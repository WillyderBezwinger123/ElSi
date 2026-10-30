import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { badRequest, notFound, parse, tooLarge } from '../errors.js';
import { uuidv7 } from '../ids.js';
import { canReadFile } from '../policy/policy.js';

export interface FileInfo {
  id: string;
  sha256: string;
  size: number;
  mime: string;
}

interface FileRow {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  uploader_id: string | null;
  path: string;
}

const shaParam = z.object({
  sha256: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.string().regex(/^[0-9a-f]{64}$/, 'expected a hex sha256')),
});

const toInfo = (r: FileRow): FileInfo => ({ id: r.id, sha256: r.sha256, size: Number(r.size), mime: r.mime });

function normalizeMime(header: string | undefined): string {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : 'application/octet-stream';
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;
  const root = path.resolve(config.filesDir);
  app.addHook('onRequest', app.authenticate);

  // Uploads are raw bytes of any type: replace the JSON/text parsers in this plugin's scope.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.maxUploadBytes }, (_req, body, done) =>
    done(null, body),
  );

  app.put(
    '/files/:sha256',
    {
      bodyLimit: config.maxUploadBytes,
      onRequest: async (req) => {
        const len = Number(req.headers['content-length'] ?? 0);
        if (len > config.maxUploadBytes) throw tooLarge(`Files are limited to ${config.maxUploadBytes} bytes`);
      },
    },
    async (req) => {
      const { sha256 } = parse(shaParam, req.params);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length > config.maxUploadBytes) throw tooLarge();
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== sha256) throw badRequest('Body does not match the sha256 in the URL');

      const rel = `${sha256.slice(0, 2)}/${sha256}`;
      const abs = path.join(root, rel);
      if (!(await exists(abs))) {
        await mkdir(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
        await writeFile(tmp, body);
        await rename(tmp, abs).catch(async (err) => {
          await rm(tmp, { force: true });
          if (!(await exists(abs))) throw err;
        });
      }

      const mime = normalizeMime(req.headers['content-type']);
      const inserted = await db.query<FileRow>(
        `INSERT INTO files (id, sha256, size, mime, uploader_id, path) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sha256) DO NOTHING RETURNING *`,
        [uuidv7(), sha256, body.length, mime, req.user.id, rel],
      );
      if (inserted.rows[0]) {
        await audit(db, {
          actorId: req.user.id,
          action: 'file.upload',
          resourceType: 'file',
          resourceId: inserted.rows[0].id,
          detail: { sha256, size: body.length, mime },
        });
        return toInfo(inserted.rows[0]);
      }
      const { rows } = await db.query<FileRow>('SELECT * FROM files WHERE sha256 = $1', [sha256]);
      return toInfo(rows[0]!);
    },
  );

  app.get('/files/:sha256', async (req, reply) => {
    const { sha256 } = parse(shaParam, req.params);
    const row = (await db.query<FileRow>('SELECT * FROM files WHERE sha256 = $1', [sha256])).rows[0];
    // Same answer for "missing" and "not yours", so hashes cannot be probed.
    if (!row || !(await canReadFile(db, req.user.id, row))) throw notFound('File not found');
    const abs = path.join(root, row.path);
    if (!(await exists(abs))) throw notFound('File content missing');

    return reply
      .header('content-type', row.mime)
      .header('content-length', Number(row.size))
      .header('etag', `"${row.sha256}"`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(createReadStream(abs));
  });
}
