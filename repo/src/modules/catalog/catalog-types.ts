import { z } from 'zod';

const scalarFacetValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const facetRecordSchema = z.record(
  z.string().min(1),
  z.union([scalarFacetValueSchema, z.array(scalarFacetValueSchema).min(1)])
);

export const productMutationSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  category: z.string().min(1).max(120),
  attributes: facetRecordSchema.default({}),
  fitmentDimensions: facetRecordSchema.default({}),
  active: z.boolean().default(true)
});

export const productUpdateSchema = productMutationSchema.partial().refine((payload) => Object.keys(payload).length > 0, {
  message: 'At least one updatable field is required'
});

export const searchFiltersSchema = z
  .object({
    categories: z.array(z.string().min(1)).default([]),
    attributes: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
    fitmentDimensions: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).default({}),
    active: z.boolean().optional()
  })
  .default({});

export const searchRequestSchema = z.object({
  keyword: z.string().max(200).optional(),
  filters: searchFiltersSchema,
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sort: z
    .enum([
      'relevance',
      'name_asc',
      'name_desc',
      'sku_asc',
      'sku_desc',
      'updated_at_asc',
      'updated_at_desc'
    ])
    .default('relevance'),
  includeSuggestedTerms: z.boolean().default(false)
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;
