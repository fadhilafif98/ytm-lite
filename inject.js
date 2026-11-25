(() => {
  if (window.__ytmLiteInjected) return;
  window.__ytmLiteInjected = true;

  const boot = window.__ytmLiteBoot;
  try {
    delete window.__ytmLiteBoot;
  } catch {
    window.__ytmLiteBoot = undefined;
  }
  if (!boot?.matcher || !boot?.cache || !boot?.resolver) return;

  const {
    isResolvableNonAtvType,
    getMusicVideoType,
    setMusicVideoTypeAtv,
    findFirstWatchEndpoint,
    extractResponsiveItems,
    extractPlaylistPanelItems,
    stripViewsAndLikesFromByline
  } = boot.matcher;

  const {
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
  } = boot.cache;

  const {
    init: initResolver,
    collectCounterpartMappings,
    fetchVlAlbumTracks,
    pairAndRememberTracks,
    resolveTrack,
    updateActiveQueue,
    cancelLookahead,
    scheduleLookahead
  } = boot.resolver;

  const originalFetch = window.fetch;
  initResolver({ originalFetch });

  let lastRedirectedOmv = '';
  let lastRedirectTime = 0;

  /**
   * Deep-rewrite mapped OMV videoIds / watchEndpoints / playlistPanelVideoRenderers
   * using omvToAtvMap + square album covers, clean OMV views/likes bylines, and swap
   * any official playlistPanelVideoWrapperRenderer counterparts.
   */
  function rewritePayloadToAtv(root) {
    let modified = false;
    let activeSwap = null;

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }

      // 1. Swap official YouTube Premium/wrapper counterpart
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

            if (atvEntry) {
              const atvRenderer =
                atvEntry.counterpartRenderer.playlistPanelVideoRenderer;
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
              }
            }
          }
        }
      }

      // 2. Rewrite plain playlistPanelVideoRenderer using omvToAtvMap + square cover + clean byline
      if (node.playlistPanelVideoRenderer?.videoId) {
        const r = node.playlistPanelVideoRenderer;
        const origId = r.videoId;
        const mappedAtv = omvToAtvMap.get(origId);
        if (mappedAtv) {
          r.videoId = mappedAtv;
          if (r.navigationEndpoint?.watchEndpoint) {
            r.navigationEndpoint.watchEndpoint.videoId = mappedAtv;
            setMusicVideoTypeAtv(r.navigationEndpoint.watchEndpoint);
          }
          stripViewsAndLikesFromByline(r.longBylineText);
          stripViewsAndLikesFromByline(r.shortBylineText);
          if (r.selected) {
            activeSwap = {
              omvId: origId,
              atvId: mappedAtv,
              playlistId: r.navigationEndpoint?.watchEndpoint?.playlistId || ''
            };
          }
          modified = true;
        }
        const squareThumbs =
          videoThumbMap.get(r.videoId) || videoThumbMap.get(origId);
        if (squareThumbs && r.thumbnail) {
          r.thumbnail.thumbnails = squareThumbs.map((t) => ({ ...t }));
          modified = true;
        }
      }

      // 2b. Rewrite musicResponsiveListItemRenderer thumbnail (Playlist / Search / Home rows)
      if (node.musicResponsiveListItemRenderer) {
        const r = node.musicResponsiveListItemRenderer;
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

      // 3. Rewrite any watchEndpoint pointing to a mapped OMV
      if (node.watchEndpoint?.videoId) {
        const mappedAtv = omvToAtvMap.get(node.watchEndpoint.videoId);
        if (mappedAtv) {
          node.watchEndpoint.videoId = mappedAtv;
          setMusicVideoTypeAtv(node.watchEndpoint);
          modified = true;
        }
      }

      // 4. Rewrite playlistItemData.videoId
      if (node.playlistItemData?.videoId) {
        const mappedAtv = omvToAtvMap.get(node.playlistItemData.videoId);
        if (mappedAtv) {
          node.playlistItemData.videoId = mappedAtv;
          modified = true;
        }
      }

      // 5. Rewrite queueAddEndpoint.queueTarget.videoId
      if (node.queueTarget?.videoId) {
        const mappedAtv = omvToAtvMap.get(node.queueTarget.videoId);
        if (mappedAtv) {
          node.queueTarget.videoId = mappedAtv;
          modified = true;
        }
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) walk(node[keys[i]]);
    }

    walk(root);
    return { modified, activeSwap };
  }

  function syncDomCoverArt(videoId) {
    if (!isEnabled() || !videoId) return;
    const thumbs = videoThumbMap.get(videoId);
    const hiResUrl = thumbs?.[thumbs.length - 1]?.url || '';

    requestAnimationFrame(() => {
      // Clear stale video-mode on ytmusic-player when playing a confirmed ATV track
      // (e.g. clicked from an unrewritten Up Next queue item) so YTM uses its native 1:1 cover layout.
      const playerEl = document.querySelector('ytmusic-player');
      const moviePlayer = document.getElementById('movie_player');
      const curVid =
        typeof moviePlayer?.getVideoData === 'function'
          ? moviePlayer.getVideoData()?.video_id || ''
          : '';
      if (
        playerEl &&
        playerEl.hasAttribute('video-mode') &&
        !playerEl.hasAttribute('is-advertisement-playing') &&
        (curVid === videoId || !curVid) &&
        (atvToOmvMap.has(videoId) || knownAtvSet.has(videoId))
      ) {
        playerEl.removeAttribute('video-mode');
      }

      if (!hiResUrl) return;
      const targets = [
        document.querySelector('ytmusic-player #song-image img'),
        document.querySelector('ytmusic-player-bar img.image')
      ];
      for (const img of targets) {
        if (!img) continue;
        const src = img.getAttribute('src') || '';
        if (src && src !== hiResUrl && src.includes('ytimg.com')) {
          img.setAttribute('src', hiResUrl);
        }
      }
    });
  }

  /**
   * Non-destructive fallback swap: never calls ytmusic-app.navigate() so YTM's
   * background browse page & minimize state are never disrupted.
   */
  function redirectPlayerToAtv({ omvId, atvId }) {
    if (!isEnabled() || !atvId) return;

    syncDomCoverArt(atvId);

    if (wasRecentlyLoadedAsAtv(omvId, atvId)) {
      return;
    }

    const now = Date.now();
    if (omvId === lastRedirectedOmv && now - lastRedirectTime < 2500) {
      return;
    }

    const moviePlayer = document.getElementById('movie_player');
    const currentVideoId =
      typeof moviePlayer?.getVideoData === 'function'
        ? moviePlayer.getVideoData()?.video_id || ''
        : '';

    if (currentVideoId === atvId) return;
    if (currentVideoId && omvId && currentVideoId !== omvId) return;

    lastRedirectedOmv = omvId;
    lastRedirectTime = now;

    // 1. Prefer native Song button when toggle is actively in OMV_PREFERRED mode
    const avToggle = document.querySelector('ytmusic-av-toggle');
    if (
      avToggle &&
      !avToggle.hasAttribute('toggle-disabled') &&
      avToggle.getAttribute('playback-mode') === 'OMV_PREFERRED'
    ) {
      const songBtn = avToggle.querySelector('.song-button');
      if (
        songBtn &&
        !songBtn.hasAttribute('disabled') &&
        songBtn.getAttribute('aria-disabled') !== 'true'
      ) {
        songBtn.click();
        return;
      }
    }

    // 2. Swap stream directly inside movie_player without touching page navigation
    if (moviePlayer && typeof moviePlayer.loadVideoById === 'function') {
      try {
        markPlayerRequest(atvId, omvId);
        moviePlayer.loadVideoById(atvId);
      } catch {
        // Ignore
      }
    }
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  async function decodeBytesToText(bytes) {
    if (!bytes || bytes.byteLength === 0) return '';
    // Detect GZIP magic bytes (0x1f 0x8b) — YTM compresses /player & /next POST bodies
    if (
      bytes.byteLength >= 2 &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b &&
      typeof DecompressionStream === 'function'
    ) {
      const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(ds).text();
    }
    return new TextDecoder().decode(bytes);
  }

  async function readRequestBodyObj(input, init) {
    try {
      let bodyText = null;
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
      return bodyText ? JSON.parse(bodyText) : null;
    } catch {
      return null;
    }
  }

  function replaceRequestBody(input, init, bodyObj) {
    const newBody = JSON.stringify(bodyObj);
    if (init && init.body !== undefined) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.delete('content-encoding');
      headers.delete('content-length');
      return { input, init: { ...init, headers, body: newBody } };
    }
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return { input: new Request(input, { headers, body: newBody }), init };
    }
    return { input, init };
  }

  window.fetch = async function ytmLiteFetch(input, init) {
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

    // Passively capture OMV metadata from YTM's own search results (0 blocking)
    if (isSearchReq) {
      const searchRes = await originalFetch.call(this, input, init);
      if (searchRes.ok) {
        (async () => {
          try {
            const searchJson = await searchRes.clone().json();
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
    let playerRetryInput = null;

    // Outgoing /player: high-priority resolve before sending so MV never loads
    if (isPlayerReq && origPlayerVideoId) {
      let mappedAtv = omvToAtvMap.get(origPlayerVideoId);
      if (
        !mappedAtv &&
        !noAtvSet.has(origPlayerVideoId) &&
        knownOmvMeta.has(origPlayerVideoId)
      ) {
        // Free HTTP connections from stale lookahead so active song gets instant priority
        cancelLookahead();
        pendingPlayerSwaps.add(origPlayerVideoId);
        try {
          await resolveTrack(
            knownOmvMeta.get(origPlayerVideoId),
            url,
            reqBody?.context,
            { priority: 'high' }
          );
          mappedAtv = omvToAtvMap.get(origPlayerVideoId);
        } finally {
          pendingPlayerSwaps.delete(origPlayerVideoId);
        }
      }

      if (mappedAtv) {
        reqBody.videoId = mappedAtv;
        const replaced = replaceRequestBody(nextInput, nextInit, reqBody);
        nextInput = replaced.input;
        nextInit = replaced.init;
        markPlayerRequest(mappedAtv, origPlayerVideoId);
        setTimeout(() => syncDomCoverArt(mappedAtv), 120);
      } else {
        markPlayerRequest(origPlayerVideoId, '');
        if (!noAtvSet.has(origPlayerVideoId) && !knownAtvSet.has(origPlayerVideoId)) {
          cancelLookahead();
          pendingPlayerSwaps.add(origPlayerVideoId);
          playerRetryInput = input instanceof Request ? input.clone() : input;
        }
      }
    }

    // Outgoing /next: temporarily send original OMV so YouTube marks the right queue track selected
    if (isNextReq && reqBody?.videoId && reqBody?.playlistId) {
      const originalOmv = atvToOmvMap.get(reqBody.videoId);
      if (originalOmv) {
        reqBody.videoId = originalOmv;
        const replaced = replaceRequestBody(nextInput, nextInit, reqBody);
        nextInput = replaced.input;
        nextInit = replaced.init;
      }
    }

    const response = await originalFetch.call(this, nextInput, nextInit);

    if (!response.ok) {
      if (origPlayerVideoId) pendingPlayerSwaps.delete(origPlayerVideoId);
      return response;
    }

    // Cache-miss /player fallback (cold /watch?v=... links) + rolling lookahead trigger
    if (isPlayerReq) {
      try {
        if (playerRetryInput && origPlayerVideoId && !omvToAtvMap.has(origPlayerVideoId)) {
          const playerData = await response.clone().json();
          const vd = playerData?.videoDetails;
          const mvType = vd?.musicVideoType || '';
          if (vd?.videoId && isResolvableNonAtvType(mvType)) {
            await resolveTrack(
              {
                videoId: origPlayerVideoId,
                title: vd.title || '',
                artist: vd.author || '',
                musicVideoType: mvType,
                durationSec: Number(vd.lengthSeconds) || 0
              },
              url,
              reqBody?.context,
              { priority: 'high' }
            );
            const resolvedAtv = omvToAtvMap.get(origPlayerVideoId);
            if (resolvedAtv) {
              const retryBody = { ...reqBody, videoId: resolvedAtv };
              const replaced = replaceRequestBody(playerRetryInput, init, retryBody);
              const atvResponse = await originalFetch.call(
                this,
                replaced.input,
                replaced.init
              );
              if (atvResponse.ok) {
                markPlayerRequest(resolvedAtv, origPlayerVideoId);
                setTimeout(() => syncDomCoverArt(resolvedAtv), 120);
                scheduleLookahead(origPlayerVideoId, url, reqBody?.context);
                return atvResponse;
              }
            }
          }
        }
      } catch {
        // Fall back to original player response
      } finally {
        if (origPlayerVideoId) pendingPlayerSwaps.delete(origPlayerVideoId);
      }

      if (origPlayerVideoId) {
        scheduleLookahead(origPlayerVideoId, url, reqBody?.context);
      }
      return response;
    }

    try {
      const data = await response.clone().json();

      // /browse: ZERO eager search calls! Only register metadata + fast 1-request album VL pairing
      if (isBrowseReq) {
        const browseId = reqBody?.browseId || '';
        if (!browseId.startsWith('VLOLAK5uy_')) {
          const items = extractResponsiveItems(data);
          registerTracksMetadata(items);
          const olakTrack = items.find(
            (t) =>
              t.playlistId.startsWith('OLAK5uy_') &&
              t.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV'
          );
          if (olakTrack) {
            const vlTracks = await fetchVlAlbumTracks(
              olakTrack.playlistId,
              url,
              reqBody?.context
            );
            pairAndRememberTracks(items, vlTracks);
          }
        }
      }

      // /next or /get_queue: await ONLY the active selected track so UI renders immediately,
      // then warm the next 3 tracks via cancellable background lookahead.
      let lookaheadAnchorId = '';
      if (isNextReq) {
        collectCounterpartMappings(data);

        const panelItems = extractPlaylistPanelItems(data);
        registerTracksMetadata(panelItems);
        updateActiveQueue(panelItems);

        const olakPlaylistId =
          (typeof reqBody?.playlistId === 'string' &&
          reqBody.playlistId.startsWith('OLAK5uy_')
            ? reqBody.playlistId
            : panelItems.find((t) => t.playlistId.startsWith('OLAK5uy_'))
                ?.playlistId) || '';

        if (
          olakPlaylistId &&
          panelItems.some((t) => t.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV')
        ) {
          const vlTracks = await fetchVlAlbumTracks(
            olakPlaylistId,
            url,
            reqBody?.context
          );
          pairAndRememberTracks(panelItems, vlTracks);
        }

        const selectedItem = panelItems.find((t) => t.selected) || panelItems[0];
        if (selectedItem?.videoId) {
          lookaheadAnchorId = selectedItem.videoId;
          if (
            isResolvableNonAtvType(selectedItem.musicVideoType) &&
            !omvToAtvMap.has(selectedItem.videoId) &&
            !noAtvSet.has(selectedItem.videoId)
          ) {
            cancelLookahead();
            await resolveTrack(selectedItem, url, reqBody?.context, {
              priority: 'high'
            });
          }
        }
      }

      const { modified, activeSwap } = rewritePayloadToAtv(data);

      if (isNextReq) {
        if (lookaheadAnchorId) {
          scheduleLookahead(lookaheadAnchorId, url, reqBody?.context);
        }
        if (activeSwap) {
          if (wasRecentlyLoadedAsAtv(activeSwap.omvId, activeSwap.atvId)) {
            setTimeout(() => syncDomCoverArt(activeSwap.atvId), 120);
          } else {
            setTimeout(() => redirectPlayerToAtv(activeSwap), 80);
          }
        } else {
          const currentVid = new URLSearchParams(window.location.search).get('v');
          if (currentVid && videoThumbMap.has(currentVid)) {
            setTimeout(() => syncDomCoverArt(currentVid), 120);
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

  /**
   * Intercept XMLHttpRequest for /player and /next as a safety net when base.js uses XHR.
   */
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function ytmLiteXhrOpen(method, url, asyncFlag, ...rest) {
    try {
      const urlStr = typeof url === 'string' ? url : String(url || '');
      this.__ytmSeq = (this.__ytmSeq || 0) + 1;
      this.__ytmLite = {
        method: String(method || '').toUpperCase(),
        url: urlStr,
        async: asyncFlag !== false,
        seq: this.__ytmSeq
      };
    } catch {
      this.__ytmLite = null;
    }
    return originalXhrOpen.call(this, method, url, asyncFlag, ...rest);
  };

  XMLHttpRequest.prototype.send = function ytmLiteXhrSend(body) {
    const meta = this.__ytmLite;
    if (!isEnabled() || !meta || !meta.async || typeof body !== 'string') {
      return originalXhrSend.call(this, body);
    }

    const url = meta.url;
    const isPlayerReq = url.includes('/youtubei/v1/player');
    const isNextReq =
      url.includes('/youtubei/v1/next') ||
      url.includes('/youtubei/v1/music/get_queue');

    if (!isPlayerReq && !isNextReq) {
      return originalXhrSend.call(this, body);
    }

    let reqBody = null;
    try {
      reqBody = JSON.parse(body);
    } catch {
      return originalXhrSend.call(this, body);
    }

    if (isPlayerReq && reqBody?.videoId) {
      const origVid = reqBody.videoId;
      const absUrl = url.startsWith('http')
        ? url
        : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;

      const mappedAtv = omvToAtvMap.get(origVid);
      if (mappedAtv) {
        reqBody.videoId = mappedAtv;
        markPlayerRequest(mappedAtv, origVid);
        setTimeout(() => syncDomCoverArt(mappedAtv), 120);
        scheduleLookahead(origVid, absUrl, reqBody?.context);
        return originalXhrSend.call(this, JSON.stringify(reqBody));
      }

      if (!noAtvSet.has(origVid) && knownOmvMeta.has(origVid)) {
        const xhr = this;
        const seq = meta.seq;
        cancelLookahead();
        pendingPlayerSwaps.add(origVid);
        (async () => {
          try {
            await resolveTrack(knownOmvMeta.get(origVid), absUrl, reqBody?.context, {
              priority: 'high'
            });
            if (xhr.__ytmSeq !== seq || xhr.readyState !== XMLHttpRequest.OPENED) return;
            const resolvedAtv = omvToAtvMap.get(origVid);
            if (resolvedAtv) {
              reqBody.videoId = resolvedAtv;
              markPlayerRequest(resolvedAtv, origVid);
              setTimeout(() => syncDomCoverArt(resolvedAtv), 120);
              originalXhrSend.call(xhr, JSON.stringify(reqBody));
            } else {
              markPlayerRequest(origVid, '');
              originalXhrSend.call(xhr, body);
            }
            scheduleLookahead(origVid, absUrl, reqBody?.context);
          } catch {
            if (xhr.__ytmSeq === seq && xhr.readyState === XMLHttpRequest.OPENED) {
              markPlayerRequest(origVid, '');
              originalXhrSend.call(xhr, body);
            }
          } finally {
            pendingPlayerSwaps.delete(origVid);
          }
        })();
        return;
      }

      markPlayerRequest(origVid, '');

      if (!noAtvSet.has(origVid) && !knownAtvSet.has(origVid)) {
        const xhr = this;
        xhr.addEventListener('load', async () => {
          if (!isEnabled()) return;
          try {
            const text =
              xhr.responseType === '' || xhr.responseType === 'text'
                ? xhr.responseText
                : '';
            const playerData =
              xhr.responseType === 'json'
                ? xhr.response
                : text
                  ? JSON.parse(text)
                  : null;
            const vd = playerData?.videoDetails;
            const mvType = vd?.musicVideoType || '';
            if (vd?.videoId && isResolvableNonAtvType(mvType)) {
              const found = await resolveTrack(
                {
                  videoId: origVid,
                  title: vd.title || '',
                  artist: vd.author || '',
                  musicVideoType: mvType,
                  durationSec: Number(vd.lengthSeconds) || 0
                },
                absUrl,
                reqBody?.context,
                { priority: 'high' }
              );
              const resolvedAtv = found ? omvToAtvMap.get(origVid) : '';
              if (resolvedAtv) {
                redirectPlayerToAtv({ omvId: origVid, atvId: resolvedAtv });
              }
            }
          } catch {
            // Ignore parse errors
          }
        });
      }

      scheduleLookahead(origVid, absUrl, reqBody?.context);
      return originalXhrSend.call(this, body);
    }

    if (isNextReq && reqBody?.videoId && reqBody?.playlistId) {
      const originalOmv = atvToOmvMap.get(reqBody.videoId);
      if (originalOmv) {
        reqBody.videoId = originalOmv;
        return originalXhrSend.call(this, JSON.stringify(reqBody));
      }
    }

    return originalXhrSend.call(this, body);
  };

  /**
   * Hook ytcfg.set({ YTMUSIC_INITIAL_DATA: [...] }) at document_start:
   * registers ALL inline playlist/page OMV metadata synchronously (0 network calls!)
   * and rewrites any tracks already present in cache.
   */
  const processedInitialEntries = new WeakSet();

  function processInitialDataEntry(entry) {
    if (!isEnabled() || !entry || typeof entry !== 'object') return entry;
    if (processedInitialEntries.has(entry)) return entry;
    processedInitialEntries.add(entry);

    const path = String(entry.path || '');
    if (!path.includes('/browse') && !path.includes('/next')) return entry;

    try {
      const isString = typeof entry.data === 'string';
      const parsed = isString ? JSON.parse(entry.data) : entry.data;
      if (!parsed || typeof parsed !== 'object') return entry;

      collectCounterpartMappings(parsed);
      const responsiveItems = extractResponsiveItems(parsed);
      const panelItems = extractPlaylistPanelItems(parsed);
      const allItems = [...responsiveItems, ...panelItems];
      registerTracksMetadata(allItems);

      const { modified } = rewritePayloadToAtv(parsed);
      if (modified && isString) {
        entry.data = JSON.stringify(parsed);
      }
    } catch {
      // Ignore parse errors
    }
    return entry;
  }

  function processInitialDataList(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      processInitialDataEntry(list[i]);
    }
  }

  function installInitialDataHook() {
    function wrapYtcfgSet(cfg) {
      if (!cfg || typeof cfg !== 'object' || cfg.__ytmLiteSetHooked) return;
      cfg.__ytmLiteSetHooked = true;

      let origSet = typeof cfg.set === 'function' ? cfg.set : undefined;
      function wrappedSet(...args) {
        try {
          if (args[0] && typeof args[0] === 'object' && Array.isArray(args[0].YTMUSIC_INITIAL_DATA)) {
            processInitialDataList(args[0].YTMUSIC_INITIAL_DATA);
          } else if (args[0] === 'YTMUSIC_INITIAL_DATA' && Array.isArray(args[1])) {
            processInitialDataList(args[1]);
          }
        } catch {
          // Ignore
        }
        return origSet ? origSet.apply(this, args) : undefined;
      }

      try {
        Object.defineProperty(cfg, 'set', {
          configurable: true,
          enumerable: true,
          get() {
            return origSet ? wrappedSet : undefined;
          },
          set(fn) {
            origSet = typeof fn === 'function' ? fn : undefined;
          }
        });
      } catch {
        if (origSet) cfg.set = wrappedSet;
      }

      try {
        const existing = cfg.get?.('YTMUSIC_INITIAL_DATA');
        if (Array.isArray(existing)) processInitialDataList(existing);
      } catch {
        // Ignore
      }
    }

    let backingYtcfg = window.ytcfg;
    if (backingYtcfg && typeof backingYtcfg === 'object') {
      wrapYtcfgSet(backingYtcfg);
    }

    try {
      Object.defineProperty(window, 'ytcfg', {
        configurable: true,
        enumerable: true,
        get() {
          return backingYtcfg;
        },
        set(val) {
          backingYtcfg = val;
          if (val && typeof val === 'object') {
            wrapYtcfgSet(val);
          }
        }
      });
    } catch {
      // Fall through to DOMContentLoaded scan
    }

    window.addEventListener(
      'DOMContentLoaded',
      () => {
        try {
          const list = window.ytcfg?.get?.('YTMUSIC_INITIAL_DATA');
          if (Array.isArray(list)) processInitialDataList(list);
        } catch {
          // Ignore
        }
      },
      { once: true }
    );
  }

  installInitialDataHook();

  window.addEventListener('ytm-lite-settings', (event) => {
    if (event?.detail && event.detail.enabled === false) {
      cancelLookahead();
    }
  });
})();
