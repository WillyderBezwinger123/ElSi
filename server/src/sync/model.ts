import { z } from 'zod';
import { UUID_RE } from '../ids.js';
import { isHlc } from './hlc.js';

const id = z.string().regex(UUID_RE, 'invalid id');
/** Loose reference to another row (parent, conflict original); not policy-relevant. */
const ref = z.string().min(1).max(100);
const hlc = z.string().max(200).refine(isHlc, 'invalid hlc (expected <15 digits>-<5 digits>-<deviceId>)');

/** Block content arrives as a JSON object; a JSON-encoded string of an object is accepted too. */
const content = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.record(z.string(), z.unknown()));

export const pageData = z.object({
  id,
  workspaceId: id,
  parentId: ref.nullable().default(null),
  title: z.string().max(2000).default(''),
  icon: z.string().max(200).nullable().default(null),
  position: z.string().max(200).default(''),
  tags: z.array(z.string().max(200)).max(200).default([]),
  aiVisible: z.boolean().default(true),
  hlc,
  deleted: z.boolean().default(false),
});

export const blockData = z.object({
  id,
  pageId: id,
  parentId: ref.nullable().default(null),
  position: z.string().max(200).default(''),
  type: z.string().min(1).max(100),
  content: content.default({}),
  hlc,
  deleted: z.boolean().default(false),
  conflictOf: ref.nullable().default(null),
});

const baseHlc = z.string().max(200).nullable().default(null);

export const syncOp = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('page'), id, baseHlc, data: pageData }),
  z.object({ entity: z.literal('block'), id, baseHlc, data: blockData }),
]);

export const pushBody = z.object({
  deviceId: z.string().min(1).max(200),
  ops: z.array(syncOp).max(1000),
});

export const pullQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).default(500).transform((n) => Math.min(n, 1000)),
});

export type PageData = z.output<typeof pageData>;
export type BlockData = z.output<typeof blockData>;
export type SyncOp = z.output<typeof syncOp>;

export interface PageRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  position: string;
  tags: string[];
  ai_visible: boolean;
  hlc: string;
  deleted: boolean;
}

export interface BlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  position: string;
  type: string;
  content: Record<string, unknown>;
  hlc: string;
  deleted: boolean;
  conflict_of: string | null;
}

export function pageToApi(r: PageRow): PageData {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    parentId: r.parent_id,
    title: r.title,
    icon: r.icon,
    position: r.position,
    tags: r.tags,
    aiVisible: r.ai_visible,
    hlc: r.hlc,
    deleted: r.deleted,
  };
}

export function blockToApi(r: BlockRow): BlockData {
  return {
    id: r.id,
    pageId: r.page_id,
    parentId: r.parent_id,
    position: r.position,
    type: r.type,
    content: r.content,
    hlc: r.hlc,
    deleted: r.deleted,
    conflictOf: r.conflict_of,
  };
}
