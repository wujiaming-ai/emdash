import { z } from 'zod';
import { attachmentMetadataSchema } from '#services/attachments/api';

export const transcriptMessageSchema = z.object({
  kind: z.literal('message'),
  /** Opaque reducer-owned identity, scoped to the turn, role, and identity origin. */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  /** Correlates an accepted prompt without matching message text. */
  promptId: z.string().optional(),
  text: z.string(),
  /** Attachment metadata only; bytes are served separately by the runtime. */
  attachments: z.array(attachmentMetadataSchema).optional(),
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

/** Durable provider notices do not carry a conversational role or tool status. */
export const activitySchema = z.object({
  id: z.string(),
  category: z.enum(['turn', 'tool', 'task', 'hook', 'retry', 'rate_limit', 'notice']),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  severity: z.enum(['info', 'warning', 'error']),
  turnId: z.string().optional(),
  background: z.boolean().optional(),
  startedAt: z.number().optional(),
});

export const transcriptNotificationSchema = z.object({
  kind: z.literal('notification'),
  id: z.string(),
  seq: z.number().int(),
  title: z.string(),
  text: z.string(),
  /** 原生事件只更新所属实体，旧通知保持原有展示。 */
  activity: activitySchema.optional(),
});
