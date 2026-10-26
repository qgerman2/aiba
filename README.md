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
- An NVIDIA GPU with drivers (580 or newer, the backend's PyTorch is built for CUDA 13.0) and the NVIDIA Container Toolkit (the backend requests all available GPUs for ASR/alignment)
- An Ollama instance reachable from the backend container, with the `qwen3:4b-instruct` model pulled, for phrase splitting

Install the NVIDIA Container Toolkit (Arch Linux):

```bash
sudo pacman -S nvidia-container-toolkit
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Install the NVIDIA Container Toolkit (Ubuntu on WSL2, with the NVIDIA driver installed on Windows, not in WSL):

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
```

On WSL, if containers fail with `Failed to initialize NVML` after a Windows driver update, run `sudo systemctl restart nvidia-cdi-refresh`.

Install Ollama and pull the model (Arch Linux):

```bash
sudo pacman -S ollama
sudo systemctl enable --now ollama
ollama pull qwen3:4b-instruct
```

Install Ollama and pull the model (Ubuntu on WSL2):

```bash
sudo apt-get install -y zstd
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b-instruct
```

The backend reaches Ollama at `host.docker.internal`, which is the Docker bridge (`172.17.0.1`), so Ollama has to listen there instead of on `127.0.0.1`:

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Unit]\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nEnvironment="OLLAMA_HOST=172.17.0.1:11434"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
echo 'export OLLAMA_HOST=172.17.0.1:11434' >> ~/.bashrc   # so the ollama CLI finds it too
```

Download the ASR and alignment models into the `model-cache` volume (the backend runs with `HF_HUB_OFFLINE=1`, so they aren't fetched on demand):

```bash
docker compose run --rm --no-deps -e HF_HUB_OFFLINE=0 backend python -c \
  "from huggingface_hub import snapshot_download as d; [d(m) for m in ('Qwen/Qwen3-ASR-0.6B', 'Qwen/Qwen3-ForcedAligner-0.6B')]"
```

## Commands

Run everything locally:

```bash
docker compose up --build
```

Run only the database and backend:

```bash
docker compose up --build db backend
```

Set up the Python venv for the static bundle scripts (they only need `psycopg` and `soundfile`):

```bash
sudo apt-get install -y python3-venv   # Ubuntu; Arch includes venv with python
python3 -m venv backend/venv
backend/venv/bin/pip install "psycopg[binary]" soundfile
```

Regenerate the static bundle (`docs/`, used by GitHub Pages). Export replaces the bundle with what's in Postgres, so on a fresh database import first:

```bash
cd frontend
npm run import:static   # load the existing bundle into Postgres
npm run export:static   # pull fresh data from Postgres
npm run deploy:docs     # build and copy into docs/
```

Without Node on the host, run the build with Docker instead of `npm run deploy:docs`:

```bash
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/..":/repo -w /repo/frontend \
  node:24-bookworm-slim sh -c "npm ci && npm run deploy:docs"
```
