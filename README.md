# aiba

Chinese 听力 practice tool with a React/Vite frontend, FastAPI backend, Postgres metadata storage, local ASR/alignment processing, and optional YouTube ingestion.

## Run Everything With Docker Compose

Prerequisites:

- Docker with Docker Compose
- NVIDIA GPU drivers and NVIDIA Container Toolkit for backend ASR processing
- Ollama running on the host if you want processing to work
- The `qwen3:4b-instruct` Ollama model available locally

Start the full stack:

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

The backend container requests all available NVIDIA GPUs for Qwen ASR:

```bash
docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu24.04 nvidia-smi
```

Run that command first if GPU access fails in Compose.

Override it when needed:

```bash
OLLAMA_HOST=http://your-ollama-host:11434 docker compose up --build
```

## Run Only Database And Backend

Start just Postgres and the backend API:

```bash
docker compose up --build db backend
```

The backend will be available at:

```text
http://localhost:8000
```

Health check:

```bash
curl http://localhost:8000/health
```

## Run Frontend Locally Against Docker Backend

With `db` and `backend` running in Docker, start the frontend from another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:8080
```

The frontend defaults to the public backend URL:

```text
https://backend.java-kokanue.ts.net:443
```

Override it for local-only development when needed:

```bash
VITE_API_BASE_URL=/api npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000` by default.

## Useful Compose Commands

Stop services:

```bash
docker compose down
```

Stop services and remove persistent volumes:

```bash
docker compose down -v
```

View backend logs:

```bash
docker compose logs -f backend
```

View database logs:

```bash
docker compose logs -f db
```

## Static GitHub Pages Build

The frontend can export successful processed entries into static files so the app still works when the API is unavailable:

```bash
cd frontend
npm run deploy:docs
```

That writes the GitHub Pages build to:

```text
docs/
```

The static content bundle lives at:

```text
frontend/public/static/aiba-static.json
frontend/public/static/assets/
```
