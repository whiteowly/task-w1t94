import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAuditLog, listAuditLogs } from '../../modules/audit/audit-read-service';
import { auditLogIdParamSchema, auditLogListQuerySchema } from '../../modules/audit/audit-read-types';
import {
  exportListQuerySchema,
  exportIdParamSchema
} from '../../modules/exports/export-types';
import {
  generateAnalyticsKpiReport,
  generateReconciliationKpiReport,
  getExportFile,
  getExportJob,
  listExportJobs
} from '../../modules/exports/export-jobs';
import { permissions } from '../../platform/auth/permissions';
import { validationFailed } from '../../platform/errors/app-error';

const parseOrFail = <S extends z.ZodTypeAny>(schema: S, payload: unknown, message: string): z.infer<S> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw validationFailed(message, parsed.error.flatten());
  }

  return parsed.data;
};

const serializeExportJob = (row: {
  id: string;
  jobType: string;
  status: string;
  scheduledForLocal: string;
  startedAt: number | null;
  completedAt: number | null;
  filePath: string | null;
  checksumSha256: string | null;
  rowCount: number | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: row.id,
  jobType: row.jobType,
  status: row.status,
  scheduledForLocal: row.scheduledForLocal,
  startedAt: row.startedAt,
  completedAt: row.completedAt,
  filePath: row.filePath,
  checksumSha256: row.checksumSha256,
  rowCount: row.rowCount,
  errorMessage: row.errorMessage,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const serializeAuditLog = (row: {
  id: number;
  occurredAt: number;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeHash: string;
  afterHash: string;
  prevHash: string | null;
  entryHash: string;
  correlationId: string;
  metadata: Record<string, unknown>;
}) => ({
  id: row.id,
  occurredAt: row.occurredAt,
  actorUserId: row.actorUserId,
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  beforeHash: row.beforeHash,
  afterHash: row.afterHash,
  prevHash: row.prevHash,
  entryHash: row.entryHash,
  correlationId: row.correlationId,
  metadata: row.metadata
});

export const registerAuditReportingRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/v1/audit/logs', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readLogs)] }, async (request, reply) => {
    const query = parseOrFail(auditLogListQuerySchema, request.query, 'Invalid audit logs query');
    const listed = await listAuditLogs(fastify.appDb, query);

    return reply.send({
      items: listed.rows.map(serializeAuditLog),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  fastify.get('/v1/audit/logs/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readLogs)] }, async (request, reply) => {
    const params = parseOrFail(auditLogIdParamSchema, request.params, 'Invalid audit log id');
    const log = await getAuditLog(fastify.appDb, params.id);

    return reply.send({
      auditLog: serializeAuditLog(log),
      correlationId: request.id
    });
  });

  fastify.post('/v1/reports/kpis/analytics', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readReconciliationExports)] }, async (request, reply) => {
    const report = await generateAnalyticsKpiReport(
      fastify.appDb,
      {
        exportDir: fastify.appConfig.exportDir,
        facilityTimezone: fastify.appConfig.facilityTimezone
      },
      {
        userId: request.auth!.userId,
        correlationId: request.id
      }
    );

    return reply.send({
      dataset: report.dataset,
      exportReference: serializeExportJob(report.exportJob),
      correlationId: request.id
    });
  });

  fastify.post('/v1/reports/kpis/reconciliation', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readReconciliationExports)] }, async (request, reply) => {
    const report = await generateReconciliationKpiReport(
      fastify.appDb,
      {
        exportDir: fastify.appConfig.exportDir,
        facilityTimezone: fastify.appConfig.facilityTimezone
      },
      {
        userId: request.auth!.userId,
        correlationId: request.id
      }
    );

    return reply.send({
      dataset: report.dataset,
      exportReference: serializeExportJob(report.exportJob),
      correlationId: request.id
    });
  });

  fastify.get('/v1/exports', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readReconciliationExports)] }, async (request, reply) => {
    const query = parseOrFail(exportListQuerySchema, request.query, 'Invalid export jobs query');
    const listed = await listExportJobs(fastify.appDb, query);

    return reply.send({
      items: listed.rows.map(serializeExportJob),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  fastify.get('/v1/exports/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readReconciliationExports)] }, async (request, reply) => {
    const params = parseOrFail(exportIdParamSchema, request.params, 'Invalid export job id');
    const exportJob = await getExportJob(fastify.appDb, params.id);

    return reply.send({
      exportJob: serializeExportJob(exportJob),
      correlationId: request.id
    });
  });

  fastify.get('/v1/exports/:id/download', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.audit.readReconciliationExports)] }, async (request, reply) => {
    const params = parseOrFail(exportIdParamSchema, request.params, 'Invalid export job id');
    const exportFile = await getExportFile(
      fastify.appDb,
      {
        exportDir: fastify.appConfig.exportDir
      },
      params.id
    );

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${exportFile.exportJob.id}.csv"`);
    return reply.send(exportFile.csvContent);
  });
};
