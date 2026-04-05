import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  compensateChargingSession,
  endChargingSession,
  getChargingSession,
  listChargingSessions,
  markChargingException,
  startChargingSession
} from '../../modules/charging/charging-service';
import {
  compensateSessionSchema,
  endSessionSchema,
  exceptionSessionSchema,
  formatKwhFromThousandths,
  idParamSchema,
  listSessionsQuerySchema,
  parseKwhToThousandths,
  startSessionSchema
} from '../../modules/charging/charging-types';
import { permissions } from '../../platform/auth/permissions';
import { validationFailed } from '../../platform/errors/app-error';

const parseOrFail = <S extends z.ZodTypeAny>(schema: S, payload: unknown, message: string): z.infer<S> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw validationFailed(message, parsed.error.flatten());
  }
  return parsed.data;
};

const serializeChargingSession = (row: {
  id: number;
  customerId: string;
  chargerAssetId: string;
  status: string;
  meteredKwhThousandths: number;
  startedAt: number;
  endedAt: number | null;
  exceptionReason: string | null;
  compensationNote: string | null;
  compensatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: row.id,
  customerId: row.customerId,
  chargerAssetId: row.chargerAssetId,
  status: row.status,
  meteredKwh: formatKwhFromThousandths(row.meteredKwhThousandths),
  meteredKwhThousandths: row.meteredKwhThousandths,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  exceptionReason: row.exceptionReason,
  compensationNote: row.compensationNote,
  compensatedAt: row.compensatedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export const registerChargingRoutes = async (fastify: FastifyInstance) => {
  // Operational model for this slice:
  // - mutations: administrator, operations manager, sales associate (charging.manage)
  // - reads: any authenticated staff role

  fastify.post('/v1/charging/sessions/start', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.charging.manage)] }, async (request, reply) => {
    const payload = parseOrFail(startSessionSchema, request.body, 'Invalid charging start payload');
    const created = await startChargingSession(
      fastify.appDb,
      {
        customerId: payload.customerId,
        chargerAssetId: payload.chargerAssetId,
        startedAt: payload.startedAt,
        initialMeteredKwhThousandths: parseKwhToThousandths(payload.initialMeteredKwh)
      },
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.code(201).send({ chargingSession: serializeChargingSession(created), correlationId: request.id });
  });

  fastify.post('/v1/charging/sessions/:id/end', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.charging.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid charging session id');
    const payload = parseOrFail(endSessionSchema, request.body, 'Invalid charging end payload');

    const updated = await endChargingSession(
      fastify.appDb,
      params.id,
      {
        meteredKwhThousandths: parseKwhToThousandths(payload.meteredKwh),
        endedAt: payload.endedAt
      },
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.send({ chargingSession: serializeChargingSession(updated), correlationId: request.id });
  });

  fastify.post('/v1/charging/sessions/:id/exception', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.charging.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid charging session id');
    const payload = parseOrFail(exceptionSessionSchema, request.body, 'Invalid charging exception payload');

    const updated = await markChargingException(fastify.appDb, params.id, payload.reason, {
      userId: request.auth!.userId,
      correlationId: request.id
    });

    return reply.send({ chargingSession: serializeChargingSession(updated), correlationId: request.id });
  });

  fastify.post('/v1/charging/sessions/:id/compensate', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.charging.manage)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid charging session id');
    const payload = parseOrFail(compensateSessionSchema, request.body, 'Invalid charging compensation payload');

    const updated = await compensateChargingSession(fastify.appDb, params.id, payload.note, {
      userId: request.auth!.userId,
      correlationId: request.id
    });

    return reply.send({ chargingSession: serializeChargingSession(updated), correlationId: request.id });
  });

  fastify.get('/v1/charging/sessions/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid charging session id');
    const found = await getChargingSession(fastify.appDb, params.id);
    return reply.send({ chargingSession: serializeChargingSession(found), correlationId: request.id });
  });

  fastify.get('/v1/charging/sessions', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const query = parseOrFail(listSessionsQuerySchema, request.query, 'Invalid charging sessions query');
    const listed = await listChargingSessions(fastify.appDb, query);
    return reply.send({
      items: listed.rows.map(serializeChargingSession),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });
};
