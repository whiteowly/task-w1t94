import { and, count, desc, eq, gte, lte } from 'drizzle-orm';

import { notFound } from '../../platform/errors/app-error';
import type { AppDatabase } from '../../platform/db/client';
import { auditLogs } from '../../platform/db/schema';

const parseMetadataJson = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

export const listAuditLogs = async (
  database: AppDatabase,
  query: {
    page: number;
    pageSize: number;
    action?: string;
    entityType?: string;
    entityId?: string;
    actorUserId?: number;
    correlationId?: string;
    occurredFrom?: number;
    occurredTo?: number;
  }
) => {
  const filter = and(
    query.action ? eq(auditLogs.action, query.action) : undefined,
    query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
    query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
    query.actorUserId ? eq(auditLogs.actorUserId, query.actorUserId) : undefined,
    query.correlationId ? eq(auditLogs.correlationId, query.correlationId) : undefined,
    query.occurredFrom ? gte(auditLogs.occurredAt, query.occurredFrom) : undefined,
    query.occurredTo ? lte(auditLogs.occurredAt, query.occurredTo) : undefined
  );

  const [totalRow] = await database.db.select({ total: count() }).from(auditLogs).where(filter);

  const rows = await database.db
    .select()
    .from(auditLogs)
    .where(filter)
    .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows: rows.map((row) => ({
      ...row,
      metadata: parseMetadataJson(row.metadataJson)
    })),
    total: totalRow.total
  };
};

export const getAuditLog = async (database: AppDatabase, id: number) => {
  const rows = await database.db.select().from(auditLogs).where(eq(auditLogs.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw notFound('Audit log not found');
  }

  return {
    ...row,
    metadata: parseMetadataJson(row.metadataJson)
  };
};
