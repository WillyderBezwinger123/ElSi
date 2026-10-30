import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestEnv, loginDevice, registerUser, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

const api = (path: string) => `/api/v1${path}`;

describe('health', () => {
  it('answers without auth', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the error shape for unknown routes', async () => {
    const res = await env.app.inject({ method: 'GET', url: api('/nope') });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});

describe('registration', () => {
  it('lets the first user register without an invite code and creates a private workspace', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { email: '  First@Example.com ', name: 'First', password: 'hunter2hunter2', deviceName: 'pc' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ email: 'first@example.com', name: 'First' });
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(typeof body.deviceId).toBe('string');

    const { rows } = await env.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
      body.user.id,
    ]);
    expect(rows[0]!.password_hash.startsWith('$argon2id$')).toBe(true);

    const ws = await env.app.inject({ method: 'GET', url: api('/workspaces'), headers: bearer(body.accessToken) });
    expect(ws.json()).toEqual([
      { id: expect.any(String), name: 'Private', kind: 'private', members: [{ userId: body.user.id, role: 'owner' }] },
    ]);
  });

  it('requires the invite code for later users', async () => {
    const payload = { email: 'second@example.com', name: 'Second', password: 'hunter2hunter2', deviceName: 'pc' };
    const none = await env.app.inject({ method: 'POST', url: api('/auth/register'), payload });
    expect(none.statusCode).toBe(403);
    expect(none.json().error).toBe('forbidden');

    const wrong = await env.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { ...payload, inviteCode: 'nope' },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await env.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { ...payload, inviteCode: env.config.inviteCode },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects duplicate emails case-insensitively and short passwords', async () => {
    const dup = await env.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { email: 'FIRST@example.com', name: 'X', password: 'hunter2hunter2', deviceName: 'pc', inviteCode: env.config.inviteCode },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('conflict');

    const short = await env.app.inject({
      method: 'POST',
      url: api('/auth/register'),
      payload: { email: 'short@example.com', name: 'X', password: 'short', deviceName: 'pc', inviteCode: env.config.inviteCode },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toBe('bad_request');
  });

  it('is closed after the first user when INVITE_CODE is unset', async () => {
    const closed = await createTestEnv({ inviteCode: undefined });
    try {
      await registerUser(closed.app, { inviteCode: null });
      const res = await closed.app.inject({
        method: 'POST',
        url: api('/auth/register'),
        payload: { email: 'late@example.com', name: 'Late', password: 'hunter2hunter2', deviceName: 'pc', inviteCode: '' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe('login, tokens and devices', () => {
  it('logs in with the right password only', async () => {
    const u = await registerUser(env.app);
    const bad = await env.app.inject({
      method: 'POST',
      url: api('/auth/login'),
      payload: { email: u.email, password: 'wrong password', deviceName: 'phone' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('unauthorized');

    const unknown = await env.app.inject({
      method: 'POST',
      url: api('/auth/login'),
      payload: { email: 'nobody@example.com', password: 'whatever123', deviceName: 'phone' },
    });
    expect(unknown.statusCode).toBe(401);

    const phone = await loginDevice(env.app, u);
    expect(phone.deviceId).not.toBe(u.deviceId);
    const me = await env.app.inject({ method: 'GET', url: api('/me'), headers: phone.headers });
    expect(me.json()).toEqual({ id: u.id, email: u.email, name: u.name });

    const { rows } = await env.db.query(
      `SELECT 1 FROM audit_log WHERE action = 'auth.login' AND actor_id = $1 AND resource_id = $2`,
      [u.id, phone.deviceId],
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects missing, malformed and forged tokens', async () => {
    expect((await env.app.inject({ method: 'GET', url: api('/me') })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: bearer('garbage') })).statusCode).toBe(401);
    const u = await registerUser(env.app);
    const [h, p] = u.accessToken.split('.');
    const forged = `${h}.${p}.AAAA`;
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: bearer(forged) })).statusCode).toBe(401);
  });

  it('rotates refresh tokens, and reuse of an old one revokes the session', async () => {
    const u = await registerUser(env.app);
    const r1 = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: u.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const t1 = r1.json();
    expect(t1.refreshToken).not.toBe(u.refreshToken);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: bearer(t1.accessToken) })).statusCode).toBe(200);

    const r2 = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: t1.refreshToken } });
    expect(r2.statusCode).toBe(200);
    const t2 = r2.json();

    // Replaying the previous token: rejected and the whole session is revoked.
    const replay = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: t1.refreshToken } });
    expect(replay.statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: bearer(t2.accessToken) })).statusCode).toBe(401);
    const after = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: t2.refreshToken } });
    expect(after.statusCode).toBe(401);

    const unknown = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: 'nope' } });
    expect(unknown.statusCode).toBe(401);
  });

  it('rejects access tokens of a logged-out session', async () => {
    const u = await registerUser(env.app);
    const out = await env.app.inject({ method: 'POST', url: api('/auth/logout'), headers: u.headers });
    expect(out.statusCode).toBe(204);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: u.headers })).statusCode).toBe(401);
    const refresh = await env.app.inject({ method: 'POST', url: api('/auth/refresh'), payload: { refreshToken: u.refreshToken } });
    expect(refresh.statusCode).toBe(401);
  });

  it('lists and revokes devices', async () => {
    const u = await registerUser(env.app, { deviceName: 'laptop' });
    const phone = await loginDevice(env.app, u, 'phone');

    const list = await env.app.inject({ method: 'GET', url: api('/auth/devices'), headers: u.headers });
    expect(list.statusCode).toBe(200);
    const devices = list.json();
    expect(devices).toHaveLength(2);
    expect(devices.find((d: { current: boolean }) => d.current)).toMatchObject({ id: u.deviceId, deviceName: 'laptop' });
    expect(devices.find((d: { current: boolean }) => !d.current)).toMatchObject({ id: phone.deviceId, deviceName: 'phone' });
    expect(Date.parse(devices[0].lastSeenAt)).not.toBeNaN();
    expect(Date.parse(devices[0].createdAt)).not.toBeNaN();

    // Another user cannot revoke it.
    const other = await registerUser(env.app);
    const foreign = await env.app.inject({ method: 'DELETE', url: api(`/auth/devices/${phone.deviceId}`), headers: other.headers });
    expect(foreign.statusCode).toBe(404);

    const del = await env.app.inject({ method: 'DELETE', url: api(`/auth/devices/${phone.deviceId}`), headers: u.headers });
    expect(del.statusCode).toBe(204);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: phone.headers })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: api('/me'), headers: u.headers })).statusCode).toBe(200);
    const again = await env.app.inject({ method: 'GET', url: api('/auth/devices'), headers: u.headers });
    expect(again.json()).toHaveLength(1);

    const { rows } = await env.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.device_revoke' AND resource_id = $1`, [
      phone.deviceId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('lists all users', async () => {
    const u = await registerUser(env.app);
    const res = await env.app.inject({ method: 'GET', url: api('/users'), headers: u.headers });
    expect(res.statusCode).toBe(200);
    const users = res.json();
    expect(users.length).toBeGreaterThan(2);
    expect(users).toContainEqual({ id: u.id, email: u.email, name: u.name });
    expect(Object.keys(users[0]).sort()).toEqual(['email', 'id', 'name']);
  });
});

describe('rate limiting', () => {
  it('limits auth routes per IP', async () => {
    const limited = await createTestEnv({ authRateLimitPerMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: api('/auth/login'),
          payload: { email: 'x@example.com', password: 'whatever123', deviceName: 'pc' },
        });
        codes.push(res.statusCode);
        if (res.statusCode === 429) expect(res.json().error).toBe('rate_limited');
      }
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});
