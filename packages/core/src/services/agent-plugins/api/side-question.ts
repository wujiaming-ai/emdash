import { z } from 'zod';

/** 旁支控制与主 turn 的发送、排队和停止完全分离。 */
export const sideQuestionSchema = z
  .object({
    sideId: z.string().uuid(),
    action: z.enum(['ask', 'cancel', 'close']),
    question: z.string().trim().min(1).max(32_000).optional(),
    quote: z.string().max(16_000).optional(),
  })
  .refine((value) => value.action !== 'ask' || value.question !== undefined, {
    message: 'A side question is required',
  });
export type SideQuestionInput = z.infer<typeof sideQuestionSchema>;
export type SideQuestionResult = { text: string };
