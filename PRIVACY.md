# Privacy Policy — YTM Lite

**Last updated:** 2026-11-26

YTM Lite is a privacy-first browser extension. Your listening activity, search queries, and cached song mappings never leave your browser to any third-party or developer server.

## Data Collection

- **No personal data collected:** YTM Lite does not collect, store, or transmit personally identifiable information, account credentials, browsing history, or listening history.
- **No analytics or telemetry:** There are no third-party trackers, crash reporters, ads, or external backend servers.

## Network Requests

YTM Lite only communicates with `https://music.youtube.com` directly from your browser tab, using your existing YouTube Music session to look up official audio-only album tracks (`ATV`) corresponding to music videos (`OMV`/`UGC`) you play.

## Browser Permissions & Storage

| Permission / Scope | Purpose |
| --- | --- |
| `storage` (`chrome.storage.sync`) | Saves your two toggle settings (*Don't play music videos* and *Hide video fallback*) and syncs them across your signed-in Chrome profile devices when Chrome Sync is enabled. |
| `storage` (`chrome.storage.local`) | Caches up to 2,500 resolved song ID mappings and album cover URLs locally on your device for 30 days to enable instant swaps. You can clear this cache at any time from the extension popup. |
| `https://music.youtube.com/*` | Runs the audio-track resolver and optional cover-art stylesheet exclusively on YouTube Music. |

## Contact

If you have privacy questions or concerns, please open an issue at [github.com/fadhilafif98/ytm-lite/issues](https://github.com/fadhilafif98/ytm-lite/issues).
