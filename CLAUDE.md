# CLAUDE.md

YTM Lite is a Manifest V3 Chrome extension that intercepts YouTube Music (`https://music.youtube.com/*`) before video streams load, switches music videos (`OMV`/`UGC`) to official audio-only album tracks (`ATV`), and provides an optional square cover-art fallback.

## Commands

- `npm run typecheck` — Run `tsc --noEmit` across `src/**/*.ts`
- `npm run build` — Bundle `src/` entrypoints to `dist/` with `esbuild` (`iife`, `chrome111`) and copy `public/` + `LICENSE` via `scripts/build.mjs`
- `npm run watch` — Watch `src/` (via `esbuild` context) and `public/` and rebuild `dist/` automatically on changes
- `npm run zip` — Build and package `ytm-lite-v<version>.zip` from `dist/`
- `npm test` — Run `npm run build && node --test tests/*.test.js` (runs bundled `dist/` scripts and in-memory `esbuild` core bundles inside `node:vm`)
- `npm run qa` — Run full pre-push QA gate (`scripts/qa.mjs`: ESM source hygiene check, typecheck, `esbuild` build, MV3 manifest/permissions/version sync, PNG icon dimensions, CSP/inline-handler check, Chrome 111+ CSS check, syntax check, and all unit tests)

Load `dist/` (not the repository root) in `chrome://extensions` via **Load unpacked**, and rebuild before reloading the extension. Never edit files inside `dist/` directly.

## Project Layout

- `public/manifest.json` — MV3 manifest (`minimum_chrome_version: "111"`, `storage` permission only, no `tabs` or `<all_urls>`)
- `public/popup/` — Extension popup (`popup.html`, `popup.css`)
- `public/styles/content.css` — Square fallback layout injected on YouTube Music
- `public/icons/` — Extension PNG icons (`16`, `48`, `128`) and `logo.svg`
- `src/types.d.ts` — Shared ambient TypeScript types (`YtmTrackMeta`, `YtmLiteBoot`, `YtmLiteConstants`, `YtmLiteSettings`, `Window` / `XMLHttpRequest` augmentations)
- `src/shared/constants.ts` — Single source of truth for storage keys, defaults, cache limits, video ID/thumbnail validators, and `localStorage.ytmLiteDebug` logger (`window.__ytmLiteConst`)
- `src/core/matcher.ts` — Track/variant/artist/duration scoring, byline stat stripping, and InnerTube payload extraction
- `src/core/cache.ts` — In-memory + `sessionStorage` mapping cache with cross-tab hydration
- `src/core/resolver.ts` — 3-stage on-demand `ATV` resolver (songs-filtered search, unfiltered search, artist catalog `/browse`), HTTP 429/5xx backoff, and `VLOLAK5uy_` album pairing
- `src/content/inject.ts` — `MAIN`-world `fetch`, `XMLHttpRequest`, and `ytcfg.YTMUSIC_INITIAL_DATA` interceptor
- `src/content/content.ts` — `ISOLATED`-world bridge between `chrome.storage` and `MAIN` world, native `.song-button` fallback, and fallback cover sync
- `src/popup/` — Popup controller (`popup.ts`) and synchronous anti-FOUC theme hydration (`theme-init.ts`)
- `tests/` — `node:test` suites (`matcher.test.js`, `inject.test.js`, `content.test.js`)

## Architecture & Module System

- **ES Modules + `esbuild` bundling:** `tsconfig.json` uses `"module": "ESNext"` + `"moduleResolution": "Bundler"` (`noEmit: true` for typechecking). `scripts/build.mjs` bundles 4 standalone IIFE entrypoints with `esbuild` (`target: "chrome111"`, zero runtime dependencies): `dist/content/inject.js` (`MAIN` world), `dist/content/content.js` (`ISOLATED` world), `dist/popup/popup.js`, and `dist/popup/theme-init.js`.
- **No global boot handoff:** Modules import directly with standard TypeScript `import`/`export`. Do not reintroduce `window.__ytmLiteBoot` or `window.__ytmLiteConst` (checked by `scripts/qa.mjs`).
- **Manifest script entries:** `public/manifest.json` loads only `content/inject.js` in `MAIN` world and `content/content.js` in `ISOLATED` world at `document_start`.
- **Cross-world bridge:** `content.ts` (`ISOLATED` world) and `inject.ts` / `cache.ts` (`MAIN` world) communicate solely via `CustomEvent`s (`ytm-lite-settings`, `ytm-lite-cache-put`, `ytm-lite-cache-ready`, `ytm-lite-cache-hydrate`, `ytm-lite-cache-clear`, `ytm-lite-swap-state`, `ytm-lite-manual-video`) and `sessionStorage` (`ytm_lite_enabled_v1`).
- **Debug logging:** Set `localStorage.setItem('ytmLiteDebug', '1')` on `music.youtube.com` to enable `[YTM Lite:*]` `console.debug` logs from `resolver.ts` and `inject.ts`.

## Storage Keys & Versioning

Bump the key version suffix whenever changing a persisted schema, and clean up the previous legacy key on startup:

- `chrome.storage.sync`: `enabled`, `hideVideoFallback`
- `chrome.storage.local`: `ytmLiteCacheV2` (30-day TTL, max 2,500 entries; cleans up legacy `ytmLiteCacheV1`)
- `sessionStorage` (`music.youtube.com`): `ytm_lite_omv_to_atv_v5` (cleans up `v4`), `ytm_lite_thumbs_v2`, `ytm_lite_no_atv_v1`, `ytm_lite_enabled_v1`
- `localStorage` (popup): `ytm-lite-color-scheme`; (`music.youtube.com` optional): `ytmLiteDebug`

## Critical Invariants & Pitfalls

- **Treat `MAIN`-world events as untrusted input in `content.ts`:** Validate 11-char video IDs with `isSafeVideoId` from `shared/constants.ts` (which blocks `"constructor"`, `"__proto__"`, `"prototype"`), store `persistentCache` with `Object.create(null)` + `Object.hasOwn`, and restrict thumbnail URLs to `ALLOWED_THUMB_RE` (`([a-z0-9-]+\.)*(googleusercontent\.com|ytimg\.com)`).
- **Preserve OMV counterparts during wrapper swaps:** In `inject.ts` (`rewritePayloadToAtv`), after swapping `playlistPanelVideoWrapperRenderer.primaryRenderer` to `ATV`, recurse only into `wrapper.primaryRenderer` so `counterpartRenderer` keeps its `OMV` ID for YouTube Music's Video toggle.
- **Avoid double-waiting or transient `noAtv` poisoning:** When `/player` pre-wait times out in `inject.ts`, set `preWaitTimedOut` and skip cold fallback retry; on `/next`, share one `PLAYER_RESOLVE_TIMEOUT_MS` budget across `VL` album fetch and selected-track resolution. In `resolver.ts`, never call `markNoAtv()` on HTTP 429/5xx, backoff skips, or aborted requests, and trigger cooldown on HTTP 429 (45s) / 5xx (10s).
- **Never hide ads or break `<video>` audio:** Both `content.ts` and `content.css` must leave `[is-advertisement-playing]` untouched. Hide `#song-video` via `opacity: 0; visibility: hidden` (not `display: none`) and overlay `#song-image` with `position: absolute; inset: 0; z-index: 0`.
- **Respect manual Video selection:** `content.ts` tracks trusted user clicks on `ytmusic-av-toggle .video-button` (`manualVideoTrackKey`) for the current track only and resumes audio-only switching on the next track.
- **Browser compatibility:** `public/manifest.json` targets Chrome `111+`. Do not use Chrome `123+`-only CSS such as `light-dark()` in `public/popup/popup.css`.
- **Privacy consistency:** Toggle preferences (`enabled`, `hideVideoFallback`) use `chrome.storage.sync`; the 2,500-track mapping cache uses `chrome.storage.local`. Keep `PRIVACY.md` and `README.md` accurate when changing storage behavior.

## Release Procedure

1. Update `"version"` in both `public/manifest.json` and `package.json` to the same `X.Y.Z` value (enforced by CI and release workflows).
2. Run `npm run typecheck && npm test`.
3. Tag and push `vX.Y.Z`; `.github/workflows/release.yml` validates the tag against both manifests, builds `dist/`, runs tests, and attaches `ytm-lite-vX.Y.Z.zip` to the GitHub Release.
