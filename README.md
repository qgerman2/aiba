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
- An NVIDIA GPU with drivers and the NVIDIA Container Toolkit (the backend requests all available GPUs for ASR/alignment). The backend's PyTorch is built for CUDA 13.0, so the driver must be 580 or newer
- An Ollama instance reachable from the backend container, with the `qwen3:4b-instruct` model pulled, for phrase splitting (see [Ollama](#ollama))

### Arch Linux

Install the NVIDIA Container Toolkit:

```bash
sudo pacman -S nvidia-container-toolkit
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Install Ollama and pull the model:

```bash
sudo pacman -S ollama
sudo systemctl enable --now ollama
ollama pull qwen3:4b-instruct
```

Then bind Ollama to the Docker bridge, as described in [Ollama](#ollama).

### Ubuntu on WSL2

Install the NVIDIA driver on **Windows** (580 or newer), not inside WSL. WSL exposes it to Linux automatically; check with `nvidia-smi`. WSL must have systemd enabled (`[boot] systemd=true` in `/etc/wsl.conf`, the default on current Ubuntu images), and Docker Engine must be installed inside WSL (see [docs.docker.com](https://docs.docker.com/engine/install/ubuntu/)).

Install the NVIDIA Container Toolkit:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi -L   # should list your GPU
```

The toolkit generates the GPU device spec (`/var/run/cdi/nvidia.yaml`) at boot. After updating the Windows driver, containers can fail with `Failed to initialize NVML` because the spec still points at the old driver; regenerate it with:

```bash
sudo systemctl restart nvidia-cdi-refresh
```

Install Ollama (the installer needs `zstd`) and pull the model:

```bash
sudo apt-get install -y zstd
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b-instruct
```

Then bind Ollama to the Docker bridge, as described in [Ollama](#ollama).

### Ollama

Ollama runs on the host, not in Compose. The backend reaches it at `OLLAMA_HOST`, which defaults to `http://host.docker.internal:11434`. Compose maps `host.docker.internal` to the Docker bridge gateway (`172.17.0.1` by default), so the backend's requests arrive on the `docker0` bridge, not on `127.0.0.1` where Ollama listens by default. Bind Ollama to the bridge address so the backend can reach it while it stays off your LAN and tailnet:

```bash
ip -4 addr show docker0   # confirm the bridge address (172.17.0.1 unless Docker's config changes it)
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Unit]\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nEnvironment="OLLAMA_HOST=172.17.0.1:11434"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

`docker0` only exists once Docker is running, which is why the override orders Ollama after Docker; otherwise Ollama can fail to bind at boot.

The `ollama` CLI connects to `127.0.0.1` by default, so point it at the bridge too (e.g. in `~/.bashrc`):

```bash
export OLLAMA_HOST=172.17.0.1:11434
```

Check that a container can reach it:

```bash
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl \
  -s http://host.docker.internal:11434/api/tags
```

To use an Ollama instance on another machine instead, set `OLLAMA_HOST` before starting Compose, e.g. `OLLAMA_HOST=http://192.168.1.50:11434 docker compose up`.

Postgres is likewise published only on `127.0.0.1:5432`, so it's reachable from the host (for the static bundle scripts) but not from other machines. The backend API (`8000`) and frontend (`8080`) are published on all interfaces.

### ASR and alignment models

Compose runs the backend with `HF_HUB_OFFLINE=1`, so `Qwen/Qwen3-ASR-0.6B` and `Qwen/Qwen3-ForcedAligner-0.6B` are **not** downloaded automatically; until they are in the `model-cache` volume, every job fails with `couldn't connect to 'https://huggingface.co'`. Download them once after the first build:

```bash
docker compose run --rm --no-deps -e HF_HUB_OFFLINE=0 backend python -c \
  "from huggingface_hub import snapshot_download as d; [d(m) for m in ('Qwen/Qwen3-ASR-0.6B', 'Qwen/Qwen3-ForcedAligner-0.6B')]"
```

The volume persists across rebuilds, so this only needs repeating after `docker compose down -v`.

## Commands

Run everything locally:

```bash
docker compose up --build
```

Run only the database and backend:

```bash
docker compose up --build db backend
```

### Static bundle

The static bundle (`frontend/public/static/`, copied into `docs/` for GitHub Pages) is a snapshot of Postgres. Export **replaces** it with whatever is in the database, so on a fresh or wiped database, import the existing bundle first or the export will drop every entry that isn't in Postgres:

```bash
cd frontend
npm run import:static   # load the bundle into Postgres (skips runs already present)
npm run export:static   # write Postgres back out to public/static/
npm run deploy:docs     # build and copy into docs/
```

These scripts need Node on the host and a Python venv at `backend/venv` with the backend's dependencies (PyTorch, transformers, etc.). If you don't have those, run the same steps in containers instead, from the repo root with `db` running:

```bash
# import: runs as root because it writes audio into backend/media, which the backend container owns
docker compose run --rm --no-deps -T -v "$PWD":/repo -w /repo/backend \
  -e DATABASE_URL=postgresql://myuser:mypass@db:5432/postgres \
  backend python /repo/frontend/scripts/import_static_content.py

# export: runs as your user so the files written to frontend/public/static stay yours
docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$PWD":/repo -w /repo/backend \
  -e DATABASE_URL=postgresql://myuser:mypass@db:5432/postgres \
  backend python /repo/frontend/scripts/export_static_content.py

# build and deploy to docs/ with Node from Docker
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/repo -w /repo/frontend \
  node:24-bookworm-slim sh -c "npm ci && npm run deploy:docs"
```

The Python steps reuse the backend image, which already has every dependency, and reach Postgres over the Compose network (`db:5432`). The build step uses the same `node:24` image as `frontend/Dockerfile`; it installs `node_modules` into `frontend/` (git-ignored).
