import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { and, count, desc, eq, sql } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import type { AppConfig } from '../../platform/config';
import type { AppDatabase } from '../../platform/db/client';
import { conflict, notFound } from '../../platform/errors/app-error';
import { exportJobs } from '../../platform/db/schema';

const nowEpoch = () => Math.floor(Date.now() / 1000);

export type ExportJobType = 'analytics' | 'reconciliation';
export type ExportJobStatus = 'pending' | 'running' | 'completed' | 'failed';

const dateKey = (timezone: string): string => {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  return formatted;
};

const buildExportFilePath = (exportDir: string, jobType: ExportJobType, localDate: string, id: string): string =>
  path.join(exportDir, `${jobType}-${localDate}-${id}.csv`);

const rowCountForCsv = (csvContent: string): number => {
  const trimmed = csvContent.trim();
  if (!trimmed) {
    return 0;
  }

  return Math.max(trimmed.split('\n').length - 1, 0);
};

export const persistCsvExport = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>,
  input: {
    jobType: ExportJobType;
    csvContent: string;
    correlationId: string;
    actorUserId?: number;
    scheduledForLocal?: string;
  }
) => {
  const id = randomUUID();
  const startedAt = nowEpoch();
  const localDate = input.scheduledForLocal ?? dateKey(config.facilityTimezone);

  const [created] = await database.db
    .insert(exportJobs)
    .values({
      id,
      jobType: input.jobType,
      status: 'running',
      scheduledForLocal: localDate,
      startedAt,
      createdAt: startedAt,
      updatedAt: startedAt
    })
    .returning();

  try {
    await fs.mkdir(config.exportDir, { recursive: true });
    const filePath = buildExportFilePath(config.exportDir, input.jobType, localDate, id);
    await fs.writeFile(filePath, input.csvContent, 'utf8');

    const checksumSha256 = createHash('sha256').update(input.csvContent, 'utf8').digest('hex');
    const rowCount = rowCountForCsv(input.csvContent);
    const completedAt = nowEpoch();

    const [completed] = await database.db
      .update(exportJobs)
      .set({
        status: 'completed',
        completedAt,
        filePath,
        checksumSha256,
        rowCount,
        updatedAt: completedAt
      })
      .where(eq(exportJobs.id, id))
      .returning();

    await appendAuditLog(database, {
      actorUserId: input.actorUserId,
      action: 'export.job.completed',
      entityType: 'export_job',
      entityId: completed.id,
      before: { status: created.status },
      after: {
        status: completed.status,
        jobType: completed.jobType,
        filePath: completed.filePath,
        rowCount: completed.rowCount
      },
      correlationId: input.correlationId
    });

    return completed;
  } catch (error) {
    const completedAt = nowEpoch();
    const [failed] = await database.db
      .update(exportJobs)
      .set({
        status: 'failed',
        completedAt,
        errorMessage: error instanceof Error ? error.message : 'Unknown export failure',
        updatedAt: completedAt
      })
      .where(eq(exportJobs.id, id))
      .returning();

    await appendAuditLog(database, {
      actorUserId: input.actorUserId,
      action: 'export.job.failed',
      entityType: 'export_job',
      entityId: failed.id,
      before: { status: created.status },
      after: {
        status: failed.status,
        errorMessage: failed.errorMessage
      },
      correlationId: input.correlationId
    });

    throw error;
  }
};

const summarizeOrderStatus = (database: AppDatabase) =>
  database.sqlite
    .prepare(
      `SELECT status, COUNT(*) as count, COALESCE(SUM(total_minor), 0) as total_minor
       FROM orders
       GROUP BY status
       ORDER BY status`
    )
    .all() as Array<{ status: string; count: number; total_minor: number }>;

const summarizeOrderTotals = (database: AppDatabase) =>
  database.sqlite
    .prepare(
      `SELECT
         COUNT(*) as order_count,
         SUM(CASE WHEN status = 'finalized' THEN 1 ELSE 0 END) as finalized_order_count,
         COALESCE(SUM(CASE WHEN status = 'finalized' THEN total_minor ELSE 0 END), 0) as finalized_total_minor
       FROM orders`
    )
    .get() as {
    order_count: number;
    finalized_order_count: number;
    finalized_total_minor: number;
  };

const summarizePayments = (database: AppDatabase) =>
  database.sqlite
    .prepare(
      `SELECT method, COUNT(*) as count, COALESCE(SUM(amount_minor), 0) as total_minor
       FROM payments
       GROUP BY method
       ORDER BY method`
    )
    .all() as Array<{ method: string; count: number; total_minor: number }>;

const summarizeReconciliationByState = (database: AppDatabase) =>
  database.sqlite
    .prepare(
      `SELECT state, COUNT(*) as count
       FROM reconciliation_records
       GROUP BY state
       ORDER BY state`
    )
    .all() as Array<{ state: string; count: number }>;

const summarizeReconciliationTransitions = (database: AppDatabase) =>
  database.sqlite
    .prepare(
      `SELECT from_state, to_state, COUNT(*) as count
       FROM reconciliation_transitions
       GROUP BY from_state, to_state
       ORDER BY from_state, to_state`
    )
    .all() as Array<{ from_state: string; to_state: string; count: number }>;

const summarizeReconciliationTotals = (database: AppDatabase) =>
  database.sqlite
    .prepare('SELECT COUNT(*) as record_count FROM reconciliation_records')
    .get() as {
    record_count: number;
  };

export type AnalyticsKpiDataset = {
  generatedAtEpoch: number;
  totals: {
    orderCount: number;
    finalizedOrderCount: number;
    finalizedTotalMinor: number;
  };
  orderStatusBreakdown: Array<{ status: string; count: number; totalMinor: number }>;
  paymentMethodBreakdown: Array<{ method: string; count: number; totalMinor: number }>;
};

export type ReconciliationKpiDataset = {
  generatedAtEpoch: number;
  totals: {
    recordCount: number;
  };
  stateBreakdown: Array<{ state: string; count: number }>;
  transitionBreakdown: Array<{ fromState: string; toState: string; count: number }>;
};

export const getAnalyticsKpiDataset = (database: AppDatabase): AnalyticsKpiDataset => {
  const orderTotals = summarizeOrderTotals(database);
  const orderStatus = summarizeOrderStatus(database);
  const payments = summarizePayments(database);

  return {
    generatedAtEpoch: nowEpoch(),
    totals: {
      orderCount: orderTotals.order_count,
      finalizedOrderCount: orderTotals.finalized_order_count,
      finalizedTotalMinor: orderTotals.finalized_total_minor
    },
    orderStatusBreakdown: orderStatus.map((row) => ({
      status: row.status,
      count: row.count,
      totalMinor: row.total_minor
    })),
    paymentMethodBreakdown: payments.map((row) => ({
      method: row.method,
      count: row.count,
      totalMinor: row.total_minor
    }))
  };
};

export const getReconciliationKpiDataset = (database: AppDatabase): ReconciliationKpiDataset => {
  const totals = summarizeReconciliationTotals(database);
  const stateBreakdown = summarizeReconciliationByState(database);
  const transitionBreakdown = summarizeReconciliationTransitions(database);

  return {
    generatedAtEpoch: nowEpoch(),
    totals: {
      recordCount: totals.record_count
    },
    stateBreakdown: stateBreakdown.map((row) => ({
      state: row.state,
      count: row.count
    })),
    transitionBreakdown: transitionBreakdown.map((row) => ({
      fromState: row.from_state,
      toState: row.to_state,
      count: row.count
    }))
  };
};

const buildAnalyticsCsv = (dataset: AnalyticsKpiDataset): string =>
  [
    'metric,value',
    `generated_at_epoch,${dataset.generatedAtEpoch}`,
    `total_orders,${dataset.totals.orderCount}`,
    `finalized_orders,${dataset.totals.finalizedOrderCount}`,
    `finalized_total_minor,${dataset.totals.finalizedTotalMinor}`,
    ...dataset.orderStatusBreakdown.flatMap((row) => [
      `orders_status_${row.status}_count,${row.count}`,
      `orders_status_${row.status}_total_minor,${row.totalMinor}`
    ]),
    ...dataset.paymentMethodBreakdown.flatMap((row) => [
      `payments_method_${row.method}_count,${row.count}`,
      `payments_method_${row.method}_total_minor,${row.totalMinor}`
    ]),
    ''
  ].join('\n');

const buildReconciliationCsv = (dataset: ReconciliationKpiDataset): string =>
  [
    'metric,value',
    `generated_at_epoch,${dataset.generatedAtEpoch}`,
    `total_records,${dataset.totals.recordCount}`,
    ...dataset.stateBreakdown.map((row) => `state_${row.state}_count,${row.count}`),
    ...dataset.transitionBreakdown.map((row) => `transition_${row.fromState}_to_${row.toState}_count,${row.count}`),
    ''
  ].join('\n');

export const generateAnalyticsKpiReport = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>,
  actor: { correlationId: string; userId?: number }
) => {
  const dataset = getAnalyticsKpiDataset(database);
  const exportJob = await persistCsvExport(database, config, {
    jobType: 'analytics',
    csvContent: buildAnalyticsCsv(dataset),
    correlationId: actor.correlationId,
    actorUserId: actor.userId
  });

  return {
    dataset,
    exportJob
  };
};

export const generateReconciliationKpiReport = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>,
  actor: { correlationId: string; userId?: number }
) => {
  const dataset = getReconciliationKpiDataset(database);
  const exportJob = await persistCsvExport(database, config, {
    jobType: 'reconciliation',
    csvContent: buildReconciliationCsv(dataset),
    correlationId: actor.correlationId,
    actorUserId: actor.userId
  });

  return {
    dataset,
    exportJob
  };
};

export const listExportJobs = async (
  database: AppDatabase,
  query: {
    page: number;
    pageSize: number;
    jobType?: ExportJobType;
    status?: ExportJobStatus;
    scheduledForLocal?: string;
  }
) => {
  const filter = and(
    query.jobType ? eq(exportJobs.jobType, query.jobType) : undefined,
    query.status ? eq(exportJobs.status, query.status) : undefined,
    query.scheduledForLocal ? eq(exportJobs.scheduledForLocal, query.scheduledForLocal) : undefined
  );

  const [totalRow] = await database.db.select({ total: count() }).from(exportJobs).where(filter);

  const rows = await database.db
    .select()
    .from(exportJobs)
    .where(filter)
    .orderBy(desc(exportJobs.createdAt), desc(exportJobs.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows,
    total: totalRow.total
  };
};

export const getExportJob = async (database: AppDatabase, id: string) => {
  const rows = await database.db.select().from(exportJobs).where(eq(exportJobs.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw notFound('Export job not found');
  }
  return row;
};

export const getExportFile = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir'>,
  id: string
): Promise<{ exportJob: typeof exportJobs.$inferSelect; csvContent: string }> => {
  const exportJob = await getExportJob(database, id);

  if (exportJob.status !== 'completed' || !exportJob.filePath) {
    throw conflict('Export is not ready for download', { status: exportJob.status });
  }

  const resolvedExportDir = path.resolve(config.exportDir);
  const resolvedFilePath = path.resolve(exportJob.filePath);
  if (resolvedFilePath !== resolvedExportDir && !resolvedFilePath.startsWith(`${resolvedExportDir}${path.sep}`)) {
    throw conflict('Export file path is outside configured export directory');
  }

  try {
    const csvContent = await fs.readFile(resolvedFilePath, 'utf8');
    return {
      exportJob,
      csvContent
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw notFound('Export file not found');
    }
    throw error;
  }
};

export const runDailyAnalyticsExport = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>
): Promise<typeof exportJobs.$inferSelect> =>
  generateAnalyticsKpiReport(database, config, {
    correlationId: 'scheduler.daily.analytics'
  }).then((result) => result.exportJob);

export const runDailyReconciliationExport = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>
): Promise<typeof exportJobs.$inferSelect> =>
  generateReconciliationKpiReport(database, config, {
    correlationId: 'scheduler.daily.reconciliation'
  }).then((result) => result.exportJob);

export const runMissedDailyExports = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'exportDir' | 'facilityTimezone'>
): Promise<void> => {
  const localDate = dateKey(config.facilityTimezone);

  const existing = await database.db
    .select({ jobType: exportJobs.jobType, status: exportJobs.status })
    .from(exportJobs)
    .where(sql`${exportJobs.scheduledForLocal} = ${localDate} and ${exportJobs.status} = 'completed'`);

  const hasAnalytics = existing.some((job) => job.jobType === 'analytics');
  const hasReconciliation = existing.some((job) => job.jobType === 'reconciliation');

  if (!hasAnalytics) {
    await runDailyAnalyticsExport(database, config);
  }
  if (!hasReconciliation) {
    await runDailyReconciliationExport(database, config);
  }
};
