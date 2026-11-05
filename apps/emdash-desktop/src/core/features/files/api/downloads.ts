import { resourceUriSchema } from '@emdash/core/primitives/path/api';
import { defineContract, liveJob, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const downloadConflictSchema = z.enum(['keep-both', 'skip', 'replace']);
export const downloadProgressSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  size: z.number(),
  files: z.number(),
  transferred: z.number(),
  skipped: z.number(),
  warnings: z.array(z.string()),
});
export const downloadsContract = defineContract({
  prepare: procedure({
    input: z.object({
      sources: z.array(resourceUriSchema).min(1).max(1000),
      conflict: downloadConflictSchema,
    }),
    output: z.object({ id: z.string(), destination: z.string() }).nullable(),
  }),
  run: liveJob({
    input: z.object({ id: z.string() }),
    progress: downloadProgressSchema,
    result: downloadProgressSchema,
    error: z.object({ message: z.string() }),
  }),
  discard: procedure({ input: z.object({ id: z.string() }), output: z.void() }),
});
export type DownloadConflict = z.infer<typeof downloadConflictSchema>;
export type DownloadProgress = z.infer<typeof downloadProgressSchema>;
