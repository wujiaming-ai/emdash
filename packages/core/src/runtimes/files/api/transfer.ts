import { defineContract, downloadFile, fallible } from '@emdash/wire/rpc';
import { z } from 'zod';
import { hostAbsolutePathSchema } from '#primitives/path/api';
import { fsErrorSchema } from './errors';

export const TRANSFER_BLOCK_BYTES = 4 * 1024 * 1024;
export const transferEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['file', 'directory', 'symlink', 'special']),
  size: z.number().int().nonnegative().safe(),
  mtimeMs: z.number(),
  mode: z.number().int(),
  version: z.string().min(1),
});
const key = z.object({ path: hostAbsolutePathSchema });
const versionKey = key.extend({ version: z.string().min(1) });
export const transferReadSchema = versionKey.extend({
  offset: z.number().int().nonnegative().safe(),
  length: z.number().int().positive().max(TRANSFER_BLOCK_BYTES),
});
export const fileTransferContract = defineContract({
  inspect: fallible({ input: key, data: transferEntrySchema, error: fsErrorSchema }),
  list: downloadFile({
    input: versionKey,
    meta: z.object({ name: z.string(), mimeType: z.literal('application/x-ndjson') }),
    error: fsErrorSchema,
  }),
  read: downloadFile({
    input: transferReadSchema,
    meta: z.object({
      name: z.string(),
      mimeType: z.literal('application/octet-stream'),
      size: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      version: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    error: fsErrorSchema,
  }),
});
export type TransferEntry = z.infer<typeof transferEntrySchema>;
export type TransferRead = z.infer<typeof transferReadSchema>;
