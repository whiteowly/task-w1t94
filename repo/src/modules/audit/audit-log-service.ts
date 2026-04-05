import { createHash } from 'node:crypto';

import { desc } from 'drizzle-orm';

import type { AppDatabase } from '../../platform/db/client';
import { auditLogs } from '../../platform/db/schema';

const nowEpoch = () => Math.floor(Date.now() / 1000);

const hashPayload = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

export const appendAuditLog = async (
  database: AppDatabase,
  input: {
    actorUserId?: number;
    action: string;
    entityType: string;
    entityId: string;
    before: unknown;
    after: unknown;
    correlationId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  const [last] = await database.db
    .select({ entryHash: auditLogs.entryHash })
    .from(auditLogs)
    .orderBy(desc(auditLogs.id))
    .limit(1);

  const beforeHash = hashPayload(input.before);
  const afterHash = hashPayload(input.after);
  const prevHash = last?.entryHash ?? null;
  const entryHash = createHash('sha256')
    .update([prevHash ?? '', beforeHash, afterHash, input.action, input.entityType, input.entityId, input.correlationId].join(':'))
    .digest('hex');

  await database.db.insert(auditLogs).values({
    occurredAt: nowEpoch(),
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeHash,
    afterHash,
    prevHash,
    entryHash,
    correlationId: input.correlationId,
    metadataJson: JSON.stringify(input.metadata ?? {})
  });
};
