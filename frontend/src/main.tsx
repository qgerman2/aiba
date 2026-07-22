import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ApiJob = {
  id: string;
  processing_run_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  progress_current: number;
  progress_total: number;
  progress_percent: number;
  last_message: string | null;
  heartbeat_at: string;
  elapsed_seconds: number;
  upload_path: string | null;
  source_type?: "upload" | "youtube";
  source_url?: string | null;
  downloaded_audio_path?: string | null;
  thumbnail_path?: string | null;
  display_name: string | null;
  tags: string[];
  is_curated?: boolean;
  asset_tags?: string[];
  command?: string[];
  stdout?: string | null;
  stderr?: string | null;
  tail_stdout?: string;
  tail_stderr?: string;
  exit_code: number | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type ApiRun = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  output_dir: string;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

type GeneratedFile = {
  id: string;
  processing_run_id: string;
  file_kind: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
};

type StaticGeneratedFile = GeneratedFile & {
  static_url: string;
};

type ApiPhrase = {
  phrase_index: number;
  start_seconds: number;
  end_seconds: number;
  hanzi: string;
  pinyin: string;
};

type ApiCharacter = {
  char_index: number;
  phrase_char_index: number | null;
  start_seconds: number;
  end_seconds: number;
  hanzi: string;
  pinyin: string;
  is_estimated: boolean;
};

type ProcessingResponse = {
  job: ApiJob;
  run: ApiRun | null;
  output_files_available: GeneratedFile[];
};

type QueueResponse = {
  active_job_id: string | null;
  pending_in_memory: number;
  jobs: ApiJob[];
};

type StaticEntry = {
  job: ApiJob;
  run: ApiRun;
  files: StaticGeneratedFile[];
  phrases: ApiPhrase[];
  characters: ApiCharacter[];
};

type StaticBundle = {
  version: number;
  generated_at: string;
  entries: StaticEntry[];
};

type ServerQueueStatus =
  | {
      state: "checking";
      message: string;
    }
  | {
      state: "offline";
      message: string;
    }
  | {
      state: "idle" | "busy";
      message: string;
      activeJobId: string | null;
      pendingCount: number;
      activeJob: ApiJob | null;
    };

type TimestampSegment = {
  start: number;
  end: number;
  text: string;
};

type CharacterPrompt = {
  char: string;
  start: number;
  end: number;
  expected: string;
};

type PhrasePrompt = {
  phrase: TimestampSegment;
  chars: CharacterPrompt[];
};

type PhrasePanelItem =
  | {
      type: "char";
      charIndex: number;
      char: CharacterPrompt;
    }
  | {
      type: "punctuation";
      text: string;
    };

type MediaMode = "youtube" | "audio";

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  setPlaybackRate: (suggestedRate: number) => void;
  destroy: () => void;
};

type YouTubeConstructor = new (
  element: HTMLElement,
  options: {
    videoId: string;
    playerVars?: Record<string, number | string>;
    events?: {
      onReady?: () => void;
      onStateChange?: (event: { data: number }) => void;
    };
  }
) => YouTubePlayer;

declare global {
  interface Window {
    YT?: {
      Player: YouTubeConstructor;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type ViewMode = "home" | "entries" | "upload" | "player" | "about";

type CachedPlayerEntry = {
  jobId: string;
  runId: string;
  name: string;
  tags: string[];
  isCurated: boolean;
  assetTags: string[];
  audioFileId: string;
  audioStaticUrl?: string | null;
  sourceType: "upload" | "youtube";
  sourceUrl: string | null;
  thumbnailFileId: string | null;
  thumbnailStaticUrl?: string | null;
  phrasePrompts: PhrasePrompt[];
  answers: Record<string, string>;
  hintedKeys: Record<string, boolean>;
  cachedAt: string;
};

const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? "https://backend.java-kokanue.ts.net:443";
const githubRepoUrl = "https://github.com/qgerman2/aiba";
const playerCacheKey = "aiba.playerCache.v1";
const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const maxCachedEntries = 8;
const syllablePlaybackTailSeconds = 1;
const syllablePlaybackLeadInSeconds = 2;

function apiUrl(path: string) {
  return `${apiBaseUrl}${path}`;
}

function extractYouTubeVideoId(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v");
      }

      const parts = parsed.pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex((part) =>
        ["embed", "shorts", "live"].includes(part)
      );

      if (markerIndex >= 0) {
        return parts[markerIndex + 1] ?? null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function youtubeThumbnailUrl(url: string | null | undefined) {
  const videoId = extractYouTubeVideoId(url);
  return videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    const previousCallback = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };

    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.append(script);
    }
  });
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function isChineseCharacter(char: string) {
  return /\p{Script=Han}/u.test(char);
}

function normalizePinyin(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("ü", "v")
    .replaceAll("u:", "v")
    .replace(/\s+/g, "");
}

function buildPhrasePrompts(
  phrases: ApiPhrase[],
  characters: ApiCharacter[]
): PhrasePrompt[] {
  let charCursor = 0;

  return phrases.map((phrase) => {
    const phraseCharacters = Array.from(phrase.hanzi).filter(isChineseCharacter);
    const matchedCharacters: ApiCharacter[] = [];

    for (const phraseCharacter of phraseCharacters) {
      while (
        charCursor < characters.length &&
        characters[charCursor].hanzi !== phraseCharacter
      ) {
        charCursor += 1;
      }

      if (charCursor < characters.length) {
        matchedCharacters.push(characters[charCursor]);
        charCursor += 1;
      }
    }

    return {
      phrase: {
        start: phrase.start_seconds,
        end: phrase.end_seconds,
        text: phrase.hanzi
      },
      chars: matchedCharacters.map((char) => ({
        char: char.hanzi,
        start: char.start_seconds,
        end: char.end_seconds,
        expected: normalizePinyin(char.pinyin)
      }))
    };
  });
}

function findActivePhraseIndex(phrases: TimestampSegment[], currentTime: number) {
  const index = phrases.findIndex(
    (phrase) => currentTime >= phrase.start && currentTime < phrase.end
  );

  return index >= 0 ? index : null;
}

function findActiveCharacterIndex(chars: CharacterPrompt[], currentTime: number) {
  const index = chars.findIndex(
    (char) => currentTime >= char.start && currentTime < char.end
  );

  return index >= 0 ? index : null;
}

function buildPhrasePanelItems(prompt: PhrasePrompt): PhrasePanelItem[] {
  let charIndex = 0;

  return Array.from(prompt.phrase.text).flatMap((text) => {
    if (!isChineseCharacter(text)) {
      return { type: "punctuation", text };
    }

    const char = prompt.chars[charIndex];
    charIndex += 1;

    return char ? { type: "char", charIndex: charIndex - 1, char } : [];
  });
}

function entryName(job: ApiJob) {
  return job.display_name || job.upload_path?.split("/").at(-1) || job.id;
}

function hasStaticTag(tags: string[]) {
  return tags.some((tag) => tag.trim().toLowerCase() === "static");
}

function isHomeEligibleEntry(entry: ApiJob) {
  return Boolean(entry.is_curated) || hasStaticTag(entry.asset_tags ?? entry.tags);
}

function isVisibleServerEntry(entry: ApiJob) {
  return entry.status !== "failed";
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: "Queued",
    upload_saved: "Upload saved",
    download_queued: "Download queued",
    downloading: "Downloading YouTube audio",
    run_started: "Processing started",
    chunking: "Chunking audio",
    asr: "Transcribing",
    phrase_split: "Splitting phrases",
    pinyin: "Generating pinyin",
    alignment: "Aligning timestamps",
    timestamp_mapping: "Mapping timestamps",
    db_save: "Saving results",
    completed: "Completed",
    failed: "Failed"
  };

  return labels[stage] ?? stage;
}

function uniqueEntryTags(entry: ApiJob) {
  const tags = new Map<string, string>();

  for (const tag of [...entry.tags, ...(entry.asset_tags ?? [])]) {
    const normalized = tag.trim();

    if (normalized) {
      tags.set(normalized.toLowerCase(), normalized);
    }
  }

  return [...tags.values()];
}

function formatDate(value: string | null) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function readCachedEntries(): CachedPlayerEntry[] {
  try {
    const raw = window.localStorage.getItem(playerCacheKey);

    return raw ? (JSON.parse(raw) as CachedPlayerEntry[]) : [];
  } catch {
    return [];
  }
}

function writeCachedEntries(entries: CachedPlayerEntry[]) {
  window.localStorage.setItem(
    playerCacheKey,
    JSON.stringify(entries.slice(0, maxCachedEntries))
  );
}

function cachedProgressFor(jobId: string | null | undefined) {
  if (!jobId) {
    return null;
  }

  return readCachedEntries().find((entry) => entry.jobId === jobId) ?? null;
}

function answersWithFirstPinyin(
  prompts: PhrasePrompt[],
  savedAnswers: Record<string, string> | undefined
) {
  const nextAnswers = { ...(savedAnswers ?? {}) };

  for (let phraseIndex = 0; phraseIndex < prompts.length; phraseIndex += 1) {
    const firstChar = prompts[phraseIndex].chars[0];

    if (!firstChar) {
      continue;
    }

    const key = `${phraseIndex}:0`;

    if (!nextAnswers[key]) {
      nextAnswers[key] = firstChar.expected;
    }

    break;
  }

  return nextAnswers;
}

function playerHref(jobId: string) {
  return `${window.location.pathname}?entry=${encodeURIComponent(jobId)}`;
}

function viewHref(view: ViewMode) {
  if (view === "home") {
    return window.location.pathname;
  }

  return `${window.location.pathname}?view=${encodeURIComponent(view)}`;
}

function isViewMode(value: string | null): value is ViewMode {
  return (
    value === "home" ||
    value === "entries" ||
    value === "upload" ||
    value === "player" ||
    value === "about"
  );
}

function initialViewMode(): ViewMode {
  const params = new URLSearchParams(window.location.search);

  if (params.get("entry")) {
    return "player";
  }

  const view = params.get("view");
  return isViewMode(view) ? view : "home";
}

function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const playUntilRef = useRef<number | null>(null);
  const pendingMediaSeekRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [entries, setEntries] = useState<ApiJob[]>([]);
  const [entryThumbnailUrls, setEntryThumbnailUrls] = useState<Record<string, string>>({});
  const [staticEntries, setStaticEntries] = useState<Record<string, StaticEntry>>({});
  const [cachedEntries, setCachedEntries] = useState<CachedPlayerEntry[]>(() =>
    readCachedEntries()
  );
  const [viewMode, setViewMode] = useState<ViewMode>(() => initialViewMode());
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("entry")
  );
  const [selectedRunName, setSelectedRunName] = useState("aiba");
  const [selectedRunTags, setSelectedRunTags] = useState<string[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [youtubeVideoId, setYoutubeVideoId] = useState<string | null>(null);
  const [mediaMode, setMediaMode] = useState<MediaMode>("audio");
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isYouTubeReady, setIsYouTubeReady] = useState(false);
  const [phrasePrompts, setPhrasePrompts] = useState<PhrasePrompt[]>([]);
  const [selectedPhraseIndex, setSelectedPhraseIndex] = useState(0);
  const [focusedCharIndex, setFocusedCharIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [hanziHintKey, setHanziHintKey] = useState<string | null>(null);
  const [pinyinHintKey, setPinyinHintKey] = useState<string | null>(null);
  const [hintedKeys, setHintedKeys] = useState<Record<string, boolean>>({});
  const [currentTime, setCurrentTime] = useState(0);
  const [highlightCurrentPhrase, setHighlightCurrentPhrase] = useState(true);
  const [highlightCurrentSyllable, setHighlightCurrentSyllable] = useState(true);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [isLoadingRun, setIsLoadingRun] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [youtubeInputUrl, setYoutubeInputUrl] = useState("");
  const [uploadSourceType, setUploadSourceType] = useState<"audio" | "youtube">(
    "audio"
  );
  const [uploadName, setUploadName] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<ProcessingResponse | null>(
    null
  );
  const [isUploading, setIsUploading] = useState(false);
  const [uploadedEntryId, setUploadedEntryId] = useState<string | null>(null);
  const [serverQueueStatus, setServerQueueStatus] = useState<ServerQueueStatus>({
    state: "checking",
    message: "Checking server..."
  });

  useEffect(() => {
    void loadEntries();

    const entryId = new URLSearchParams(window.location.search).get("entry");

    if (entryId) {
      void loadEntryFromUrl(entryId);
    }
  }, []);

  useEffect(() => {
    document.title = "aiba";

    const nextUrl =
      viewMode === "player" && selectedEntryId
        ? playerHref(selectedEntryId)
        : viewHref(viewMode);

    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [selectedEntryId, viewMode]);

  useEffect(() => {
    if (viewMode !== "home" && viewMode !== "upload") {
      return;
    }

    let isCurrent = true;

    async function refreshQueueStatus() {
      const nextStatus = await getServerQueueStatus();

      if (isCurrent) {
        setServerQueueStatus(nextStatus);
      }
    }

    void refreshQueueStatus();
    const intervalId = window.setInterval(refreshQueueStatus, 5000);

    return () => {
      isCurrent = false;
      window.clearInterval(intervalId);
    };
  }, [viewMode]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      youtubePlayerRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (mediaMode !== "youtube" || !youtubeVideoId || !youtubeHostRef.current) {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      return;
    }

    let isCurrent = true;
    setIsYouTubeReady(false);

    void loadYouTubeApi().then(() => {
      if (!isCurrent || !youtubeHostRef.current || !window.YT?.Player) {
        return;
      }

      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = new window.YT.Player(youtubeHostRef.current, {
        videoId: youtubeVideoId,
        playerVars: {
          modestbranding: 1,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: () => {
            if (isCurrent) {
              setIsYouTubeReady(true);
              youtubePlayerRef.current?.setPlaybackRate(playbackSpeed);
            }
          },
          onStateChange: (event) => {
            if (event.data === window.YT?.PlayerState.PLAYING) {
              startTrackingPlayback();
            }

            if (
              event.data === window.YT?.PlayerState.PAUSED ||
              event.data === window.YT?.PlayerState.ENDED
            ) {
              if (event.data === window.YT?.PlayerState.ENDED) {
                playUntilRef.current = null;
              }
              stopTrackingPlayback();
            }
          }
        }
      });
    });

    return () => {
      isCurrent = false;
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      setIsYouTubeReady(false);
    };
  }, [mediaMode, youtubeVideoId]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }

    if (mediaMode === "youtube" && isYouTubeReady) {
      youtubePlayerRef.current?.setPlaybackRate(playbackSpeed);
    }
  }, [isYouTubeReady, mediaMode, playbackSpeed, audioUrl]);

  useEffect(() => {
    if (pendingMediaSeekRef.current === null) {
      return;
    }

    if (mediaMode === "youtube" && !isYouTubeReady) {
      return;
    }

    const nextTime = pendingMediaSeekRef.current;
    pendingMediaSeekRef.current = null;
    seekMedia(nextTime);
  }, [mediaMode, isYouTubeReady, audioUrl]);

  useEffect(() => {
    const visualViewport = window.visualViewport;

    if (!visualViewport) {
      return;
    }

    const viewport = visualViewport;

    function updateKeyboardOffset() {
      const keyboardOffset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop
      );

      document.documentElement.style.setProperty(
        "--keyboard-offset",
        `${keyboardOffset}px`
      );
    }

    updateKeyboardOffset();
    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      document.documentElement.style.removeProperty("--keyboard-offset");
    };
  }, []);

  const filteredEntries = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    return entries.filter((entry) => {
      if (!isVisibleServerEntry(entry)) {
        return false;
      }

      const entryTags = uniqueEntryTags(entry);
      const searchable = [entryName(entry), ...entryTags]
        .join(" ")
        .toLowerCase();
      const matchesSearch = query.length === 0 || searchable.includes(query);
      const matchesTags = selectedTags.every((selectedTag) =>
        entryTags.some(
          (tag) => tag.trim().toLowerCase() === selectedTag.toLowerCase()
        )
      );

      return matchesSearch && matchesTags;
    });
  }, [entries, searchTerm, selectedTags]);

  const homeServerEntries = useMemo(
    () => entries.filter(isVisibleServerEntry).filter(isHomeEligibleEntry).slice(0, 3),
    [entries]
  );

  const homeTags = useMemo(() => {
    const tags = new Map<string, string>();

    for (const entry of cachedEntries) {
      for (const tag of [...entry.tags, ...(entry.assetTags ?? [])]) {
        const normalized = tag.trim();

        if (normalized) {
          tags.set(normalized.toLowerCase(), normalized);
        }
      }
    }

    for (const entry of entries.filter(isVisibleServerEntry).filter(isHomeEligibleEntry)) {
      for (const tag of uniqueEntryTags(entry)) {
        const normalized = tag.trim();

        if (normalized) {
          tags.set(normalized.toLowerCase(), normalized);
        }
      }
    }

    return [...tags.values()].sort((left, right) => left.localeCompare(right));
  }, [cachedEntries, entries]);

  const entriesTags = useMemo(() => {
    const tags = new Map<string, string>();

    for (const entry of filteredEntries) {
      for (const tag of uniqueEntryTags(entry)) {
        tags.set(tag.toLowerCase(), tag);
      }
    }

    return [...tags.values()].sort((left, right) => left.localeCompare(right));
  }, [filteredEntries]);

  const phrases = useMemo(
    () => phrasePrompts.map((prompt) => prompt.phrase),
    [phrasePrompts]
  );

  const activePhraseIndex = useMemo(
    () => findActivePhraseIndex(phrases, currentTime),
    [phrases, currentTime]
  );

  const selectedPhrase = phrasePrompts[selectedPhraseIndex] ?? null;
  const currentPhrase =
    activePhraseIndex === null
      ? selectedPhrase
      : phrasePrompts[activePhraseIndex] ?? selectedPhrase;
  const activeCharacterIndex = selectedPhrase
    ? findActiveCharacterIndex(selectedPhrase.chars, currentTime)
    : null;

  function mergeEntries(serverJobs: ApiJob[], staticMap: Record<string, StaticEntry>) {
    const entriesById = new Map<string, ApiJob>();

    for (const entry of Object.values(staticMap)) {
      entriesById.set(entry.job.id, entry.job);
    }

    for (const job of serverJobs) {
      entriesById.set(job.id, job);
    }

    return [...entriesById.values()];
  }

  async function loadEntries(nextSelectedId?: string) {
    try {
      setEntriesError(null);
      const data = await fetchJson<QueueResponse>("/queue?limit=100");
      const staticMap = await loadStaticBundle();
      const mergedEntries = mergeEntries(data.jobs, staticMap);

      setStaticEntries(staticMap);
      setEntries(mergedEntries);
      void loadEntryThumbnails(mergedEntries);

      const nextSelection = nextSelectedId ?? null;

      if (nextSelection) {
        setSelectedEntryId(nextSelection);
        const entry = mergedEntries.find((job) => job.id === nextSelection);

        if (entry?.processing_run_id) {
          if (staticMap[entry.id]) {
            loadStaticRun(staticMap[entry.id]);
          } else {
            await loadRun(entry.processing_run_id, entryName(entry), entry);
          }
          setViewMode("player");
        }
      }
    } catch (unknownError) {
      try {
        const staticMap = await loadStaticBundle();
        const staticJobs = Object.values(staticMap).map((entry) => entry.job);
        setStaticEntries(staticMap);
        setEntries(staticJobs);
        setEntriesError(null);

        const nextSelection = nextSelectedId ?? null;

        if (nextSelection && staticMap[nextSelection]) {
          loadStaticRun(staticMap[nextSelection]);
          setViewMode("player");
        }
      } catch {
        setEntriesError(
          unknownError instanceof Error
            ? unknownError.message
            : "Could not load entries"
        );
      }
    }
  }

  async function loadStaticBundle() {
    const response = await fetch("./static/aiba-static.json");

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const bundle = (await response.json()) as StaticBundle;
    return Object.fromEntries(
      bundle.entries.map((entry) => [entry.job.id, entry])
    );
  }

  async function loadEntryThumbnails(nextEntries: ApiJob[]) {
    const youtubeEntries = nextEntries.filter(
      (entry) =>
        isVisibleServerEntry(entry) &&
        entry.status === "succeeded" &&
        entry.processing_run_id &&
        entry.source_type === "youtube"
    );

    if (youtubeEntries.length === 0) {
      setEntryThumbnailUrls({});
      return;
    }

    const pairs = await Promise.all(
      youtubeEntries.map(async (entry) => {
        const fallbackUrl = youtubeThumbnailUrl(entry.source_url);

        try {
          const filesData = await fetchJson<{ files: GeneratedFile[] }>(
            `/runs/${entry.processing_run_id}/frontend-files`
          );
          const thumbnailFile = filesData.files.find(
            (file) => file.file_kind === "thumbnail"
          );

          return [
            entry.id,
            thumbnailFile
              ? apiUrl(`/files/${thumbnailFile.id}/download`)
              : fallbackUrl
          ] as const;
        } catch {
          return [entry.id, fallbackUrl] as const;
        }
      })
    );

    setEntryThumbnailUrls(
      Object.fromEntries(
        pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1]))
      )
    );
  }

  async function loadEntryFromUrl(entryId: string) {
    const cached = cachedEntries.find((entry) => entry.jobId === entryId);

    try {
      const status = await fetchJson<ProcessingResponse>(`/processing/${entryId}`);

      setSelectedEntryId(entryId);

      if (status.job.status === "succeeded" && status.job.processing_run_id) {
        await loadRun(
          status.job.processing_run_id,
          entryName(status.job),
          status.job
        );
        setViewMode("player");
        return;
      }

      setPlayerError("This entry is not ready yet.");
      setViewMode("player");
    } catch {
      try {
        const staticMap =
          Object.keys(staticEntries).length > 0
            ? staticEntries
            : await loadStaticBundle();
        setStaticEntries(staticMap);

        if (staticMap[entryId]) {
          loadStaticRun(staticMap[entryId]);
          setViewMode("player");
          return;
        }
      } catch {
        // Fall through to the local cache fallback.
      }

      if (cached) {
        loadCachedRun(cached);
        setViewMode("player");
        return;
      }

      setPlayerError("Entry could not be loaded.");
      setViewMode("player");
    }
  }

  function loadStaticRun(entry: StaticEntry) {
    const audioFile = entry.files.find((file) => file.file_kind === "audio");
    const thumbnailFile = entry.files.find(
      (file) => file.file_kind === "thumbnail"
    );

    if (!audioFile) {
      setPlayerError("Static entry has no playable audio file.");
      return;
    }

    const prompts = buildPhrasePrompts(entry.phrases, entry.characters);
    const entrySourceType = entry.job.source_type ?? "upload";
    const entrySourceUrl = entry.job.source_url ?? null;
    const nextYoutubeVideoId =
      entrySourceType === "youtube" ? extractYouTubeVideoId(entrySourceUrl) : null;
    const cachedProgress = cachedProgressFor(entry.job.id);
    const nextAnswers = answersWithFirstPinyin(
      prompts,
      cachedProgress?.answers
    );

    setSelectedEntryId(entry.job.id);
    setSelectedRunName(entryName(entry.job));
    setSelectedRunTags(uniqueEntryTags(entry.job));
    setAudioUrl(audioFile.static_url);
    setThumbnailUrl(thumbnailFile?.static_url ?? youtubeThumbnailUrl(entrySourceUrl));
    setYoutubeVideoId(nextYoutubeVideoId);
    setMediaMode(nextYoutubeVideoId ? "youtube" : "audio");
    setIsYouTubeReady(false);
    setPhrasePrompts(prompts);
    setSelectedPhraseIndex(0);
    setFocusedCharIndex(0);
    setAnswers(nextAnswers);
    setHanziHintKey(null);
    setPinyinHintKey(null);
    setHintedKeys(cachedProgress?.hintedKeys ?? {});
    setCurrentTime(0);
    setPlayerError(null);
    playUntilRef.current = null;
    updateEntryUrl(entry.job.id);

    cachePlayerEntry({
      jobId: entry.job.id,
      runId: entry.run.id,
      name: entryName(entry.job),
      tags: entry.job.tags,
      isCurated: Boolean(entry.job.is_curated),
      assetTags: entry.job.asset_tags ?? entry.job.tags,
      audioFileId: audioFile.id,
      audioStaticUrl: audioFile.static_url,
      sourceType: entrySourceType,
      sourceUrl: entrySourceUrl,
      thumbnailFileId: thumbnailFile?.id ?? null,
      thumbnailStaticUrl: thumbnailFile?.static_url ?? null,
      phrasePrompts: prompts,
      answers: nextAnswers,
      hintedKeys: cachedProgress?.hintedKeys ?? {},
      cachedAt: new Date().toISOString()
    });
  }

  async function loadRun(runId: string, name: string, entry?: ApiJob) {
    setIsLoadingRun(true);
    setPlayerError(null);

    try {
      const [phrasesData, charactersData, filesData] = await Promise.all([
        fetchJson<{ phrases: ApiPhrase[] }>(`/runs/${runId}/phrases`),
        fetchJson<{ characters: ApiCharacter[] }>(`/runs/${runId}/characters`),
        fetchJson<{ files: GeneratedFile[] }>(`/runs/${runId}/frontend-files`)
      ]);
      const audioFile = filesData.files.find(
        (file) => file.file_kind === "audio"
      );
      const thumbnailFile = filesData.files.find(
        (file) => file.file_kind === "thumbnail"
      );

      if (!audioFile) {
        throw new Error("Run has no playable audio file");
      }

      const prompts = buildPhrasePrompts(
        phrasesData.phrases,
        charactersData.characters
      );
      const entrySourceType = entry?.source_type ?? "upload";
      const entrySourceUrl = entry?.source_url ?? null;
      const nextYoutubeVideoId =
        entrySourceType === "youtube" ? extractYouTubeVideoId(entrySourceUrl) : null;
      const cachedProgress = cachedProgressFor(entry?.id);
      const nextAnswers = answersWithFirstPinyin(
        prompts,
        cachedProgress?.answers
      );

      setSelectedRunName(name);
      setSelectedRunTags(entry ? uniqueEntryTags(entry) : []);
      setAudioUrl(apiUrl(`/files/${audioFile.id}/download`));
      setThumbnailUrl(
        thumbnailFile
          ? apiUrl(`/files/${thumbnailFile.id}/download`)
          : youtubeThumbnailUrl(entrySourceUrl)
      );
      setYoutubeVideoId(nextYoutubeVideoId);
      setMediaMode(nextYoutubeVideoId ? "youtube" : "audio");
      setIsYouTubeReady(false);
      setPhrasePrompts(prompts);
      setSelectedPhraseIndex(0);
      setFocusedCharIndex(0);
      setAnswers(nextAnswers);
      setHanziHintKey(null);
      setPinyinHintKey(null);
      setHintedKeys(cachedProgress?.hintedKeys ?? {});
      setCurrentTime(0);
      playUntilRef.current = null;

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }

      if (entry) {
        cachePlayerEntry({
          jobId: entry.id,
          runId,
          name,
          tags: entry.tags,
          isCurated: Boolean(entry.is_curated),
          assetTags: entry.asset_tags ?? entry.tags,
          audioFileId: audioFile.id,
          audioStaticUrl: staticEntries[entry.id]?.files.find(
            (file) => file.file_kind === "audio"
          )?.static_url,
          sourceType: entrySourceType,
          sourceUrl: entrySourceUrl,
          thumbnailFileId: thumbnailFile?.id ?? null,
          thumbnailStaticUrl: staticEntries[entry.id]?.files.find(
            (file) => file.file_kind === "thumbnail"
          )?.static_url,
          phrasePrompts: prompts,
          answers: nextAnswers,
          hintedKeys: cachedProgress?.hintedKeys ?? {},
          cachedAt: new Date().toISOString()
        });
      }
    } catch (unknownError) {
      if (entry && staticEntries[entry.id]) {
        loadStaticRun(staticEntries[entry.id]);
        return;
      }

      setPlayerError(
        unknownError instanceof Error
          ? unknownError.message
          : "Could not load run"
      );
    } finally {
      setIsLoadingRun(false);
    }
  }

  function cachePlayerEntry(entry: CachedPlayerEntry) {
    setCachedEntries((current) => {
      const stored = readCachedEntries();
      const mergedCurrent = [
        ...current,
        ...stored.filter(
          (storedEntry) =>
            !current.some((entry) => entry.jobId === storedEntry.jobId)
        )
      ];
      const existing = mergedCurrent.find(
        (cached) => cached.jobId === entry.jobId
      );
      const nextEntry = {
        ...entry,
        answers:
          Object.keys(entry.answers).length > 0
            ? entry.answers
            : existing?.answers ?? {},
        hintedKeys:
          Object.keys(entry.hintedKeys).length > 0
            ? entry.hintedKeys
            : existing?.hintedKeys ?? {}
      };
      const next = [
        nextEntry,
        ...mergedCurrent.filter((cached) => cached.jobId !== entry.jobId)
      ].slice(0, maxCachedEntries);

      writeCachedEntries(next);
      return next;
    });
  }

  function updateCachedProgress(
    nextAnswers: Record<string, string>,
    nextHintedKeys: Record<string, boolean>
  ) {
    if (!selectedEntryId) {
      return;
    }

    setCachedEntries((current) => {
      const stored = readCachedEntries();
      const mergedCurrent = [
        ...current,
        ...stored.filter(
          (storedEntry) =>
            !current.some((entry) => entry.jobId === storedEntry.jobId)
        )
      ];
      const existing = mergedCurrent.find(
        (entry) => entry.jobId === selectedEntryId
      );

      if (!existing) {
        return current;
      }

      const next = [
        {
          ...existing,
          answers: nextAnswers,
          hintedKeys: nextHintedKeys,
          cachedAt: new Date().toISOString()
        },
        ...mergedCurrent.filter((entry) => entry.jobId !== selectedEntryId)
      ].slice(0, maxCachedEntries);

      writeCachedEntries(next);
      return next;
    });
  }

  function loadCachedRun(entry: CachedPlayerEntry) {
    setSelectedEntryId(entry.jobId);
    setSelectedRunName(entry.name);
    setSelectedRunTags(
      [...entry.tags, ...(entry.assetTags ?? [])]
        .map((tag) => tag.trim())
        .filter(Boolean)
        .filter(
          (tag, index, tags) =>
            tags.findIndex(
              (candidate) => candidate.toLowerCase() === tag.toLowerCase()
            ) === index
        )
    );
    setAudioUrl(entry.audioStaticUrl ?? apiUrl(`/files/${entry.audioFileId}/download`));
    setThumbnailUrl(
      entry.thumbnailStaticUrl ??
      (entry.thumbnailFileId
        ? apiUrl(`/files/${entry.thumbnailFileId}/download`)
        : youtubeThumbnailUrl(entry.sourceUrl))
    );
    const nextYoutubeVideoId =
      entry.sourceType === "youtube" ? extractYouTubeVideoId(entry.sourceUrl) : null;
    setYoutubeVideoId(nextYoutubeVideoId);
    setMediaMode(nextYoutubeVideoId ? "youtube" : "audio");
    setIsYouTubeReady(false);
    setPhrasePrompts(entry.phrasePrompts);
    setSelectedPhraseIndex(0);
    setFocusedCharIndex(0);
    setAnswers(entry.answers ?? {});
    setHanziHintKey(null);
    setPinyinHintKey(null);
    setHintedKeys(entry.hintedKeys ?? {});
    setCurrentTime(0);
    setPlayerError(null);
    updateEntryUrl(entry.jobId);
  }

  function cachedEntryThumbnail(entry: CachedPlayerEntry) {
    if (entry.thumbnailStaticUrl) {
      return entry.thumbnailStaticUrl;
    }

    if (entry.thumbnailFileId) {
      return apiUrl(`/files/${entry.thumbnailFileId}/download`);
    }

    return youtubeThumbnailUrl(entry.sourceUrl);
  }

  function serverEntryThumbnail(entry: ApiJob) {
    const staticThumbnail = staticEntries[entry.id]?.files.find(
      (file) => file.file_kind === "thumbnail"
    )?.static_url;

    return (
      staticThumbnail ??
      entryThumbnailUrls[entry.id] ??
      youtubeThumbnailUrl(entry.source_url)
    );
  }

  async function getServerQueueStatus(): Promise<ServerQueueStatus> {
    try {
      await fetchJson<{ ok: boolean; db: boolean }>("/health");
      const queue = await fetchJson<QueueResponse>("/queue?limit=10");
      const activeJob =
        queue.jobs.find((job) => job.id === queue.active_job_id) ?? null;

      if (queue.active_job_id || queue.pending_in_memory > 0) {
        return {
          state: "busy",
          message: activeJob
            ? `${entryName(activeJob)} is ${activeJob.stage} at ${activeJob.progress_percent}%`
            : `${queue.pending_in_memory} queued`,
          activeJobId: queue.active_job_id,
          pendingCount: queue.pending_in_memory,
          activeJob
        };
      }

      return {
        state: "idle",
        message: "Server is idle",
        activeJobId: null,
        pendingCount: 0,
        activeJob: null
      };
    } catch (unknownError) {
      return {
        state: "offline",
        message:
          unknownError instanceof Error
            ? `Server unavailable: ${unknownError.message}`
            : "Server unavailable"
      };
    }
  }

  async function selectEntry(entry: ApiJob) {
    setSelectedEntryId(entry.id);

    if (entry.status !== "succeeded" || !entry.processing_run_id) {
      setPlayerError("This entry is not ready yet.");
      return;
    }

    if (staticEntries[entry.id]) {
      loadStaticRun(staticEntries[entry.id]);
      setViewMode("player");
      return;
    }

    await loadRun(entry.processing_run_id, entryName(entry), entry);
    setViewMode("player");
    updateEntryUrl(entry.id);
  }

  async function handleUploadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (uploadSourceType === "audio" && !uploadFile) {
      setUploadError("Choose an audio file first.");
      return;
    }

    if (uploadSourceType === "youtube" && !youtubeInputUrl.trim()) {
      setUploadError("Enter a YouTube link first.");
      return;
    }

    setUploadError(null);
    setIsUploading(true);
    setUploadStatus(null);

    try {
      const formData = new FormData();

      if (uploadSourceType === "youtube") {
        formData.append("youtube_url", youtubeInputUrl.trim());
        if (uploadName.trim()) {
          formData.append("name", uploadName.trim());
        }
      } else if (uploadFile) {
        formData.append("audio", uploadFile);
        formData.append(
          "name",
          uploadName.trim() || uploadFile.name.replace(/\.[^.]+$/, "")
        );
      }

      for (const tag of uploadTags.split(",")) {
        const normalizedTag = tag.trim();

        if (normalizedTag) {
          formData.append("tags", normalizedTag);
        }
      }

      const upload = await fetchJson<{
        job_id: string;
        status: "queued";
      }>(uploadSourceType === "youtube" ? "/youtube/process" : "/audio/process", {
        method: "POST",
        body: formData
      });

      setUploadedEntryId(upload.job_id);
      await pollProcessing(upload.job_id);
      await loadEntries();
    } catch (unknownError) {
      setUploadError(
        unknownError instanceof Error ? unknownError.message : "Upload failed"
      );
    } finally {
      setIsUploading(false);
    }
  }

  async function pollProcessing(jobId: string) {
    while (true) {
      const status = await fetchJson<ProcessingResponse>(`/processing/${jobId}`);
      setUploadStatus(status);

      if (status.job.status === "succeeded") {
        if (status.job.processing_run_id) {
          await loadRun(
            status.job.processing_run_id,
            entryName(status.job),
            status.job
          );
          setSelectedEntryId(status.job.id);
          updateEntryUrl(status.job.id);
        }
        return;
      }

      if (status.job.status === "failed") {
        throw new Error(
          status.job.error_message ??
            status.run?.error_message ??
            "Processing failed"
        );
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  }

  function answerKey(phraseIndex: number, charIndex: number) {
    return `${phraseIndex}:${charIndex}`;
  }

  function updateEntryUrl(jobId: string) {
    window.history.replaceState(null, "", playerHref(jobId));
  }

  function toggleTagFilter(tag: string) {
    setSelectedTags((current) =>
      current.some((selectedTag) => selectedTag.toLowerCase() === tag.toLowerCase())
        ? current.filter(
            (selectedTag) => selectedTag.toLowerCase() !== tag.toLowerCase()
          )
        : [...current, tag]
    );
    setViewMode("entries");
  }

  function pauseMedia() {
    if (mediaMode === "youtube") {
      youtubePlayerRef.current?.pauseVideo();
      return;
    }

    audioRef.current?.pause();
  }

  function seekMedia(seconds: number) {
    if (mediaMode === "youtube") {
      youtubePlayerRef.current?.seekTo(seconds, true);
      setCurrentTime(seconds);
      return;
    }

    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
    }
  }

  function playMedia() {
    if (mediaMode === "youtube") {
      youtubePlayerRef.current?.playVideo();
      startTrackingPlayback();
      return;
    }

    if (audioRef.current) {
      void audioRef.current.play();
    }
  }

  function currentMediaTime() {
    if (mediaMode === "youtube") {
      return youtubePlayerRef.current?.getCurrentTime() ?? currentTime;
    }

    return audioRef.current?.currentTime ?? currentTime;
  }

  function isMediaPlaying() {
    if (mediaMode === "youtube") {
      return (
        youtubePlayerRef.current?.getPlayerState() ===
        window.YT?.PlayerState.PLAYING
      );
    }

    return Boolean(audioRef.current && !audioRef.current.paused && !audioRef.current.ended);
  }

  function changeMediaMode(nextMode: MediaMode) {
    if (nextMode === mediaMode) {
      return;
    }

    const syncedTime = currentMediaTime();
    pauseMedia();
    pendingMediaSeekRef.current = syncedTime;
    setMediaMode(nextMode);
    setCurrentTime(syncedTime);
  }

  function playPhrase(index: number) {
    const phrase = phrasePrompts[index]?.phrase;

    if (!phrase) {
      return;
    }

    setSelectedPhraseIndex(index);
    playUntilRef.current = phrase.end;
    seekMedia(phrase.start);
    playMedia();
  }

  function playUntilCharacter(index: number, charIndex: number) {
    const prompt = phrasePrompts[index];
    const targetChar = prompt?.chars[charIndex];
    const stopAt =
      prompt && targetChar
        ? Math.min(
            Math.max(targetChar.start, targetChar.end) +
              syllablePlaybackTailSeconds,
            prompt.phrase.end
          )
        : prompt?.phrase.end;

    if (!prompt || stopAt === undefined) {
      return;
    }

    const startAt = targetChar
      ? Math.max(0, targetChar.start - syllablePlaybackLeadInSeconds)
      : prompt.phrase.start;

    setSelectedPhraseIndex(index);
    playUntilRef.current = stopAt;
    seekMedia(startAt);
    playMedia();
  }

  function movePhrase(offset: number) {
    if (phrasePrompts.length === 0) {
      return;
    }

    const nextIndex = Math.min(
      Math.max(selectedPhraseIndex + offset, 0),
      phrasePrompts.length - 1
    );

    setFocusedCharIndex(0);
    setSelectedPhraseIndex(nextIndex);
    playUntilRef.current = null;
    pauseMedia();
    seekMedia(phrasePrompts[nextIndex]?.phrase.start ?? 0);
  }

  function updateCurrentTime(time: number) {
    setCurrentTime(time);

    if (playUntilRef.current !== null && time >= playUntilRef.current) {
      pauseMedia();
      playUntilRef.current = null;
    }
  }

  function stopTrackingPlayback() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function trackPlayback() {
    if (!isMediaPlaying()) {
      stopTrackingPlayback();
      return;
    }

    updateCurrentTime(currentMediaTime());
    animationFrameRef.current = requestAnimationFrame(trackPlayback);
  }

  function startTrackingPlayback() {
    stopTrackingPlayback();
    animationFrameRef.current = requestAnimationFrame(trackPlayback);
  }

  function focusInput(phraseIndex: number, charIndex: number) {
    inputRefs.current[answerKey(phraseIndex, charIndex)]?.focus({
      preventScroll: true
    });
  }

  function moveInputFocus(
    phraseIndex: number,
    charIndex: number,
    offset: -1 | 1
  ) {
    const currentPhraseChars = phrasePrompts[phraseIndex]?.chars.length ?? 0;
    const nextCharIndex = charIndex + offset;

    if (nextCharIndex >= 0 && nextCharIndex < currentPhraseChars) {
      focusInput(phraseIndex, nextCharIndex);
      return;
    }

    if (offset === 1) {
      for (
        let nextPhraseIndex = phraseIndex + 1;
        nextPhraseIndex < phrasePrompts.length;
        nextPhraseIndex += 1
      ) {
        const nextPhrase = phrasePrompts[nextPhraseIndex];

        if (nextPhrase.chars.length > 0) {
          setSelectedPhraseIndex(nextPhraseIndex);
          setFocusedCharIndex(0);
          window.setTimeout(() => focusInput(nextPhraseIndex, 0), 0);
          return;
        }
      }

      return;
    }

    for (
      let previousPhraseIndex = phraseIndex - 1;
      previousPhraseIndex >= 0;
      previousPhraseIndex -= 1
    ) {
      const previousPhrase = phrasePrompts[previousPhraseIndex];
      const lastCharIndex = previousPhrase.chars.length - 1;

      if (lastCharIndex >= 0) {
        setSelectedPhraseIndex(previousPhraseIndex);
        setFocusedCharIndex(lastCharIndex);
        window.setTimeout(
          () => focusInput(previousPhraseIndex, lastCharIndex),
          0
        );
        return;
      }
    }
  }

  function revealHanziHint(phraseIndex: number, charIndex: number) {
    const key = answerKey(phraseIndex, charIndex);
    const nextHintedKeys = {
      ...hintedKeys,
      [key]: true
    };

    setHanziHintKey(key);
    setHintedKeys(nextHintedKeys);
    updateCachedProgress(answers, nextHintedKeys);
    focusInput(phraseIndex, charIndex);
  }

  function revealPinyinHint(phraseIndex: number, charIndex: number) {
    const expected = phrasePrompts[phraseIndex]?.chars[charIndex]?.expected;

    if (!expected) {
      return;
    }

    const key = answerKey(phraseIndex, charIndex);
    const nextHintedKeys = {
      ...hintedKeys,
      [key]: true
    };

    setPinyinHintKey(key);
    setHintedKeys(nextHintedKeys);
    updateCachedProgress(answers, nextHintedKeys);
    focusInput(phraseIndex, charIndex);
  }

  function clearPlayerProgress() {
    setAnswers({});
    setHintedKeys({});
    setHanziHintKey(null);
    setPinyinHintKey(null);
    updateCachedProgress({}, {});
  }

  function handleInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    phraseIndex: number,
    charIndex: number,
    charCount: number
  ) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveInputFocus(phraseIndex, charIndex, -1);
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveInputFocus(phraseIndex, charIndex, 1);
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      revealHanziHint(phraseIndex, charIndex);
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      revealPinyinHint(phraseIndex, charIndex);
    }

    if (event.key === " ") {
      event.preventDefault();
      playUntilCharacter(phraseIndex, charIndex);
    }
  }

  const statusJob = uploadStatus?.job;
  const uploadYouTubeThumbnail =
    uploadSourceType === "youtube"
      ? youtubeThumbnailUrl(statusJob?.source_url ?? youtubeInputUrl)
      : null;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brandBlock">
          <span className="brandMark">aiba</span>
        </div>
        <nav className="menu" aria-label="Main">
          <button
            type="button"
            className={viewMode === "home" ? "active" : ""}
            onClick={() => setViewMode("home")}
          >
            Home
          </button>
          <button
            type="button"
            className={viewMode === "entries" ? "active" : ""}
            onClick={() => setViewMode("entries")}
          >
            Entries
          </button>
          <button
            type="button"
            className={viewMode === "upload" ? "active" : ""}
            onClick={() => setViewMode("upload")}
          >
            Upload
          </button>
          <button
            type="button"
            className={viewMode === "player" ? "active" : ""}
            onClick={() => setViewMode("player")}
            disabled={!audioUrl}
          >
            Player
          </button>
          <button
            type="button"
            className={viewMode === "about" ? "active" : ""}
            onClick={() => setViewMode("about")}
          >
            About
          </button>
        </nav>
      </aside>

      {viewMode === "home" && (
        <section className="page">
          <div className="pageHeader">
            <div>
              <p className="label">Overview</p>
              <h1>Home</h1>
              <p className="pageDescription">
                Chinese 听力 practice tool for replaying audio until syllable
                recognition feels familiar. Upload custom audio or link a
                YouTube video to process it into the practice database.
              </p>
            </div>
          </div>

          <div className="homeGrid">
            <section className="homeSection wide">
              <div className="sectionHeader">
                <h2>Tags</h2>
              </div>
              <div className="tagSelector" aria-label="Filter entries by tag">
                {homeTags.map((tag) => (
                  <button
                    type="button"
                    className={[
                      "tagChip",
                      selectedTags.some(
                        (selectedTag) =>
                          selectedTag.toLowerCase() === tag.toLowerCase()
                      )
                        ? "active"
                        : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={tag}
                    onClick={() => toggleTagFilter(tag)}
                  >
                    {tag}
                  </button>
                ))}
                {homeTags.length === 0 && (
                  <p className="emptyText">No tags available yet.</p>
                )}
              </div>
            </section>

            <section className="homeSection">
              <div className="sectionHeader">
                <h2>Recently Used</h2>
              </div>
              <div className="entryList full compact">
                {cachedEntries.map((entry) => (
                  <a
                    className="entryButton"
                    href={playerHref(entry.jobId)}
                    key={entry.jobId}
                    onClick={(event) => {
                      event.preventDefault();
                      loadCachedRun(entry);
                      setViewMode("player");
                    }}
                  >
                    {cachedEntryThumbnail(entry) && (
                      <img
                        className="entryThumbnail"
                        src={cachedEntryThumbnail(entry) ?? undefined}
                        alt=""
                        aria-hidden="true"
                      />
                    )}
                    <span className="entryTitle">{entry.name}</span>
                    <span className="statusPill succeeded">cached</span>
                    <span className="entryMeta">{formatDate(entry.cachedAt)}</span>
                    <span className="tagRow">
                      {entry.tags.length > 0 ? entry.tags.join(", ") : "untagged"}
                    </span>
                  </a>
                ))}
                {cachedEntries.length === 0 && (
                  <p className="emptyText">No cached entries yet.</p>
                )}
              </div>
            </section>

            <section className="homeSection">
              <div className="sectionHeader">
                <h2>Latest From Server</h2>
              </div>
              {entriesError && <p className="errorText">{entriesError}</p>}
              <div className="entryList full compact">
                {homeServerEntries.map((entry) => (
                  <button
                    type="button"
                    className="entryButton"
                    key={entry.id}
                    onClick={() => void selectEntry(entry)}
                  >
                    {serverEntryThumbnail(entry) && (
                      <img
                        className="entryThumbnail"
                        src={serverEntryThumbnail(entry) ?? undefined}
                        alt=""
                        aria-hidden="true"
                      />
                    )}
                    <span className="entryTitle">{entryName(entry)}</span>
                    <span className="entryMeta">
                      {formatDate(entry.completed_at ?? entry.queued_at)}
                    </span>
                    <span className="tagRow">
                      {uniqueEntryTags(entry).length > 0
                        ? uniqueEntryTags(entry).map((tag) => (
                            <span className="entryTag" key={tag}>
                              {tag}
                            </span>
                          ))
                        : "untagged"}
                    </span>
                  </button>
                ))}
                {homeServerEntries.length === 0 && !entriesError && (
                  <p className="emptyText">No curated server entries found.</p>
                )}
              </div>
            </section>
          </div>
        </section>
      )}

      {viewMode === "about" && (
        <section className="page narrow">
          <div className="pageHeader">
            <div>
              <p className="label">Project</p>
              <h1>About</h1>
            </div>
          </div>

          <section className="aboutPanel">
            <p>Programmed by GPT-5.5.</p>
            <p>
              The backend uses FastAPI with Postgres for job metadata, generated
              file records, phrase timings, and character timings. Audio uploads
              are processed through an in-process queue that runs the ASR and
              alignment pipeline.
            </p>
            <p>
              Long audio is split locally with silence-based VAD before ASR.
              Chunk boundaries and per-chunk transcripts are stored in
              Postgres and a chunk manifest, while playback timestamps remain
              aligned to the original full audio.
            </p>
            <p>
              The AI stack runs Qwen/Qwen3-ASR-0.6B locally for transcription,
              Qwen/Qwen3-ForcedAligner-0.6B locally for character timing
              alignment, qwen3:4b-instruct through Ollama for phrase splitting,
              and pypinyin plus tone sandhi rules for numbered pinyin.
            </p>
            <p>
              Complaints, release questions, and bug reports can go to my
              Instagram. If you are wondering why it is called aiba, ask me.
            </p>
            <div className="aboutLinks">
              <a href={githubRepoUrl} target="_blank" rel="noreferrer">
                GitHub repo
              </a>
              <a href="https://www.instagram.com/germaaaaaaaaan" target="_blank" rel="noreferrer">
                @germaaaaaaaaan
              </a>
            </div>
          </section>
        </section>
      )}

      {viewMode === "entries" && (
        <section className="page">
          <div className="pageHeader">
            <div>
              <p className="label">Library</p>
              <h1>Entries</h1>
            </div>
            <button type="button" onClick={() => void loadEntries()}>
              Refresh
            </button>
          </div>

          <input
            className="searchInput"
            type="search"
            value={searchTerm}
            placeholder="Search name or tags"
            aria-label="Search entries by name or tags"
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          <section className="tagFilterPanel">
            <div className="sectionHeader">
              <h2>Tags</h2>
              {selectedTags.length > 0 && (
                <button
                  type="button"
                  className="clearFilterButton"
                  onClick={() => setSelectedTags([])}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="tagSelector" aria-label="Filter entries by tag">
              {entriesTags.map((tag) => (
                <button
                  type="button"
                  className={[
                    "tagChip",
                    selectedTags.some(
                      (selectedTag) =>
                        selectedTag.toLowerCase() === tag.toLowerCase()
                    )
                      ? "active"
                      : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={tag}
                  onClick={() => toggleTagFilter(tag)}
                >
                  {tag}
                </button>
              ))}
              {entriesTags.length === 0 && (
                <p className="emptyText">No tags available yet.</p>
              )}
            </div>
          </section>

          {entriesError && <p className="errorText">{entriesError}</p>}

          <div className="entryList full">
            {filteredEntries.map((entry) => (
              <button
                type="button"
                className={[
                  "entryButton",
                  selectedEntryId === entry.id ? "selected" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={entry.id}
                onClick={() => void selectEntry(entry)}
              >
                {serverEntryThumbnail(entry) && (
                  <img
                    className="entryThumbnail"
                    src={serverEntryThumbnail(entry) ?? undefined}
                    alt=""
                    aria-hidden="true"
                  />
                )}
                <span className="entryTitle">{entryName(entry)}</span>
                <span className="entryMeta">
                  {formatDate(entry.completed_at ?? entry.queued_at)}
                </span>
                <span className="tagRow">
                  {uniqueEntryTags(entry).length > 0
                    ? uniqueEntryTags(entry).map((tag) => (
                        <span className="entryTag" key={tag}>
                          {tag}
                        </span>
                      ))
                    : "untagged"}
                </span>
              </button>
            ))}

            {filteredEntries.length === 0 && (
              <p className="emptyText">No entries match this search.</p>
            )}
          </div>
        </section>
      )}

      {viewMode === "upload" && (
        <section className="page narrow">
          <div className="pageHeader">
            <div>
              <p className="label">New audio</p>
              <h1>Upload</h1>
            </div>
          </div>

          <section className="queueStatusBox" aria-live="polite">
            <div className="statusTopline">
              <span className={`serverDot ${serverQueueStatus.state}`} />
              <strong>{serverQueueStatus.message}</strong>
            </div>
            {"pendingCount" in serverQueueStatus && (
              <div className="statusGrid">
                <span>
                  {serverQueueStatus.activeJobId ? "Active job" : "No active job"}
                </span>
                <span>{serverQueueStatus.pendingCount} queued</span>
              </div>
            )}
          </section>

          <form className="uploadForm full" onSubmit={handleUploadSubmit}>
            <div className="sourceToggle" aria-label="Upload source">
              <button
                type="button"
                className={uploadSourceType === "audio" ? "active" : ""}
                onClick={() => setUploadSourceType("audio")}
              >
                Audio file
              </button>
              <button
                type="button"
                className={uploadSourceType === "youtube" ? "active" : ""}
                onClick={() => setUploadSourceType("youtube")}
              >
                YouTube link
              </button>
            </div>

            <label>
              <span>
                {uploadSourceType === "youtube"
                  ? "Name (blank uses YouTube title)"
                  : "Name"}
              </span>
              <input
                type="text"
                value={uploadName}
                placeholder={
                  uploadSourceType === "youtube"
                    ? "Use video title"
                    : "Lesson name"
                }
                onChange={(event) => setUploadName(event.target.value)}
              />
            </label>

            <label>
              <span>Tags (comma separated)</span>
              <input
                type="text"
                value={uploadTags}
                placeholder="U10, monologue, travel"
                onChange={(event) => setUploadTags(event.target.value)}
              />
            </label>

            {uploadSourceType === "audio" ? (
              <label>
                <span>Audio</span>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) =>
                    setUploadFile(event.target.files?.[0] ?? null)
                  }
                />
              </label>
            ) : (
              <label>
                <span>YouTube link</span>
                <input
                  type="url"
                  value={youtubeInputUrl}
                  placeholder="https://www.youtube.com/watch?v=..."
                  onChange={(event) => setYoutubeInputUrl(event.target.value)}
                />
              </label>
            )}

            <button type="submit" disabled={isUploading}>
              {isUploading ? "Processing" : "Upload"}
            </button>
          </form>

          {uploadError && <p className="errorText">{uploadError}</p>}

          {statusJob && (
            <section className="statusBox" aria-live="polite">
              {uploadYouTubeThumbnail && (
                <img
                  className="uploadThumbnail"
                  src={uploadYouTubeThumbnail}
                  alt=""
                  aria-hidden="true"
                />
              )}
              <div className="statusTopline">
                <span className={`statusPill ${statusJob.status}`}>
                  {statusJob.status}
                </span>
                <span>{stageLabel(statusJob.stage)}</span>
              </div>
              <div className="progressTrack">
                <span
                  className="progressBar"
                  style={{ width: `${statusJob.progress_percent}%` }}
                />
              </div>
              <div className="statusGrid">
                <span>{statusJob.progress_percent}%</span>
                <span>
                  Step {statusJob.progress_current} of {statusJob.progress_total}
                </span>
                <span>{statusJob.elapsed_seconds}s</span>
              </div>
              <p className="statusMessage">
                {statusJob.last_message ?? "Waiting for progress update."}
              </p>
              {statusJob.status === "succeeded" && uploadedEntryId && (
                <a
                  className="playerLink"
                  href={playerHref(uploadedEntryId)}
                  onClick={(event) => {
                    event.preventDefault();
                    setViewMode("player");
                    updateEntryUrl(uploadedEntryId);
                  }}
                >
                  Open player
                </a>
              )}
            </section>
          )}
        </section>
      )}

      {viewMode === "player" && (
      <section className="player page">
        <header className="header playerHeader">
          <div>
            <p className="label">Player</p>
            <h1>{selectedRunName}</h1>
            {selectedRunTags.length > 0 && (
              <div className="playerTags" aria-label="Entry tags">
                {selectedRunTags.map((tag) => (
                  <button
                    type="button"
                    className="entryTag entryTagButton"
                    key={tag}
                    onClick={() => toggleTagFilter(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ghostButton"
            onClick={clearPlayerProgress}
            disabled={!selectedEntryId || phrasePrompts.length === 0}
          >
            Clear progress
          </button>
        </header>

        <section className="mediaPanel">
          {youtubeVideoId && (
            <div className="mediaModeToggle" aria-label="Playback mode">
              <button
                type="button"
                className={mediaMode === "youtube" ? "active" : ""}
                onClick={() => changeMediaMode("youtube")}
              >
                YouTube
              </button>
              <button
                type="button"
                className={mediaMode === "audio" ? "active" : ""}
                onClick={() => changeMediaMode("audio")}
              >
                Audio only
              </button>
            </div>
          )}

          {mediaMode === "youtube" && youtubeVideoId && (
            <div className="youtubeFrameWrap">
              <div ref={youtubeHostRef} className="youtubeFrame" />
              {!isYouTubeReady && thumbnailUrl && (
                <img
                  className="youtubePoster"
                  src={thumbnailUrl}
                  alt=""
                  aria-hidden="true"
                />
              )}
            </div>
          )}

          <audio
            ref={audioRef}
            className={mediaMode === "audio" ? "audio" : "audio hiddenMedia"}
            controls
            preload="metadata"
            src={audioUrl ?? undefined}
            onEnded={() => {
              playUntilRef.current = null;
              stopTrackingPlayback();
            }}
            onPause={stopTrackingPlayback}
            onPlay={startTrackingPlayback}
            onSeeked={(event) => updateCurrentTime(event.currentTarget.currentTime)}
            onTimeUpdate={(event) => updateCurrentTime(event.currentTarget.currentTime)}
          />
        </section>

        <div className="controls">
          <button
            type="button"
            onClick={() => movePhrase(-1)}
            disabled={selectedPhraseIndex <= 0}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => playPhrase(selectedPhraseIndex)}
            disabled={!selectedPhrase}
          >
            Play phrase
          </button>
          <button
            type="button"
            onClick={() => movePhrase(1)}
            disabled={selectedPhraseIndex >= phrasePrompts.length - 1}
          >
            Next
          </button>
          <label className="speedControl">
            <span>Speed</span>
            <select
              value={playbackSpeed}
              onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
              aria-label="Playback speed"
            >
              {playbackSpeeds.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </label>
          <label className="switchControl">
            <input
              type="checkbox"
              checked={highlightCurrentPhrase}
              onChange={(event) =>
                setHighlightCurrentPhrase(event.target.checked)
              }
            />
            <span>Phrase highlight</span>
          </label>
          <label className="switchControl">
            <input
              type="checkbox"
              checked={highlightCurrentSyllable}
              onChange={(event) =>
                setHighlightCurrentSyllable(event.target.checked)
              }
            />
            <span>Syllable highlight</span>
          </label>
        </div>

        <section className="nowPlaying" aria-live="polite">
          <p className="label">Current phrase</p>
          <p className="phrase">
            {playerError ??
              (isLoadingRun
                ? "Loading run..."
                : currentPhrase
                  ? `Phrase ${selectedPhraseIndex + 1}`
                  : "Select a completed entry")}
          </p>
          <div className="meta">
            <span>{currentTime.toFixed(2)}s</span>
            <span>
              {phrasePrompts.length > 0 ? selectedPhraseIndex + 1 : 0} /{" "}
              {phrasePrompts.length}
            </span>
          </div>
        </section>

        <section className="shortcuts" aria-label="Keyboard shortcuts">
          <span>
            <kbd>Space</kbd> play current syllable window
          </span>
          <span>
            <kbd>Left</kbd> previous input
          </span>
          <span>
            <kbd>Right</kbd> next input
          </span>
          <span>
            <kbd>Up</kbd> reveal current character
          </span>
          <span>
            <kbd>Down</kbd> reveal current pinyin
          </span>
        </section>

        <div className="mobileActions" aria-label="Mobile syllable actions">
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => playUntilCharacter(selectedPhraseIndex, focusedCharIndex)}
            disabled={!selectedPhrase}
          >
            Play syllable
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => revealHanziHint(selectedPhraseIndex, focusedCharIndex)}
            disabled={!selectedPhrase}
          >
            Hanzi hint
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => revealPinyinHint(selectedPhraseIndex, focusedCharIndex)}
            disabled={!selectedPhrase}
          >
            Pinyin hint
          </button>
        </div>

        {selectedPhrase && (
          <section
            className={[
              "phraseCard",
              highlightCurrentPhrase && selectedPhraseIndex === activePhraseIndex
                ? "active"
                : ""
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="phraseRowHeader">
              <time>
                {selectedPhrase.phrase.start.toFixed(2)} -{" "}
                {selectedPhrase.phrase.end.toFixed(2)}
              </time>
              <span>Type the numbered pinyin for each hidden character</span>
              <span className="phraseCount">
                Phrase {selectedPhraseIndex + 1} of {phrasePrompts.length}
              </span>
            </div>

            <div className="syllables">
              {buildPhrasePanelItems(selectedPhrase).map((item, itemIndex) => {
                if (item.type === "punctuation") {
                  return (
                    <span className="punctuation" key={`punctuation-${itemIndex}`}>
                      {item.text}
                    </span>
                  );
                }

                const { char, charIndex } = item;
                const key = answerKey(selectedPhraseIndex, charIndex);
                const value = answers[key] ?? "";
                const isCorrect =
                  value.length > 0 &&
                  normalizePinyin(value) === normalizePinyin(char.expected);
                const isRevealed = isCorrect || hanziHintKey === key;
                const hasPinyinHint = pinyinHintKey === key;
                const hasUsedHint = hintedKeys[key];

                return (
                  <label
                    className={[
                      "syllable",
                      hasUsedHint ? "hinted" : "",
                      highlightCurrentSyllable && activeCharacterIndex === charIndex
                        ? "playing"
                        : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={`${key}-${char.start}`}
                  >
                    <span className={isRevealed ? "hanzi revealed" : "hanzi"}>
                      {isRevealed ? char.char : ""}
                    </span>
                    <input
                      ref={(element) => {
                        inputRefs.current[key] = element;
                      }}
                      className={isCorrect ? "correct" : ""}
                      inputMode="text"
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      name={`pinyin-${selectedPhraseIndex}-${charIndex}`}
                      value={value}
                      placeholder="pinyin"
                      aria-label={`Pinyin for character ${charIndex + 1}`}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const nextAnswers = {
                          ...answers,
                          [key]: nextValue
                        };

                        setAnswers(nextAnswers);
                        updateCachedProgress(nextAnswers, hintedKeys);

                        if (
                          normalizePinyin(nextValue) ===
                          normalizePinyin(char.expected)
                        ) {
                          window.setTimeout(() => {
                            moveInputFocus(selectedPhraseIndex, charIndex, 1);
                          }, 0);
                        }
                      }}
                      onFocus={() => {
                        setSelectedPhraseIndex(selectedPhraseIndex);
                        setFocusedCharIndex(charIndex);
                        setHanziHintKey(null);
                        setPinyinHintKey(null);
                      }}
                      onBlur={() => {
                        setHanziHintKey((current) =>
                          current === key ? null : current
                        );
                        setPinyinHintKey((current) =>
                          current === key ? null : current
                        );
                      }}
                      onKeyDown={(event) =>
                        handleInputKeyDown(
                          event,
                          selectedPhraseIndex,
                          charIndex,
                          selectedPhrase.chars.length
                        )
                      }
                    />
                    <span className="pinyinHint">
                      {hasPinyinHint ? char.expected : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        )}
      </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
