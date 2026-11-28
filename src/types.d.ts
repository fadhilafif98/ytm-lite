interface YtmThumbnail {
  url: string;
  width?: number;
  height?: number;
}

interface YtmBrowseEndpoint {
  browseId?: string;
  browseEndpointContextSupportedConfigs?: {
    browseEndpointContextMusicConfig?: {
      pageType?: string;
    };
  };
}

interface YtmWatchEndpoint {
  videoId?: string;
  playlistId?: string;
  watchEndpointMusicSupportedConfigs?: {
    watchEndpointMusicConfig?: {
      musicVideoType?: string;
    };
  };
}

interface YtmRun {
  text?: string;
  navigationEndpoint?: {
    browseEndpoint?: YtmBrowseEndpoint;
    watchEndpoint?: YtmWatchEndpoint;
  };
}

interface YtmRunsContainer {
  runs?: YtmRun[];
}

interface YtmPlaylistPanelVideoRenderer {
  videoId?: string;
  selected?: boolean;
  title?: YtmRunsContainer;
  longBylineText?: YtmRunsContainer;
  shortBylineText?: YtmRunsContainer;
  lengthText?: YtmRunsContainer;
  navigationEndpoint?: {
    watchEndpoint?: YtmWatchEndpoint;
  };
  thumbnail?: {
    thumbnails?: YtmThumbnail[];
  };
}

interface YtmPlaylistPanelVideoWrapperRenderer {
  primaryRenderer?: {
    playlistPanelVideoRenderer?: YtmPlaylistPanelVideoRenderer;
  };
  counterpart?: Array<{
    counterpartRenderer?: {
      playlistPanelVideoRenderer?: YtmPlaylistPanelVideoRenderer;
    };
  }>;
}

interface YtmResponsiveListItemRenderer {
  flexColumns?: Array<{
    musicResponsiveListItemFlexColumnRenderer?: {
      text?: YtmRunsContainer;
    };
  }>;
  fixedColumns?: Array<{
    musicResponsiveListItemFixedColumnRenderer?: {
      text?: YtmRunsContainer;
    };
  }>;
  playlistItemData?: {
    videoId?: string;
  };
  thumbnail?: {
    musicThumbnailRenderer?: {
      thumbnail?: {
        thumbnails?: YtmThumbnail[];
      };
    };
  };
}

interface YtmTwoRowItemRenderer {
  title?: YtmRunsContainer;
  subtitle?: YtmRunsContainer;
  navigationEndpoint?: {
    watchEndpoint?: YtmWatchEndpoint;
  };
  thumbnailRenderer?: {
    musicThumbnailRenderer?: {
      thumbnail?: {
        thumbnails?: YtmThumbnail[];
      };
    };
  };
}

interface YtmPlayerData {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    channelId?: string;
    lengthSeconds?: string | number;
    musicVideoType?: string;
    thumbnail?: {
      thumbnails?: YtmThumbnail[];
    };
  };
  microformat?: {
    microformatDataRenderer?: {
      title?: string;
      description?: string;
      pageOwnerDetails?: {
        name?: string;
        externalChannelId?: string;
      };
    };
  };
}

interface YtmTrackMeta {
  videoId: string;
  title: string;
  artist: string;
  artistBrowseId?: string;
  playlistId?: string;
  musicVideoType: string;
  durationSec: number;
  thumbnails?: YtmThumbnail[] | null;
  selected?: boolean;
  lowConfidenceAuthor?: boolean;
}

interface ParsedTitleParts {
  cleaned: string;
  artistFromTitle: string;
  titleWithoutArtist: string;
}

type YtmLiteSettings = {
  enabled: boolean;
  hideVideoFallback: boolean;
};

interface PersistentCacheEntry {
  a: string;
  u: string;
  t: number;
}

type PersistentCacheMap = Record<string, PersistentCacheEntry>;

interface HydrateCacheEntry {
  o: string;
  a: string;
  u: string;
}

interface RecentPlayerSwap {
  atvId: string;
  time: number;
}

interface ResolveWaitResult {
  resolved: boolean;
  timedOut: boolean;
}

interface ActiveSwapInfo {
  omvId: string;
  atvId: string;
  playlistId: string;
}

interface YtmMoviePlayer extends HTMLElement {
  getVideoData?: () => { video_id?: string } | undefined;
  getPlayerResponse?: () => YtmPlayerData | undefined;
  getCurrentTime?: () => number;
  getPlayerState?: () => number;
  loadVideoById?: (arg: string | { videoId: string; startSeconds?: number }) => void;
  cueVideoById?: (arg: string | { videoId: string; startSeconds?: number }) => void;
}

interface YtmCfg {
  get?: (key: string) => unknown;
  set?: (...args: unknown[]) => unknown;
  __ytmLiteSetHooked?: boolean;
}

interface YtmLiteXhrMeta {
  method: string;
  url: string;
  async: boolean;
  seq: number;
  headers: Record<string, string>;
}

interface Window {
  __ytmLiteInjected?: boolean;
  __ytmLiteContentLoaded?: boolean;
  ytcfg?: YtmCfg;
}

interface XMLHttpRequest {
  __ytmSeq?: number;
  __ytmLite?: YtmLiteXhrMeta | null;
}
