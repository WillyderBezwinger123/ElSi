import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import {
  canAccessConversation,
  canAccessPage,
  canAccessWorkspace,
  sqlChunkVisible,
  visibleConversationIds,
  visibleWorkspaceIds,
} from '../src/policy/policy.js';
import { createTestEnv, hlc, page, push, registerUser, type TestEnv, type TestUser } from './helpers.js';

let env: TestEnv;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

beforeAll(async () => {
  env = await createTestEnv();
  alice = await registerUser(env.app, { name: 'Alice' });
  bob = await registerUser(env.app, { name: 'Bob' });
  carol = await registerUser(env.app, { name: 'Carol' });
});
afterAll(async () => env.close());

const api = (path: string) => `/api/v1${path}`;

async function createShared(owner: TestUser, memberIds: string[], name = 'Team') {
  const res = await env.app.inject({ method: 'POST', url: api('/workspaces'), headers: owner.headers, payload: { name, memberIds } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('workspaces', () => {
  it('creates a shared workspace that all members see', async () => {
    const ws = await createShared(alice, [bob.id, bob.id, alice.id]);
    expect(ws).toMatchObject({ name: 'Team', kind: 'shared' });
    expect(ws.members).toEqual(
      expect.arrayContaining([
        { userId: alice.id, role: 'owner' },
        { userId: bob.id, role: 'member' },
      ]),
    );
    expect(ws.members).toHaveLength(2);

    const bobList = (await env.app.inject({ method: 'GET', url: api('/workspaces'), headers: bob.headers })).json();
    expect(bobList.map((w: { id: string }) => w.id)).toContain(ws.id);
    const carolList = (await env.app.inject({ method: 'GET', url: api('/workspaces'), headers: carol.headers })).json();
    expect(carolList.map((w: { id: string }) => w.id)).not.toContain(ws.id);
    expect(carolList).toHaveLength(1);
  });

  it('validates input', async () => {
    const noName = await env.app.inject({ method: 'POST', url: api('/workspaces'), headers: alice.headers, payload: { memberIds: [] } });
    expect(noName.statusCode).toBe(400);
    const unknown = await env.app.inject({
      method: 'POST',
      url: api('/workspaces'),
      headers: alice.headers,
      payload: { name: 'X', memberIds: [uuidv7()] },
    });
    expect(unknown.statusCode).toBe(400);
    const anon = await env.app.inject({ method: 'GET', url: api('/workspaces') });
    expect(anon.statusCode).toBe(401);
  });

  it('only lets the owner patch: 404 for non-members, 403 for members', async () => {
    const ws = await createShared(alice, [bob.id]);
    const byCarol = await env.app.inject({ method: 'PATCH', url: api(`/workspaces/${ws.id}`), headers: carol.headers, payload: { name: 'Mine' } });
    expect(byCarol.statusCode).toBe(404);
    const byBob = await env.app.inject({ method: 'PATCH', url: api(`/workspaces/${ws.id}`), headers: bob.headers, payload: { name: 'Mine' } });
    expect(byBob.statusCode).toBe(403);
    expect(byBob.json().error).toBe('forbidden');

    const ok = await env.app.inject({
      method: 'PATCH',
      url: api(`/workspaces/${ws.id}`),
      headers: alice.headers,
      payload: { name: 'Renamed', addMemberIds: [carol.id], removeMemberIds: [bob.id] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: ws.id, name: 'Renamed', kind: 'shared' });
    expect(ok.json().members.map((m: { userId: string }) => m.userId).sort()).toEqual([alice.id, carol.id].sort());

    const audit = await env.db.query(`SELECT detail FROM audit_log WHERE action = 'workspace.update' AND resource_id = $1`, [ws.id]);
    expect(audit.rows[0]!.detail).toMatchObject({ name: 'Renamed', added: [carol.id], removed: [bob.id] });
  });

  it('protects private workspaces and owners', async () => {
    const addToPrivate = await env.app.inject({
      method: 'PATCH',
      url: api(`/workspaces/${alice.privateWorkspaceId}`),
      headers: alice.headers,
      payload: { addMemberIds: [bob.id] },
    });
    expect(addToPrivate.statusCode).toBe(400);
    const rename = await env.app.inject({
      method: 'PATCH',
      url: api(`/workspaces/${alice.privateWorkspaceId}`),
      headers: alice.headers,
      payload: { name: 'My notes' },
    });
    expect(rename.statusCode).toBe(200);

    const ws = await createShared(alice, [bob.id]);
    const removeOwner = await env.app.inject({
      method: 'PATCH',
      url: api(`/workspaces/${ws.id}`),
      headers: alice.headers,
      payload: { removeMemberIds: [alice.id] },
    });
    expect(removeOwner.statusCode).toBe(400);
  });
});

describe('policy', () => {
  it('answers membership questions for workspaces and pages', async () => {
    const ws = await createShared(alice, [bob.id]);
    const p = page({ workspaceId: ws.id, hlc: hlc(Date.now()) });
    expect((await push(env.app, alice.headers, [{ entity: 'page', data: p }])).statusCode).toBe(200);

    expect(await canAccessWorkspace(env.db, bob.id, ws.id)).toBe(true);
    expect(await canAccessWorkspace(env.db, carol.id, ws.id)).toBe(false);
    expect(await canAccessPage(env.db, bob.id, p.id)).toBe(true);
    expect(await canAccessPage(env.db, carol.id, p.id)).toBe(false);
    const carolSees = await visibleWorkspaceIds(env.db, carol.id);
    expect(carolSees).toContain(carol.privateWorkspaceId);
    expect(carolSees).not.toContain(ws.id);
    expect(carolSees).not.toContain(alice.privateWorkspaceId);
  });

  it('answers membership questions for conversations', async () => {
    const convId = uuidv7();
    await env.db.query(`INSERT INTO conversations (id, kind, created_by) VALUES ($1, 'dm', $2)`, [convId, alice.id]);
    await env.db.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`, [
      convId,
      alice.id,
      bob.id,
    ]);
    expect(await canAccessConversation(env.db, bob.id, convId)).toBe(true);
    expect(await canAccessConversation(env.db, carol.id, convId)).toBe(false);
    expect(await visibleConversationIds(env.db, alice.id)).toContain(convId);
    expect(await visibleConversationIds(env.db, carol.id)).not.toContain(convId);
  });

  it('filters AI chunks by membership and ai_visible inside SQL', async () => {
    const now = Date.now();
    const visible = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(now), title: 'visible' });
    const hidden = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(now), title: 'hidden', aiVisible: false });
    await push(env.app, alice.headers, [
      { entity: 'page', data: visible },
      { entity: 'page', data: hidden },
    ]);
    const convId = uuidv7();
    await env.db.query(`INSERT INTO conversations (id, kind, created_by) VALUES ($1, 'group', $2)`, [convId, alice.id]);
    await env.db.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)`, [convId, alice.id]);

    const chunk = async (sourceType: string, sourceId: string, text: string) =>
      env.db.query(
        `INSERT INTO chunks (id, source_type, source_id, workspace_id, conversation_id, text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv7(),
          sourceType,
          sourceId,
          sourceType === 'page' ? alice.privateWorkspaceId : null,
          sourceType === 'conversation' ? convId : null,
          text,
          `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`,
        ],
      );
    await chunk('page', visible.id, 'secret plan alpha');
    await chunk('page', hidden.id, 'secret plan beta');
    await chunk('conversation', convId, 'secret plan gamma');

    const search = async (userId: string) =>
      (
        await env.db.query<{ text: string }>(
          `SELECT c.text FROM chunks c
           WHERE c.tsv @@ plainto_tsquery('simple', $2) AND ${sqlChunkVisible('$1', 'c')}
           ORDER BY c.embedding <=> $3 LIMIT 10`,
          [userId, 'secret plan', `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`],
        )
      ).rows.map((r) => r.text);

    expect((await search(alice.id)).sort()).toEqual(['secret plan alpha', 'secret plan gamma']);
    expect(await search(bob.id)).toEqual([]);

    await env.db.query('UPDATE conversations SET ai_visible = false WHERE id = $1', [convId]);
    expect(await search(alice.id)).toEqual(['secret plan alpha']);
  });
});
