import { debugLog } from '../shared/constants';
import {
  isResolvableNonAtvType,
  isLikelyLabelChannel,
  extractVariantTags,
  normalizeTitle,
  normalizeArtist,
  parseTitleParts,
  extractResponsiveItems,
  matchArtistsScore,
  pickBestCandidate,
  getMusicVideoType
} from './matcher';
import {
  omvToAtvMap,
  noAtvSet,
  trimMap,
  rememberMapping,
  markNoAtv,
  onCacheClear
} from './cache';

const SONGS_SEARCH_PARAMS = 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D';
  const RATE_LIMIT_COOLDOWN_MS = 45_000;
  const SERVER_ERROR_COOLDOWN_MS = 10_000;
  const FORWARDED_HEADER_KEYS = [
    'authorization',
    'x-goog-authuser',
    'x-goog-visitor-id',
    'x-origin',
    'x-youtube-client-name',
    'x-youtube-client-version'
  ] as const;

  let rawFetch: typeof window.fetch = window.fetch;
  let capturedAuthHeaders: Record<string, string> = {};
  let backoffUntil = 0;
  const vlCache = new Map<string, Promise<YtmTrackMeta[]>>();
  const artistSongsCache = new Map<string, Promise<{ ok: boolean; aborted?: boolean; items: YtmTrackMeta[] }>>();
  const searchCache = new Map<string, Promise<boolean>>();

  function getBackoffRemainingMs(): number {
    return Math.max(0, backoffUntil - Date.now());
  }

  function isBackingOff(): boolean {
    return Date.now() < backoffUntil;
  }

  function triggerBackoff(status: number, endpoint: string): void {
    if (status !== 429 && status < 500) return;
    const durationMs = status === 429 ? RATE_LIMIT_COOLDOWN_MS : SERVER_ERROR_COOLDOWN_MS;
    backoffUntil = Math.max(backoffUntil, Date.now() + durationMs);
    debugLog('resolver', `HTTP ${status} on ${endpoint}; backing off for ${durationMs}ms`);
  }

  onCacheClear(() => {
    vlCache.clear();
    artistSongsCache.clear();
    backoffUntil = 0;
  });

  function init({ originalFetch }: { originalFetch?: typeof window.fetch }): void {
    if (typeof originalFetch === 'function') {
      rawFetch = originalFetch;
    }
  }

  function setAuthHeaders(headers: Record<string, string>): void {
    if (!headers || typeof headers !== 'object') return;
    const next: Record<string, string> = { ...capturedAuthHeaders };
    for (const key of FORWARDED_HEADER_KEYS) {
      const val = headers[key];
      if (typeof val === 'string' && val) {
        next[key] = val;
      }
    }
    capturedAuthHeaders = next;
  }

  function buildRequestHeaders(): Record<string, string> {
    return {
      ...capturedAuthHeaders,
      'content-type': 'application/json'
    };
  }

  function getInnertubeContext(context?: unknown): unknown {
    if (context) return context;
    try {
      const cfgCtx = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
      if (cfgCtx && typeof cfgCtx === 'object') return cfgCtx;
    } catch {
      // Ignore ytcfg access errors
    }
    // Last-resort fallback used only when window.ytcfg is unavailable; refresh periodically if InnerTube rejects older clientVersion values.
    return {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20261120.01.00'
      }
    };
  }

  function buildYoutubeiUrl(sourceUrl: string, endpoint: string): string {
    if (sourceUrl && sourceUrl.includes('/youtubei/v1/')) {
      return sourceUrl.replace(/\/youtubei\/v1\/[^?]+/, `/youtubei/v1/${endpoint}`);
    }
    return `${window.location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`;
  }

  function collectCounterpartMappings(root: unknown): void {
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      const rec = node as Record<string, unknown>;
      if (rec.playlistPanelVideoWrapperRenderer) {
        const wrapper = rec.playlistPanelVideoWrapperRenderer as YtmPlaylistPanelVideoWrapperRenderer;
        const primary = wrapper.primaryRenderer?.playlistPanelVideoRenderer;
        const counterparts = wrapper.counterpart;
        if (primary && Array.isArray(counterparts)) {
          const primaryType = getMusicVideoType(
            primary?.navigationEndpoint?.watchEndpoint
          );
          if (primaryType !== 'MUSIC_VIDEO_TYPE_ATV') {
            const atvEntry = counterparts.find((entry) => {
              const r = entry?.counterpartRenderer?.playlistPanelVideoRenderer;
              return (
                r &&
                getMusicVideoType(r?.navigationEndpoint?.watchEndpoint) ===
                  'MUSIC_VIDEO_TYPE_ATV'
              );
            });
            const atvRenderer =
              atvEntry?.counterpartRenderer?.playlistPanelVideoRenderer;
            if (
              primary.videoId &&
              atvRenderer?.videoId &&
              primary.videoId !== atvRenderer.videoId
            ) {
              rememberMapping(
                primary.videoId,
                atvRenderer.videoId,
                atvRenderer?.thumbnail?.thumbnails
              );
            }
          }
        }
      }
      const keys = Object.keys(rec);
      for (let i = 0; i < keys.length; i++) walk(rec[keys[i]]);
    }
    walk(root);
  }

  function fetchVlAlbumTracks(
    playlistId: string,
    sourceUrl: string,
    context?: unknown
  ): Promise<YtmTrackMeta[]> {
    if (!playlistId || !playlistId.startsWith('OLAK5uy_') || isBackingOff()) {
      return Promise.resolve([]);
    }
    const cached = vlCache.get(playlistId);
    if (cached) {
      return cached;
    }

    const browseUrl = buildYoutubeiUrl(sourceUrl, 'browse');
    const promise = (async () => {
      try {
        const res = await rawFetch.call(window, browseUrl, {
          method: 'POST',
          credentials: 'include',
          headers: buildRequestHeaders(),
          body: JSON.stringify({
            context: getInnertubeContext(context),
            browseId: `VL${playlistId}`
          })
        });
        if (!res.ok) {
          triggerBackoff(res.status, 'browse/VL');
          vlCache.delete(playlistId);
          return [];
        }
        const json: unknown = await res.json();
        return extractResponsiveItems(json).filter(
          (item) => item.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV'
        );
      } catch {
        vlCache.delete(playlistId);
        return [];
      }
    })();

    vlCache.set(playlistId, promise);
    trimMap(vlCache, 300);
    return promise;
  }

  function getVariantSignature(title: string): string {
    const tags = extractVariantTags(title);
    return tags.size > 0 ? Array.from(tags).sort().join(',') : '';
  }

  function variantsCompatible(titleA: string, titleB: string): boolean {
    return getVariantSignature(titleA) === getVariantSignature(titleB);
  }

  function pairAndRememberTracks(
    sourceTracks: YtmTrackMeta[],
    vlAtvTracks: YtmTrackMeta[]
  ): void {
    if (!sourceTracks.length || !vlAtvTracks.length) return;

    const sameLength = sourceTracks.length === vlAtvTracks.length;
    const vlByTitle = new Map<string, YtmTrackMeta>();
    for (const v of vlAtvTracks) {
      const norm = normalizeTitle(v.title);
      if (!norm) continue;
      const key = `${norm}||${getVariantSignature(v.title)}`;
      if (!vlByTitle.has(key)) {
        vlByTitle.set(key, v);
      }
    }

    let comparableCount = 0;
    let alignedCount = 0;
    if (sameLength) {
      for (let i = 0; i < sourceTracks.length; i++) {
        const sNorm = normalizeTitle(sourceTracks[i]?.title);
        const vNorm = normalizeTitle(vlAtvTracks[i]?.title);
        if (sNorm && vNorm) {
          comparableCount++;
          if (
            sNorm === vNorm &&
            variantsCompatible(sourceTracks[i]?.title, vlAtvTracks[i]?.title)
          ) {
            alignedCount++;
          }
        }
      }
    }
    const orderTrusted =
      sameLength &&
      (comparableCount === 0 || alignedCount >= Math.ceil(comparableCount / 2));

    for (let i = 0; i < sourceTracks.length; i++) {
      const src = sourceTracks[i];
      if (
        !src.videoId ||
        src.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV' ||
        !isResolvableNonAtvType(src.musicVideoType || 'MUSIC_VIDEO_TYPE_OMV', src)
      ) {
        continue;
      }

      let match: YtmTrackMeta | null = null;
      if (sameLength) {
        const byIndex = vlAtvTracks[i];
        if (
          byIndex &&
          (!src.title ||
            !byIndex.title ||
            (normalizeTitle(src.title) === normalizeTitle(byIndex.title) &&
              variantsCompatible(src.title, byIndex.title)))
        ) {
          match = byIndex;
        }
      }
      if (!match && src.title) {
        const key = `${normalizeTitle(src.title)}||${getVariantSignature(src.title)}`;
        match = vlByTitle.get(key) || null;
      }
      if (!match && orderTrusted) {
        const candidate = vlAtvTracks[i];
        if (
          candidate &&
          (!src.title || !candidate.title || variantsCompatible(src.title, candidate.title))
        ) {
          match = candidate;
        }
      }

      if (match?.videoId && match.videoId !== src.videoId) {
        rememberMapping(src.videoId, match.videoId, match.thumbnails);
      }
    }
  }

  function fetchArtistTopSongs(
    artistBrowseId: string,
    sourceUrl: string,
    context?: unknown,
    signal?: AbortSignal | null
  ): Promise<{ ok: boolean; aborted?: boolean; items: YtmTrackMeta[] }> {
    if (!artistBrowseId || !artistBrowseId.startsWith('UC')) {
      return Promise.resolve({ ok: true, items: [] });
    }
    if (isBackingOff()) {
      return Promise.resolve({ ok: false, items: [] });
    }
    const cached = artistSongsCache.get(artistBrowseId);
    if (cached) {
      return cached;
    }

    const browseUrl = buildYoutubeiUrl(sourceUrl, 'browse');
    const promise = (async () => {
      try {
        const fetchOpts: RequestInit = {
          method: 'POST',
          credentials: 'include',
          headers: buildRequestHeaders(),
          body: JSON.stringify({
            context: getInnertubeContext(context),
            browseId: artistBrowseId
          })
        };
        if (signal) fetchOpts.signal = signal;
        const res = await rawFetch.call(window, browseUrl, fetchOpts);
        if (!res.ok) {
          triggerBackoff(res.status, 'browse/artist');
          artistSongsCache.delete(artistBrowseId);
          return { ok: false, items: [] };
        }
        const json: unknown = await res.json();
        return {
          ok: true,
          items: extractResponsiveItems(json).filter(
            (item) => item.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV'
          )
        };
      } catch (err) {
        artistSongsCache.delete(artistBrowseId);
        const aborted = err instanceof Error && err.name === 'AbortError';
        return { ok: false, aborted, items: [] };
      }
    })();

    artistSongsCache.set(artistBrowseId, promise);
    trimMap(artistSongsCache, 300);
    return promise;
  }

  function resolveTrack(
    track: YtmTrackMeta,
    sourceUrl: string,
    context?: unknown,
    { signal = null }: { signal?: AbortSignal | null } = {}
  ): Promise<boolean> {
    const omvId = track?.videoId;
    if (
      !omvId ||
      omvToAtvMap.has(omvId) ||
      noAtvSet.has(omvId) ||
      !isResolvableNonAtvType(track.musicVideoType || 'MUSIC_VIDEO_TYPE_OMV', track)
    ) {
      return Promise.resolve(omvToAtvMap.has(omvId));
    }

    const existing = searchCache.get(omvId);
    if (existing) {
      return existing;
    }

    if (isBackingOff()) {
      debugLog('resolver', 'skipping search during backoff', {
        omvId,
        remainingMs: getBackoffRemainingMs()
      });
      return Promise.resolve(false);
    }

    const { cleaned, artistFromTitle, titleWithoutArtist } = parseTitleParts(
      track.title,
      track.artist
    );
    if (!cleaned) {
      markNoAtv(omvId);
      return Promise.resolve(false);
    }

    const artist = (track.artist || '').trim();
    const queryTitle = titleWithoutArtist || cleaned;
    const baseQueryTitle = normalizeTitle(queryTitle) || queryTitle;
    const queryArtist =
      artist && !isLikelyLabelChannel(artist)
        ? artist
        : artistFromTitle || artist;
    const primaryQuery = queryArtist ? `${queryTitle} ${queryArtist}` : queryTitle;
    const fallbackTitle =
      baseQueryTitle && baseQueryTitle !== queryTitle.toLowerCase()
        ? baseQueryTitle
        : queryTitle;
    const fallbackQuery = queryArtist
      ? `${queryArtist} ${fallbackTitle}`
      : `"${fallbackTitle}"`;
    const searchUrl = buildYoutubeiUrl(sourceUrl, 'search');
    const reqContext = getInnertubeContext(context);
    const minScore =
      normalizeArtist(queryArtist) || track.artistBrowseId ? 125 : 90;
    let discoveredArtistBrowseId = track.artistBrowseId || '';
    let hadTransientError = false;
    const activeSignal = signal || undefined;

    async function runSearch(query: string, useSongsFilter: boolean): Promise<YtmTrackMeta | null> {
      const payload: Record<string, unknown> = { context: reqContext, query };
      if (useSongsFilter) payload.params = SONGS_SEARCH_PARAMS;
      const fetchOpts: RequestInit = {
        method: 'POST',
        credentials: 'include',
        headers: buildRequestHeaders(),
        body: JSON.stringify(payload)
      };
      if (activeSignal) fetchOpts.signal = activeSignal;

      const res = await rawFetch.call(window, searchUrl, fetchOpts);
      if (!res.ok) {
        hadTransientError = true;
        triggerBackoff(res.status, 'search');
        return null;
      }

      const json: unknown = await res.json();
      const allItems = extractResponsiveItems(json);

      if (!discoveredArtistBrowseId && queryArtist) {
        const artistHit = allItems.find(
          (item) =>
            item.artistBrowseId &&
            matchArtistsScore(queryArtist, item.artist, '') >= 50
        );
        if (artistHit?.artistBrowseId) {
          discoveredArtistBrowseId = artistHit.artistBrowseId;
        }
      }

      return pickBestCandidate(track, allItems, omvId, minScore);
    }

    const promise = (async () => {
      try {
        let best = await runSearch(primaryQuery, true);

        if (!best && !isBackingOff()) {
          if (discoveredArtistBrowseId) {
            const [fallbackBest, artistResult] = await Promise.all([
              runSearch(fallbackQuery, false),
              fetchArtistTopSongs(
                discoveredArtistBrowseId,
                searchUrl,
                reqContext,
                activeSignal
              )
            ]);
            if (fallbackBest) {
              best = fallbackBest;
            } else if (!artistResult.ok) {
              hadTransientError = true;
            } else {
              best = pickBestCandidate(track, artistResult.items, omvId, minScore);
            }
          } else {
            best = await runSearch(fallbackQuery, false);
            if (!best && !isBackingOff() && discoveredArtistBrowseId) {
              const artistResult = await fetchArtistTopSongs(
                discoveredArtistBrowseId,
                searchUrl,
                reqContext,
                activeSignal
              );
              if (!artistResult.ok) {
                hadTransientError = true;
              } else {
                best = pickBestCandidate(track, artistResult.items, omvId, minScore);
              }
            }
          }
        }

        if (best?.videoId) {
          debugLog('resolver', 'matched ATV', {
            omvId,
            atvId: best.videoId,
            title: track.title,
            matchedTitle: best.title
          });
          rememberMapping(omvId, best.videoId, best.thumbnails);
          return true;
        }

        if (!hadTransientError && !track.lowConfidenceAuthor) {
          debugLog('resolver', 'no ATV found; marking noAtv', {
            omvId,
            title: track.title,
            artist: track.artist
          });
          markNoAtv(omvId);
        } else {
          debugLog('resolver', 'unresolved without marking noAtv', {
            omvId,
            hadTransientError,
            lowConfidenceAuthor: Boolean(track.lowConfidenceAuthor)
          });
        }
        return false;
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          debugLog('resolver', 'resolveTrack error', omvId, err);
        }
        return false;
      } finally {
        searchCache.delete(omvId);
      }
    })();

    searchCache.set(omvId, promise);
    return promise;
  }

  async function waitForResolve(
    promise: Promise<unknown> | null | undefined,
    timeoutMs: number
  ): Promise<ResolveWaitResult> {
    if (!promise || !timeoutMs || timeoutMs <= 0) {
      try {
        const resolved = await promise;
        return { resolved: Boolean(resolved), timedOut: false };
      } catch {
        return { resolved: false, timedOut: false };
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<ResolveWaitResult>((resolve) => {
        timer = setTimeout(() => {
          timer = null;
          resolve({ resolved: false, timedOut: true });
        }, timeoutMs);
      });
      const resolvePromise = (async (): Promise<ResolveWaitResult> => {
        try {
          const val = await promise;
          return { resolved: Boolean(val), timedOut: false };
        } catch {
          return { resolved: false, timedOut: false };
        }
      })();
      return await Promise.race([resolvePromise, timeoutPromise]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

export {
  init,
  setAuthHeaders,
  getInnertubeContext,
  buildYoutubeiUrl,
  collectCounterpartMappings,
  fetchVlAlbumTracks,
  pairAndRememberTracks,
  resolveTrack,
  waitForResolve,
  getBackoffRemainingMs
};
