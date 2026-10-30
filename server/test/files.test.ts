import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { block, createTestEnv, hlc, page, push, registerUser, type TestEnv, type TestUser } from './helpers.js';

let env: TestEnv;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  env = await createTestEnv();
  alice = await registerUser(env.app, { name: 'Alice' });
  bob = await registerUser(env.app, { name: 'Bob' });
});
afterAll(async () => env.close());

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function upload(user: TestUser, body: Buffer, contentType = 'image/png', hash = sha(body)) {
  return env.app.inject({
    method: 'PUT',
    url: `/api/v1/files/${hash}`,
    headers: { ...user.headers, 'content-type': contentType },
    payload: body,
  });
}
const download = (user: TestUser, hash: string) =>
  env.app.inject({ method: 'GET', url: `/api/v1/files/${hash}`, headers: user.headers });

describe('files', () => {
  it('stores content-addressed files and serves them back', async () => {
    const body = randomBytes(1000);
    const res = await upload(alice, body);
    expect(res.statusCode).toBe(200);
    const info = res.json();
    expect(info).toEqual({ id: expect.any(String), sha256: sha(body), size: 1000, mime: 'image/png' });
    const h = sha(body);
    expect(existsSync(path.join(env.config.filesDir, h.slice(0, 2), h))).toBe(true);

    const got = await download(alice, h);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.equals(body)).toBe(true);

    const audit = await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'file.upload' AND resource_id = $1`, [info.id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('keeps JSON and text bodies byte-exact', async () => {
    const body = Buffer.from('{ "b": 1,   "a": [2] }\n');
    const res = await upload(alice, body, 'application/json; charset=utf-8');
    expect(res.statusCode).toBe(200);
    expect(res.json().mime).toBe('application/json');
    const got = await download(alice, sha(body));
    expect(got.rawPayload.equals(body)).toBe(true);
  });

  it('rejects a body that does not match the hash, and bad hashes', async () => {
    const body = randomBytes(64);
    const wrong = await upload(alice, body, 'application/octet-stream', sha(Buffer.from('other')));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe('bad_request');
    const malformed = await upload(alice, body, 'application/octet-stream', 'not-a-hash');
    expect(malformed.statusCode).toBe(400);
  });

  it('enforces the upload limit (25 MB by default)', async () => {
    expect(env.config.maxUploadBytes).toBe(25 * 1024 * 1024);
    const big = Buffer.alloc(env.config.maxUploadBytes + 1, 1);
    const res = await upload(alice, big, 'application/octet-stream');
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_large');
  });

  it('dedupes uploads of the same content', async () => {
    const body = randomBytes(256);
    const first = (await upload(alice, body)).json();
    const second = await upload(bob, body, 'image/jpeg');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first);
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM files WHERE sha256 = $1', [sha(body)]);
    expect(rows[0]!.n).toBe(1);
  });

  it('requires auth', async () => {
    const body = randomBytes(10);
    const res = await env.app.inject({ method: 'PUT', url: `/api/v1/files/${sha(body)}`, payload: body, headers: { 'content-type': 'image/png' } });
    expect(res.statusCode).toBe(401);
  });

  it('only lets the uploader and members of referencing workspaces or conversations read', async () => {
    const body = randomBytes(300);
    const h = sha(body);
    const info = (await upload(alice, body)).json();
    expect((await download(bob, h)).statusCode).toBe(404);
    expect((await download(bob, 'a'.repeat(64))).statusCode).toBe(404);

    // Referenced from a block in Alice's private workspace: still hidden from Bob.
    const t = Date.now() - 1000;
    const priv = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t) });
    await push(env.app, alice.headers, [
      { entity: 'page', data: priv },
      { entity: 'block', data: block({ pageId: priv.id, hlc: hlc(t), type: 'image', content: { sha256: h } }) },
    ]);
    expect((await download(bob, h)).statusCode).toBe(404);

    // Referenced from a block in a workspace Bob belongs to: readable.
    const ws = (
      await env.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: alice.headers, payload: { name: 'Team', memberIds: [bob.id] } })
    ).json();
    const shared = page({ workspaceId: ws.id, hlc: hlc(t) });
    await push(env.app, alice.headers, [
      { entity: 'page', data: shared },
      { entity: 'block', data: block({ pageId: shared.id, hlc: hlc(t), type: 'image', content: { file: { sha256: h } } }) },
    ]);
    expect((await download(bob, h)).statusCode).toBe(200);

    // Attached to a message in a conversation.
    const carol = await registerUser(env.app, { name: 'Carol' });
    const other = randomBytes(50);
    const otherInfo = (await upload(alice, other)).json();
    expect((await download(carol, sha(other))).statusCode).toBe(404);
    const conv = uuidv7();
    const msg = uuidv7();
    await env.db.query(`INSERT INTO conversations (id, kind, created_by) VALUES ($1, 'dm', $2)`, [conv, alice.id]);
    await env.db.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [conv, alice.id, carol.id]);
    await env.db.query(`INSERT INTO messages (id, conversation_id, seq, sender_id, body) VALUES ($1, $2, 1, $3, 'pic')`, [msg, conv, alice.id]);
    await env.db.query(`INSERT INTO message_attachments (message_id, file_id) VALUES ($1, $2)`, [msg, otherInfo.id]);
    expect((await download(carol, sha(other))).statusCode).toBe(200);
    expect((await download(bob, sha(other))).statusCode).toBe(404);
    expect(info.id).not.toBe(otherInfo.id);
  });
});
