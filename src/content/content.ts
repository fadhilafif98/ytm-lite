import {
  DEFAULTS,
  ENABLED_STORAGE_KEY,
  LOCAL_CACHE_KEY,
  LEGACY_LOCAL_CACHE_KEY,
  CACHE_TTL_MS,
  MAX_PERSISTENT_ENTRIES,
  isSafeVideoId,
  sanitizeThumbUrl
} from '../shared/constants';

(() => {
  if (window.__ytmLiteContentLoaded) return;
  window.__ytmLiteContentLoaded = true;

  const HIDE_VIDEO_CLASS = 'ytm-lite-hide-video';
  const SWAP_PENDING_CLASS = 'ytm-lite-swap-pending';
  const CACHE_FLUSH_DELAY_MS = 500;
  const MAX_SWITCH_ATTEMPTS = 3;
  const SWITCH_COOLDOWN_MS = 600;
  const INJECT_PENDING_MAX_MS = 3500;
  const ROOT_MUTATION_THROTTLE_MS = 100;

  let settings: YtmLiteSettings = { ...DEFAULTS };
  let lastTrackKey = '';
  let manualVideoTrackKey = '';
  let lastInjectVideoId = '';
  let activeTrackIsAtv = false;
  let prevTrackBarSrc = '';
  let injectSwapPending = false;
  let injectPendingSince = 0;
  let switchAttempts = 0;
  let lastAttemptTime = 0;
  let scheduledCheck: ReturnType<typeof setTimeout> | null = null;
  let fallbackCoverTimer: ReturnType<typeof setTimeout> | null = null;
  let toggleObserver: MutationObserver | null = null;
  let observedToggleEl: Element | null = null;
  let playerObserver: MutationObserver | null = null;
  let observedPlayerEl: Element | null = null;
  let observedVideoEl: HTMLVideoElement | null = null;
  let barImgObserver: MutationObserver | null = null;
  let observedBarImgEl: Element | null = null;
  let rootObserver: MutationObserver | null = null;
  let rootMutationTimer: ReturnType<typeof setTimeout> | null = null;
  let storageListenerBound = false;

  let persistentCache: PersistentCacheMap = Object.create(null) as PersistentCacheMap;
  const atvThumbCache = new Map<string, string>();
  let cacheHydrated = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite = false;
  let contextInvalidated = false;

  function isExtensionContextValid(): boolean {
    if (contextInvalidated) return false;
    try {
      return Boolean(
        typeof chrome !== 'undefined' &&
        chrome?.runtime?.id &&
        chrome?.storage?.local
      );
    } catch {
      return false;
    }
  }

  function broadcastManualVideo(videoId: string): void {
    try {
      window.dispatchEvent(
        new CustomEvent('ytm-lite-manual-video', {
          detail: { videoId }
        })
      );
    } catch {
      // Ignore event errors
    }
  }

  function clearForcedAtvAttribute(playerEl: Element | null): void {
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

  function onDocumentClick(event: MouseEvent): void {
    if (!event.isTrusted || !settings.enabled || !isExtensionContextValid()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('ytmusic-av-toggle .video-button')) {
      manualVideoTrackKey = getCurrentTrackKey();
      const rawId = manualVideoTrackKey.startsWith('vid:')
        ? manualVideoTrackKey.slice(4)
        : manualVideoTrackKey;
      broadcastManualVideo(isSafeVideoId(rawId) ? rawId : '');
      clearForcedAtvAttribute(document.querySelector('ytmusic-player'));
      setSwapPendingClass(false);
      setHideVideoClass(false);
    } else if (target.closest('ytmusic-av-toggle .song-button')) {
      manualVideoTrackKey = '';
      broadcastManualVideo('');
    }
  }

  function handleContextInvalidated(): void {
    if (contextInvalidated) return;
    contextInvalidated = true;
    pendingWrite = false;
    clearForcedAtvAttribute(document.querySelector('ytmusic-player'));
    document.documentElement.classList.toggle(SWAP_PENDING_CLASS, false);
    document.documentElement.classList.toggle(HIDE_VIDEO_CLASS, false);
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (scheduledCheck !== null) {
      clearTimeout(scheduledCheck);
      scheduledCheck = null;
    }
    if (fallbackCoverTimer !== null) {
      clearTimeout(fallbackCoverTimer);
      fallbackCoverTimer = null;
    }
    if (rootMutationTimer !== null) {
      clearTimeout(rootMutationTimer);
      rootMutationTimer = null;
    }
    if (toggleObserver) {
      toggleObserver.disconnect();
      toggleObserver = null;
    }
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }
    if (barImgObserver) {
      barImgObserver.disconnect();
      barImgObserver = null;
    }
    observedBarImgEl = null;
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
    if (observedVideoEl) {
      observedVideoEl.removeEventListener('loadedmetadata', onVideoMediaEvent);
      observedVideoEl.removeEventListener('play', onVideoMediaEvent);
      delete observedVideoEl.dataset.ytmLiteBound;
      observedVideoEl = null;
    }
    window.removeEventListener('ytm-lite-cache-put', onCachePut);
    window.removeEventListener('ytm-lite-cache-ready', onCacheReady);
    window.removeEventListener('ytm-lite-swap-state', onSwapState);
    window.removeEventListener('yt-navigate-finish', onNavigateFinish);
    document.removeEventListener('click', onDocumentClick, true);
    if (storageListenerBound) {
      storageListenerBound = false;
      try {
        chrome?.storage?.onChanged?.removeListener?.(onStorageChanged);
      } catch {
        // Ignore invalidated chrome.storage access
      }
    }
  }

  function prunePersistentCache(rawCache: unknown): PersistentCacheMap {
    const now = Date.now();
    const valid: Array<[string, PersistentCacheEntry]> = [];
    if (rawCache && typeof rawCache === 'object') {
      for (const [omvId, rawEntry] of Object.entries(rawCache as Record<string, unknown>)) {
        if (!isSafeVideoId(omvId)) continue;
        const entry = rawEntry as Partial<PersistentCacheEntry> | null;
        if (!entry || !isSafeVideoId(entry.a) || omvId === entry.a) continue;
        const rawTs = Number(entry.t);
        const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : now;
        if (now - ts > CACHE_TTL_MS) continue;
        valid.push([omvId, { a: entry.a, u: sanitizeThumbUrl(entry.u), t: ts }]);
      }
    }
    if (valid.length > MAX_PERSISTENT_ENTRIES) {
      valid.sort((a, b) => a[1].t - b[1].t);
      valid.splice(0, valid.length - MAX_PERSISTENT_ENTRIES);
    }
    const out = Object.create(null) as PersistentCacheMap;
    for (const [k, v] of valid) {
      out[k] = v;
    }
    return out;
  }

  function rebuildAtvThumbCache(): void {
    atvThumbCache.clear();
    for (const entry of Object.values(persistentCache)) {
      if (entry?.a && entry.u) {
        atvThumbCache.set(entry.a, entry.u);
      }
    }
  }

  function broadcastCacheHydrate(): void {
    const entries: HydrateCacheEntry[] = Object.entries(persistentCache).map(([o, v]) => ({
      o,
      a: v.a,
      u: v.u || ''
    }));
    if (entries.length === 0) return;
    window.dispatchEvent(
      new CustomEvent('ytm-lite-cache-hydrate', {
        detail: { entries }
      })
    );
  }

  function scheduleCacheFlush(): void {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    pendingWrite = true;
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!pendingWrite) return;
      pendingWrite = false;
      if (!isExtensionContextValid()) {
        handleContextInvalidated();
        return;
      }
      try {
        persistentCache = prunePersistentCache(persistentCache);
        await chrome.storage.local.set({ [LOCAL_CACHE_KEY]: persistentCache });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err || '');
        if (!isExtensionContextValid() || msg.includes('Extension context invalidated')) {
          handleContextInvalidated();
          return;
        }
        console.error('[YTM Lite] Failed to persist cache:', err);
      }
    }, CACHE_FLUSH_DELAY_MS);
  }

  function onCachePut(event: Event): void {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    const d = (event as CustomEvent<{ omvId?: unknown; atvId?: unknown; thumbUrl?: unknown } | undefined>)?.detail;
    if (!d || !isSafeVideoId(d.omvId) || !isSafeVideoId(d.atvId) || d.omvId === d.atvId) return;
    const prev = Object.hasOwn(persistentCache, d.omvId) ? persistentCache[d.omvId] : null;
    const rawThumb = sanitizeThumbUrl(d.thumbUrl);
    const thumbUrl = rawThumb || prev?.u || '';
    if (prev && prev.a === d.atvId && prev.u === thumbUrl) return;
    persistentCache[d.omvId] = { a: d.atvId, u: thumbUrl, t: Date.now() };
    if (thumbUrl) {
      atvThumbCache.set(d.atvId, thumbUrl);
    }
    scheduleCacheFlush();
  }

  function onCacheReady(): void {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    if (cacheHydrated) {
      broadcastCacheHydrate();
    }
  }

  function onSwapState(event: Event): void {
    const d = (
      event as CustomEvent<{ pending?: unknown; videoId?: unknown; isAtv?: unknown } | undefined>
    )?.detail;
    if (!d) return;
    injectSwapPending = Boolean(d.pending);
    injectPendingSince = injectSwapPending ? Date.now() : 0;
    const vid = isSafeVideoId(d.videoId) ? d.videoId : '';
    const isSameTrackPair = Boolean(
      vid &&
        lastInjectVideoId &&
        (vid === lastInjectVideoId ||
          (Object.hasOwn(persistentCache, lastInjectVideoId) &&
            persistentCache[lastInjectVideoId]?.a === vid) ||
          (Object.hasOwn(persistentCache, vid) &&
            persistentCache[vid]?.a === lastInjectVideoId))
    );
    if (vid && !isSameTrackPair) {
      const barImg = document.querySelector<HTMLImageElement>('ytmusic-player-bar img.image');
      prevTrackBarSrc = barImg?.getAttribute('src') || '';
      switchAttempts = 0;
      lastAttemptTime = 0;
    }
    if (vid) {
      lastInjectVideoId = vid;
    }
    activeTrackIsAtv = !injectSwapPending && Boolean(d.isAtv);

    const playerEl = document.querySelector('ytmusic-player');
    const isAd = Boolean(playerEl?.hasAttribute('is-advertisement-playing'));
    const trackKey = getCurrentTrackKey();
    const isManual = Boolean(manualVideoTrackKey && trackKey === manualVideoTrackKey);
    if (injectSwapPending && settings.enabled && settings.hideVideoFallback && !isAd && !isManual) {
      setSwapPendingClass(true);
      setHideVideoClass(true);
    } else if (!injectSwapPending) {
      setSwapPendingClass(false);
      const isNativeAtvLayout =
        !playerEl?.hasAttribute('video-mode') &&
        playerEl?.getAttribute('playback-mode') !== 'OMV_PREFERRED';
      if (activeTrackIsAtv && isNativeAtvLayout) {
        setHideVideoClass(false);
      } else {
        scheduleEvaluate(40);
      }
    }
  }

  window.addEventListener('ytm-lite-cache-put', onCachePut);
  window.addEventListener('ytm-lite-cache-ready', onCacheReady);
  window.addEventListener('ytm-lite-swap-state', onSwapState);

  function broadcastSettings(): void {
    try {
      sessionStorage.setItem(ENABLED_STORAGE_KEY, settings.enabled ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    window.dispatchEvent(
      new CustomEvent('ytm-lite-settings', {
        detail: {
          enabled: settings.enabled,
          hideVideoFallback: settings.hideVideoFallback
        }
      })
    );
  }

  function getCurrentTrackKey(): string {
    if (lastInjectVideoId) return lastInjectVideoId;
    const urlVideoId = new URLSearchParams(window.location.search).get('v');
    if (urlVideoId) return urlVideoId;

    const titleEl = document.querySelector('ytmusic-player-bar .title');
    const bylineEl = document.querySelector('ytmusic-player-bar .byline');
    return `${titleEl?.textContent?.trim() || ''}|${bylineEl?.textContent?.trim() || ''}`;
  }

  function upgradeSquareThumbUrl(url: string): string {
    if (
      /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\//i.test(url) &&
      /w\d+-h\d+/.test(url)
    ) {
      return url.replace(/w\d+-h\d+/, 'w544-h544');
    }
    return url;
  }

  function isGoogleThumbUrl(url: string): boolean {
    return /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\//i.test(url);
  }

  function getGoogleThumbBase(url: string): string {
    if (!isGoogleThumbUrl(url)) return '';
    return url.replace(/=[^/?#]+$/, '');
  }

  function isSameGoogleThumbBase(urlA: string, urlB: string): boolean {
    const baseA = getGoogleThumbBase(urlA);
    return Boolean(baseA && baseA === getGoogleThumbBase(urlB));
  }

  function findBestSquareThumbUrl(activeVid: string): string {
    if (isSafeVideoId(activeVid)) {
      const cached = Object.hasOwn(persistentCache, activeVid)
        ? persistentCache[activeVid]?.u || ''
        : atvThumbCache.get(activeVid) || '';
      if (cached && isGoogleThumbUrl(cached)) {
        return upgradeSquareThumbUrl(cached);
      }
    }

    const barImg = document.querySelector<HTMLImageElement>('ytmusic-player-bar img.image');
    const barSrc = barImg?.getAttribute('src') || '';
    const isStaleBarSrc = Boolean(prevTrackBarSrc && barSrc && barSrc === prevTrackBarSrc);
    if (barSrc && !isStaleBarSrc && isGoogleThumbUrl(barSrc)) {
      return upgradeSquareThumbUrl(barSrc);
    }

    const queueImg = document.querySelector<HTMLImageElement>(
      'ytmusic-player-queue-item[selected] img'
    );
    const queueSrc = queueImg?.getAttribute('src') || '';
    const isStaleQueueSrc = Boolean(
      prevTrackBarSrc && queueSrc && (queueSrc === prevTrackBarSrc || isSameGoogleThumbBase(queueSrc, prevTrackBarSrc))
    );
    if (queueSrc && !isStaleQueueSrc && isGoogleThumbUrl(queueSrc)) {
      return upgradeSquareThumbUrl(queueSrc);
    }

    return '';
  }

  function syncFallbackCoverArt(): void {
    const isHiding =
      document.documentElement.classList.contains(HIDE_VIDEO_CLASS) ||
      document.documentElement.classList.contains(SWAP_PENDING_CLASS);
    if (!isHiding) return;
    const songImg = document.querySelector<HTMLImageElement>('ytmusic-player #song-image img');
    if (!songImg) return;
    songImg.removeAttribute('hidden');
    const shadowHost = songImg.closest('yt-img-shadow');
    if (shadowHost) {
      shadowHost.removeAttribute('hidden');
      shadowHost.removeAttribute('empty');
    }

    const curSrc = songImg.getAttribute('src') || '';
    const activeVid =
      lastInjectVideoId || new URLSearchParams(window.location.search).get('v') || '';

    const squareArtUrl = findBestSquareThumbUrl(activeVid);
    if (squareArtUrl) {
      const alreadyMatchingHiRes =
        curSrc === squareArtUrl ||
        (isSameGoogleThumbBase(curSrc, squareArtUrl) && /w544-h544/.test(curSrc));
      if (!alreadyMatchingHiRes) {
        songImg.setAttribute('src', squareArtUrl);
      }
      const barImg = document.querySelector<HTMLImageElement>('ytmusic-player-bar img.image');
      const barSrc = barImg?.getAttribute('src') || '';
      if (barImg && (!barSrc || barSrc.includes('ytimg.com'))) {
        barImg.setAttribute('src', squareArtUrl);
      }
      return;
    }

    // While ATV swap is pending, never paint a 16:9 MV thumbnail frame (avoids 0:00 visual blip)
    if (injectSwapPending) return;

    const barImg = document.querySelector<HTMLImageElement>('ytmusic-player-bar img.image');
    const barSrc = barImg?.getAttribute('src') || '';
    const isStaleBarSrc = Boolean(prevTrackBarSrc && barSrc && barSrc === prevTrackBarSrc);
    if (barSrc && !isStaleBarSrc && /^https:\/\//i.test(barSrc)) {
      // Never downgrade an existing square googleusercontent cover to a 16:9 ytimg frame
      if (isGoogleThumbUrl(curSrc) && !isGoogleThumbUrl(barSrc)) {
        return;
      }
      const targetSrc = upgradeSquareThumbUrl(barSrc);
      if (curSrc !== targetSrc) {
        songImg.setAttribute('src', targetSrc);
      }
      return;
    }

    if (isGoogleThumbUrl(curSrc) && (!prevTrackBarSrc || !isSameGoogleThumbBase(curSrc, prevTrackBarSrc))) {
      return;
    }

    const needsSrc =
      !curSrc ||
      curSrc.startsWith('data:') ||
      !songImg.complete ||
      songImg.naturalWidth === 0;
    if (!needsSrc) return;

    if (isSafeVideoId(activeVid)) {
      const fallbackUrl = `https://i.ytimg.com/vi/${activeVid}/hqdefault.jpg`;
      if (curSrc !== fallbackUrl) {
        songImg.setAttribute('src', fallbackUrl);
      }
    }
  }

  function setSwapPendingClass(pending: boolean): void {
    if (contextInvalidated) return;
    document.documentElement.classList.toggle(SWAP_PENDING_CLASS, pending);
  }

  function setHideVideoClass(shouldHide: boolean): void {
    const apply = (): void => {
      if (contextInvalidated) return;
      document.documentElement.classList.toggle(HIDE_VIDEO_CLASS, shouldHide);
      if (fallbackCoverTimer !== null) {
        clearTimeout(fallbackCoverTimer);
        fallbackCoverTimer = null;
      }
      if (shouldHide) {
        syncFallbackCoverArt();
        fallbackCoverTimer = setTimeout(() => {
          fallbackCoverTimer = null;
          if (!contextInvalidated) syncFallbackCoverArt();
        }, 200);
      }
    };

    // Apply hiding synchronously so 16:9 video layout never flashes even for a single frame
    if (shouldHide || document.hidden || typeof requestAnimationFrame !== 'function') {
      apply();
    } else {
      requestAnimationFrame(apply);
    }
  }

  function isSongButtonAvailable(toggleEl: Element | null): boolean {
    if (!toggleEl || toggleEl.hasAttribute('toggle-disabled')) {
      return false;
    }

    const songBtn = toggleEl.querySelector('.song-button');
    if (!songBtn) return false;

    if (
      songBtn.hasAttribute('disabled') ||
      songBtn.getAttribute('aria-disabled') === 'true'
    ) {
      return false;
    }

    return true;
  }

  function attachToggleObserver(toggleEl: Element | null): void {
    if (observedToggleEl === toggleEl) return;

    if (toggleObserver) {
      toggleObserver.disconnect();
      toggleObserver = null;
    }

    observedToggleEl = toggleEl;
    if (!toggleEl) return;

    toggleObserver = new MutationObserver(() => {
      scheduleEvaluate();
    });

    toggleObserver.observe(toggleEl, {
      attributes: true,
      attributeFilter: ['playback-mode', 'toggle-disabled', 'hidden']
    });
  }

  function attachBarImgObserver(): void {
    const barImg = document.querySelector('ytmusic-player-bar img.image');
    if (observedBarImgEl === barImg) return;
    if (barImgObserver) {
      barImgObserver.disconnect();
      barImgObserver = null;
    }
    observedBarImgEl = barImg;
    if (!barImg) return;
    barImgObserver = new MutationObserver(() => {
      if (contextInvalidated) return;
      const curBarSrc = barImg.getAttribute('src') || '';
      if (prevTrackBarSrc && curBarSrc && curBarSrc !== prevTrackBarSrc) {
        prevTrackBarSrc = '';
      }
      if (
        document.documentElement.classList.contains(HIDE_VIDEO_CLASS) ||
        document.documentElement.classList.contains(SWAP_PENDING_CLASS)
      ) {
        syncFallbackCoverArt();
      }
    });
    barImgObserver.observe(barImg, {
      attributes: true,
      attributeFilter: ['src']
    });
  }

  function attachPlayerObserver(playerEl: Element | null): void {
    if (observedPlayerEl === playerEl) return;

    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }

    observedPlayerEl = playerEl;
    if (!playerEl) return;

    playerObserver = new MutationObserver(() => {
      if (contextInvalidated) return;
      // Apply square fallback immediately when player enters video/OMV mode to prevent 16:9 flash
      const enteredVideoMode =
        playerEl.hasAttribute('video-mode') ||
        playerEl.getAttribute('playback-mode') === 'OMV_PREFERRED';
      if (
        settings.enabled &&
        settings.hideVideoFallback &&
        enteredVideoMode &&
        !playerEl.hasAttribute('is-advertisement-playing')
      ) {
        const trackKey = getCurrentTrackKey();
        if (!manualVideoTrackKey || trackKey !== manualVideoTrackKey) {
          setHideVideoClass(true);
        }
      }
      scheduleEvaluate(30);
    });

    playerObserver.observe(playerEl, {
      attributes: true,
      attributeFilter: ['video-mode', 'playback-mode', 'is-advertisement-playing', 'player-ui-state']
    });
  }

  function evaluatePlaybackMode(): void {
    if (contextInvalidated) return;
    if (!settings.enabled) {
      clearForcedAtvAttribute(document.querySelector('ytmusic-player'));
      setSwapPendingClass(false);
      setHideVideoClass(false);
      return;
    }

    const toggleEl = document.querySelector('ytmusic-av-toggle');
    attachToggleObserver(toggleEl);

    const playerEl = document.querySelector('ytmusic-player');
    attachPlayerObserver(playerEl);
    attachBarImgObserver();

    if (playerEl?.hasAttribute('is-advertisement-playing')) {
      clearForcedAtvAttribute(playerEl);
      setSwapPendingClass(false);
      setHideVideoClass(false);
      return;
    }

    const trackKey = getCurrentTrackKey();
    if (trackKey !== lastTrackKey) {
      if (lastTrackKey && !prevTrackBarSrc) {
        const barImg = document.querySelector<HTMLImageElement>('ytmusic-player-bar img.image');
        prevTrackBarSrc = barImg?.getAttribute('src') || '';
      }
      lastTrackKey = trackKey;
      switchAttempts = 0;
      lastAttemptTime = 0;
      if (manualVideoTrackKey && trackKey !== manualVideoTrackKey) {
        manualVideoTrackKey = '';
        broadcastManualVideo('');
      }
    }

    if (manualVideoTrackKey && trackKey === manualVideoTrackKey) {
      clearForcedAtvAttribute(playerEl);
      setSwapPendingClass(false);
      setHideVideoClass(false);
      return;
    }

    const isVideoMode = playerEl?.hasAttribute('video-mode') ?? false;
    const playerPlaybackMode = playerEl?.getAttribute('playback-mode') || '';
    const togglePlaybackMode = toggleEl?.getAttribute('playback-mode') || '';
    const playbackMode = togglePlaybackMode || playerPlaybackMode;
    const isPlayerInVideoLayout = isVideoMode || playerPlaybackMode === 'OMV_PREFERRED';

    if ((playbackMode === 'ATV_PREFERRED' || activeTrackIsAtv) && !isPlayerInVideoLayout) {
      setSwapPendingClass(false);
      setHideVideoClass(false);
      return;
    }

    if (injectSwapPending) {
      if (Date.now() - injectPendingSince < INJECT_PENDING_MAX_MS) {
        if (settings.hideVideoFallback) {
          setSwapPendingClass(true);
          if (isPlayerInVideoLayout || playbackMode === 'OMV_PREFERRED') {
            setHideVideoClass(true);
          }
        }
        return;
      }
      injectSwapPending = false;
      injectPendingSince = 0;
    }
    setSwapPendingClass(false);

    if (activeTrackIsAtv) {
      // Track is already playing official ATV; only apply square fallback while video layout lingers
      setHideVideoClass(settings.hideVideoFallback && isPlayerInVideoLayout);
      return;
    }

    const canSwitchToSong = isSongButtonAvailable(toggleEl);
    const wantsSwitch =
      playbackMode === 'OMV_PREFERRED' ||
      (isPlayerInVideoLayout && playbackMode !== 'ATV_PREFERRED');

    if (canSwitchToSong && wantsSwitch && toggleEl) {
      const now = Date.now();
      const elapsed = now - lastAttemptTime;
      if (switchAttempts < MAX_SWITCH_ATTEMPTS) {
        if (elapsed >= SWITCH_COOLDOWN_MS) {
          const songBtn = toggleEl.querySelector<HTMLElement>('.song-button');
          if (songBtn) {
            switchAttempts += 1;
            lastAttemptTime = now;
            // Keep square cover visible until YTM actually leaves video-mode (avoids 16:9 flash)
            if (settings.hideVideoFallback && (isPlayerInVideoLayout || playbackMode === 'OMV_PREFERRED')) {
              setHideVideoClass(true);
            }
            songBtn.click();
            scheduleEvaluate(SWITCH_COOLDOWN_MS + 50);
            return;
          }
        } else {
          scheduleEvaluate(SWITCH_COOLDOWN_MS - elapsed + 30);
        }
      }
    }

    const shouldFallbackHide =
      settings.hideVideoFallback &&
      (isPlayerInVideoLayout || playbackMode === 'OMV_PREFERRED');
    setHideVideoClass(shouldFallbackHide);
  }

  function scheduleEvaluate(delayMs = 150): void {
    if (contextInvalidated) return;
    if (scheduledCheck !== null) {
      clearTimeout(scheduledCheck);
    }
    scheduledCheck = setTimeout(() => {
      scheduledCheck = null;
      evaluatePlaybackMode();
    }, delayMs);
  }

  function onVideoMediaEvent(): void {
    scheduleEvaluate(100);
  }

  function onNavigateFinish(): void {
    if (contextInvalidated) return;
    const urlVid = new URLSearchParams(window.location.search).get('v') || '';
    if (
      urlVid &&
      lastInjectVideoId &&
      urlVid !== lastInjectVideoId &&
      (!Object.hasOwn(persistentCache, urlVid) ||
        persistentCache[urlVid]?.a !== lastInjectVideoId)
    ) {
      lastInjectVideoId = '';
      activeTrackIsAtv = false;
    }
    switchAttempts = 0;
    lastAttemptTime = 0;
    scheduleEvaluate(120);
  }

  function attachVideoListener(): void {
    if (observedVideoEl && observedVideoEl.isConnected) return;
    const videoEl = document.querySelector<HTMLVideoElement>('ytmusic-player video');
    if (!videoEl) return;
    observedVideoEl = videoEl;
    if (videoEl.dataset.ytmLiteBound === '1') return;

    videoEl.dataset.ytmLiteBound = '1';
    videoEl.addEventListener('loadedmetadata', onVideoMediaEvent);
    videoEl.addEventListener('play', onVideoMediaEvent);
  }

  function startObservers(): void {
    if (contextInvalidated) return;
    const observeRoot = document.querySelector('ytmusic-app') || document.body;
    if (!observeRoot) return;
    if (rootObserver) {
      rootObserver.disconnect();
    }
    rootObserver = new MutationObserver(() => {
      if (contextInvalidated) return;
      if (
        observedVideoEl?.isConnected &&
        observedToggleEl?.isConnected &&
        observedPlayerEl?.isConnected &&
        observedBarImgEl?.isConnected
      ) {
        return;
      }
      if (rootMutationTimer !== null) return;
      rootMutationTimer = setTimeout(() => {
        rootMutationTimer = null;
        if (contextInvalidated) return;
        attachVideoListener();
        attachBarImgObserver();
        const toggleEl = document.querySelector('ytmusic-av-toggle');
        if (toggleEl && toggleEl !== observedToggleEl) {
          attachToggleObserver(toggleEl);
          scheduleEvaluate(100);
        }
        const playerEl = document.querySelector('ytmusic-player');
        if (playerEl && playerEl !== observedPlayerEl) {
          attachPlayerObserver(playerEl);
          scheduleEvaluate(100);
        }
      }, ROOT_MUTATION_THROTTLE_MS);
    });

    rootObserver.observe(observeRoot, {
      childList: true,
      subtree: true
    });

    window.removeEventListener('yt-navigate-finish', onNavigateFinish);
    window.addEventListener('yt-navigate-finish', onNavigateFinish);

    document.removeEventListener('click', onDocumentClick, true);
    document.addEventListener('click', onDocumentClick, true);

    attachVideoListener();
    scheduleEvaluate(300);
  }

  function onStorageChanged(
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    if (areaName === 'local' && changes[LOCAL_CACHE_KEY]) {
      const nextVal = changes[LOCAL_CACHE_KEY].newValue as Record<string, unknown> | undefined;
      if (!nextVal || Object.keys(nextVal).length === 0) {
        persistentCache = Object.create(null) as PersistentCacheMap;
        atvThumbCache.clear();
        pendingWrite = false;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        window.dispatchEvent(new CustomEvent('ytm-lite-cache-clear'));
      } else {
        const combined = Object.assign(Object.create(null), nextVal, persistentCache);
        const merged = prunePersistentCache(combined);
        const newlyAdded: HydrateCacheEntry[] = [];
        for (const [o, rawV] of Object.entries(nextVal)) {
          const v = rawV as Partial<PersistentCacheEntry> | null;
          if (
            isSafeVideoId(o) &&
            !Object.hasOwn(persistentCache, o) &&
            v &&
            isSafeVideoId(v.a) &&
            o !== v.a
          ) {
            newlyAdded.push({ o, a: v.a, u: sanitizeThumbUrl(v.u) });
          }
        }
        persistentCache = merged;
        rebuildAtvThumbCache();
        if (newlyAdded.length > 0) {
          window.dispatchEvent(
            new CustomEvent('ytm-lite-cache-hydrate', {
              detail: { entries: newlyAdded }
            })
          );
        }
      }
      return;
    }

    if (areaName !== 'sync') return;
    if (changes.enabled) {
      settings.enabled = Boolean(changes.enabled.newValue ?? DEFAULTS.enabled);
      switchAttempts = 0;
      if (!settings.enabled) {
        manualVideoTrackKey = '';
      }
    }
    if (changes.hideVideoFallback) {
      settings.hideVideoFallback = Boolean(
        changes.hideVideoFallback.newValue ?? DEFAULTS.hideVideoFallback
      );
    }
    broadcastSettings();
    scheduleEvaluate(50);
  }

  if (isExtensionContextValid() && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(onStorageChanged);
    storageListenerBound = true;
  }

  async function init(): Promise<void> {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    try {
      try {
        await chrome.storage.local.remove(LEGACY_LOCAL_CACHE_KEY);
      } catch {
        // Ignore cleanup errors for legacy cache key
      }
      const [storedSync, storedLocal] = await Promise.all([
        chrome.storage.sync.get(DEFAULTS),
        chrome.storage.local.get(LOCAL_CACHE_KEY)
      ]);
      settings = {
        enabled: Boolean(storedSync.enabled),
        hideVideoFallback: Boolean(storedSync.hideVideoFallback)
      };
      persistentCache = prunePersistentCache(storedLocal?.[LOCAL_CACHE_KEY]);
      rebuildAtvThumbCache();
      cacheHydrated = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || '');
      if (!isExtensionContextValid() || msg.includes('Extension context invalidated')) {
        handleContextInvalidated();
        return;
      }
      console.error('[YTM Lite] Failed to read settings/cache:', err);
    }

    broadcastSettings();
    broadcastCacheHydrate();

    if (document.body) {
      startObservers();
    } else {
      window.addEventListener('DOMContentLoaded', startObservers, { once: true });
    }
  }

  init();
})();
