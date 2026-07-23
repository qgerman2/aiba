-- AIBA backend schema.
-- Store audio and generated artifacts on disk/object storage; store metadata,
-- transcript structure, pinyin, and timestamps in Postgres.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists audio_assets (
    id uuid primary key default gen_random_uuid(),
    sha256 text not null unique,
    original_filename text not null,
    storage_path text not null unique,
    mime_type text not null default 'audio/mpeg',
    byte_size bigint not null check (byte_size > 0),
    duration_seconds numeric(12, 3) check (duration_seconds is null or duration_seconds >= 0),
    sample_rate integer check (sample_rate is null or sample_rate > 0),
    channels integer check (channels is null or channels > 0),
    language_code text not null default 'zh',
    source_type text not null default 'upload'
        check (source_type in ('upload', 'youtube')),
    source_url text,
    downloaded_audio_path text,
    thumbnail_path text,
    display_name text,
    title text,
    tags text[] not null default '{}',
    is_curated boolean not null default false,
    imported_at timestamptz not null default now()
);

alter table audio_assets
    add column if not exists source_type text not null default 'upload';

alter table audio_assets
    add column if not exists source_url text;

alter table audio_assets
    add column if not exists downloaded_audio_path text;

alter table audio_assets
    add column if not exists thumbnail_path text;

alter table audio_assets
    add column if not exists display_name text;

alter table audio_assets
    add column if not exists title text;

alter table audio_assets
    add column if not exists tags text[] not null default '{}';

alter table audio_assets
    add column if not exists is_curated boolean not null default false;

create table if not exists processing_runs (
    id uuid primary key default gen_random_uuid(),
    audio_asset_id uuid not null references audio_assets(id) on delete cascade,
    status text not null default 'pending'
        check (status in ('pending', 'running', 'succeeded', 'failed')),
    transcript_text text,
    asr_model text not null default 'Qwen/Qwen3-ASR-0.6B',
    aligner_model text not null default 'Qwen/Qwen3-ForcedAligner-0.6B',
    phrase_splitter_model text not null default 'qwen3:4b-instruct',
    pinyin_method text not null default 'pypinyin+dictionary',
    word_segmenter text not null default 'jieba',
    script_name text not null default 'test4.py',
    script_version text,
    output_dir text not null,
    error_message text,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    check (completed_at is null or completed_at >= started_at)
);

alter table processing_runs
    add column if not exists word_segmenter text not null default 'jieba';

create table if not exists processing_jobs (
    id uuid primary key default gen_random_uuid(),
    processing_run_id uuid references processing_runs(id) on delete set null,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'succeeded', 'failed')),
    source_type text not null default 'upload'
        check (source_type in ('upload', 'youtube')),
    source_url text,
    upload_path text,
    downloaded_audio_path text,
    thumbnail_path text,
    display_name text,
    tags text[] not null default '{}',
    stage text not null default 'queued',
    progress_current integer not null default 0,
    progress_total integer not null default 10,
    progress_percent integer not null default 0 check (progress_percent between 0 and 100),
    last_message text,
    heartbeat_at timestamptz not null default now(),
    command text[] not null default '{}',
    stdout text,
    stderr text,
    exit_code integer,
    error_message text,
    queued_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    check (started_at is null or started_at >= queued_at),
    check (completed_at is null or started_at is not null),
    check (completed_at is null or completed_at >= started_at)
);

alter table processing_jobs
    add column if not exists source_type text not null default 'upload';

alter table processing_jobs
    add column if not exists source_url text;

alter table processing_jobs
    add column if not exists downloaded_audio_path text;

alter table processing_jobs
    add column if not exists thumbnail_path text;

alter table processing_jobs
    alter column upload_path drop not null;

alter table processing_jobs
    drop column if exists is_curated;

alter table processing_jobs
    add column if not exists stage text not null default 'queued';

alter table processing_jobs
    add column if not exists progress_current integer not null default 0;

alter table processing_jobs
    add column if not exists progress_total integer not null default 10;

alter table processing_jobs
    alter column progress_total set default 10;

alter table processing_jobs
    add column if not exists progress_percent integer not null default 0;

alter table processing_jobs
    add column if not exists last_message text;

alter table processing_jobs
    add column if not exists heartbeat_at timestamptz not null default now();

update processing_jobs
set stage = 'completed',
    progress_current = 10,
    progress_total = 10,
    progress_percent = 100,
    last_message = coalesce(last_message, 'Processing completed.'),
    heartbeat_at = coalesce(completed_at, heartbeat_at)
where status = 'succeeded'
  and (progress_percent < 100 or progress_total <> 10);

update processing_jobs
set stage = 'failed',
    progress_current = 10,
    progress_total = 10,
    progress_percent = 100,
    last_message = coalesce(last_message, 'Processing failed.'),
    heartbeat_at = coalesce(completed_at, heartbeat_at)
where status = 'failed'
  and (stage <> 'failed' or progress_total <> 10);

create table if not exists processing_chunks (
    id bigserial primary key,
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    chunk_index integer not null check (chunk_index >= 0),
    start_seconds numeric(12, 3) not null check (start_seconds >= 0),
    end_seconds numeric(12, 3) not null check (end_seconds >= start_seconds),
    audio_path text not null,
    transcript_text text,
    status text not null default 'pending'
        check (status in ('pending', 'running', 'succeeded', 'failed')),
    error_message text,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    unique (processing_run_id, chunk_index)
);

create table if not exists generated_files (
    id uuid primary key default gen_random_uuid(),
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    file_kind text not null check (
        file_kind in (
            'audio',
            'thumbnail',
            'transcript',
            'phrases',
            'pinyin',
            'chunks_manifest',
            'char_timestamps',
            'char_pinyin_timestamps',
            'phrase_timestamps',
            'phrase_timestamps_pinyin'
        )
    ),
    storage_path text not null,
    mime_type text not null default 'text/plain; charset=utf-8',
    byte_size bigint check (byte_size is null or byte_size >= 0),
    sha256 text,
    created_at timestamptz not null default now(),
    unique (processing_run_id, file_kind)
);

alter table generated_files
    drop constraint if exists generated_files_file_kind_check;

alter table generated_files
    add constraint generated_files_file_kind_check check (
        file_kind in (
            'audio',
            'thumbnail',
            'transcript',
            'phrases',
            'pinyin',
            'chunks_manifest',
            'char_timestamps',
            'char_pinyin_timestamps',
            'phrase_timestamps',
            'phrase_timestamps_pinyin'
        )
    );

create table if not exists transcript_phrases (
    id bigserial primary key,
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    phrase_index integer not null check (phrase_index >= 0),
    start_seconds numeric(12, 3) not null check (start_seconds >= 0),
    end_seconds numeric(12, 3) not null check (end_seconds >= start_seconds),
    hanzi text not null,
    pinyin text not null,
    created_at timestamptz not null default now(),
    unique (processing_run_id, phrase_index)
);

create table if not exists transcript_characters (
    id bigserial primary key,
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    phrase_id bigint references transcript_phrases(id) on delete set null,
    char_index integer not null check (char_index >= 0),
    phrase_char_index integer check (phrase_char_index is null or phrase_char_index >= 0),
    start_seconds numeric(12, 3) not null check (start_seconds >= 0),
    end_seconds numeric(12, 3) not null check (end_seconds >= start_seconds),
    hanzi text not null check (char_length(hanzi) = 1),
    pinyin text not null,
    is_estimated boolean not null default false,
    created_at timestamptz not null default now(),
    unique (processing_run_id, char_index)
);

create table if not exists transcript_words (
    id bigserial primary key,
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    phrase_id bigint references transcript_phrases(id) on delete set null,
    word_index integer not null check (word_index >= 0),
    phrase_word_index integer check (phrase_word_index is null or phrase_word_index >= 0),
    start_seconds numeric(12, 3) not null check (start_seconds >= 0),
    end_seconds numeric(12, 3) not null check (end_seconds >= start_seconds),
    hanzi text not null,
    pinyin text not null,
    char_count integer not null check (char_count > 0),
    created_at timestamptz not null default now(),
    unique (processing_run_id, word_index)
);

create index if not exists transcript_words_run_time_idx
    on transcript_words (processing_run_id, start_seconds, end_seconds);

create table if not exists transcription_error_reports (
    id uuid primary key default gen_random_uuid(),
    processing_run_id uuid not null references processing_runs(id) on delete cascade,
    transcript_character_id bigint not null references transcript_characters(id) on delete cascade,
    char_index integer not null check (char_index >= 0),
    current_hanzi text not null check (char_length(current_hanzi) = 1),
    current_pinyin text not null,
    suggested_hanzi text check (suggested_hanzi is null or char_length(suggested_hanzi) = 1),
    suggested_pinyin text,
    status text not null default 'open'
        check (status in ('open', 'reviewed', 'accepted', 'rejected')),
    created_at timestamptz not null default now(),
    unique (processing_run_id, transcript_character_id, suggested_hanzi, suggested_pinyin)
);

create index if not exists audio_assets_sha256_idx
    on audio_assets (sha256);

create index if not exists audio_assets_tags_idx
    on audio_assets using gin (tags);

create index if not exists audio_assets_is_curated_idx
    on audio_assets (is_curated);

create index if not exists audio_assets_source_url_idx
    on audio_assets (source_url);

create index if not exists processing_runs_audio_asset_id_idx
    on processing_runs (audio_asset_id);

create index if not exists processing_jobs_status_idx
    on processing_jobs (status, queued_at);

create index if not exists processing_jobs_processing_run_id_idx
    on processing_jobs (processing_run_id);

create index if not exists processing_chunks_run_idx
    on processing_chunks (processing_run_id, chunk_index);

create index if not exists generated_files_processing_run_id_idx
    on generated_files (processing_run_id);

create index if not exists transcript_phrases_run_time_idx
    on transcript_phrases (processing_run_id, start_seconds, end_seconds);

create index if not exists transcript_characters_run_time_idx
    on transcript_characters (processing_run_id, start_seconds, end_seconds);

create index if not exists transcript_phrases_hanzi_trgm_idx
    on transcript_phrases using gin (hanzi gin_trgm_ops);

create index if not exists transcript_characters_hanzi_idx
    on transcript_characters (hanzi);

create index if not exists transcription_error_reports_run_idx
    on transcription_error_reports (processing_run_id, created_at desc);

create index if not exists transcription_error_reports_status_idx
    on transcription_error_reports (status, created_at desc);
