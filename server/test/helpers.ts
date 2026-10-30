import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { PgliteDb } from '../src/db/pglite.js';
import { uuidv7 } from '../src/ids.js';

export const INVITE = 'test-invite';

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  config: Config;
  close(): Promise<void>;
}

/** Fresh in-memory PGlite + migrated schema + app. One per test file (PGlite boot is slow-ish). */
export async function createTestEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const db = await PgliteDb.create();
  await migrate(db);
  const filesDir = await mkdtemp(path.join(tmpdir(), 'elsi-files-'));
  const config: Config = {
    ...loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'test-secret-test-secret-test-secret', INVITE_CODE: INVITE }),
    filesDir,
    authRateLimitPerMinute: 0,
    ...overrides,
  };
  const app = buildApp({ db, config });
  await app.ready();
  return {
    app,
    db,
    config,
    async close() {
      await app.close();
      await db.close();
      await rm(filesDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  privateWorkspaceId: string;
  headers: { authorization: string };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

let n = 0;
export async function registerUser(
  app: FastifyInstance,
  opts: { name?: string; email?: string; password?: string; deviceName?: string; inviteCode?: string | null } = {},
): Promise<TestUser> {
  n++;
  const name = opts.name ?? `User ${n}`;
  const email = opts.email ?? `user${n}-${uuidv7().slice(-6)}@example.com`;
  const password = opts.password ?? 'correct horse battery';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email,
      name,
      password,
      deviceName: opts.deviceName ?? 'laptop',
      ...(opts.inviteCode === null ? {} : { inviteCode: opts.inviteCode ?? INVITE }),
    },
  });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  const ws = await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: bearer(body.accessToken) });
  const priv = ws.json().find((w: { kind: string }) => w.kind === 'private');
  return {
    ...body.user,
    password,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    deviceId: body.deviceId,
    privateWorkspaceId: priv.id,
    headers: bearer(body.accessToken),
  };
}

/** Logs in a user on another device; returns the new tokens. */
export async function loginDevice(app: FastifyInstance, user: TestUser, deviceName = 'phone') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: user.email, password: user.password, deviceName },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { ...body, headers: bearer(body.accessToken) } as {
    accessToken: string;
    refreshToken: string;
    deviceId: string;
    headers: { authorization: string };
  };
}

/** Builds an HLC string. */
export function hlc(wallMs: number, counter = 0, device = 'dev-a'): string {
  return `${String(wallMs).padStart(15, '0')}-${String(counter).padStart(5, '0')}-${device}`;
}

export function page(over: Partial<Record<string, unknown>> & { workspaceId: string; hlc: string }) {
  return {
    id: uuidv7(),
    parentId: null,
    title: 'Untitled',
    icon: null,
    position: 'a0',
    tags: [],
    aiVisible: true,
    deleted: false,
    ...over,
  };
}

export function block(over: Partial<Record<string, unknown>> & { pageId: string; hlc: string }) {
  return {
    id: uuidv7(),
    parentId: null,
    position: '00000001',
    type: 'paragraph',
    content: { text: 'hello' },
    deleted: false,
    conflictOf: null,
    ...over,
  };
}

export async function push(
  app: FastifyInstance,
  headers: { authorization: string },
  ops: { entity: 'page' | 'block'; data: { id: unknown; [k: string]: unknown }; baseHlc?: string | null }[],
  deviceId = 'dev-a',
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers,
    payload: { deviceId, ops: ops.map((o) => ({ entity: o.entity, id: o.data.id, baseHlc: o.baseHlc ?? null, data: o.data })) },
  });
}

export async function pullAll(app: FastifyInstance, headers: { authorization: string }, since = 0) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/sync/pull?since=${since}`, headers });
  if (res.statusCode !== 200) throw new Error(`pull failed: ${res.statusCode} ${res.body}`);
  return res.json() as {
    changes: { seq: number; entity: string; data: Record<string, any> }[];
    nextSeq: number;
    hasMore: boolean;
  };
}
