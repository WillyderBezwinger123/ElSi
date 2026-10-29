# ElSi

An open-source, self-hosted alternative to Notion: block-based notes, an AI assistant that works with your notes and chats, and a private built-in messenger. Runs on **Windows** and **Android**, backed by a server you host yourself.

> Status: early development (M0, scaffolding). Not usable yet.

## Features (planned)
- Block-based notes with offline-first editing and sync
- AI assistant: ask questions about your notes, writing help, auto-organize, voice notes
- Private 1:1 and group chat with attachments and note sharing
- Self-hosted: your data stays on your server; only LLM calls leave it

## Repository layout
| Path | Purpose |
|---|---|
| `client/` | Flutter app (Windows + Android) |
| `server/` | API, sync, chat and AI services (TypeScript / Fastify) |
| `deploy/` | Docker Compose, Caddy, example env |
| `docs/` | Architecture and design notes |

## Getting started
Setup instructions will be added as the milestones land. See `docs/architecture.md` for the plan.

## Security
Never commit secrets. Configuration lives in `.env` files (see `deploy/.env.example`), which are git-ignored.

## License
MIT, see [LICENSE](LICENSE).
