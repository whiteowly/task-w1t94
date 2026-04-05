import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { permissions } from '../../platform/auth/permissions';
import { validationFailed } from '../../platform/errors/app-error';
import { products } from '../../platform/db/schema';
import { createProduct, getProductById, listProducts, setProductActiveState, updateProduct } from '../../modules/catalog/catalog-service';
import { productMutationSchema, productUpdateSchema, searchRequestSchema } from '../../modules/catalog/catalog-types';
import { searchProducts } from '../../modules/catalog/search-service';

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive()
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  category: z.string().optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
});

const serializeProduct = (product: typeof products.$inferSelect) => ({
  id: product.id,
  sku: product.sku,
  name: product.name,
  description: product.description,
  category: product.category,
  attributes: JSON.parse(product.attributesJson),
  fitmentDimensions: JSON.parse(product.fitmentJson),
  active: product.active,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt
});

export const registerCatalogRoutes = async (fastify: FastifyInstance) => {
  fastify.post(
    '/v1/catalog/products',
    {
      preHandler: [fastify.authenticate, fastify.requirePermission(permissions.catalog.manage)]
    },
    async (request, reply) => {
      const parsed = productMutationSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed('Invalid product payload', parsed.error.flatten());
      }

      const payload = parsed.data;
      const created = await createProduct(
        fastify.appDb,
        {
          sku: payload.sku,
          name: payload.name,
          description: payload.description,
          category: payload.category,
          attributes: payload.attributes,
          fitmentDimensions: payload.fitmentDimensions,
          active: payload.active
        },
        {
          userId: request.auth!.userId,
          correlationId: request.id
        }
      );

      return reply.code(201).send({
        product: serializeProduct(created),
        correlationId: request.id
      });
    }
  );

  fastify.patch(
    '/v1/catalog/products/:id',
    {
      preHandler: [fastify.authenticate, fastify.requirePermission(permissions.catalog.manage)]
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw validationFailed('Invalid product id', parsedParams.error.flatten());
      }
      const params = parsedParams.data;

      const parsedPayload = productUpdateSchema.safeParse(request.body);
      if (!parsedPayload.success) {
        throw validationFailed('Invalid product update payload', parsedPayload.error.flatten());
      }
      const payload = parsedPayload.data;

      const updated = await updateProduct(
        fastify.appDb,
        params.id,
        payload,
        {
          userId: request.auth!.userId,
          correlationId: request.id
        }
      );

      return reply.send({
        product: serializeProduct(updated),
        correlationId: request.id
      });
    }
  );

  fastify.post(
    '/v1/catalog/products/:id/activate',
    {
      preHandler: [fastify.authenticate, fastify.requirePermission(permissions.catalog.manage)]
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw validationFailed('Invalid product id', parsedParams.error.flatten());
      }
      const params = parsedParams.data;
      const updated = await setProductActiveState(
        fastify.appDb,
        params.id,
        true,
        {
          userId: request.auth!.userId,
          correlationId: request.id
        }
      );
      return reply.send({ product: serializeProduct(updated), correlationId: request.id });
    }
  );

  fastify.post(
    '/v1/catalog/products/:id/deactivate',
    {
      preHandler: [fastify.authenticate, fastify.requirePermission(permissions.catalog.manage)]
    },
    async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        throw validationFailed('Invalid product id', parsedParams.error.flatten());
      }
      const params = parsedParams.data;
      const updated = await setProductActiveState(
        fastify.appDb,
        params.id,
        false,
        {
          userId: request.auth!.userId,
          correlationId: request.id
        }
      );
      return reply.send({ product: serializeProduct(updated), correlationId: request.id });
    }
  );

  fastify.get('/v1/catalog/products/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsedParams = idParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      throw validationFailed('Invalid product id', parsedParams.error.flatten());
    }
    const params = parsedParams.data;
    const product = await getProductById(fastify.appDb, params.id);

    return reply.send({
      product: serializeProduct(product),
      correlationId: request.id
    });
  });

  fastify.get('/v1/catalog/products', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      throw validationFailed('Invalid product list query', parsedQuery.error.flatten());
    }
    const query = parsedQuery.data;

    const result = await listProducts(fastify.appDb, {
      page: query.page,
      pageSize: query.pageSize,
      category: query.category,
      active: query.active
    });

    return reply.send({
      items: result.rows.map(serializeProduct),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / query.pageSize),
        appliedFilters: {
          category: query.category,
          active: query.active
        }
      },
      correlationId: request.id
    });
  });

  fastify.post('/v1/search/products', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parsedPayload = searchRequestSchema.safeParse(request.body);
    if (!parsedPayload.success) {
      throw validationFailed('Invalid search payload', parsedPayload.error.flatten());
    }
    const payload = parsedPayload.data;

    const result = searchProducts(fastify.appDb, payload);

    return reply.send({
      ...result,
      correlationId: request.id
    });
  });
};
