'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadInjectEnv({ fetchImpl, documentMock, setupWin, navigatorMock } = {}) {
  const storage = new Map();
  const dispatched = [];
  const domListeners = new Map();
  const observers = [];
  const distDir = path.join(__dirname, '..', 'dist');

  class FakeMutationObserver {
    constructor(cb) {
      this._cb = cb;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, opts) {
      this._target = target;
      this._opts = opts;
    }
    trigger() {
      if (!this.disconnected) this._cb();
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeHeaders {
    constructor(init) {
      this._map = new Map();
      if (init instanceof FakeHeaders) {
        init.forEach((v, k) => this._map.set(k, v));
      } else if (init && typeof init === 'object') {
        for (const [k, v] of Object.entries(init)) {
          this._map.set(k.toLowerCase(), String(v));
        }
      }
    }
    get(k) { return this._map.get(k.toLowerCase()) || null; }
    set(k, v) { this._map.set(k.toLowerCase(), String(v)); }
    delete(k) { this._map.delete(k.toLowerCase()); }
    forEach(cb) { this._map.forEach((v, k) => cb(v, k)); }
  }

  class FakeResponse {
    constructor(body, init = {}) {
      this._body = typeof body === 'string' ? body : JSON.stringify(body);
      this.status = init.status ?? 200;
      this.statusText = init.statusText ?? 'OK';
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new FakeHeaders(init.headers);
    }
    clone() {
      return new FakeResponse(this._body, { status: this.status, statusText: this.statusText, headers: this.headers });
    }
    async json() {
      return JSON.parse(this._body);
    }
  }

  class FakeRequest {
    constructor(input, init = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.headers = new FakeHeaders(init.headers || (input instanceof FakeRequest ? input.headers : undefined));
      this._body = init.body !== undefined ? init.body : input._body;
    }
    clone() {
      return new FakeRequest(this.url, { headers: this.headers, body: this._body });
    }
    async arrayBuffer() {
      return new TextEncoder().encode(this._body || '').buffer;
    }
  }

  class FakeXMLHttpRequest {
    open(method, url, asyncFlag) {
      this._method = method;
      this._url = url;
      this._async = asyncFlag;
      this._openArgCount = arguments.length;
      this.readyState = 1;
      this._listeners = new Map();
    }
    setRequestHeader() {}
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    send(body) {
      this._sentBody = body;
    }
  }
  FakeXMLHttpRequest.OPENED = 1;

  const win = {
    location: { origin: 'https://music.youtube.com', search: '' },
    addEventListener(type, fn) {
      if (!domListeners.has(type)) domListeners.set(type, []);
      domListeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      dispatched.push(ev);
      for (const fn of domListeners.get(ev.type) || []) fn(ev);
      return true;
    },
    fetch: fetchImpl || (async () => new FakeResponse({}))
  };
  if (typeof setupWin === 'function') {
    setupWin(win);
  }

  const sandbox = {
    window: win,
    navigator: navigatorMock || {},
    document: documentMock || {
      hidden: false,
      getElementById: () => null,
      querySelector: () => null
    },
    MutationObserver: FakeMutationObserver,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    Headers: FakeHeaders,
    Response: FakeResponse,
    Request: FakeRequest,
    XMLHttpRequest: FakeXMLHttpRequest,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    AbortController,
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Promise,
    Map,
    Set,
    WeakSet,
    Array,
    Object,
    JSON,
    Date,
    Math,
    Number,
    String,
    Boolean,
    RegExp,
    URL
  };

  const code = fs.readFileSync(path.join(distDir, 'content/inject.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'dist/content/inject.js' });

  return { win, dispatched, observers, FakeResponse, FakeRequest, FakeXMLHttpRequest };
}

test('inject.js rewrites cached OMV /player request and /next payload to ATV + square cover', async () => {
  const fetchCalls = [];
  const env = loadInjectEnv({
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      if (url.includes('/youtubei/v1/next')) {
        return new env.FakeResponse({
          contents: {
            playlistPanelVideoRenderer: {
              videoId: 'omv_1234567',
              selected: true,
              title: { runs: [{ text: 'Song' }] },
              longBylineText: {
                runs: [{ text: 'Artist' }, { text: ' • ' }, { text: '5M views' }]
              },
              navigationEndpoint: {
                watchEndpoint: {
                  videoId: 'omv_1234567',
                  playlistId: 'RDAMVM1'
                }
              },
              thumbnail: {
                thumbnails: [{ url: 'https://i.ytimg.com/vi/omv_1234567/hqdefault.jpg', width: 480, height: 360 }]
              }
            }
          }
        });
      }
      return new env.FakeResponse({ ok: true });
    }
  });

  // Hydrate mapping via extension event
  env.win.dispatchEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: {
      entries: [
        {
          o: 'omv_1234567',
          a: 'atv_7654321',
          u: 'https://lh3.googleusercontent.com/cover=w544-h544-l90-rj'
        }
      ]
    }
  });

  await env.win.fetch('https://music.youtube.com/youtubei/v1/player', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'omv_1234567', context: {} })
  });
  assert.equal(fetchCalls[0].body.videoId, 'atv_7654321');

  const nextRes = await env.win.fetch('https://music.youtube.com/youtubei/v1/next', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'atv_7654321', playlistId: 'RDAMVM1', context: {} })
  });
  assert.equal(fetchCalls[1].body.videoId, 'omv_1234567');
  const nextJson = await nextRes.json();
  const panel = nextJson.contents.playlistPanelVideoRenderer;
  assert.equal(panel.videoId, 'atv_7654321');
  assert.deepEqual(panel.longBylineText.runs, [{ text: 'Artist' }]);
  assert.ok(panel.thumbnail.thumbnails[0].url.includes('googleusercontent.com'));
});

test('inject.js emits swap-state true/false on cold XHR /player request', async () => {
  const env = loadInjectEnv();
  const xhr = new env.FakeXMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player', true);
  xhr.send(JSON.stringify({ videoId: 'cold_omv_01', context: {} }));

  const swapEvents = env.dispatched.filter((e) => e.type === 'ytm-lite-swap-state');
  assert.equal(swapEvents.length, 1);
  assert.equal(swapEvents[0].detail.pending, true);
  assert.equal(swapEvents[0].detail.videoId, 'cold_omv_01');

  // Trigger error event and confirm pending state clears cleanly
  for (const fn of xhr._listeners.get('error') || []) fn();
  const afterError = env.dispatched.filter((e) => e.type === 'ytm-lite-swap-state');
  assert.equal(afterError.length, 2);
  assert.equal(afterError[1].detail.pending, false);
});

test('inject.js preserves OMV inside counterpartRenderer after wrapper swap and guards ytcfg.set self-assignment', async () => {
  const env = loadInjectEnv({
    fetchImpl: async () =>
      new env.FakeResponse({
        contents: {
          playlistPanelVideoWrapperRenderer: {
            primaryRenderer: {
              playlistPanelVideoRenderer: {
                videoId: 'omv_wrap_01',
                selected: true,
                navigationEndpoint: {
                  watchEndpoint: {
                    videoId: 'omv_wrap_01',
                    watchEndpointMusicSupportedConfigs: {
                      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
                    }
                  }
                }
              }
            },
            counterpart: [
              {
                counterpartRenderer: {
                  playlistPanelVideoRenderer: {
                    videoId: 'atv_wrap_01',
                    navigationEndpoint: {
                      watchEndpoint: {
                        videoId: 'atv_wrap_01',
                        watchEndpointMusicSupportedConfigs: {
                          watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
                        }
                      }
                    },
                    thumbnail: {
                      thumbnails: [{ url: 'https://lh3.googleusercontent.com/art=w544-h544', width: 544, height: 544 }]
                    }
                  }
                }
              }
            ]
          }
        }
      })
  });

  const nextRes = await env.win.fetch('https://music.youtube.com/youtubei/v1/next', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'omv_wrap_01', context: {} })
  });
  const json = await nextRes.json();
  const wrapper = json.contents.playlistPanelVideoWrapperRenderer;
  assert.equal(wrapper.primaryRenderer.playlistPanelVideoRenderer.videoId, 'atv_wrap_01');
  assert.equal(wrapper.counterpart[0].counterpartRenderer.playlistPanelVideoRenderer.videoId, 'omv_wrap_01');
  assert.equal(
    wrapper.counterpart[0].counterpartRenderer.playlistPanelVideoRenderer.navigationEndpoint.watchEndpoint.videoId,
    'omv_wrap_01'
  );

  // Self-assigning ytcfg.set must not recurse infinitely
  let calls = 0;
  env.win.ytcfg = {
    set() { calls += 1; },
    get() { return null; }
  };
  env.win.ytcfg.set = env.win.ytcfg.set;
  env.win.ytcfg.set({ YTMUSIC_INITIAL_DATA: [] });
  assert.equal(calls, 1);

  // MAIN-world bootstrap globals must be removed after startup
  assert.equal(env.win.__ytmLiteBoot, undefined);
  assert.equal(env.win.__ytmLiteConst, undefined);
});

test('inject.js shares a single timeout budget between VL album fetch and selected track resolve on /next', async () => {
  const timers = [];
  const env = loadInjectEnv({
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/youtubei/v1/next')) {
        return new env.FakeResponse({
          contents: {
            playlistPanelVideoRenderer: {
              videoId: 'omv_slow_01',
              selected: true,
              title: { runs: [{ text: 'Slow Song' }] },
              longBylineText: { runs: [{ text: 'Slow Artist' }] },
              navigationEndpoint: {
                watchEndpoint: {
                  videoId: 'omv_slow_01',
                  playlistId: 'OLAK5uy_slowalbum123',
                  watchEndpointMusicSupportedConfigs: {
                    watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
                  }
                }
              }
            }
          }
        });
      }
      // Both /browse (VL) and /search stall longer than the 1600ms budget
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(new env.FakeResponse({})), 2200);
        t.unref();
        timers.push(t);
      });
    }
  });

  const startedAt = Date.now();
  const res = await env.win.fetch('https://music.youtube.com/youtubei/v1/next', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'omv_slow_01', playlistId: 'OLAK5uy_slowalbum123', context: {} })
  });
  const elapsedMs = Date.now() - startedAt;
  for (const t of timers) clearTimeout(t);

  assert.equal(res.ok, true);
  assert.ok(elapsedMs < 2400, `expected single shared budget (<2400ms), got ${elapsedMs}ms`);
});

test('inject.js aborts stale /player resolve on rapid skip and prevents stale swap-state clobbering', async () => {
  const searchSignals = new Map();
  let releaseSlowPlayerA;
  const env = loadInjectEnv({
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.includes('/youtubei/v1/search')) {
        searchSignals.set(body.query, init?.signal);
        return new Promise((resolve) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              resolve(Promise.reject(err));
            });
          }
        });
      }
      if (url.includes('/youtubei/v1/player') && body.videoId === 'omv_skip_0A') {
        return new Promise((resolve) => {
          releaseSlowPlayerA = () =>
            resolve(
              new env.FakeResponse({
                videoDetails: {
                  videoId: 'omv_skip_0A',
                  title: 'Track A',
                  author: 'Artist A',
                  lengthSeconds: '200',
                  musicVideoType: 'MUSIC_VIDEO_TYPE_OMV'
                }
              })
            );
        });
      }
      return new env.FakeResponse({ ok: true });
    }
  });

  // Hydrate Track B as cached ATV
  env.win.dispatchEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: {
      entries: [
        {
          o: 'omv_skip_0B',
          a: 'atv_skip_0B',
          u: 'https://lh3.googleusercontent.com/trackB=w544-h544'
        }
      ]
    }
  });

  // 1. Start slow cold /player for Track A
  const pA = env.win.fetch('https://music.youtube.com/youtubei/v1/player', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'omv_skip_0A', context: {} })
  });
  await new Promise((r) => setTimeout(r, 15));

  // 2. Rapidly skip to Track B before Track A finishes
  await env.win.fetch('https://music.youtube.com/youtubei/v1/player', {
    method: 'POST',
    body: JSON.stringify({ videoId: 'omv_skip_0B', context: {} })
  });

  const swapsAfterB = env.dispatched.filter((e) => e.type === 'ytm-lite-swap-state');
  const lastBeforeAEnds = swapsAfterB[swapsAfterB.length - 1];
  assert.equal(lastBeforeAEnds.detail.pending, false);
  assert.equal(lastBeforeAEnds.detail.videoId, 'atv_skip_0B');

  // 3. Now Track A finishes late — it must NOT overwrite Track B's swap-state or fire search
  releaseSlowPlayerA();
  await pA;

  const swapsFinal = env.dispatched.filter((e) => e.type === 'ytm-lite-swap-state');
  assert.equal(swapsFinal.length, swapsAfterB.length, 'stale Track A must not emit swap-state');
  assert.equal(searchSignals.size, 0, 'abandoned Track A must not start cold search');
});

test('inject.js DOM guard enforces native ATV playback-mode, strips video-mode, pulls playerResponse art, and respects ads/manual video', async () => {
  const playerAttrs = new Map([
    ['video-mode', ''],
    ['playback-mode', 'OMV_PREFERRED']
  ]);
  let currentMovieId = 'atv_dom_001';
  const songImg = {
    src: 'https://i.ytimg.com/vi/omv_dom_001/hqdefault.jpg',
    getAttribute: (k) => (k === 'src' ? songImg.src : null),
    setAttribute: (k, v) => {
      if (k === 'src') songImg.src = v;
    }
  };
  const barImg = {
    src: 'https://i.ytimg.com/vi/omv_dom_001/hqdefault.jpg',
    getAttribute: (k) => (k === 'src' ? barImg.src : null),
    setAttribute: (k, v) => {
      if (k === 'src') barImg.src = v;
    }
  };
  const playerEl = {
    videoMode: true,
    hasAttribute: (k) => playerAttrs.has(k),
    getAttribute: (k) => (playerAttrs.has(k) ? playerAttrs.get(k) : null),
    setAttribute: (k, v) => playerAttrs.set(k, String(v)),
    removeAttribute: (k) => playerAttrs.delete(k)
  };
  const pageAttrs = new Map([['video-mode', '']]);
  const playerPageEl = {
    hasAttribute: (k) => pageAttrs.has(k),
    setAttribute: (k, v) => pageAttrs.set(k, String(v)),
    removeAttribute: (k) => pageAttrs.delete(k)
  };
  const bylineChildren = [
    { tagName: 'A', textContent: 'A2O LITE & A2O', dataset: {} },
    { tagName: 'SPAN', textContent: ' • ', dataset: {} },
    { tagName: 'SPAN', textContent: '56M views', dataset: {} },
    { tagName: 'SPAN', textContent: ' • ', dataset: {} },
    { tagName: 'SPAN', textContent: '750K likes', dataset: {} }
  ];
  const bylineEl = { children: bylineChildren };
  const moviePlayer = {
    getVideoData: () => ({ video_id: currentMovieId }),
    getPlayerResponse: () => ({
      videoDetails: {
        videoId: currentMovieId,
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        thumbnail: {
          thumbnails: [
            { url: 'https://lh3.googleusercontent.com/fromResp=w120-h120-l90-rj', width: 120, height: 120 }
          ]
        }
      }
    })
  };

  const env = loadInjectEnv({
    documentMock: {
      hidden: false,
      getElementById: (id) => (id === 'movie_player' ? moviePlayer : null),
      querySelector: (sel) => {
        if (sel === 'ytmusic-player') return playerEl;
        if (sel === 'ytmusic-player-page') return playerPageEl;
        if (sel === 'ytmusic-player #song-image #img' || sel === 'ytmusic-player #song-image img') return songImg;
        if (sel === 'ytmusic-player-bar img.image') return barImg;
        if (sel === 'ytmusic-player-bar yt-formatted-string.byline' || sel === 'ytmusic-player-bar .byline') return bylineEl;
        return null;
      }
    }
  });

  // Hydrate mapping WITHOUT thumb URL to verify fallback to movie_player.getPlayerResponse() thumbnails
  env.win.dispatchEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: {
      entries: [
        {
          o: 'omv_dom_001',
          a: 'atv_dom_001',
          u: ''
        }
      ]
    }
  });

  // Trigger DOMContentLoaded to attach reactive player DOM guard (immediately enforces native ATV mode!)
  env.win.dispatchEvent({ type: 'DOMContentLoaded' });
  const guard = env.observers.find((o) => o._target === playerEl);
  assert.ok(guard, 'expected player DOM guard observer');

  assert.equal(playerEl.getAttribute('playback-mode'), 'ATV_PREFERRED');
  assert.equal(playerEl.hasAttribute('video-mode'), false);
  assert.equal(playerEl.videoMode, false);
  assert.equal(playerPageEl.hasAttribute('video-mode'), false);
  assert.equal(songImg.src, 'https://lh3.googleusercontent.com/fromResp=w544-h544-l90-rj');
  assert.equal(barImg.src, 'https://lh3.googleusercontent.com/fromResp=w544-h544-l90-rj');
  assert.equal(bylineChildren[0].dataset.ytmLiteHiddenStat, undefined, 'artist link must stay visible');
  assert.equal(bylineChildren[1].dataset.ytmLiteHiddenStat, '1', 'bullet before views must be hidden');
  assert.equal(bylineChildren[2].dataset.ytmLiteHiddenStat, '1', 'views stat must be hidden');
  assert.equal(bylineChildren[3].dataset.ytmLiteHiddenStat, '1', 'bullet before likes must be hidden');
  assert.equal(bylineChildren[4].dataset.ytmLiteHiddenStat, '1', 'likes stat must be hidden');

  // Polymer overrides playback-mode back to OMV_PREFERRED after delay -> guard snaps it back to ATV_PREFERRED
  playerEl.setAttribute('playback-mode', 'OMV_PREFERRED');
  playerEl.setAttribute('video-mode', '');
  playerPageEl.setAttribute('video-mode', '');
  guard.trigger();
  assert.equal(playerEl.getAttribute('playback-mode'), 'ATV_PREFERRED');
  assert.equal(playerEl.hasAttribute('video-mode'), false);
  assert.equal(playerPageEl.hasAttribute('video-mode'), false);

  // Polymer resets #song-image img to blank data URI -> songImgObserver restores official square art
  const imgGuard = env.observers.find((o) => o._target === songImg);
  assert.ok(imgGuard, 'expected songImg observer');
  songImg.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  imgGuard.trigger();
  assert.equal(songImg.src, 'https://lh3.googleusercontent.com/fromResp=w544-h544-l90-rj');

  // Polymer re-adds video-mode ONLY on ytmusic-player-page -> page observer strips it
  const pageGuard = env.observers.find((o) => o._target === playerPageEl);
  assert.ok(pageGuard, 'expected ytmusic-player-page observer');
  playerPageEl.setAttribute('video-mode', '');
  pageGuard.trigger();
  assert.equal(playerPageEl.hasAttribute('video-mode'), false);

  // Polymer re-renders byline late after queue jump -> byline observer hides views/likes again
  const bylineGuard = env.observers.find((o) => o._target === bylineEl);
  assert.ok(bylineGuard, 'expected player-bar byline observer');
  delete bylineChildren[1].dataset.ytmLiteHiddenStat;
  delete bylineChildren[2].dataset.ytmLiteHiddenStat;
  bylineGuard.trigger();
  assert.equal(bylineChildren[0].dataset.ytmLiteHiddenStat, undefined);
  assert.equal(bylineChildren[1].dataset.ytmLiteHiddenStat, '1');
  assert.equal(bylineChildren[2].dataset.ytmLiteHiddenStat, '1');

  // If ad starts playing -> guard must NOT touch video-mode or playback-mode
  playerEl.setAttribute('video-mode', '');
  playerEl.setAttribute('playback-mode', 'OMV_PREFERRED');
  playerEl.setAttribute('is-advertisement-playing', '');
  guard.trigger();
  assert.equal(playerEl.hasAttribute('video-mode'), true);
  assert.equal(playerEl.getAttribute('playback-mode'), 'OMV_PREFERRED');

  // If user manually selected Video -> guard must NOT strip video-mode or playback-mode
  playerEl.removeAttribute('is-advertisement-playing');
  env.win.dispatchEvent({ type: 'ytm-lite-manual-video', detail: { videoId: 'atv_dom_001' } });
  guard.trigger();
  assert.equal(playerEl.hasAttribute('video-mode'), true);
  assert.equal(playerEl.getAttribute('playback-mode'), 'OMV_PREFERRED');
});

test('inject.js stays compatible with adblockers: chains existing ytcfg descriptor, cleans up on blocked fetch, and preserves XHR.open arity', async () => {
  let adblockerYtcfgSets = 0;
  let storedYtcfg;
  const env = loadInjectEnv({
    setupWin(win) {
      Object.defineProperty(win, 'ytcfg', {
        configurable: true,
        enumerable: true,
        get() {
          return storedYtcfg;
        },
        set(v) {
          adblockerYtcfgSets += 1;
          storedYtcfg = v;
        }
      });
    },
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch (ERR_BLOCKED_BY_CLIENT)');
    }
  });

  // 1. Existing adblocker ytcfg setter must still be invoked
  env.win.ytcfg = { set() {}, get() { return null; } };
  assert.equal(adblockerYtcfgSets, 1);

  // 2. Blocked /player fetch must clear pending swap-state before rethrowing
  await assert.rejects(
    env.win.fetch('https://music.youtube.com/youtubei/v1/player', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'blk_omv_001', context: {} })
    }),
    /ERR_BLOCKED_BY_CLIENT/
  );
  const swaps = env.dispatched.filter((e) => e.type === 'ytm-lite-swap-state');
  assert.equal(swaps.length, 2);
  assert.equal(swaps[0].detail.pending, true);
  assert.equal(swaps[1].detail.pending, false);

  // 3. XHR.open forwards exact argument count
  const xhr = new env.FakeXMLHttpRequest();
  xhr.open('POST', '/youtubei/v1/player');
  assert.equal(xhr._openArgCount, 2);
});

test('inject.js locks 1:1 aspect ratio, syncs MediaSession art, rejects ytimg playerResponse frames, prefetches on pointerdown, and skips jarring late reload', async () => {
  const playerAttrs = new Map([
    ['video-mode', ''],
    ['playback-mode', 'OMV_PREFERRED']
  ]);
  const styleProps = new Map([['--ytmusic-player-aspect-ratio', '1.777778']]);
  const docListeners = new Map();
  let currentMovieId = 'atv_ux_0001';
  let movieTime = 5.2;
  let movieState = 1;
  const loadCalls = [];
  const searchQueries = [];

  const songImg = {
    src: 'https://lh3.googleusercontent.com/realCover=w120-h120-l90-rj',
    getAttribute: (k) => (k === 'src' ? songImg.src : null),
    setAttribute: (k, v) => {
      if (k === 'src') songImg.src = v;
    }
  };
  const playerEl = {
    videoMode: true,
    style: {
      getPropertyValue: (k) => styleProps.get(k) || '',
      setProperty: (k, v) => styleProps.set(k, String(v)),
      removeProperty: (k) => styleProps.delete(k)
    },
    hasAttribute: (k) => playerAttrs.has(k),
    getAttribute: (k) => (playerAttrs.has(k) ? playerAttrs.get(k) : null),
    setAttribute: (k, v) => playerAttrs.set(k, String(v)),
    removeAttribute: (k) => playerAttrs.delete(k)
  };
  let responseThumbs = [
    { url: 'https://i.ytimg.com/vi/omv_only_01/maxresdefault.jpg', width: 1280, height: 720 }
  ];
  const moviePlayer = {
    getVideoData: () => ({ video_id: currentMovieId }),
    getPlayerResponse: () => ({
      videoDetails: {
        videoId: currentMovieId,
        musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
        thumbnail: { thumbnails: responseThumbs }
      }
    }),
    getCurrentTime: () => movieTime,
    getPlayerState: () => movieState,
    loadVideoById: (arg) => loadCalls.push(arg)
  };

  const mediaSession = {
    metadata: { title: 'Test Song', artist: 'Test Artist', artwork: [] }
  };

  const env = loadInjectEnv({
    navigatorMock: { mediaSession },
    documentMock: {
      hidden: false,
      getElementById: (id) => (id === 'movie_player' ? moviePlayer : null),
      querySelector: (sel) => {
        if (sel === 'ytmusic-player') return playerEl;
        if (sel === 'ytmusic-player #song-image #img' || sel === 'ytmusic-player #song-image img') return songImg;
        return null;
      },
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      }
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : {};
      if (url.includes('/youtubei/v1/browse')) {
        return new env.FakeResponse({
          contents: {
            musicResponsiveListItemRenderer: {
              flexColumns: [
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Prefetch Song' }] } } },
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Prefetch Artist' }] } } }
              ],
              playlistItemData: { videoId: 'omv_ptr_001' },
              navigationEndpoint: {
                watchEndpoint: {
                  videoId: 'omv_ptr_001',
                  watchEndpointMusicSupportedConfigs: {
                    watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
                  }
                }
              }
            }
          }
        });
      }
      if (url.includes('/youtubei/v1/search')) {
        searchQueries.push(body.query);
        return new env.FakeResponse({
          contents: {
            musicResponsiveListItemRenderer: {
              flexColumns: [
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Prefetch Song' }] } } },
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Prefetch Artist' }] } } }
              ],
              playlistItemData: { videoId: 'atv_ptr_001' },
              navigationEndpoint: {
                watchEndpoint: {
                  videoId: 'atv_ptr_001',
                  watchEndpointMusicSupportedConfigs: {
                    watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
                  }
                }
              },
              thumbnail: {
                musicThumbnailRenderer: {
                  thumbnail: {
                    thumbnails: [{ url: 'https://lh3.googleusercontent.com/ptr=w544-h544-l90-rj', width: 544, height: 544 }]
                  }
                }
              }
            }
          }
        });
      }
      return new env.FakeResponse({ ok: true });
    }
  });

  // 1. Hydrate ATV without thumb and verify ytimg-only playerResponse NEVER overwrites existing square art
  env.win.dispatchEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: { entries: [{ o: 'omv_ux_0001', a: 'atv_ux_0001', u: '' }] }
  });
  env.win.dispatchEvent({ type: 'DOMContentLoaded' });
  assert.equal(playerEl.getAttribute('data-ytm-lite-atv'), '1');
  assert.equal(styleProps.get('--ytmusic-player-aspect-ratio'), '1');
  assert.equal(
    songImg.src,
    'https://lh3.googleusercontent.com/realCover=w120-h120-l90-rj',
    'ytimg playerResponse frame must never overwrite square googleusercontent cover'
  );

  // 1b. When playerResponse has googleusercontent art, syncDomCoverArt updates songImg + MediaSession artwork
  responseThumbs = [
    { url: 'https://lh3.googleusercontent.com/officialAlbum=w120-h120-l90-rj', width: 120, height: 120 }
  ];
  playerEl.setAttribute('video-mode', '');
  const guard = env.observers.find((o) => o._target === playerEl);
  guard.trigger();
  assert.equal(songImg.src, 'https://lh3.googleusercontent.com/officialAlbum=w544-h544-l90-rj');
  assert.equal(
    mediaSession.metadata.artwork[0]?.src,
    'https://lh3.googleusercontent.com/officialAlbum=w544-h544-l90-rj'
  );

  // 2. Manual Video clears data-ytm-lite-atv and inline --ytmusic-player-aspect-ratio
  env.win.dispatchEvent({ type: 'ytm-lite-manual-video', detail: { videoId: 'atv_ux_0001' } });
  assert.equal(playerEl.hasAttribute('data-ytm-lite-atv'), false);
  assert.equal(styleProps.has('--ytmusic-player-aspect-ratio'), false);

  // 3. Browse registers OMV metadata, then pointerdown on track row prefetches ATV immediately
  await env.win.fetch('https://music.youtube.com/youtubei/v1/browse', {
    method: 'POST',
    body: JSON.stringify({ browseId: 'FEmusic_home', context: {} })
  });
  const fakeAnchor = { getAttribute: (k) => (k === 'href' ? 'watch?v=omv_ptr_001&list=RD1' : null) };
  const fakeRow = { querySelector: () => fakeAnchor };
  const fakeTarget = { closest: () => fakeRow };
  for (const fn of docListeners.get('pointerdown') || []) {
    fn({ target: fakeTarget });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(searchQueries.length >= 1, 'pointerdown on known OMV row must prefetch ATV');
});

test('inject.js keeps /browse non-blocking, prefetches Track 3 when advancing to Track 2 via /player, and extracts hover videoId from Polymer/ytimg', async () => {
  const searchQueries = [];
  const docListeners = new Map();
  const timers = [];

  const env = loadInjectEnv({
    documentMock: {
      hidden: false,
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      }
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init?.body ? JSON.parse(init.body) : {};

      if (url.includes('/youtubei/v1/browse') && body.browseId === 'FEmusic_album') {
        return new env.FakeResponse({
          contents: {
            musicResponsiveListItemRenderer: {
              flexColumns: [
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Album Track' }] } } },
                { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Album Artist' }] } } }
              ],
              playlistItemData: { videoId: 'omv_alb_001' },
              navigationEndpoint: {
                watchEndpoint: {
                  videoId: 'omv_alb_001',
                  playlistId: 'OLAK5uy_slowbrowse1',
                  watchEndpointMusicSupportedConfigs: {
                    watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
                  }
                }
              }
            }
          }
        });
      }

      if (url.includes('/youtubei/v1/browse') && body.browseId?.startsWith('VLOLAK5uy_')) {
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve(new env.FakeResponse({})), 1200);
          t.unref();
          timers.push(t);
        });
      }

      if (url.includes('/youtubei/v1/next')) {
        return new env.FakeResponse({
          contents: [
            {
              playlistPanelVideoRenderer: {
                videoId: 'atv_qtr_001',
                selected: true,
                title: { runs: [{ text: 'Track One' }] },
                longBylineText: { runs: [{ text: 'Artist Q' }] },
                navigationEndpoint: {
                  watchEndpoint: {
                    videoId: 'atv_qtr_001',
                    watchEndpointMusicSupportedConfigs: {
                      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
                    }
                  }
                }
              }
            },
            {
              playlistPanelVideoRenderer: {
                videoId: 'atv_qtr_002',
                selected: false,
                title: { runs: [{ text: 'Track Two' }] },
                longBylineText: { runs: [{ text: 'Artist Q' }] },
                navigationEndpoint: {
                  watchEndpoint: {
                    videoId: 'atv_qtr_002',
                    watchEndpointMusicSupportedConfigs: {
                      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
                    }
                  }
                }
              }
            },
            {
              playlistPanelVideoRenderer: {
                videoId: 'omv_qtr_003',
                selected: false,
                title: { runs: [{ text: 'Track Three' }] },
                longBylineText: { runs: [{ text: 'Artist Q' }] },
                navigationEndpoint: {
                  watchEndpoint: {
                    videoId: 'omv_qtr_003',
                    watchEndpointMusicSupportedConfigs: {
                      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
                    }
                  }
                }
              }
            }
          ]
        });
      }

      if (url.includes('/youtubei/v1/search')) {
        searchQueries.push(body.query);
        if (String(body.query || '').includes('Track Three')) {
          return new env.FakeResponse({
            contents: {
              musicResponsiveListItemRenderer: {
                flexColumns: [
                  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Track Three' }] } } },
                  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist Q' }] } } }
                ],
                playlistItemData: { videoId: 'atv_qtr_003' },
                navigationEndpoint: {
                  watchEndpoint: {
                    videoId: 'atv_qtr_003',
                    watchEndpointMusicSupportedConfigs: {
                      watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
                    }
                  }
                }
              }
            }
          });
        }
        return new env.FakeResponse({});
      }

      return new env.FakeResponse({ ok: true });
    }
  });

  try {
    // 1. /browse must return fast (<400ms) even when VL fetch stalls for 1200ms
    const t0 = Date.now();
    const browseRes = await env.win.fetch('https://music.youtube.com/youtubei/v1/browse', {
      method: 'POST',
      body: JSON.stringify({ browseId: 'FEmusic_album', context: {} })
    });
    const browseElapsed = Date.now() - t0;
    assert.equal(browseRes.ok, true);
    assert.ok(browseElapsed < 400, `expected fast non-blocking /browse (<400ms), got ${browseElapsed}ms`);

    // 2. Load 3-track queue via /next (Track 1 active), then advance to Track 2 via /player only
    await env.win.fetch('https://music.youtube.com/youtubei/v1/next', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'atv_qtr_001', context: {} })
    });
    await env.win.fetch('https://music.youtube.com/youtubei/v1/player', {
      method: 'POST',
      body: JSON.stringify({ videoId: 'atv_qtr_002', context: {} })
    });

    // Wait past 350ms settle -> Track 3 gets pre-warmed automatically
    await new Promise((r) => setTimeout(r, 430));
    assert.ok(
      searchQueries.some((q) => q.includes('Track Three')),
      'advancing to Track 2 via /player must prefetch upcoming Track 3'
    );

    // 3. Hovering a queue row with Polymer data (no <a> href) prefetches known OMV after 120ms debounce
    const hoverRow = {
      querySelector: () => null,
      data: { videoId: 'omv_alb_001' }
    };
    const hoverTarget = { closest: () => hoverRow };
    for (const fn of docListeners.get('pointerover') || []) {
      fn({ target: hoverTarget });
    }
    await new Promise((r) => setTimeout(r, 170));
    assert.ok(
      searchQueries.some((q) => q.includes('Album Track')),
      'pointerover on Polymer queue row must prefetch known OMV'
    );
  } finally {
    env.win.dispatchEvent({ type: 'ytm-lite-settings', detail: { enabled: false } });
    for (const t of timers) clearTimeout(t);
  }
});
