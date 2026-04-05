import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  cancelOrder,
  createDraftOrder,
  createPromotion,
  createVoucher,
  finalizeOrder,
  getOrderDetail,
  getPromotion,
  getVoucher,
  listPromotions,
  listVouchers,
  quoteOrder,
  recordOrderPayment,
  updatePromotion,
  updateVoucher
} from '../../modules/commerce/commerce-service';
import {
  finalizeOrderSchema,
  idParamSchema,
  listPromotionQuerySchema,
  listVoucherQuerySchema,
  orderCreateSchema,
  paymentCreateSchema,
  pricingQuoteSchema,
  promotionCreateSchema,
  promotionUpdateSchema,
  voucherCreateSchema,
  voucherUpdateSchema
} from '../../modules/commerce/commerce-types';
import { permissions } from '../../platform/auth/permissions';
import { validationFailed } from '../../platform/errors/app-error';

const parseOrFail = <S extends z.ZodTypeAny>(schema: S, payload: unknown, message: string): z.infer<S> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw validationFailed(message, parsed.error.flatten());
  }
  return parsed.data;
};

const parseIdempotencyHeader = (headers: Record<string, unknown>): string => {
  const value = headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationFailed('Missing Idempotency-Key header');
  }
  return value.trim();
};

const serializePromotion = (row: {
  id: number;
  name: string;
  type: string;
  priority: number;
  stackability: string;
  maxRedemptionsPerUser: number;
  validFromLocal: string;
  validToLocal: string;
  applicabilitySelectorsJson: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}) => {
  const parsed = JSON.parse(row.applicabilitySelectorsJson) as {
    selectors?: Record<string, unknown>;
    rule?: Record<string, unknown>;
  };
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    priority: row.priority,
    stackability: row.stackability,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    validFromLocal: row.validFromLocal,
    validToLocal: row.validToLocal,
    applicabilitySelectors: parsed.selectors ?? parsed,
    rule: parsed.rule ?? {},
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
};

export const registerCommerceRoutes = async (fastify: FastifyInstance) => {
  // Promotions (admin-only)
  fastify.post('/v1/promotions', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const payload = parseOrFail(promotionCreateSchema, request.body, 'Invalid promotion payload');
    const created = await createPromotion(
      fastify.appDb,
      { facilityTimezone: fastify.appConfig.facilityTimezone },
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.code(201).send({ promotion: serializePromotion(created), correlationId: request.id });
  });

  fastify.patch('/v1/promotions/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid promotion id');
    const payload = parseOrFail(promotionUpdateSchema, request.body, 'Invalid promotion update payload');
    const updated = await updatePromotion(
      fastify.appDb,
      { facilityTimezone: fastify.appConfig.facilityTimezone },
      params.id,
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.send({ promotion: serializePromotion(updated), correlationId: request.id });
  });

  fastify.get('/v1/promotions/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid promotion id');
    const promotion = await getPromotion(fastify.appDb, params.id);
    return reply.send({ promotion: serializePromotion(promotion), correlationId: request.id });
  });

  fastify.get('/v1/promotions', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const query = parseOrFail(listPromotionQuerySchema, request.query, 'Invalid promotions query');
    const listed = await listPromotions(fastify.appDb, query);
    return reply.send({
      items: listed.rows.map(serializePromotion),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  // Vouchers (admin-only)
  fastify.post('/v1/vouchers', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const payload = parseOrFail(voucherCreateSchema, request.body, 'Invalid voucher payload');
    const created = await createVoucher(
      fastify.appDb,
      { facilityTimezone: fastify.appConfig.facilityTimezone },
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );
    return reply.code(201).send({ voucher: created, correlationId: request.id });
  });

  fastify.patch('/v1/vouchers/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid voucher id');
    const payload = parseOrFail(voucherUpdateSchema, request.body, 'Invalid voucher update payload');
    const updated = await updateVoucher(
      fastify.appDb,
      { facilityTimezone: fastify.appConfig.facilityTimezone },
      params.id,
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );
    return reply.send({ voucher: updated, correlationId: request.id });
  });

  fastify.get('/v1/vouchers/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid voucher id');
    const voucher = await getVoucher(fastify.appDb, params.id);
    return reply.send({ voucher, correlationId: request.id });
  });

  fastify.get('/v1/vouchers', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.promotions.manage)] }, async (request, reply) => {
    const query = parseOrFail(listVoucherQuerySchema, request.query, 'Invalid vouchers query');
    const listed = await listVouchers(fastify.appDb, query);
    return reply.send({
      items: listed.rows,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  // Sales checkout flows
  fastify.post('/v1/orders/quote', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const payload = parseOrFail(pricingQuoteSchema, request.body, 'Invalid quote payload');
    if (payload.voucherCode) {
      await fastify.requirePermission(permissions.sales.applyVouchers)(request);
    }

    const quote = await quoteOrder(fastify.appDb, payload);
    return reply.send({ quote, correlationId: request.id });
  });

  fastify.post('/v1/orders', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const payload = parseOrFail(orderCreateSchema, request.body, 'Invalid order payload');
    if (payload.voucherCode) {
      await fastify.requirePermission(permissions.sales.applyVouchers)(request);
    }

    const idempotencyKey = parseIdempotencyHeader(request.headers as Record<string, unknown>);
    const created = await createDraftOrder(
      fastify.appDb,
      idempotencyKey,
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.code(201).send({
      order: created.order,
      lineItems: created.lines,
      pricing: created.pricing,
      correlationId: request.id
    });
  });

  fastify.get('/v1/orders/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid order id');
    const detail = await getOrderDetail(fastify.appDb, params.id, {
      userId: request.auth!.userId,
      role: request.auth!.role
    });
    return reply.send({ ...detail, correlationId: request.id });
  });

  fastify.post('/v1/orders/:id/finalize', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid order id');
    const payload = parseOrFail(finalizeOrderSchema, request.body ?? {}, 'Invalid finalize payload');
    if (payload.voucherCode) {
      await fastify.requirePermission(permissions.sales.applyVouchers)(request);
    }

    const idempotencyKey = parseIdempotencyHeader(request.headers as Record<string, unknown>);
    const finalized = await finalizeOrder(
      fastify.appDb,
      idempotencyKey,
      params.id,
      payload.voucherCode,
      { userId: request.auth!.userId, role: request.auth!.role, correlationId: request.id }
    );
    return reply.send({
      order: finalized.order,
      pricing: finalized.pricing,
      correlationId: request.id
    });
  });

  fastify.post('/v1/orders/:id/cancel', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid order id');
    const canceled = await cancelOrder(fastify.appDb, params.id, {
      userId: request.auth!.userId,
      role: request.auth!.role,
      correlationId: request.id
    });
    return reply.send({ order: canceled, correlationId: request.id });
  });

  fastify.post('/v1/orders/:id/payments', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.sales.createOrders)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid order id');
    const payload = parseOrFail(paymentCreateSchema, request.body, 'Invalid payment payload');
    const payment = await recordOrderPayment(
      fastify.appDb,
      { encryptionKey: fastify.appConfig.encryptionKey },
      params.id,
      payload,
      { userId: request.auth!.userId, role: request.auth!.role, correlationId: request.id }
    );
    return reply.code(201).send({ payment, correlationId: request.id });
  });
};
