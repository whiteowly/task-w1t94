import { z } from 'zod';

export const reconciliationStateSchema = z.enum(['pending', 'reviewed', 'exported', 'archived']);

export const reconciliationTransitionTargetSchema = z.enum(['reviewed', 'exported', 'archived']);

export const reconciliationIdParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const reconciliationCreateSchema = z.object({
  orderId: z.coerce.number().int().positive().optional(),
  transitionNote: z.string().min(1).max(500).optional()
});

export const reconciliationTransitionSchema = z.object({
  toState: reconciliationTransitionTargetSchema,
  transitionNote: z.string().min(1).max(500).optional()
});

export const reconciliationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: reconciliationStateSchema.optional(),
  orderId: z.coerce.number().int().positive().optional()
});

export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;
