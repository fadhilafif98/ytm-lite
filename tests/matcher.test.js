'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMatcher() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'matcher.js'),
    'utf8'
  );
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: 'src/matcher.js' });
  return sandbox.window.__ytmLiteBoot.matcher;
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
