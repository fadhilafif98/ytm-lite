import {
  ENABLED_STORAGE_KEY,
  MAX_PERSISTENT_ENTRIES as MAX_MEMORY_ENTRIES,
  isSafeVideoId as isValidVideoId,
  isAllowedThumbUrl
} from '../shared/constants';
import { isResolvableNonAtvType } from './matcher';

const STORAGE_KEY = 'ytm_lite_omv_to_atv_v5';
  const LEGACY_STORAGE_KEY = 'ytm_lite_omv_to_atv_v4';
  const THUMB_STORAGE_KEY = 'ytm_lite_thumbs_v2';
  const NO_ATV_STORAGE_KEY = 'ytm_lite_no_atv_v1';
  const MAX_SESSION_ENTRIES = 800;

  let enabled = true;
  try {
    if (sessionStorage.getItem(ENABLED_STORAGE_KEY) === '0') {
      enabled = false;
    }
  } catch {
    // Ignore storage errors
  }

  const omvToAtvMap = new Map<string, string>();
  const atvToOmvMap = new Map<string, string>();
  const videoThumbMap = new Map<string, YtmThumbnail[]>();
  const knownOmvMeta = new Map<string, YtmTrackMeta>();
  const knownAtvSet = new Set<string>();
  const noAtvSet = new Set<string>();
  const recentPlayerSwaps = new Map<string, RecentPlayerSwap>();
  const recentPlayerRequests = new Map<string, number>();
  const pendingPlayerSwaps = new Set<string>();

  function trimMap<K, V>(map: Map<K, V>, maxSize = MAX_MEMORY_ENTRIES): void {
    if (map.size <= maxSize) return;
    const excess = map.size - maxSize;
    let i = 0;
    for (const key of map.keys()) {
      map.delete(key);
      if (++i >= excess) break;
    }
  }

  function trimSet<V>(set: Set<V>, maxSize = MAX_MEMORY_ENTRIES): void {
    if (set.size <= maxSize) return;
    const excess = set.size - maxSize;
    let i = 0;
    for (const val of set.values()) {
      set.delete(val);
      if (++i >= excess) break;
    }
  }

  function buildSquareThumbnails(thumbs: unknown): YtmThumbnail[] | null {
    if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
    const result: YtmThumbnail[] = thumbs
      .filter((t): t is YtmThumbnail => Boolean(t && typeof t === 'object' && isAllowedThumbUrl((t as YtmThumbnail).url)))
      .map((t) => ({ ...t }));
    if (result.length === 0) return null;
    const last = result[result.length - 1];
    if (
      last?.url &&
      /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\//i.test(last.url) &&
      /w\d+-h\d+/.test(last.url) &&
      (last.width || 0) < 544
    ) {
      result.push({
        url: last.url.replace(/w\d+-h\d+/, 'w544-h544'),
        width: 544,
        height: 544
      });
    }
    return result;
  }

  function buildThumbsFromUrl(url: string): YtmThumbnail[] | null {
    if (!isAllowedThumbUrl(url)) return null;
    return buildSquareThumbnails([{ url, width: 544, height: 544 }]);
  }

  function loadSessionCache(): void {
    try {
      sessionStorage.removeItem(LEGACY_STORAGE_KEY);
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (!Array.isArray(entry)) continue;
            const [omvId, atvId] = entry;
            if (isValidVideoId(omvId) && isValidVideoId(atvId) && omvId !== atvId) {
              omvToAtvMap.set(omvId, atvId);
              atvToOmvMap.set(atvId, omvId);
            }
          }
        }
      }
      const rawThumbs = sessionStorage.getItem(THUMB_STORAGE_KEY);
      if (rawThumbs) {
        const thumbEntries: unknown = JSON.parse(rawThumbs);
        if (Array.isArray(thumbEntries)) {
          for (const entry of thumbEntries) {
            if (!Array.isArray(entry)) continue;
            const [vid, thumbs] = entry;
            const cleanThumbs = isValidVideoId(vid) ? buildSquareThumbnails(thumbs) : null;
            if (cleanThumbs) {
              videoThumbMap.set(vid, cleanThumbs);
            }
          }
        }
      }
      const rawNoAtv = sessionStorage.getItem(NO_ATV_STORAGE_KEY);
      if (rawNoAtv) {
        const noAtvEntries: unknown = JSON.parse(rawNoAtv);
        if (Array.isArray(noAtvEntries)) {
          for (const vid of noAtvEntries) {
            if (isValidVideoId(vid) && !omvToAtvMap.has(vid)) {
              noAtvSet.add(vid);
            }
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  function saveNoAtvSessionCache(): void {
    try {
      const noAtvEntries = Array.from(noAtvSet).slice(-MAX_SESSION_ENTRIES);
      sessionStorage.setItem(NO_ATV_STORAGE_KEY, JSON.stringify(noAtvEntries));
    } catch {
      // Ignore quota errors
    }
  }

  function saveSessionCache(): void {
    try {
      const entries = Array.from(omvToAtvMap.entries()).slice(-MAX_SESSION_ENTRIES);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      const thumbEntries = Array.from(videoThumbMap.entries()).slice(-MAX_SESSION_ENTRIES);
      sessionStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(thumbEntries));
      saveNoAtvSessionCache();
    } catch {
      // Ignore quota errors
    }
  }

  function persistMappingToExtension(
    omvId: string,
    atvId: string,
    squareThumbs: YtmThumbnail[] | null
  ): void {
    try {
      const thumbUrl = squareThumbs?.[squareThumbs.length - 1]?.url || '';
      window.dispatchEvent(
        new CustomEvent('ytm-lite-cache-put', {
          detail: { omvId, atvId, thumbUrl }
        })
      );
    } catch {
      // Ignore event errors
    }
  }

  function getThumbQualityScore(thumbs: YtmThumbnail[] | undefined): number {
    if (!Array.isArray(thumbs) || thumbs.length === 0) return 0;
    const last = thumbs[thumbs.length - 1];
    const url = String(last?.url || '');
    const width = Number(last?.width) || 0;
    const isGoogleSquare = url.includes('googleusercontent.com') ? 10000 : 0;
    return isGoogleSquare + width;
  }

  function rememberMapping(
    omvId: string,
    atvId: string,
    thumbnails?: YtmThumbnail[] | string | null,
    { persist = true }: { persist?: boolean } = {}
  ): void {
    if (!isValidVideoId(omvId) || !isValidVideoId(atvId) || omvId === atvId) return;
    let changed = false;
    if (omvToAtvMap.get(omvId) !== atvId) {
      omvToAtvMap.set(omvId, atvId);
      atvToOmvMap.set(atvId, omvId);
      noAtvSet.delete(omvId);
      changed = true;
    }
    const squareThumbs = Array.isArray(thumbnails)
      ? buildSquareThumbnails(thumbnails)
      : typeof thumbnails === 'string'
        ? buildThumbsFromUrl(thumbnails)
        : null;
    if (squareThumbs) {
      const existingScore = getThumbQualityScore(videoThumbMap.get(atvId));
      const incomingScore = getThumbQualityScore(squareThumbs);
      if (!videoThumbMap.has(atvId) || incomingScore > existingScore) {
        videoThumbMap.set(omvId, squareThumbs);
        videoThumbMap.set(atvId, squareThumbs);
        changed = true;
      }
    }
    if (changed) {
      trimMap(omvToAtvMap);
      trimMap(atvToOmvMap);
      trimMap(videoThumbMap);
      saveSessionCache();
      if (persist) {
        persistMappingToExtension(
          omvId,
          atvId,
          squareThumbs || videoThumbMap.get(atvId) || null
        );
      }
    }
  }

  function registerTracksMetadata(tracks: YtmTrackMeta[]): void {
    if (!Array.isArray(tracks)) return;
    let noAtvChanged = false;
    for (const t of tracks) {
      if (!t?.videoId) continue;
      if (t.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') {
        knownAtvSet.add(t.videoId);
      } else if (isResolvableNonAtvType(t.musicVideoType, t) && t.title) {
        const existing = knownOmvMeta.get(t.videoId);
        const incomingHasArtistId = Boolean(
          t.artistBrowseId && String(t.artistBrowseId).startsWith('UC')
        );
        if (!existing) {
          knownOmvMeta.set(t.videoId, {
            videoId: t.videoId,
            title: t.title,
            artist: t.artist || '',
            artistBrowseId: t.artistBrowseId || '',
            musicVideoType: t.musicVideoType,
            durationSec: t.durationSec || 0
          });
          if (incomingHasArtistId && noAtvSet.has(t.videoId)) {
            noAtvSet.delete(t.videoId);
            noAtvChanged = true;
          }
        } else {
          const betterArtist =
            incomingHasArtistId &&
            (!existing.artistBrowseId || existing.artist !== t.artist);
          if (betterArtist) {
            existing.artist = t.artist || existing.artist;
            existing.artistBrowseId = t.artistBrowseId;
            if (noAtvSet.has(t.videoId)) {
              noAtvSet.delete(t.videoId);
              noAtvChanged = true;
            }
          } else if (!existing.artistBrowseId && t.artistBrowseId) {
            existing.artistBrowseId = t.artistBrowseId;
          }
        }
      }
    }
    if (noAtvChanged) {
      saveNoAtvSessionCache();
    }
    trimMap(knownOmvMeta);
    trimSet(knownAtvSet);
  }

  function markNoAtv(omvId: string): void {
    if (!omvId || noAtvSet.has(omvId)) return;
    noAtvSet.add(omvId);
    trimSet(noAtvSet);
    saveNoAtvSessionCache();
  }

  function markPlayerRequest(videoId: string, origOmvId = ''): void {
    const now = Date.now();
    if (videoId) {
      recentPlayerRequests.set(videoId, now);
      trimMap(recentPlayerRequests, 100);
    }
    if (origOmvId && videoId && origOmvId !== videoId) {
      recentPlayerSwaps.set(origOmvId, { atvId: videoId, time: now });
      trimMap(recentPlayerSwaps, 100);
    }
  }

  function wasRecentlyLoadedAsAtv(omvId: string, atvId: string, windowMs = 8000): boolean {
    if (omvId && pendingPlayerSwaps.has(omvId)) {
      return true;
    }
    const now = Date.now();
    const swap = omvId ? recentPlayerSwaps.get(omvId) : null;
    if (swap && swap.atvId === atvId && now - swap.time < windowMs) {
      return true;
    }
    const reqTime = atvId ? recentPlayerRequests.get(atvId) : 0;
    if (reqTime && now - reqTime < 4000) {
      return true;
    }
    return false;
  }

  const clearListeners: Array<() => void> = [];

  function onCacheClear(fn: () => void): void {
    clearListeners.push(fn);
  }

  function clearAllCaches(): void {
    omvToAtvMap.clear();
    atvToOmvMap.clear();
    videoThumbMap.clear();
    noAtvSet.clear();
    recentPlayerSwaps.clear();
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(THUMB_STORAGE_KEY);
      sessionStorage.removeItem(NO_ATV_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    for (const fn of clearListeners) {
      try {
        fn();
      } catch {
        // Ignore listener errors
      }
    }
  }

  function hydrateFromPersistentCache(entries: HydrateCacheEntry[] | undefined): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    let added = false;
    for (const item of entries) {
      if (!item || !isValidVideoId(item.o) || !isValidVideoId(item.a)) continue;
      if (item.o === item.a) continue;
      if (!omvToAtvMap.has(item.o)) {
        omvToAtvMap.set(item.o, item.a);
        atvToOmvMap.set(item.a, item.o);
        noAtvSet.delete(item.o);
        added = true;
      }
      if (item.u && !videoThumbMap.has(item.a)) {
        const thumbs = buildThumbsFromUrl(item.u);
        if (thumbs) {
          videoThumbMap.set(item.o, thumbs);
          videoThumbMap.set(item.a, thumbs);
          added = true;
        }
      }
    }
    if (added) {
      trimMap(omvToAtvMap);
      trimMap(atvToOmvMap);
      trimMap(videoThumbMap);
      saveSessionCache();
    }
  }

  function isEnabled(): boolean {
    return enabled;
  }

  if (!window.__ytmLiteInjected) {
    loadSessionCache();

    window.addEventListener('ytm-lite-settings', (event: Event) => {
      const customEvent = event as CustomEvent<Partial<YtmLiteSettings> | undefined>;
      if (customEvent?.detail && typeof customEvent.detail.enabled === 'boolean') {
        enabled = customEvent.detail.enabled;
        try {
          sessionStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
        } catch {
          // Ignore storage errors
        }
      }
    });

    window.addEventListener('ytm-lite-cache-hydrate', (event: Event) => {
      const customEvent = event as CustomEvent<{ entries?: HydrateCacheEntry[] } | undefined>;
      hydrateFromPersistentCache(customEvent?.detail?.entries);
    });

    window.addEventListener('ytm-lite-cache-clear', () => {
      clearAllCaches();
    });

    // Notify isolated world content.ts that cache listener is ready for hydration
    try {
      window.dispatchEvent(new CustomEvent('ytm-lite-cache-ready'));
    } catch {
      // Ignore
    }
  }

  export {
    isEnabled,
    omvToAtvMap,
    atvToOmvMap,
    videoThumbMap,
    knownOmvMeta,
    knownAtvSet,
    noAtvSet,
    pendingPlayerSwaps,
    trimMap,
    trimSet,
    rememberMapping,
    registerTracksMetadata,
    markNoAtv,
    markPlayerRequest,
    wasRecentlyLoadedAsAtv,
    clearAllCaches,
    onCacheClear
  };
