import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const MB = 1024 * 1024;

/** Empty strings in env files mean "unset". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const intWithDefault = (def: number) =>
  optionalString.transform((v, ctx) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      ctx.addIssue({ code: 'custom', message: `expected a non-negative integer, got "${v}"` });
      return z.NEVER;
    }
    return n;
  });

const envSchema = z.object({
  NODE_ENV: optionalString,
  HOST: optionalString,
  PORT: intWithDefault(3000),
  LOG_LEVEL: optionalString,
  DATABASE_URL: optionalString,
  JWT_SECRET: optionalString,
  INVITE_CODE: optionalString,
  FILES_DIR: optionalString,
  PUBLIC_URL: optionalString,
  TRUST_PROXY: optionalString,
  AUTH_RATE_LIMIT_PER_MIN: intWithDefault(10),
  ANTHROPIC_API_KEY: optionalString,
  AI_MONTHLY_TOKEN_BUDGET: intWithDefault(2_000_000),
  EMBEDDINGS_PROVIDER: optionalString.pipe(z.enum(['ollama', 'voyage', 'none']).optional()),
  EMBEDDINGS_MODEL: optionalString,
  OLLAMA_URL: optionalString,
  VOYAGE_API_KEY: optionalString,
  WHISPER_URL: optionalString,
  WHISPER_MODEL: optionalString,
});

export type NodeEnv = 'development' | 'production' | 'test';

export interface Config {
  env: NodeEnv;
  host: string;
  port: number;
  logLevel: string;
  /** `postgres://...`, `pglite://memory` or `pglite:///path/to/dir`. */
  databaseUrl: string;
  jwtSecret: string;
  /** Required for every registration after the first. Unset = registration closed. */
  inviteCode?: string;
  filesDir: string;
  publicUrl?: string;
  /** Passed to Fastify's `trustProxy`. */
  trustProxy: boolean | number | string;
  /** Requests per minute per IP on the unauthenticated auth routes. 0 disables the limit. */
  authRateLimitPerMinute: number;
  /** Upload limit for `PUT /files/:sha256`. */
  maxUploadBytes: number;
  anthropicApiKey?: string;
  aiMonthlyTokenBudget: number;
  embeddingsProvider: 'ollama' | 'voyage' | 'none';
  embeddingsModel?: string;
  ollamaUrl?: string;
  voyageApiKey?: string;
  whisperUrl?: string;
  whisperModel?: string;
}

export class ConfigError extends Error {}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (v === undefined) return false;
  const lower = v.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // comma-separated list of addresses / CIDRs
}

/** Parses server configuration from environment variables. Throws ConfigError on invalid input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const nodeEnv: NodeEnv =
    e.NODE_ENV === 'production' ? 'production' : e.NODE_ENV === 'test' ? 'test' : 'development';
  const production = nodeEnv === 'production';

  let jwtSecret = e.JWT_SECRET;
  if (production) {
    if (!jwtSecret) throw new ConfigError('JWT_SECRET is required when NODE_ENV=production');
    if (jwtSecret.length < 32) {
      throw new ConfigError('JWT_SECRET must be at least 32 characters in production');
    }
  }
  // Dev/test fallback: a random per-process secret (tokens die on restart).
  jwtSecret ??= randomBytes(32).toString('hex');

  let databaseUrl = e.DATABASE_URL;
  if (!databaseUrl) {
    if (production) throw new ConfigError('DATABASE_URL is required when NODE_ENV=production');
    databaseUrl = 'pglite://memory';
  }

  return {
    env: nodeEnv,
    host: e.HOST ?? '0.0.0.0',
    port: e.PORT,
    logLevel: e.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    databaseUrl,
    jwtSecret,
    inviteCode: e.INVITE_CODE,
    filesDir: e.FILES_DIR ?? './data/files',
    publicUrl: e.PUBLIC_URL,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    authRateLimitPerMinute: e.AUTH_RATE_LIMIT_PER_MIN,
    maxUploadBytes: 25 * MB,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    aiMonthlyTokenBudget: e.AI_MONTHLY_TOKEN_BUDGET,
    embeddingsProvider: e.EMBEDDINGS_PROVIDER ?? 'none',
    embeddingsModel: e.EMBEDDINGS_MODEL,
    ollamaUrl: e.OLLAMA_URL,
    voyageApiKey: e.VOYAGE_API_KEY,
    whisperUrl: e.WHISPER_URL,
    whisperModel: e.WHISPER_MODEL,
  };
}
