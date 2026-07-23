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

## Run everything with Docker Compose

```bash
docker compose up --build
```

Then open:

```text
http://localhost:8080
```

Service URLs:

```text
Frontend  http://localhost:8080
Backend   http://localhost:8000
Postgres  localhost:5432
```

The backend uses this default database URL inside Compose:

```text
postgresql://myuser:mypass@db:5432/postgres
```

Ollama defaults to the host machine:

```text
OLLAMA_HOST=http://host.docker.internal:11434
```

Override it when needed:

```bash
OLLAMA_HOST=http://your-ollama-host:11434 docker compose up --build
```

If GPU access fails in Compose, check it directly first:

```bash
docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu24.04 nvidia-smi
```

## Run only the database and backend

```bash
docker compose up --build db backend
```

The backend will be available at `http://localhost:8000`. Health check:

```bash
curl http://localhost:8000/health
```

## Run only the frontend

```bash
docker compose up --build frontend
```

Compose brings up `frontend`'s declared dependencies (`backend`, which itself depends on `db`) automatically, so this behaves the same as starting the whole stack. To build/run only the frontend container in isolation — e.g. against an already-running backend elsewhere — skip dependencies explicitly:

```bash
docker compose up --build --no-deps frontend
```

Point it at that backend with `VITE_API_PROXY_TARGET`; it still falls back to the static bundle and cached progress if no backend is reachable.

## Run the frontend locally against the Docker backend

With `db` and `backend` running in Docker, from another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:8080`. The frontend defaults to the public backend URL (`https://backend.java-kokanue.ts.net:443`); override it for local-only development:

```bash
VITE_API_BASE_URL=/api npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000` by default.

## Frontend npm commands

Run from `frontend/`:

| Command | What it does |
|---|---|
| `npm run dev` | Starts the Vite dev server on port 8080. |
| `npm run build` | Type-checks (`tsc --noEmit`) and builds the production bundle into `dist/`. |
| `npm run export:static` | Pulls all succeeded entries (phrases/characters/words/audio/thumbnails) from the live Postgres database into `frontend/public/static/`, for offline/static use. Excludes anything tagged `no-publish`. |
| `npm run import:static` | The reverse: recreates database rows (audio assets, processing runs/jobs, phrases, characters, words, generated file records) and restores media files from `frontend/public/static/` into a fresh/pruned Postgres database. Skips any run already present, so it's safe to re-run. |
| `npm run deploy:docs` | Builds the frontend (using whatever is currently in `frontend/public/static/`) and copies the result into `docs/` for GitHub Pages. Does **not** re-pull from the database — run `export:static` first if you want fresh data included. |
| `npm run preview` | Serves the built `dist/` output locally, for sanity-checking a production build. |

## Useful Compose commands

Stop services:

```bash
docker compose down
```

Stop services and remove persistent volumes:

```bash
docker compose down -v
```

View logs:

```bash
docker compose logs -f backend
docker compose logs -f db
```

## Static GitHub Pages build

`docs/` is a static export of the frontend plus a JSON snapshot of successful entries, so the app keeps working (read-only, from cached data) even when the backend is offline. To rebuild and republish it:

```bash
cd frontend
npm run export:static   # pull fresh data from Postgres
npm run deploy:docs     # build and copy into docs/
```

The static content bundle lives at:

```text
frontend/public/static/aiba-static.json
frontend/public/static/assets/
```

In metadata, `static` means the entry is bundled for use when the backend is unavailable. `curated` (`is_curated`) means admin-curated content — do not treat `static` as a curated signal. A job/audio asset tagged `no-publish` is excluded from the static export entirely.

## Disclaimer

This project has been heavily vibe-coded with GPT-5.5 and Claude Sonnet 5. Expect rough edges.
