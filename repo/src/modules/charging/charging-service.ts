import { and, count, desc, eq } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import { conflict, notFound } from '../../platform/errors/app-error';
import type { AppDatabase } from '../../platform/db/client';
import { chargingSessions } from '../../platform/db/schema';

const nowEpoch = () => Math.floor(Date.now() / 1000);

const getSessionOrThrow = async (database: AppDatabase, id: number) => {
  const rows = await database.db.select().from(chargingSessions).where(eq(chargingSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw notFound('Charging session not found');
  }
  return row;
};

export const startChargingSession = async (
  database: AppDatabase,
  payload: {
    customerId: string;
    chargerAssetId: string;
    startedAt?: number;
    initialMeteredKwhThousandths: number;
  },
  actor: { userId: number; correlationId: string }
) => {
  const now = nowEpoch();
  const [created] = await database.db
    .insert(chargingSessions)
    .values({
      customerId: payload.customerId,
      chargerAssetId: payload.chargerAssetId,
      status: 'started',
      meteredKwhThousandths: payload.initialMeteredKwhThousandths,
      startedAt: payload.startedAt ?? now,
      endedAt: null,
      exceptionReason: null,
      compensationNote: null,
      compensatedAt: null,
      createdAt: now,
      updatedAt: now
    })
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'charging.session.started',
    entityType: 'charging_session',
    entityId: String(created.id),
    before: null,
    after: { status: created.status, customerId: created.customerId, chargerAssetId: created.chargerAssetId },
    correlationId: actor.correlationId
  });

  return created;
};

export const endChargingSession = async (
  database: AppDatabase,
  id: number,
  payload: { meteredKwhThousandths: number; endedAt?: number },
  actor: { userId: number; correlationId: string }
) => {
  const existing = await getSessionOrThrow(database, id);
  if (existing.status !== 'started') {
    throw conflict('Only started sessions can be ended', { status: existing.status });
  }

  const resolvedEndedAt = payload.endedAt ?? nowEpoch();
  if (resolvedEndedAt < existing.startedAt) {
    throw conflict('Charging session cannot end before it starts', {
      startedAt: existing.startedAt,
      endedAt: resolvedEndedAt
    });
  }

  if (payload.meteredKwhThousandths < existing.meteredKwhThousandths) {
    throw conflict('Metered kWh cannot decrease', {
      previous: existing.meteredKwhThousandths,
      next: payload.meteredKwhThousandths
    });
  }

  const [updated] = await database.db
    .update(chargingSessions)
    .set({
      status: 'ended',
      meteredKwhThousandths: payload.meteredKwhThousandths,
      endedAt: resolvedEndedAt,
      updatedAt: nowEpoch()
    })
    .where(eq(chargingSessions.id, id))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'charging.session.ended',
    entityType: 'charging_session',
    entityId: String(id),
    before: { status: existing.status, meteredKwhThousandths: existing.meteredKwhThousandths },
    after: { status: updated.status, meteredKwhThousandths: updated.meteredKwhThousandths },
    correlationId: actor.correlationId
  });

  return updated;
};

export const markChargingException = async (
  database: AppDatabase,
  id: number,
  reason: string,
  actor: { userId: number; correlationId: string }
) => {
  const existing = await getSessionOrThrow(database, id);
  if (existing.status !== 'started') {
    throw conflict('Only started sessions can be marked exception', { status: existing.status });
  }

  const [updated] = await database.db
    .update(chargingSessions)
    .set({
      status: 'exception',
      exceptionReason: reason,
      endedAt: nowEpoch(),
      updatedAt: nowEpoch()
    })
    .where(eq(chargingSessions.id, id))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'charging.session.exception',
    entityType: 'charging_session',
    entityId: String(id),
    before: { status: existing.status, exceptionReason: existing.exceptionReason },
    after: { status: updated.status, exceptionReason: updated.exceptionReason },
    correlationId: actor.correlationId
  });

  return updated;
};

export const compensateChargingSession = async (
  database: AppDatabase,
  id: number,
  note: string,
  actor: { userId: number; correlationId: string }
) => {
  const existing = await getSessionOrThrow(database, id);
  if (existing.status !== 'exception') {
    throw conflict('Only exception sessions can be compensated', { status: existing.status });
  }

  const [updated] = await database.db
    .update(chargingSessions)
    .set({
      status: 'compensated',
      compensationNote: note,
      compensatedAt: nowEpoch(),
      updatedAt: nowEpoch()
    })
    .where(eq(chargingSessions.id, id))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'charging.session.compensated',
    entityType: 'charging_session',
    entityId: String(id),
    before: { status: existing.status, compensationNote: existing.compensationNote },
    after: { status: updated.status, compensationNote: updated.compensationNote },
    correlationId: actor.correlationId
  });

  return updated;
};

export const getChargingSession = async (database: AppDatabase, id: number) => getSessionOrThrow(database, id);

export const listChargingSessions = async (
  database: AppDatabase,
  query: {
    page: number;
    pageSize: number;
    status?: 'started' | 'ended' | 'exception' | 'compensated';
    customerId?: string;
    chargerAssetId?: string;
  }
) => {
  const filter = and(
    query.status ? eq(chargingSessions.status, query.status) : undefined,
    query.customerId ? eq(chargingSessions.customerId, query.customerId) : undefined,
    query.chargerAssetId ? eq(chargingSessions.chargerAssetId, query.chargerAssetId) : undefined
  );

  const [totalRow] = await database.db.select({ total: count() }).from(chargingSessions).where(filter);
  const rows = await database.db
    .select()
    .from(chargingSessions)
    .where(filter)
    .orderBy(desc(chargingSessions.startedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows,
    total: totalRow.total
  };
};
