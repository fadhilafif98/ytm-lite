const DEFAULTS = {
  enabled: true,
  hideVideoFallback: true
};
const LOCAL_CACHE_KEY = 'ytmLiteCacheV2';
const THEME_STORAGE_KEY = 'ytm-lite-color-scheme';
const MAX_PERSISTENT_ENTRIES = 2500;

const enabledToggle = document.getElementById('enabledToggle');
const fallbackToggle = document.getElementById('fallbackToggle');
const fallbackRow = document.getElementById('fallbackRow');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const playbackModeMeta = document.getElementById('playbackModeMeta');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');

const cacheBadge = document.getElementById('cacheBadge');
const cacheBadgeText = document.getElementById('cacheBadgeText');
const cacheCountEl = document.getElementById('cacheCount');
const cachePercentEl = document.getElementById('cachePercent');
const cacheProgress = document.getElementById('cacheProgress');
const cacheSizeEl = document.getElementById('cacheSize');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const clearCacheLabel = document.getElementById('clearCacheLabel');
const extVersionEl = document.getElementById('extVersion');

let clearFeedbackTimer = null;

function formatBytes(bytes) {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  const kb = safe / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function getSystemScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getRenderedScheme() {
  const metaVal = colorSchemeMeta?.content;
  if (metaVal === 'light' || metaVal === 'dark') return metaVal;
  return getSystemScheme();
}

function applyThemeOverride(scheme) {
  if (!colorSchemeMeta) return;
  colorSchemeMeta.content = scheme === 'light' || scheme === 'dark' ? scheme : 'light dark';
}

function toggleColorScheme() {
  const target = getRenderedScheme() === 'dark' ? 'light' : 'dark';
  const system = getSystemScheme();

  if (target === system) {
    try {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    applyThemeOverride(null);
  } else {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, target);
    } catch {
      // Ignore storage errors
    }
    applyThemeOverride(target);
  }
}

function updateUI(settings) {
  const isEnabled = Boolean(settings.enabled);
  enabledToggle.checked = isEnabled;
  fallbackToggle.checked = Boolean(settings.hideVideoFallback);
  fallbackToggle.disabled = !isEnabled;

  fallbackRow.classList.toggle('is-disabled', !isEnabled);
  statusBadge.classList.toggle('is-off', !isEnabled);
  statusText.textContent = isEnabled ? 'Active' : 'Paused';
  playbackModeMeta.textContent = isEnabled ? 'Album audio preferred' : 'Standard YouTube Music';
}

function updateCacheUI(count, bytes = 0) {
  const safeCount = Math.max(0, Number(count) || 0);
  const clampedCount = Math.min(MAX_PERSISTENT_ENTRIES, safeCount);
  const ratio = clampedCount / MAX_PERSISTENT_ENTRIES;
  const pct = safeCount > 0 ? Math.max(1, Math.round(ratio * 100)) : 0;

  cacheCountEl.textContent = `${safeCount.toLocaleString()} / ${MAX_PERSISTENT_ENTRIES.toLocaleString()}`;
  cachePercentEl.textContent = `${pct}%`;
  cacheProgress.max = MAX_PERSISTENT_ENTRIES;
  cacheProgress.value = clampedCount;
  cacheSizeEl.textContent = `${formatBytes(bytes)} local`;

  const isWarning = ratio >= 0.8;
  cacheProgress.classList.toggle('is-warning', isWarning);

  if (safeCount === 0) {
    cacheBadge.dataset.state = 'empty';
    cacheBadgeText.textContent = 'Empty';
  } else if (isWarning) {
    cacheBadge.dataset.state = 'warning';
    cacheBadgeText.textContent = 'Near limit';
  } else {
    cacheBadge.dataset.state = 'active';
    cacheBadgeText.textContent = 'Healthy';
  }

  clearCacheBtn.disabled = safeCount === 0;
}

async function readCacheStats() {
  const [storedLocal, bytes] = await Promise.all([
    chrome.storage.local.get(LOCAL_CACHE_KEY),
    chrome.storage.local.getBytesInUse
      ? chrome.storage.local.getBytesInUse(LOCAL_CACHE_KEY)
      : Promise.resolve(0)
  ]);
  const cacheObj = storedLocal?.[LOCAL_CACHE_KEY];
  const count = cacheObj && typeof cacheObj === 'object' ? Object.keys(cacheObj).length : 0;
  return { count, bytes: Number(bytes) || 0 };
}

async function init() {
  try {
    const version = chrome?.runtime?.getManifest?.()?.version;
    if (version && extVersionEl) {
      extVersionEl.textContent = `v${version}`;
    } else if (extVersionEl) {
      extVersionEl.textContent = 'v1.0.0';
    }
  } catch {
    if (extVersionEl) extVersionEl.textContent = 'v1.0.0';
  }

  try {
    const [storedSync, cacheStats] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      readCacheStats()
    ]);
    updateUI(storedSync);
    updateCacheUI(cacheStats.count, cacheStats.bytes);
  } catch (err) {
    console.error('[YTM Lite] Failed to load settings:', err);
    updateUI(DEFAULTS);
    updateCacheUI(0, 0);
  } finally {
    delete document.body.dataset.loading;
  }
}

themeToggleBtn.addEventListener('click', toggleColorScheme);

window.addEventListener('storage', (event) => {
  if (event.key === THEME_STORAGE_KEY) {
    applyThemeOverride(event.newValue);
  }
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  if (clearFeedbackTimer !== null) {
    clearTimeout(clearFeedbackTimer);
    clearFeedbackTimer = null;
  }
  try {
    await chrome.storage.local.remove(LOCAL_CACHE_KEY);
    updateCacheUI(0, 0);
    clearCacheLabel.textContent = 'Cleared';
    clearFeedbackTimer = setTimeout(() => {
      clearFeedbackTimer = null;
      clearCacheLabel.textContent = 'Clear cache';
    }, 1400);
  } catch (err) {
    console.error('[YTM Lite] Failed to clear cache:', err);
    clearCacheBtn.disabled = false;
  }
});

enabledToggle.addEventListener('change', async () => {
  const next = {
    enabled: enabledToggle.checked,
    hideVideoFallback: fallbackToggle.checked
  };
  updateUI(next);
  try {
    await chrome.storage.sync.set({ enabled: next.enabled });
  } catch (err) {
    console.error('[YTM Lite] Failed to save enabled state:', err);
  }
});

fallbackToggle.addEventListener('change', async () => {
  try {
    await chrome.storage.sync.set({ hideVideoFallback: fallbackToggle.checked });
  } catch (err) {
    console.error('[YTM Lite] Failed to save fallback state:', err);
  }
});

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName === 'local' && changes[LOCAL_CACHE_KEY]) {
      try {
        const stats = await readCacheStats();
        updateCacheUI(stats.count, stats.bytes);
      } catch (err) {
        console.error('[YTM Lite] Failed to refresh cache stats:', err);
      }
    }
  });
}

init();
