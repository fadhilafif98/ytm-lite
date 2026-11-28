import { DEFAULTS, LOCAL_CACHE_KEY, MAX_PERSISTENT_ENTRIES } from '../shared/constants';

(() => {
  const THEME_STORAGE_KEY = 'ytm-lite-color-scheme';

  function mustEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`[YTM Lite] Missing popup element: #${id}`);
    }
    return el as T;
  }

  const enabledToggle = mustEl<HTMLInputElement>('enabledToggle');
  const fallbackToggle = mustEl<HTMLInputElement>('fallbackToggle');
  const fallbackRow = mustEl<HTMLElement>('fallbackRow');
  const statusBadge = mustEl<HTMLElement>('statusBadge');
  const statusText = mustEl<HTMLElement>('statusText');
  const playbackModeMeta = mustEl<HTMLElement>('playbackModeMeta');
  const themeToggleBtn = mustEl<HTMLButtonElement>('themeToggleBtn');
  const colorSchemeMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');

  const cacheBadge = mustEl<HTMLElement>('cacheBadge');
  const cacheBadgeText = mustEl<HTMLElement>('cacheBadgeText');
  const cacheCountEl = mustEl<HTMLElement>('cacheCount');
  const cachePercentEl = mustEl<HTMLElement>('cachePercent');
  const cacheProgress = mustEl<HTMLProgressElement>('cacheProgress');
  const cacheSizeEl = mustEl<HTMLElement>('cacheSize');
  const clearCacheBtn = mustEl<HTMLButtonElement>('clearCacheBtn');
  const clearCacheLabel = mustEl<HTMLElement>('clearCacheLabel');
  const extVersionEl = document.getElementById('extVersion');

  let clearFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSettings: YtmLiteSettings = { ...DEFAULTS };

  function showSaveError(): void {
    if (saveErrorTimer !== null) {
      clearTimeout(saveErrorTimer);
    }
    playbackModeMeta.textContent = 'Failed to save';
    saveErrorTimer = setTimeout(() => {
      saveErrorTimer = null;
      playbackModeMeta.textContent = currentSettings.enabled
        ? 'Album audio preferred'
        : 'Standard YouTube Music';
    }, 2200);
  }

  function formatBytes(bytes: number): string {
    const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (safe < 1024) return `${Math.round(safe)} B`;
    const kb = safe / 1024;
    if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  function getSystemScheme(): 'dark' | 'light' {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getRenderedScheme(): 'dark' | 'light' {
    const metaVal = colorSchemeMeta?.content;
    if (metaVal === 'light' || metaVal === 'dark') return metaVal;
    return getSystemScheme();
  }

  function applyThemeOverride(scheme: string | null): void {
    if (!colorSchemeMeta) return;
    colorSchemeMeta.content = scheme === 'light' || scheme === 'dark' ? scheme : 'light dark';
  }

  function toggleColorScheme(): void {
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

  function updateUI(settings: YtmLiteSettings): void {
    const isEnabled = Boolean(settings.enabled);
    const hideFallback = Boolean(settings.hideVideoFallback);
    currentSettings = { enabled: isEnabled, hideVideoFallback: hideFallback };

    enabledToggle.checked = isEnabled;
    fallbackToggle.checked = hideFallback;
    fallbackToggle.disabled = !isEnabled;

    fallbackRow.classList.toggle('is-disabled', !isEnabled);
    statusBadge.classList.toggle('is-off', !isEnabled);
    statusText.textContent = isEnabled ? 'Active' : 'Paused';
    playbackModeMeta.textContent = isEnabled ? 'Album audio preferred' : 'Standard YouTube Music';
  }

  function updateCacheUI(count: number, bytes = 0): void {
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

  async function readCacheStats(): Promise<{ count: number; bytes: number }> {
    const [storedLocal, bytes] = await Promise.all([
      chrome.storage.local.get(LOCAL_CACHE_KEY),
      typeof chrome.storage.local.getBytesInUse === 'function'
        ? chrome.storage.local.getBytesInUse(LOCAL_CACHE_KEY)
        : Promise.resolve(0)
    ]);
    const cacheObj = storedLocal?.[LOCAL_CACHE_KEY];
    const count = cacheObj && typeof cacheObj === 'object' ? Object.keys(cacheObj).length : 0;
    return { count, bytes: Number(bytes) || 0 };
  }

  async function init(): Promise<void> {
    try {
      const version = chrome?.runtime?.getManifest?.()?.version;
      if (extVersionEl) {
        extVersionEl.textContent = version ? `v${version}` : '—';
      }
    } catch {
      if (extVersionEl) extVersionEl.textContent = '—';
    }

    try {
      const [storedSync, cacheStats] = await Promise.all([
        chrome.storage.sync.get(DEFAULTS),
        readCacheStats()
      ]);
      updateUI({
        enabled: Boolean(storedSync.enabled),
        hideVideoFallback: Boolean(storedSync.hideVideoFallback)
      });
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

  window.addEventListener('storage', (event: StorageEvent) => {
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
      clearCacheLabel.textContent = 'Retry';
      clearFeedbackTimer = setTimeout(() => {
        clearFeedbackTimer = null;
        clearCacheLabel.textContent = 'Clear cache';
      }, 1800);
    }
  });

  enabledToggle.addEventListener('change', async () => {
    const prev = { ...currentSettings };
    const next: YtmLiteSettings = {
      enabled: enabledToggle.checked,
      hideVideoFallback: fallbackToggle.checked
    };
    updateUI(next);
    try {
      await chrome.storage.sync.set({ enabled: next.enabled });
    } catch (err) {
      console.error('[YTM Lite] Failed to save enabled state:', err);
      updateUI(prev);
      showSaveError();
    }
  });

  fallbackToggle.addEventListener('change', async () => {
    const prev = { ...currentSettings };
    const next: YtmLiteSettings = {
      enabled: enabledToggle.checked,
      hideVideoFallback: fallbackToggle.checked
    };
    updateUI(next);
    try {
      await chrome.storage.sync.set({ hideVideoFallback: next.hideVideoFallback });
    } catch (err) {
      console.error('[YTM Lite] Failed to save fallback state:', err);
      updateUI(prev);
      showSaveError();
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
        return;
      }

      if (areaName === 'sync' && (changes.enabled || changes.hideVideoFallback)) {
        updateUI({
          enabled: changes.enabled
            ? Boolean(changes.enabled.newValue ?? DEFAULTS.enabled)
            : currentSettings.enabled,
          hideVideoFallback: changes.hideVideoFallback
            ? Boolean(changes.hideVideoFallback.newValue ?? DEFAULTS.hideVideoFallback)
            : currentSettings.hideVideoFallback
        });
      }
    });
  }

  init();
})();
