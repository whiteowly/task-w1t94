import { and, asc, count, desc, eq } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import { conflict, notFound } from '../../platform/errors/app-error';
import type { AppDatabase } from '../../platform/db/client';
import { orders, reconciliationRecords, reconciliationTransitions } from '../../platform/db/schema';

import type { ReconciliationState } from './reconciliation-types';

const nowEpoch = () => Math.floor(Date.now() / 1000);

const withSqliteTransaction = async <T>(database: AppDatabase, callback: () => Promise<T>): Promise<T> => {
  database.sqlite.prepare('BEGIN IMMEDIATE').run();
  try {
    const result = await callback();
    database.sqlite.prepare('COMMIT').run();
    return result;
  } catch (error) {
    database.sqlite.prepare('ROLLBACK').run();
    throw error;
  }
};

const nextStateMap: Record<ReconciliationState, ReconciliationState | null> = {
  pending: 'reviewed',
  reviewed: 'exported',
  exported: 'archived',
  archived: null
};

const getRecordOrThrow = async (database: AppDatabase, id: number) => {
  const rows = await database.db.select().from(reconciliationRecords).where(eq(reconciliationRecords.id, id)).limit(1);
  const record = rows[0];
  if (!record) {
    throw notFound('Reconciliation record not found');
  }
  return record;
};

const ensureOrderExists = async (database: AppDatabase, orderId: number): Promise<void> => {
  const rows = await database.db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!rows[0]) {
    throw notFound('Order not found');
  }
};

const ensureNoExistingRecordForOrder = async (database: AppDatabase, orderId: number): Promise<void> => {
  const rows = await database.db
    .select({ id: reconciliationRecords.id })
    .from(reconciliationRecords)
    .where(eq(reconciliationRecords.orderId, orderId))
    .limit(1);

  if (rows[0]) {
    throw conflict('Reconciliation record already exists for order', { orderId, reconciliationRecordId: rows[0].id });
  }
};

export const createReconciliationRecord = async (
  database: AppDatabase,
  payload: { orderId?: number; transitionNote?: string },
  actor: { userId: number; correlationId: string }
) => {
  return withSqliteTransaction(database, async () => {
    if (payload.orderId !== undefined) {
      await ensureOrderExists(database, payload.orderId);
      await ensureNoExistingRecordForOrder(database, payload.orderId);
    }

    const now = nowEpoch();

    const [created] = await database.db
      .insert(reconciliationRecords)
      .values({
        orderId: payload.orderId ?? null,
        state: 'pending',
        createdAt: now,
        updatedAt: now
      })
      .returning();

    const [initialTransition] = await database.db
      .insert(reconciliationTransitions)
      .values({
        recordId: created.id,
        fromState: 'none',
        toState: 'pending',
        transitionedAt: now,
        transitionedByUserId: actor.userId,
        transitionNote: payload.transitionNote ?? null
      })
      .returning();

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'reconciliation.record.created',
      entityType: 'reconciliation_record',
      entityId: String(created.id),
      before: null,
      after: {
        state: created.state,
        orderId: created.orderId,
        transitionId: initialTransition.id
      },
      correlationId: actor.correlationId
    });

    return {
      record: created,
      initialTransition
    };
  });
};

export const listReconciliationRecords = async (
  database: AppDatabase,
  query: {
    page: number;
    pageSize: number;
    state?: ReconciliationState;
    orderId?: number;
  }
) => {
  const filter = and(
    query.state ? eq(reconciliationRecords.state, query.state) : undefined,
    query.orderId ? eq(reconciliationRecords.orderId, query.orderId) : undefined
  );

  const [totalRow] = await database.db.select({ total: count() }).from(reconciliationRecords).where(filter);
  const rows = await database.db
    .select()
    .from(reconciliationRecords)
    .where(filter)
    .orderBy(desc(reconciliationRecords.updatedAt), desc(reconciliationRecords.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows,
    total: totalRow.total
  };
};

export const getReconciliationRecord = async (database: AppDatabase, id: number) => getRecordOrThrow(database, id);

export const getReconciliationRecordWithTransitions = async (database: AppDatabase, id: number) => {
  const record = await getRecordOrThrow(database, id);
  const transitions = await database.db
    .select()
    .from(reconciliationTransitions)
    .where(eq(reconciliationTransitions.recordId, id))
    .orderBy(asc(reconciliationTransitions.transitionedAt), asc(reconciliationTransitions.id));

  return {
    record,
    transitions
  };
};

export const transitionReconciliationRecord = async (
  database: AppDatabase,
  input: {
    recordId: number;
    toState: ReconciliationState;
    transitionNote?: string;
  },
  actor: { userId: number; correlationId: string }
) =>
  withSqliteTransaction(database, async () => {
    const existing = await getRecordOrThrow(database, input.recordId);
    const expectedNext = nextStateMap[existing.state as ReconciliationState];

    if (!expectedNext) {
      throw conflict('Reconciliation record is already archived', {
        currentState: existing.state,
        requestedState: input.toState
      });
    }

    if (input.toState !== expectedNext) {
      throw conflict('Invalid reconciliation transition', {
        currentState: existing.state,
        requestedState: input.toState,
        expectedNextState: expectedNext
      });
    }

    const now = nowEpoch();

    const [updated] = await database.db
      .update(reconciliationRecords)
      .set({
        state: input.toState,
        updatedAt: now
      })
      .where(eq(reconciliationRecords.id, input.recordId))
      .returning();

    const [transition] = await database.db
      .insert(reconciliationTransitions)
      .values({
        recordId: input.recordId,
        fromState: existing.state,
        toState: input.toState,
        transitionedAt: now,
        transitionedByUserId: actor.userId,
        transitionNote: input.transitionNote ?? null
      })
      .returning();

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'reconciliation.record.transitioned',
      entityType: 'reconciliation_record',
      entityId: String(existing.id),
      before: {
        state: existing.state
      },
      after: {
        state: updated.state,
        transitionId: transition.id
      },
      correlationId: actor.correlationId,
      metadata: {
        transition: {
          fromState: transition.fromState,
          toState: transition.toState,
          transitionedByUserId: transition.transitionedByUserId,
          transitionedAt: transition.transitionedAt
        }
      }
    });

    return {
      record: updated,
      transition
    };
  });
