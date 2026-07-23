# Processing Output and Database Spec

Audio processing starts through the API, not by manually copying files into the frontend.

The normal flow is:

```text
POST /audio/process
  -> creates a processing_jobs row
  -> stores the upload under backend/media/uploads/
  -> queues test4.py
  -> test4.py copies the audio into content-addressed storage
  -> test4.py writes generated artifacts under backend/media/runs/{processing_run_id}/
  -> test4.py inserts searchable phrase/character rows into Postgres
```

YouTube inputs use the same pipeline after download:

```text
POST /youtube/process
  -> creates a processing_jobs row with source_type=youtube and source_url
  -> downloads audio with nightly yt-dlp under backend/media/youtube/{processing_job_id}/
  -> uses the YouTube metadata title as the display name when no explicit name was submitted
  -> downloads a thumbnail image when YouTube metadata includes one
  -> queues test4.py with the downloaded MP3 path
  -> test4.py copies the audio into content-addressed storage
  -> test4.py records the YouTube URL, downloaded audio path, and thumbnail path on audio_assets
  -> test4.py writes generated artifacts and inserts searchable rows
```

`processing_jobs.id` and `processing_runs.id` are the same UUID for successful API-launched jobs.

While a job is running, `processing_jobs` is the source of truth. `processing_runs`, `generated_files`, `transcript_phrases`, and `transcript_characters` become useful after `test4.py` creates and saves those rows.

## Upload Inputs

`POST /audio/process` accepts multipart form data:

```text
audio     required uploaded audio file
name      optional display name
tags      optional repeated tag field
tags_csv  optional comma-separated tags
```

## YouTube Inputs

`POST /youtube/process` accepts multipart form data:

```text
youtube_url  required YouTube URL
name         optional display name; when omitted or blank, the backend uses the YouTube video title after download
tags         optional repeated tag field; backend always adds `youtube`
tags_csv     optional comma-separated tags; backend always adds `youtube`
```

Example:

```bash
curl -F "youtube_url=https://www.youtube.com/watch?v=UWoQ17DxZec" \
  -F "name=YouTube lesson clip" \
  http://127.0.0.1:8000/youtube/process
```

Example:

```bash
curl -F "audio=@lesson.mp3" \
  -F "name=Lesson 10 Monologue" \
  -F "tags=hsk" \
  -F "tags=lesson-10" \
  http://127.0.0.1:8000/audio/process
```

## Database Records

### `processing_jobs`

Queue and subprocess state.

Important fields:

```text
id                 job UUID
processing_run_id  matching run UUID after test4.py creates it
source_type        upload | youtube
source_url         original URL for YouTube jobs, otherwise null
status             queued | running | succeeded | failed
stage              upload_saved | download_queued | downloading | run_started | chunking | asr | phrase_split | pinyin | alignment | timestamp_mapping | db_save | completed | failed
progress_current   rough completed stage count
progress_total     total rough stage count
progress_percent   rough progress percentage
last_message       latest processing message from stdout/stderr
heartbeat_at       last observed status/log update
upload_path        temporary uploaded file path, or downloaded MP3 path after YouTube download
downloaded_audio_path downloaded MP3 path for YouTube jobs
thumbnail_path     downloaded thumbnail image path for YouTube jobs, when available
display_name       user-facing audio name
tags               text[] tags
stdout             captured test4.py stdout
stderr             captured test4.py stderr
exit_code          subprocess exit code
error_message      failure detail
queued_at
started_at
completed_at
```

Stage order:

```text
upload_saved
download_queued
downloading
run_started
chunking
asr
phrase_split
pinyin
alignment
timestamp_mapping
db_save
completed
```

Progress is intentionally coarse. It is meant for UI feedback, not exact model progress. `heartbeat_at` updates when the queue worker changes state or receives subprocess output from `test4.py`.

Long audio may enter a `chunking` stage before ASR. Chunking is local silence-based VAD using `pydub`; it does not call an external service.

### `audio_assets`

One row per unique source audio file, deduplicated by SHA-256.

Important fields:

```text
id
sha256
original_filename
storage_path       content-addressed audio path
source_type        upload | youtube
source_url         original YouTube URL when present
downloaded_audio_path backend-relative downloaded MP3 path when present
thumbnail_path     backend-relative thumbnail image path when present
mime_type
byte_size
duration_seconds
sample_rate
channels
display_name
tags
is_curated
```

`audio_assets.is_curated` is admin/manual metadata. The upload API and `test4.py` do not set it. Use this field for curated/non-curated filtering after an admin has explicitly reviewed, approved, or chosen to feature the entry; do not rely on a free-form tag named `curated` for this distinction.

The `static` tag is not a curation signal. It means the entry is available from the frontend static bundle when the backend server is offline or unreachable.

The upload API accepts ordinary user/upload tags:

```text
tags
tags_csv
```

Those are not the same as static tags. Static tags should be assigned only by the static export/deployment workflow or a future admin-only static publishing workflow.

For GitHub Pages/offline deployment, selected successful entries are written into `frontend/public/static/` with JSON transcript data plus copied audio/thumbnail files. Exported non-YouTube entries may be tagged `static` to mark offline/static-bundle availability. YouTube entries may be included in the static bundle without being tagged `static` if they should not be shown as static homepage content.

### `processing_runs`

One row per processing attempt.

Important fields:

```text
id
audio_asset_id
status             pending | running | succeeded | failed
transcript_text
asr_model
aligner_model
phrase_splitter_model
pinyin_method
word_segmenter
output_dir
error_message
started_at
completed_at
```

### `processing_chunks`

Internal chunk metadata for long-audio processing.

Important fields:

```text
processing_run_id
chunk_index
start_seconds
end_seconds
audio_path
transcript_text
status
error_message
started_at
completed_at
```

Chunks are an internal processing detail. Frontend timestamps remain relative to the original full audio.

### `generated_files`

All physical files produced or referenced by a processing run.

Important fields:

```text
id
processing_run_id
file_kind
storage_path
mime_type
byte_size
sha256
```

Supported `file_kind` values:

```text
audio
thumbnail
transcript
phrases
pinyin
chunks_manifest
char_timestamps
char_pinyin_timestamps
phrase_timestamps
phrase_timestamps_pinyin
```

### `transcript_phrases`

Parsed phrase timing data for direct frontend/API use.

Important fields:

```text
phrase_index
start_seconds
end_seconds
hanzi
pinyin
```

### `transcript_characters`

Parsed per-character timing data for direct frontend/API use.

Important fields:

```text
char_index
phrase_char_index
start_seconds
end_seconds
hanzi
pinyin
is_estimated
```

### `transcript_words`

Word-segmented timing data, used to group multi-character words in the frontend once all their characters are answered correctly. Segmentation is produced by jieba over each phrase's hanzi text.

Important fields:

```text
word_index
phrase_id
phrase_word_index
start_seconds
end_seconds
hanzi
pinyin
char_count
```

### `transcription_error_reports`

Append-only reports for suspected Hanzi or pinyin transcription errors. Each report targets one character occurrence in one processing run.

Important fields:

```text
id
processing_run_id
transcript_character_id
char_index
current_hanzi
current_pinyin
suggested_hanzi
suggested_pinyin
status             open | reviewed | accepted | rejected
created_at
```

`suggested_hanzi` and `suggested_pinyin` are both optional. A report can be a flag-only report with no proposed correction. Reports do not mutate transcript rows; they are review data for a future admin correction workflow.

## File Storage

Uploaded files first land here:

```text
backend/media/uploads/{upload_uuid}.{ext}
```

YouTube downloads first land here:

```text
backend/media/youtube/{processing_job_id}/{youtube_video_id}.mp3
backend/media/youtube/{processing_job_id}/{youtube_video_id}_thumbnail.{jpg|png|webp}
```

Source audio is copied into content-addressed storage:

```text
backend/media/audio/originals/{sha256_prefix}/{sha256}.{ext}
```

Each processing run writes artifacts here:

```text
backend/media/runs/{processing_run_id}/
```

For an input named `{base_name}.mp3`, generated run artifacts are:

```text
{base_name}.txt
{base_name}_phrases.txt
{base_name}_pinyin.txt
{base_name}_chunks.json
{base_name}_char_timestamps.txt
{base_name}_char_pinyin_timestamps.txt
{base_name}_phrase_timestamps.txt
{base_name}_phrase_timestamps_pinyin.txt
```

For YouTube inputs, the thumbnail remains in the YouTube staging directory and is referenced by a `generated_files` row:

```text
backend/media/youtube/{processing_job_id}/{youtube_video_id}_thumbnail.{jpg|png|webp}
```

## Frontend Contract

During processing, poll:

```text
GET /processing/{job_id}
```

After success, the frontend should prefer API JSON endpoints over reparsing text files:

```text
GET /runs/{run_id}/phrases
GET /runs/{run_id}/characters
GET /runs/{run_id}/frontend-files
GET /files/{file_id}/download
```

Do not require raw generated files to exist while `job.status` is `queued` or `running`. They are inserted into `generated_files` during the `db_save` stage near the end of processing.

For YouTube jobs, the thumbnail is exposed as a generated file with `file_kind = thumbnail`. The frontend should download it through `GET /files/{file_id}/download` instead of reading `thumbnail_path` directly.

Chunking is not exposed as a playback unit. The frontend should continue to render phrases and characters against the original audio timeline.

## Long Audio Chunking

`test4.py` supports local silence-based chunking for long files:

```text
--chunking auto | on | off
--chunk-threshold-seconds
--chunk-target-seconds
--chunk-max-seconds
--chunk-min-silence-ms
--chunk-silence-thresh-db
```

Default behavior:

```text
--chunking auto
--chunk-threshold-seconds 180
--chunk-target-seconds 75
--chunk-max-seconds 90
--chunk-min-silence-ms 700
```

When chunking is active:

```text
audio -> local silence/VAD chunks -> local Qwen ASR per chunk -> chunk transcripts stitched -> phrase split -> pinyin -> forced alignment per chunk -> global timestamps
```

All exported chunk files are stored under:

```text
backend/media/runs/{processing_run_id}/chunks/
```

The chunk manifest is:

```text
{base_name}_chunks.json
```

If the frontend wants raw files, use `GET /runs/{run_id}/frontend-files`.

Frontend-relevant `file_kind` values:

```text
audio
phrase_timestamps
char_pinyin_timestamps
```

## File Formats

### `{base_name}_phrase_timestamps.txt`

```text
[{start_seconds:.3f} -> {end_seconds:.3f}] {hanzi_phrase}
```

Example:

```text
[0.240 -> 7.440] 下星期五是圣诞节，这是我第一次在中国过圣诞节。
```

### `{base_name}_char_pinyin_timestamps.txt`

```text
[{start_seconds:.3f} -> {end_seconds:.3f}] {hanzi_char} {pinyin}
```

Example:

```text
[0.240 -> 0.480] 下 xia4
[0.480 -> 0.720] 星 xing1
[0.720 -> 0.960] 期 qi1
```

Notes:

- Pinyin uses Hanyu Pinyin with tone numbers.
- Neutral tone is written with `5`.
- Punctuation is omitted from character-level rows/files.
- Pinyin readings come from pypinyin's dictionary lookup (phrase-aware, no manual tone-sandhi rules).
- `is_estimated = true` means the forced aligner ran out of exact character timestamps and the script estimated timing over the remaining audio.
