import { debugLog, isAllowedThumbUrl, isSafeVideoId } from '../shared/constants';
import {
  isResolvableNonAtvType,
  extractTrackFromPlayerData,
  getMusicVideoType,
  setMusicVideoTypeAtv,
  findFirstWatchEndpoint,
  extractResponsiveItems,
  extractPlaylistPanelItems,
  isVideoStatText,
  stripViewsAndLikesFromByline
} from '../core/matcher';
import {
  isEnabled,
  omvToAtvMap,
  atvToOmvMap,
  videoThumbMap,
  knownOmvMeta,
  knownAtvSet,
  noAtvSet,
  pendingPlayerSwaps,
  rememberMapping,
  registerTracksMetadata,
  markPlayerRequest,
  wasRecentlyLoadedAsAtv
} from '../core/cache';
import {
  init as initResolver,
  setAuthHeaders,
  collectCounterpartMappings,
  fetchVlAlbumTracks,
  pairAndRememberTracks,
  resolveTrack,
  waitForResolve,
  getBackoffRemainingMs
} from '../core/resolver';

(() => {
  if (window.__ytmLiteInjected) return;
  window.__ytmLiteInjected = true;

  const originalFetch = window.fetch;
  initResolver({ originalFetch });

  const PLAYER_RESOLVE_TIMEOUT_MS = 1100;
  const COLD_PLAYER_RESOLVE_TIMEOUT_MS = 900;
  const NEXT_RESOLVE_TIMEOUT_MS = 450;
  const BROWSE_VL_WAIT_MS = 120;
  const NEXT_PREFETCH_DELAY_MS = 350;
  const HOVER_PREFETCH_DELAY_MS = 120;
  const LATE_REDIRECT_MAX_PLAYED_SEC = 4.0;
  let lastRedirectedOmv = '';
  let lastRedirectTime = 0;
  let activeTrackSeq = 0;
  let latestRequestedOmv = '';
  let latestRequestedAtv = '';
  let manualVideoId = '';
  let activePlayerAbortController: AbortController | null = null;
  let activePlayerAbortVideoId = '';
  let activeQueueItems: YtmTrackMeta[] = [];
  let activeQueueSourceUrl = '';
  let activeQueueContext: unknown = undefined;
  let nextPrefetchTimer: ReturnType<typeof setTimeout> | null = null;
  let nextPrefetchAbortController: AbortController | null = null;
  let hoverPrefetchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHoveredVideoId = '';
  let pointerPrefetchBound = false;
  let boundSyncVideoEl: HTMLVideoElement | null = null;
  let observedPlayerEl: Element | null = null;
  let playerModeObserver: MutationObserver | null = null;
  let observedPlayerPageEl: Element | null = null;
  let playerPageObserver: MutationObserver | null = null;
  let observedBylineEl: Element | null = null;
  let bylineObserver: MutationObserver | null = null;
  let observedSongImgEl: Element | null = null;
  let songImgObserver: MutationObserver | null = null;
  let coverSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelNextPrefetch(): void {
    if (nextPrefetchTimer !== null) {
      clearTimeout(nextPrefetchTimer);
      nextPrefetchTimer = null;
    }
    if (nextPrefetchAbortController) {
      try {
        nextPrefetchAbortController.abort();
      } catch {
        // Ignore abort errors
      }
      nextPrefetchAbortController = null;
    }
  }

  function updateActiveQueue(
    panelItems: YtmTrackMeta[],
    sourceUrl: string,
    context?: unknown
  ): void {
    if (!Array.isArray(panelItems) || panelItems.length === 0) return;
    activeQueueItems = panelItems;
    if (sourceUrl) activeQueueSourceUrl = sourceUrl;
    if (context) activeQueueContext = context;
  }

  function findNextUncachedQueueCandidate(
    items: YtmTrackMeta[],
    currentVid = ''
  ): YtmTrackMeta | null {
    if (!Array.isArray(items) || items.length < 2) return null;
    let startIdx = -1;
    if (currentVid) {
      const mappedOmv = atvToOmvMap.get(currentVid) || '';
      const mappedAtv = omvToAtvMap.get(currentVid) || '';
      startIdx = items.findIndex(
        (item) =>
          item?.videoId === currentVid ||
          (Boolean(mappedOmv) && item?.videoId === mappedOmv) ||
          (Boolean(mappedAtv) && item?.videoId === mappedAtv)
      );
    }
    if (startIdx < 0) {
      startIdx = items.findIndex((item) => item?.selected);
    }
    if (startIdx < 0) {
      startIdx = 0;
    }
    // Look up to 2 tracks ahead so if next track is already ATV/cached, we still pre-warm the upcoming OMV
    const maxLook = Math.min(items.length - 1, startIdx + 2);
    for (let i = startIdx + 1; i <= maxLook; i++) {
      const cand = items[i];
      if (
        cand?.videoId &&
        isResolvableNonAtvType(cand.musicVideoType, cand) &&
        !omvToAtvMap.has(cand.videoId) &&
        !noAtvSet.has(cand.videoId)
      ) {
        return cand;
      }
    }
    return null;
  }

  function scheduleNextTrackPrefetch(
    panelItems: YtmTrackMeta[],
    sourceUrl: string,
    context?: unknown,
    currentVid = ''
  ): void {
    cancelNextPrefetch();
    if (!isEnabled() || !Array.isArray(panelItems) || panelItems.length < 2) return;
    if (typeof getBackoffRemainingMs === 'function' && getBackoffRemainingMs() > 0) return;

    const nextCandidate = findNextUncachedQueueCandidate(panelItems, currentVid);
    if (!nextCandidate) return;

    const capturedSeq = activeTrackSeq;
    const effectiveUrl =
      sourceUrl ||
      activeQueueSourceUrl ||
      `${window.location.origin}/youtubei/v1/search?prettyPrint=false`;
    const effectiveContext = context || activeQueueContext;

    nextPrefetchTimer = setTimeout(() => {
      nextPrefetchTimer = null;
      if (!isEnabled() || capturedSeq !== activeTrackSeq) return;
      if (typeof getBackoffRemainingMs === 'function' && getBackoffRemainingMs() > 0) return;
      if (omvToAtvMap.has(nextCandidate.videoId) || noAtvSet.has(nextCandidate.videoId)) return;

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      nextPrefetchAbortController = controller;
      void resolveTrack(nextCandidate, effectiveUrl, effectiveContext, {
        signal: controller?.signal || null
      }).finally(() => {
        if (nextPrefetchAbortController === controller) {
          nextPrefetchAbortController = null;
        }
      });
    }, NEXT_PREFETCH_DELAY_MS);
  }

  function scheduleQueuePrefetchForActiveTrack(currentVid: string): void {
    if (!currentVid || activeQueueItems.length < 2) return;
    scheduleNextTrackPrefetch(
      activeQueueItems,
      activeQueueSourceUrl,
      activeQueueContext,
      currentVid
    );
  }

  function beginActiveTrack(origVideoId: string): { seq: number; signal?: AbortSignal } {
    cancelNextPrefetch();
    const seq = ++activeTrackSeq;
    if (
      activePlayerAbortController &&
      activePlayerAbortVideoId &&
      activePlayerAbortVideoId !== origVideoId
    ) {
      try {
        activePlayerAbortController.abort();
      } catch {
        // Ignore abort errors
      }
      activePlayerAbortController = null;
      activePlayerAbortVideoId = '';
    }
    if (lastRedirectedOmv && lastRedirectedOmv !== origVideoId) {
      lastRedirectedOmv = '';
      lastRedirectTime = 0;
    }
    if (
      manualVideoId &&
      manualVideoId !== origVideoId &&
      omvToAtvMap.get(origVideoId) !== manualVideoId &&
      atvToOmvMap.get(origVideoId) !== manualVideoId
    ) {
      manualVideoId = '';
    }
    latestRequestedOmv = origVideoId;
    if (typeof AbortController === 'function') {
      activePlayerAbortController = new AbortController();
      activePlayerAbortVideoId = origVideoId;
      return { seq, signal: activePlayerAbortController.signal };
    }
    return { seq };
  }

  function isCurrentTrack(seq: number): boolean {
    return seq === activeTrackSeq;
  }

  function isManualVideoActiveFor(videoId: string, altVideoId = ''): boolean {
    if (!manualVideoId) return false;
    return (
      manualVideoId === videoId ||
      (Boolean(altVideoId) && manualVideoId === altVideoId) ||
      atvToOmvMap.get(videoId) === manualVideoId ||
      omvToAtvMap.get(videoId) === manualVideoId
    );
  }

  function scheduleCoverSync(videoId: string, delayMs = 120, attempt = 0): void {
    if (coverSyncTimer !== null) {
      clearTimeout(coverSyncTimer);
      coverSyncTimer = null;
    }
    const capturedSeq = activeTrackSeq;
    coverSyncTimer = setTimeout(() => {
      coverSyncTimer = null;
      if (capturedSeq !== activeTrackSeq || !isEnabled()) return;
      const synced = syncDomCoverArt(videoId);
      if (!synced && attempt < 4) {
        scheduleCoverSync(videoId, 220, attempt + 1);
      }
    }, delayMs);
  }

  async function scheduleLateRedirect(
    resolvePromise: Promise<boolean>,
    omvId: string,
    expectedSeq: number
  ): Promise<void> {
    try {
      const found = await resolvePromise;
      if (!found || !isCurrentTrack(expectedSeq)) return;
      const lateAtv = omvToAtvMap.get(omvId);
      if (!lateAtv) return;
      // Avoid jarring mid-song restart if OMV already played smoothly past the grace window;
      // the resolved mapping stays cached for instant swaps on future plays.
      const moviePlayer = document.getElementById('movie_player') as YtmMoviePlayer | null;
      const rawTime =
        typeof moviePlayer?.getCurrentTime === 'function'
          ? Number(moviePlayer.getCurrentTime())
          : 0;
      const isActivelyPlaying =
        typeof moviePlayer?.getPlayerState === 'function' &&
        moviePlayer.getPlayerState() === 1;
      if (isActivelyPlaying && Number.isFinite(rawTime) && rawTime > LATE_REDIRECT_MAX_PLAYED_SEC) {
        debugLog('inject', 'skipping late mid-song redirect; cached for next play', {
          omvId,
          atvId: lateAtv,
          rawTime
        });
        syncDomCoverArt(omvId);
        return;
      }
      redirectPlayerToAtv({
        omvId,
        atvId: lateAtv,
        expectedSeq
      });
    } catch {
      // Ignore late resolve errors
    }
  }

  async function pairVlInBackground(
    vlPromise: Promise<YtmTrackMeta[]>,
    tracks: YtmTrackMeta[]
  ): Promise<void> {
    try {
      const vlTracks = await vlPromise;
      pairAndRememberTracks(tracks, vlTracks);
    } catch {
      // Ignore background pairing errors
    }
  }

  interface YoutubeiRequestBody {
    videoId?: string;
    playlistId?: string;
    browseId?: string;
    continuation?: string;
    context?: unknown;
    [key: string]: unknown;
  }

  function emitSwapState(pending: boolean, videoId = '', isAtv?: boolean): void {
    try {
      const vid = String(videoId || '');
      const resolvedIsAtv =
        typeof isAtv === 'boolean'
          ? isAtv
          : Boolean(!pending && vid && (atvToOmvMap.has(vid) || knownAtvSet.has(vid)));
      window.dispatchEvent(
        new CustomEvent('ytm-lite-swap-state', {
          detail: { pending: Boolean(pending), videoId: vid, isAtv: resolvedIsAtv }
        })
      );
    } catch {
      // Ignore event errors
    }
  }

  function getCurrentMoviePlayerVideoId(): string {
    try {
      const moviePlayer = document.getElementById('movie_player') as YtmMoviePlayer | null;
      return typeof moviePlayer?.getVideoData === 'function'
        ? moviePlayer.getVideoData()?.video_id || ''
        : '';
    } catch {
      return '';
    }
  }

  function rewritePayloadToAtv(root: unknown): { modified: boolean; activeSwap: ActiveSwapInfo | null } {
    let modified = false;
    let activeSwap: ActiveSwapInfo | null = null;

    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      const rec = node as Record<string, unknown>;

      // 1. Swap official YouTube Premium/wrapper counterpart
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

            if (atvEntry?.counterpartRenderer?.playlistPanelVideoRenderer) {
              const atvRenderer = atvEntry.counterpartRenderer.playlistPanelVideoRenderer;
              const omvId = primary.videoId;
              const atvId = atvRenderer.videoId;

              if (omvId && atvId && omvId !== atvId) {
                rememberMapping(omvId, atvId, atvRenderer?.thumbnail?.thumbnails);
                if (primary.selected) {
                  atvRenderer.selected = true;
                  primary.selected = false;
                  activeSwap = {
                    omvId,
                    atvId,
                    playlistId:
                      atvRenderer?.navigationEndpoint?.watchEndpoint?.playlistId ||
                      primary?.navigationEndpoint?.watchEndpoint?.playlistId ||
                      ''
                  };
                }
                wrapper.primaryRenderer = {
                  playlistPanelVideoRenderer: atvRenderer
                };
                atvEntry.counterpartRenderer = {
                  playlistPanelVideoRenderer: primary
                };
                modified = true;
                // Walk only primaryRenderer so counterpartRenderer keeps its original OMV videoId for the Video toggle
                walk(wrapper.primaryRenderer);
                return;
              }
            }
          }
        }
      }

      // 2. Rewrite plain playlistPanelVideoRenderer using omvToAtvMap + square cover + clean byline
      const panelRenderer = rec.playlistPanelVideoRenderer as YtmPlaylistPanelVideoRenderer | undefined;
      if (panelRenderer?.videoId) {
        const origId = panelRenderer.videoId;
        const mappedAtv = omvToAtvMap.get(origId);
        if (mappedAtv) {
          panelRenderer.videoId = mappedAtv;
          if (panelRenderer.navigationEndpoint?.watchEndpoint) {
            panelRenderer.navigationEndpoint.watchEndpoint.videoId = mappedAtv;
            setMusicVideoTypeAtv(panelRenderer.navigationEndpoint.watchEndpoint);
          }
          stripViewsAndLikesFromByline(panelRenderer.longBylineText);
          stripViewsAndLikesFromByline(panelRenderer.shortBylineText);
          if (panelRenderer.selected) {
            activeSwap = {
              omvId: origId,
              atvId: mappedAtv,
              playlistId: panelRenderer.navigationEndpoint?.watchEndpoint?.playlistId || ''
            };
          }
          modified = true;
        }
        const squareThumbs =
          videoThumbMap.get(panelRenderer.videoId) || videoThumbMap.get(origId);
        if (squareThumbs && panelRenderer.thumbnail) {
          panelRenderer.thumbnail.thumbnails = squareThumbs.map((t) => ({ ...t }));
          modified = true;
        }
      }

      // 2b. Rewrite musicResponsiveListItemRenderer thumbnail (Playlist / Search / Home rows)
      if (rec.musicResponsiveListItemRenderer) {
        const r = rec.musicResponsiveListItemRenderer as YtmResponsiveListItemRenderer;
        const rowVid =
          r?.playlistItemData?.videoId || findFirstWatchEndpoint(r)?.videoId || '';
        const mappedAtv = omvToAtvMap.get(rowVid);
        const squareThumbs =
          videoThumbMap.get(mappedAtv || rowVid) || videoThumbMap.get(rowVid);
        if (squareThumbs && r?.thumbnail?.musicThumbnailRenderer?.thumbnail) {
          r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails = squareThumbs.map(
            (t) => ({ ...t })
          );
          modified = true;
        }
      }

      // 2c. Rewrite musicTwoRowItemRenderer thumbnail (Home / Explore / Quick picks cards)
      if (rec.musicTwoRowItemRenderer) {
        const r = rec.musicTwoRowItemRenderer as YtmTwoRowItemRenderer;
        const cardWe = r?.navigationEndpoint?.watchEndpoint || findFirstWatchEndpoint(r);
        const cardVid = cardWe?.videoId || '';
        if (cardVid) {
          const mappedAtv = omvToAtvMap.get(cardVid);
          const squareThumbs =
            videoThumbMap.get(mappedAtv || cardVid) || videoThumbMap.get(cardVid);
          if (squareThumbs && r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail) {
            r.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails = squareThumbs.map(
              (t) => ({ ...t })
            );
            modified = true;
          }
        }
      }

      // 3. Rewrite any watchEndpoint pointing to a mapped OMV
      const watchEndpoint = rec.watchEndpoint as YtmWatchEndpoint | undefined;
      if (watchEndpoint?.videoId) {
        const mappedAtv = omvToAtvMap.get(watchEndpoint.videoId);
        if (mappedAtv) {
          watchEndpoint.videoId = mappedAtv;
          setMusicVideoTypeAtv(watchEndpoint);
          modified = true;
        }
      }

      // 4. Rewrite playlistItemData.videoId
      const playlistItemData = rec.playlistItemData as { videoId?: string } | undefined;
      if (playlistItemData?.videoId) {
        const mappedAtv = omvToAtvMap.get(playlistItemData.videoId);
        if (mappedAtv) {
          playlistItemData.videoId = mappedAtv;
          modified = true;
        }
      }

      // 5. Rewrite queueAddEndpoint.queueTarget.videoId
      const queueTarget = rec.queueTarget as { videoId?: string } | undefined;
      if (queueTarget?.videoId) {
        const mappedAtv = omvToAtvMap.get(queueTarget.videoId);
        if (mappedAtv) {
          queueTarget.videoId = mappedAtv;
          modified = true;
        }
      }

      const keys = Object.keys(rec);
      for (let i = 0; i < keys.length; i++) walk(rec[keys[i]]);
    }

    walk(root);
    return { modified, activeSwap };
  }

  function getPlayerBarBylineContainer(): Element | null {
    return (
      document.querySelector('ytmusic-player-bar yt-formatted-string.byline') ||
      document.querySelector('ytmusic-player-bar .byline yt-formatted-string') ||
      document.querySelector('ytmusic-player-bar .byline')
    );
  }

  function syncDomPlayerBarByline(isSwappedAtv: boolean): void {
    try {
      const bylineEl = getPlayerBarBylineContainer();
      if (!bylineEl || !bylineEl.children) return;
      const children = Array.from(bylineEl.children) as HTMLElement[];
      for (const child of children) {
        if (child?.dataset?.ytmLiteHiddenStat) {
          delete child.dataset.ytmLiteHiddenStat;
        }
      }
      if (!isSwappedAtv) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || child.tagName === 'A') continue;
        const text = (child.textContent || '').trim();
        if (!text || !isVideoStatText(text)) continue;
        child.dataset.ytmLiteHiddenStat = '1';
        for (let j = i - 1; j >= 0; j--) {
          const prev = children[j];
          if (!prev || prev.dataset?.ytmLiteHiddenStat === '1') continue;
          const prevText = (prev.textContent || '').trim();
          if (/^[•·|-]+$/.test(prevText)) {
            prev.dataset.ytmLiteHiddenStat = '1';
          }
          break;
        }
      }
      // Also hide any dangling trailing bullet separator
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (!child || child.dataset?.ytmLiteHiddenStat === '1') continue;
        const text = (child.textContent || '').trim();
        if (/^[•·|-]+$/.test(text)) {
          child.dataset.ytmLiteHiddenStat = '1';
          continue;
        }
        break;
      }
    } catch {
      // Ignore DOM byline errors
    }
  }

  function isGoogleArtUrl(url: string): boolean {
    return /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\//i.test(url);
  }

  function getGoogleArtBase(url: string): string {
    if (!isGoogleArtUrl(url)) return '';
    return url.replace(/=[^/?#]+$/, '');
  }

  function isSameGoogleArtBase(urlA: string, urlB: string): boolean {
    const baseA = getGoogleArtBase(urlA);
    return Boolean(baseA && baseA === getGoogleArtBase(urlB));
  }

  function syncMediaSessionArtwork(hiResUrl: string): void {
    try {
      if (!isGoogleArtUrl(hiResUrl)) return;
      const ms = (typeof navigator !== 'undefined' ? navigator.mediaSession : null) as
        | { metadata?: { title?: string; artist?: string; album?: string; artwork?: Array<{ src: string; sizes?: string; type?: string }> } | null }
        | null;
      if (!ms?.metadata) return;
      const curArt = ms.metadata.artwork;
      if (
        Array.isArray(curArt) &&
        curArt.some((a) => a?.src === hiResUrl)
      ) {
        return;
      }
      ms.metadata.artwork = [
        { src: hiResUrl, sizes: '544x544', type: 'image/jpeg' }
      ];
    } catch {
      // Ignore MediaSession errors in restricted environments
    }
  }

  function getPlayerResponseSquareThumb(videoId: string): string {
    try {
      const moviePlayer = document.getElementById('movie_player') as YtmMoviePlayer | null;
      const resp =
        typeof moviePlayer?.getPlayerResponse === 'function'
          ? moviePlayer.getPlayerResponse()
          : undefined;
      if (!resp?.videoDetails || resp.videoDetails.videoId !== videoId) return '';
      const thumbs = resp.videoDetails.thumbnail?.thumbnails;
      if (!Array.isArray(thumbs) || thumbs.length === 0) return '';
      // Never pull/cache 16:9 ytimg.com MV frames as square cover art
      const validGoogle = thumbs.filter(
        (t) => isAllowedThumbUrl(t?.url) && isGoogleArtUrl(t.url)
      );
      if (validGoogle.length === 0) return '';
      const best = validGoogle[validGoogle.length - 1];
      let url = best.url;
      if (/w\d+-h\d+/.test(url)) {
        url = url.replace(/w\d+-h\d+/, 'w544-h544');
      }
      if (!videoThumbMap.has(videoId)) {
        videoThumbMap.set(videoId, [{ url, width: 544, height: 544 }]);
      }
      return url;
    } catch {
      return '';
    }
  }

  function clearForcedAtvPlayerMode(playerEl: Element | null): void {
    if (!playerEl) return;
    if (playerEl.hasAttribute('data-ytm-lite-atv')) {
      playerEl.removeAttribute('data-ytm-lite-atv');
    }
    try {
      const styled = playerEl as HTMLElement;
      if (styled.style?.getPropertyValue?.('--ytmusic-player-aspect-ratio') === '1') {
        styled.style.removeProperty('--ytmusic-player-aspect-ratio');
      }
    } catch {
      // Ignore style errors
    }
  }

  function applyNativeAtvPlayerMode(
    playerEl: Element | null,
    playerPageEl: Element | null
  ): boolean {
    if (!playerEl) return false;
    if (playerEl.hasAttribute('is-advertisement-playing')) {
      clearForcedAtvPlayerMode(playerEl);
      return false;
    }
    let changed = false;
    if (playerEl.getAttribute('playback-mode') !== 'ATV_PREFERRED') {
      playerEl.setAttribute('playback-mode', 'ATV_PREFERRED');
      changed = true;
    }
    if (playerEl.hasAttribute('video-mode')) {
      playerEl.removeAttribute('video-mode');
      changed = true;
    }
    if (playerEl.getAttribute('data-ytm-lite-atv') !== '1') {
      playerEl.setAttribute('data-ytm-lite-atv', '1');
      changed = true;
    }
    try {
      const styled = playerEl as HTMLElement;
      if (styled.style?.setProperty) {
        if (styled.style.getPropertyValue?.('--ytmusic-player-aspect-ratio') !== '1') {
          styled.style.setProperty('--ytmusic-player-aspect-ratio', '1');
          changed = true;
        }
      }
    } catch {
      // Ignore style errors
    }
    try {
      const polymerPlayer = playerEl as Element & { videoMode?: boolean };
      if (polymerPlayer.videoMode === true) {
        polymerPlayer.videoMode = false;
      }
    } catch {
      // Ignore read-only Polymer property
    }
    if (playerPageEl?.hasAttribute('video-mode')) {
      playerPageEl.removeAttribute('video-mode');
      changed = true;
    }
    return changed;
  }

  function syncDomCoverArt(videoId: string): boolean {
    if (!isEnabled() || !videoId) return true;
    bindReactiveCoverSync();
    const curVidImmediate = getCurrentMoviePlayerVideoId();
    if (curVidImmediate && curVidImmediate !== videoId) {
      return false;
    }
    const thumbs = videoThumbMap.get(videoId);
    const rawCachedThumb = thumbs?.[thumbs.length - 1]?.url || '';
    const hiResUrl =
      (isGoogleArtUrl(rawCachedThumb) ? rawCachedThumb : '') ||
      getPlayerResponseSquareThumb(videoId) ||
      rawCachedThumb;

    const apply = (): void => {
      if (!isEnabled()) return;
      const playerEl = document.querySelector('ytmusic-player');
      const playerPageEl = document.querySelector('ytmusic-player-page');
      const curVid = getCurrentMoviePlayerVideoId();

      if (curVid && curVid !== videoId) return;
      if (!curVid && latestRequestedAtv && videoId !== latestRequestedAtv) return;
      if (isManualVideoActiveFor(videoId, curVid)) {
        clearForcedAtvPlayerMode(playerEl);
        return;
      }

      const isKnownAtv = atvToOmvMap.has(videoId) || knownAtvSet.has(videoId);
      if (isKnownAtv) {
        applyNativeAtvPlayerMode(playerEl, playerPageEl);
      } else {
        clearForcedAtvPlayerMode(playerEl);
      }

      syncDomPlayerBarByline(atvToOmvMap.has(videoId));

      if (!hiResUrl) return;
      const isGoogleArt = isGoogleArtUrl(hiResUrl);
      if (isGoogleArt) {
        syncMediaSessionArtwork(hiResUrl);
      }
      const targets = [
        document.querySelector('ytmusic-player #song-image #img') ||
          document.querySelector('ytmusic-player #song-image img'),
        document.querySelector('ytmusic-player-bar img.image'),
        document.querySelector('ytmusic-player-queue-item[selected] img')
      ];
      for (const img of targets) {
        if (!img) continue;
        const src = img.getAttribute('src') || '';
        if (src === hiResUrl) continue;
        const sameArtAlreadyHiRes =
          isGoogleArt && isSameGoogleArtBase(src, hiResUrl) && /w544-h544/.test(src);
        if (sameArtAlreadyHiRes) continue;
        const shouldReplace =
          !src ||
          src.startsWith('data:') ||
          src.includes('ytimg.com') ||
          isGoogleArt;
        if (shouldReplace) {
          img.setAttribute('src', hiResUrl);
        }
      }
    };

    if (typeof requestAnimationFrame === 'function' && !document.hidden) {
      requestAnimationFrame(apply);
    } else {
      apply();
    }
    return Boolean(curVidImmediate === videoId || (!curVidImmediate && videoId === latestRequestedAtv));
  }

  function enforceAtvPlayerMode(playerEl: Element | null): void {
    if (!isEnabled() || !playerEl) return;
    if (playerEl.hasAttribute('is-advertisement-playing')) {
      clearForcedAtvPlayerMode(playerEl);
      return;
    }
    const curVid = getCurrentMoviePlayerVideoId() || latestRequestedAtv;
    if (!curVid || isManualVideoActiveFor(curVid)) {
      clearForcedAtvPlayerMode(playerEl);
      return;
    }
    const isKnownAtv = atvToOmvMap.has(curVid) || knownAtvSet.has(curVid);
    if (!isKnownAtv) {
      clearForcedAtvPlayerMode(playerEl);
      return;
    }
    const playerPageEl = document.querySelector('ytmusic-player-page');
    const changed = applyNativeAtvPlayerMode(playerEl, playerPageEl);
    if (changed) {
      syncDomCoverArt(curVid);
    } else if (atvToOmvMap.has(curVid)) {
      syncDomPlayerBarByline(true);
    }
  }

  function attachPlayerDomGuard(): void {
    if (typeof MutationObserver !== 'function') return;
    const playerEl = document.querySelector('ytmusic-player');
    if (playerEl && playerEl !== observedPlayerEl) {
      if (playerModeObserver) {
        playerModeObserver.disconnect();
        playerModeObserver = null;
      }
      observedPlayerEl = playerEl;
      playerModeObserver = new MutationObserver(() => {
        enforceAtvPlayerMode(playerEl);
      });
      playerModeObserver.observe(playerEl, {
        attributes: true,
        attributeFilter: ['video-mode', 'playback-mode', 'player-ui-state', 'is-advertisement-playing']
      });
      enforceAtvPlayerMode(playerEl);
    }

    const playerPageEl = document.querySelector('ytmusic-player-page');
    if (playerPageEl && playerPageEl !== observedPlayerPageEl) {
      if (playerPageObserver) {
        playerPageObserver.disconnect();
        playerPageObserver = null;
      }
      observedPlayerPageEl = playerPageEl;
      playerPageObserver = new MutationObserver(() => {
        enforceAtvPlayerMode(document.querySelector('ytmusic-player'));
      });
      playerPageObserver.observe(playerPageEl, {
        attributes: true,
        attributeFilter: ['video-mode']
      });
      enforceAtvPlayerMode(playerEl);
    }

    const bylineEl = getPlayerBarBylineContainer();
    if (bylineEl && bylineEl !== observedBylineEl) {
      if (bylineObserver) {
        bylineObserver.disconnect();
        bylineObserver = null;
      }
      observedBylineEl = bylineEl;
      bylineObserver = new MutationObserver(() => {
        if (!isEnabled()) return;
        const curVid = getCurrentMoviePlayerVideoId() || latestRequestedAtv;
        if (!curVid || isManualVideoActiveFor(curVid)) return;
        syncDomPlayerBarByline(atvToOmvMap.has(curVid));
      });
      bylineObserver.observe(bylineEl, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    const songImgEl =
      document.querySelector('ytmusic-player #song-image #img') ||
      document.querySelector('ytmusic-player #song-image img');
    if (songImgEl && songImgEl !== observedSongImgEl) {
      if (songImgObserver) {
        songImgObserver.disconnect();
        songImgObserver = null;
      }
      observedSongImgEl = songImgEl;
      songImgObserver = new MutationObserver(() => {
        if (!isEnabled()) return;
        const curVid = getCurrentMoviePlayerVideoId() || latestRequestedAtv;
        if (!curVid || isManualVideoActiveFor(curVid)) return;
        if (!atvToOmvMap.has(curVid) && !knownAtvSet.has(curVid)) return;
        const src = songImgEl.getAttribute('src') || '';
        const thumbs = videoThumbMap.get(curVid);
        const hiResUrl =
          thumbs?.[thumbs.length - 1]?.url || getPlayerResponseSquareThumb(curVid);
        if (
          hiResUrl &&
          src !== hiResUrl &&
          (!src || src.startsWith('data:') || src.includes('ytimg.com'))
        ) {
          songImgEl.setAttribute('src', hiResUrl);
        }
      });
      songImgObserver.observe(songImgEl, {
        attributes: true,
        attributeFilter: ['src']
      });
    }
  }

  function bindReactiveCoverSync(): void {
    attachPlayerDomGuard();
    if (boundSyncVideoEl && boundSyncVideoEl.isConnected) return;
    const videoEl = document.querySelector<HTMLVideoElement>('ytmusic-player video');
    if (!videoEl) return;
    boundSyncVideoEl = videoEl;
    if (videoEl.dataset.ytmLiteSyncBound === '1') return;

    videoEl.dataset.ytmLiteSyncBound = '1';
    const onVideoActive = (): void => {
      if (!isEnabled()) return;
      attachPlayerDomGuard();
      const curVid = getCurrentMoviePlayerVideoId();
      if (!curVid) return;
      if (atvToOmvMap.has(curVid) || knownAtvSet.has(curVid) || videoThumbMap.has(curVid)) {
        syncDomCoverArt(curVid);
        scheduleCoverSync(curVid, 180);
      }
    };
    videoEl.addEventListener('loadedmetadata', onVideoActive);
    videoEl.addEventListener('canplay', onVideoActive);
    videoEl.addEventListener('durationchange', onVideoActive);
    videoEl.addEventListener('play', onVideoActive);
    videoEl.addEventListener('playing', onVideoActive);
  }

  function redirectPlayerToAtv({
    omvId,
    atvId,
    expectedSeq = 0
  }: {
    omvId: string;
    atvId: string;
    expectedSeq?: number;
  }): void {
    if (!isEnabled() || !atvId) return;

    if (expectedSeq && expectedSeq !== activeTrackSeq) {
      return;
    }
    if (isManualVideoActiveFor(omvId, atvId)) {
      return;
    }

    const moviePlayer = document.getElementById('movie_player') as YtmMoviePlayer | null;
    const currentVideoId = getCurrentMoviePlayerVideoId();

    if (currentVideoId === atvId) {
      syncDomCoverArt(atvId);
      return;
    }

    if (wasRecentlyLoadedAsAtv(omvId, atvId)) {
      syncDomCoverArt(atvId);
      return;
    }

    if (!currentVideoId) {
      if (!omvId || omvId !== latestRequestedOmv) return;
    } else if (omvId && currentVideoId !== omvId) {
      return;
    }

    const now = Date.now();
    if (omvId === lastRedirectedOmv && now - lastRedirectTime < 2500) {
      return;
    }

    lastRedirectedOmv = omvId;
    lastRedirectTime = now;
    latestRequestedAtv = atvId;

    const avToggle = document.querySelector('ytmusic-av-toggle');
    if (
      avToggle &&
      !avToggle.hasAttribute('toggle-disabled') &&
      avToggle.getAttribute('playback-mode') === 'OMV_PREFERRED'
    ) {
      const songBtn = avToggle.querySelector<HTMLElement>('.song-button');
      if (
        songBtn &&
        !songBtn.hasAttribute('disabled') &&
        songBtn.getAttribute('aria-disabled') !== 'true'
      ) {
        songBtn.click();
        return;
      }
    }

    if (moviePlayer && typeof moviePlayer.loadVideoById === 'function') {
      try {
        const rawTime =
          typeof moviePlayer.getCurrentTime === 'function'
            ? Number(moviePlayer.getCurrentTime())
            : 0;
        const startSeconds =
          Number.isFinite(rawTime) && rawTime > 0.25 && rawTime < 60
            ? Math.round(rawTime * 10) / 10
            : 0;
        const isPaused =
          typeof moviePlayer.getPlayerState === 'function' &&
          moviePlayer.getPlayerState() === 2;
        const loadFn =
          isPaused && typeof moviePlayer.cueVideoById === 'function'
            ? moviePlayer.cueVideoById
            : moviePlayer.loadVideoById;
        markPlayerRequest(atvId, omvId);
        if (startSeconds > 0) {
          loadFn.call(moviePlayer, { videoId: atvId, startSeconds });
        } else {
          loadFn.call(moviePlayer, atvId);
        }
        emitSwapState(false, atvId);
        scheduleCoverSync(atvId, 150);
      } catch {
        // Ignore
      }
    }
  }

  function getRequestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  async function decodeBytesToText(bytes: Uint8Array): Promise<string> {
    if (!bytes || bytes.byteLength === 0) return '';
    if (
      bytes.byteLength >= 2 &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b &&
      typeof DecompressionStream === 'function'
    ) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const ds = new Blob([copy]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(ds).text();
    }
    return new TextDecoder().decode(bytes);
  }

  async function readRequestBodyObj(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<YoutubeiRequestBody | null> {
    try {
      let bodyText: string | null = null;
      if (init && typeof init.body === 'string') {
        bodyText = init.body;
      } else if (init && init.body instanceof ArrayBuffer) {
        bodyText = await decodeBytesToText(new Uint8Array(init.body));
      } else if (init && ArrayBuffer.isView(init.body)) {
        bodyText = await decodeBytesToText(
          new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength)
        );
      } else if (init && init.body instanceof Blob) {
        bodyText = await decodeBytesToText(new Uint8Array(await init.body.arrayBuffer()));
      } else if (input instanceof Request) {
        const buf = await input.clone().arrayBuffer();
        bodyText = await decodeBytesToText(new Uint8Array(buf));
      }
      return bodyText ? (JSON.parse(bodyText) as YoutubeiRequestBody) : null;
    } catch {
      return null;
    }
  }

  function replaceRequestBody(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    bodyObj: YoutubeiRequestBody
  ): { input: RequestInfo | URL; init: RequestInit | undefined } {
    const newBody = JSON.stringify(bodyObj);
    if (init && init.body !== undefined) {
      const headers = new Headers(
        init.headers || (input instanceof Request ? input.headers : undefined)
      );
      headers.delete('content-encoding');
      headers.delete('content-length');
      return { input, init: { ...init, headers, body: newBody } };
    }
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      if (init?.headers) {
        new Headers(init.headers).forEach((val, key) => headers.set(key, val));
      }
      headers.delete('content-encoding');
      headers.delete('content-length');
      const nextInit: RequestInit = init ? { ...init, headers } : { headers };
      return { input: new Request(input, { ...nextInit, body: newBody }), init: undefined };
    }
    return { input, init };
  }

  function captureAuthHeadersFromFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): void {
    try {
      const merged: Record<string, string> = {};
      const sources: Array<HeadersInit | null> = [
        input instanceof Request ? input.headers : null,
        init?.headers || null
      ];
      for (const src of sources) {
        if (!src) continue;
        if (src instanceof Headers) {
          src.forEach((val, key) => {
            merged[key.toLowerCase()] = val;
          });
        } else if (Array.isArray(src)) {
          for (const pair of src) {
            if (Array.isArray(pair) && pair[0] && pair[1]) {
              merged[String(pair[0]).toLowerCase()] = String(pair[1]);
            }
          }
        } else if (typeof src === 'object') {
          for (const [k, v] of Object.entries(src)) {
            if (typeof v === 'string' && v) {
              merged[k.toLowerCase()] = v;
            }
          }
        }
      }
      setAuthHeaders?.(merged);
    } catch {
      // Ignore header read errors
    }
  }

  window.fetch = async function ytmLiteFetch(
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    if (!isEnabled()) {
      return originalFetch.call(this, input, init);
    }

    const url = getRequestUrl(input);
    const isPlayerReq = url.includes('/youtubei/v1/player');
    const isNextReq =
      url.includes('/youtubei/v1/next') ||
      url.includes('/youtubei/v1/music/get_queue');
    const isBrowseReq = url.includes('/youtubei/v1/browse');
    const isSearchReq = url.includes('/youtubei/v1/search');

    if (!isPlayerReq && !isNextReq && !isBrowseReq && !isSearchReq) {
      return originalFetch.call(this, input, init);
    }

    captureAuthHeadersFromFetch(input, init);

    if (isSearchReq) {
      const searchRes = await originalFetch.call(this, input, init);
      if (searchRes.ok) {
        (async () => {
          try {
            const searchJson: unknown = await searchRes.clone().json();
            registerTracksMetadata(extractResponsiveItems(searchJson));
          } catch {
            // Ignore parse errors
          }
        })();
      }
      return searchRes;
    }

    let nextInput = input;
    let nextInit = init;
    const reqBody = await readRequestBodyObj(input, init);
    const origPlayerVideoId = isPlayerReq ? reqBody?.videoId || '' : '';
    let playerRetryInput: RequestInfo | URL | null = null;
    let playerReqSeq = 0;
    let playerAbortSignal: AbortSignal | undefined;
    let preWaitTimedOut = false;

    if (isPlayerReq && origPlayerVideoId) {
      bindReactiveCoverSync();
      const trackCtx = beginActiveTrack(origPlayerVideoId);
      playerReqSeq = trackCtx.seq;
      playerAbortSignal = trackCtx.signal;

      if (isManualVideoActiveFor(origPlayerVideoId)) {
        latestRequestedAtv = '';
        markPlayerRequest(origPlayerVideoId, '');
        emitSwapState(false, origPlayerVideoId);
        return originalFetch.call(this, nextInput, nextInit);
      }

      let mappedAtv = omvToAtvMap.get(origPlayerVideoId);
      const knownMeta = knownOmvMeta.get(origPlayerVideoId);
      if (!mappedAtv && !noAtvSet.has(origPlayerVideoId) && knownMeta) {
        pendingPlayerSwaps.add(origPlayerVideoId);
        emitSwapState(true, origPlayerVideoId);
        try {
          const resolvePromise = resolveTrack(
            knownMeta,
            url,
            reqBody?.context,
            { signal: playerAbortSignal || null }
          );
          const { timedOut } = await waitForResolve(
            resolvePromise,
            PLAYER_RESOLVE_TIMEOUT_MS
          );
          mappedAtv = omvToAtvMap.get(origPlayerVideoId);
          if (timedOut && !mappedAtv && isCurrentTrack(playerReqSeq)) {
            preWaitTimedOut = true;
            void scheduleLateRedirect(resolvePromise, origPlayerVideoId, playerReqSeq);
          }
        } finally {
          pendingPlayerSwaps.delete(origPlayerVideoId);
          if (isCurrentTrack(playerReqSeq)) {
            emitSwapState(false, mappedAtv || origPlayerVideoId);
          }
        }
      }

      if (!isCurrentTrack(playerReqSeq)) {
        return originalFetch.call(this, nextInput, nextInit);
      }

      if (mappedAtv) {
        latestRequestedAtv = mappedAtv;
        if (reqBody) {
          reqBody.videoId = mappedAtv;
          const replaced = replaceRequestBody(nextInput, nextInit, reqBody);
          nextInput = replaced.input;
          nextInit = replaced.init;
        }
        markPlayerRequest(mappedAtv, origPlayerVideoId);
        emitSwapState(false, mappedAtv);
        scheduleCoverSync(mappedAtv, 120);
        scheduleQueuePrefetchForActiveTrack(origPlayerVideoId);
      } else {
        latestRequestedAtv = knownAtvSet.has(origPlayerVideoId) ? origPlayerVideoId : '';
        markPlayerRequest(origPlayerVideoId, '');
        if (
          !preWaitTimedOut &&
          !noAtvSet.has(origPlayerVideoId) &&
          !knownAtvSet.has(origPlayerVideoId)
        ) {
          pendingPlayerSwaps.add(origPlayerVideoId);
          emitSwapState(true, origPlayerVideoId);
          playerRetryInput = input instanceof Request ? input.clone() : input;
        } else {
          emitSwapState(false, origPlayerVideoId);
        }
      }
    }

    if (isNextReq && reqBody?.videoId && reqBody?.playlistId) {
      const originalOmv = atvToOmvMap.get(reqBody.videoId);
      if (originalOmv) {
        reqBody.videoId = originalOmv;
        const replaced = replaceRequestBody(nextInput, nextInit, reqBody);
        nextInput = replaced.input;
        nextInit = replaced.init;
      }
    }

    let response: Response;
    try {
      response = await originalFetch.call(this, nextInput, nextInit);
    } catch (err) {
      if (origPlayerVideoId) {
        pendingPlayerSwaps.delete(origPlayerVideoId);
        if (isCurrentTrack(playerReqSeq)) {
          emitSwapState(false, origPlayerVideoId);
        }
      }
      throw err;
    }

    if (!response.ok) {
      if (origPlayerVideoId) {
        pendingPlayerSwaps.delete(origPlayerVideoId);
        if (isCurrentTrack(playerReqSeq)) {
          emitSwapState(false, origPlayerVideoId);
        }
      }
      return response;
    }

    if (isPlayerReq) {
      try {
        if (
          playerRetryInput &&
          origPlayerVideoId &&
          isCurrentTrack(playerReqSeq) &&
          !omvToAtvMap.has(origPlayerVideoId)
        ) {
          const playerData = (await response.clone().json()) as YtmPlayerData;
          const parsedPlayerTrack = extractTrackFromPlayerData(
            playerData,
            origPlayerVideoId
          );
          if (parsedPlayerTrack?.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') {
            registerTracksMetadata([parsedPlayerTrack]);
            if (isCurrentTrack(playerReqSeq)) {
              latestRequestedAtv = origPlayerVideoId;
              scheduleCoverSync(origPlayerVideoId, 120);
            }
          }
          const knownMeta = knownOmvMeta.get(origPlayerVideoId);
          const resolvedTrackInput =
            knownMeta?.artistBrowseId && parsedPlayerTrack
              ? {
                  ...parsedPlayerTrack,
                  artist: knownMeta.artist || parsedPlayerTrack.artist,
                  artistBrowseId: knownMeta.artistBrowseId,
                  lowConfidenceAuthor: false
                }
              : parsedPlayerTrack;
          if (
            isCurrentTrack(playerReqSeq) &&
            resolvedTrackInput &&
            isResolvableNonAtvType(
              resolvedTrackInput.musicVideoType,
              resolvedTrackInput
            )
          ) {
            const resolvePromise = resolveTrack(
              resolvedTrackInput,
              url,
              reqBody?.context,
              { signal: playerAbortSignal || null }
            );
            const { timedOut } = await waitForResolve(
              resolvePromise,
              COLD_PLAYER_RESOLVE_TIMEOUT_MS
            );
            if (!isCurrentTrack(playerReqSeq)) {
              return response;
            }
            const resolvedAtv = omvToAtvMap.get(origPlayerVideoId);
            if (resolvedAtv && reqBody) {
              const retryBody: YoutubeiRequestBody = { ...reqBody, videoId: resolvedAtv };
              const replaced = replaceRequestBody(playerRetryInput, init, retryBody);
              const atvResponse = await originalFetch.call(
                this,
                replaced.input,
                replaced.init
              );
              if (atvResponse.ok && isCurrentTrack(playerReqSeq)) {
                latestRequestedAtv = resolvedAtv;
                markPlayerRequest(resolvedAtv, origPlayerVideoId);
                emitSwapState(false, resolvedAtv);
                scheduleCoverSync(resolvedAtv, 120);
                scheduleQueuePrefetchForActiveTrack(origPlayerVideoId);
                return atvResponse;
              }
            } else if (timedOut) {
              void scheduleLateRedirect(resolvePromise, origPlayerVideoId, playerReqSeq);
            }
          }
        }
      } catch (err) {
        debugLog('inject', '/player intercept error; falling back', origPlayerVideoId, err);
      } finally {
        if (origPlayerVideoId) {
          pendingPlayerSwaps.delete(origPlayerVideoId);
          if (isCurrentTrack(playerReqSeq)) {
            emitSwapState(false, omvToAtvMap.get(origPlayerVideoId) || origPlayerVideoId);
            scheduleQueuePrefetchForActiveTrack(origPlayerVideoId);
          }
        }
      }

      return response;
    }

    try {
      const data: unknown = await response.clone().json();

      if (isBrowseReq) {
        const browseId = reqBody?.browseId || '';
        if (!browseId.startsWith('VLOLAK5uy_')) {
          const items = extractResponsiveItems(data);
          registerTracksMetadata(items);
          const olakTrack = items.find(
            (t) =>
              Boolean(t.playlistId?.startsWith('OLAK5uy_')) &&
              t.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV'
          );
          if (olakTrack?.playlistId) {
            const vlPromise = fetchVlAlbumTracks(
              olakTrack.playlistId,
              url,
              reqBody?.context
            );
            // Keep page browsing snappy: use VL immediately only if cached/fast, otherwise pair in background
            const vlWait = await waitForResolve(vlPromise, BROWSE_VL_WAIT_MS);
            if (!vlWait.timedOut) {
              pairAndRememberTracks(items, await vlPromise);
            } else {
              void pairVlInBackground(vlPromise, items);
            }
          }
        }
      }

      const nextReqSeq = activeTrackSeq;
      if (isNextReq) {
        collectCounterpartMappings(data);

        const panelItems = extractPlaylistPanelItems(data);
        registerTracksMetadata(panelItems);
        updateActiveQueue(panelItems, url, reqBody?.context);

        const olakPlaylistId =
          (typeof reqBody?.playlistId === 'string' &&
          reqBody.playlistId.startsWith('OLAK5uy_')
            ? reqBody.playlistId
            : panelItems.find((t) => t.playlistId?.startsWith('OLAK5uy_'))
                ?.playlistId) || '';

        const nextDeadline = Date.now() + NEXT_RESOLVE_TIMEOUT_MS;

        if (
          olakPlaylistId &&
          panelItems.some((t) => t.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV')
        ) {
          const vlPromise = fetchVlAlbumTracks(
            olakPlaylistId,
            url,
            reqBody?.context
          );
          const vlWait = await waitForResolve(
            vlPromise,
            Math.max(0, nextDeadline - Date.now())
          );
          if (!vlWait.timedOut) {
            pairAndRememberTracks(panelItems, await vlPromise);
          } else {
            void pairVlInBackground(vlPromise, panelItems);
          }
        }

        const selectedItem = panelItems.find((t) => t.selected) || panelItems[0];
        if (selectedItem?.videoId) {
          if (
            isCurrentTrack(nextReqSeq) &&
            !isManualVideoActiveFor(selectedItem.videoId) &&
            isResolvableNonAtvType(selectedItem.musicVideoType, selectedItem) &&
            !omvToAtvMap.has(selectedItem.videoId) &&
            !noAtvSet.has(selectedItem.videoId)
          ) {
            const selectedPromise = resolveTrack(selectedItem, url, reqBody?.context);
            const remainingMs = Math.max(0, nextDeadline - Date.now());
            const selectedWait =
              remainingMs > 0
                ? await waitForResolve(selectedPromise, remainingMs)
                : { resolved: false, timedOut: true };
            if (selectedWait.timedOut && !omvToAtvMap.has(selectedItem.videoId)) {
              void scheduleLateRedirect(selectedPromise, selectedItem.videoId, nextReqSeq);
            }
          }
        }

        if (isCurrentTrack(nextReqSeq)) {
          scheduleNextTrackPrefetch(
            panelItems,
            url,
            reqBody?.context,
            selectedItem?.videoId || ''
          );
        }
      }

      const { modified, activeSwap } = rewritePayloadToAtv(data);

      if (isNextReq && isCurrentTrack(nextReqSeq)) {
        if (activeSwap) {
          const swap = activeSwap;
          if (wasRecentlyLoadedAsAtv(swap.omvId, swap.atvId)) {
            scheduleCoverSync(swap.atvId, 120);
          } else {
            setTimeout(
              () =>
                redirectPlayerToAtv({
                  ...swap,
                  expectedSeq: nextReqSeq
                }),
              0
            );
          }
        } else {
          const currentVid = new URLSearchParams(window.location.search).get('v');
          if (currentVid && videoThumbMap.has(currentVid)) {
            scheduleCoverSync(currentVid, 120);
          }
        }
      }

      if (!modified) {
        return response;
      }

      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function ytmLiteXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    asyncFlag?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    try {
      const urlStr = typeof url === 'string' ? url : String(url || '');
      this.__ytmSeq = (this.__ytmSeq || 0) + 1;
      this.__ytmLite = {
        method: String(method || '').toUpperCase(),
        url: urlStr,
        async: asyncFlag !== false,
        seq: this.__ytmSeq,
        headers: {}
      };
    } catch {
      this.__ytmLite = null;
    }
    Reflect.apply(originalXhrOpen, this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function ytmLiteXhrSetHeader(
    this: XMLHttpRequest,
    name: string,
    value: string
  ): void {
    try {
      if (this.__ytmLite?.headers && name && typeof value === 'string') {
        this.__ytmLite.headers[String(name).toLowerCase()] = value;
      }
    } catch {
      // Ignore header tracking errors
    }
    originalXhrSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function ytmLiteXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const meta = this.__ytmLite;
    if (!isEnabled() || !meta || !meta.async || typeof body !== 'string') {
      originalXhrSend.call(this, body);
      return;
    }

    const url = meta.url;
    const isPlayerReq = url.includes('/youtubei/v1/player');
    const isNextReq =
      url.includes('/youtubei/v1/next') ||
      url.includes('/youtubei/v1/music/get_queue');

    if (!isPlayerReq && !isNextReq) {
      originalXhrSend.call(this, body);
      return;
    }

    if (meta.headers) {
      setAuthHeaders?.(meta.headers);
    }

    let reqBody: YoutubeiRequestBody | null = null;
    try {
      reqBody = JSON.parse(body) as YoutubeiRequestBody;
    } catch {
      originalXhrSend.call(this, body);
      return;
    }

    if (isPlayerReq && reqBody?.videoId) {
      bindReactiveCoverSync();
      const origVid = reqBody.videoId;
      const trackCtx = beginActiveTrack(origVid);
      const xhrReqSeq = trackCtx.seq;
      const xhrAbortSignal = trackCtx.signal;
      const absUrl = url.startsWith('http')
        ? url
        : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;

      if (isManualVideoActiveFor(origVid)) {
        latestRequestedAtv = '';
        markPlayerRequest(origVid, '');
        emitSwapState(false, origVid);
        originalXhrSend.call(this, body);
        return;
      }

      const mappedAtv = omvToAtvMap.get(origVid);
      if (mappedAtv) {
        latestRequestedAtv = mappedAtv;
        reqBody.videoId = mappedAtv;
        markPlayerRequest(mappedAtv, origVid);
        emitSwapState(false, mappedAtv);
        scheduleCoverSync(mappedAtv, 120);
        scheduleQueuePrefetchForActiveTrack(origVid);
        originalXhrSend.call(this, JSON.stringify(reqBody));
        return;
      }

      const knownMeta = knownOmvMeta.get(origVid);
      if (!noAtvSet.has(origVid) && knownMeta) {
        const xhr = this;
        const seq = meta.seq;
        pendingPlayerSwaps.add(origVid);
        emitSwapState(true, origVid);
        (async () => {
          try {
            const resolvePromise = resolveTrack(
              knownMeta,
              absUrl,
              reqBody?.context,
              { signal: xhrAbortSignal || null }
            );
            const { timedOut } = await waitForResolve(
              resolvePromise,
              PLAYER_RESOLVE_TIMEOUT_MS
            );
            if (xhr.__ytmSeq !== seq || xhr.readyState !== XMLHttpRequest.OPENED) return;
            const resolvedAtv = omvToAtvMap.get(origVid);
            if (resolvedAtv && reqBody && isCurrentTrack(xhrReqSeq)) {
              latestRequestedAtv = resolvedAtv;
              reqBody.videoId = resolvedAtv;
              markPlayerRequest(resolvedAtv, origVid);
              scheduleCoverSync(resolvedAtv, 120);
              originalXhrSend.call(xhr, JSON.stringify(reqBody));
            } else {
              markPlayerRequest(origVid, '');
              originalXhrSend.call(xhr, body);
              if (timedOut && isCurrentTrack(xhrReqSeq)) {
                void scheduleLateRedirect(resolvePromise, origVid, xhrReqSeq);
              }
            }
          } catch {
            if (xhr.__ytmSeq === seq && xhr.readyState === XMLHttpRequest.OPENED) {
              markPlayerRequest(origVid, '');
              originalXhrSend.call(xhr, body);
            }
          } finally {
            pendingPlayerSwaps.delete(origVid);
            if (isCurrentTrack(xhrReqSeq)) {
              emitSwapState(false, omvToAtvMap.get(origVid) || origVid);
            }
          }
        })();
        return;
      }

      latestRequestedAtv = knownAtvSet.has(origVid) ? origVid : '';
      markPlayerRequest(origVid, '');

      if (!noAtvSet.has(origVid) && !knownAtvSet.has(origVid)) {
        const xhr = this;
        let coldDone = false;
        const finishColdSwap = (finalVid: string): void => {
          if (coldDone) return;
          coldDone = true;
          pendingPlayerSwaps.delete(origVid);
          if (isCurrentTrack(xhrReqSeq)) {
            emitSwapState(false, finalVid || origVid);
          }
        };
        pendingPlayerSwaps.add(origVid);
        emitSwapState(true, origVid);
        xhr.addEventListener('error', () => finishColdSwap(origVid), { once: true });
        xhr.addEventListener('abort', () => finishColdSwap(origVid), { once: true });
        xhr.addEventListener('load', async () => {
          if (!isEnabled() || !isCurrentTrack(xhrReqSeq)) {
            finishColdSwap(origVid);
            return;
          }
          let finalVid = origVid;
          try {
            const text =
              xhr.responseType === '' || xhr.responseType === 'text'
                ? xhr.responseText
                : '';
            const playerData = (
              xhr.responseType === 'json'
                ? xhr.response
                : text
                  ? JSON.parse(text)
                  : null
            ) as YtmPlayerData | null;
            const parsedPlayerTrack = extractTrackFromPlayerData(playerData, origVid);
            if (parsedPlayerTrack?.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') {
              registerTracksMetadata([parsedPlayerTrack]);
              if (isCurrentTrack(xhrReqSeq)) {
                latestRequestedAtv = origVid;
                scheduleCoverSync(origVid, 120);
              }
            }
            const metaEntry = knownOmvMeta.get(origVid);
            const resolvedTrackInput =
              metaEntry?.artistBrowseId && parsedPlayerTrack
                ? {
                    ...parsedPlayerTrack,
                    artist: metaEntry.artist || parsedPlayerTrack.artist,
                    artistBrowseId: metaEntry.artistBrowseId,
                    lowConfidenceAuthor: false
                  }
                : parsedPlayerTrack;
            if (
              isCurrentTrack(xhrReqSeq) &&
              resolvedTrackInput &&
              isResolvableNonAtvType(
                resolvedTrackInput.musicVideoType,
                resolvedTrackInput
              )
            ) {
              const found = await resolveTrack(
                resolvedTrackInput,
                absUrl,
                reqBody?.context,
                { signal: xhrAbortSignal || null }
              );
              const resolvedAtv = found ? omvToAtvMap.get(origVid) : '';
              if (resolvedAtv && isCurrentTrack(xhrReqSeq)) {
                finalVid = resolvedAtv;
                redirectPlayerToAtv({
                  omvId: origVid,
                  atvId: resolvedAtv,
                  expectedSeq: xhrReqSeq
                });
              }
            }
          } catch {
            // Ignore parse errors
          } finally {
            finishColdSwap(finalVid);
          }
        });
      } else {
        emitSwapState(false, origVid);
      }

      originalXhrSend.call(this, body);
      return;
    }

    if (isNextReq && reqBody?.videoId && reqBody?.playlistId) {
      const originalOmv = atvToOmvMap.get(reqBody.videoId);
      if (originalOmv) {
        reqBody.videoId = originalOmv;
        originalXhrSend.call(this, JSON.stringify(reqBody));
        return;
      }
    }

    originalXhrSend.call(this, body);
  };

  const processedInitialEntries = new WeakSet<object>();

  interface InitialDataEntry {
    path?: unknown;
    data?: unknown;
  }

  function processInitialDataEntry(entry: unknown): unknown {
    if (!isEnabled() || !entry || typeof entry !== 'object') return entry;
    if (processedInitialEntries.has(entry)) return entry;
    processedInitialEntries.add(entry);

    const typedEntry = entry as InitialDataEntry;
    const path = String(typedEntry.path || '');
    if (!path.includes('/browse') && !path.includes('/next')) return entry;

    try {
      const isString = typeof typedEntry.data === 'string';
      const parsed: unknown = isString
        ? JSON.parse(typedEntry.data as string)
        : typedEntry.data;
      if (!parsed || typeof parsed !== 'object') return entry;

      collectCounterpartMappings(parsed);
      const responsiveItems = extractResponsiveItems(parsed);
      const panelItems = extractPlaylistPanelItems(parsed);
      const allItems = [...responsiveItems, ...panelItems];
      registerTracksMetadata(allItems);
      if (panelItems.length > 0) {
        updateActiveQueue(
          panelItems,
          `${window.location.origin}/youtubei/v1/search?prettyPrint=false`
        );
      }

      const { modified } = rewritePayloadToAtv(parsed);
      if (modified && isString) {
        typedEntry.data = JSON.stringify(parsed);
      }
    } catch {
      // Ignore parse errors
    }
    return entry;
  }

  function processInitialDataList(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      processInitialDataEntry(list[i]);
    }
  }

  function installInitialDataHook(): void {
    function wrapYtcfgSet(cfg: YtmCfg | undefined): void {
      if (!cfg || typeof cfg !== 'object' || cfg.__ytmLiteSetHooked) return;
      cfg.__ytmLiteSetHooked = true;

      const prevSetDesc = Object.getOwnPropertyDescriptor(cfg, 'set');
      const prevSetGet = prevSetDesc?.get;
      const prevSetSet = prevSetDesc?.set;
      let origSet = typeof cfg.set === 'function' ? cfg.set : undefined;
      function wrappedSet(this: unknown, ...args: unknown[]): unknown {
        try {
          const first = args[0] as { YTMUSIC_INITIAL_DATA?: unknown } | string | undefined;
          if (first && typeof first === 'object' && Array.isArray(first.YTMUSIC_INITIAL_DATA)) {
            processInitialDataList(first.YTMUSIC_INITIAL_DATA);
          } else if (first === 'YTMUSIC_INITIAL_DATA' && Array.isArray(args[1])) {
            processInitialDataList(args[1]);
          }
        } catch {
          // Ignore
        }
        const currentOrig = prevSetGet
          ? (prevSetGet.call(cfg) as ((...a: unknown[]) => unknown) | undefined)
          : origSet;
        const targetFn =
          typeof currentOrig === 'function' && currentOrig !== wrappedSet
            ? currentOrig
            : origSet;
        return targetFn ? targetFn.apply(this, args) : undefined;
      }

      if (!prevSetDesc || prevSetDesc.configurable !== false) {
        try {
          Object.defineProperty(cfg, 'set', {
            configurable: true,
            enumerable: true,
            get() {
              const cur = prevSetGet ? prevSetGet.call(cfg) : origSet;
              return typeof cur === 'function' ? wrappedSet : undefined;
            },
            set(fn: unknown) {
              if (fn === wrappedSet) return;
              if (prevSetSet) {
                prevSetSet.call(cfg, fn);
              }
              origSet = typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : undefined;
            }
          });
        } catch {
          if (origSet) cfg.set = wrappedSet;
        }
      } else if (origSet && prevSetDesc.writable) {
        cfg.set = wrappedSet;
      }

      try {
        const existing = cfg.get?.('YTMUSIC_INITIAL_DATA');
        if (Array.isArray(existing)) processInitialDataList(existing);
      } catch {
        // Ignore
      }
    }

    const prevYtcfgDesc = Object.getOwnPropertyDescriptor(window, 'ytcfg');
    const prevYtcfgGet = prevYtcfgDesc?.get;
    const prevYtcfgSet = prevYtcfgDesc?.set;
    let backingYtcfg = window.ytcfg;
    if (backingYtcfg && typeof backingYtcfg === 'object') {
      wrapYtcfgSet(backingYtcfg);
    }

    if (!prevYtcfgDesc || prevYtcfgDesc.configurable !== false) {
      try {
        Object.defineProperty(window, 'ytcfg', {
          configurable: true,
          enumerable: true,
          get() {
            return prevYtcfgGet
              ? (prevYtcfgGet.call(window) as YtmCfg | undefined)
              : backingYtcfg;
          },
          set(val: YtmCfg | undefined) {
            if (prevYtcfgSet) {
              prevYtcfgSet.call(window, val);
            }
            backingYtcfg = val;
            const resolved = prevYtcfgGet
              ? (prevYtcfgGet.call(window) as YtmCfg | undefined)
              : val;
            if (resolved && typeof resolved === 'object') {
              wrapYtcfgSet(resolved);
            }
          }
        });
      } catch {
        // Fall through to DOMContentLoaded scan
      }
    }

    window.addEventListener(
      'DOMContentLoaded',
      () => {
        bindReactiveCoverSync();
        try {
          const list = window.ytcfg?.get?.('YTMUSIC_INITIAL_DATA');
          if (Array.isArray(list)) processInitialDataList(list);
        } catch {
          // Ignore
        }
      },
      { once: true }
    );
    window.addEventListener('yt-navigate-finish', () => {
      bindReactiveCoverSync();
    });
  }

  const TRACK_ROW_SELECTOR =
    'ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer, ytmusic-player-queue-item';

  function extractVideoIdFromRowElement(itemEl: Element): string {
    if (typeof itemEl.querySelector === 'function') {
      const link = itemEl.querySelector('a[href*="watch?v="]');
      const href = link?.getAttribute?.('href') || '';
      const linkMatch = href.match(/[?&]v=([A-Za-z0-9_-]{11})\b/);
      if (linkMatch?.[1] && isSafeVideoId(linkMatch[1])) {
        return linkMatch[1];
      }

      const thumbImg = itemEl.querySelector('img[src*="ytimg.com/vi/"]');
      const thumbSrc = thumbImg?.getAttribute?.('src') || '';
      const thumbMatch = thumbSrc.match(/\/vi\/([A-Za-z0-9_-]{11})\//);
      if (thumbMatch?.[1] && isSafeVideoId(thumbMatch[1])) {
        return thumbMatch[1];
      }
    }

    try {
      const polymerEl = itemEl as Element & {
        data?: Record<string, unknown>;
        __data?: { data?: Record<string, unknown> };
      };
      const dataObj = polymerEl.data || polymerEl.__data?.data;
      if (dataObj && typeof dataObj === 'object') {
        const directId =
          (dataObj.videoId as string | undefined) ||
          ((dataObj.playlistItemData as { videoId?: string } | undefined)?.videoId) ||
          findFirstWatchEndpoint(dataObj)?.videoId ||
          '';
        if (isSafeVideoId(directId)) {
          return directId;
        }
      }
    } catch {
      // Ignore Polymer data read errors
    }

    return '';
  }

  function triggerRowPrefetch(vid: string): void {
    if (!isEnabled() || !vid || omvToAtvMap.has(vid) || noAtvSet.has(vid)) return;
    if (typeof getBackoffRemainingMs === 'function' && getBackoffRemainingMs() > 0) return;
    const meta = knownOmvMeta.get(vid);
    if (!meta) return;
    void resolveTrack(meta, `${window.location.origin}/youtubei/v1/search?prettyPrint=false`);
  }

  function installPointerPrefetch(): void {
    if (pointerPrefetchBound || typeof document?.addEventListener !== 'function') return;
    pointerPrefetchBound = true;

    document.addEventListener(
      'pointerover',
      (event: Event) => {
        if (!isEnabled()) return;
        const target = event.target as Element | null;
        if (!target || typeof target.closest !== 'function') return;
        const itemEl = target.closest(TRACK_ROW_SELECTOR);
        if (!itemEl) return;
        const vid = extractVideoIdFromRowElement(itemEl);
        if (!vid || vid === lastHoveredVideoId || omvToAtvMap.has(vid) || noAtvSet.has(vid)) {
          return;
        }
        lastHoveredVideoId = vid;
        if (hoverPrefetchTimer !== null) {
          clearTimeout(hoverPrefetchTimer);
        }
        hoverPrefetchTimer = setTimeout(() => {
          hoverPrefetchTimer = null;
          triggerRowPrefetch(vid);
        }, HOVER_PREFETCH_DELAY_MS);
      },
      true
    );

    document.addEventListener(
      'pointerdown',
      (event: Event) => {
        if (!isEnabled()) return;
        if (hoverPrefetchTimer !== null) {
          clearTimeout(hoverPrefetchTimer);
          hoverPrefetchTimer = null;
        }
        const target = event.target as Element | null;
        if (!target || typeof target.closest !== 'function') return;
        const itemEl = target.closest(TRACK_ROW_SELECTOR);
        if (!itemEl) return;
        const vid = extractVideoIdFromRowElement(itemEl);
        if (vid) {
          triggerRowPrefetch(vid);
        }
      },
      true
    );
  }

  installInitialDataHook();
  installPointerPrefetch();

  window.addEventListener('ytm-lite-settings', (event: Event) => {
    const customEvent = event as CustomEvent<Partial<YtmLiteSettings> | undefined>;
    if (customEvent?.detail && customEvent.detail.enabled === false) {
      cancelNextPrefetch();
      if (hoverPrefetchTimer !== null) {
        clearTimeout(hoverPrefetchTimer);
        hoverPrefetchTimer = null;
      }
      lastHoveredVideoId = '';
      activeQueueItems = [];
      if (activePlayerAbortController) {
        try {
          activePlayerAbortController.abort();
        } catch {
          // Ignore abort errors
        }
        activePlayerAbortController = null;
        activePlayerAbortVideoId = '';
      }
      if (coverSyncTimer !== null) {
        clearTimeout(coverSyncTimer);
        coverSyncTimer = null;
      }
      activeTrackSeq += 1;
      lastRedirectedOmv = '';
      latestRequestedOmv = '';
      latestRequestedAtv = '';
      manualVideoId = '';
      clearForcedAtvPlayerMode(document.querySelector('ytmusic-player'));
      syncDomPlayerBarByline(false);
    }
  });

  window.addEventListener('ytm-lite-manual-video', (event: Event) => {
    const detail = (event as CustomEvent<{ videoId?: unknown } | undefined>)?.detail;
    manualVideoId = typeof detail?.videoId === 'string' ? detail.videoId : '';
    if (manualVideoId) {
      clearForcedAtvPlayerMode(document.querySelector('ytmusic-player'));
    }
  });
})();
