import asyncio
import hashlib
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.request import Request, urlopen

import psycopg
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from psycopg.rows import dict_row
from yt_dlp import YoutubeDL


BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_DB_DSN = "postgresql://myuser:mypass@localhost:5432/postgres"
DB_DSN = os.environ.get("DATABASE_URL", DEFAULT_DB_DSN)
MEDIA_DIR = BACKEND_DIR / "media"
UPLOAD_DIR = MEDIA_DIR / "uploads"
YOUTUBE_DIR = MEDIA_DIR / "youtube"
SCRIPT_PATH = BACKEND_DIR / "test4.py"
FRONTEND_FILE_KINDS = {"audio", "thumbnail", "phrase_timestamps", "char_pinyin_timestamps"}
PROGRESS_TOTAL = 10
STAGE_PROGRESS = {
    "queued": 0,
    "upload_saved": 1,
    "download_queued": 1,
    "downloading": 2,
    "run_started": 2,
    "chunking": 3,
    "asr": 4,
    "phrase_split": 5,
    "pinyin": 6,
    "alignment": 7,
    "timestamp_mapping": 8,
    "db_save": 9,
    "completed": 10,
    "failed": 10,
}

job_queue: asyncio.Queue[str] = asyncio.Queue()
worker_task: asyncio.Task | None = None
active_job_id: str | None = None


def connect_db():
    return psycopg.connect(DB_DSN, row_factory=dict_row)


def backend_relative(path: Path) -> str:
    return path.resolve().relative_to(BACKEND_DIR).as_posix()


def resolve_storage_path(storage_path: str) -> Path:
    path = (BACKEND_DIR / storage_path).resolve()
    if not path.is_relative_to(BACKEND_DIR):
        raise HTTPException(status_code=400, detail="Invalid storage path")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found on disk")
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def thumbnail_extension(content_type: str | None, url: str) -> str:
    if content_type:
        content_type = content_type.split(";")[0].strip().lower()
        if content_type == "image/jpeg":
            return ".jpg"
        if content_type == "image/png":
            return ".png"
        if content_type == "image/webp":
            return ".webp"
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def parse_tags(tags: list[str] | None, tags_csv: str | None) -> list[str]:
    values: list[str] = []
    if tags:
        values.extend(tags)
    if tags_csv:
        values.extend(tags_csv.split(","))
    return [tag.strip() for tag in values if tag and tag.strip()]


def with_required_tag(tags: list[str], required_tag: str) -> list[str]:
    if any(tag.lower() == required_tag.lower() for tag in tags):
        return tags
    return [*tags, required_tag]


def create_job(
    upload_path: Path | None,
    display_name: str | None,
    tags: list[str],
    source_type: str = "upload",
    source_url: str | None = None,
) -> str:
    job_id = str(uuid.uuid4())
    stage = "upload_saved" if source_type == "upload" else "download_queued"
    message = (
        "Upload saved; waiting for processing worker."
        if source_type == "upload"
        else "YouTube URL queued; waiting for downloader."
    )
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into processing_jobs (
                    id,
                    source_type,
                    source_url,
                    upload_path,
                    display_name,
                    tags,
                    stage,
                    progress_current,
                    progress_total,
                    progress_percent,
                    last_message
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    job_id,
                    source_type,
                    source_url,
                    backend_relative(upload_path) if upload_path is not None else None,
                    display_name,
                    tags,
                    stage,
                    STAGE_PROGRESS[stage],
                    PROGRESS_TOTAL,
                    progress_percent(stage),
                    message,
                ),
            )
    return job_id


def progress_percent(stage: str) -> int:
    return round(STAGE_PROGRESS.get(stage, 0) * 100 / PROGRESS_TOTAL)


def infer_stage(line: str, stream_name: str) -> str | None:
    if stream_name == "stderr":
        return None
    if line.startswith("Audio stored at:") or line.startswith("Run ID:") or line.startswith("Output dir:"):
        return "run_started"
    if line.startswith("Starting local VAD/silence chunking.") or line.startswith("Audio chunks:"):
        return "chunking"
    if (
        line.startswith("Starting ASR.")
        or line.startswith("Transcribing chunk ")
        or line.startswith("Transcript saved to:")
        or line.startswith("Transcript length:")
    ):
        return "asr"
    if (
        line.startswith("Starting phrase split.")
        or line.startswith("Splitting phrase segment ")
        or line.startswith("Phrases saved to:")
    ):
        return "phrase_split"
    if line.startswith("Starting pinyin generation.") or line.startswith("Pinyin saved to:"):
        return "pinyin"
    if (
        line.startswith("Starting forced alignment.")
        or line.startswith("Aligning chunk ")
        or line.startswith("Character timestamps saved to:")
        or line.startswith("Aligned characters:")
    ):
        return "alignment"
    if (
        line.startswith("Starting timestamp mapping.")
        or line.startswith("Character timestamps with pinyin saved to:")
        or line.startswith("Phrase timestamps saved to:")
        or line.startswith("Phrase timestamps with pinyin saved to:")
        or line.startswith("Number of phrase timestamps:")
    ):
        return "timestamp_mapping"
    if line.startswith("Starting database save.") or line.startswith("Database rows saved."):
        return "db_save"
    return None


def update_job_state(job_id: str, stage: str, message: str, **fields):
    current = STAGE_PROGRESS[stage]
    set_clauses = [
        "stage = %s",
        "progress_current = greatest(progress_current, %s)",
        "progress_percent = greatest(progress_percent, %s)",
        "last_message = %s",
        "heartbeat_at = now()",
    ]
    values: list[object] = [stage, current, progress_percent(stage), message]
    for column, value in fields.items():
        set_clauses.append(f"{column} = %s")
        values.append(value)
    values.append(job_id)

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"update processing_jobs set {', '.join(set_clauses)} where id = %s",
                values,
            )


def download_youtube_audio(job_id: str, youtube_url: str) -> tuple[Path, Path | None, str | None]:
    output_dir = YOUTUBE_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "%(id)s.%(ext)s")
    log_lines: list[str] = []

    def progress_hook(status):
        if status.get("status") == "downloading":
            downloaded = status.get("downloaded_bytes") or 0
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            if total:
                message = f"Downloading YouTube audio: {downloaded}/{total} bytes."
            else:
                message = f"Downloading YouTube audio: {downloaded} bytes."
            update_job_state(job_id, "downloading", message)
        elif status.get("status") == "finished":
            update_job_state(job_id, "downloading", "YouTube download finished; extracting audio.")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "progress_hooks": [progress_hook],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "paths": {"home": str(output_dir)},
    }

    class Logger:
        def debug(self, message):
            if message:
                log_lines.append(str(message))

        def warning(self, message):
            update_job_progress(job_id, None, str(message), "stderr")

        def error(self, message):
            update_job_progress(job_id, None, str(message), "stderr")

    ydl_opts["logger"] = Logger()
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(youtube_url, download=True)
        prepared = Path(ydl.prepare_filename(info))
    title = str(info.get("title") or "").strip() or None

    mp3_path = prepared.with_suffix(".mp3")
    if not mp3_path.exists():
        candidates = sorted(output_dir.glob("*.mp3"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not candidates:
            raise RuntimeError("yt-dlp did not produce an mp3 audio file")
        mp3_path = candidates[0]

    thumbnail_path = None
    thumbnail_url = info.get("thumbnail")
    if thumbnail_url:
        try:
            request = Request(thumbnail_url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(request, timeout=30) as response:
                extension = thumbnail_extension(response.headers.get("Content-Type"), thumbnail_url)
                thumbnail_path = output_dir / f"{info.get('id') or job_id}_thumbnail{extension}"
                thumbnail_path.write_bytes(response.read())
            update_job_progress(job_id, "downloading", f"YouTube thumbnail saved to: {backend_relative(thumbnail_path)}", "stdout")
        except Exception as error:
            update_job_progress(job_id, None, f"WARNING: YouTube thumbnail download failed: {error}", "stderr")

    update_job_progress(job_id, "downloading", f"YouTube audio saved to: {backend_relative(mp3_path)}", "stdout")
    return mp3_path, thumbnail_path, title


def update_job_progress(job_id: str, stage: str | None, message: str, stream_name: str):
    stage = stage or "running"
    current = STAGE_PROGRESS.get(stage)
    percent = progress_percent(stage) if current is not None else None
    set_clauses = [
        "last_message = %s",
        "heartbeat_at = now()",
    ]
    values: list[object] = [message]

    if current is not None and percent is not None:
        set_clauses.extend(
            [
                "stage = %s",
                "progress_current = greatest(progress_current, %s)",
                "progress_percent = greatest(progress_percent, %s)",
            ]
        )
        values.extend([stage, current, percent])

    if stream_name == "stdout":
        set_clauses.append("stdout = coalesce(stdout, '') || %s")
    else:
        set_clauses.append("stderr = coalesce(stderr, '') || %s")
    values.extend([f"{message}\n", job_id])

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"update processing_jobs set {', '.join(set_clauses)} where id = %s",
                values,
            )


async def stream_process_output(job_id: str, stream: asyncio.StreamReader, stream_name: str):
    while True:
        line_bytes = await stream.readline()
        if not line_bytes:
            break
        line = line_bytes.decode("utf-8", errors="replace").rstrip()
        if line:
            update_job_progress(job_id, infer_stage(line, stream_name), line, stream_name)


async def run_processing_job(job_id: str):
    global active_job_id
    active_job_id = job_id

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select * from processing_jobs where id = %s", (job_id,))
            job = cur.fetchone()
            if job is None:
                active_job_id = None
                return

            upload_path = job["upload_path"]
            source_type = job["source_type"]
            source_url = job["source_url"]
            display_name = job["display_name"]
            tags = job["tags"] or []
            if source_type == "youtube":
                if not source_url:
                    raise RuntimeError("YouTube processing job is missing source_url")
                update_job_state(job_id, "downloading", "Starting YouTube audio download.")
                downloaded_path, thumbnail_path, youtube_title = await asyncio.to_thread(download_youtube_audio, job_id, source_url)
                upload_path = backend_relative(downloaded_path)
                thumbnail_path_value = backend_relative(thumbnail_path) if thumbnail_path is not None else None
                if not str(display_name or "").strip() and youtube_title:
                    display_name = youtube_title
                update_job_state(
                    job_id,
                    "downloading",
                    "YouTube audio downloaded.",
                    upload_path=upload_path,
                    downloaded_audio_path=upload_path,
                    thumbnail_path=thumbnail_path_value,
                    display_name=display_name,
                )

            command = [
                str(BACKEND_DIR / "venv" / "bin" / "python"),
                "-u",
                str(SCRIPT_PATH),
                "--audio",
                upload_path,
                "--run-id",
                job_id,
                "--source-type",
                source_type,
            ]
            if source_url:
                command.extend(["--source-url", source_url])
            if job.get("downloaded_audio_path") or source_type == "youtube":
                command.extend(["--downloaded-audio-path", upload_path])
            if source_type == "youtube" and thumbnail_path_value:
                command.extend(["--thumbnail-path", thumbnail_path_value])
            if display_name:
                command.extend(["--name", display_name])
            if tags:
                command.append("--tags")
                command.extend(tags)

            cur.execute(
                """
                update processing_jobs
                set status = 'running',
                    stage = 'run_started',
                    progress_current = greatest(progress_current, %s),
                    progress_total = %s,
                    progress_percent = greatest(progress_percent, %s),
                    last_message = 'Processing worker started.',
                    heartbeat_at = now(),
                    started_at = now(),
                    command = %s,
                    stdout = '',
                    stderr = ''
                where id = %s
                """,
                (
                    STAGE_PROGRESS["run_started"],
                    PROGRESS_TOTAL,
                    progress_percent("run_started"),
                    command,
                    job_id,
                ),
            )
            conn.commit()

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=BACKEND_DIR,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    await asyncio.gather(
        stream_process_output(job_id, process.stdout, "stdout"),
        stream_process_output(job_id, process.stderr, "stderr"),
    )
    await process.wait()
    status = "succeeded" if process.returncode == 0 else "failed"

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select id from processing_runs where id = %s", (job_id,))
            run_exists = cur.fetchone() is not None
            cur.execute("select stdout, stderr from processing_jobs where id = %s", (job_id,))
            log_row = cur.fetchone() or {"stdout": "", "stderr": ""}
            stdout = log_row["stdout"] or ""
            stderr = log_row["stderr"] or ""
            final_stage = "completed" if status == "succeeded" else "failed"
            cur.execute(
                """
                update processing_jobs
                set status = %s,
                    processing_run_id = case when %s then %s else processing_run_id end,
                    stage = %s,
                    progress_current = %s,
                    progress_percent = %s,
                    last_message = %s,
                    heartbeat_at = now(),
                    exit_code = %s,
                    error_message = case when %s = 'failed' then %s else null end,
                    completed_at = now()
                where id = %s
                """,
                (
                    status,
                    run_exists,
                    job_id,
                    final_stage,
                    STAGE_PROGRESS[final_stage],
                    progress_percent(final_stage),
                    "Processing completed." if status == "succeeded" else "Processing failed.",
                    process.returncode,
                    status,
                    stderr[-4000:] or stdout[-4000:],
                    job_id,
                ),
            )
            if status == "failed":
                cur.execute(
                    """
                    update processing_runs
                    set status = 'failed', completed_at = now(), error_message = %s
                    where id = %s and status <> 'succeeded'
                    """,
                    (stderr[-4000:] or stdout[-4000:], job_id),
                )
    active_job_id = None


def mark_job_failed(job_id: str, error: Exception):
    message = str(error)
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update processing_jobs
                set status = 'failed',
                    stage = 'failed',
                    progress_current = %s,
                    progress_total = %s,
                    progress_percent = 100,
                    last_message = %s,
                    heartbeat_at = now(),
                    stderr = coalesce(stderr, '') || %s,
                    error_message = %s,
                    exit_code = coalesce(exit_code, -1),
                    completed_at = now()
                where id = %s
                """,
                (
                    STAGE_PROGRESS["failed"],
                    PROGRESS_TOTAL,
                    "Processing failed.",
                    f"{message}\n",
                    message[-4000:],
                    job_id,
                ),
            )


async def queue_worker():
    global active_job_id
    while True:
        job_id = await job_queue.get()
        try:
            await run_processing_job(job_id)
        except Exception as error:
            mark_job_failed(job_id, error)
        finally:
            active_job_id = None
            job_queue.task_done()


async def load_queued_jobs():
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update processing_jobs
                set status = 'failed',
                    stage = 'failed',
                    progress_current = %s,
                    progress_percent = 100,
                    last_message = 'API process restarted while this job was running.',
                    heartbeat_at = now(),
                    completed_at = now(),
                    error_message = 'API process restarted while this job was running.'
                where status = 'running'
                """
                ,
                (STAGE_PROGRESS["failed"],),
            )
            cur.execute(
                """
                select id
                from processing_jobs
                where status = 'queued'
                order by queued_at
                """
            )
            queued_jobs = cur.fetchall()
    for job in queued_jobs:
        await job_queue.put(str(job["id"]))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global worker_task
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    YOUTUBE_DIR.mkdir(parents=True, exist_ok=True)
    await load_queued_jobs()
    worker_task = asyncio.create_task(queue_worker())
    try:
        yield
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="AIBA Backend API", lifespan=lifespan)


@app.get("/health")
def health():
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select 1 as ok")
            db = cur.fetchone()
    return {"ok": True, "db": db["ok"] == 1}


@app.get("/pipeline/state")
def pipeline_state():
    script_text = SCRIPT_PATH.read_bytes()
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select status, count(*) as count from processing_jobs group by status")
            job_counts = cur.fetchall()
            cur.execute("select count(*) as count from audio_assets")
            audio_count = cur.fetchone()["count"]
            cur.execute("select count(*) as count from processing_runs")
            run_count = cur.fetchone()["count"]
    return {
        "script": {
            "path": backend_relative(SCRIPT_PATH),
            "sha256": hashlib.sha256(script_text).hexdigest(),
            "size_bytes": len(script_text),
        },
        "models": {
            "asr": "Qwen/Qwen3-ASR-0.6B",
            "aligner": "Qwen/Qwen3-ForcedAligner-0.6B",
            "phrase_splitter": "qwen3:4b-instruct",
            "pinyin": "pypinyin+sandhi-rules",
        },
        "queue": {
            "active_job_id": active_job_id,
            "pending_in_memory": job_queue.qsize(),
            "db_counts": job_counts,
        },
        "database": {
            "audio_assets": audio_count,
            "processing_runs": run_count,
        },
    }


@app.post("/audio/process")
async def upload_and_enqueue_audio(
    audio: Annotated[UploadFile, File()],
    name: Annotated[str | None, Form()] = None,
    tags: Annotated[list[str] | None, Form()] = None,
    tags_csv: Annotated[str | None, Form()] = None,
):
    upload_id = uuid.uuid4()
    suffix = Path(audio.filename or "audio.mp3").suffix or ".mp3"
    upload_path = UPLOAD_DIR / f"{upload_id}{suffix}"

    with upload_path.open("wb") as f:
        while chunk := await audio.read(1024 * 1024):
            f.write(chunk)

    display_name = name or Path(audio.filename or upload_path.name).stem
    parsed_tags = parse_tags(tags, tags_csv)
    job_id = create_job(upload_path, display_name, parsed_tags, source_type="upload")
    await job_queue.put(job_id)

    return {
        "job_id": job_id,
        "status": "queued",
        "upload_path": backend_relative(upload_path),
        "source_type": "upload",
        "source_url": None,
        "name": display_name,
        "tags": parsed_tags,
    }


@app.post("/youtube/process")
async def enqueue_youtube_audio(
    youtube_url: Annotated[str, Form()],
    name: Annotated[str | None, Form()] = None,
    tags: Annotated[list[str] | None, Form()] = None,
    tags_csv: Annotated[str | None, Form()] = None,
):
    parsed_tags = with_required_tag(parse_tags(tags, tags_csv), "youtube")
    job_id = create_job(
        None,
        name,
        parsed_tags,
        source_type="youtube",
        source_url=youtube_url,
    )
    await job_queue.put(job_id)

    return {
        "job_id": job_id,
        "status": "queued",
        "source_type": "youtube",
        "source_url": youtube_url,
        "upload_path": None,
        "name": name,
        "tags": parsed_tags,
    }


@app.get("/queue")
def queue_state(status: Annotated[str | None, Query()] = None, limit: int = 50):
    params: list[object] = []
    where = ""
    if status:
        where = "where pj.status = %s"
        params.append(status)
    params.append(limit)

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                select pj.id, pj.processing_run_id, pj.status, pj.stage, pj.progress_current,
                       pj.progress_total, pj.progress_percent, pj.last_message, pj.heartbeat_at,
                       pj.source_type, pj.source_url, pj.upload_path, pj.downloaded_audio_path,
                       pj.thumbnail_path,
                       pj.display_name, pj.tags, pj.exit_code, pj.error_message,
                       pj.queued_at, pj.started_at, pj.completed_at,
                       coalesce(aa.is_curated, false) as is_curated,
                       coalesce(aa.tags, '{{}}'::text[]) as asset_tags,
                       extract(epoch from (
                           coalesce(pj.completed_at, now()) - coalesce(pj.started_at, pj.queued_at)
                       ))::integer as elapsed_seconds
                from processing_jobs pj
                left join processing_runs pr on pr.id = pj.processing_run_id
                left join audio_assets aa on aa.id = pr.audio_asset_id
                {where}
                order by pj.queued_at desc
                limit %s
                """,
                params,
            )
            jobs = cur.fetchall()

    return {
        "active_job_id": active_job_id,
        "pending_in_memory": job_queue.qsize(),
        "jobs": jobs,
    }


@app.get("/processing/{job_id}")
def processing_call_state(job_id: str):
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select *,
                       extract(epoch from (
                           coalesce(completed_at, now()) - coalesce(started_at, queued_at)
                       ))::integer as elapsed_seconds,
                       right(coalesce(stdout, ''), 4000) as tail_stdout,
                       right(coalesce(stderr, ''), 4000) as tail_stderr
                from processing_jobs
                where id = %s
                """,
                (job_id,),
            )
            job = cur.fetchone()
            if job is None:
                raise HTTPException(status_code=404, detail="Processing job not found")

            cur.execute(
                """
                select id, status, output_dir, error_message, started_at, completed_at
                from processing_runs
                where id = %s
                """,
                (job_id,),
            )
            run = cur.fetchone()

            cur.execute(
                """
                select id, file_kind, storage_path, mime_type, byte_size, sha256, created_at
                from generated_files
                where processing_run_id = %s
                order by file_kind
                """,
                (job_id,),
            )
            output_files_available = cur.fetchall()

    return {"job": job, "run": run, "output_files_available": output_files_available}


@app.get("/files")
def list_db_files(
    processing_run_id: Annotated[str | None, Query()] = None,
    audio_asset_id: Annotated[str | None, Query()] = None,
    file_kind: Annotated[str | None, Query()] = None,
    limit: int = 100,
):
    clauses = []
    params: list[object] = []

    if processing_run_id:
        clauses.append("gf.processing_run_id = %s")
        params.append(processing_run_id)
    if audio_asset_id:
        clauses.append("pr.audio_asset_id = %s")
        params.append(audio_asset_id)
    if file_kind:
        clauses.append("gf.file_kind = %s")
        params.append(file_kind)

    where = f"where {' and '.join(clauses)}" if clauses else ""
    params.append(limit)

    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                select gf.*, pr.audio_asset_id, pr.status as run_status
                from generated_files gf
                join processing_runs pr on pr.id = gf.processing_run_id
                {where}
                order by gf.created_at desc
                limit %s
                """,
                params,
            )
            files = cur.fetchall()
    return {"files": files}


@app.get("/runs/{run_id}/files")
def run_files(run_id: str, frontend_only: bool = False):
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select *
                from generated_files
                where processing_run_id = %s
                order by file_kind
                """,
                (run_id,),
            )
            files = cur.fetchall()

    if not files:
        raise HTTPException(status_code=404, detail="No generated files found for run")
    if frontend_only:
        files = [file for file in files if file["file_kind"] in FRONTEND_FILE_KINDS]
    return {"processing_run_id": run_id, "files": files}


@app.get("/runs/{run_id}/frontend-files")
def run_frontend_files(run_id: str):
    return run_files(run_id, frontend_only=True)


@app.get("/audio-assets/{audio_asset_id}/files")
def audio_asset_files(audio_asset_id: str, frontend_only: bool = False):
    kinds = tuple(FRONTEND_FILE_KINDS)
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select gf.*, pr.id as processing_run_id, pr.status as run_status, pr.completed_at
                from processing_runs pr
                join generated_files gf on gf.processing_run_id = pr.id
                where pr.audio_asset_id = %s
                  and (%s = false or gf.file_kind = any(%s))
                order by pr.completed_at desc nulls last, gf.file_kind
                """,
                (audio_asset_id, frontend_only, list(kinds)),
            )
            files = cur.fetchall()

    if not files:
        raise HTTPException(status_code=404, detail="No generated files found for audio asset")
    return {"audio_asset_id": audio_asset_id, "files": files}


@app.get("/files/{file_id}/download")
def download_generated_file(file_id: str):
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute("select * from generated_files where id = %s", (file_id,))
            record = cur.fetchone()
            if record is None:
                raise HTTPException(status_code=404, detail="Generated file not found")

    path = resolve_storage_path(record["storage_path"])
    return FileResponse(
        path,
        media_type=record["mime_type"],
        filename=path.name,
    )


@app.get("/runs/{run_id}/phrases")
def run_phrases(run_id: str):
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select phrase_index, start_seconds, end_seconds, hanzi, pinyin
                from transcript_phrases
                where processing_run_id = %s
                order by phrase_index
                """,
                (run_id,),
            )
            phrases = cur.fetchall()
    if not phrases:
        raise HTTPException(status_code=404, detail="No transcript phrases found for run")
    return {"processing_run_id": run_id, "phrases": phrases}


@app.get("/runs/{run_id}/characters")
def run_characters(run_id: str):
    with connect_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select char_index, phrase_char_index, start_seconds, end_seconds, hanzi, pinyin, is_estimated
                from transcript_characters
                where processing_run_id = %s
                order by char_index
                """,
                (run_id,),
            )
            characters = cur.fetchall()
    if not characters:
        raise HTTPException(status_code=404, detail="No transcript characters found for run")
    return {"processing_run_id": run_id, "characters": characters}
