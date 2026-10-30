# ElSi server

TypeScript + Fastify API for ElSi: auth and devices, workspaces, sync of pages and blocks, files,
and a WebSocket gateway. The HTTP contract is [`docs/api.md`](../docs/api.md).

## Quick start

```bash
npm install
# zero-setup dev server on an in-memory database (PGlite, pgvector included)
DATABASE_URL=pglite://memory JWT_SECRET=dev npm run dev
curl localhost:3000/health
```

| Script | What it does |
|---|---|
| `npm run dev` | Watch mode via tsx |
| `npm test` | Vitest; every test file gets a fresh in-memory PGlite (no Docker needed) |
| `npm run typecheck` | `tsc` over `src` and `test` |
| `npm run build` | Compile to `dist/` and copy the SQL migrations |
| `npm start` | `node dist/index.js` |

Optional: `TEST_DATABASE_URL=postgres://user:pw@host:5432/postgres npm test` runs the suite against
a real Postgres with pgvector (each file creates and drops its own database).

## Configuration

All settings come from environment variables (parsed with zod in `src/config.ts`); see
[`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` makes `DATABASE_URL` and `JWT_SECRET` mandatory |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | `pglite://memory` (dev only) | `postgres://...`, `pglite://memory`, `pglite:///path/to/dir` |
| `JWT_SECRET` | random per process (dev only) | HS256 key, at least 32 chars in production |
| `INVITE_CODE` | unset | Required for every registration after the first; unset closes registration |
| `AUTH_RATE_LIMIT_PER_MIN` | `10` | Per IP on register/login/refresh; `0` disables |
| `FILES_DIR` | `./data/files` | Attachment storage |
| `PUBLIC_URL` | unset | Public base URL of the API |
| `TRUST_PROXY` | `false` | `true`, hop count, or proxy addresses; set behind Caddy |
| `ANTHROPIC_API_KEY` | unset | AI features are off without it |
| `AI_MONTHLY_TOKEN_BUDGET` | `2000000` | Per user per month |
| `EMBEDDINGS_PROVIDER` | `none` | `ollama`, `voyage` or `none` |
| `EMBEDDINGS_MODEL`, `OLLAMA_URL`, `VOYAGE_API_KEY` | unset | Embeddings backend |
| `WHISPER_URL`, `WHISPER_MODEL` | unset | Voice transcription service |

The Docker image runs as the unprivileged `node` user with `FILES_DIR=/app/data/files`; mount a
volume at `/app/data` (a named volume inherits the right ownership).

## Layout

```
src/
  index.ts            entry: config -> db -> migrate -> buildApp -> listen
  app.ts              buildApp({db, config}): app.ctx, app.authenticate, error shape, plugins
  modules.ts          list of feature modules (one line per module)
  config.ts           env parsing
  context.ts          AppContext / req.user typings
  errors.ts           HttpError helpers (badRequest, forbidden, ...) and zod `parse`
  ids.ts              uuidv7(), uuidFromKey()
  db/                 Db interface, pg + PGlite implementations, migrate(), migrations/*.sql
  auth/               register/login/refresh/logout/devices/me/users, tokens, Argon2id
  policy/policy.ts    every authorization rule + SQL fragments
  audit/audit.ts      audit(db, {...})
  workspaces/         workspace routes and loaders
  sync/               push/pull, HLC helpers, change log
  files/              content-addressed uploads
  ws/                 WebSocket gateway and the events bus (ctx.events)
```

## Writing a module

1. Write a Fastify plugin `async function chatRoutes(app: FastifyInstance)` and append
   `{ name: 'chat', plugin: chatRoutes }` to `src/modules.ts`. It is mounted under `/api/v1`.
2. Use `app.ctx` = `{ db, config, events }`. Protect routes with
   `app.addHook('onRequest', app.authenticate)`; then `req.user = { id, sessionId }`.
3. Ask `src/policy/policy.ts` for every access decision (`assertConversationAccess`,
   `canAccessPage`, `visibleConversationIds`, `sqlChunkVisible('$1', 'c')`, ...). Add new rules
   there rather than in route files.
4. Throw `badRequest()/forbidden()/notFound()/...` from `src/errors.js`; validate input with
   `parse(zodSchema, req.body)`.
5. Database: `db.query<T>(sql, params)` returns `{rows}`; wrap multi-statement writes in
   `db.tx(async (t) => ...)` and use only `t` inside. Pass jsonb as `JSON.stringify(value)`.
6. Audit sensitive actions: `audit(t, { actorId, action: 'chat.message_delete', resourceType,
   resourceId, via: 'human' | 'ai', detail })`.
7. Real-time: `ctx.events.publish(userIds, { type: 'message.new', message }, { exceptSessionId })`,
   `ctx.events.isOnline(userId)`, and `ctx.events.onClientMessage('typing', (conn, msg) => ...)`
   where `conn = { userId, sessionId, send(event), close() }`.
8. Migrations: add `src/db/migrations/NNN_name.sql` in your range (core 001-099, chat 100-199,
   AI 200-299). They run in order at startup, each in a transaction, tracked in
   `schema_migrations`. Table definitions for every module already exist in `001_core.sql`;
   later migrations should only add columns and indexes.
