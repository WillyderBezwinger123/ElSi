-- 001_core: full schema for every module (core, chat, AI).
-- Later migrations (chat 100-199, AI 200-299) should only add columns and indexes.
-- Ids are UUIDv7 strings stored as text (validated at the API boundary).

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- users and devices

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_sessions (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name       text NOT NULL,
  refresh_hash      text NOT NULL UNIQUE,   -- sha256 hex of the current refresh token
  prev_refresh_hash text,                   -- previous token; presenting it again = reuse
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE INDEX device_sessions_user_idx ON device_sessions (user_id);
CREATE INDEX device_sessions_prev_refresh_idx ON device_sessions (prev_refresh_hash);

-- ---------------------------------------------------------------- workspaces, pages, blocks

CREATE TABLE workspaces (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('private', 'shared')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE pages (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id),
  parent_id       text,                       -- no FK: sync may deliver children first
  title           text NOT NULL DEFAULT '',
  icon            text,
  position        text NOT NULL DEFAULT '',   -- fractional index among siblings
  tags            text[] NOT NULL DEFAULT '{}',
  ai_visible      boolean NOT NULL DEFAULT true,
  encryption_mode text NOT NULL DEFAULT 'none',
  hlc             text NOT NULL,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pages_workspace_idx ON pages (workspace_id);

CREATE TABLE blocks (
  id          text PRIMARY KEY,
  page_id     text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_id   text,
  position    text NOT NULL DEFAULT '',
  type        text NOT NULL,
  content     jsonb NOT NULL DEFAULT '{}',
  hlc         text NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  conflict_of text,                           -- id of the block this is a conflict copy of
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blocks_page_idx ON blocks (page_id);

-- Global change sequence for /sync/pull. Pull returns the CURRENT row for each entry, so
-- superseded entries are redundant and may be pruned once older than the tombstone window.
-- Writers must use appendChange() inside a transaction (it takes an advisory lock so that
-- seq order = commit order). user_id set = a notice addressed to one user only
-- (e.g. "you were removed from this workspace").
CREATE TABLE change_log (
  seq          bigserial PRIMARY KEY,
  entity       text NOT NULL,                 -- page | block | workspace
  entity_id    text NOT NULL,
  workspace_id text,
  user_id      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_entity_idx ON change_log (entity, entity_id);
CREATE INDEX change_log_workspace_idx ON change_log (workspace_id, seq);
CREATE INDEX change_log_user_idx ON change_log (user_id, seq) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------- files

CREATE TABLE files (
  id          text PRIMARY KEY,
  sha256      text NOT NULL UNIQUE,
  size        bigint NOT NULL,
  mime        text NOT NULL,
  uploader_id text REFERENCES users(id) ON DELETE SET NULL,
  path        text NOT NULL,                 -- relative to FILES_DIR
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_uploader_idx ON files (uploader_id);

-- ---------------------------------------------------------------- chat

CREATE TABLE conversations (
  id              text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('dm', 'group')),
  title           text,
  ai_visible      boolean NOT NULL DEFAULT true,
  encryption_mode text NOT NULL DEFAULT 'none',
  dm_key          text UNIQUE,               -- sorted member ids for DMs, so a DM is reused
  created_by      text REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seq        integer NOT NULL DEFAULT 0
);

CREATE TABLE conversation_members (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq   integer NOT NULL DEFAULT 0,
  role            text NOT NULL DEFAULT 'member',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

CREATE TABLE messages (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  sender_id        text REFERENCES users(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'text',   -- text | note_ref | ai
  body             text NOT NULL DEFAULT '',
  reply_to         text,
  note_ref_page_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE message_attachments (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id    text NOT NULL REFERENCES files(id),
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_attachments_file_idx ON message_attachments (file_id);

CREATE TABLE reactions (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE push_endpoints (
  device_session_id text PRIMARY KEY REFERENCES device_sessions(id) ON DELETE CASCADE,
  endpoint          text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- AI

CREATE TABLE chunks (
  id               text PRIMARY KEY,
  source_type      text NOT NULL CHECK (source_type IN ('page', 'conversation')),
  source_id        text NOT NULL,             -- page id or conversation id
  workspace_id     text,                      -- set for page chunks
  conversation_id  text,                      -- set for conversation chunks
  block_id         text,
  message_seq_from integer,
  message_seq_to   integer,
  title            text NOT NULL DEFAULT '',
  text             text NOT NULL,
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  embedding        vector(1024),
  embedding_model  text,
  dim              integer,
  source_hash      text,
  ai_visible       boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_source_idx ON chunks (source_type, source_id);
CREATE INDEX chunks_workspace_idx ON chunks (workspace_id);
CREATE INDEX chunks_conversation_idx ON chunks (conversation_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
-- HNSW works on both Postgres+pgvector and PGlite's pgvector build.
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE ai_threads (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_threads_user_idx ON ai_threads (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id         text PRIMARY KEY,
  thread_id  text NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  role       text NOT NULL,                  -- user | assistant
  text       text NOT NULL DEFAULT '',
  citations  jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_thread_idx ON ai_messages (thread_id, created_at);

CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_idx ON ai_usage (user_id, created_at);

CREATE TABLE proposals (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,                  -- create_note | update_note | send_message | set_tags | set_title | add_links
  status     text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  summary    text NOT NULL DEFAULT '',
  args       jsonb NOT NULL DEFAULT '{}',
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX proposals_user_idx ON proposals (user_id, status);

CREATE TABLE jobs (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,                  -- transcribe | ...
  status     text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  input      jsonb NOT NULL DEFAULT '{}',
  page_id    text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_user_idx ON jobs (user_id, created_at DESC);
CREATE INDEX jobs_status_idx ON jobs (status, created_at);

-- ---------------------------------------------------------------- audit

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  actor_id      text,                        -- no FK: audit rows outlive users
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  via           text NOT NULL DEFAULT 'human' CHECK (via IN ('human', 'ai')),
  detail        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, ts);
