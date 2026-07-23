from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import psycopg
from psycopg.rows import dict_row


ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"
PUBLIC_STATIC_DIR = ROOT_DIR / "frontend" / "public" / "static"
ASSET_DIR = PUBLIC_STATIC_DIR / "assets"
DB_DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://myuser:mypass@localhost:5432/postgres",
)
FRONTEND_FILE_KINDS = {"audio", "thumbnail"}


def json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    raise TypeError(f"Unsupported JSON value: {value!r}")


def with_tag(tags: list[str] | None, tag: str) -> list[str]:
    values = [value for value in (tags or []) if value]
    if any(value.lower() == tag.lower() for value in values):
        return values
    return [*values, tag]


def copy_static_file(run_id: str, file_record: dict) -> dict:
    source = (BACKEND_DIR / file_record["storage_path"]).resolve()
    if not source.is_file() or not source.is_relative_to(BACKEND_DIR):
        raise FileNotFoundError(file_record["storage_path"])

    destination_dir = ASSET_DIR / run_id
    destination_dir.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix or ".bin"
    destination = destination_dir / f"{file_record['file_kind']}{suffix}"
    shutil.copy2(source, destination)

    return {
        **file_record,
        "static_url": f"./static/assets/{run_id}/{destination.name}",
    }


def main() -> None:
    if PUBLIC_STATIC_DIR.exists():
        shutil.rmtree(PUBLIC_STATIC_DIR)
    ASSET_DIR.mkdir(parents=True, exist_ok=True)

    with psycopg.connect(DB_DSN, row_factory=dict_row) as conn:
        with conn.transaction():
            conn.execute(
                """
                update processing_jobs
                   set tags = array_append(tags, 'static')
                 where status = 'succeeded'
                   and processing_run_id is not null
                   and source_type <> 'youtube'
                   and not ('static' = any(tags))
                """
            )
            conn.execute(
                """
                update audio_assets aa
                   set tags = array_append(aa.tags, 'static')
                  from processing_runs pr
                  join processing_jobs pj on pj.processing_run_id = pr.id
                 where pr.audio_asset_id = aa.id
                   and pj.status = 'succeeded'
                   and pj.source_type <> 'youtube'
                   and not ('static' = any(aa.tags))
                """
            )

        jobs = conn.execute(
            """
            select pj.id, pj.processing_run_id, pj.status, pj.stage,
                   pj.progress_current, pj.progress_total, pj.progress_percent,
                   pj.last_message, pj.heartbeat_at,
                   extract(epoch from (
                       coalesce(pj.completed_at, now()) - coalesce(pj.started_at, pj.queued_at)
                   ))::integer as elapsed_seconds,
                   pj.upload_path, pj.source_type, pj.source_url,
                   pj.downloaded_audio_path, pj.thumbnail_path,
                   pj.display_name, pj.tags, pj.exit_code, pj.error_message,
                   pj.queued_at, pj.started_at, pj.completed_at,
                   coalesce(aa.is_curated, false) as is_curated,
                   coalesce(aa.tags, pj.tags) as asset_tags
              from processing_jobs pj
              join processing_runs pr on pr.id = pj.processing_run_id
              join audio_assets aa on aa.id = pr.audio_asset_id
             where pj.status = 'succeeded'
               and not ('no-publish' = any(pj.tags))
               and not ('no-publish' = any(aa.tags))
             order by pj.completed_at desc nulls last, pj.queued_at desc
            """
        ).fetchall()

        entries = []
        for job in jobs:
            run_id = str(job["processing_run_id"])
            run = conn.execute(
                """
                select id, status, output_dir, error_message, started_at, completed_at
                  from processing_runs
                 where id = %s
                """,
                (run_id,),
            ).fetchone()
            phrases = conn.execute(
                """
                select phrase_index, start_seconds, end_seconds, hanzi, pinyin
                  from transcript_phrases
                 where processing_run_id = %s
                 order by phrase_index
                """,
                (run_id,),
            ).fetchall()
            characters = conn.execute(
                """
                select char_index, phrase_char_index, start_seconds, end_seconds,
                       hanzi, pinyin, is_estimated
                  from transcript_characters
                 where processing_run_id = %s
                 order by char_index
                """,
                (run_id,),
            ).fetchall()
            words = conn.execute(
                """
                select tw.word_index, tp.phrase_index, tw.phrase_word_index,
                       tw.start_seconds, tw.end_seconds, tw.hanzi, tw.pinyin, tw.char_count
                  from transcript_words tw
                  join transcript_phrases tp on tp.id = tw.phrase_id
                 where tw.processing_run_id = %s
                 order by tw.word_index
                """,
                (run_id,),
            ).fetchall()
            files = conn.execute(
                """
                select id, processing_run_id, file_kind, storage_path, mime_type,
                       byte_size, sha256, created_at
                  from generated_files
                 where processing_run_id = %s
                   and file_kind = any(%s)
                 order by file_kind
                """,
                (run_id, list(FRONTEND_FILE_KINDS)),
            ).fetchall()

            static_files = [copy_static_file(run_id, file) for file in files]
            if job["source_type"] != "youtube":
                job["tags"] = with_tag(job["tags"], "static")
                job["asset_tags"] = with_tag(job["asset_tags"], "static")
            entries.append(
                {
                    "job": job,
                    "run": run,
                    "files": static_files,
                    "phrases": phrases,
                    "characters": characters,
                    "words": words,
                }
            )

    index = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "entries": entries,
    }
    (PUBLIC_STATIC_DIR / "aiba-static.json").write_text(
        json.dumps(index, ensure_ascii=False, default=json_default),
        encoding="utf-8",
    )
    print(f"Exported {len(entries)} static entries to {PUBLIC_STATIC_DIR}")


if __name__ == "__main__":
    main()
