# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-27

### Added

- Migrated the codebase to strict TypeScript ES modules (`src/core/`, `src/content/`, `src/popup/`, `src/shared/`, `src/types.d.ts`) bundled into 4 lightweight IIFE entrypoints (`dist/content/inject.js`, `dist/content/content.js`, `dist/popup/popup.js`, `dist/popup/theme-init.js`) with `esbuild` via `scripts/build.mjs` (zero runtime dependencies), with static assets organized under `public/`.
- Added build and QA scripts in `package.json` (`typecheck`, `build`, `watch`, `zip`, `test`, `qa`) and automated pre-push gate (`scripts/qa.mjs`) checking ESM hygiene, TypeScript typechecking, `esbuild` output, MV3 manifest/version parity, PNG icon dimensions, CSP rules, and Chrome 111+ CSS compatibility.
- Added shared constants and opt-in debug logging (`src/shared/constants.ts`, enabled via `localStorage.ytmLiteDebug = '1'`).
- Expanded automated test suites with `tests/inject.test.js` and `tests/content.test.js`, plus new matcher, cache, and resolver regression cases in `tests/matcher.test.js`.

### Changed

- Reduced navigation and switching latency: kept `/browse` non-blocking (120ms VL check with background pairing), tightened `/next` (450ms) and cold `/player` (900–1100ms) resolve budgets, parallelized fallback search + artist catalog lookup in `resolver.ts`, added continuous active-queue next-track prefetch across `/player` advances (350ms settle), and added `pointerover` (120ms debounce) + `pointerdown` prefetch extracting video IDs from links, thumbnails, and Polymer row data.
- Added HTTP `429` (45s) / `5xx` (10s) backoff cooldowns without marking tracks as `noAtv` on transient errors or aborts.
- Synced `544×544` official album artwork to `navigator.mediaSession` for native OS media control consistency.
- Replaced Chrome 123+-only `light-dark()` CSS in `public/popup/popup.css` with standard custom properties to maintain full Chrome 111+ compatibility.
- Updated source-build workflow: run `npm install && npm run build` and load `dist/` via **Load unpacked** in `chrome://extensions`.
- Updated CI (`.github/workflows/ci.yml`) and release (`.github/workflows/release.yml`) workflows to run `npm run qa`, enforce matching versions between `public/manifest.json` and `package.json`, and package `dist/`.
- Clarified Chrome Sync vs. local cache storage behavior in `README.md` and `PRIVACY.md`.

### Fixed

- Fixed square cover art stretching into leftover 16:9 video dimensions by locking `ytmusic-player` to `--ytmusic-player-aspect-ratio: 1` (`data-ytm-lite-atv="1"`) and centering `#song-image yt-img-shadow` at strict `1:1` aspect ratio (automatically cleared on ads, manual Video clicks, or disable).
- Fixed cover art flickering and wrong/stale covers by rejecting `ytimg.com` 16:9 frames in `getPlayerResponseSquareThumb`, tracking stale previous-track `barImg` URLs across the full track transition, and avoiding redundant `src` churn when the same album art is already displayed at `544×544`.
- Prevented jarring mid-song restarts on slow late redirects (preserves exact floating-point playback position within the grace window, and skips disruptive reloads once playback passes 4 seconds while keeping the mapping cached).
- Fixed rapid-skip race conditions by aborting stale `/player` lookups, preventing stale `swap-state` clobbering, removing the blocking 600ms skip cooldown, and preventing 16:9 MV thumbnail flashes at `0:00`.
- Preserved `OMV` IDs inside `counterpartRenderer` after `playlistPanelVideoWrapperRenderer` swaps so YouTube Music's native Video toggle remains functional, and cleared `hide-video` state on queue-jumped `ATV` tracks.
- Enforced native `ATV` playback mode and square cover-art sync in the DOM guard while respecting active ads and manual Video toggle selections.
- Shared a single timeout budget on `/next` between `VL` album fetches and selected-track resolution, and avoided double-waiting after `/player` pre-wait timeouts.
- Hardened `MAIN`-world event validation in `content.ts` and `cache.ts` against prototype-colliding video IDs and lookalike thumbnail domains, and improved adblocker compatibility (`ytcfg` descriptor chaining, blocked-fetch cleanup, `XMLHttpRequest.open` arity).
- Improved song/artist matching for CJK titles and `artistBrowseId`, podcast-tagged music videos (recovering artist metadata from microformat), multilingual view/like bylines, `musicTwoRowItemRenderer` watch cards, short-clip rejection, and strict variant/album-order pairing.

## [1.0.0] - 2026-11-25

### Added

- Initial Manifest V3 release of YTM Lite for `https://music.youtube.com/*`.
- Automatic switching of music videos (`OMV` / `UGC`) to official audio-only album tracks (`ATV`) before video streams load via `MAIN`-world `fetch`, `XMLHttpRequest`, and `YTMUSIC_INITIAL_DATA` interception.
- 3-stage `ATV` resolver with title/artist/duration/variant scoring, album `VL` pairing, and variant protection (remix, live, acoustic, instrumental, slowed, sped up).
- Persistent local mapping cache (up to 2,500 tracks, 30-day TTL) with cross-tab hydration and instant `544×544` square album art replacement.
- Optional *Hide video fallback* mode displaying square cover art when no official audio track exists (preserves ads and respects manual Video toggle clicks).
- Adaptive Light/Dark popup UI with feature toggles, cache usage indicator, and one-click cache clear.

[1.1.0]: https://github.com/fadhilafif98/ytm-lite/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/fadhilafif98/ytm-lite/releases/tag/v1.0.0
