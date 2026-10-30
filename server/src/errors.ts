import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'ai_not_configured'
  | 'budget_exceeded'
  | 'internal';

/** Throw from any route; the error handler renders `{error, message}` with the status. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad request') => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg = 'Conflict') => new HttpError(409, 'conflict', msg);
export const tooLarge = (msg = 'Payload too large') => new HttpError(413, 'too_large', msg);

/** Validates `value` with a zod schema, throwing a 400 `bad_request` on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError | Error, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    // Postgres data exceptions (class 22: invalid text, \u0000 in jsonb, out of range) are client errors.
    const pgCode = (err as { code?: unknown }).code;
    if (typeof pgCode === 'string' && /^22[0-9A-Z]{3}$/.test(pgCode)) {
      return reply.status(400).send({ error: 'bad_request', message: err.message });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    const code = STATUS_CODES[status];
    if (code && status < 500) {
      return reply.status(status).send({ error: code, message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} not found` });
  });
}
