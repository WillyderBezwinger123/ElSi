import { timingSafeEqual } from 'node:crypto';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import type { Db } from '../db/db.js';
import { conflict, forbidden, notFound, parse, unauthorized } from '../errors.js';
import { UUID_RE, uuidv7 } from '../ids.js';
import { createPrivateWorkspace } from '../workspaces/service.js';
import { hashPassword, verifyDummy, verifyPassword } from './passwords.js';
import { hashToken, newRefreshToken, signAccessToken } from './tokens.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

const email = z
  .string()
  .trim()
  .max(320)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());
const password = z.string().min(8, 'Password must have at least 8 characters').max(1024);
const deviceName = z.string().trim().min(1).max(200);

const registerBody = z.object({
  email,
  name: z.string().trim().min(1).max(200),
  password,
  deviceName,
  inviteCode: z.string().max(500).optional(),
});
const loginBody = z.object({ email, password: z.string().max(1024), deviceName });
const refreshBody = z.object({ refreshToken: z.string().min(1).max(500) });
const idParam = z.object({ id: z.string().regex(UUID_RE, 'invalid id') });

// Serializes registration so two concurrent "first users" cannot both skip the invite check.
const REGISTER_LOCK = 7_123_003;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function createSession(db: Db, userId: string, device: string) {
  const id = uuidv7();
  const refreshToken = newRefreshToken();
  await db.query(
    'INSERT INTO device_sessions (id, user_id, device_name, refresh_hash) VALUES ($1, $2, $3, $4)',
    [id, userId, device, hashToken(refreshToken)],
  );
  return { id, refreshToken };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, events } = app.ctx;

  const authLimit: { rateLimit: RateLimitOptions | false } = {
    rateLimit:
      config.authRateLimitPerMinute > 0 ? { max: config.authRateLimitPerMinute, timeWindow: '1 minute' } : false,
  };

  const authResult = async (user: User, sessionId: string, refreshToken: string) => ({
    user,
    accessToken: await signAccessToken(config.jwtSecret, user.id, sessionId),
    refreshToken,
    deviceId: sessionId,
  });

  app.post('/auth/register', { config: authLimit }, async (req) => {
    const body = parse(registerBody, req.body);
    const passwordHash = await hashPassword(body.password);

    const { user, session } = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock($1)', [REGISTER_LOCK]);
      const { rows } = await t.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      if (rows[0]!.n > 0) {
        if (!config.inviteCode) throw forbidden('Registration is closed on this server');
        if (!body.inviteCode || !safeEqual(body.inviteCode, config.inviteCode)) {
          throw forbidden('Invalid invite code');
        }
      }
      const existing = await t.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (existing.rows.length > 0) throw conflict('Email is already registered');

      const user: User = { id: uuidv7(), email: body.email, name: body.name };
      await t.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [
        user.id,
        user.email,
        user.name,
        passwordHash,
      ]);
      await createPrivateWorkspace(t, user.id);
      const session = await createSession(t, user.id, body.deviceName);
      await audit(t, {
        actorId: user.id,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user.id,
        detail: { deviceSessionId: session.id, ip: req.ip },
      });
      return { user, session };
    });

    return authResult(user, session.id, session.refreshToken);
  });

  app.post('/auth/login', { config: authLimit }, async (req) => {
    const body = parse(loginBody, req.body);
    const row = (
      await db.query<User & { password_hash: string }>(
        'SELECT id, email, name, password_hash FROM users WHERE email = $1',
        [body.email],
      )
    ).rows[0];

    let ok = false;
    if (row) ok = await verifyPassword(row.password_hash, body.password);
    else await verifyDummy(body.password);
    if (!row || !ok) {
      await audit(db, {
        actorId: row?.id ?? null,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: row?.id ?? null,
        detail: { email: body.email, ip: req.ip },
      });
      throw unauthorized('Wrong email or password');
    }

    const user: User = { id: row.id, email: row.email, name: row.name };
    const session = await db.tx(async (t) => {
      const s = await createSession(t, user.id, body.deviceName);
      await audit(t, {
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'device_session',
        resourceId: s.id,
        detail: { deviceName: body.deviceName, ip: req.ip },
      });
      return s;
    });
    return authResult(user, session.id, session.refreshToken);
  });

  app.post('/auth/refresh', { config: authLimit }, async (req) => {
    const { refreshToken } = parse(refreshBody, req.body);
    const presented = hashToken(refreshToken);
    const next = newRefreshToken();

    // Atomic rotation: only one concurrent caller can swap a given token.
    const rotated = await db.query<{ id: string; user_id: string }>(
      `UPDATE device_sessions SET refresh_hash = $2, prev_refresh_hash = $1, last_seen_at = now()
       WHERE refresh_hash = $1 AND revoked_at IS NULL
       RETURNING id, user_id`,
      [presented, hashToken(next)],
    );
    const session = rotated.rows[0];
    if (session) {
      return {
        accessToken: await signAccessToken(config.jwtSecret, session.user_id, session.id),
        refreshToken: next,
      };
    }

    // Presenting the previous token again means it leaked (or a client bug): revoke the session.
    const reused = await db.query<{ id: string; user_id: string }>(
      `UPDATE device_sessions SET revoked_at = now()
       WHERE prev_refresh_hash = $1 AND revoked_at IS NULL
       RETURNING id, user_id`,
      [presented],
    );
    for (const s of reused.rows) {
      await db.query('DELETE FROM push_endpoints WHERE device_session_id = $1', [s.id]);
      events.closeSession(s.id);
      await audit(db, {
        actorId: s.user_id,
        action: 'auth.refresh_reuse',
        resourceType: 'device_session',
        resourceId: s.id,
        detail: { ip: req.ip },
      });
    }
    throw unauthorized('Invalid refresh token');
  });

  // ---------------------------------------------------------------- authenticated

  const revokeSession = async (req: FastifyRequest, sessionId: string, action: string) => {
    await db.tx(async (t) => {
      await t.query('UPDATE device_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
        sessionId,
      ]);
      await t.query('DELETE FROM push_endpoints WHERE device_session_id = $1', [sessionId]);
      await audit(t, {
        actorId: req.user.id,
        action,
        resourceType: 'device_session',
        resourceId: sessionId,
        detail: { ip: req.ip },
      });
    });
    events.closeSession(sessionId);
  };

  app.post('/auth/logout', { onRequest: app.authenticate }, async (req, reply) => {
    await revokeSession(req, req.user.sessionId, 'auth.logout');
    return reply.status(204).send();
  });

  app.get('/auth/devices', { onRequest: app.authenticate }, async (req) => {
    const { rows } = await db.query<{
      id: string;
      device_name: string;
      last_seen_at: Date;
      created_at: Date;
    }>(
      `SELECT id, device_name, last_seen_at, created_at FROM device_sessions
       WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
      [req.user.id],
    );
    return rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      lastSeenAt: r.last_seen_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      current: r.id === req.user.sessionId,
    }));
  });

  app.delete('/auth/devices/:id', { onRequest: app.authenticate }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query(
      'SELECT 1 FROM device_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [id, req.user.id],
    );
    if (rows.length === 0) throw notFound('Device not found');
    await revokeSession(req, id, 'auth.device_revoke');
    return reply.status(204).send();
  });

  app.get('/me', { onRequest: app.authenticate }, async (req) => {
    const { rows } = await db.query<User>('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) throw unauthorized();
    return rows[0];
  });

  app.get('/users', { onRequest: app.authenticate }, async () => {
    const { rows } = await db.query<User>('SELECT id, email, name FROM users ORDER BY lower(name), id');
    return rows;
  });
}
