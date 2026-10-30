import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Db } from '../db/db.js';
import type { AuthUser } from '../context.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const keyCache = new Map<string, Uint8Array>();
function key(secret: string): Uint8Array {
  let k = keyCache.get(secret);
  if (!k) keyCache.set(secret, (k = new TextEncoder().encode(secret)));
  return k;
}

export async function signAccessToken(secret: string, userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key(secret));
}

/** Returns the claims or null if the token is malformed, expired or badly signed. */
export async function verifyAccessTokenSignature(secret: string, token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { id: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

/**
 * Full access-token check: signature, expiry, and a live (not revoked) device session that
 * belongs to the token's user. Also bumps `last_seen_at` at most once a minute.
 */
export async function authenticateToken(db: Db, secret: string, token: string): Promise<AuthUser | null> {
  const claims = await verifyAccessTokenSignature(secret, token);
  if (!claims) return null;
  const { rows } = await db.query<{ stale: boolean }>(
    `SELECT last_seen_at < now() - interval '1 minute' AS stale
     FROM device_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [claims.sessionId, claims.id],
  );
  if (rows.length === 0) return null;
  if (rows[0]!.stale) {
    await db.query('UPDATE device_sessions SET last_seen_at = now() WHERE id = $1', [claims.sessionId]);
  }
  return claims;
}

/** Opaque refresh token (256 bits, base64url). Only its hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
