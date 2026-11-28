const VARIANT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['remix', /\b(remix|rmx|rework|re-?edit|reimagined|refix|redo|bootleg|mashup|megamix|flip|vip\s*mix|club\s*mix|dub\s*mix|extended\s*mix|radio\s*mix|dj\s*set)\b/i],
    ['mix', /\b(dj\s+mix|extended\s*version|club\s*version|dub\s*version)\b/i],
    ['live', /\b(live|concert|unplugged|tiny\s*desk|live\s*session|live\s*at|live\s*from|the\s*first\s*take|first\s*take|colors\s*show|live\s*lounge|vevo\s*live|bbc\s*radio|live\s*performance|in\s*studio)\b/i],
    ['acoustic', /\b(acoustic|stripped|piano\s*version|guitar\s*version|orchestral|symphonic|string\s*version|music\s*box|lullaby|8[\s-]?bit|chiptune)\b/i],
    ['instrumental', /\b(instrumental|karaoke|backing\s*track|minus\s*one)\b/i],
    ['acapella', /\b(a\s*cappella|acapella|vocals\s*only)\b/i],
    ['sped_up', /\b(sped\s*up|speed\s*up|nightcore|fast\s*version|pitched|pitch\s*up)\b/i],
    ['slowed', /\b(slowed|super\s*slowed|ultra\s*slowed|reverb|chopped|screwed)\b/i],
    ['cover', /\b(cover|tribute|parody)\b/i],
    ['lofi', /\b(lo[\s-]?fi|8d\s*audio|8d|16d)\b/i],
    ['koplo', /\b(koplo|dangdut|jedag\s*jedug|jj|funkot|breakbeat|phonk|hardstyle)\b/i],
    ['demo', /\b(demo)\b/i]
  ];

  const COVER_ARTIST_RE =
    /\b(tribute|karaoke|lullaby|kidz\s+bop|8[\s-]?bit|ringtone|music\s+box|backing\s+track|piano\s+players|string\s+quartet|cover\s+band|instrumental\s+band|cover\s+version)\b/i;

  const NON_ARTIST_DASH_SUFFIX_RE =
    /^(?:remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|ost|soundtrack|from\s+.+|theme\s+(?:song|from).*|official\b.*|live\b.*|acoustic\b.*|instrumental\b.*|karaoke\b.*|remix\b.*|slowed\b.*|sped\s*up\b.*|nightcore\b.*|clean\b.*|explicit\b.*|radio\s+edit\b.*|single\s+version\b.*|album\s+version\b.*|bonus\s+track\b.*|deluxe\b.*|teaser\b.*|trailer\b.*|lyric(?:s)?\b.*|audio\b.*|visualizer\b.*|performance\b.*|dance\s+practice\b.*|color\s+coded\b.*|pt\.?\s*\d+.*|part\s*\d+.*|prod\.?\b.*|feat\.?\b.*|ft\.?\b.*|.+\s+(?:ver\.?|version|edit|remix|mix|ost))$/i;

  const LIKELY_LABEL_CHANNEL_RE =
    /\b(vevo|records|recording|recordings|music|entertainment|ent\.?|labels|label|studio|studios|media|channel|tv|official|playlist|1thek|smtown|hybe|jyp|yg|stone\s+music|warner|sony|universal|atlantic|republic|columbia|interscope|capitol|def\s+jam|spinnin|monstercat|ncs|trap\s+nation|proximity|majestic|cloudkid|colors)\b/i;

  const BENIGN_VERSION_DESCRIPTOR_RE =
    /^(?:album|original|single|studio|full|official|explicit|explicit\s+album|standard|main|master|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|mono|stereo|dolby\s+atmos|spatial\s+audio|hi[\s-]?res)$/i;

  const STANDALONE_ALT_QUALIFIER_RE =
    /^(?:clean|censored|edited|inst\.?|mr|tv\s*size|anime\s*size|game\s*size|radio\s*edit|single\s*edit|album\s*edit|short\s*edit|english|eng|en|japanese|jpn|jp|korean|kor|kr|chinese|chn|cn|zh|tw|spanish|esp|french|german|italian|portuguese|indonesian|indo|id|orchestra|piano|band|rock|ballad|jazz|holiday|christmas|solo|duet|choir|choral)$/i;

  const VERSION_ALIASES: Record<string, string> = {
    en: 'english',
    eng: 'english',
    jpn: 'japanese',
    jp: 'japanese',
    kor: 'korean',
    kr: 'korean',
    chn: 'chinese',
    cn: 'chinese',
    zh: 'chinese',
    tw: 'chinese',
    id: 'indonesian',
    indo: 'indonesian',
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

  const BYLINE_STAT_RE =
    /(?:\b(?:views?|likes?|plays?|ditonton|diputar|suka|vistas?|reproducciones|vues?|aufrufe|visualizações)\b|回視聴|高評価|조회수|좋아요|次觀看|次观看|次播放|点赞)/i;

  function isVideoStatText(text: string | null | undefined): boolean {
    return BYLINE_STAT_RE.test(text || '');
  }

  function isVideoStatRun(run: YtmRun | undefined): boolean {
    if (!run || run.navigationEndpoint) return false;
    return isVideoStatText(run.text);
  }

  function isResolvableNonAtvType(
    mvType: string,
    track: Partial<YtmTrackMeta> | null = null
  ): boolean {
    if (!mvType || mvType === 'MUSIC_VIDEO_TYPE_ATV') return false;
    if (mvType === 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE') {
      // Labels sometimes add official MVs into YouTube Podcast playlists (e.g. SMTOWN LIVE),
      // causing /next to tag them PODCAST_EPISODE even though the byline is a real MUSIC_PAGE_TYPE_ARTIST.
      const hasArtistChannel = Boolean(
        track?.artistBrowseId && String(track.artistBrowseId).startsWith('UC')
      );
      const dur = Number(track?.durationSec) || 0;
      return hasArtistChannel && (dur === 0 || dur <= 900);
    }
    return true;
  }

  function matchCoreVariantTags(str: string): Set<string> {
    const tags = new Set<string>();
    if (!str) return tags;
    for (const [tag, regex] of VARIANT_PATTERNS) {
      if (regex.test(str)) tags.add(tag);
    }
    if (/[\(\[]\s*dj\b/i.test(str)) {
      tags.add('remix');
    }
    return tags;
  }

  function addNormalizedVersionTag(tags: Set<string>, rawDesc: string): void {
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

  function extractVariantTags(str: string): Set<string> {
    const tags = matchCoreVariantTags(str);
    if (!str) return tags;

    // 1. Parenthetical / bracketed alternate version qualifiers: (Hot Chili ver.), (English ver.), (Clean), (Radio Edit)
    const parenRe = /[\(\[]([^\)\]]+)[\)\]]/g;
    let m: RegExpExecArray | null;
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

  function cleanSongTitle(rawTitle: string): string {
    return (rawTitle || '')
      .replace(
        /[\(\[\|【]\s*(official\s*)?(music\s*|performance\s*|dance\s*|choreography\s*|track\s*|stage\s*|special\s*)?(video|mv|m\/v|lyric\s*video|lyrics|audio|visualizer|practice|hd|4k|hq|full\s*video|explicit|official\s*lyric\s*video|official\s*audio)[^\)\]】]*[\)\]】]?/gi,
        ' '
      )
      .replace(/\s*[-–—|]\s*official\s*(music\s*|performance\s*|lyric\s*)?(video|mv|m\/v|audio|visualizer).*$/i, '')
      .replace(/\s+\b(?:official\s+)?(?:music\s+video|performance\s+video|dance\s+practice|m\/v|mv|lyric\s+video|official\s+audio|official\s+video|official\s+visualizer)\b\s*$/i, '')
      .replace(/[“”"‘’']/g, (ch) => (ch === "'" || ch === '’' ? "'" : ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeUnicode(str: string): string {
    return (str || '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function normalizeTitle(str: string): string {
    return normalizeUnicode(
      cleanSongTitle(str)
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s*\[[^\]]*\]\s*/g, ' ')
        .replace(/\s*【[^】]*】\s*/g, ' ')
        .replace(/(?:^|\s)[-–—]\s*[^()\[\]【】\-–—]{1,40}?\s+(?:ver\.?|version|edit)\s*[-–—]?(?=\s|$)/gi, ' ')
        .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    );
  }

  function extractFeaturedArtistsFromTitle(rawTitle: string): string {
    if (!rawTitle) return '';
    const cleaned = cleanSongTitle(rawTitle);
    const feats: string[] = [];
    const parenRe = /[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]]+)[\)\]]/gi;
    let m: RegExpExecArray | null;
    while ((m = parenRe.exec(cleaned)) !== null) {
      const name = m[1].replace(/\s+of\s+.+$/i, '').trim();
      if (name) feats.push(name);
    }
    if (feats.length === 0) {
      const inlineM = cleaned.match(/\b(?:feat\.?|ft\.?|featuring)\s+([^(\[\-–—]+)/i);
      if (inlineM) {
        const name = inlineM[1].replace(/\s+of\s+.+$/i, '').trim();
        if (name) feats.push(name);
      }
    }
    return feats.join(', ');
  }

  function normalizeArtist(str: string): string {
    return normalizeUnicode(
      (str || '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/\bofficial$/i, '')
        .replace(/vevo$/i, '')
    );
  }

  function extractParenSubtitles(rawTitle: string): string[] {
    const cleaned = cleanSongTitle(rawTitle);
    const subs: string[] = [];
    const regex = /[\(\[]([^\)\]]+)[\)\]]/g;
    let m: RegExpExecArray | null;
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

  function stripLeadingArtistPrefix(cleanedTitle: string, artistStr: string): string {
    if (!cleanedTitle || !artistStr) return '';
    const primaryArtist = artistStr.split(/,|&|\(/)[0].trim();
    if (!primaryArtist || primaryArtist.length < 2) return '';
    const escaped = primaryArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}(?:\\s*\\([^)]*\\))?(?:\\s*[-–—:]|\\s+)\\s*(.+)$`, 'i');
    const m = cleanedTitle.match(re);
    return m ? m[1].trim() : '';
  }

  function isLikelyLabelChannel(artistStr: string): boolean {
    return Boolean(artistStr && LIKELY_LABEL_CHANNEL_RE.test(artistStr));
  }

  function hasWholeWordPhrase(haystack: string, needle: string): boolean {
    if (!haystack || !needle || needle.length < 2) return false;
    if (haystack === needle) return true;
    return ` ${haystack} `.includes(` ${needle} `);
  }

  function parseTitleParts(rawTitle: string, rawArtist = ''): ParsedTitleParts {
    const cleaned = cleanSongTitle(rawTitle);

    // Handle CJK quotation format: e.g. YOASOBI「アイドル」 or YOASOBI「アイドル」(English ver.)
    const cjkQuoteMatch = cleaned.match(
      /^(.+?)\s*[「『]([^」』]+)[」』](?:\s*((?:\([^)]*\)|\[[^\]]*\]|【[^】]*】).*))?$/
    );
    if (cjkQuoteMatch) {
      const left = cjkQuoteMatch[1].trim();
      const inside = cjkQuoteMatch[2].trim();
      const tail = (cjkQuoteMatch[3] || '').trim();
      if (left && inside) {
        return {
          cleaned,
          artistFromTitle: left,
          titleWithoutArtist: tail ? `${inside} ${tail}` : inside
        };
      }
    }

    // Handle K-Pop / label quoted MV title format: e.g. aespa 에스파 'Supernova' MV or Artist 'Song' (Live)
    const singleQuoteMatch = cleaned.match(
      /^(.+?)\s+'([^']{2,80})'(?:\s*((?:\([^)]*\)|\[[^\]]*\]|【[^】]*】).*))?$/
    );
    if (singleQuoteMatch) {
      const left = singleQuoteMatch[1].trim();
      const inside = singleQuoteMatch[2].trim();
      const tail = (singleQuoteMatch[3] || '').trim();
      if (left && inside) {
        return {
          cleaned,
          artistFromTitle: left,
          titleWithoutArtist: tail ? `${inside} ${tail}` : inside
        };
      }
    }

    const dashMatch = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dashMatch) {
      const left = dashMatch[1].trim();
      const right = dashMatch[2].trim();
      const rightIsSuffix = NON_ARTIST_DASH_SUFFIX_RE.test(right);
      const hasRawArtist = Boolean(normalizeArtist(rawArtist));

      if (hasRawArtist) {
        const leftMatchesArtist = matchArtistsScore(rawArtist, left, '') >= 50;
        const rightMatchesArtist = !rightIsSuffix && matchArtistsScore(rawArtist, right, '') >= 50;

        if (leftMatchesArtist) {
          return { cleaned, artistFromTitle: left, titleWithoutArtist: right };
        }
        if (rightMatchesArtist) {
          return { cleaned, artistFromTitle: right, titleWithoutArtist: left };
        }
        if (rightIsSuffix) {
          return { cleaned, artistFromTitle: '', titleWithoutArtist: left };
        }
        if (isLikelyLabelChannel(rawArtist)) {
          return { cleaned, artistFromTitle: left, titleWithoutArtist: right };
        }
        return { cleaned, artistFromTitle: '', titleWithoutArtist: '' };
      }

      if (rightIsSuffix) {
        return { cleaned, artistFromTitle: '', titleWithoutArtist: left };
      }
      return {
        cleaned,
        artistFromTitle: left,
        titleWithoutArtist: right
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

  function parseDurationSec(text: string | undefined): number {
    if (!text) return 0;
    const m = String(text).trim().match(/^(?:(\d+):)?(\d+):(\d{2})$/);
    if (!m) return 0;
    const hours = m[1] ? Number(m[1]) : 0;
    const mins = Number(m[2]);
    const secs = Number(m[3]);
    return hours * 3600 + mins * 60 + secs;
  }

  function getRunsText(runs: YtmRun[] | undefined): string {
    if (!Array.isArray(runs)) return '';
    return runs.map((r) => r?.text || '').join('').trim();
  }

  function isArtistRun(run: YtmRun | undefined): boolean {
    const pageType =
      run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType;
    return pageType === 'MUSIC_PAGE_TYPE_ARTIST';
  }

  function extractArtistBrowseIdFromByline(bylineObj: YtmRunsContainer | undefined): string {
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

  function extractArtistFromByline(bylineObj: YtmRunsContainer | undefined): string {
    const runs = bylineObj?.runs;
    if (!Array.isArray(runs) || runs.length === 0) return '';

    const artistRuns = runs
      .filter((r) => isArtistRun(r) && (r?.text || '').trim())
      .map((r) => (r.text || '').trim());
    if (artistRuns.length > 0) {
      return artistRuns.join(', ');
    }

    for (const run of runs) {
      const text = (run?.text || '').trim();
      if (!text || text === '•' || text === ',' || text === '&') continue;
      if (NON_ARTIST_LABELS.has(text.toLowerCase())) continue;
      if (
        isVideoStatRun(run) ||
        /^\d+:\d+(:\d+)?$/.test(text) ||
        /^\d{4}$/.test(text)
      ) {
        continue;
      }
      return text;
    }
    return '';
  }

  function extractDurationFromRuns(runs: YtmRun[] | undefined): number {
    if (!Array.isArray(runs)) return 0;
    for (let i = runs.length - 1; i >= 0; i--) {
      const sec = parseDurationSec(runs[i]?.text);
      if (sec > 0) return sec;
    }
    return 0;
  }

  function getMusicVideoType(watchEndpoint: YtmWatchEndpoint | null | undefined): string {
    return (
      watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType || ''
    );
  }

  function setMusicVideoTypeAtv(watchEndpoint: YtmWatchEndpoint | null | undefined): void {
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

  function findFirstWatchEndpoint(obj: unknown): YtmWatchEndpoint | null {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const found = findFirstWatchEndpoint(obj[i]);
        if (found) return found;
      }
      return null;
    }
    const rec = obj as Record<string, unknown>;
    const we = rec.watchEndpoint as YtmWatchEndpoint | undefined;
    if (we?.videoId) return we;
    const keys = Object.keys(rec);
    for (let i = 0; i < keys.length; i++) {
      const found = findFirstWatchEndpoint(rec[keys[i]]);
      if (found) return found;
    }
    return null;
  }

  function extractResponsiveItems(root: unknown): YtmTrackMeta[] {
    const items: YtmTrackMeta[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      const rec = node as Record<string, unknown>;
      if (rec.musicResponsiveListItemRenderer) {
        const r = rec.musicResponsiveListItemRenderer as YtmResponsiveListItemRenderer;
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
      if (rec.musicTwoRowItemRenderer) {
        const r = rec.musicTwoRowItemRenderer as YtmTwoRowItemRenderer;
        const we = r?.navigationEndpoint?.watchEndpoint || findFirstWatchEndpoint(r);
        if (we?.videoId) {
          const title = getRunsText(r?.title?.runs);
          const bylineObj = r?.subtitle;
          const artist = extractArtistFromByline(bylineObj);
          const artistBrowseId = extractArtistBrowseIdFromByline(bylineObj);
          const durationSec = extractDurationFromRuns(bylineObj?.runs);
          const thumbnails =
            r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || null;
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
      const keys = Object.keys(rec);
      for (let i = 0; i < keys.length; i++) walk(rec[keys[i]]);
    }
    walk(root);
    return items;
  }

  function extractPlaylistPanelItems(root: unknown): YtmTrackMeta[] {
    const items: YtmTrackMeta[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      const rec = node as Record<string, unknown>;
      if (rec.playlistPanelVideoRenderer) {
        const r = rec.playlistPanelVideoRenderer as YtmPlaylistPanelVideoRenderer;
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
      const keys = Object.keys(rec);
      for (let i = 0; i < keys.length; i++) walk(rec[keys[i]]);
    }
    walk(root);
    return items;
  }

  function splitArtistTokens(artistStr: string): string[] {
    return (artistStr || '')
      .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b/i)
      .map((s) => normalizeArtist(s))
      .filter(Boolean);
  }

  function matchArtistsScore(
    targetArtistStr: string,
    candArtistStr: string,
    artistFromTitle: string
  ): number {
    const candFull = normalizeArtist(candArtistStr);
    if (!candFull) return 0;

    const candTokens = splitArtistTokens(candArtistStr);
    const candCompact = candFull.replace(/\s+/g, '');

    function isSafePhraseOrCompactMatch(
      a: string,
      aCompact: string,
      b: string,
      bCompact: string
    ): boolean {
      const shorterLen = Math.min(a.length, b.length);
      const longerLen = Math.max(a.length, b.length);
      if (shorterLen >= 4 && shorterLen / longerLen >= 0.5) {
        if (hasWholeWordPhrase(a, b) || hasWholeWordPhrase(b, a)) {
          return true;
        }
      }
      const shorterCompact = Math.min(aCompact.length, bCompact.length);
      const longerCompact = Math.max(aCompact.length, bCompact.length);
      if (shorterCompact >= 5 && shorterCompact / longerCompact >= 0.72) {
        if (aCompact.includes(bCompact) || bCompact.includes(aCompact)) {
          return true;
        }
      }
      return false;
    }

    function scoreAgainst(refStr: string, exactPts: number, partialPts: number): number {
      const refFull = normalizeArtist(refStr);
      if (!refFull) return -1;
      const refCompact = refFull.replace(/\s+/g, '');
      if (candFull === refFull || candCompact === refCompact) {
        return exactPts;
      }
      if (isSafePhraseOrCompactMatch(candFull, candCompact, refFull, refCompact)) {
        return partialPts;
      }
      const refTokens = splitArtistTokens(refStr);
      for (const rt of refTokens) {
        const rtCompact = rt.replace(/\s+/g, '');
        for (const ct of candTokens) {
          const ctCompact = ct.replace(/\s+/g, '');
          if (ct === rt || (rtCompact.length >= 3 && ctCompact === rtCompact)) {
            return partialPts;
          }
          if (isSafePhraseOrCompactMatch(ct, ctCompact, rt, rtCompact)) {
            return partialPts;
          }
        }
      }
      return -1;
    }

    const byChannel = scoreAgainst(targetArtistStr, 80, 55);
    const byTitle = artistFromTitle ? scoreAgainst(artistFromTitle, 70, 45) : -1;
    return Math.max(byChannel, byTitle);
  }

  function scoreAtvCandidate(
    track: Partial<YtmTrackMeta> & { title: string; artist: string },
    cand: YtmTrackMeta,
    index: number
  ): number {
    const targetVariants = extractVariantTags(track.title);
    const candVariants = extractVariantTags(cand.title);

    for (const tag of candVariants) {
      if (!targetVariants.has(tag)) return -1;
    }
    for (const tag of targetVariants) {
      if (!candVariants.has(tag)) return -1;
    }

    // Reject tribute / karaoke / lullaby / cover-band ATV artists unless target also is one
    if (
      cand.artist &&
      COVER_ARTIST_RE.test(cand.artist) &&
      !COVER_ARTIST_RE.test(track.artist || '')
    ) {
      return -1;
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

    const refForSub = targetNoArtist || targetBase;
    const targetContainsCandWord =
      candBase &&
      candBase.length >= 4 &&
      ((targetNoArtist &&
        hasWholeWordPhrase(targetNoArtist, candBase) &&
        candBase.length / targetNoArtist.length >= 0.55) ||
        (targetBase &&
          hasWholeWordPhrase(targetBase, candBase) &&
          candBase.length / targetBase.length >= 0.55));

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
    } else if (targetContainsCandWord && refForSub) {
      titleScore = 55;
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

    const exactBrowseIdMatch = Boolean(
      track.artistBrowseId &&
        cand.artistBrowseId &&
        track.artistBrowseId === cand.artistBrowseId
    );

    const hasTargetArtist = Boolean(
      normalizeArtist(effectiveTargetArtist) || normalizeArtist(artistFromTitle)
    );
    const hasCandArtist = Boolean(normalizeArtist(effectiveCandArtist));

    if (exactBrowseIdMatch) {
      artistScore = 85;
    } else if (hasTargetArtist && hasCandArtist) {
      const baseArtistScore = matchArtistsScore(
        track.artist,
        cand.artist,
        artistFromTitle
      );
      const featArtistScore = matchArtistsScore(
        effectiveTargetArtist,
        effectiveCandArtist,
        artistFromTitle
      );
      artistScore = Math.max(baseArtistScore, featArtistScore);
      if (artistScore < 0) return -1;
    }

    // Small featured-artist tiebreaker so explicit feat. MVs prefer feat. ATVs
    if (targetFeat) {
      const candHasFeat = matchArtistsScore(targetFeat, effectiveCandArtist, '') >= 45;
      artistScore += candHasFeat ? 10 : -15;
    } else if (
      candFeat &&
      !hasWholeWordPhrase(normalizeArtist(effectiveTargetArtist), normalizeArtist(candFeat))
    ) {
      artistScore -= 5;
    }

    let durationScore = 0;
    const targetDur = Number(track.durationSec) || 0;
    const candDur = Number(cand.durationSec) || 0;
    if (targetDur > 0 && candDur > 0) {
      const diff = candDur - targetDur;
      if (candDur < 45 && targetDur >= 90) {
        return -1;
      }
      if (targetDur >= 90 && candDur < targetDur * 0.45) {
        return -1;
      }
      if (diff > 120) {
        return -1;
      }
      if (Math.abs(diff) <= 15) {
        durationScore = 25;
      } else if (diff < 0 && diff >= -90) {
        durationScore = 10;
      } else if (diff > 45) {
        durationScore = -40;
      } else if (diff < -90) {
        durationScore = -20;
      }
    }

    const rankBonus = Math.max(0, 10 - index);
    return titleScore + artistScore + durationScore + rankBonus;
  }

  function pickBestCandidate(
    track: Partial<YtmTrackMeta> & { title: string; artist: string },
    candidates: YtmTrackMeta[],
    omvId: string,
    minScore: number
  ): YtmTrackMeta | null {
    let best: YtmTrackMeta | null = null;
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

  function stripViewsAndLikesFromByline(bylineObj: YtmRunsContainer | undefined): boolean {
    const runs = bylineObj?.runs;
    if (!bylineObj || !Array.isArray(runs) || runs.length === 0) return false;
    const hasVideoStats = runs.some((r) => isVideoStatRun(r));
    if (!hasVideoStats) return false;

    const cleaned: YtmRun[] = [];
    for (let i = 0; i < runs.length; i++) {
      if (isVideoStatRun(runs[i])) {
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

  function extractTrackFromPlayerData(
    playerData: YtmPlayerData | null | undefined,
    origVideoId = ''
  ): YtmTrackMeta | null {
    const vd = playerData?.videoDetails;
    if (!vd?.videoId) return null;

    const mf = playerData?.microformat?.microformatDataRenderer;
    const rawTitle = vd.title || '';
    const rawAuthor = vd.author || '';
    const ownerName = mf?.pageOwnerDetails?.name || '';
    const mfTitle = mf?.title || '';
    const mfDesc = mf?.description || '';
    const mvType = vd.musicVideoType || '';

    const isEpisodePlaylistAuthor =
      /^Episode\s*[•·]/i.test(mfDesc) ||
      /\bplaylist\b/i.test(rawAuthor) ||
      /\blive\s+\d{4}\b/i.test(rawAuthor);
    const isLabelChannel =
      isLikelyLabelChannel(rawAuthor) || isLikelyLabelChannel(ownerName);
    const suspiciousAuthor = isEpisodePlaylistAuthor || isLabelChannel;

    let artist = rawAuthor;
    const artistBrowseId = suspiciousAuthor ? '' : vd.channelId || '';
    let lowConfidenceAuthor = false;

    if (suspiciousAuthor && mfTitle) {
      const parsedMf = parseTitleParts(mfTitle, '');
      if (parsedMf.artistFromTitle) {
        artist = parsedMf.artistFromTitle;
      } else if (rawTitle) {
        const escapedTitle = rawTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixRe = new RegExp(`^(.+?)\\s*['"‘’“”「『\\-–—:]\\s*${escapedTitle}`, 'i');
        const pm = cleanSongTitle(mfTitle).match(prefixRe);
        if (pm?.[1]?.trim()) {
          artist = pm[1].trim();
        }
      }
    }

    if (suspiciousAuthor && artist === rawAuthor && rawTitle) {
      const parsedRaw = parseTitleParts(rawTitle, '');
      if (parsedRaw.artistFromTitle) {
        artist = parsedRaw.artistFromTitle;
      }
    }

    if (suspiciousAuthor && artist === rawAuthor) {
      if (isEpisodePlaylistAuthor) {
        artist = '';
      }
      lowConfidenceAuthor = true;
    }

    return {
      videoId: origVideoId || vd.videoId,
      title: rawTitle,
      artist,
      artistBrowseId,
      musicVideoType: mvType,
      durationSec: Number(vd.lengthSeconds) || 0,
      lowConfidenceAuthor
    };
  }

export {
  isResolvableNonAtvType,
  isLikelyLabelChannel,
  extractTrackFromPlayerData,
  extractVariantTags,
  extractFeaturedArtistsFromTitle,
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
  isVideoStatText,
  stripViewsAndLikesFromByline
};
