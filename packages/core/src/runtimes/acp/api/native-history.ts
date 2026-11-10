import { z } from 'zod';

export const nativeHistoryProviderSchema = z.enum(['codex', 'claude']);
export const nativeHistoryInputSchema = z.object({
  providerId: nativeHistoryProviderSchema,
  cursor: z.string().max(4096).nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export const nativeSessionSchema = z.object({
  selectionId: z.string().uuid(),
  providerId: nativeHistoryProviderSchema,
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string(),
  updatedAt: z.string().nullable(),
});
export const nativeHistoryPageSchema = z.object({
  sessions: z.array(nativeSessionSchema),
  nextCursor: z.string().nullable(),
});
export type NativeSession = z.infer<typeof nativeSessionSchema>;
export type NativeHistoryInput = z.infer<typeof nativeHistoryInputSchema>;
