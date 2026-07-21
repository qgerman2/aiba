# Frontend API Integration Spec

This document is for the frontend implementation. The backend is a FastAPI app that accepts audio uploads, queues slow ASR/alignment processing, stores metadata in Postgres, and exposes processed transcript data as JSON and downloadable files.

Base URL in local development:

```text
http://127.0.0.1:8000
```

Start backend from `backend/`:

```bash
./venv/bin/uvicorn api:app --host 127.0.0.1 --port 8000
```

## High-Level Frontend Flow

1. Upload an audio file with `POST /audio/process`, or submit a YouTube URL with `POST /youtube/process`.
2. Store the returned `job_id`.
3. Poll `GET /processing/{job_id}` until `job.status` is `succeeded` or `failed`.
4. When succeeded, use `run.id` or `job.processing_run_id` as `run_id`.
5. Fetch display data with:
   ```text
   GET /runs/{run_id}/phrases
   GET /runs/{run_id}/characters
   GET /runs/{run_id}/frontend-files
   ```
6. Download/play the audio through:
   ```text
   GET /files/{audio_generated_file_id}/download
   ```
7. Display a YouTube thumbnail, when present, through:
   ```text
   GET /files/{thumbnail_generated_file_id}/download
   ```

The frontend does not need to parse filesystem paths directly. Treat `storage_path` as backend metadata and use `file_id` download URLs.

## Upload-to-Playback State Machine

```text
idle
  -> uploading
  -> queued
  -> running
  -> succeeded
  -> loading run data
  -> ready
```

Failure path:

```text
queued/running -> failed
```

Use `job.status` for state transitions and `job.stage`, `job.progress_percent`, `job.last_message`, and `job.heartbeat_at` for progress UI while `job.status === "running"`.

## Processing Status Values

Jobs use these statuses:

```text
queued
running
succeeded
failed
```

Runs use these statuses:

```text
pending
running
succeeded
failed
```

For API-uploaded audio, `processing_jobs.id` is also passed to `test4.py` as `--run-id`, so a successful job should have:

```text
job.id == job.processing_run_id == run.id
```

## Endpoints

### `GET /health`

Use for a basic backend readiness check.

Response:

```json
{
  "ok": true,
  "db": true
}
```

### `POST /audio/process`

Uploads an audio file and enqueues processing.

Request content type:

```text
multipart/form-data
```

Fields:

```text
audio     required file
name      optional string
tags      optional repeated string field
tags_csv  optional comma-separated string
```

Example:

```ts
const form = new FormData();
form.append("audio", file);
form.append("name", "Lesson 10 Monologue");
form.append("tags", "hsk");
form.append("tags", "lesson-10");

const res = await fetch("http://127.0.0.1:8000/audio/process", {
  method: "POST",
  body: form,
});
const job = await res.json();
```

Response shape:

```ts
type UploadResponse = {
  job_id: string;
  status: "queued";
  source_type: "upload";
  source_url: null;
  upload_path: string;
  name: string;
  tags: string[];
};
```

### `POST /youtube/process`

Downloads audio from a YouTube URL with nightly `yt-dlp`, stores the downloaded MP3 under `backend/media/youtube/`, and enqueues the same processing pipeline used for uploads.
When a thumbnail URL is available from YouTube metadata, the backend also stores the image under the same `backend/media/youtube/{job_id}/` directory.

Request content type:

```text
multipart/form-data
```

Fields:

```text
youtube_url  required string
name         optional string; when omitted or blank, the backend uses the YouTube video title after download
tags         optional repeated string field; backend always adds `youtube`
tags_csv     optional comma-separated string; backend always adds `youtube`
```

Example:

```ts
const form = new FormData();
form.append("youtube_url", "https://www.youtube.com/watch?v=UWoQ17DxZec");
form.append("name", "YouTube lesson clip");

const res = await fetch("http://127.0.0.1:8000/youtube/process", {
  method: "POST",
  body: form,
});
const job = await res.json();
```

Response shape:

```ts
type YouTubeProcessResponse = {
  job_id: string;
  status: "queued";
  source_type: "youtube";
  source_url: string;
  upload_path: null;
  name: string | null;
  tags: string[];
};
```

### `GET /processing/{job_id}`

Poll this endpoint for one upload/processing call.

Response shape:

```ts
type ProcessingResponse = {
  job: {
    id: string;
    processing_run_id: string | null;
    status: "queued" | "running" | "succeeded" | "failed";
    stage:
      | "queued"
      | "upload_saved"
      | "download_queued"
      | "downloading"
      | "run_started"
      | "chunking"
      | "asr"
      | "phrase_split"
      | "pinyin"
      | "alignment"
      | "timestamp_mapping"
      | "db_save"
      | "completed"
      | "failed";
    progress_current: number;
    progress_total: number;
    progress_percent: number;
    last_message: string | null;
    heartbeat_at: string;
    elapsed_seconds: number;
    upload_path: string | null;
    source_type: "upload" | "youtube";
    source_url: string | null;
    downloaded_audio_path: string | null;
    thumbnail_path: string | null;
    display_name: string | null;
    tags: string[];
    command: string[];
    stdout: string | null;
    stderr: string | null;
    tail_stdout: string;
    tail_stderr: string;
    exit_code: number | null;
    error_message: string | null;
    queued_at: string;
    started_at: string | null;
    completed_at: string | null;
  };
  run: null | {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    output_dir: string;
    error_message: string | null;
    started_at: string;
    completed_at: string | null;
  };
  output_files_available: GeneratedFile[];
};
```

Frontend polling guidance:

```text
queued/running: poll every 2-5 seconds
succeeded: stop polling and fetch run data
failed: stop polling and show job.error_message or run.error_message
```

If `job.status === "running"` and `heartbeat_at` has not changed for a long time, keep the job in a running state but surface a soft warning such as "No recent progress update." ASR/model loading can be slow, so do not treat a stale heartbeat as failure unless the backend returns `failed`.

Verbose status fields:

```text
stage             current coarse processing stage
progress_percent  rough progress estimate, 0-100
last_message      latest stdout/stderr line from test4.py
heartbeat_at      last time the backend saw subprocess output or state changed
elapsed_seconds   elapsed time since started_at, or queued_at while waiting
tail_stdout       last 4000 characters of stdout
tail_stderr       last 4000 characters of stderr
output_files_available generated files already inserted for the run
```

Stage order:

```text
upload_saved -> run_started -> chunking -> asr -> phrase_split -> pinyin -> alignment -> timestamp_mapping -> db_save -> completed
download_queued -> downloading -> run_started -> chunking -> asr -> phrase_split -> pinyin -> alignment -> timestamp_mapping -> db_save -> completed
```

`output_files_available` is usually empty until database save completes, because `test4.py` inserts generated file rows at the end of a successful run.

The `chunking` stage appears for long files when local silence-based VAD chunking is active. Chunks are internal; the frontend still renders phrases and characters against the original audio timeline.

For YouTube jobs, `upload_path` becomes the downloaded MP3 path after the `downloading` stage. `thumbnail_path` is populated when the thumbnail download succeeds. Use `source_url` for displaying provenance; use generated file download endpoints for playback and thumbnail display after success.

Minimal polling helper:

```ts
async function pollProcessing(jobId: string) {
  const res = await fetch(`${baseUrl}/processing/${jobId}`);
  if (!res.ok) throw new Error(`Polling failed: ${res.status}`);
  const data = (await res.json()) as ProcessingResponse;

  if (data.job.status === "failed") {
    throw new Error(data.job.error_message ?? data.run?.error_message ?? "Processing failed");
  }

  return data;
}
```

### `GET /queue`

Lists recent queue jobs. This is useful for an admin/status screen.

Query params:

```text
status  optional queued | running | succeeded | failed
limit   optional number, default 50
```

Response shape:

```ts
type QueueResponse = {
  active_job_id: string | null;
  pending_in_memory: number;
  jobs: Array<{
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
    upload_path: string;
    display_name: string | null;
    tags: string[];
    exit_code: number | null;
    error_message: string | null;
    queued_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
};
```

### `GET /pipeline/state`

Returns the current processing script state and high-level DB/queue counts.

Response includes:

```text
script.path
script.sha256
script.size_bytes
models.asr
models.aligner
models.phrase_splitter
models.pinyin
queue.active_job_id
queue.pending_in_memory
queue.db_counts
database.audio_assets
database.processing_runs
```

Use this for diagnostics, not for normal playback UI.

### `GET /runs/{run_id}/phrases`

Returns phrase timing data as JSON.

Use this for phrase highlighting, phrase list UI, or seeking by phrase.

Response shape:

```ts
type PhrasesResponse = {
  processing_run_id: string;
  phrases: Array<{
    phrase_index: number;
    start_seconds: number;
    end_seconds: number;
    hanzi: string;
    pinyin: string;
  }>;
};
```

### `GET /runs/{run_id}/characters`

Returns character-level Hanzi and pinyin timing data as JSON.

Use this for karaoke-style highlighting or per-character pinyin display.

Response shape:

```ts
type CharactersResponse = {
  processing_run_id: string;
  characters: Array<{
    char_index: number;
    phrase_char_index: number | null;
    start_seconds: number;
    end_seconds: number;
    hanzi: string;
    pinyin: string;
    is_estimated: boolean;
  }>;
};
```

Notes:

- `hanzi` is one Chinese character.
- Punctuation is omitted from this endpoint.
- `pinyin` uses tone numbers.
- `is_estimated` marks fallback timestamps produced when alignment did not cover the full transcript.

### `GET /runs/{run_id}/frontend-files`

Returns only the generated file records the frontend usually needs:

```text
audio
thumbnail
phrase_timestamps
char_pinyin_timestamps
```

Response shape:

```ts
type FrontendFilesResponse = {
  processing_run_id: string;
  files: GeneratedFile[];
};

type GeneratedFile = {
  id: string;
  processing_run_id: string;
  file_kind:
    | "audio"
    | "thumbnail"
    | "phrase_timestamps"
    | "char_pinyin_timestamps";
  storage_path: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
};
```

Build download URLs from `id`:

```ts
const url = `${baseUrl}/files/${file.id}/download`;
```

### `GET /runs/{run_id}/files`

Returns every generated file for a run.

Query params:

```text
frontend_only  optional boolean
```

### `GET /files`

Lists generated file records across runs.

Query params:

```text
processing_run_id  optional UUID
audio_asset_id     optional UUID
file_kind          optional string
limit              optional number, default 100
```

### `GET /audio-assets/{audio_asset_id}/files`

Lists generated files for all runs associated with one audio asset.

Query params:

```text
frontend_only  optional boolean
```

### `GET /files/{file_id}/download`

Downloads or streams a generated file.

Use this endpoint for:

```text
audio playback
raw phrase timestamp text file download
raw character+pinyin timestamp text file download
```

For audio playback:

```tsx
<audio controls src={`${baseUrl}/files/${audioFile.id}/download`} />
```

## Recommended Playback Data Loading

After a job succeeds:

```ts
const runId = processing.job.processing_run_id;

const [phrasesRes, charactersRes, filesRes] = await Promise.all([
  fetch(`${baseUrl}/runs/${runId}/phrases`),
  fetch(`${baseUrl}/runs/${runId}/characters`),
  fetch(`${baseUrl}/runs/${runId}/frontend-files`),
]);

const phrases = await phrasesRes.json();
const characters = await charactersRes.json();
const files = await filesRes.json();

const audioFile = files.files.find((file) => file.file_kind === "audio");
const thumbnailFile = files.files.find((file) => file.file_kind === "thumbnail");
const audioUrl = `${baseUrl}/files/${audioFile.id}/download`;
const thumbnailUrl = thumbnailFile ? `${baseUrl}/files/${thumbnailFile.id}/download` : null;
```

Use `phrases.phrases` and `characters.characters` for rendered transcript state. Use `audioUrl` as the audio element source and `thumbnailUrl` as the image source when present.

## What To Trust While Running

While a job is queued or running:

```text
GET /processing/{job_id}
```

is the source of truth for UI state.

Do not expect these endpoints to be populated until the job succeeds:

```text
GET /runs/{run_id}/phrases
GET /runs/{run_id}/characters
GET /runs/{run_id}/frontend-files
```

The backend writes generated file rows and parsed transcript rows near the end of `test4.py`, during the `db_save` stage.

## Curated Entries

`audio_assets.is_curated` is a boolean metadata field for entries that have been reviewed or overseen by an admin.

The public upload API does not set this field. It must be changed manually by an admin or a future admin-only endpoint.

```text
audio_assets.is_curated
```

The frontend should use `is_curated` for filtering or badges instead of relying on a free-form tag like `"curated"`.

## Static Tags

Static tags are admin-controlled tags used for stable classification, filtering, or collection membership.

They are not part of the public upload API. Do not expose static-tag assignment in the upload form, and do not send static tags through:

```text
POST /audio/process
```

Public upload fields still support user-supplied `tags` and `tags_csv`, but those should be treated as ordinary upload metadata. Static tags should be managed manually by an admin or a future admin-only endpoint.

The frontend may display or filter by static tags only after the backend exposes them from admin-managed metadata.

For GitHub Pages/offline deployment, the current successful content can be exported into a frontend static bundle. Exported entries are tagged `static` and can be loaded by the frontend when the API is unavailable.

## Error Handling

Expected error cases:

```text
404 from /processing/{job_id}: unknown job id
404 from /runs/{run_id}/...: run exists but no generated rows are available
404 from /files/{file_id}/download: file record or physical file is missing
failed job.status: model/script/database processing failed
```

For failed jobs, show:

```text
job.error_message || run.error_message || "Processing failed"
```

## Current Limitations

- The queue worker is in-process. Restarting the API marks previously running jobs as failed and reloads queued jobs.
- Only one processing job runs at a time.
- Upload progress is client-side only; the backend returns after the upload is saved and queued.
- Long audio is chunked locally by silence detection before ASR. This is suitable for local audio and future YouTube-derived audio, but noisy recordings may need a stronger VAD model later.
- There is no cancellation endpoint yet.
- There is no auth layer yet.
