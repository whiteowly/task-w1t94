import { z } from 'zod';

export const promotionTypeSchema = z.enum([
  'spend_and_save',
  'percentage_discount',
  'amount_discount',
  'bundle',
  'member_pricing_tier',
  'voucher'
]);

export const promotionStackabilitySchema = z.enum(['exclusive', 'stackable']);

export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:mm:ss local datetime');

export const applicabilitySelectorsSchema = z.object({
  skus: z.array(z.string().min(1)).default([]),
  productCategories: z.array(z.string().min(1)).default([]),
  courseCategories: z.array(z.string().min(1)).default([]),
  classInstanceIds: z.array(z.number().int().positive()).default([]),
  lineTypes: z.array(z.string().min(1)).default([]),
  membershipTiers: z.array(z.string().min(1)).default([]),
  minOrderSpendMinor: z.number().int().min(0).optional(),
  voucherCodes: z.array(z.string().min(1)).default([]),
  applyToCharging: z.boolean().optional()
});

export const promotionRuleSchema = z.record(z.string(), z.unknown()).default({});

const promotionBaseSchema = z.object({
  name: z.string().min(1).max(200),
  type: promotionTypeSchema,
  priority: z.number().int().min(1).max(100),
  stackability: promotionStackabilitySchema,
  maxRedemptionsPerUser: z.number().int().min(1).default(1),
  validFromLocal: localDateTimeSchema,
  validToLocal: localDateTimeSchema,
  applicabilitySelectors: applicabilitySelectorsSchema,
  rule: promotionRuleSchema,
  active: z.boolean().default(true)
});

export const promotionCreateSchema = promotionBaseSchema.refine((payload) => payload.validToLocal > payload.validFromLocal, {
    message: 'validToLocal must be after validFromLocal',
    path: ['validToLocal']
  });

export const promotionUpdateSchema = promotionBaseSchema.partial().refine((payload) => Object.keys(payload).length > 0, {
  message: 'At least one field is required'
});

export const voucherCreateSchema = z
  .object({
    code: z.string().min(1).max(80),
    promotionId: z.number().int().positive().optional(),
    customerBinding: z.string().min(1).max(120).optional(),
    expirationLocal: localDateTimeSchema
  })
  .strict();

export const voucherUpdateSchema = z
  .object({
    promotionId: z.number().int().positive().nullable().optional(),
    customerBinding: z.string().min(1).max(120).nullable().optional(),
    expirationLocal: localDateTimeSchema.optional()
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field is required'
  });

export const lineItemInputSchema = z.object({
  lineType: z.string().min(1).max(60),
  sku: z.string().max(80).optional(),
  description: z.string().max(400).default(''),
  category: z.string().max(120).optional(),
  courseCategory: z.string().max(120).optional(),
  classInstanceId: z.number().int().positive().optional(),
  quantity: z.number().int().min(1).max(10000),
  unitPriceMinor: z.number().int().min(0)
});

export const pricingQuoteSchema = z.object({
  customerId: z.string().min(1).max(120).optional(),
  membershipTier: z.string().min(1).max(120).optional(),
  voucherCode: z.string().min(1).max(80).optional(),
  taxRateBasisPoints: z.number().int().min(0).max(10000).default(0),
  depositMinor: z.number().int().min(0).default(0),
  items: z.array(lineItemInputSchema).min(1)
});

export const orderCreateSchema = pricingQuoteSchema;

export const finalizeOrderSchema = z.object({
  voucherCode: z.string().min(1).max(80).optional()
});

export const paymentCreateSchema = z.object({
  method: z.enum(['cash', 'check', 'manual_card_entry']),
  amountMinor: z.number().int().min(1),
  referenceText: z.string().max(200).optional(),
  personalNote: z.string().max(2000).optional()
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const listPromotionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: promotionTypeSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
});

export const listVoucherQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  customerBinding: z.string().optional(),
  redeemed: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
});
