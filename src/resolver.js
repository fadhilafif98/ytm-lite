(() => {
  if (window.__ytmLiteInjected) return;

  const boot = window.__ytmLiteBoot;
  if (!boot?.matcher || !boot?.cache) return;

  const {
    isResolvableNonAtvType,
    normalizeTitle,
    normalizeArtist,
    parseTitleParts,
    extractResponsiveItems,
    matchArtistsScore,
    pickBestCandidate,
    getMusicVideoType
  } = boot.matcher;

  const {
    isEnabled,
    omvToAtvMap,
    atvToOmvMap,
    knownOmvMeta,
    noAtvSet,
    trimMap,
    rememberMapping,
    markNoAtv,
    onCacheClear
  } = boot.cache;

  const SONGS_SEARCH_PARAMS = 'EgWKAQIIAWoKEAMQBBAJEAoQBQ%3D%3D';
  const LOOKAHEAD_COUNT = 3;
  const LOOKAHEAD_CONCURRENCY = 2;

  let rawFetch = window.fetch;
  const vlCache = new Map(); // playlistId -> Promise<Array>
  const artistSongsCache = new Map(); // artistBrowseId -> Promise<Array>
  const searchCache = new Map(); // omvId -> Promise<boolean>
  const highPriorityIds = new Set(); // omvIds currently needed by active /player or /next

  let activeQueueIds = [];
  let lookaheadGen = 0;
  let lookaheadAbort = null;

  onCacheClear(() => {
    vlCache.clear();
    artistSongsCache.clear();
    cancelLookahead();
  });

  function init({ originalFetch }) {
    if (typeof originalFetch === 'function') {
      rawFetch = originalFetch;
    }
  }

  function getInnertubeContext(context) {
    if (context) return context;
    try {
      const cfgCtx = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
      if (cfgCtx && typeof cfgCtx === 'object') return cfgCtx;
    } catch {
      // Ignore ytcfg access errors
    }
    return {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20261120.01.00'
      }
    };
  }

  function buildYoutubeiUrl(sourceUrl, endpoint) {
    if (sourceUrl && sourceUrl.includes('/youtubei/v1/')) {
      return sourceUrl.replace(/\/youtubei\/v1\/[^?]+/, `/youtubei/v1/${endpoint}`);
    }
    return `${window.location.origin}/youtubei/v1/${endpoint}?prettyPrint=false`;
  }

  function collectCounterpartMappings(root) {
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.playlistPanelVideoWrapperRenderer) {
        const wrapper = node.playlistPanelVideoWrapperRenderer;
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
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) walk(node[keys[i]]);
    }
    walk(root);
  }

  function fetchVlAlbumTracks(playlistId, sourceUrl, context) {
    if (!playlistId || !playlistId.startsWith('OLAK5uy_')) {
      return Promise.resolve([]);
    }
    if (vlCache.has(playlistId)) {
      return vlCache.get(playlistId);
    }

    const browseUrl = buildYoutubeiUrl(sourceUrl, 'browse');
    const promise = (async () => {
      try {
        const res = await rawFetch.call(window, browseUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: getInnertubeContext(context),
            browseId: `VL${playlistId}`
          })
        });
        if (!res.ok) {
          vlCache.delete(playlistId);
          return [];
        }
        const json = await res.json();
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

  function pairAndRememberTracks(sourceTracks, vlAtvTracks) {
    if (!sourceTracks.length || !vlAtvTracks.length) return;

    const sameLength = sourceTracks.length === vlAtvTracks.length;
    const vlByTitle = new Map();
    for (const v of vlAtvTracks) {
      const key = normalizeTitle(v.title);
      if (key && !vlByTitle.has(key)) {
        vlByTitle.set(key, v);
      }
    }

    for (let i = 0; i < sourceTracks.length; i++) {
      const src = sourceTracks[i];
      if (!src.videoId || src.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV') continue;

      let match = null;
      if (sameLength) {
        const byIndex = vlAtvTracks[i];
        if (
          byIndex &&
          (!src.title ||
            !byIndex.title ||
            normalizeTitle(src.title) === normalizeTitle(byIndex.title))
        ) {
          match = byIndex;
        }
      }
      if (!match && src.title) {
        match = vlByTitle.get(normalizeTitle(src.title)) || null;
      }
      if (!match && sameLength) {
        match = vlAtvTracks[i];
      }

      if (match?.videoId && match.videoId !== src.videoId) {
        rememberMapping(src.videoId, match.videoId, match.thumbnails);
      }
    }
  }

  function fetchArtistTopSongs(artistBrowseId, sourceUrl, context, signal) {
    if (!artistBrowseId || !artistBrowseId.startsWith('UC')) {
      return Promise.resolve([]);
    }
    if (artistSongsCache.has(artistBrowseId)) {
      return artistSongsCache.get(artistBrowseId);
    }

    const browseUrl = buildYoutubeiUrl(sourceUrl, 'browse');
    const promise = (async () => {
      try {
        const fetchOpts = {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: getInnertubeContext(context),
            browseId: artistBrowseId
          })
        };
        if (signal) fetchOpts.signal = signal;
        const res = await rawFetch.call(window, browseUrl, fetchOpts);
        if (!res.ok) {
          artistSongsCache.delete(artistBrowseId);
          return [];
        }
        const json = await res.json();
        return extractResponsiveItems(json).filter(
          (item) => item.musicVideoType === 'MUSIC_VIDEO_TYPE_ATV'
        );
      } catch {
        artistSongsCache.delete(artistBrowseId);
        return [];
      }
    })();

    artistSongsCache.set(artistBrowseId, promise);
    trimMap(artistSongsCache, 300);
    return promise;
  }

  function resolveTrack(track, sourceUrl, context, { priority = 'high', signal = null } = {}) {
    const omvId = track?.videoId;
    if (
      !omvId ||
      omvToAtvMap.has(omvId) ||
      noAtvSet.has(omvId) ||
      !isResolvableNonAtvType(track.musicVideoType || 'MUSIC_VIDEO_TYPE_OMV')
    ) {
      return Promise.resolve(omvToAtvMap.has(omvId));
    }

    if (priority === 'high') {
      highPriorityIds.add(omvId);
    }

    if (searchCache.has(omvId)) {
      return searchCache.get(omvId);
    }

    const { cleaned, artistFromTitle, titleWithoutArtist } = parseTitleParts(
      track.title,
      track.artist
    );
    if (!cleaned) {
      markNoAtv(omvId);
      highPriorityIds.delete(omvId);
      return Promise.resolve(false);
    }

    const artist = (track.artist || '').trim();
    const queryTitle = titleWithoutArtist || cleaned;
    const queryArtist = artistFromTitle || artist;
    const primaryQuery = queryArtist ? `${queryTitle} ${queryArtist}` : queryTitle;
    const fallbackQuery = queryArtist ? `${queryArtist} ${queryTitle}` : `"${queryTitle}"`;
    const searchUrl = buildYoutubeiUrl(sourceUrl, 'search');
    const reqContext = getInnertubeContext(context);
    const minScore = normalizeArtist(queryArtist) ? 95 : 80;
    let discoveredArtistBrowseId = track.artistBrowseId || '';

    function getActiveSignal() {
      // Never abort a request that was started as or promoted to high priority
      if (priority === 'high' || highPriorityIds.has(omvId)) return undefined;
      return signal || undefined;
    }

    async function runSearch(query, useSongsFilter) {
      const payload = { context: reqContext, query };
      if (useSongsFilter) payload.params = SONGS_SEARCH_PARAMS;
      const fetchOpts = {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
      const activeSignal = getActiveSignal();
      if (activeSignal) fetchOpts.signal = activeSignal;

      const res = await rawFetch.call(window, searchUrl, fetchOpts);
      if (!res.ok) return null;

      const json = await res.json();
      const allItems = extractResponsiveItems(json);

      if (!discoveredArtistBrowseId && queryArtist) {
        const artistHit = allItems.find(
          (item) =>
            item.artistBrowseId &&
            matchArtistsScore(queryArtist, item.artist, '') >= 50
        );
        if (artistHit) {
          discoveredArtistBrowseId = artistHit.artistBrowseId;
        }
      }

      return pickBestCandidate(track, allItems, omvId, minScore);
    }

    const promise = (async () => {
      try {
        // Stage 1: Songs-filtered search ("Title Artist")
        let best = await runSearch(primaryQuery, true);

        // Stage 2: Unfiltered Top-Result/Songs search ("Artist Title")
        if (!best) {
          best = await runSearch(fallbackQuery, false);
        }

        // Stage 3: Artist official YTM page (/browse) for label-uploaded / unindexed releases
        if (!best && discoveredArtistBrowseId) {
          const artistSongs = await fetchArtistTopSongs(
            discoveredArtistBrowseId,
            searchUrl,
            reqContext,
            getActiveSignal()
          );
          best = pickBestCandidate(track, artistSongs, omvId, minScore);
        }

        if (best?.videoId) {
          rememberMapping(omvId, best.videoId, best.thumbnails);
          return true;
        }

        markNoAtv(omvId);
        return false;
      } catch (err) {
        // If aborted by lookahead cancellation, do NOT mark as noAtv
        if (err?.name === 'AbortError') {
          return false;
        }
        return false;
      } finally {
        searchCache.delete(omvId);
        highPriorityIds.delete(omvId);
      }
    })();

    searchCache.set(omvId, promise);
    return promise;
  }

  function updateActiveQueue(panelItems) {
    if (!Array.isArray(panelItems) || panelItems.length === 0) return;
    activeQueueIds = panelItems
      .map((item) => item?.videoId || '')
      .filter(Boolean);
  }

  function cancelLookahead() {
    lookaheadGen += 1;
    if (lookaheadAbort) {
      try {
        lookaheadAbort.abort();
      } catch {
        // Ignore abort errors
      }
      lookaheadAbort = null;
    }
  }

  /**
   * Non-blocking rolling lookahead: warms up only the next LOOKAHEAD_COUNT (3)
   * unmapped OMV tracks in activeQueueIds after currentVideoId. Immediately
   * cancelled whenever the user jumps to another song.
   */
  function scheduleLookahead(currentVideoId, sourceUrl, context) {
    if (!isEnabled() || !currentVideoId || activeQueueIds.length === 0) return;

    cancelLookahead();
    const gen = lookaheadGen;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    lookaheadAbort = controller;

    const origId = atvToOmvMap.get(currentVideoId) || currentVideoId;
    let startIdx = activeQueueIds.indexOf(origId);
    if (startIdx < 0) startIdx = activeQueueIds.indexOf(currentVideoId);
    if (startIdx < 0) return;

    const targets = [];
    for (let i = startIdx + 1; i < activeQueueIds.length && targets.length < LOOKAHEAD_COUNT; i++) {
      const vid = activeQueueIds[i];
      if (!vid || omvToAtvMap.has(vid) || noAtvSet.has(vid)) continue;
      const meta = knownOmvMeta.get(vid);
      if (meta) targets.push(meta);
    }

    if (targets.length === 0) return;

    let idx = 0;
    const workerCount = Math.min(LOOKAHEAD_CONCURRENCY, targets.length);
    for (let w = 0; w < workerCount; w++) {
      (async () => {
        while (idx < targets.length) {
          if (gen !== lookaheadGen || !isEnabled()) return;
          const item = targets[idx++];
          if (omvToAtvMap.has(item.videoId) || noAtvSet.has(item.videoId)) continue;
          await resolveTrack(item, sourceUrl, context, {
            priority: 'low',
            signal: controller?.signal || null
          });
        }
      })();
    }
  }

  boot.resolver = {
    init,
    getInnertubeContext,
    buildYoutubeiUrl,
    collectCounterpartMappings,
    fetchVlAlbumTracks,
    pairAndRememberTracks,
    resolveTrack,
    updateActiveQueue,
    cancelLookahead,
    scheduleLookahead
  };
})();
