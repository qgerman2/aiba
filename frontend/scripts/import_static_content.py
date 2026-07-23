from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import psycopg
import soundfile as sf

ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"
PUBLIC_STATIC_DIR = ROOT_DIR / "frontend" / "public" / "static"
STATIC_JSON = PUBLIC_STATIC_DIR / "aiba-static.json"
STATIC_ASSETS_DIR = PUBLIC_STATIC_DIR / "assets"
DB_DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://myuser:mypass@localhost:5432/postgres",
)

ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"
ALIGNER_MODEL = "Qwen/Qwen3-ForcedAligner-0.6B"
PHRASE_SPLITTER_MODEL = "qwen3:4b-instruct"
PINYIN_METHOD = "pypinyin+dictionary"
WORD_SEGMENTER = "jieba"


def restore_media_file(run_id: str, file_record: dict) -> bool:
    static_dir = STATIC_ASSETS_DIR / run_id
    suffix = Path(file_record["storage_path"]).suffix
    source = static_dir / f"{file_record['file_kind']}{suffix}"
    destination = BACKEND_DIR / file_record["storage_path"]

    if destination.exists():
        return True
    if not source.is_file():
        print(f"  WARNING: missing static asset for {run_id} ({file_record['file_kind']})")
        return False

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return True


def import_entry(conn, entry: dict) -> bool:
    job = entry["job"]
    run = entry["run"]
    run_id = run["id"]

    audio_file = next((f for f in entry["files"] if f["file_kind"] == "audio"), None)
    if audio_file is None:
        print(f"  WARNING: run {run_id} has no audio file record; skipping.")
        return False

    for file_record in entry["files"]:
        restore_media_file(run_id, file_record)

    audio_path_on_disk = BACKEND_DIR / audio_file["storage_path"]
    duration = sample_rate = channels = None
    if audio_path_on_disk.is_file():
        info = sf.info(audio_path_on_disk)
        duration = round(float(info.duration), 3)
        sample_rate = info.samplerate
        channels = info.channels

    with conn.cursor() as cur:
        cur.execute(
            """
            insert into audio_assets (
                sha256, original_filename, storage_path, mime_type, byte_size,
                duration_seconds, sample_rate, channels,
                source_type, source_url, downloaded_audio_path, thumbnail_path,
                display_name, title, tags, is_curated
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (sha256) do update set
                display_name = excluded.display_name,
                title = excluded.title
            returning id
            """,
            (
                audio_file["sha256"],
                Path(audio_file["storage_path"]).name,
                audio_file["storage_path"],
                audio_file["mime_type"],
                audio_file["byte_size"],
                duration,
                sample_rate,
                channels,
                job["source_type"],
                job["source_url"],
                job["downloaded_audio_path"],
                job["thumbnail_path"],
                job["display_name"],
                job["display_name"],
                job.get("asset_tags") or job.get("tags") or [],
                job.get("is_curated", False),
            ),
        )
        audio_asset_id = cur.fetchone()[0]

        transcript_text = "".join(p["hanzi"] for p in entry["phrases"])
        cur.execute(
            """
            insert into processing_runs (
                id, audio_asset_id, status, transcript_text,
                asr_model, aligner_model, phrase_splitter_model, pinyin_method,
                word_segmenter, output_dir, error_message, started_at, completed_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                audio_asset_id,
                run["status"],
                transcript_text,
                ASR_MODEL,
                ALIGNER_MODEL,
                PHRASE_SPLITTER_MODEL,
                PINYIN_METHOD,
                WORD_SEGMENTER,
                run["output_dir"],
                run["error_message"],
                run["started_at"],
                run["completed_at"],
            ),
        )

        cur.execute(
            """
            insert into processing_jobs (
                id, processing_run_id, status, source_type, source_url,
                upload_path, downloaded_audio_path, thumbnail_path,
                display_name, tags, stage, progress_current, progress_total,
                progress_percent, last_message, heartbeat_at,
                exit_code, error_message, queued_at, started_at, completed_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                job["id"],
                run_id,
                job["status"],
                job["source_type"],
                job["source_url"],
                job["upload_path"],
                job["downloaded_audio_path"],
                job["thumbnail_path"],
                job["display_name"],
                job.get("tags") or [],
                job["stage"],
                job["progress_current"],
                job["progress_total"],
                job["progress_percent"],
                job["last_message"],
                job["heartbeat_at"],
                job["exit_code"],
                job["error_message"],
                job["queued_at"],
                job["started_at"],
                job["completed_at"],
            ),
        )

        for file_record in entry["files"]:
            cur.execute(
                """
                insert into generated_files (
                    id, processing_run_id, file_kind, storage_path,
                    mime_type, byte_size, sha256, created_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (processing_run_id, file_kind) do nothing
                """,
                (
                    file_record["id"],
                    run_id,
                    file_record["file_kind"],
                    file_record["storage_path"],
                    file_record["mime_type"],
                    file_record["byte_size"],
                    file_record["sha256"],
                    file_record["created_at"],
                ),
            )

        phrase_id_by_index: dict[int, int] = {}
        for phrase in entry["phrases"]:
            cur.execute(
                """
                insert into transcript_phrases (
                    processing_run_id, phrase_index, start_seconds,
                    end_seconds, hanzi, pinyin
                )
                values (%s, %s, %s, %s, %s, %s)
                returning id
                """,
                (
                    run_id,
                    phrase["phrase_index"],
                    phrase["start_seconds"],
                    phrase["end_seconds"],
                    phrase["hanzi"],
                    phrase["pinyin"],
                ),
            )
            phrase_id_by_index[phrase["phrase_index"]] = cur.fetchone()[0]

        phrase_ptr = -1
        for char in entry["characters"]:
            if char["phrase_char_index"] == 0:
                phrase_ptr += 1
            phrase_id = phrase_id_by_index.get(phrase_ptr)
            cur.execute(
                """
                insert into transcript_characters (
                    processing_run_id, phrase_id, char_index, phrase_char_index,
                    start_seconds, end_seconds, hanzi, pinyin, is_estimated
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    phrase_id,
                    char["char_index"],
                    char["phrase_char_index"],
                    char["start_seconds"],
                    char["end_seconds"],
                    char["hanzi"],
                    char["pinyin"],
                    char["is_estimated"],
                ),
            )

        for word in entry.get("words", []):
            phrase_id = phrase_id_by_index.get(word["phrase_index"])
            cur.execute(
                """
                insert into transcript_words (
                    processing_run_id, phrase_id, word_index, phrase_word_index,
                    start_seconds, end_seconds, hanzi, pinyin, char_count
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    phrase_id,
                    word["word_index"],
                    word["phrase_word_index"],
                    word["start_seconds"],
                    word["end_seconds"],
                    word["hanzi"],
                    word["pinyin"],
                    word["char_count"],
                ),
            )

    return True


def main() -> None:
    if not STATIC_JSON.is_file():
        raise SystemExit(f"No static bundle found at {STATIC_JSON}")

    data = json.loads(STATIC_JSON.read_text(encoding="utf-8"))
    entries = data["entries"]

    with psycopg.connect(DB_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("select id from processing_runs")
            existing_run_ids = {str(row[0]) for row in cur.fetchall()}

        imported = 0
        skipped = 0
        for entry in entries:
            run_id = entry["run"]["id"]
            if run_id in existing_run_ids:
                skipped += 1
                continue

            print(f"Importing {run_id} ({entry['job']['display_name']})...")
            if import_entry(conn, entry):
                conn.commit()
                imported += 1
            else:
                conn.rollback()

    print(f"Imported {imported} runs, skipped {skipped} already-present runs.")


if __name__ == "__main__":
    main()
