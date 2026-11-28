'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const rootDir = path.join(__dirname, '..');

const matcherBundleCode = esbuild.buildSync({
  entryPoints: [path.join(rootDir, 'src', 'core', 'matcher.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome111'
}).outputFiles[0].text;

const fullBootBundleCode = esbuild.buildSync({
  stdin: {
    contents: [
      "import * as matcher from './src/core/matcher.ts';",
      "import * as cache from './src/core/cache.ts';",
      "import * as resolver from './src/core/resolver.ts';",
      'export { matcher, cache, resolver };'
    ].join('\n'),
    resolveDir: rootDir,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome111'
}).outputFiles[0].text;

function loadMatcher() {
  const mod = { exports: {} };
  const sandbox = { window: {}, module: mod, exports: mod.exports };
  vm.runInNewContext(matcherBundleCode, sandbox, { filename: 'src/core/matcher.ts' });
  return sandbox.module.exports;
}

const matcher = loadMatcher();

test('extractVariantTags detects core musical variants', () => {
  assert.deepEqual([...matcher.extractVariantTags('Song (Official Remix)')], ['remix']);
  assert.deepEqual([...matcher.extractVariantTags('Song (Live at Tokyo Dome)')], ['live']);
  assert.deepEqual([...matcher.extractVariantTags('Song (Acoustic Version)')], ['acoustic']);
  assert.deepEqual([...matcher.extractVariantTags('Song (Sped Up)')], ['sped_up']);
  assert.deepEqual([...matcher.extractVariantTags('Song [Slowed + Reverb]')], ['slowed']);
  assert.deepEqual([...matcher.extractVariantTags('Song (Instrumental)')], ['instrumental']);
});

test('extractVariantTags detects parenthetical and hyphenated alternate versions', () => {
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (Hot Chili ver.)')], ['ver:hot chili']);
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (English ver.)')], ['ver:english']);
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (Clean ver.)')], ['ver:clean']);
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (Clean)')], ['ver:clean']);
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (Censored)')], ['ver:clean']);
  assert.deepEqual([...matcher.extractVariantTags('Track (TV Size)')], ['ver:tv size']);
  assert.deepEqual([...matcher.extractVariantTags('Track (Radio Edit)')], ['ver:radio']);
  assert.deepEqual([...matcher.extractVariantTags('Track (Inst.)')], ['instrumental']);
  assert.deepEqual([...matcher.extractVariantTags('Track (MR)')], ['instrumental']);
  assert.deepEqual([...matcher.extractVariantTags('ANTIFRAGILE -Japanese ver.-')], ['ver:japanese']);
  assert.deepEqual([...matcher.extractVariantTags('Song - Radio Edit')], ['ver:radio']);
});

test('extractVariantTags ignores canonical descriptors and avoids false positives', () => {
  assert.deepEqual([...matcher.extractVariantTags('SPAGHETTI (feat. j-hope)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (Album Version)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (Original Version)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (Explicit)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (Remastered 2011)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (2020 Remaster)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Track (Official Music Video)')], []);
  assert.deepEqual([...matcher.extractVariantTags('Mr. Brightside')], []);
});

test('cleanSongTitle strips MV/audio noise but preserves meaningful version tags', () => {
  assert.equal(matcher.cleanSongTitle('Song Title (Official Music Video)'), 'Song Title');
  assert.equal(matcher.cleanSongTitle('Song Title [Official Audio]'), 'Song Title');
  assert.equal(matcher.cleanSongTitle('Song Title - Official MV'), 'Song Title');
  assert.equal(matcher.cleanSongTitle('SPAGHETTI (Clean)'), 'SPAGHETTI (Clean)');
  assert.equal(matcher.cleanSongTitle('SPAGHETTI (Hot Chili ver.)'), 'SPAGHETTI (Hot Chili ver.)');
});

test('pickBestCandidate resolves SPAGHETTI MV to original feat. ATV instead of alt versions', () => {
  const omvTrack = {
    title: 'SPAGHETTI',
    artist: 'LE SSERAFIM, j-hope',
    durationSec: 194
  };
  const candidates = [
    {
      videoId: 'SvX3OFL7R28',
      title: 'SPAGHETTI (Hot Chili ver.)',
      artist: 'LE SSERAFIM',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 172
    },
    {
      videoId: 'clean_id_01',
      title: 'SPAGHETTI (Clean ver.)',
      artist: 'LE SSERAFIM',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 171
    },
    {
      videoId: 'eng_id_0001',
      title: 'SPAGHETTI (English ver.)',
      artist: 'LE SSERAFIM',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 171
    },
    {
      videoId: '12ELDQy3IUc',
      title: 'SPAGHETTI (feat. j-hope)',
      artist: 'LE SSERAFIM',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 171
    }
  ];

  const picked = matcher.pickBestCandidate(omvTrack, candidates, 'TvVtYaqCni8', 110);
  assert.equal(picked?.videoId, '12ELDQy3IUc');
  assert.equal(matcher.scoreAtvCandidate(omvTrack, candidates[0], 0), -1);
  assert.ok(matcher.scoreAtvCandidate(omvTrack, candidates[3], 3) >= 180);
});

test('pickBestCandidate enforces variant lock in both directions', () => {
  const remixMv = {
    title: 'Track (Club Remix) (Official Video)',
    artist: 'Artist A',
    durationSec: 210
  };
  const originalAtv = {
    videoId: 'orig_atv_01',
    title: 'Track',
    artist: 'Artist A',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 205
  };
  const remixAtv = {
    videoId: 'rmx_atv_001',
    title: 'Track (Club Remix)',
    artist: 'Artist A',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 208
  };

  assert.equal(matcher.scoreAtvCandidate(remixMv, originalAtv, 0), -1);
  assert.equal(
    matcher.pickBestCandidate(remixMv, [originalAtv, remixAtv], 'omv_001', 110)?.videoId,
    'rmx_atv_001'
  );
});

test('pickBestCandidate skips non-ATV items and self videoId', () => {
  const track = { title: 'Hello', artist: 'Adele', durationSec: 295 };
  const candidates = [
    {
      videoId: 'self_omv_01',
      title: 'Hello',
      artist: 'Adele',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 295
    },
    {
      videoId: 'other_omv_1',
      title: 'Hello',
      artist: 'Adele',
      musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
      durationSec: 295
    },
    {
      videoId: 'valid_atv_1',
      title: 'Hello',
      artist: 'Adele',
      musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
      durationSec: 295
    }
  ];

  const picked = matcher.pickBestCandidate(track, candidates, 'self_omv_01', 110);
  assert.equal(picked?.videoId, 'valid_atv_1');
});

test('scoreAtvCandidate parses Artist - Title MV format and rejects short clips', () => {
  const mv = {
    title: 'Daft Punk - Instant Crush (Official Video)',
    artist: 'Daft PunkVEVO',
    durationSec: 337
  };
  const fullAtv = {
    videoId: 'atv_full_01',
    title: 'Instant Crush (feat. Julian Casablancas)',
    artist: 'Daft Punk',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 337
  };
  const snippetAtv = {
    videoId: 'atv_snip_01',
    title: 'Instant Crush',
    artist: 'Daft Punk',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 30
  };

  assert.ok(matcher.scoreAtvCandidate(mv, fullAtv, 0) >= 180);
  assert.equal(matcher.scoreAtvCandidate(mv, snippetAtv, 0), -1);
});

test('stripViewsAndLikesFromByline removes video stats and dangling bullets', () => {
  const byline = {
    runs: [
      { text: 'LE SSERAFIM' },
      { text: ' • ' },
      { text: '12M views' },
      { text: ' • ' },
      { text: '450K likes' }
    ]
  };
  const changed = matcher.stripViewsAndLikesFromByline(byline);
  assert.equal(changed, true);
  assert.deepEqual(Array.from(byline.runs), [{ text: 'LE SSERAFIM' }]);

  const cleanByline = {
    runs: [{ text: 'LE SSERAFIM' }, { text: ' • ' }, { text: 'SPAGHETTI' }, { text: ' • ' }, { text: '2025' }]
  };
  assert.equal(matcher.stripViewsAndLikesFromByline(cleanByline), false);
});

test('matchArtistsScore blocks short and mid-word substring false positives', () => {
  assert.equal(matcher.matchArtistsScore('IU', 'Nium', ''), -1);
  assert.equal(matcher.matchArtistsScore('V', 'Avicii', ''), -1);
  assert.equal(matcher.matchArtistsScore('V', 'Marvin Gaye', ''), -1);
  assert.equal(matcher.matchArtistsScore('Lisa', 'Elisabeth', ''), -1);
  assert.equal(matcher.matchArtistsScore('Rose', 'Primrose', ''), -1);
  assert.equal(matcher.matchArtistsScore('CL', 'Clean Bandit', ''), -1);
  assert.ok(matcher.matchArtistsScore('V', 'BTS, V', '') >= 55);
  assert.ok(matcher.matchArtistsScore('LE SSERAFIM, j-hope', 'LE SSERAFIM', '') >= 55);
});

test('scoreAtvCandidate rejects different songs sharing prefix and tribute/karaoke artists', () => {
  const track = { title: 'Better', artist: 'Khalid', durationSec: 229 };
  const wrongSong = {
    videoId: 'wrong_song1',
    title: 'Better Now',
    artist: 'Khalid',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 230
  };
  assert.equal(matcher.scoreAtvCandidate(track, wrongSong, 0), -1);

  const tributeCand = {
    videoId: 'tribute_001',
    title: 'Hello',
    artist: 'Adele Tribute Band',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 295
  };
  assert.equal(
    matcher.scoreAtvCandidate({ title: 'Hello', artist: 'Adele', durationSec: 295 }, tributeCand, 0),
    -1
  );
});

test('scoreAtvCandidate rejects short snippets even when diff is within 90s', () => {
  const track = { title: 'Short Pop Song', artist: 'Artist X', durationSec: 120 };
  const snippet = {
    videoId: 'snip_120_35',
    title: 'Short Pop Song',
    artist: 'Artist X',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 35
  };
  assert.equal(matcher.scoreAtvCandidate(track, snippet, 0), -1);
});

test('scoreAtvCandidate matches CJK/English artist via artistBrowseId and parses CJK brackets', () => {
  const mv = {
    title: 'YOASOBI「アイドル」 Official Music Video',
    artist: 'YOASOBI',
    artistBrowseId: 'UCvpredjG93ifbCP1Y77JyFA',
    durationSec: 225
  };
  const atv = {
    videoId: 'zrtdQ81jPUQ',
    title: 'アイドル',
    artist: 'YOASOBI',
    artistBrowseId: 'UCvpredjG93ifbCP1Y77JyFA',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 213
  };
  assert.ok(matcher.scoreAtvCandidate(mv, atv, 0) >= 180);

  const cjkMismatchName = {
    title: 'Kenshi Yonezu - Lemon【Official Music Video】',
    artist: 'Kenshi Yonezu',
    artistBrowseId: 'UCUCeZaZeJbEYAAzvMgrKOPQ',
    durationSec: 274
  };
  const jpAtv = {
    videoId: 'lemon_atv01',
    title: 'Lemon',
    artist: '米津玄師',
    artistBrowseId: 'UCUCeZaZeJbEYAAzvMgrKOPQ',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 256
  };
  assert.ok(matcher.scoreAtvCandidate(cjkMismatchName, jpAtv, 0) >= 180);
});

test('parseTitleParts handles Title - Artist and Title - Suffix without clobbering artist', () => {
  const reversed = matcher.parseTitleParts('Every Summertime - NIKI', 'NIKI');
  assert.equal(reversed.artistFromTitle, 'NIKI');
  assert.equal(reversed.titleWithoutArtist, 'Every Summertime');

  const remaster = matcher.parseTitleParts('Bohemian Rhapsody - Remastered 2011', 'Queen');
  assert.equal(remaster.artistFromTitle, '');
  assert.equal(remaster.titleWithoutArtist, 'Bohemian Rhapsody');

  const labelUpload = matcher.parseTitleParts('IU - Blueming (MV)', '1theK');
  assert.equal(labelUpload.artistFromTitle, 'IU');
  assert.equal(labelUpload.titleWithoutArtist, 'Blueming');
});

function loadFullBoot() {
  const storage = new Map();
  const listeners = new Map();
  const sandbox = {
    window: {
      location: { origin: 'https://music.youtube.com' },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of listeners.get(ev?.type) || []) fn(ev);
        return true;
      },
      fetch: async () => ({ ok: false })
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    AbortController,
    setTimeout,
    clearTimeout,
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
  const mod = { exports: {} };
  sandbox.module = mod;
  sandbox.exports = mod.exports;
  vm.runInNewContext(fullBootBundleCode, sandbox, { filename: 'src/core/full-boot.ts' });
  const boot = { ...sandbox.module.exports };
  boot.dispatchWindowEvent = (ev) => sandbox.window.dispatchEvent(ev);
  return boot;
}

test('resolver resolveTrack aborts cleanly via AbortSignal without marking noAtv', async () => {
  const boot = loadFullBoot();
  let capturedSignal = null;

  boot.resolver.init({
    originalFetch: (_url, opts) => {
      capturedSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
  });

  const controller = new AbortController();
  const promise = boot.resolver.resolveTrack(
    { videoId: 'abt_0000001', title: 'NextOne', artist: 'Art', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    'https://music.youtube.com/youtubei/v1/player',
    {},
    { signal: controller.signal }
  );

  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  const resolved = await promise;

  assert.equal(resolved, false);
  assert.ok(capturedSignal?.aborted);
  assert.equal(boot.cache.noAtvSet.has('abt_0000001'), false, 'aborted resolve must not poison noAtvSet');
});

test('resolver waitForResolve times out without rejecting slow lookup', async () => {
  const boot = loadFullBoot();
  let resolveSlow;
  const slow = new Promise((r) => {
    resolveSlow = r;
  });
  const res = await boot.resolver.waitForResolve(slow, 30);
  assert.equal(res.resolved, false);
  assert.equal(res.timedOut, true);
  resolveSlow(true);
});

test('resolver pairAndRememberTracks refuses index fallback on mismatched album order', () => {
  const boot = loadFullBoot();
  const src = [
    { videoId: 'omv_a000001', title: 'Track Alpha', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    { videoId: 'omv_b000002', title: 'Track Beta', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
  ];
  const vl = [
    { videoId: 'atv_x000001', title: 'Completely Different 1', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    { videoId: 'atv_y000002', title: 'Completely Different 2', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
  ];
  boot.resolver.pairAndRememberTracks(src, vl);
  assert.equal(boot.cache.omvToAtvMap.has('omv_a000001'), false);
  assert.equal(boot.cache.omvToAtvMap.has('omv_b000002'), false);
});

test('extractTrackFromPlayerData recovers real artist from microformat when SMTOWN podcast playlist corrupts author', () => {
  const playerData = {
    videoDetails: {
      videoId: 'phuiiNCxRMg',
      title: 'Supernova',
      author: 'SMTOWN LIVE 2025 [THE CULTURE, THE FUTURE] in SEOUL Playlist',
      channelId: 'UCEf_Bc-KVd7onSeifS3py9g',
      lengthSeconds: '193',
      musicVideoType: 'MUSIC_VIDEO_TYPE_OMV'
    },
    microformat: {
      microformatDataRenderer: {
        title: "aespa 에스파 'Supernova' MV",
        description: 'Episode • SMTOWN LIVE 2025 [THE CULTURE, THE FUTURE] in SEOUL Playlist',
        pageOwnerDetails: {
          name: 'SMTOWN',
          externalChannelId: 'UCEf_Bc-KVd7onSeifS3py9g'
        }
      }
    }
  };

  const track = matcher.extractTrackFromPlayerData(playerData, 'phuiiNCxRMg');
  assert.equal(track.title, 'Supernova');
  assert.equal(track.artist, 'aespa 에스파');
  assert.equal(track.artistBrowseId, '');

  const officialAtv = {
    videoId: 'G8YNFjruzPk',
    title: 'Supernova',
    artist: 'aespa',
    artistBrowseId: 'UCEdZAdnnKqbaHOlv8nM6OtA',
    musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
    durationSec: 179
  };
  assert.ok(matcher.scoreAtvCandidate(track, officialAtv, 0) >= 180);
});

test('isResolvableNonAtvType allows podcast-tagged MV with MUSIC_PAGE_TYPE_ARTIST but skips real podcasts', () => {
  assert.equal(matcher.isResolvableNonAtvType('MUSIC_VIDEO_TYPE_PODCAST_EPISODE'), false);
  assert.equal(
    matcher.isResolvableNonAtvType('MUSIC_VIDEO_TYPE_PODCAST_EPISODE', {
      artistBrowseId: 'UCEdZAdnnKqbaHOlv8nM6OtA',
      durationSec: 194
    }),
    true
  );
  assert.equal(
    matcher.isResolvableNonAtvType('MUSIC_VIDEO_TYPE_PODCAST_EPISODE', {
      artistBrowseId: 'UCEdZAdnnKqbaHOlv8nM6OtA',
      durationSec: 3600
    }),
    false
  );
  assert.equal(
    matcher.isResolvableNonAtvType('MUSIC_VIDEO_TYPE_PODCAST_EPISODE', {
      artistBrowseId: '',
      durationSec: 180
    }),
    false
  );
});

test('parseTitleParts preserves trailing modifiers after CJK/single quotes and extractFeaturedArtistsFromTitle cleans MV noise', () => {
  const cjkTrail = matcher.parseTitleParts('YOASOBI「アイドル」(English ver.) Official Video', 'YOASOBI');
  assert.equal(cjkTrail.artistFromTitle, 'YOASOBI');
  assert.equal(cjkTrail.titleWithoutArtist, 'アイドル (English ver.)');

  const quoteTrail = matcher.parseTitleParts("Artist 'Song Name' (Live) [Official MV]", 'Artist');
  assert.equal(quoteTrail.artistFromTitle, 'Artist');
  assert.equal(quoteTrail.titleWithoutArtist, 'Song Name (Live)');

  assert.equal(
    matcher.extractFeaturedArtistsFromTitle('Song feat. Guest Star Official Music Video'),
    'Guest Star'
  );
});

test('stripViewsAndLikesFromByline handles multilingual stats without stripping linked album/year runs', () => {
  const jpByline = {
    runs: [
      {
        text: 'YOASOBI',
        navigationEndpoint: { browseEndpoint: { browseId: 'UCvpredjG93ifbCP1Y77JyFA' } }
      },
      { text: ' • ' },
      { text: '1,200万回視聴' },
      { text: ' • ' },
      { text: '12万高評価' }
    ]
  };
  assert.equal(matcher.stripViewsAndLikesFromByline(jpByline), true);
  assert.deepEqual(
    Array.from(jpByline.runs.map((r) => r.text)),
    ['YOASOBI']
  );

  const albumRun = {
    runs: [
      { text: 'Taylor Swift', navigationEndpoint: { browseEndpoint: { browseId: 'UC1' } } },
      { text: ' • ' },
      { text: '1989', navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_1' } } }
    ]
  };
  assert.equal(matcher.stripViewsAndLikesFromByline(albumRun), false);
});

test('extractResponsiveItems extracts musicTwoRowItemRenderer watch cards', () => {
  const data = {
    contents: [
      {
        musicTwoRowItemRenderer: {
          title: { runs: [{ text: 'Card Song' }] },
          subtitle: {
            runs: [
              {
                text: 'Card Artist',
                navigationEndpoint: {
                  browseEndpoint: {
                    browseId: 'UCabc123',
                    browseEndpointContextSupportedConfigs: {
                      browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' }
                    }
                  }
                }
              }
            ]
          },
          navigationEndpoint: {
            watchEndpoint: {
              videoId: 'omv_card_01',
              watchEndpointMusicSupportedConfigs: {
                watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
              }
            }
          },
          thumbnailRenderer: {
            musicThumbnailRenderer: {
              thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/omv_card_01/hqdefault.jpg', width: 480, height: 360 }] }
            }
          }
        }
      }
    ]
  };
  const items = matcher.extractResponsiveItems(data);
  assert.equal(items.length, 1);
  assert.equal(items[0].videoId, 'omv_card_01');
  assert.equal(items[0].artistBrowseId, 'UCabc123');
});

test('cache upgrades low-res thumbnail with square googleusercontent art and hydrate clears noAtvSet', () => {
  const boot = loadFullBoot();
  boot.cache.markNoAtv('omv_up_0001');
  boot.dispatchWindowEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: { entries: [{ o: 'omv_up_0001', a: 'atv_up_0001', u: '' }] }
  });
  assert.equal(boot.cache.noAtvSet.has('omv_up_0001'), false);

  boot.cache.rememberMapping('omv_up_0001', 'atv_up_0001', [
    { url: 'https://i.ytimg.com/vi/atv_up_0001/hqdefault.jpg', width: 480, height: 360 }
  ]);
  boot.cache.rememberMapping('omv_up_0001', 'atv_up_0001', [
    { url: 'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj', width: 544, height: 544 }
  ]);
  const thumbs = boot.cache.videoThumbMap.get('atv_up_0001');
  assert.ok(thumbs[thumbs.length - 1].url.includes('googleusercontent.com'));
});

test('resolver pairAndRememberTracks enforces variant compatibility and does not mark noAtv on HTTP 429', async () => {
  const boot = loadFullBoot();
  const src = [
    { videoId: 'omv_v000001', title: 'Song', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    { videoId: 'omv_v000002', title: 'Song (Instrumental)', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' }
  ];
  const vl = [
    { videoId: 'atv_v000002', title: 'Song (Instrumental)', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
    { videoId: 'atv_v000001', title: 'Song', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
  ];
  boot.resolver.pairAndRememberTracks(src, vl);
  assert.equal(boot.cache.omvToAtvMap.get('omv_v000001'), 'atv_v000001');
  assert.equal(boot.cache.omvToAtvMap.get('omv_v000002'), 'atv_v000002');

  let seenHeaders = null;
  boot.resolver.setAuthHeaders({ authorization: 'SAPISIDHASH test', 'x-goog-authuser': '1' });
  boot.resolver.init({
    originalFetch: async (url, opts) => {
      seenHeaders = opts.headers;
      return { ok: false, status: 429 };
    }
  });
  const ok = await boot.resolver.resolveTrack(
    { videoId: 'omv_429_001', title: 'Some Song', artist: 'Some Artist', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    'https://music.youtube.com/youtubei/v1/player',
    {}
  );
  assert.equal(ok, false);
  assert.equal(boot.cache.noAtvSet.has('omv_429_001'), false);
  assert.equal(seenHeaders.authorization, 'SAPISIDHASH test');
  assert.equal(seenHeaders['x-goog-authuser'], '1');
});

test('cache rejects lookalike thumb domains and prototype-colliding videoIds', () => {
  const boot = loadFullBoot();
  boot.dispatchWindowEvent({
    type: 'ytm-lite-cache-hydrate',
    detail: {
      entries: [
        { o: 'constructor', a: 'atv_safe_01', u: 'https://lh3.googleusercontent.com/x=w544-h544' },
        { o: 'omv_safe_01', a: 'atv_safe_01', u: 'https://evil-googleusercontent.com/x.jpg' }
      ]
    }
  });
  assert.equal(boot.cache.omvToAtvMap.has('constructor'), false);
  assert.equal(boot.cache.omvToAtvMap.get('omv_safe_01'), 'atv_safe_01');
  assert.equal(boot.cache.videoThumbMap.has('atv_safe_01'), false);
});

test('resolver backs off on HTTP 429 without marking noAtv and resets backoff on cache clear', async () => {
  const boot = loadFullBoot();
  let fetchCount = 0;
  boot.resolver.init({
    originalFetch: async () => {
      fetchCount += 1;
      return { ok: false, status: 429 };
    }
  });

  const first = await boot.resolver.resolveTrack(
    { videoId: 'omv_rl_0001', title: 'Track One', artist: 'Artist', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    'https://music.youtube.com/youtubei/v1/player',
    {}
  );
  assert.equal(first, false);
  assert.equal(fetchCount, 1, '429 on stage 1 must halt stage 2/3 immediately');
  assert.equal(boot.cache.noAtvSet.has('omv_rl_0001'), false);
  assert.ok(boot.resolver.getBackoffRemainingMs() > 0);

  // Subsequent track skips network during backoff without poisoning noAtvSet
  const second = await boot.resolver.resolveTrack(
    { videoId: 'omv_rl_0002', title: 'Track Two', artist: 'Artist', musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' },
    'https://music.youtube.com/youtubei/v1/player',
    {}
  );
  assert.equal(second, false);
  assert.equal(fetchCount, 1);
  assert.equal(boot.cache.noAtvSet.has('omv_rl_0002'), false);

  // Cache clear resets backoff
  boot.cache.clearAllCaches();
  assert.equal(boot.resolver.getBackoffRemainingMs(), 0);
});
