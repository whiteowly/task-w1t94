import { z } from 'zod';

export const auditLogIdParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const auditLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().min(1).max(120).optional(),
  entityType: z.string().min(1).max(120).optional(),
  entityId: z.string().min(1).max(120).optional(),
  actorUserId: z.coerce.number().int().positive().optional(),
  correlationId: z.string().min(1).max(120).optional(),
  occurredFrom: z.coerce.number().int().positive().optional(),
  occurredTo: z.coerce.number().int().positive().optional()
});
