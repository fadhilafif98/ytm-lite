export const DEFAULTS: Readonly<YtmLiteSettings> = Object.freeze({
  enabled: true,
  hideVideoFallback: true
});

export const ENABLED_STORAGE_KEY = 'ytm_lite_enabled_v1';
export const LOCAL_CACHE_KEY = 'ytmLiteCacheV2';
export const LEGACY_LOCAL_CACHE_KEY = 'ytmLiteCacheV1';
export const DEBUG_STORAGE_KEY = 'ytmLiteDebug';
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PERSISTENT_ENTRIES = 2500;
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const FORBIDDEN_CACHE_KEYS: ReadonlySet<string> = new Set([
  'constructor',
  '__proto__',
  'prototype'
]);
export const ALLOWED_THUMB_RE =
  /^https:\/\/([a-z0-9-]+\.)*(googleusercontent\.com|ytimg\.com)\//i;

export function isSafeVideoId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID_RE.test(id) && !FORBIDDEN_CACHE_KEYS.has(id);
}

export function isAllowedThumbUrl(url: unknown): url is string {
  return typeof url === 'string' && ALLOWED_THUMB_RE.test(url);
}

export function sanitizeThumbUrl(url: unknown): string {
  return isAllowedThumbUrl(url) ? url : '';
}

export function isDebugEnabled(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(DEBUG_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function debugLog(scope: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return;
  try {
    console.debug(`[YTM Lite:${scope}]`, ...args);
  } catch {
    // Ignore console errors
  }
}
