# aiba

Live site: [https://qgerman2.github.io/aiba/](https://qgerman2.github.io/aiba/)

## What it does

aiba turns Chinese audio (an uploaded file or a YouTube link) into a study tool: a synced transcript, per-character pinyin, and per-character timestamps aligned to playback. You listen while typing the pinyin for each hidden character, get instant correct/incorrect feedback, can reveal hanzi/pinyin hints, and once every character in a word is right its boxes merge into a single word view. Multi-character words are detected automatically so you can practice them as units instead of isolated syllables. Entries can come from your own uploads/YouTube links or from a bundled static library that still works even when the backend is offline.

## Tech stack

**Frontend** — React 19 + TypeScript, built with Vite. No component framework or router: a single-file app (`frontend/src/main.tsx`) driving view state, playback, and a plain CSS design system (`frontend/src/styles.css`). Ships both as a live app talking to the backend API and as a static export (`docs/`) for GitHub Pages, falling back to a bundled JSON snapshot and `localStorage`-cached progress when the backend is unreachable.

**Backend** — FastAPI + Postgres. Audio processing (`backend/test4.py`) runs as a pipeline:

- Local silence-based VAD chunking for long audio
- Transcription with `Qwen/Qwen3-ASR-0.6B`
- Phrase splitting with `qwen3:4b-instruct` via Ollama
- Character-level forced alignment with `Qwen/Qwen3-ForcedAligner-0.6B`
- Pinyin via `pypinyin`'s dictionary lookup (no manual tone-sandhi rules)
- Word segmentation via `jieba`, so the frontend can group multi-character words

Job state, transcripts, phrase/character/word timings, and generated file records are all stored in Postgres and served through the FastAPI app (`backend/api.py`).

## Requirements

- Docker with Docker Compose
- An NVIDIA GPU with drivers and the NVIDIA Container Toolkit (the backend requests all available GPUs for ASR/alignment)
- An Ollama instance reachable from the backend container, with the `qwen3:4b-instruct` model pulled, for phrase splitting

## Commands

Run everything locally:

```bash
docker compose up --build
```

Run only the database and backend:

```bash
docker compose up --build db backend
```
