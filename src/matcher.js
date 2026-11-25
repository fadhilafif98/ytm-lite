(() => {
  if (window.__ytmLiteInjected) return;

  const VARIANT_PATTERNS = [
    ['remix', /\b(remix|rmx|rework|bootleg|mashup|megamix|flip|vip\s*mix|club\s*mix|dub\s*mix|extended\s*mix|radio\s*mix)\b/i],
    ['mix', /\b(dj\s+mix|extended\s*version|club\s*version|dub\s*version)\b/i],
    ['live', /\b(live|concert|unplugged|tiny\s*desk|live\s*session|live\s*at|live\s*from)\b/i],
    ['acoustic', /\b(acoustic|stripped|piano\s*version|guitar\s*version|orchestral)\b/i],
    ['instrumental', /\b(instrumental|karaoke|backing\s*track|minus\s*one)\b/i],
    ['acapella', /\b(a\s*cappella|acapella|vocals\s*only)\b/i],
    ['sped_up', /\b(sped\s*up|speed\s*up|nightcore|fast\s*version)\b/i],
    ['slowed', /\b(slowed|reverb|chopped|screwed)\b/i],
    ['cover', /\b(cover|tribute|parody)\b/i],
    ['lofi', /\b(lo[\s-]?fi|8d\s*audio|8d|16d)\b/i],
    ['koplo', /\b(koplo|dangdut|jedag\s*jedug|jj|funkot|breakbeat|phonk|hardstyle)\b/i],
    ['demo', /\b(demo)\b/i]
  ];

  const BENIGN_VERSION_DESCRIPTOR_RE =
    /^(?:album|original|single|studio|full|official|explicit|explicit\s+album|standard|main|master|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|mono|stereo|dolby\s+atmos|spatial\s+audio|hi[\s-]?res)$/i;

  const STANDALONE_ALT_QUALIFIER_RE =
    /^(?:clean|censored|edited|inst\.?|mr|tv\s*size|anime\s*size|game\s*size|radio\s*edit|single\s*edit|album\s*edit|short\s*edit|english|eng|japanese|jpn|jp|korean|kor|kr|chinese|chn|cn|spanish|esp|french|german|italian|portuguese|indonesian|orchestra|piano|band|rock|ballad|jazz|holiday|christmas|solo|duet|choir|choral)$/i;

  const VERSION_ALIASES = {
    eng: 'english',
    jpn: 'japanese',
    jp: 'japanese',
    kor: 'korean',
    kr: 'korean',
    chn: 'chinese',
    cn: 'chinese',
    esp: 'spanish',
    spa: 'spanish',
    orch: 'orchestral',
    orchestra: 'orchestral',
    symphonic: 'orchestral',
    inst: 'instrumental',
    instr: 'instrumental',
    mr: 'instrumental',
    orig: 'original',
    censored: 'clean'
  };

  const NON_ARTIST_LABELS = new Set([
    'song',
    'video',
    'single',
    'album',
    'ep',
    'playlist',
    'podcast',
    'episode',
    'lagu',
    'top result'
  ]);

  function isResolvableNonAtvType(mvType) {
    return (
      Boolean(mvType) &&
      mvType !== 'MUSIC_VIDEO_TYPE_ATV' &&
      mvType !== 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE'
    );
  }

  function matchCoreVariantTags(str) {
    const tags = new Set();
    if (!str) return tags;
    for (const [tag, regex] of VARIANT_PATTERNS) {
      if (regex.test(str)) tags.add(tag);
    }
    if (/[\(\[]\s*dj\b/i.test(str)) {
      tags.add('remix');
    }
    return tags;
  }

  function addNormalizedVersionTag(tags, rawDesc) {
    let desc = normalizeUnicode(rawDesc);
    if (!desc || BENIGN_VERSION_DESCRIPTOR_RE.test(desc)) return;
    if (VERSION_ALIASES[desc]) desc = VERSION_ALIASES[desc];
    if (desc === 'original') return;
    if (desc === 'instrumental' || desc === 'orchestral') {
      tags.add(desc === 'orchestral' ? 'acoustic' : 'instrumental');
      return;
    }
    tags.add(`ver:${desc}`);
  }

  function extractVariantTags(str) {
    const tags = matchCoreVariantTags(str);
    if (!str) return tags;

    // 1. Parenthetical / bracketed alternate version qualifiers: (Hot Chili ver.), (English ver.), (Clean), (Radio Edit)
    const parenRe = /[\(\[]([^\)\]]+)[\)\]]/g;
    let m;
    while ((m = parenRe.exec(str)) !== null) {
      const inner = m[1].trim();
      if (!inner) continue;
      if (/^(?:feat\.?|ft\.?|featuring|prod\.?|narr\.?|with|official\s*(?:music\s*)?(?:video|mv|m\/v|audio|lyric\s*video)|music\s*video|lyric\s*video|lyrics|audio|visualizer|hd|4k|hq)\b/i.test(inner)) {
        continue;
      }
      if (matchCoreVariantTags(inner).size > 0) continue;

      const verMatch = inner.match(/^(.+?)\s+(?:ver\.?|version|edit|edition|mix|take|session|cut)$/i);
      if (verMatch) {
        addNormalizedVersionTag(tags, verMatch[1]);
        continue;
      }
      if (STANDALONE_ALT_QUALIFIER_RE.test(inner)) {
        addNormalizedVersionTag(tags, inner.replace(/\s+(?:edit)$/i, ''));
      }
    }

    // 2. Hyphen-wrapped or trailing version qualifiers: "ANTIFRAGILE -Japanese ver.-", "Song - Radio Edit"
    const hyphenRe = /(?:^|\s)[-–—]\s*([^()\[\]\-–—]{1,40}?)\s+(?:ver\.?|version|edit)\s*[-–—]?(?=\s|$|\(|\[)/gi;
    while ((m = hyphenRe.exec(str)) !== null) {
      if (matchCoreVariantTags(m[0]).size > 0) continue;
      addNormalizedVersionTag(tags, m[1]);
    }

    return tags;
  }

  function cleanSongTitle(rawTitle) {
    return (rawTitle || '')
      .replace(
        /[\(\[\|]\s*(official\s*)?(music\s*)?(video|mv|m\/v|lyric\s*video|lyrics|audio|visualizer|hd|4k|hq|full\s*video|explicit|official\s*lyric\s*video|official\s*audio)[^\)\]]*[\)\]]?/gi,
        ' '
      )
      .replace(/\s*[-–|]\s*official\s*(music\s*)?(video|mv|m\/v|audio|lyric\s*video).*$/i, '')
      .replace(/\s+\b(?:official\s+)?(?:music\s+video|m\/v|mv|lyric\s+video|official\s+audio|official\s+video)\b\s*$/i, '')
      .replace(/[“”"‘’']/g, (ch) => (ch === "'" || ch === '’' ? "'" : ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUnicode(str) {
    return (str || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function normalizeTitle(str) {
    return normalizeUnicode(
      cleanSongTitle(str)
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s*\[[^\]]*\]\s*/g, ' ')
        .replace(/(?:^|\s)[-–—]\s*[^()\[\]\-–—]{1,40}?\s+(?:ver\.?|version|edit)\s*[-–—]?(?=\s|$)/gi, ' ')
        .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    );
  }

  function extractFeaturedArtistsFromTitle(rawTitle) {
    if (!rawTitle) return '';
    const feats = [];
    const parenRe = /[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]]+)[\)\]]/gi;
    let m;
    while ((m = parenRe.exec(rawTitle)) !== null) {
      const name = m[1].replace(/\s+of\s+.+$/i, '').trim();
      if (name) feats.push(name);
    }
    if (feats.length === 0) {
      const inlineM = rawTitle.match(/\b(?:feat\.?|ft\.?|featuring)\s+([^(\[\-–—]+)/i);
      if (inlineM) {
        const name = inlineM[1].replace(/\s+of\s+.+$/i, '').trim();
        if (name) feats.push(name);
      }
    }
    return feats.join(', ');
  }

  function normalizeArtist(str) {
    return normalizeUnicode(
      (str || '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/\bofficial$/i, '')
        .replace(/vevo$/i, '')
    );
  }

  function extractParenSubtitles(rawTitle) {
    const cleaned = cleanSongTitle(rawTitle);
    const subs = [];
    const regex = /[\(\[]([^\)\]]+)[\)\]]/g;
    let m;
    while ((m = regex.exec(cleaned)) !== null) {
      const inner = m[1].trim();
      if (!inner) continue;
      if (extractVariantTags(inner).size > 0) continue;
      if (/^(feat\.?|ft\.?|featuring|prod\.?|narr\.?|with)\b/i.test(inner)) continue;
      const norm = normalizeUnicode(inner);
      if (norm && norm.length >= 2) subs.push(norm);
    }
    return subs;
  }

  function stripLeadingArtistPrefix(cleanedTitle, artistStr) {
    if (!cleanedTitle || !artistStr) return '';
    const primaryArtist = artistStr.split(/,|&|\(/)[0].trim();
    if (!primaryArtist || primaryArtist.length < 2) return '';
    const escaped = primaryArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(?:\\s*\\([^)]*\\))?(?:\\s*[-–—:]|\\s+)\\s*(.+)$`, 'i');
    const m = cleanedTitle.match(re);
    return m ? m[1].trim() : '';
  }

  function parseTitleParts(rawTitle, rawArtist) {
    const cleaned = cleanSongTitle(rawTitle);
    const dashMatch = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dashMatch) {
      return {
        cleaned,
        artistFromTitle: dashMatch[1].trim(),
        titleWithoutArtist: dashMatch[2].trim()
      };
    }
    const strippedLead = stripLeadingArtistPrefix(cleaned, rawArtist);
    if (strippedLead) {
      return {
        cleaned,
        artistFromTitle: '',
        titleWithoutArtist: strippedLead
      };
    }
    return {
      cleaned,
      artistFromTitle: '',
      titleWithoutArtist: ''
    };
  }

  function parseDurationSec(text) {
    if (!text) return 0;
    const m = String(text).trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/);
    if (!m) return 0;
    const hours = m[1] ? Number(m[1]) : 0;
    const mins = Number(m[2]);
    const secs = Number(m[3]);
    return hours * 3600 + mins * 60 + secs;
  }

  function getRunsText(runs) {
    if (!Array.isArray(runs)) return '';
    return runs.map((r) => r?.text || '').join('').trim();
  }

  function isArtistRun(run) {
    const pageType =
      run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
    return pageType === 'MUSIC_PAGE_TYPE_ARTIST';
  }

  function extractArtistBrowseIdFromByline(bylineObj) {
    const runs = bylineObj?.runs;
    if (!Array.isArray(runs)) return '';
    for (const run of runs) {
      if (isArtistRun(run)) {
        const bid = run?.navigationEndpoint?.browseEndpoint?.browseId || '';
        if (bid) return bid;
      }
    }
    return '';
  }

  function extractArtistFromByline(bylineObj) {
    const runs = bylineObj?.runs;
    if (!Array.isArray(runs) || runs.length === 0) return '';

    const artistRuns = runs
      .filter((r) => isArtistRun(r) && (r?.text || '').trim())
      .map((r) => r.text.trim());
    if (artistRuns.length > 0) {
      return artistRuns.join(', ');
    }

    for (const run of runs) {
      const text = (run?.text || '').trim();
      if (!text || text === '•' || text === ',' || text === '&') continue;
      if (NON_ARTIST_LABELS.has(text.toLowerCase())) continue;
      if (
        /\b(views|likes|plays|ditonton|diputar|suka)\b/i.test(text) ||
        /^\d+:\d+(:\d+)?$/.test(text) ||
        /^\d{4}$/.test(text)
      ) {
        continue;
      }
      return text;
    }
    return '';
  }

  function extractDurationFromRuns(runs) {
    if (!Array.isArray(runs)) return 0;
    for (let i = runs.length - 1; i >= 0; i--) {
      const sec = parseDurationSec(runs[i]?.text);
      if (sec > 0) return sec;
    }
    return 0;
  }

  function getMusicVideoType(watchEndpoint) {
    return (
      watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType || ''
    );
  }

  function setMusicVideoTypeAtv(watchEndpoint) {
    if (!watchEndpoint || typeof watchEndpoint !== 'object') return;
    if (!watchEndpoint.watchEndpointMusicSupportedConfigs) {
      watchEndpoint.watchEndpointMusicSupportedConfigs = {};
    }
    if (!watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig) {
      watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig = {};
    }
    watchEndpoint.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType =
      'MUSIC_VIDEO_TYPE_ATV';
  }

  function findFirstWatchEndpoint(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const found = findFirstWatchEndpoint(obj[i]);
        if (found) return found;
      }
      return null;
    }
    if (obj.watchEndpoint?.videoId) return obj.watchEndpoint;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const found = findFirstWatchEndpoint(obj[keys[i]]);
      if (found) return found;
    }
    return null;
  }

  function extractResponsiveItems(root) {
    const items = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.musicResponsiveListItemRenderer) {
        const r = node.musicResponsiveListItemRenderer;
        const title = getRunsText(
          r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
        );
        const bylineObj =
          r?.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text;
        const artist = extractArtistFromByline(bylineObj);
        const artistBrowseId = extractArtistBrowseIdFromByline(bylineObj);
        const durationSec =
          extractDurationFromRuns(
            r?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs
          ) || extractDurationFromRuns(bylineObj?.runs);
        const we = findFirstWatchEndpoint(r);
        if (we?.videoId) {
          const thumbnails =
            r?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || null;
          items.push({
            title,
            artist,
            artistBrowseId,
            videoId: we.videoId,
            playlistId: we.playlistId || '',
            musicVideoType: getMusicVideoType(we),
            durationSec,
            thumbnails
          });
        }
        return;
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) walk(node[keys[i]]);
    }
    walk(root);
    return items;
  }

  function extractPlaylistPanelItems(root) {
    const items = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.playlistPanelVideoRenderer) {
        const r = node.playlistPanelVideoRenderer;
        const we = r?.navigationEndpoint?.watchEndpoint;
        if (r?.videoId) {
          items.push({
            title: getRunsText(r?.title?.runs),
            artist:
              extractArtistFromByline(r?.longBylineText) ||
              extractArtistFromByline(r?.shortBylineText),
            artistBrowseId:
              extractArtistBrowseIdFromByline(r?.longBylineText) ||
              extractArtistBrowseIdFromByline(r?.shortBylineText),
            videoId: r.videoId,
            playlistId: we?.playlistId || '',
            musicVideoType: getMusicVideoType(we),
            durationSec: extractDurationFromRuns(r?.lengthText?.runs),
            selected: Boolean(r.selected)
          });
        }
        return;
      }
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) walk(node[keys[i]]);
    }
    walk(root);
    return items;
  }

  function splitArtistTokens(artistStr) {
    return (artistStr || '')
      .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b/i)
      .map((s) => normalizeArtist(s))
      .filter(Boolean);
  }

  function matchArtistsScore(targetArtistStr, candArtistStr, artistFromTitle) {
    const candFull = normalizeArtist(candArtistStr);
    if (!candFull) return 0;

    const candTokens = splitArtistTokens(candArtistStr);
    const candCompact = candFull.replace(/\s+/g, '');

    function scoreAgainst(refStr, exactPts, partialPts) {
      const refFull = normalizeArtist(refStr);
      if (!refFull) return -1;
      const refCompact = refFull.replace(/\s+/g, '');
      if (candFull === refFull || candCompact === refCompact) {
        return exactPts;
      }
      if (
        candFull.includes(refFull) ||
        refFull.includes(candFull) ||
        (refCompact.length >= 4 &&
          (candCompact.includes(refCompact) || refCompact.includes(candCompact)))
      ) {
        return partialPts;
      }
      const refTokens = splitArtistTokens(refStr);
      for (const rt of refTokens) {
        const rtCompact = rt.replace(/\s+/g, '');
        for (const ct of candTokens) {
          const ctCompact = ct.replace(/\s+/g, '');
          if (
            ct === rt ||
            ctCompact === rtCompact ||
            (rt.length >= 3 && (ct.includes(rt) || rt.includes(ct)))
          ) {
            return partialPts;
          }
        }
      }
      return -1;
    }

    const byChannel = scoreAgainst(targetArtistStr, 80, 50);
    const byTitle = artistFromTitle ? scoreAgainst(artistFromTitle, 70, 45) : -1;
    return Math.max(byChannel, byTitle);
  }

  function scoreAtvCandidate(track, cand, index) {
    const targetVariants = extractVariantTags(track.title);
    const candVariants = extractVariantTags(cand.title);

    for (const tag of candVariants) {
      if (!targetVariants.has(tag)) return -1;
    }
    for (const tag of targetVariants) {
      if (!candVariants.has(tag)) return -1;
    }

    const { cleaned, artistFromTitle, titleWithoutArtist } = parseTitleParts(
      track.title,
      track.artist
    );
    const targetBase = normalizeTitle(cleaned);
    const targetNoArtist = titleWithoutArtist ? normalizeTitle(titleWithoutArtist) : '';
    const candBase = normalizeTitle(cand.title);
    const candParenSubs = extractParenSubtitles(cand.title);
    const targetParenSubs = extractParenSubtitles(track.title);
    if ((!candBase && candParenSubs.length === 0) || (!targetBase && !targetNoArtist)) {
      return -1;
    }

    let titleScore = 0;
    const candFullNorm = normalizeUnicode(cleanSongTitle(cand.title));
    const targetFullNorm = normalizeUnicode(cleaned);
    const targetNoArtistFullNorm = titleWithoutArtist
      ? normalizeUnicode(titleWithoutArtist)
      : '';

    const exactParenMatch =
      (targetBase && candParenSubs.includes(targetBase)) ||
      (targetNoArtist && candParenSubs.includes(targetNoArtist)) ||
      (candBase && targetParenSubs.includes(candBase)) ||
      targetParenSubs.some((sub) => candParenSubs.includes(sub));

    if (
      (candFullNorm && candFullNorm === targetFullNorm) ||
      (targetNoArtistFullNorm && candFullNorm === targetNoArtistFullNorm)
    ) {
      titleScore = 120;
    } else if (
      (candBase && candBase === targetBase) ||
      (targetNoArtist && candBase === targetNoArtist)
    ) {
      titleScore = 100;
    } else if (exactParenMatch) {
      titleScore = 105;
    } else if (
      candBase &&
      ((targetNoArtist &&
        (candBase.includes(targetNoArtist) || targetNoArtist.includes(candBase))) ||
        (targetBase && (candBase.includes(targetBase) || targetBase.includes(candBase))))
    ) {
      const ref = targetNoArtist || targetBase;
      const shorterLen = Math.min(candBase.length, ref.length);
      const longerLen = Math.max(candBase.length, ref.length);
      if (shorterLen < 3 || shorterLen / longerLen < 0.45) return -1;
      titleScore = 45;
    } else {
      return -1;
    }

    let artistScore = 0;
    const targetFeat = extractFeaturedArtistsFromTitle(track.title);
    const candFeat = extractFeaturedArtistsFromTitle(cand.title);
    const effectiveTargetArtist =
      targetFeat && !normalizeArtist(track.artist).includes(normalizeArtist(targetFeat))
        ? [track.artist, targetFeat].filter(Boolean).join(', ')
        : track.artist;
    const effectiveCandArtist =
      candFeat && !normalizeArtist(cand.artist).includes(normalizeArtist(candFeat))
        ? [cand.artist, candFeat].filter(Boolean).join(', ')
        : cand.artist;

    const hasTargetArtist = Boolean(
      normalizeArtist(effectiveTargetArtist) || normalizeArtist(artistFromTitle)
    );
    const hasCandArtist = Boolean(normalizeArtist(effectiveCandArtist));

    if (hasTargetArtist && hasCandArtist) {
      artistScore = matchArtistsScore(effectiveTargetArtist, effectiveCandArtist, artistFromTitle);
      if (artistScore < 0) return -1;
    }

    let durationScore = 0;
    const targetDur = Number(track.durationSec) || 0;
    const candDur = Number(cand.durationSec) || 0;
    if (targetDur > 0 && candDur > 0) {
      const diff = candDur - targetDur;
      if (Math.abs(diff) <= 15) {
        durationScore = 25;
      } else if (diff < 0 && diff >= -90) {
        durationScore = 5;
      } else if (diff > 60) {
        durationScore = -45;
      } else if (candDur < 45 && targetDur >= 90) {
        return -1;
      }
    }

    const rankBonus = Math.max(0, 10 - index);
    return titleScore + artistScore + durationScore + rankBonus;
  }

  function pickBestCandidate(track, candidates, omvId, minScore) {
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!c?.videoId || c.videoId === omvId) continue;
      if (c.musicVideoType !== 'MUSIC_VIDEO_TYPE_ATV') continue;
      const score = scoreAtvCandidate(track, c, i);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best?.videoId && bestScore >= minScore ? best : null;
  }

  function stripViewsAndLikesFromByline(bylineObj) {
    const runs = bylineObj?.runs;
    if (!Array.isArray(runs) || runs.length === 0) return false;
    const hasVideoStats = runs.some((r) =>
      /\b(views|likes|ditonton|suka)\b/i.test(r?.text || '')
    );
    if (!hasVideoStats) return false;

    const cleaned = [];
    for (let i = 0; i < runs.length; i++) {
      const text = runs[i]?.text || '';
      if (/\b(views|likes|ditonton|suka)\b/i.test(text)) {
        // Drop preceding bullet separator if present
        if (cleaned.length > 0 && /^\s*[•·]\s*$/.test(cleaned[cleaned.length - 1]?.text || '')) {
          cleaned.pop();
        }
        continue;
      }
      cleaned.push(runs[i]);
    }
    while (cleaned.length > 0 && /^\s*[•·]\s*$/.test(cleaned[cleaned.length - 1]?.text || '')) {
      cleaned.pop();
    }
    if (cleaned.length === 0) return false;
    bylineObj.runs = cleaned;
    return true;
  }

  window.__ytmLiteBoot = window.__ytmLiteBoot || {};
  window.__ytmLiteBoot.matcher = {
    isResolvableNonAtvType,
    extractVariantTags,
    cleanSongTitle,
    normalizeUnicode,
    normalizeTitle,
    normalizeArtist,
    extractParenSubtitles,
    parseTitleParts,
    parseDurationSec,
    getRunsText,
    extractArtistBrowseIdFromByline,
    extractArtistFromByline,
    extractDurationFromRuns,
    getMusicVideoType,
    setMusicVideoTypeAtv,
    findFirstWatchEndpoint,
    extractResponsiveItems,
    extractPlaylistPanelItems,
    matchArtistsScore,
    scoreAtvCandidate,
    pickBestCandidate,
    stripViewsAndLikesFromByline
  };
})();
