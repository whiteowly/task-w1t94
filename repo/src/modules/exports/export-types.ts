import { z } from 'zod';

export const exportIdParamSchema = z.object({
  id: z.string().uuid()
});

export const exportListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  jobType: z.enum(['analytics', 'reconciliation']).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
  scheduledForLocal: z.string().min(1).max(20).optional()
});
