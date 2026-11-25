(() => {
  if (window.__ytmLiteInjected) return;

  const boot = window.__ytmLiteBoot;
  if (!boot?.matcher) return;
  const { isResolvableNonAtvType } = boot.matcher;

  const STORAGE_KEY = 'ytm_lite_omv_to_atv_v5';
  const LEGACY_STORAGE_KEY = 'ytm_lite_omv_to_atv_v4';
  const THUMB_STORAGE_KEY = 'ytm_lite_thumbs_v2';
  const ENABLED_STORAGE_KEY = 'ytm_lite_enabled_v1';
  const MAX_SESSION_ENTRIES = 800;
  const MAX_MEMORY_ENTRIES = 2500;

  let enabled = true;
  try {
    if (sessionStorage.getItem(ENABLED_STORAGE_KEY) === '0') {
      enabled = false;
    }
  } catch {
    // Ignore storage errors
  }

  const omvToAtvMap = new Map();
  const atvToOmvMap = new Map();
  const videoThumbMap = new Map(); // videoId -> square thumbnails array
  const knownOmvMeta = new Map(); // omvId -> { videoId, title, artist, artistBrowseId, musicVideoType, durationSec }
  const knownAtvSet = new Set();
  const noAtvSet = new Set();
  const recentPlayerSwaps = new Map(); // omvId -> { atvId, time }
  const recentPlayerRequests = new Map(); // videoId -> timestamp
  const pendingPlayerSwaps = new Set(); // omvIds actively being resolved by /player

  function trimMap(map, maxSize = MAX_MEMORY_ENTRIES) {
    if (map.size <= maxSize) return;
    const excess = map.size - maxSize;
    let i = 0;
    for (const key of map.keys()) {
      map.delete(key);
      if (++i >= excess) break;
    }
  }

  function trimSet(set, maxSize = MAX_MEMORY_ENTRIES) {
    if (set.size <= maxSize) return;
    const excess = set.size - maxSize;
    let i = 0;
    for (const val of set.values()) {
      set.delete(val);
      if (++i >= excess) break;
    }
  }

  function buildSquareThumbnails(thumbs) {
    if (!Array.isArray(thumbs) || thumbs.length === 0) return null;
    const result = thumbs.map((t) => ({ ...t }));
    const last = result[result.length - 1];
    if (
      last?.url &&
      last.url.includes('googleusercontent.com') &&
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

  function buildThumbsFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    return buildSquareThumbnails([{ url, width: 544, height: 544 }]);
  }

  function loadSessionCache() {
    try {
      sessionStorage.removeItem(LEGACY_STORAGE_KEY);
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const [omvId, atvId] of entries) {
            if (typeof omvId === 'string' && typeof atvId === 'string') {
              omvToAtvMap.set(omvId, atvId);
              atvToOmvMap.set(atvId, omvId);
            }
          }
        }
      }
      const rawThumbs = sessionStorage.getItem(THUMB_STORAGE_KEY);
      if (rawThumbs) {
        const thumbEntries = JSON.parse(rawThumbs);
        if (Array.isArray(thumbEntries)) {
          for (const [vid, thumbs] of thumbEntries) {
            if (typeof vid === 'string' && Array.isArray(thumbs) && thumbs.length) {
              videoThumbMap.set(vid, thumbs);
            }
          }
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  function saveSessionCache() {
    try {
      const entries = Array.from(omvToAtvMap.entries()).slice(-MAX_SESSION_ENTRIES);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      const thumbEntries = Array.from(videoThumbMap.entries()).slice(-MAX_SESSION_ENTRIES);
      sessionStorage.setItem(THUMB_STORAGE_KEY, JSON.stringify(thumbEntries));
    } catch {
      // Ignore quota errors
    }
  }

  function persistMappingToExtension(omvId, atvId, squareThumbs) {
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

  function rememberMapping(omvId, atvId, thumbnails, { persist = true } = {}) {
    if (!omvId || !atvId || omvId === atvId) return;
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
    if (squareThumbs && !videoThumbMap.has(atvId)) {
      videoThumbMap.set(omvId, squareThumbs);
      videoThumbMap.set(atvId, squareThumbs);
      changed = true;
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

  function registerTracksMetadata(tracks) {
    if (!Array.isArray(tracks)) return;
    for (const t of tracks) {
      if (!t?.videoId) continue;
      if (t.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') {
        knownAtvSet.add(t.videoId);
      } else if (isResolvableNonAtvType(t.musicVideoType) && t.title) {
        const existing = knownOmvMeta.get(t.videoId);
        if (!existing) {
          knownOmvMeta.set(t.videoId, {
            videoId: t.videoId,
            title: t.title,
            artist: t.artist || '',
            artistBrowseId: t.artistBrowseId || '',
            musicVideoType: t.musicVideoType,
            durationSec: t.durationSec || 0
          });
        } else if (!existing.artistBrowseId && t.artistBrowseId) {
          existing.artistBrowseId = t.artistBrowseId;
        }
      }
    }
    trimMap(knownOmvMeta);
    trimSet(knownAtvSet);
  }

  function markNoAtv(omvId) {
    if (!omvId) return;
    noAtvSet.add(omvId);
    trimSet(noAtvSet);
  }

  function markPlayerRequest(videoId, origOmvId) {
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

  function wasRecentlyLoadedAsAtv(omvId, atvId, windowMs = 8000) {
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

  const clearListeners = [];

  function onCacheClear(fn) {
    clearListeners.push(fn);
  }

  function clearAllCaches() {
    omvToAtvMap.clear();
    atvToOmvMap.clear();
    videoThumbMap.clear();
    noAtvSet.clear();
    recentPlayerSwaps.clear();
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(THUMB_STORAGE_KEY);
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

  function hydrateFromPersistentCache(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    let added = false;
    for (const item of entries) {
      if (!item || typeof item.o !== 'string' || typeof item.a !== 'string') continue;
      if (item.o === item.a) continue;
      if (!omvToAtvMap.has(item.o)) {
        omvToAtvMap.set(item.o, item.a);
        atvToOmvMap.set(item.a, item.o);
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

  loadSessionCache();

  window.addEventListener('ytm-lite-settings', (event) => {
    if (event?.detail && typeof event.detail.enabled === 'boolean') {
      enabled = event.detail.enabled;
      try {
        sessionStorage.setItem(ENABLED_STORAGE_KEY, enabled ? '1' : '0');
      } catch {
        // Ignore storage errors
      }
    }
  });

  window.addEventListener('ytm-lite-cache-hydrate', (event) => {
    hydrateFromPersistentCache(event?.detail?.entries);
  });

  window.addEventListener('ytm-lite-cache-clear', () => {
    clearAllCaches();
  });

  // Notify isolated world content.js that cache listener is ready for hydration
  try {
    window.dispatchEvent(new CustomEvent('ytm-lite-cache-ready'));
  } catch {
    // Ignore
  }

  boot.cache = {
    isEnabled: () => enabled,
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
})();
