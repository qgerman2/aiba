# Audio Storage Layout

Keep audio files and generated run artifacts out of the database. Postgres should store paths, metadata, searchable transcript rows, and timestamps.

## Recommended layout

Use content-addressed storage for original audio:

```text
backend/media/audio/originals/{sha256_prefix}/{sha256}.{ext}
```

Example:

```text
backend/media/audio/originals/ab/ab12...ef90.mp3
```

Use one immutable directory per processing run:

```text
backend/media/runs/{processing_run_id}/
```

YouTube downloads are staged separately before being copied into content-addressed storage:

```text
backend/media/youtube/{processing_job_id}/{youtube_video_id}.mp3
backend/media/youtube/{processing_job_id}/{youtube_video_id}_thumbnail.{jpg|png|webp}
```

Run output files:

```text
backend/media/runs/{processing_run_id}/{base_name}.txt
backend/media/runs/{processing_run_id}/{base_name}_phrases.txt
backend/media/runs/{processing_run_id}/{base_name}_pinyin.txt
backend/media/runs/{processing_run_id}/{base_name}_chunks.json
backend/media/runs/{processing_run_id}/{base_name}_char_timestamps.txt
backend/media/runs/{processing_run_id}/{base_name}_char_pinyin_timestamps.txt
backend/media/runs/{processing_run_id}/{base_name}_phrase_timestamps.txt
backend/media/runs/{processing_run_id}/{base_name}_phrase_timestamps_pinyin.txt
backend/media/runs/{processing_run_id}/chunks/chunk_0000.wav
```

For YouTube inputs, the thumbnail stays in the YouTube staging directory and is exposed through a `generated_files` row with `file_kind = thumbnail`.

The frontend contract needs:

```text
{base_name}.mp3
{youtube_video_id}_thumbnail.{jpg|png|webp} when available
{base_name}_phrase_timestamps.txt
{base_name}_char_pinyin_timestamps.txt
```

## Why this layout

- `audio_assets.sha256` deduplicates identical uploaded audio, even if filenames differ.
- `audio_assets.source_type`, `source_url`, `downloaded_audio_path`, and `thumbnail_path` preserve YouTube provenance when the source came from `POST /youtube/process`.
- `processing_runs` allows rerunning ASR/alignment/pinyin without overwriting previous results.
- `generated_files` records the exact files produced by a run.
- `transcript_phrases` and `transcript_characters` make the frontend data queryable without reparsing text files.
- `processing_chunks` records local silence/VAD chunk boundaries and per-chunk transcripts for long audio.
- The original filename is metadata only; it should not control permanent storage paths.

## Import flow

1. For uploaded audio, save the multipart file under `media/uploads/`.
2. For YouTube audio, download with nightly `yt-dlp` under `media/youtube/{processing_job_id}/`, including a thumbnail when available.
3. Compute SHA-256 for the source audio.
4. If `audio_assets.sha256` already exists, reuse that row and update source metadata when applicable.
5. Otherwise copy the audio into `media/audio/originals/{sha256_prefix}/{sha256}.{ext}`.
6. Create a `processing_runs` row with a new `output_dir`.
7. Run the Python pipeline into that run directory.
8. For long files, create local silence/VAD chunks under `media/runs/{processing_run_id}/chunks/`.
9. Run local Qwen ASR per chunk, then stitch transcripts into the full transcript.
10. Insert `generated_files` rows for every generated artifact.
11. Parse frontend-relevant files into `transcript_phrases` and `transcript_characters`.

## Serving options

For local development, the API can serve the file paths directly from `backend/media`.

For production, keep the same logical paths in Postgres but store the actual files in object storage. The schema does not need to change; `storage_path` can point to an object key instead of a local path.

For GitHub Pages/offline deployment, `frontend/scripts/export_static_content.py` exports successful runs into:

```text
frontend/public/static/aiba-static.json
frontend/public/static/assets/{processing_run_id}/audio.mp3
frontend/public/static/assets/{processing_run_id}/thumbnail.{jpg|png|webp}
```

The frontend build copies those files into `docs/static/` through `npm run deploy:docs`.

The `static` tag is an offline availability marker for entries that should be discoverable from the static frontend bundle when the backend is unavailable. It is separate from curation. Admin-curated content is represented by `audio_assets.is_curated`, not by a `static` tag.
