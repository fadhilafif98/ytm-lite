'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement(tagName, { attrs = {}, dataset = {}, children = {}, closestMap = {} } = {}) {
  const listeners = new Map();
  const attrMap = new Map(Object.entries(attrs));
  const el = {
    tagName: tagName.toUpperCase(),
    isConnected: true,
    dataset: { ...dataset },
    clicks: 0,
    hasAttribute: (k) => attrMap.has(k),
    getAttribute: (k) => (attrMap.has(k) ? attrMap.get(k) : null),
    setAttribute: (k, v) => attrMap.set(k, String(v)),
    removeAttribute: (k) => attrMap.delete(k),
    querySelector: (sel) => children[sel] || null,
    closest: (sel) => closestMap[sel] || null,
    click() {
      this.clicks += 1;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
  return el;
}

async function loadContentEnv({
  initialSync = { enabled: true, hideVideoFallback: true },
  initialLocal = {},
  locationSearch = '?v=omv_trk_001',
  selectors = {}
} = {}) {
  const distDir = path.join(__dirname, '..', 'dist');
  const sessionMap = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const dispatched = [];
  const storageOnChangedListeners = [];
  const observers = [];
  const pendingTimers = new Set();

  let syncStore = { ...initialSync };
  let localStore = { ...initialLocal };
  let runtimeId = 'test-ext-id';

  const classSet = new Set();
  const documentElement = {
    classList: {
      toggle(cls, force) {
        if (force) classSet.add(cls);
        else classSet.delete(cls);
      },
      contains: (cls) => classSet.has(cls)
    }
  };

  class FakeElement {}
  for (const el of Object.values(selectors)) {
    if (el && typeof el === 'object') Object.setPrototypeOf(el, FakeElement.prototype);
  }

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

  const win = {
    location: { origin: 'https://music.youtube.com', search: locationSearch },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      dispatched.push(ev);
      for (const fn of [...(winListeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
    listenerCount(type) {
      return (winListeners.get(type) || []).length;
    }
  };

  const doc = {
    hidden: false,
    documentElement,
    body: makeElement('body'),
    querySelector: (sel) => selectors[sel] || null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      for (const fn of [...(docListeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    }
  };

  const chrome = {
    runtime: {
      get id() {
        return runtimeId;
      }
    },
    storage: {
      sync: {
        async get(defaults) {
          return { ...defaults, ...syncStore };
        },
        async set(obj) {
          syncStore = { ...syncStore, ...obj };
        }
      },
      local: {
        async get(key) {
          return { [key]: localStore[key] };
        },
        async set(obj) {
          localStore = { ...localStore, ...obj };
        },
        async remove(key) {
          delete localStore[key];
        }
      },
      onChanged: {
        addListener(fn) {
          storageOnChangedListeners.push(fn);
        },
        removeListener(fn) {
          const idx = storageOnChangedListeners.indexOf(fn);
          if (idx >= 0) storageOnChangedListeners.splice(idx, 1);
        }
      }
    }
  };

  const trackedSetTimeout = (fn, ms) => {
    const id = setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    id.unref();
    pendingTimers.add(id);
    return id;
  };
  const trackedClearTimeout = (id) => {
    pendingTimers.delete(id);
    clearTimeout(id);
  };

  const sandbox = {
    window: win,
    document: doc,
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    chrome,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    sessionStorage: {
      getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
      setItem: (k, v) => sessionMap.set(k, String(v)),
      removeItem: (k) => sessionMap.delete(k)
    },
    URLSearchParams,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    requestAnimationFrame: (fn) => fn(),
    cancelAnimationFrame: () => {},
    console,
    Promise,
    Map,
    Set,
    Array,
    Object,
    JSON,
    Date,
    Math,
    Number,
    String,
    Boolean,
    RegExp
  };

  const code = fs.readFileSync(path.join(distDir, 'content/content.js'), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'dist/content/content.js' });

  // Allow init() microtasks to finish
  await new Promise((r) => setTimeout(r, 20));

  return {
    win,
    doc,
    Element: FakeElement,
    classSet,
    dispatched,
    observers,
    storageOnChangedListeners,
    getLocalStore: () => localStore,
    invalidateContext: () => {
      runtimeId = '';
    },
    emitStorageChange(changes, areaName) {
      for (const fn of [...storageOnChangedListeners]) fn(changes, areaName);
    },
    cleanup() {
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
    }
  };
}

function toHostJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test('content.js validates untrusted ytm-lite-cache-put events and prunes expired/overflow entries', async () => {
  const now = Date.now();
  const expiredTs = now - 31 * 24 * 60 * 60 * 1000;
  const initialCache = {
    omv_exp_001: { a: 'atv_exp_001', u: 'https://lh3.googleusercontent.com/old', t: expiredTs },
    omv_ok_0001: { a: 'atv_ok_0001', u: 'https://lh3.googleusercontent.com/good', t: now - 1000 },
    constructor: { a: 'atv_bad_001', u: '', t: now }
  };

  const env = await loadContentEnv({
    initialLocal: { ytmLiteCacheV2: initialCache }
  });

  try {
    // Hydration broadcast should include only valid, non-expired entry
    const hydrate = env.dispatched.find((e) => e.type === 'ytm-lite-cache-hydrate');
    assert.ok(hydrate);
    assert.deepEqual(toHostJson(hydrate.detail.entries), [
      { o: 'omv_ok_0001', a: 'atv_ok_0001', u: 'https://lh3.googleusercontent.com/good' }
    ]);

    // Untrusted malicious events must be ignored or sanitized
    env.win.dispatchEvent({
      type: 'ytm-lite-cache-put',
      detail: { omvId: 'constructor', atvId: 'atv_evil_01', thumbUrl: 'https://lh3.googleusercontent.com/x' }
    });
    env.win.dispatchEvent({
      type: 'ytm-lite-cache-put',
      detail: { omvId: 'short', atvId: 'atv_evil_02', thumbUrl: '' }
    });
    env.win.dispatchEvent({
      type: 'ytm-lite-cache-put',
      detail: { omvId: 'omv_same_01', atvId: 'omv_same_01', thumbUrl: '' }
    });
    env.win.dispatchEvent({
      type: 'ytm-lite-cache-put',
      detail: {
        omvId: 'omv_new_001',
        atvId: 'atv_new_001',
        thumbUrl: 'https://evil-googleusercontent.com/phish.jpg'
      }
    });

    // Wait for 500ms cache flush debounce
    await new Promise((r) => setTimeout(r, 560));

    const persisted = env.getLocalStore().ytmLiteCacheV2;
    assert.equal(Object.getPrototypeOf(persisted), null, 'persisted cache must use null prototype');
    assert.equal(Object.hasOwn(persisted, 'constructor'), false);
    assert.equal(Object.hasOwn(persisted, 'short'), false);
    assert.equal(Object.hasOwn(persisted, 'omv_same_01'), false);
    assert.equal(Object.hasOwn(persisted, 'omv_exp_001'), false);
    assert.equal(persisted.omv_new_001.a, 'atv_new_001');
    assert.equal(persisted.omv_new_001.u, '', 'lookalike thumb URL must be stripped');
  } finally {
    env.cleanup();
  }
});

test('content.js evicts oldest entries when cache exceeds 2500 limit', async () => {
  const now = Date.now();
  const initialCache = {};
  for (let i = 0; i < 2505; i++) {
    const pad = String(i).padStart(7, '0');
    initialCache[`omv_${pad}`] = { a: `atv_${pad}`, u: '', t: now - (3000 - i) * 1000 };
  }

  const env = await loadContentEnv({
    initialLocal: { ytmLiteCacheV2: initialCache }
  });

  try {
    const hydrate = env.dispatched.find((e) => e.type === 'ytm-lite-cache-hydrate');
    assert.ok(hydrate);
    assert.equal(hydrate.detail.entries.length, 2500);
    const ids = new Set(hydrate.detail.entries.map((e) => e.o));
    assert.equal(ids.has('omv_0000000'), false, 'oldest entry must be evicted');
    assert.equal(ids.has('omv_0000004'), false, '5th oldest entry must be evicted');
    assert.equal(ids.has('omv_0000005'), true, '6th oldest entry must be kept');
    assert.equal(ids.has('omv_0002504'), true, 'newest entry must be kept');
  } finally {
    env.cleanup();
  }
});

test('content.js merges cross-tab storage.onChanged additions and broadcasts cache clear', async () => {
  const now = Date.now();
  const env = await loadContentEnv({
    initialLocal: {
      ytmLiteCacheV2: {
        omv_tab1_01: { a: 'atv_tab1_01', u: '', t: now }
      }
    }
  });

  try {
    env.dispatched.length = 0;

    // Simulate another tab writing an additional mapping
    env.emitStorageChange(
      {
        ytmLiteCacheV2: {
          newValue: {
            omv_tab1_01: { a: 'atv_tab1_01', u: '', t: now },
            omv_tab2_02: {
              a: 'atv_tab2_02',
              u: 'https://lh3.googleusercontent.com/tab2=w544-h544',
              t: now
            },
            __proto__: { a: 'atv_bad_002', u: '', t: now }
          }
        }
      },
      'local'
    );

    const hydrateEvents = env.dispatched.filter((e) => e.type === 'ytm-lite-cache-hydrate');
    assert.equal(hydrateEvents.length, 1);
    assert.deepEqual(toHostJson(hydrateEvents[0].detail.entries), [
      {
        o: 'omv_tab2_02',
        a: 'atv_tab2_02',
        u: 'https://lh3.googleusercontent.com/tab2=w544-h544'
      }
    ]);

    // Simulate clearing cache from popup
    env.emitStorageChange({ ytmLiteCacheV2: { newValue: undefined } }, 'local');
    const clearEvents = env.dispatched.filter((e) => e.type === 'ytm-lite-cache-clear');
    assert.equal(clearEvents.length, 1);
  } finally {
    env.cleanup();
  }
});

test('content.js respects manual Video toggle, skips ads, and cleans up on context invalidation', async () => {
  const songBtn = makeElement('button');
  const videoBtn = makeElement('button');
  videoBtn.closest = (sel) => (sel === 'ytmusic-av-toggle .video-button' ? videoBtn : null);
  const toggleEl = makeElement('ytmusic-av-toggle', {
    attrs: { 'playback-mode': 'OMV_PREFERRED' },
    children: { '.song-button': songBtn }
  });
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '' }
  });
  const videoEl = makeElement('video');

  const env = await loadContentEnv({
    locationSearch: '?v=omv_trk_001',
    selectors: {
      'ytmusic-av-toggle': toggleEl,
      'ytmusic-player': playerEl,
      'ytmusic-player video': videoEl
    }
  });
  Object.setPrototypeOf(videoBtn, env.Element.prototype);

  try {
    // Untrusted click must be ignored
    env.doc.dispatchEvent({ type: 'click', isTrusted: false, target: videoBtn });

    // 1. Trusted user click on Video button disables switching for current track
    env.doc.dispatchEvent({ type: 'click', isTrusted: true, target: videoBtn });
    await new Promise((r) => setTimeout(r, 340));
    assert.equal(songBtn.clicks, 0, 'must not auto-switch after manual Video selection');
    assert.equal(env.classSet.has('ytm-lite-hide-video'), false);

    // 2. Switching to a new track resumes auto-switching (unless ad is playing)
    env.win.location.search = '?v=omv_trk_002';
    playerEl.setAttribute('is-advertisement-playing', '');
    env.win.dispatchEvent({ type: 'yt-navigate-finish' });
    await new Promise((r) => setTimeout(r, 290));
    assert.equal(songBtn.clicks, 0, 'must not click song button during ads');
    assert.equal(env.classSet.has('ytm-lite-hide-video'), false);

    // 3. Ad finishes -> song button gets clicked
    playerEl.removeAttribute('is-advertisement-playing');
    env.win.dispatchEvent({ type: 'yt-navigate-finish' });
    await new Promise((r) => setTimeout(r, 290));
    assert.equal(songBtn.clicks, 1);

    // 4. Context invalidation removes listeners, disconnects observers, and clears stuck hiding classes
    env.classSet.add('ytm-lite-swap-pending');
    env.classSet.add('ytm-lite-hide-video');
    env.invalidateContext();
    env.win.dispatchEvent({ type: 'ytm-lite-cache-ready' });
    assert.equal(env.classSet.has('ytm-lite-swap-pending'), false);
    assert.equal(env.classSet.has('ytm-lite-hide-video'), false);
    assert.equal(env.win.listenerCount('yt-navigate-finish'), 0);
    assert.equal(env.win.listenerCount('ytm-lite-cache-put'), 0);
    assert.equal(videoEl.listenerCount('play'), 0);
    assert.equal(videoEl.listenerCount('loadedmetadata'), 0);
    assert.equal(env.storageOnChangedListeners.length, 0);
    assert.ok(env.observers.every((o) => o.disconnected));
  } finally {
    env.cleanup();
  }
});

test('content.js falls back to DEFAULTS when sync keys are removed and ignores unsafe swap-state videoIds', async () => {
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '' }
  });
  const songImg = makeElement('img', { attrs: { src: '' } });

  const env = await loadContentEnv({
    initialSync: { enabled: false, hideVideoFallback: false },
    locationSearch: '?v=omv_def_001',
    selectors: {
      'ytmusic-player': playerEl,
      'ytmusic-player #song-image img': songImg
    }
  });

  try {
    env.dispatched.length = 0;

    // Removing keys from chrome.storage.sync emits newValue: undefined -> must restore DEFAULTS (true)
    env.emitStorageChange(
      {
        enabled: { oldValue: false, newValue: undefined },
        hideVideoFallback: { oldValue: false, newValue: undefined }
      },
      'sync'
    );
    const settingsEvent = env.dispatched.find((e) => e.type === 'ytm-lite-settings');
    assert.ok(settingsEvent);
    assert.equal(settingsEvent.detail.enabled, true);
    assert.equal(settingsEvent.detail.hideVideoFallback, true);

    // Unsafe videoId in swap-state must not poison fallback ytimg URL
    env.win.location.search = '';
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: false, videoId: 'constructor', isAtv: false }
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(songImg.getAttribute('src'), '');
  } finally {
    env.cleanup();
  }
});

test('content.js handles rapid skips without 600ms cooldown blocking next song or 16:9 flash, and syncs cover when bar img updates', async () => {
  const songBtn = makeElement('button');
  const toggleEl = makeElement('ytmusic-av-toggle', {
    attrs: { 'playback-mode': 'OMV_PREFERRED' },
    children: { '.song-button': songBtn }
  });
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '' }
  });
  const songImg = makeElement('img', {
    attrs: { src: 'https://i.ytimg.com/vi/omv_skp_001/hqdefault.jpg' }
  });
  const barImg = makeElement('img', {
    attrs: { src: 'https://lh3.googleusercontent.com/songA=w120-h120-l90-rj' }
  });

  const env = await loadContentEnv({
    locationSearch: '?v=omv_skp_001',
    selectors: {
      'ytmusic-av-toggle': toggleEl,
      'ytmusic-player': playerEl,
      'ytmusic-player #song-image img': songImg,
      'ytmusic-player-bar img.image': barImg
    }
  });

  try {
    // Wait for initial evaluate on Track 1
    await new Promise((r) => setTimeout(r, 340));
    assert.equal(songBtn.clicks, 1, 'Track 1 should click song button');
    assert.equal(
      env.classSet.has('ytm-lite-hide-video'),
      true,
      'square fallback must stay active while YTM transitions out of video-mode (no 16:9 flash)'
    );
    assert.equal(
      songImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/songA=w544-h544-l90-rj'
    );

    // Immediately skip to Track 2 (<600ms after Track 1 click!)
    env.win.location.search = '?v=omv_skp_002';
    env.win.dispatchEvent({ type: 'yt-navigate-finish' });
    await new Promise((r) => setTimeout(r, 170));
    assert.equal(songBtn.clicks, 2, 'Track 2 must not be skipped by Track 1 cooldown');

    // Simulate Polymer updating player-bar cover art late -> barImgObserver syncs #song-image immediately
    barImg.setAttribute('src', 'https://lh3.googleusercontent.com/songB=w120-h120-l90-rj');
    const barObserver = env.observers.find((o) => o._target === barImg);
    assert.ok(barObserver, 'expected barImg observer');
    barObserver.trigger();
    assert.equal(
      songImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/songB=w544-h544-l90-rj'
    );
  } finally {
    env.cleanup();
  }
});

test('content.js prevents 0:00 MV thumbnail blip during swap-pending and prefers selected queue square art', async () => {
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '' }
  });
  const songImg = makeElement('img', {
    attrs: { src: 'https://i.ytimg.com/vi/gQlMMD8auMs/sddefault.jpg' }
  });
  const barImg = makeElement('img', {
    attrs: { src: 'https://i.ytimg.com/vi/gQlMMD8auMs/sddefault.jpg' }
  });
  const queueImg = makeElement('img', {
    attrs: { src: 'https://lh3.googleusercontent.com/bornpink=w120-h120-l90-rj' }
  });

  const env = await loadContentEnv({
    locationSearch: '?v=gQlMMD8auMs',
    selectors: {
      'ytmusic-player': playerEl,
      'ytmusic-player #song-image img': songImg,
      'ytmusic-player-bar img.image': barImg,
      'ytmusic-player-queue-item[selected] img': queueImg
    }
  });

  try {
    // 1. When swap starts pending and selected queue row has square art, both songImg and barImg get square art immediately
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: true, videoId: 'gQlMMD8auMs' }
    });
    assert.equal(env.classSet.has('ytm-lite-swap-pending'), true);
    assert.equal(env.classSet.has('ytm-lite-hide-video'), true);
    assert.equal(
      songImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/bornpink=w544-h544-l90-rj'
    );
    assert.equal(
      barImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/bornpink=w544-h544-l90-rj'
    );

    // 2. When NO square art exists yet during swap-pending, do NOT copy ytimg.com MV frame into #song-image
    queueImg.setAttribute('src', '');
    barImg.setAttribute('src', 'https://i.ytimg.com/vi/cold_mv_001/sddefault.jpg');
    songImg.setAttribute('src', '');
    env.win.location.search = '?v=cold_mv_001';
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: true, videoId: 'cold_mv_001' }
    });
    assert.equal(songImg.getAttribute('src'), '', 'must not paint 16:9 ytimg MV frame during pending swap');

    // 3. Clearing swap-pending removes ytm-lite-swap-pending class
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: false, videoId: 'cold_mv_001' }
    });
    assert.equal(env.classSet.has('ytm-lite-swap-pending'), false);
  } finally {
    env.cleanup();
  }
});

test('content.js clears hide-video on queue-jumped ATV even when toggle stays OMV_PREFERRED, and ignores stale previous-track art', async () => {
  const songBtn = makeElement('button');
  const toggleEl = makeElement('ytmusic-av-toggle', {
    attrs: { 'playback-mode': 'OMV_PREFERRED' },
    children: { '.song-button': songBtn }
  });
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '' }
  });
  const songImg = makeElement('img', { attrs: { src: '' } });
  const barImg = makeElement('img', {
    attrs: { src: 'https://lh3.googleusercontent.com/prevSong=w120-h120-l90-rj' }
  });

  const env = await loadContentEnv({
    locationSearch: '?v=prev_trk_01',
    selectors: {
      'ytmusic-av-toggle': toggleEl,
      'ytmusic-player': playerEl,
      'ytmusic-player #song-image img': songImg,
      'ytmusic-player-bar img.image': barImg
    }
  });

  try {
    // 1. Jump to a cold queue song while barImg still holds previous song's googleusercontent cover
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: true, videoId: 'omv_qjump_1' }
    });
    assert.equal(env.classSet.has('ytm-lite-swap-pending'), true);
    assert.equal(
      songImg.getAttribute('src'),
      '',
      'must not copy stale previous-track googleusercontent cover onto new pending track'
    );

    // 2. While ytmusic-player still has playback-mode=OMV_PREFERRED (even without video-mode), fallback stays active
    playerEl.removeAttribute('video-mode');
    playerEl.setAttribute('playback-mode', 'OMV_PREFERRED');
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: false, videoId: 'atv_qjump_1', isAtv: true }
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(env.classSet.has('ytm-lite-hide-video'), true);

    // 3. Once inject.ts sets ytmusic-player playback-mode=ATV_PREFERRED, content.ts hands off to native audio layout
    playerEl.setAttribute('playback-mode', 'ATV_PREFERRED');
    const playerGuard = env.observers.find((o) => o._target === playerEl);
    assert.ok(playerGuard, 'expected ytmusic-player observer');
    playerGuard.trigger();
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(env.classSet.has('ytm-lite-swap-pending'), false);
    assert.equal(
      env.classSet.has('ytm-lite-hide-video'),
      false,
      'must let native audio layout render once ATV is active and playback-mode=ATV_PREFERRED'
    );
    assert.equal(songBtn.clicks, 0, 'must not click song button when inject.ts already swapped to ATV');
  } finally {
    env.cleanup();
  }
});

test('content.js blocks stale previous-track cover after swap-pending ends and clears data-ytm-lite-atv on manual Video', async () => {
  const styleProps = new Map([['--ytmusic-player-aspect-ratio', '1']]);
  const videoBtn = makeElement('button');
  videoBtn.closest = (sel) => (sel === 'ytmusic-av-toggle .video-button' ? videoBtn : null);
  const playerEl = makeElement('ytmusic-player', {
    attrs: { 'video-mode': '', 'data-ytm-lite-atv': '1' }
  });
  playerEl.style = {
    getPropertyValue: (k) => styleProps.get(k) || '',
    removeProperty: (k) => styleProps.delete(k)
  };
  const songImg = makeElement('img', {
    attrs: { src: 'https://lh3.googleusercontent.com/trackB=w544-h544-l90-rj' }
  });
  const barImg = makeElement('img', {
    attrs: { src: 'https://lh3.googleusercontent.com/trackA=w120-h120-l90-rj' }
  });

  const env = await loadContentEnv({
    locationSearch: '?v=omv_trka_01',
    selectors: {
      'ytmusic-player': playerEl,
      'ytmusic-player #song-image img': songImg,
      'ytmusic-player-bar img.image': barImg
    }
  });
  Object.setPrototypeOf(videoBtn, env.Element.prototype);

  try {
    // 1. Switch to Track B while barImg still holds Track A's cover
    env.win.dispatchEvent({
      type: 'ytm-lite-swap-state',
      detail: { pending: false, videoId: 'omv_trkb_02', isAtv: false }
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      songImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/trackB=w544-h544-l90-rj',
      'stale previous-track barImg must not overwrite new track cover even after swap-pending ends'
    );

    // 2. Once barImg updates to Track B's real cover, barImgObserver clears stale guard and syncs
    barImg.setAttribute('src', 'https://lh3.googleusercontent.com/trackBNew=w120-h120-l90-rj');
    const barObserver = env.observers.find((o) => o._target === barImg);
    assert.ok(barObserver);
    barObserver.trigger();
    assert.equal(
      songImg.getAttribute('src'),
      'https://lh3.googleusercontent.com/trackBNew=w544-h544-l90-rj'
    );

    // 3. Trusted manual Video click clears data-ytm-lite-atv and inline --ytmusic-player-aspect-ratio
    env.doc.dispatchEvent({ type: 'click', isTrusted: true, target: videoBtn });
    assert.equal(playerEl.hasAttribute('data-ytm-lite-atv'), false);
    assert.equal(styleProps.has('--ytmusic-player-aspect-ratio'), false);
  } finally {
    env.cleanup();
  }
});
