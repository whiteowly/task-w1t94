import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  createReconciliationRecord,
  getReconciliationRecordWithTransitions,
  listReconciliationRecords,
  transitionReconciliationRecord
} from '../../modules/reconciliation/reconciliation-service';
import {
  reconciliationCreateSchema,
  reconciliationIdParamSchema,
  reconciliationListQuerySchema,
  reconciliationTransitionSchema
} from '../../modules/reconciliation/reconciliation-types';
import { forbidden, unauthorized, validationFailed } from '../../platform/errors/app-error';
import { permissions, roleHasPermission } from '../../platform/auth/permissions';

const parseOrFail = <S extends z.ZodTypeAny>(schema: S, payload: unknown, message: string): z.infer<S> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw validationFailed(message, parsed.error.flatten());
  }

  return parsed.data;
};

const requireReconciliationReadPermission = async (request: FastifyRequest): Promise<void> => {
  if (!request.auth) {
    throw unauthorized();
  }

  const allowed =
    roleHasPermission(request.auth.role, permissions.reconciliation.manage) ||
    roleHasPermission(request.auth.role, permissions.audit.readReconciliationExports);

  if (!allowed) {
    throw forbidden();
  }
};

const serializeRecord = (row: {
  id: number;
  orderId: number | null;
  state: string;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: row.id,
  orderId: row.orderId,
  state: row.state,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const serializeTransition = (row: {
  id: number;
  recordId: number;
  fromState: string;
  toState: string;
  transitionedAt: number;
  transitionedByUserId: number | null;
  transitionNote: string | null;
}) => ({
  id: row.id,
  recordId: row.recordId,
  fromState: row.fromState,
  toState: row.toState,
  transitionedAt: row.transitionedAt,
  transitionedByUserId: row.transitionedByUserId,
  transitionNote: row.transitionNote
});

export const registerReconciliationRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/v1/reconciliation/records', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.reconciliation.manage)] }, async (request, reply) => {
    const payload = parseOrFail(reconciliationCreateSchema, request.body ?? {}, 'Invalid reconciliation record payload');

    const created = await createReconciliationRecord(
      fastify.appDb,
      {
        orderId: payload.orderId,
        transitionNote: payload.transitionNote
      },
      {
        userId: request.auth!.userId,
        correlationId: request.id
      }
    );

    return reply.code(201).send({
      record: serializeRecord(created.record),
      transition: serializeTransition(created.initialTransition),
      correlationId: request.id
    });
  });

  fastify.get('/v1/reconciliation/records', { preHandler: [fastify.authenticate, requireReconciliationReadPermission] }, async (request, reply) => {
    const query = parseOrFail(reconciliationListQuerySchema, request.query, 'Invalid reconciliation list query');
    const listed = await listReconciliationRecords(fastify.appDb, query);

    return reply.send({
      items: listed.rows.map(serializeRecord),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  fastify.get('/v1/reconciliation/records/:id', { preHandler: [fastify.authenticate, requireReconciliationReadPermission] }, async (request, reply) => {
    const params = parseOrFail(reconciliationIdParamSchema, request.params, 'Invalid reconciliation record id');
    const detail = await getReconciliationRecordWithTransitions(fastify.appDb, params.id);

    return reply.send({
      record: serializeRecord(detail.record),
      transitions: detail.transitions.map(serializeTransition),
      correlationId: request.id
    });
  });

  fastify.post('/v1/reconciliation/records/:id/transitions', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.reconciliation.manage)] }, async (request, reply) => {
    const params = parseOrFail(reconciliationIdParamSchema, request.params, 'Invalid reconciliation record id');
    const payload = parseOrFail(reconciliationTransitionSchema, request.body, 'Invalid reconciliation transition payload');

    const transitioned = await transitionReconciliationRecord(
      fastify.appDb,
      {
        recordId: params.id,
        toState: payload.toState,
        transitionNote: payload.transitionNote
      },
      {
        userId: request.auth!.userId,
        correlationId: request.id
      }
    );

    return reply.send({
      record: serializeRecord(transitioned.record),
      transition: serializeTransition(transitioned.transition),
      correlationId: request.id
    });
  });
};
