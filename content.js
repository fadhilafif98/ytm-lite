(() => {
  if (window.__ytmLiteContentLoaded) return;
  window.__ytmLiteContentLoaded = true;

  const DEFAULTS = {
    enabled: true,
    hideVideoFallback: true
  };

  const HIDE_VIDEO_CLASS = 'ytm-lite-hide-video';
  const ENABLED_STORAGE_KEY = 'ytm_lite_enabled_v1';
  const LOCAL_CACHE_KEY = 'ytmLiteCacheV2';
  const LEGACY_LOCAL_CACHE_KEY = 'ytmLiteCacheV1';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const MAX_PERSISTENT_ENTRIES = 2500;
  const CACHE_FLUSH_DELAY_MS = 500;
  const MAX_SWITCH_ATTEMPTS = 3;
  const SWITCH_COOLDOWN_MS = 600;

  let settings = { ...DEFAULTS };
  let lastTrackKey = '';
  let switchAttempts = 0;
  let lastAttemptTime = 0;
  let scheduledCheck = null;
  let toggleObserver = null;
  let observedToggleEl = null;
  let playerObserver = null;
  let observedPlayerEl = null;
  let observedVideoEl = null;
  let mutationRafId = null;

  let persistentCache = {};
  let cacheHydrated = false;
  let flushTimer = null;
  let pendingWrite = false;
  let contextInvalidated = false;

  function isExtensionContextValid() {
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

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    pendingWrite = false;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    window.removeEventListener('ytm-lite-cache-put', onCachePut);
    window.removeEventListener('ytm-lite-cache-ready', onCacheReady);
  }

  function prunePersistentCache(rawCache) {
    const now = Date.now();
    const valid = [];
    for (const [omvId, entry] of Object.entries(rawCache || {})) {
      if (!entry || typeof entry.a !== 'string') continue;
      const ts = Number(entry.t) || now;
      if (now - ts > CACHE_TTL_MS) continue;
      valid.push([omvId, { a: entry.a, u: entry.u || '', t: ts }]);
    }
    if (valid.length > MAX_PERSISTENT_ENTRIES) {
      valid.sort((a, b) => a[1].t - b[1].t);
      valid.splice(0, valid.length - MAX_PERSISTENT_ENTRIES);
    }
    return Object.fromEntries(valid);
  }

  function broadcastCacheHydrate() {
    const entries = Object.entries(persistentCache).map(([o, v]) => ({
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

  function scheduleCacheFlush() {
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
        if (
          !isExtensionContextValid() ||
          String(err?.message || '').includes('Extension context invalidated')
        ) {
          handleContextInvalidated();
          return;
        }
        console.error('[YTM Lite] Failed to persist cache:', err);
      }
    }, CACHE_FLUSH_DELAY_MS);
  }

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const ALLOWED_THUMB_RE = /^https:\/\/[a-z0-9.-]*(googleusercontent\.com|ytimg\.com)\//i;

  function onCachePut(event) {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    const d = event?.detail;
    if (!d || typeof d.omvId !== 'string' || typeof d.atvId !== 'string') return;
    if (!VIDEO_ID_RE.test(d.omvId) || !VIDEO_ID_RE.test(d.atvId) || d.omvId === d.atvId) return;
    const prev = persistentCache[d.omvId];
    const rawThumb = typeof d.thumbUrl === 'string' && ALLOWED_THUMB_RE.test(d.thumbUrl) ? d.thumbUrl : '';
    const thumbUrl = rawThumb || prev?.u || '';
    if (prev && prev.a === d.atvId && prev.u === thumbUrl) return;
    persistentCache[d.omvId] = { a: d.atvId, u: thumbUrl, t: Date.now() };
    scheduleCacheFlush();
  }

  function onCacheReady() {
    if (!isExtensionContextValid()) {
      handleContextInvalidated();
      return;
    }
    if (cacheHydrated) {
      broadcastCacheHydrate();
    }
  }

  window.addEventListener('ytm-lite-cache-put', onCachePut);
  window.addEventListener('ytm-lite-cache-ready', onCacheReady);

  function broadcastSettings() {
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

  function getCurrentTrackKey() {
    const urlVideoId = new URLSearchParams(window.location.search).get('v');
    if (urlVideoId) return urlVideoId;

    const titleEl = document.querySelector('ytmusic-player-bar .title');
    const bylineEl = document.querySelector('ytmusic-player-bar .byline');
    return `${titleEl?.textContent?.trim() || ''}|${bylineEl?.textContent?.trim() || ''}`;
  }

  function setHideVideoClass(shouldHide) {
    requestAnimationFrame(() => {
      document.documentElement.classList.toggle(HIDE_VIDEO_CLASS, shouldHide);
    });
  }

  function isSongButtonAvailable(toggleEl) {
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

  function attachToggleObserver(toggleEl) {
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

  function attachPlayerObserver(playerEl) {
    if (observedPlayerEl === playerEl) return;

    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }

    observedPlayerEl = playerEl;
    if (!playerEl) return;

    playerObserver = new MutationObserver(() => {
      scheduleEvaluate(50);
    });

    playerObserver.observe(playerEl, {
      attributes: true,
      attributeFilter: ['video-mode', 'is-advertisement-playing', 'player-ui-state']
    });
  }

  function evaluatePlaybackMode() {
    if (!settings.enabled) {
      setHideVideoClass(false);
      return;
    }

    const toggleEl = document.querySelector('ytmusic-av-toggle');
    attachToggleObserver(toggleEl);

    const playerEl = document.querySelector('ytmusic-player');
    attachPlayerObserver(playerEl);

    // Never hide video while an advertisement is playing
    if (playerEl?.hasAttribute('is-advertisement-playing')) {
      setHideVideoClass(false);
      return;
    }

    const isVideoMode = playerEl?.hasAttribute('video-mode') ?? false;
    const playbackMode = toggleEl?.getAttribute('playback-mode') || '';

    // Already playing official audio / album version.
    if (playbackMode === 'ATV_PREFERRED' && !isVideoMode) {
      setHideVideoClass(false);
      return;
    }

    const trackKey = getCurrentTrackKey();
    if (trackKey !== lastTrackKey) {
      lastTrackKey = trackKey;
      switchAttempts = 0;
    }

    const canSwitchToSong = isSongButtonAvailable(toggleEl);
    const wantsSwitch =
      playbackMode === 'OMV_PREFERRED' ||
      (isVideoMode && playbackMode !== 'ATV_PREFERRED');

    if (canSwitchToSong && wantsSwitch) {
      const now = Date.now();
      if (
        switchAttempts < MAX_SWITCH_ATTEMPTS &&
        now - lastAttemptTime >= SWITCH_COOLDOWN_MS
      ) {
        const songBtn = toggleEl.querySelector('.song-button');
        if (songBtn) {
          switchAttempts += 1;
          lastAttemptTime = now;
          songBtn.click();
          setHideVideoClass(false);
          return;
        }
      }
    }

    // No album/song version available: apply audio-only visual fallback if enabled.
    const shouldFallbackHide =
      settings.hideVideoFallback &&
      (isVideoMode || playbackMode === 'OMV_PREFERRED');
    setHideVideoClass(shouldFallbackHide);
  }

  function scheduleEvaluate(delayMs = 150) {
    if (scheduledCheck !== null) {
      clearTimeout(scheduledCheck);
    }
    scheduledCheck = setTimeout(() => {
      scheduledCheck = null;
      evaluatePlaybackMode();
    }, delayMs);
  }

  function attachVideoListener() {
    if (observedVideoEl && observedVideoEl.isConnected) return;
    const videoEl = document.querySelector('ytmusic-player video');
    if (!videoEl) return;
    observedVideoEl = videoEl;
    if (videoEl.dataset.ytmLiteBound === '1') return;

    videoEl.dataset.ytmLiteBound = '1';
    videoEl.addEventListener('loadedmetadata', () => scheduleEvaluate(100));
    videoEl.addEventListener('play', () => scheduleEvaluate(100));
  }

  function startObservers() {
    if (!document.body) return;
    const rootObserver = new MutationObserver(() => {
      if (
        observedVideoEl?.isConnected &&
        observedToggleEl?.isConnected &&
        observedPlayerEl?.isConnected
      ) {
        return;
      }
      if (mutationRafId !== null) return;
      mutationRafId = requestAnimationFrame(() => {
        mutationRafId = null;
        attachVideoListener();
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
      });
    });

    rootObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('yt-navigate-finish', () => {
      switchAttempts = 0;
      scheduleEvaluate(250);
    });

    attachVideoListener();
    scheduleEvaluate(300);
  }

  if (isExtensionContextValid() && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!isExtensionContextValid()) {
        handleContextInvalidated();
        return;
      }
      if (areaName === 'local' && changes[LOCAL_CACHE_KEY]) {
        const nextVal = changes[LOCAL_CACHE_KEY].newValue;
        if (!nextVal || Object.keys(nextVal).length === 0) {
          persistentCache = {};
          pendingWrite = false;
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          window.dispatchEvent(new CustomEvent('ytm-lite-cache-clear'));
        } else {
          // Merge updates from other YTM tabs so no tab overwrites another tab's cache
          const merged = prunePersistentCache({ ...nextVal, ...persistentCache });
          const newlyAdded = [];
          for (const [o, v] of Object.entries(nextVal)) {
            if (!persistentCache[o] && v && typeof v.a === 'string') {
              newlyAdded.push({ o, a: v.a, u: v.u || '' });
            }
          }
          persistentCache = merged;
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
        settings.enabled = Boolean(changes.enabled.newValue);
        switchAttempts = 0;
      }
      if (changes.hideVideoFallback) {
        settings.hideVideoFallback = Boolean(changes.hideVideoFallback.newValue);
      }
      broadcastSettings();
      scheduleEvaluate(50);
    });
  }

  async function init() {
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
      cacheHydrated = true;
    } catch (err) {
      if (
        !isExtensionContextValid() ||
        String(err?.message || '').includes('Extension context invalidated')
      ) {
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
