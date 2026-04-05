import { z } from 'zod';

const kwhStringSchema = z
  .string()
  .regex(/^\d+(?:\.\d{1,3})?$/, 'meteredKwh must be a non-negative decimal with up to 3 fractional digits');

export const startSessionSchema = z.object({
  customerId: z.string().min(1).max(120),
  chargerAssetId: z.string().min(1).max(120),
  startedAt: z.number().int().positive().optional(),
  initialMeteredKwh: kwhStringSchema.optional().default('0.000')
});

export const endSessionSchema = z.object({
  meteredKwh: kwhStringSchema,
  endedAt: z.number().int().positive().optional()
});

export const exceptionSessionSchema = z.object({
  reason: z.string().min(1).max(500)
});

export const compensateSessionSchema = z.object({
  note: z.string().min(1).max(500)
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const listSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['started', 'ended', 'exception', 'compensated']).optional(),
  customerId: z.string().optional(),
  chargerAssetId: z.string().optional()
});

export const parseKwhToThousandths = (value: string): number => {
  const [wholePart, fractionalPart = ''] = value.split('.');
  const whole = Number(wholePart);
  const frac = Number(fractionalPart.padEnd(3, '0'));
  return whole * 1000 + frac;
};

export const formatKwhFromThousandths = (value: number): string => {
  const whole = Math.floor(value / 1000);
  const frac = Math.abs(value % 1000)
    .toString()
    .padStart(3, '0');
  return `${whole}.${frac}`;
};
