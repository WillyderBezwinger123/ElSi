# ElSi API contract (v1)

This is the shared contract between `client/` and `server/`. Change it here first, then in code.

- Base path: `/api/v1`. JSON everywhere unless noted. Ids are UUIDv7 strings.
- Auth: `Authorization: Bearer <accessToken>` on every route except `/auth/register`, `/auth/login`, `/auth/refresh` and `/health`.
- Errors: HTTP status plus `{ "error": "<code>", "message": "<human text>" }`. Codes used: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `too_large`, `rate_limited`, `ai_not_configured`, `budget_exceeded` (plus `unsupported_media_type` and `internal` for 415/500).
- Rate limit: `/auth/register`, `/auth/login` and `/auth/refresh` allow 10 requests per minute per IP (`429 rate_limited`).
- Timestamps: ISO 8601 strings in UTC. Clock values (`hlc`) are strings `<wallMs 15 digits>-<counter 5 digits>-<deviceId>`, compared as plain strings.

## Health
`GET /health` (no `/api/v1` prefix) returns `{ "status": "ok" }`.

## Auth and devices
| Method and path | Body | Response |
|---|---|---|
| `POST /auth/register` | `{email, name, password, deviceName, inviteCode?}` | `AuthResult` |
| `POST /auth/login` | `{email, password, deviceName}` | `AuthResult` |
| `POST /auth/refresh` | `{refreshToken}` | `{accessToken, refreshToken}` |
| `POST /auth/logout` | none | `204` (revokes the current device session) |
| `GET /auth/devices` | none | `[{id, deviceName, lastSeenAt, createdAt, current}]` |
| `DELETE /auth/devices/:id` | none | `204` |
| `GET /me` | none | `User` |
| `GET /users` | none | `[User]` (everyone on this server, for starting chats and sharing) |

- `AuthResult = {user: User, accessToken, refreshToken, deviceId}`. `User = {id, email, name}`. `deviceId` is the device session id (the `id` in `/auth/devices`).
- Registration: the first user may always register. Later users need `inviteCode` equal to the server's `INVITE_CODE` env var (if that is unset, registration is closed after the first user).
- Passwords: Argon2id. Minimum 8 characters.
- Access token: JWT (HS256, `JWT_SECRET`), 15 minutes, claims `sub` (user id), `sid` (device session id).
- Refresh token: opaque random string, stored hashed, rotated on every refresh. Reusing an old refresh token revokes that device session.
- A revoked session's access tokens are rejected (the server checks `sid` against the session table).

## Workspaces
Every user gets a private workspace on registration. Shared workspaces hold pages several users can see.

| Method and path | Body | Response |
|---|---|---|
| `GET /workspaces` | none | `[Workspace]` |
| `POST /workspaces` | `{name, memberIds: [userId]}` | `Workspace` (kind `shared`, creator is `owner`) |
| `PATCH /workspaces/:id` | `{name?, addMemberIds?, removeMemberIds?}` | `Workspace` (owner only) |

`Workspace = {id, name, kind: "private"|"shared", members: [{userId, role: "owner"|"member"}]}`.

## Sync (pages and blocks)
Server rows mirror the client tables.
- `Page = {id, workspaceId, parentId, title, icon, position, tags: [string], aiVisible, hlc, deleted}`
- `Block = {id, pageId, parentId, position, type, content (JSON object), hlc, deleted, conflictOf}`

`POST /sync/push`
```json
{ "deviceId": "...", "ops": [
  { "entity": "page", "id": "...", "baseHlc": "...", "data": { /* full Page */ } },
  { "entity": "block", "id": "...", "baseHlc": "...", "data": { /* full Block */ } }
] }
```
Response: `{ "results": [{ "id", "status": "applied"|"stale"|"conflict", "conflictCopyId"? }], "serverSeq": 123 }`

Rules:
- Each op carries the full row. `baseHlc` is the `hlc` the client last saw from the server for that row (null for new rows).
- The server first clamps `hlc` wall time to at most now + 60 s.
- If the row doesn't exist, insert it (`applied`).
- If `data.hlc` > stored `hlc`, overwrite (`applied`). If the stored `hlc` != `baseHlc` and the content differs, this was a concurrent edit; it still wins, but the server keeps the previous version as a conflict copy only when it is a block (see next rule, mirrored).
- If `data.hlc` <= stored `hlc`: if `baseHlc` != stored `hlc` and the block `content` differs, store the incoming block as a new sibling block with a fresh id and `conflictOf` = original id (`conflict`, return `conflictCopyId`); otherwise `stale`.
- Pushing the same op twice is harmless (same hlc, so the second time is `stale`).
- Every applied write appends to the change log and bumps the global sequence. Tombstones (`deleted: true`) are kept for at least 30 days.
- Policy: the user must be a member of the page's workspace. Moving a page to another workspace requires membership in both.
- After applying, the server sends `sync.hint` over the WebSocket to every member's other devices.

Server details (clarifications of the rules above):
- A push is atomic. If any op breaks policy, the whole push fails with `403 forbidden` and nothing is applied. A block's page must already exist on the server or come earlier in the same push.
- When an incoming block wins a concurrent edit, its result is `applied` with `conflictCopyId` (the copy holding the overwritten version).
- No conflict copy is made when the stored and incoming `hlc` share the same `deviceId` (a device cannot conflict with itself), when either side is a deletion, or when the content is equal (key order ignored).
- Conflict copy ids are derived from the op, so retrying an op returns the same `conflictCopyId` and never makes a second copy. Copies keep the original's `pageId`, `parentId` and `position`.

`GET /sync/pull?since=<seq>&limit=<n, default 500, max 1000>`
Response: `{ "changes": [{ "seq", "entity": "page"|"block"|"workspace", "data": {...} }], "nextSeq", "hasMore" }`. Only rows in workspaces the user belongs to. For `workspace`, `data` is a `Workspace`.
- `data` is always the row's current state. Each row appears at most once per response. Within a response, workspaces come first, then pages, then blocks. Across responses, a block can still arrive before its page, so clients must tolerate that.
- Store `nextSeq` as the next `since`, even when `changes` is empty: it can jump past changes the user cannot see.
- A row that left the user's workspaces (its page moved to a workspace they are not in) arrives as a tombstone with `deleted: true`. A page tombstone has `workspaceId` set to the old workspace and an empty title. A block tombstone has `content: {}`.
- A workspace the user was removed from arrives as `{id, name, kind, members: [], deleted: true}`. Drop it locally, with its pages and blocks.
- When a user is added to a workspace, all its pages and blocks are sent again, so the new member gets them with their existing cursor.

## Files
- `PUT /files/:sha256` with the raw bytes as body and the real `Content-Type`. The server verifies the hash. Max 25 MB (`too_large`). Response `FileInfo = {id, sha256, size, mime}`. Uploading an existing hash is a no-op that returns the same info.
- `GET /files/:sha256` returns the bytes. Only the uploader, or members of a conversation or workspace that references the file, may read it. A workspace references a file when one of its blocks has the sha256 anywhere in `content`. A conversation references it when a message has it as an attachment. Files that are missing and files the user may not read both return `404 not_found`.

## Chat
- `Conversation = {id, kind: "dm"|"group", title, aiVisible, members: [{userId, lastReadSeq}], lastMessage?: Message, unreadCount}`
- `Message = {id, conversationId, seq, senderId, kind: "text"|"note_ref"|"ai", body, replyTo, attachments: [FileInfo], noteRef?: {pageId, title}, reactions: [{emoji, userIds}], createdAt, editedAt, deletedAt}`

| Method and path | Body | Response |
|---|---|---|
| `GET /conversations` | none | `[Conversation]` (most recent first) |
| `POST /conversations` | `{kind, title?, memberIds}` | `Conversation` (a DM between the same two users is reused) |
| `PATCH /conversations/:id` | `{title?, aiVisible?, addMemberIds?, removeMemberIds?}` | `Conversation` |
| `GET /conversations/:id/messages?before=<seq>&limit=<n, default 50>` | none | `[Message]` (ascending by seq) |
| `POST /conversations/:id/messages` | `{id, kind, body, replyTo?, attachmentIds?, noteRef?: {pageId}}` | `Message` (idempotent on client `id`) |
| `PATCH /messages/:id` | `{body}` | `Message` (sender only) |
| `DELETE /messages/:id` | none | `204` (sender only; soft delete, body cleared) |
| `POST /conversations/:id/read` | `{seq}` | `204` |
| `POST /messages/:id/reactions` | `{emoji}` | `Message` |
| `DELETE /messages/:id/reactions/:emoji` | none | `Message` |

- `seq` is per conversation, starting at 1, with no gaps.
- `note_ref` messages check on read that the recipient may see the page; otherwise `noteRef.title` is `null`.

## WebSocket
`GET /api/v1/ws?token=<accessToken>`. Frames are JSON objects with a `type`.

Client to server:
- `{type: "resume", conversations: {"<conversationId>": <lastSeq>}}`: the server replays missed messages as `message.new`, in order.
- `{type: "typing", conversationId}`
- `{type: "ping"}`: the server answers `{type: "pong"}`. Clients ping every 25 s.

Server to client:
- `message.new {message}`, `message.updated {message}`, `message.deleted {message}`
- `conversation.updated {conversation}`
- `read {conversationId, userId, seq}`
- `typing {conversationId, userId}`
- `sync.hint {seq}`
- `proposal.new {proposal}`, `job.updated {job}`
- `error {error, message}` for a frame that is not JSON, has no `type`, or has an unknown `type`.

Connection rules:
- The server accepts the upgrade and then closes the socket with code `4401` if the token is missing, invalid or expired, or if its device session is revoked. Revoking a device also closes its open sockets with `4401`. Reconnect with a fresh access token.
- Frames are limited to 64 KB. A socket that sends no frame for 75 s is dropped.

## Push (Android, UnifiedPush)
- `POST /push/register {endpoint}` stores the UnifiedPush endpoint for the current device session. `DELETE /push/register` removes it.
- When a message arrives for a member with no open WebSocket, the server POSTs a small JSON ping `{type: "message", conversationId}` to their endpoint (no message content).

## AI
All AI routes return `503 ai_not_configured` when `ANTHROPIC_API_KEY` is unset, and `429 budget_exceeded` when the user's monthly token budget (`AI_MONTHLY_TOKEN_BUDGET`, default 2,000,000) is used up.

Streaming routes use Server-Sent Events (`Content-Type: text/event-stream`). Each event is `event: <name>` plus `data: <json>`.

`POST /ai/chat` with `{threadId?, message, scope?: {pageId?, conversationId?}, mode?: "fast"|"default"|"deep"}`. Events:
- `thread {threadId}` (first event)
- `delta {text}`
- `tool {name, status: "started"|"finished"}`
- `citation {sourceType: "page"|"conversation", sourceId, blockId?, messageSeq?, title, snippet}`
- `proposal {proposal}`
- `done {usage: {inputTokens, outputTokens}}`
- `error {error, message}`

Modes map to models: `fast` = `claude-haiku-5-5`, `default` = `claude-sonnet-5-5`, `deep` = `claude-opus-5-5`.

| Method and path | Body | Response |
|---|---|---|
| `GET /ai/threads` | none | `[{id, title, updatedAt}]` |
| `GET /ai/threads/:id` | none | `{id, title, messages: [{role, text, citations}]}` |
| `POST /ai/write` | `{action: "improve"|"continue"|"summarize"|"translate"|"fix_grammar", text, context?, language?}` | SSE: `delta`, `done`, `error` |
| `POST /ai/organize` | `{pageId}` | `{proposals: [Proposal]}` (tags, title, links to related pages) |
| `GET /proposals?status=pending` | none | `[Proposal]` |
| `POST /proposals/:id/approve` | none | `{proposal, result}` |
| `POST /proposals/:id/reject` | none | `{proposal}` |
| `POST /ai/transcribe` | multipart: `audio` file, `title?`, `workspaceId?` | `{job: Job}` |
| `GET /ai/jobs/:id` | none | `Job` |
| `GET /ai/usage` | none | `{monthInputTokens, monthOutputTokens, budget}` |

- `Proposal = {id, kind: "create_note"|"update_note"|"send_message"|"set_tags"|"set_title"|"add_links", status: "pending"|"approved"|"rejected", summary, args, createdAt}`
- `Job = {id, kind: "transcribe", status: "queued"|"running"|"done"|"failed", pageId?, error?}`. A finished transcription creates a page (in `workspaceId` or the private workspace) with a summary, action items and the full transcript.

AI rules:
- Retrieval only returns chunks the asking user may see, and only from pages and conversations with `aiVisible = true`. The filter runs inside the same SQL query.
- Tools get the user from the session, never from model arguments. Write tools only create proposals.
- Every retrieval and tool call is written to the audit log with `via = "ai"`.
- Retrieved text is passed to the model as quoted, untrusted data.
