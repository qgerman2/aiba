import argparse
import gc
import hashlib
import json
import mimetypes
import os
import re
import shutil
import uuid
from pathlib import Path

import jieba
import ollama
import psycopg
import soundfile as sf
import torch
from pydub import AudioSegment, silence
from pypinyin import Style, pinyin as hanzi_to_pinyin
from qwen_asr import Qwen3ASRModel, Qwen3ForcedAligner

jieba.setLogLevel(60)


BACKEND_DIR = Path(__file__).resolve().parent
DEFAULT_DB_DSN = "postgresql://myuser:mypass@localhost:5432/postgres"
ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"
ALIGNER_MODEL = "Qwen/Qwen3-ForcedAligner-0.6B"
OLLAMA_MODEL = "qwen3:4b-instruct"
LONG_AUDIO_SECONDS = 180


def log(message):
    print(message, flush=True)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate Chinese transcript, phrase timestamps, and pinyin character timestamps."
    )
    parser.add_argument(
        "--audio",
        default="your-file.mp3",
        help="Input audio path. Relative paths are resolved from backend/.",
    )
    parser.add_argument(
        "--name",
        help="Human-readable audio name. Defaults to the audio filename stem.",
    )
    parser.add_argument(
        "--tags",
        nargs="*",
        default=[],
        help="Optional space-separated tags, for example: --tags hsk lesson-10 monologue",
    )
    parser.add_argument(
        "--db-dsn",
        default=os.environ.get("DATABASE_URL", DEFAULT_DB_DSN),
        help="Postgres connection string.",
    )
    parser.add_argument(
        "--no-db",
        action="store_true",
        help="Write artifacts only; do not insert metadata/timestamps into Postgres.",
    )
    parser.add_argument(
        "--output-root",
        default="media",
        help="Artifact storage root. Relative paths are resolved from backend/.",
    )
    parser.add_argument(
        "--run-id",
        help="Optional UUID to use for the processing run. Defaults to a generated UUID.",
    )
    parser.add_argument(
        "--source-type",
        choices=["upload", "youtube"],
        default="upload",
        help="Where this audio came from.",
    )
    parser.add_argument(
        "--source-url",
        help="Original source URL, for example a YouTube URL.",
    )
    parser.add_argument(
        "--downloaded-audio-path",
        help="Backend-relative path for the downloaded source audio, when applicable.",
    )
    parser.add_argument(
        "--thumbnail-path",
        help="Backend-relative path for a source thumbnail, when available.",
    )
    parser.add_argument(
        "--chunking",
        choices=["auto", "on", "off"],
        default="auto",
        help="Use local silence-based VAD chunking. Auto enables it for long audio.",
    )
    parser.add_argument(
        "--chunk-threshold-seconds",
        type=float,
        default=LONG_AUDIO_SECONDS,
        help="Minimum duration for auto chunking.",
    )
    parser.add_argument(
        "--chunk-target-seconds",
        type=float,
        default=75.0,
        help="Preferred chunk duration when silence boundaries allow it.",
    )
    parser.add_argument(
        "--chunk-max-seconds",
        type=float,
        default=90.0,
        help="Maximum chunk duration before falling back to a hard cut.",
    )
    parser.add_argument(
        "--chunk-min-silence-ms",
        type=int,
        default=700,
        help="Minimum silence length used to find chunk boundaries.",
    )
    parser.add_argument(
        "--chunk-silence-thresh-db",
        type=float,
        help="Silence threshold in dBFS. Defaults to audio.dBFS - 16.",
    )
    parser.add_argument(
        "--phrase-split-max-chars",
        type=int,
        default=900,
        help="Maximum transcript characters per Ollama phrase-splitting request.",
    )
    return parser.parse_args()


def with_required_tag(tags, required_tag):
    if required_tag in tags:
        return tags
    return [*tags, required_tag]


def resolve_backend_path(path):
    path = Path(path).expanduser()
    if path.is_absolute():
        return path
    return BACKEND_DIR / path


def relative_to_backend(path):
    return path.resolve().relative_to(BACKEND_DIR).as_posix()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_original_audio(audio_path, output_root, sha256):
    ext = audio_path.suffix.lower() or ".mp3"
    original_dir = output_root / "audio" / "originals" / sha256[:2]
    original_dir.mkdir(parents=True, exist_ok=True)
    stored_audio_path = original_dir / f"{sha256}{ext}"
    if not stored_audio_path.exists():
        shutil.copy2(audio_path, stored_audio_path)
    return stored_audio_path


def file_record(path, kind, mime_type=None):
    return {
        "file_kind": kind,
        "storage_path": relative_to_backend(path),
        "mime_type": mime_type or mimetypes.guess_type(path.name)[0] or "text/plain; charset=utf-8",
        "byte_size": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def should_chunk_audio(args, audio_duration):
    if args.chunking == "on":
        return True
    if args.chunking == "off":
        return False
    return audio_duration >= args.chunk_threshold_seconds


def choose_chunk_end(start_ms, total_ms, split_points, target_ms, max_ms):
    remaining_ms = total_ms - start_ms
    if remaining_ms <= max_ms:
        return total_ms

    min_reasonable_ms = start_ms + max(10_000, target_ms // 2)
    max_allowed_ms = min(start_ms + max_ms, total_ms)
    candidates = [
        point
        for point in split_points
        if min_reasonable_ms <= point <= max_allowed_ms
    ]
    after_target = [point for point in candidates if point >= start_ms + target_ms]
    if after_target:
        return after_target[0]
    if candidates:
        return candidates[-1]
    return max_allowed_ms


def build_audio_chunks(stored_audio_path, output_dir, audio_duration, args):
    if not should_chunk_audio(args, audio_duration):
        return [
            {
                "chunk_index": 0,
                "start_seconds": 0.0,
                "end_seconds": round(audio_duration, 3),
                "audio_path": stored_audio_path,
                "transcript_text": "",
                "status": "pending",
            }
        ]

    log("Starting local VAD/silence chunking.")
    audio = AudioSegment.from_file(stored_audio_path)
    total_ms = len(audio)
    silence_thresh = (
        args.chunk_silence_thresh_db
        if args.chunk_silence_thresh_db is not None
        else audio.dBFS - 16
    )
    non_silent_ranges = silence.detect_nonsilent(
        audio,
        min_silence_len=args.chunk_min_silence_ms,
        silence_thresh=silence_thresh,
        seek_step=10,
    )

    split_points = []
    for previous, current in zip(non_silent_ranges, non_silent_ranges[1:]):
        silence_start = previous[1]
        silence_end = current[0]
        if silence_end > silence_start:
            split_points.append((silence_start + silence_end) // 2)

    target_ms = int(args.chunk_target_seconds * 1000)
    max_ms = int(args.chunk_max_seconds * 1000)
    chunks_dir = output_dir / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    chunks = []
    start_ms = 0
    while start_ms < total_ms:
        end_ms = choose_chunk_end(start_ms, total_ms, split_points, target_ms, max_ms)
        chunk_index = len(chunks)
        chunk_path = chunks_dir / f"chunk_{chunk_index:04d}.wav"
        audio[start_ms:end_ms].export(chunk_path, format="wav")
        chunks.append(
            {
                "chunk_index": chunk_index,
                "start_seconds": round(start_ms / 1000, 3),
                "end_seconds": round(end_ms / 1000, 3),
                "audio_path": chunk_path,
                "transcript_text": "",
                "status": "pending",
            }
        )
        start_ms = end_ms

    log(f"Audio chunks: {len(chunks)}")
    return chunks


def write_chunks_manifest(chunks, output_dir, base_name):
    manifest_path = output_dir / f"{base_name}_chunks.json"
    serializable_chunks = []
    for chunk in chunks:
        serializable_chunks.append(
            {
                "chunk_index": chunk["chunk_index"],
                "start_seconds": chunk["start_seconds"],
                "end_seconds": chunk["end_seconds"],
                "audio_path": relative_to_backend(chunk["audio_path"]),
                "status": chunk["status"],
                "transcript_text": chunk.get("transcript_text", ""),
            }
        )
    manifest_path.write_text(
        json.dumps(serializable_chunks, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def split_with_ollama(text, model=OLLAMA_MODEL):
    prompt = f"""Split the following Chinese text into natural phrases. Each phrase should be about 30 characters long. Only split at punctuation marks （。，）. Do not add, remove, or change any characters. Output one phrase per line. You must include every single character from the input.

Text:
{text}
"""
    response = ollama.chat(
        model=model,
        messages=[
            {
                "role": "system",
                "content": "You are a text formatter. Never explain, think, or add commentary. Output only the requested format.",
            },
            {"role": "user", "content": prompt},
        ],
        options={"temperature": 0.1},
    )
    return response["message"]["content"].strip()


def parse_phrases(output):
    lines = [line.strip() for line in output.split("\n") if line.strip()]
    cleaned = []
    for line in lines:
        line = re.sub(r"^\d+\.\s*", "", line)
        line = line.strip("`- ")
        cleaned.append(line)
    return cleaned


def split_with_regex(text):
    parts = re.split(r"(?<=[。，])", text)
    return [p.strip() for p in parts if p.strip()]


def split_text_for_phrase_model(text, max_chars):
    if len(text) <= max_chars:
        return [text]

    punctuation_parts = re.split(r"(?<=[。，])", text)
    segments = []
    current = ""

    for part in punctuation_parts:
        if not part:
            continue
        if current and len(current) + len(part) > max_chars:
            segments.append(current)
            current = ""

        while len(part) > max_chars:
            split_at = max_chars
            segments.append(part[:split_at])
            part = part[split_at:]

        current += part

    if current:
        segments.append(current)

    return segments


def split_phrases(text, max_chars):
    segments = split_text_for_phrase_model(text, max_chars)
    phrases = []

    for index, segment in enumerate(segments):
        if len(segments) > 1:
            log(f"Splitting phrase segment {index + 1}/{len(segments)}.")

        try:
            ollama_output = split_with_ollama(segment)
            segment_phrases = parse_phrases(ollama_output)
        except Exception as error:
            log(f"WARNING: Ollama phrase split failed for segment {index + 1}: {error}")
            segment_phrases = split_with_regex(segment)

        if "".join(segment_phrases) != segment:
            log(f"WARNING: Ollama output incomplete for segment {index + 1}. Falling back to regex.")
            segment_phrases = split_with_regex(segment)

        phrases.extend(segment_phrases)

    return phrases


def pinyin_units_with_dictionary(phrase):
    han_indices = [
        index for index, ch in enumerate(phrase) if "\u4e00" <= ch <= "\u9fff"
    ]
    if not han_indices:
        return []

    readings = hanzi_to_pinyin(
        phrase,
        style=Style.TONE3,
        neutral_tone_with_five=True,
        errors="ignore",
    )

    return [
        {"char": phrase[char_index], "pinyin": reading[0]}
        for char_index, reading in zip(han_indices, readings)
    ]


def segment_phrase_words(phrase, units):
    tokens = jieba.lcut(phrase)
    words = []
    unit_index = 0

    for token in tokens:
        char_count = sum(1 for ch in token if "一" <= ch <= "鿿")
        if char_count == 0:
            continue

        word_units = units[unit_index:unit_index + char_count]
        words.append({"word": token, "char_count": char_count, "units": word_units})
        unit_index += char_count

    return words


def expand_to_char_timestamps(segments, offset_seconds=0.0):
    chars = []
    for segment in segments:
        text = segment.text
        start = segment.start_time + offset_seconds
        end = segment.end_time + offset_seconds
        text_chars = list(text)
        if len(text_chars) == 1:
            chars.append((text_chars[0], start, end))
        else:
            duration = end - start
            for i, ch in enumerate(text_chars):
                ch_start = start + (duration * i / len(text_chars))
                ch_end = start + (duration * (i + 1) / len(text_chars))
                chars.append((ch, ch_start, ch_end))
    return chars


def create_audio_asset(
    conn,
    audio_path,
    stored_audio_path,
    audio_info,
    display_name,
    tags,
    sha256,
    source_type="upload",
    source_url=None,
    downloaded_audio_path=None,
    thumbnail_path=None,
):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into audio_assets (
                sha256,
                original_filename,
                storage_path,
                mime_type,
                byte_size,
                duration_seconds,
                sample_rate,
                channels,
                source_type,
                source_url,
                downloaded_audio_path,
                thumbnail_path,
                display_name,
                title,
                tags
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (sha256) do update set
                source_type = excluded.source_type,
                source_url = coalesce(excluded.source_url, audio_assets.source_url),
                downloaded_audio_path = coalesce(excluded.downloaded_audio_path, audio_assets.downloaded_audio_path),
                thumbnail_path = coalesce(excluded.thumbnail_path, audio_assets.thumbnail_path),
                display_name = excluded.display_name,
                title = excluded.title,
                tags = excluded.tags
            returning id
            """,
            (
                sha256,
                audio_path.name,
                relative_to_backend(stored_audio_path),
                mimetypes.guess_type(audio_path.name)[0] or "audio/mpeg",
                audio_path.stat().st_size,
                round(float(audio_info.duration), 3),
                audio_info.samplerate,
                audio_info.channels,
                source_type,
                source_url,
                downloaded_audio_path,
                thumbnail_path,
                display_name,
                display_name,
                tags,
            ),
        )
        return cur.fetchone()[0]


def create_processing_run(conn, run_id, audio_asset_id, output_dir):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into processing_runs (
                id,
                audio_asset_id,
                status,
                asr_model,
                aligner_model,
                phrase_splitter_model,
                pinyin_method,
                word_segmenter,
                output_dir
            )
            values (%s, %s, 'running', %s, %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                audio_asset_id,
                ASR_MODEL,
                ALIGNER_MODEL,
                OLLAMA_MODEL,
                "pypinyin+dictionary",
                "jieba",
                relative_to_backend(output_dir),
            ),
        )


def persist_results(conn, run_id, transcript, chunks, generated_file_records, phrase_timestamps, char_pinyin_timestamps, word_timestamps):
    with conn.cursor() as cur:
        cur.execute(
            "update processing_runs set transcript_text = %s where id = %s",
            (transcript, run_id),
        )

        for record in generated_file_records:
            cur.execute(
                """
                insert into generated_files (
                    processing_run_id,
                    file_kind,
                    storage_path,
                    mime_type,
                    byte_size,
                    sha256
                )
                values (%s, %s, %s, %s, %s, %s)
                on conflict (processing_run_id, file_kind) do update set
                    storage_path = excluded.storage_path,
                    mime_type = excluded.mime_type,
                    byte_size = excluded.byte_size,
                    sha256 = excluded.sha256
                """,
                (
                    run_id,
                    record["file_kind"],
                    record["storage_path"],
                    record["mime_type"],
                    record["byte_size"],
                    record["sha256"],
                ),
            )

        for chunk in chunks:
            cur.execute(
                """
                insert into processing_chunks (
                    processing_run_id,
                    chunk_index,
                    start_seconds,
                    end_seconds,
                    audio_path,
                    transcript_text,
                    status,
                    completed_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, now())
                on conflict (processing_run_id, chunk_index) do update set
                    start_seconds = excluded.start_seconds,
                    end_seconds = excluded.end_seconds,
                    audio_path = excluded.audio_path,
                    transcript_text = excluded.transcript_text,
                    status = excluded.status,
                    completed_at = excluded.completed_at
                """,
                (
                    run_id,
                    chunk["chunk_index"],
                    chunk["start_seconds"],
                    chunk["end_seconds"],
                    relative_to_backend(chunk["audio_path"]),
                    chunk.get("transcript_text", ""),
                    chunk["status"],
                ),
            )

        phrase_ids = []
        char_offset = 0
        for phrase_index, phrase in enumerate(phrase_timestamps):
            start, end, hanzi, pinyin, char_count = phrase
            cur.execute(
                """
                insert into transcript_phrases (
                    processing_run_id,
                    phrase_index,
                    start_seconds,
                    end_seconds,
                    hanzi,
                    pinyin
                )
                values (%s, %s, %s, %s, %s, %s)
                returning id
                """,
                (run_id, phrase_index, start, end, hanzi, pinyin),
            )
            phrase_id = cur.fetchone()[0]
            phrase_ids.append((phrase_id, char_offset, char_count))
            char_offset += char_count

        phrase_lookup = {}
        for phrase_id, start_offset, char_count in phrase_ids:
            for phrase_char_index in range(char_count):
                phrase_lookup[start_offset + phrase_char_index] = (phrase_id, phrase_char_index)

        for char_index, item in enumerate(char_pinyin_timestamps):
            start, end, hanzi, pinyin, is_estimated = item
            phrase_id, phrase_char_index = phrase_lookup.get(char_index, (None, None))
            cur.execute(
                """
                insert into transcript_characters (
                    processing_run_id,
                    phrase_id,
                    char_index,
                    phrase_char_index,
                    start_seconds,
                    end_seconds,
                    hanzi,
                    pinyin,
                    is_estimated
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    phrase_id,
                    char_index,
                    phrase_char_index,
                    start,
                    end,
                    hanzi,
                    pinyin,
                    is_estimated,
                ),
            )

        phrase_id_by_index = {
            phrase_index: phrase_id
            for phrase_index, (phrase_id, _start_offset, _char_count) in enumerate(phrase_ids)
        }

        for word_index, item in enumerate(word_timestamps):
            start, end, hanzi, pinyin, phrase_index, phrase_word_index, char_count = item
            cur.execute(
                """
                insert into transcript_words (
                    processing_run_id,
                    phrase_id,
                    word_index,
                    phrase_word_index,
                    start_seconds,
                    end_seconds,
                    hanzi,
                    pinyin,
                    char_count
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    run_id,
                    phrase_id_by_index.get(phrase_index),
                    word_index,
                    phrase_word_index,
                    start,
                    end,
                    hanzi,
                    pinyin,
                    char_count,
                ),
            )

        cur.execute(
            "update processing_runs set status = 'succeeded', completed_at = now() where id = %s",
            (run_id,),
        )


def mark_run_failed(conn, run_id, error):
    with conn.cursor() as cur:
        cur.execute(
            """
            update processing_runs
            set status = 'failed', completed_at = now(), error_message = %s
            where id = %s
            """,
            (str(error), run_id),
        )


def run_pipeline(args):
    audio_path = resolve_backend_path(args.audio)
    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    display_name = args.name or audio_path.stem
    tags = args.tags or []
    if args.source_type == "youtube":
        tags = with_required_tag(tags, "youtube")
    base_name = audio_path.stem
    output_root = resolve_backend_path(args.output_root)
    audio_sha256 = sha256_file(audio_path)
    stored_audio_path = copy_original_audio(audio_path, output_root, audio_sha256)
    audio_info = sf.info(stored_audio_path)
    audio_duration = audio_info.duration
    run_id = uuid.UUID(args.run_id) if args.run_id else uuid.uuid4()
    output_dir = output_root / "runs" / str(run_id)
    output_dir.mkdir(parents=True, exist_ok=False)

    conn = None
    if not args.no_db:
        conn = psycopg.connect(args.db_dsn)
        audio_asset_id = create_audio_asset(
            conn,
            audio_path,
            stored_audio_path,
            audio_info,
            display_name,
            tags,
            audio_sha256,
            args.source_type,
            args.source_url,
            args.downloaded_audio_path,
            args.thumbnail_path,
        )
        create_processing_run(conn, run_id, audio_asset_id, output_dir)
        conn.commit()

    log(f"Audio stored at: {relative_to_backend(stored_audio_path)}")
    log(f"Run ID: {run_id}")
    log(f"Output dir: {relative_to_backend(output_dir)}")

    try:
        chunks = build_audio_chunks(stored_audio_path, output_dir, audio_duration, args)
        chunks_manifest_file = write_chunks_manifest(chunks, output_dir, base_name)

        # Step 1: ASR
        log("Starting ASR.")
        asr_model = Qwen3ASRModel.from_pretrained(
            ASR_MODEL,
            dtype=torch.bfloat16,
            device_map="cuda:0",
            max_new_tokens=256,
        )
        try:
            transcript_parts = []
            for chunk in chunks:
                chunk["status"] = "running"
                log(f"Transcribing chunk {chunk['chunk_index'] + 1}/{len(chunks)}.")
                asr_results = asr_model.transcribe(audio=str(chunk["audio_path"]), language="Chinese")
                chunk_transcript = asr_results[0].text
                chunk["transcript_text"] = chunk_transcript
                chunk["status"] = "succeeded"
                transcript_parts.append(chunk_transcript)
            transcript = "".join(transcript_parts)
        except Exception:
            for chunk in chunks:
                if chunk["status"] == "running":
                    chunk["status"] = "failed"
            raise
        finally:
            del asr_model
            gc.collect()
            torch.cuda.empty_cache()

        chunks_manifest_file = write_chunks_manifest(chunks, output_dir, base_name)

        transcript_file = output_dir / f"{base_name}.txt"
        transcript_file.write_text(transcript, encoding="utf-8")

        log(f"Transcript saved to: {relative_to_backend(transcript_file)}")
        log(f"Transcript length: {len(transcript)} chars")
        log(f"Audio duration: {audio_duration:.3f}s")

        # Step 2: Split phrases with Ollama
        log("Starting phrase split.")
        phrases = split_phrases(transcript, args.phrase_split_max_chars)

        phrases_file = output_dir / f"{base_name}_phrases.txt"
        phrases_file.write_text("\n".join(phrases) + "\n", encoding="utf-8")
        log(f"Phrases saved to: {relative_to_backend(phrases_file)}")

        # Step 2.5: Generate dictionary-based pinyin
        log("Starting pinyin generation.")
        phrase_pinyin_units = [pinyin_units_with_dictionary(phrase) for phrase in phrases]
        phrase_pinyin = [
            " ".join(unit["pinyin"] for unit in units)
            for units in phrase_pinyin_units
        ]

        pinyin_file = output_dir / f"{base_name}_pinyin.txt"
        with pinyin_file.open("w", encoding="utf-8") as f:
            for phrase, pinyin in zip(phrases, phrase_pinyin):
                f.write(f"{phrase}\n{pinyin}\n\n")
        log(f"Pinyin saved to: {relative_to_backend(pinyin_file)}")

        # Step 3: Forced aligner
        log("Starting forced alignment.")
        aligner = Qwen3ForcedAligner.from_pretrained(
            ALIGNER_MODEL,
            dtype=torch.bfloat16,
            device_map="cuda:0",
        )
        try:
            char_list = []
            for chunk in chunks:
                chunk_transcript = chunk.get("transcript_text", "")
                if not chunk_transcript:
                    continue
                log(f"Aligning chunk {chunk['chunk_index'] + 1}/{len(chunks)}.")
                align_results = aligner.align(
                    audio=str(chunk["audio_path"]),
                    text=chunk_transcript,
                    language="Chinese",
                )
                char_list.extend(
                    expand_to_char_timestamps(
                        align_results[0],
                        offset_seconds=chunk["start_seconds"],
                    )
                )
        finally:
            del aligner
            gc.collect()
            torch.cuda.empty_cache()

        char_timestamps_file = output_dir / f"{base_name}_char_timestamps.txt"
        with char_timestamps_file.open("w", encoding="utf-8") as f:
            for ch, ch_start, ch_end in char_list:
                f.write(f"[{ch_start:.3f} -> {ch_end:.3f}] {ch}\n")

        log(f"Character timestamps saved to: {relative_to_backend(char_timestamps_file)}")
        log(f"Aligned characters: {len(char_list)} / transcript chars: {len(transcript)}")

        # Step 4: Map to character and phrase timestamps with fallback for unaligned tail
        log("Starting timestamp mapping.")
        all_pinyin_units = [
            unit
            for units in phrase_pinyin_units
            for unit in units
        ]
        char_pinyin_timestamps = []
        phrase_timestamps = []
        char_idx = 0
        last_aligned_end = 0.0

        for unit_index, unit in enumerate(all_pinyin_units):
            while char_idx < len(char_list) and not ("\u4e00" <= char_list[char_idx][0] <= "\u9fff"):
                char_idx += 1

            if char_idx < len(char_list):
                ch, ch_start, ch_end = char_list[char_idx]
                if ch != unit["char"]:
                    log(f"WARNING: Character mismatch: expected {unit['char']} but aligned {ch}")
                char_pinyin_timestamps.append((ch_start, ch_end, unit["char"], unit["pinyin"], False))
                last_aligned_end = ch_end
                char_idx += 1
            else:
                remaining_chars = len(all_pinyin_units) - unit_index
                remaining_audio = max(audio_duration - last_aligned_end, 0.0)
                time_per_char = remaining_audio / remaining_chars if remaining_chars else 0.0
                est_start = last_aligned_end
                est_end = est_start + time_per_char
                char_pinyin_timestamps.append((est_start, est_end, unit["char"], unit["pinyin"], True))
                last_aligned_end = est_end

        char_pinyin_timestamps_file = output_dir / f"{base_name}_char_pinyin_timestamps.txt"
        with char_pinyin_timestamps_file.open("w", encoding="utf-8") as f:
            for start, end, ch, pinyin, _is_estimated in char_pinyin_timestamps:
                f.write(f"[{start:.3f} -> {end:.3f}] {ch} {pinyin}\n")

        log("Starting word segmentation.")
        word_timestamps = []
        char_offset = 0
        for phrase_index, (phrase, pinyin, units) in enumerate(
            zip(phrases, phrase_pinyin, phrase_pinyin_units)
        ):
            phrase_char_count = len(units)
            phrase_chars = char_pinyin_timestamps[char_offset:char_offset + phrase_char_count]
            char_offset += phrase_char_count

            if phrase_chars:
                start_time = phrase_chars[0][0]
                end_time = phrase_chars[-1][1]
                phrase_timestamps.append((start_time, end_time, phrase, pinyin, phrase_char_count))

            words = segment_phrase_words(phrase, units)
            word_char_offset = 0
            for phrase_word_index, word in enumerate(words):
                word_chars = phrase_chars[
                    word_char_offset:word_char_offset + word["char_count"]
                ]
                word_char_offset += word["char_count"]
                if not word_chars:
                    continue
                word_pinyin = " ".join(unit["pinyin"] for unit in word["units"])
                word_timestamps.append(
                    (
                        word_chars[0][0],
                        word_chars[-1][1],
                        word["word"],
                        word_pinyin,
                        phrase_index,
                        phrase_word_index,
                        word["char_count"],
                    )
                )
        log(f"Number of words segmented: {len(word_timestamps)}")

        phrase_timestamps_file = output_dir / f"{base_name}_phrase_timestamps.txt"
        with phrase_timestamps_file.open("w", encoding="utf-8") as f:
            for start, end, phrase, _pinyin, _char_count in phrase_timestamps:
                f.write(f"[{start:.3f} -> {end:.3f}] {phrase}\n")

        phrase_timestamps_pinyin_file = output_dir / f"{base_name}_phrase_timestamps_pinyin.txt"
        with phrase_timestamps_pinyin_file.open("w", encoding="utf-8") as f:
            for start, end, phrase, pinyin, _char_count in phrase_timestamps:
                f.write(f"[{start:.3f} -> {end:.3f}] {phrase}\n")
                f.write(f"{pinyin}\n\n")

        log(f"Character timestamps with pinyin saved to: {relative_to_backend(char_pinyin_timestamps_file)}")
        log(f"Phrase timestamps saved to: {relative_to_backend(phrase_timestamps_file)}")
        log(f"Phrase timestamps with pinyin saved to: {relative_to_backend(phrase_timestamps_pinyin_file)}")
        log(f"Number of phrase timestamps: {len(phrase_timestamps)}")

        if conn is not None:
            log("Starting database save.")
            generated_file_records = [
                file_record(stored_audio_path, "audio", mimetypes.guess_type(stored_audio_path.name)[0] or "audio/mpeg"),
                file_record(transcript_file, "transcript"),
                file_record(phrases_file, "phrases"),
                file_record(pinyin_file, "pinyin"),
                file_record(chunks_manifest_file, "chunks_manifest"),
                file_record(char_timestamps_file, "char_timestamps"),
                file_record(char_pinyin_timestamps_file, "char_pinyin_timestamps"),
                file_record(phrase_timestamps_file, "phrase_timestamps"),
                file_record(phrase_timestamps_pinyin_file, "phrase_timestamps_pinyin"),
            ]
            if args.thumbnail_path:
                thumbnail_file = resolve_backend_path(args.thumbnail_path)
                if thumbnail_file.exists():
                    generated_file_records.append(
                        file_record(
                            thumbnail_file,
                            "thumbnail",
                            mimetypes.guess_type(thumbnail_file.name)[0] or "image/jpeg",
                        )
                    )
            persist_results(
                conn,
                run_id,
                transcript,
                chunks,
                generated_file_records,
                phrase_timestamps,
                char_pinyin_timestamps,
                word_timestamps,
            )
            conn.commit()
            log("Database rows saved.")

    except Exception as error:
        if conn is not None:
            mark_run_failed(conn, run_id, error)
            conn.commit()
        raise
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    run_pipeline(parse_args())
