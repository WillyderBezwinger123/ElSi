import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createTestEnv, hlc, loginDevice, page, push, registerUser, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

interface Client {
  ws: WebSocket;
  frames: Record<string, unknown>[];
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(frame: unknown): void;
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(token: string): Promise<Client> {
  const frames: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (f: Record<string, unknown>) => void }[] = [];
  let resolveClosed!: (v: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
  const ws = await env.app.injectWS(`/api/v1/ws?token=${encodeURIComponent(token)}`, {}, {
    onInit(socket) {
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        const i = waiters.findIndex((w) => w.type === frame.type);
        if (i >= 0) waiters.splice(i, 1)[0]!.resolve(frame);
      });
      socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    },
  });
  return {
    ws,
    frames,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next(type, timeoutMs = 2000) {
      const have = frames.find((f) => f.type === type);
      if (have) {
        frames.splice(frames.indexOf(have), 1);
        return Promise.resolve(have);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (f) => {
            clearTimeout(timer);
            frames.splice(frames.indexOf(f), 1);
            resolve(f);
          },
        });
      });
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('websocket gateway', () => {
  it('closes with 4401 for a bad or missing token', async () => {
    const bad = await connect('not-a-token');
    expect((await bad.closed).code).toBe(4401);
    const ws = await env.app.injectWS('/api/v1/ws');
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('answers ping with pong and rejects junk frames', async () => {
    const u = await registerUser(env.app);
    const c = await connect(u.accessToken);
    c.send({ type: 'ping' });
    expect(await c.next('pong')).toEqual({ type: 'pong' });
    c.ws.send('not json');
    expect(await c.next('error')).toMatchObject({ error: 'bad_request' });
    c.send({ type: 'nope' });
    expect(await c.next('error')).toMatchObject({ error: 'bad_request' });
    expect(env.app.ctx.events.isOnline(u.id)).toBe(true);
    c.ws.close();
    await c.closed;
    await sleep(20);
    expect(env.app.ctx.events.isOnline(u.id)).toBe(false);
  });

  it('sends sync.hint to the other devices of the pushing user and to members, not the pusher', async () => {
    const u = await registerUser(env.app, { deviceName: 'laptop' });
    const phone = await loginDevice(env.app, u, 'phone');
    const friend = await registerUser(env.app);
    const stranger = await registerUser(env.app);
    const laptopWs = await connect(u.accessToken);
    const phoneWs = await connect(phone.accessToken);
    const friendWs = await connect(friend.accessToken);
    const strangerWs = await connect(stranger.accessToken);

    const res = await push(env.app, u.headers, [{ entity: 'page', data: page({ workspaceId: u.privateWorkspaceId, hlc: hlc(Date.now()) }) }]);
    const { serverSeq } = res.json();
    expect(await phoneWs.next('sync.hint')).toEqual({ type: 'sync.hint', seq: serverSeq });

    // Shared workspace: members' devices get hints too.
    const ws = (
      await env.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: u.headers, payload: { name: 'T', memberIds: [friend.id] } })
    ).json();
    await friendWs.next('sync.hint');
    await phoneWs.next('sync.hint');
    await push(env.app, u.headers, [{ entity: 'page', data: page({ workspaceId: ws.id, hlc: hlc(Date.now()) }) }]);
    expect((await friendWs.next('sync.hint')).type).toBe('sync.hint');

    await sleep(50);
    expect(laptopWs.frames.filter((f) => f.type === 'sync.hint')).toEqual([]);
    expect(strangerWs.frames).toEqual([]);
  });

  it('routes custom client frames to registered handlers', async () => {
    env.app.ctx.events.onClientMessage('echo', (conn, msg) => conn.send({ type: 'echo', userId: conn.userId, body: msg.body }));
    expect(() => env.app.ctx.events.onClientMessage('echo', () => {})).toThrow();
    const u = await registerUser(env.app);
    const c = await connect(u.accessToken);
    c.send({ type: 'echo', body: 'hi' });
    expect(await c.next('echo')).toEqual({ type: 'echo', userId: u.id, body: 'hi' });

    env.app.ctx.events.publish([u.id], { type: 'custom', n: 1 });
    expect(await c.next('custom')).toEqual({ type: 'custom', n: 1 });
  });

  it('closes sockets of a revoked device with 4401', async () => {
    const u = await registerUser(env.app);
    const phone = await loginDevice(env.app, u, 'phone');
    const c = await connect(phone.accessToken);
    const del = await env.app.inject({ method: 'DELETE', url: `/api/v1/auth/devices/${phone.deviceId}`, headers: u.headers });
    expect(del.statusCode).toBe(204);
    expect((await c.closed).code).toBe(4401);
    // And it cannot reconnect with the old token.
    const again = await connect(phone.accessToken);
    expect((await again.closed).code).toBe(4401);
  });
});
