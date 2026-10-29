# ElSi: Notion alternative (notes + AI + private messenger)

## Context
Two friends want a Notion alternative for **Windows + Android** with block-based notes, an AI assistant, and a private in-app messenger. It runs against a **self-hosted local server** that already exists but is not set up yet. The user will tell us when it is ready, and the Claude API key comes later.
The app lives in its own open-source repo, `ElSi`, with `client/` (Flutter) and `server/`.

Decisions confirmed by the user:
- Flutter client, offline-first with sync to the server.
- AI features: chat with your notes (RAG), inline writing help, auto-organize (tags, titles, links), and voice/meeting notes.
- Messenger: 1:1 and group text chat, attachments, sharing notes into chats.
- **The AI may read chats and notes with privileges**, so chat is not E2EE at first (TLS + encryption at rest).
- Security hardening comes **after** everything works, but the design must not block it.
- Server connection is **deferred**: the app takes a configurable server URL.

Defaults I chose (change on request): server in TypeScript/Fastify, push via UnifiedPush + ntfy, embeddings behind a swappable interface (local Ollama preferred), Tailscale for remote access, voice via local faster-whisper.

## Architecture
```
Flutter (Windows/Android)                     Home server (Docker Compose)
 riverpod + go_router                          Caddy (TLS)
 appflowy_editor <-> own block JSON              -> api (Fastify): auth, policy layer, sync,
 drift/SQLite + FTS5 + outbox                       chat (WebSocket), AI orchestrator, jobs
 sync engine (HTTP push/pull + WS hint)          postgres 17 + pgvector
 WS client (chat, ai.delta)                      ntfy, whisper (faster-whisper), ollama (opt.)
 UnifiedPush receiver                            outbound only: Claude API (+ embeddings)
```
Repo layout (repo name `ElSi`):
- `client/lib/{core,data/db,sync,features/{notes,chat,ai},ui_tokens}`
- `server/src/{auth,policy,sync,chat,ai,jobs,db/migrations}`
- `api/openapi.json` (generated, used for the Dart client)
- `deploy/{compose.yml,Caddyfile,.env.example}`
- `.gitignore` must exclude `*credentials*`.

Design tokens (ported from the authors' website):
- Colors: light bg `#f4f3ef` / fg `#111`; dark bg `#0d0e10` / fg `#f4f3ef`; stone `#e7e5dc`; accent emerald `#10b981`.
- Easing `cubic-bezier(0.16,1,0.3,1)`.
- Fonts: Plus Jakarta Sans, Inter, JetBrains Mono.
- Port these into a Flutter `ThemeData` (light and dark).
- Name is settled: **ElSi**.

## Key data model (all ids UUIDv7)
`user`, `device_session` (refresh hash, revoke), `page` (with `ai_visible`, `encryption_mode`), `block` (fractional-index `pos`, `parent_id`, `type`, `content jsonb`, `hlc`, `deleted`), `change_log`, `conversation`, `member` (`last_read_seq`), `message` (per-conversation `seq`, `kind` text|note_ref|ai), `attachment`, `reaction`, `chunk` (ACL scope, `embedding vector`, `embedding_model`, `dim`, `ai_visible`), `ai_usage`, `proposal`, `audit_log`.

**One policy layer:** `policy.can(user, action, resource)` plus a SQL helper for visible chunks. Every REST route, WebSocket handler and AI tool goes through it.

## Sync design
- Last-write-wins per block using a hybrid logical clock (HLC).
- Push: `POST /sync/push` (idempotent ops). Pull: `GET /sync/pull?since=seq`.
- On a concurrent edit to the same block the server keeps the winner and stores the loser as a conflict copy.
- Tombstones are kept for 30 days or more.
- Triggers: WS `sync.hint`, app start/resume, and a 60 s timer.
- Attachments are content-addressed (sha256) and downloaded lazily.
- Chat: per-conversation `seq`, WS resume from `last_seq`, client-generated ids for idempotent retries, offline send queue.
- No CRDT now, because the Dart Yjs/Loro libraries are immature. The block-level design lets one be swapped in later.

## AI design
- Models: `claude-haiku-5-5` for routing/titles/summaries, `claude-sonnet-5-5` as the default assistant, `claude-opus-5-5` for heavy tasks. Use prompt caching, the Batch API for indexing, and per-user token budgets.
- Retrieval: hybrid pgvector + Postgres FTS merged with reciprocal rank fusion. The ACL and `ai_visible` filters run in the same SQL query.
- Chunking: notes by block/heading at 300-500 tokens with a title prefix. Chat in sliding windows of 10-20 messages.
- Tools: `search_notes`, `search_chats`, `read_note`, `summarize_conversation`, `create_note`, `update_note`, `send_message`.
  - Tools take the user from the session, never from model arguments.
  - Write actions return a **proposal** that the user must confirm.
  - Retrieved text is treated as untrusted.
- Streaming: Claude SSE on the server, relayed over the WebSocket as `ai.delta`.
- Voice: local faster-whisper in a container behind an HTTP interface. Anthropic has no speech-to-text, and local keeps audio on the server.
- Embeddings: swappable interface (local Ollama preferred, Voyage as the cloud option). Model and dimension are stored per row for re-embedding.

## Milestones (about 20 weeks, 2 people part-time)
Person A leads Flutter/UX. Person B leads server/infra. They review each other's work.

| # | Scope | Acceptance |
|---|---|---|
| M0 Scaffolding (1 wk) | Repo, Flutter theme from website tokens, Fastify skeleton, Compose with postgres/caddy, OpenAPI-to-Dart codegen, CI building APK + Windows | `docker compose up` serves `/health` over TLS; CI green; themed shell runs on both targets |
| M1 Offline notes (3 wk) | drift schema, page tree, appflowy_editor on own block JSON, custom blocks (code, table, callout, embed), markdown import/export, FTS5 search. Week 1: spike tables + markdown export | Offline create/nest/reorder/search 1,000 pages; lossless block JSON round-trip (golden tests); survives a kill mid-edit |
| M2 Auth + sync (3 wk) | Argon2id, 15-min JWT + rotating refresh, device sessions, push/pull, policy layer v1, sync engine, outbox, conflict UI, Android network config | Two devices converge after offline edits (property test); revoked device stops syncing within the JWT lifetime (about 15 min) |
| M3 Messenger (3 wk) | WS gateway, DMs/groups, seq + resume, attachments, reactions, note-ref cards, ntfy/UnifiedPush ping, offline send queue | In-order delivery after a 5-minute disconnect; no duplicates after 100 forced retries; Android push within 10 s with app killed |
| M4 AI + RAG (4 wk) | Chunker, embedding job, hybrid search, tool loop, proposals, budgets, audit of retrievals, assistant panel, citations, inline writing actions | Cross-user leak tests pass at SQL and API level; injection fixtures only create proposals; budget cap enforced; recall@5 of 80% or better on 30 hand-made questions |
| M5 Voice + auto-organize (3 wk) | Whisper job, recorder, transcript to note with summary and action items, tag/title/link suggestions | 10-minute recording becomes a note in about 5 minutes; no suggestion applied without confirmation |
| M6 Hardening + packaging (3 wk) | Rate limits, upload limits, Tailscale doc, pg_dump + restic backups, disk encryption, per-conversation AI toggle, Inno Setup installer, signed APK | Restore drill on a clean machine; installers run on fresh VMs |

**Server connection step:** from M2 on, the app reads the server URL from settings. When the real server is ready, the user tells us and we deploy `deploy/compose.yml` there and point the app at it. The Claude API key goes into the server `.env` then.

## Risks
1. appflowy_editor tables/markdown export may be weak. Spike in M1 week 1; the fallback is custom block widgets.
2. Sync correctness: property-test early and keep the protocol simple.
3. Android TLS/cleartext handling (network_security_config, private CA, INTERNET permission in release manifest). Tailscale or Caddy certs avoid most of it.
4. UnifiedPush needs the ntfy app on each phone. FCM is the pragmatic fallback.
5. Prompt injection and AI cost: the proposal flow and budgets mitigate these; test them.
6. Scope creep (four AI features plus messenger): hold M4 and M5 scope tight.

## Verification (end to end)
- Server: `docker compose up`, then hit `/health` over TLS, run the server test suite, and run the leak and injection tests.
- Client: `flutter test` (golden tests for block JSON), then `flutter run -d windows` and an Android device/emulator.
- Manual: two-device offline edit and merge, chat disconnect/reconnect, push with the app killed, AI answer with citations, voice note to note.
- Final check against the acceptance column of each milestone.

## Still open (can be answered later)
- Server hardware (CPU/GPU/RAM) and network, which decides local Ollama/whisper sizing.
- Who is stronger in Flutter vs server, for the A/B split.
- Weekly hours and target date.
