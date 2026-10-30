import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clampHlc, canonicalJson } from '../src/sync/hlc.js';
import { block, createTestEnv, hlc, page, pullAll, push, registerUser, type TestEnv, type TestUser } from './helpers.js';

let env: TestEnv;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  env = await createTestEnv();
  alice = await registerUser(env.app, { name: 'Alice' });
  bob = await registerUser(env.app, { name: 'Bob' });
});
afterAll(async () => env.close());

const api = (path: string) => `/api/v1${path}`;
const T = () => Date.now() - 10_000; // base wall time safely in the past

async function sharedWorkspace(owner: TestUser, members: TestUser[]) {
  const res = await env.app.inject({
    method: 'POST',
    url: api('/workspaces'),
    headers: owner.headers,
    payload: { name: 'Shared', memberIds: members.map((m) => m.id) },
  });
  return res.json().id as string;
}

describe('hlc helpers', () => {
  it('clamps far-future wall clocks and keeps the rest', () => {
    const now = 1_700_000_000_000;
    expect(clampHlc(hlc(now + 5_000, 3, 'd'), now)).toBe(hlc(now + 5_000, 3, 'd'));
    expect(clampHlc(hlc(now + 3_600_000, 7, 'dev-x-1'), now)).toBe(hlc(now + 60_000, 7, 'dev-x-1'));
  });

  it('compares JSON regardless of key order', () => {
    expect(canonicalJson({ a: 1, b: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ b: [{ x: 1, y: 2 }], a: 1 }));
  });
});

describe('push', () => {
  it('inserts new rows, overwrites with newer hlc and ignores stale ones', async () => {
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t), title: 'v1' });
    const b = block({ pageId: p.id, hlc: hlc(t), content: { text: 'one' } });
    const first = await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);
    expect(first.statusCode).toBe(200);
    const r1 = first.json();
    expect(r1.results).toEqual([
      { id: p.id, status: 'applied' },
      { id: b.id, status: 'applied' },
    ]);
    expect(r1.serverSeq).toBeGreaterThan(0);

    // Same op again: harmless.
    const again = await push(env.app, alice.headers, [{ entity: 'page', data: p }]);
    expect(again.json().results).toEqual([{ id: p.id, status: 'stale' }]);

    const newer = await push(env.app, alice.headers, [
      { entity: 'page', data: { ...p, title: 'v2', hlc: hlc(t + 1) }, baseHlc: p.hlc },
    ]);
    expect(newer.json().results).toEqual([{ id: p.id, status: 'applied' }]);
    expect(newer.json().serverSeq).toBeGreaterThan(r1.serverSeq);

    const older = await push(env.app, alice.headers, [
      { entity: 'page', data: { ...p, title: 'old', hlc: hlc(t - 1) }, baseHlc: hlc(t + 1) },
    ]);
    expect(older.json().results).toEqual([{ id: p.id, status: 'stale' }]);

    const row = await env.db.query('SELECT title, hlc FROM pages WHERE id = $1', [p.id]);
    expect(row.rows[0]).toEqual({ title: 'v2', hlc: hlc(t + 1) });
  });

  it('keeps a losing concurrent block edit as a conflict copy, idempotently', async () => {
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t, 0, 'A') });
    const b = block({ pageId: p.id, hlc: hlc(t, 0, 'A'), content: { text: 'base' } });
    await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);
    // Device A edits (newer), device B edits concurrently from the same base (older clock).
    await push(env.app, alice.headers, [{ entity: 'block', data: { ...b, hlc: hlc(t + 20, 0, 'A'), content: { text: 'A wins' } }, baseHlc: b.hlc }]);
    const bOp = { entity: 'block' as const, data: { ...b, hlc: hlc(t + 10, 0, 'B'), content: { text: 'B edit' } }, baseHlc: b.hlc };

    const res = await push(env.app, alice.headers, [bOp]);
    const [result] = res.json().results;
    expect(result).toMatchObject({ id: b.id, status: 'conflict', conflictCopyId: expect.any(String) });

    const copy = await env.db.query('SELECT * FROM blocks WHERE id = $1', [result.conflictCopyId]);
    expect(copy.rows[0]).toMatchObject({ page_id: p.id, conflict_of: b.id, content: { text: 'B edit' }, deleted: false });
    const orig = await env.db.query('SELECT content FROM blocks WHERE id = $1', [b.id]);
    expect(orig.rows[0]!.content).toEqual({ text: 'A wins' });

    // Retrying the same op maps to the same copy.
    const retry = await push(env.app, alice.headers, [bOp]);
    expect(retry.json().results[0]).toEqual(result);
    const copies = await env.db.query('SELECT count(*)::int AS n FROM blocks WHERE conflict_of = $1', [b.id]);
    expect(copies.rows[0]!.n).toBe(1);

    // The copy reaches clients through pull.
    const pulled = await pullAll(env.app, alice.headers);
    expect(pulled.changes.find((c) => c.data.id === result.conflictCopyId)?.data).toMatchObject({
      conflictOf: b.id,
      pageId: p.id,
      content: { text: 'B edit' },
    });
  });

  it('keeps the overwritten version when a concurrent edit wins', async () => {
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t, 0, 'A') });
    const b = block({ pageId: p.id, hlc: hlc(t, 0, 'A'), content: { text: 'base' } });
    await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);
    await push(env.app, alice.headers, [{ entity: 'block', data: { ...b, hlc: hlc(t + 10, 0, 'A'), content: { text: 'A edit' } }, baseHlc: b.hlc }]);

    const res = await push(env.app, alice.headers, [
      { entity: 'block', data: { ...b, hlc: hlc(t + 20, 0, 'B'), content: { text: 'B wins' } }, baseHlc: b.hlc },
    ]);
    const [result] = res.json().results;
    expect(result).toMatchObject({ id: b.id, status: 'applied', conflictCopyId: expect.any(String) });
    const copy = await env.db.query('SELECT content, conflict_of FROM blocks WHERE id = $1', [result.conflictCopyId]);
    expect(copy.rows[0]).toEqual({ content: { text: 'A edit' }, conflict_of: b.id });

    // A device building on what it saw (baseHlc == stored) is not a conflict.
    const next = await push(env.app, alice.headers, [
      { entity: 'block', data: { ...b, hlc: hlc(t + 30, 0, 'A'), content: { text: 'A again' } }, baseHlc: hlc(t + 20, 0, 'B') },
    ]);
    expect(next.json().results[0]).toEqual({ id: b.id, status: 'applied' });
  });

  it('does not create copies when content is equal or for deletions', async () => {
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t, 0, 'A') });
    const b = block({ pageId: p.id, hlc: hlc(t + 5, 0, 'A'), content: { a: 1, b: 2 } });
    await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);
    const same = await push(env.app, alice.headers, [
      { entity: 'block', data: { ...b, hlc: hlc(t + 1, 0, 'B'), content: { b: 2, a: 1 } }, baseHlc: null },
    ]);
    expect(same.json().results[0]).toEqual({ id: b.id, status: 'stale' });
    const del = await push(env.app, alice.headers, [
      { entity: 'block', data: { ...b, hlc: hlc(t + 1, 0, 'B'), deleted: true, content: {} }, baseHlc: null },
    ]);
    expect(del.json().results[0]).toEqual({ id: b.id, status: 'stale' });
  });

  it('clamps hlc wall time to now + 60 s', async () => {
    const future = Date.now() + 3_600_000;
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(future, 4, 'C') });
    const before = Date.now();
    await push(env.app, alice.headers, [{ entity: 'page', data: p }]);
    const stored = (await env.db.query<{ hlc: string }>('SELECT hlc FROM pages WHERE id = $1', [p.id])).rows[0]!.hlc;
    const wall = Number(stored.slice(0, 15));
    expect(wall).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(wall).toBeGreaterThanOrEqual(before + 60_000);
    expect(stored.endsWith('-00004-C')).toBe(true);
  });

  it('validates the payload', async () => {
    const bad = await push(env.app, alice.headers, [
      { entity: 'page', data: page({ workspaceId: alice.privateWorkspaceId, hlc: 'yesterday' }) },
    ]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');
    const anon = await env.app.inject({ method: 'POST', url: api('/sync/push'), payload: { deviceId: 'x', ops: [] } });
    expect(anon.statusCode).toBe(401);
  });

  it('enforces workspace membership and rolls back the whole push', async () => {
    const t = T();
    const mine = page({ workspaceId: bob.privateWorkspaceId, hlc: hlc(t) });
    const theirs = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t) });
    const res = await push(env.app, bob.headers, [
      { entity: 'page', data: mine },
      { entity: 'page', data: theirs },
    ]);
    expect(res.statusCode).toBe(403);
    expect((await env.db.query('SELECT 1 FROM pages WHERE id = $1', [mine.id])).rows).toHaveLength(0);

    // Blocks into someone else's page are rejected too.
    const alicePage = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t) });
    await push(env.app, alice.headers, [{ entity: 'page', data: alicePage }]);
    const intrude = await push(env.app, bob.headers, [{ entity: 'block', data: block({ pageId: alicePage.id, hlc: hlc(t + 1) }) }]);
    expect(intrude.statusCode).toBe(403);
    // ...including overwriting an existing page by claiming his own workspace id.
    const hijack = await push(env.app, bob.headers, [
      { entity: 'page', data: { ...alicePage, workspaceId: bob.privateWorkspaceId, hlc: hlc(t + 5) } },
    ]);
    expect(hijack.statusCode).toBe(403);
  });
});

describe('pull', () => {
  it('pages through changes with a cursor and only shows visible workspaces', async () => {
    const fresh = await registerUser(env.app);
    const t = T();
    const pages = Array.from({ length: 5 }, (_, i) => page({ workspaceId: fresh.privateWorkspaceId, hlc: hlc(t + i), title: `p${i}` }));
    await push(env.app, fresh.headers, pages.map((p) => ({ entity: 'page' as const, data: p })));

    const seen: string[] = [];
    let since = 0;
    let rounds = 0;
    for (;;) {
      const res = await env.app.inject({ method: 'GET', url: api(`/sync/pull?since=${since}&limit=2`), headers: fresh.headers });
      const body = res.json();
      expect(body.changes.length).toBeLessThanOrEqual(2);
      for (const c of body.changes) {
        if (c.entity === 'page') seen.push(c.data.title);
        if (c.entity === 'workspace') expect(c.data).toMatchObject({ id: fresh.privateWorkspaceId, kind: 'private' });
      }
      expect(body.nextSeq).toBeGreaterThanOrEqual(since);
      since = body.nextSeq;
      rounds++;
      if (!body.hasMore) break;
    }
    expect(seen).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(rounds).toBe(3); // 1 workspace + 5 pages, 2 per round

    // Nothing new: empty, cursor stays put.
    const empty = await pullAll(env.app, fresh.headers, since);
    expect(empty).toEqual({ changes: [], nextSeq: since, hasMore: false });

    // Other users' rows never appear.
    const all = await pullAll(env.app, fresh.headers);
    const wsIds = new Set(all.changes.filter((c) => c.entity === 'page').map((c) => c.data.workspaceId));
    expect([...wsIds]).toEqual([fresh.privateWorkspaceId]);
    const bobView = await pullAll(env.app, bob.headers);
    expect(bobView.changes.some((c) => pages.some((p) => p.id === c.data.id))).toBe(false);
  });

  it('delivers tombstones', async () => {
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t) });
    const b = block({ pageId: p.id, hlc: hlc(t) });
    await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);
    const cursor = (await pullAll(env.app, alice.headers)).nextSeq;
    await push(env.app, alice.headers, [
      { entity: 'block', data: { ...b, deleted: true, hlc: hlc(t + 1) }, baseHlc: b.hlc },
      { entity: 'page', data: { ...p, deleted: true, hlc: hlc(t + 1) }, baseHlc: p.hlc },
    ]);
    const res = await pullAll(env.app, alice.headers, cursor);
    expect(res.changes.map((c) => [c.entity, c.data.id, c.data.deleted])).toEqual([
      ['page', p.id, true],
      ['block', b.id, true],
    ]);
  });

  it('shares pages with workspace members and sends a full workspace entity', async () => {
    const wsId = await sharedWorkspace(alice, [bob]);
    const p = page({ workspaceId: wsId, hlc: hlc(T()), title: 'team page' });
    await push(env.app, alice.headers, [{ entity: 'page', data: p }]);
    const res = await pullAll(env.app, bob.headers);
    expect(res.changes.find((c) => c.data.id === p.id)?.data).toMatchObject({ title: 'team page', workspaceId: wsId });
    const ws = res.changes.find((c) => c.entity === 'workspace' && c.data.id === wsId);
    expect(ws?.data).toMatchObject({ id: wsId, name: 'Shared', kind: 'shared' });
    expect(ws?.data.members).toHaveLength(2);
  });

  it('moves pages between workspaces only with membership in both, and tells the old side', async () => {
    const carol = await registerUser(env.app, { name: 'Carol' });
    const wsId = await sharedWorkspace(alice, [carol]);
    const t = T();
    const p = page({ workspaceId: alice.privateWorkspaceId, hlc: hlc(t), title: 'moving' });
    const b = block({ pageId: p.id, hlc: hlc(t), content: { text: 'body' } });
    await push(env.app, alice.headers, [
      { entity: 'page', data: p },
      { entity: 'block', data: b },
    ]);

    // Into a workspace Alice is not a member of: forbidden.
    const denied = await push(env.app, alice.headers, [
      { entity: 'page', data: { ...p, workspaceId: carol.privateWorkspaceId, hlc: hlc(t + 1) }, baseHlc: p.hlc },
    ]);
    expect(denied.statusCode).toBe(403);

    // Into the shared workspace: allowed, Carol now sees page and blocks.
    const carolCursor = (await pullAll(env.app, carol.headers)).nextSeq;
    const moved = await push(env.app, alice.headers, [
      { entity: 'page', data: { ...p, workspaceId: wsId, hlc: hlc(t + 2) }, baseHlc: p.hlc },
    ]);
    expect(moved.json().results[0].status).toBe('applied');
    const carolView = await pullAll(env.app, carol.headers, carolCursor);
    expect(carolView.changes.find((c) => c.data.id === p.id)?.data).toMatchObject({ workspaceId: wsId, deleted: false, title: 'moving' });
    expect(carolView.changes.find((c) => c.data.id === b.id)?.data).toMatchObject({ content: { text: 'body' }, deleted: false });

    // Carol moves it into her private workspace (member of both). Alice loses sight of it.
    const aliceCursor = (await pullAll(env.app, alice.headers)).nextSeq;
    const taken = await push(env.app, carol.headers, [
      { entity: 'page', data: { ...p, workspaceId: carol.privateWorkspaceId, hlc: hlc(t + 3) }, baseHlc: hlc(t + 2) },
    ]);
    expect(taken.json().results[0].status).toBe('applied');
    const aliceView = await pullAll(env.app, alice.headers, aliceCursor);
    const gone = aliceView.changes.find((c) => c.data.id === p.id)?.data;
    expect(gone).toMatchObject({ id: p.id, workspaceId: wsId, deleted: true, title: '' });
    expect(aliceView.changes.find((c) => c.data.id === b.id)?.data).toMatchObject({ deleted: true, content: {} });
  });

  it('re-announces content to added members and tells removed members', async () => {
    const dave = await registerUser(env.app, { name: 'Dave' });
    const wsId = await sharedWorkspace(alice, []);
    const p = page({ workspaceId: wsId, hlc: hlc(T()), title: 'before dave' });
    await push(env.app, alice.headers, [{ entity: 'page', data: p }]);
    const daveCursor = (await pullAll(env.app, dave.headers)).nextSeq;

    await env.app.inject({ method: 'PATCH', url: api(`/workspaces/${wsId}`), headers: alice.headers, payload: { addMemberIds: [dave.id] } });
    const afterAdd = await pullAll(env.app, dave.headers, daveCursor);
    expect(afterAdd.changes.find((c) => c.data.id === p.id)?.data.title).toBe('before dave');
    expect(afterAdd.changes.find((c) => c.entity === 'workspace')?.data.id).toBe(wsId);

    await env.app.inject({ method: 'PATCH', url: api(`/workspaces/${wsId}`), headers: alice.headers, payload: { removeMemberIds: [dave.id] } });
    const afterRemove = await pullAll(env.app, dave.headers, afterAdd.nextSeq);
    expect(afterRemove.changes).toEqual([
      { seq: expect.any(Number), entity: 'workspace', data: expect.objectContaining({ id: wsId, deleted: true, members: [] }) },
    ]);
  });
});
