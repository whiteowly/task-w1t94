import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildServer } from '../src/app/build-server';
import { runMissedDailyExports } from '../src/modules/exports/export-jobs';
import { hashPassword } from '../src/platform/auth/password';
import { exportJobs, orders, payments, reconciliationRecords, reconciliationTransitions, users } from '../src/platform/db/schema';

import { buildTestConfig, createMigratedTestDb } from './test-utils';

const expectErrorEnvelope = (response: { json: () => any }, code: string) => {
  const body = response.json();
  expect(body.error.code).toBe(code);
  expect(typeof body.error.correlationId).toBe('string');
};

const createUserAndLogin = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  database: ReturnType<typeof createMigratedTestDb>['database'],
  payload: { username: string; password: string; role: (typeof users.$inferInsert)['role'] }
) => {
  const [created] = await database.db
    .insert(users)
    .values({
      username: payload.username,
      passwordHash: hashPassword(payload.password),
      role: payload.role
    })
    .returning({ id: users.id });

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username: payload.username,
      password: payload.password
    }
  });

  expect(login.statusCode).toBe(200);
  return {
    userId: created.id,
    token: login.json().token as string
  };
};

describe('reconciliation, reporting, exports, and auditor read surfaces', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces linear reconciliation lifecycle with timestamped attributed transitions and 401/403/404/409 handling', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-recon-1',
      password: 'admin-recon-pass-1',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-recon-1',
      password: 'sales-recon-pass-1',
      role: 'sales_associate'
    });
    const auditor = await createUserAndLogin(app, database, {
      username: 'auditor-recon-1',
      password: 'auditor-recon-pass-1',
      role: 'auditor'
    });

    const [order] = await database.db
      .insert(orders)
      .values({
        idempotencyKey: 'recon-order-1',
        status: 'finalized',
        customerId: 'cust-recon-1',
        totalMinor: 5500,
        createdByUserId: sales.userId
      })
      .returning({ id: orders.id });

    const unauthCreate = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/records',
      payload: { orderId: order.id }
    });
    expect(unauthCreate.statusCode).toBe(401);
    expectErrorEnvelope(unauthCreate, 'UNAUTHORIZED');

    const salesCreateForbidden = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/records',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: { orderId: order.id }
    });
    expect(salesCreateForbidden.statusCode).toBe(403);
    expectErrorEnvelope(salesCreateForbidden, 'FORBIDDEN');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/records',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        orderId: order.id,
        transitionNote: 'initial reconciliation intake'
      }
    });
    expect(created.statusCode).toBe(201);
    const recordId = created.json().record.id as number;
    expect(created.json().record.state).toBe('pending');
    expect(created.json().transition.fromState).toBe('none');
    expect(created.json().transition.toState).toBe('pending');
    expect(created.json().transition.transitionedByUserId).toBe(admin.userId);
    expect(created.json().transition.transitionedAt).toBeTypeOf('number');

    const auditorList = await app.inject({
      method: 'GET',
      url: '/v1/reconciliation/records?page=1&pageSize=10&state=pending',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(auditorList.statusCode).toBe(200);
    expect(auditorList.json().items).toHaveLength(1);
    expect(auditorList.json().items[0].id).toBe(recordId);

    const skipTransition = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'exported',
        transitionNote: 'skip should fail'
      }
    });
    expect(skipTransition.statusCode).toBe(409);
    expectErrorEnvelope(skipTransition, 'CONFLICT');

    const missingTransition = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/records/999999/transitions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'reviewed'
      }
    });
    expect(missingTransition.statusCode).toBe(404);
    expectErrorEnvelope(missingTransition, 'NOT_FOUND');

    const reviewed = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'reviewed',
        transitionNote: 'review completed'
      }
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().record.state).toBe('reviewed');
    expect(reviewed.json().transition.transitionedByUserId).toBe(admin.userId);

    const backtrack = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'reviewed'
      }
    });
    expect(backtrack.statusCode).toBe(409);
    expectErrorEnvelope(backtrack, 'CONFLICT');

    const exported = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'exported'
      }
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().record.state).toBe('exported');

    const archived = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'archived'
      }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().record.state).toBe('archived');

    const transitionAfterArchived = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'exported'
      }
    });
    expect(transitionAfterArchived.statusCode).toBe(409);
    expectErrorEnvelope(transitionAfterArchived, 'CONFLICT');

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/reconciliation/records/${recordId}`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().record.state).toBe('archived');
    expect(detail.json().transitions.map((transition: { toState: string }) => transition.toState)).toEqual([
      'pending',
      'reviewed',
      'exported',
      'archived'
    ]);
  });

  it('exposes auditor-only audit log read surfaces with filtering and pagination', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-audit-1',
      password: 'admin-audit-pass-1',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-audit-1',
      password: 'sales-audit-pass-1',
      role: 'sales_associate'
    });
    const auditor = await createUserAndLogin(app, database, {
      username: 'auditor-audit-1',
      password: 'auditor-audit-pass-1',
      role: 'auditor'
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/reconciliation/records',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {}
    });
    expect(created.statusCode).toBe(201);
    const recordId = created.json().record.id as number;

    const transitioned = await app.inject({
      method: 'POST',
      url: `/v1/reconciliation/records/${recordId}/transitions`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        toState: 'reviewed'
      }
    });
    expect(transitioned.statusCode).toBe(200);

    const unauthLogs = await app.inject({
      method: 'GET',
      url: '/v1/audit/logs'
    });
    expect(unauthLogs.statusCode).toBe(401);
    expectErrorEnvelope(unauthLogs, 'UNAUTHORIZED');

    const salesForbiddenLogs = await app.inject({
      method: 'GET',
      url: '/v1/audit/logs',
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(salesForbiddenLogs.statusCode).toBe(403);
    expectErrorEnvelope(salesForbiddenLogs, 'FORBIDDEN');

    const filteredLogs = await app.inject({
      method: 'GET',
      url: '/v1/audit/logs?page=1&pageSize=10&entityType=reconciliation_record&action=reconciliation.record.transitioned',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(filteredLogs.statusCode).toBe(200);
    expect(filteredLogs.json().items.length).toBeGreaterThanOrEqual(1);
    expect(filteredLogs.json().items[0].action).toBe('reconciliation.record.transitioned');

    const auditLogId = filteredLogs.json().items[0].id as number;
    const auditLogDetail = await app.inject({
      method: 'GET',
      url: `/v1/audit/logs/${auditLogId}`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(auditLogDetail.statusCode).toBe(200);
    expect(auditLogDetail.json().auditLog.id).toBe(auditLogId);
    expect(auditLogDetail.json().auditLog.entityType).toBe('reconciliation_record');

    const missingAuditLog = await app.inject({
      method: 'GET',
      url: '/v1/audit/logs/999999',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(missingAuditLog.statusCode).toBe(404);
    expectErrorEnvelope(missingAuditLog, 'NOT_FOUND');
  });

  it('generates KPI reports with persisted export references and supports export list/lookup/download metadata paths', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const config = buildTestConfig(dbPath);
    const app = await buildServer({ config, database });
    cleanup.push(() => {
      void app.close();
    });

    const sales = await createUserAndLogin(app, database, {
      username: 'sales-reports-1',
      password: 'sales-reports-pass-1',
      role: 'sales_associate'
    });
    const auditor = await createUserAndLogin(app, database, {
      username: 'auditor-reports-1',
      password: 'auditor-reports-pass-1',
      role: 'auditor'
    });

    const [order] = await database.db
      .insert(orders)
      .values({
        idempotencyKey: 'reports-order-1',
        status: 'finalized',
        customerId: 'cust-reports-1',
        totalMinor: 12000,
        createdByUserId: sales.userId
      })
      .returning({ id: orders.id });

    await database.db.insert(payments).values({
      orderId: order.id,
      method: 'cash',
      amountMinor: 12000,
      recordedByUserId: sales.userId
    });

    const [reconciliationRecord] = await database.db
      .insert(reconciliationRecords)
      .values({
        orderId: order.id,
        state: 'pending'
      })
      .returning({ id: reconciliationRecords.id });

    await database.db.insert(reconciliationTransitions).values({
      recordId: reconciliationRecord.id,
      fromState: 'none',
      toState: 'pending',
      transitionedByUserId: sales.userId
    });

    const unauthAnalytics = await app.inject({
      method: 'POST',
      url: '/v1/reports/kpis/analytics'
    });
    expect(unauthAnalytics.statusCode).toBe(401);
    expectErrorEnvelope(unauthAnalytics, 'UNAUTHORIZED');

    const salesForbiddenAnalytics = await app.inject({
      method: 'POST',
      url: '/v1/reports/kpis/analytics',
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(salesForbiddenAnalytics.statusCode).toBe(403);
    expectErrorEnvelope(salesForbiddenAnalytics, 'FORBIDDEN');

    const analyticsReport = await app.inject({
      method: 'POST',
      url: '/v1/reports/kpis/analytics',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(analyticsReport.statusCode).toBe(200);
    expect(analyticsReport.json().dataset.totals.orderCount).toBeGreaterThanOrEqual(1);
    const analyticsExportId = analyticsReport.json().exportReference.id as string;
    expect(analyticsReport.json().exportReference.jobType).toBe('analytics');
    expect(analyticsReport.json().exportReference.status).toBe('completed');
    expect(typeof analyticsReport.json().exportReference.filePath).toBe('string');
    expect(fs.existsSync(analyticsReport.json().exportReference.filePath as string)).toBe(true);

    const reconciliationReport = await app.inject({
      method: 'POST',
      url: '/v1/reports/kpis/reconciliation',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(reconciliationReport.statusCode).toBe(200);
    expect(reconciliationReport.json().dataset.totals.recordCount).toBeGreaterThanOrEqual(1);
    const reconciliationExportId = reconciliationReport.json().exportReference.id as string;
    expect(reconciliationReport.json().exportReference.jobType).toBe('reconciliation');

    const exportList = await app.inject({
      method: 'GET',
      url: '/v1/exports?page=1&pageSize=10&jobType=analytics&status=completed',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(exportList.statusCode).toBe(200);
    expect(exportList.json().items.map((item: { id: string }) => item.id)).toContain(analyticsExportId);

    const exportLookup = await app.inject({
      method: 'GET',
      url: `/v1/exports/${analyticsExportId}`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(exportLookup.statusCode).toBe(200);
    expect(exportLookup.json().exportJob.id).toBe(analyticsExportId);

    const exportDownload = await app.inject({
      method: 'GET',
      url: `/v1/exports/${analyticsExportId}/download`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(exportDownload.statusCode).toBe(200);
    expect(exportDownload.body).toContain('metric,value');

    const missingExportLookup = await app.inject({
      method: 'GET',
      url: '/v1/exports/11111111-1111-1111-1111-111111111111',
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(missingExportLookup.statusCode).toBe(404);
    expectErrorEnvelope(missingExportLookup, 'NOT_FOUND');

    const [runningExport] = await database.db
      .insert(exportJobs)
      .values({
        id: '22222222-2222-4222-8222-222222222222',
        jobType: 'analytics',
        status: 'running',
        scheduledForLocal: '2099-01-01'
      })
      .returning({ id: exportJobs.id });

    const notReadyDownload = await app.inject({
      method: 'GET',
      url: `/v1/exports/${runningExport.id}/download`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(notReadyDownload.statusCode).toBe(409);
    expectErrorEnvelope(notReadyDownload, 'CONFLICT');

    const reconciliationExportLookup = await app.inject({
      method: 'GET',
      url: `/v1/exports/${reconciliationExportId}`,
      headers: { authorization: `Bearer ${auditor.token}` }
    });
    expect(reconciliationExportLookup.statusCode).toBe(200);
    expect(reconciliationExportLookup.json().exportJob.jobType).toBe('reconciliation');

    const persistedAnalytics = await database.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, analyticsExportId))
      .limit(1);
    expect(persistedAnalytics[0]?.status).toBe('completed');
  });

  it('runs missed daily exports once per day through scheduler export job path', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const config = buildTestConfig(dbPath);

    await runMissedDailyExports(database, {
      exportDir: config.exportDir,
      facilityTimezone: config.facilityTimezone
    });

    const firstPass = await database.db
      .select({ id: exportJobs.id, jobType: exportJobs.jobType, status: exportJobs.status })
      .from(exportJobs)
      .where(eq(exportJobs.status, 'completed'));

    expect(firstPass).toHaveLength(2);
    expect(firstPass.map((row) => row.jobType).sort()).toEqual(['analytics', 'reconciliation']);

    await runMissedDailyExports(database, {
      exportDir: config.exportDir,
      facilityTimezone: config.facilityTimezone
    });

    const secondPass = await database.db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(eq(exportJobs.status, 'completed'));

    expect(secondPass).toHaveLength(2);
  });
});
