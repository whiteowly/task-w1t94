import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25)
});

export const correlationIdHeaderSchema = z.object({
  'x-correlation-id': z.string().min(1).max(128).optional()
});
