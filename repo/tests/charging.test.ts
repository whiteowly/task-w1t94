import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildServer } from '../src/app/build-server';
import { hashPassword } from '../src/platform/auth/password';
import { auditLogs, users } from '../src/platform/db/schema';

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
  await database.db.insert(users).values({
    username: payload.username,
    passwordHash: hashPassword(payload.password),
    role: payload.role
  });

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username: payload.username,
      password: payload.password
    }
  });
  expect(login.statusCode).toBe(200);
  return login.json().token as string;
};

describe('charging sessions slice', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces mutation role boundaries and authenticated read access', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const opsToken = await createUserAndLogin(app, database, {
      username: 'ops-charge-1',
      password: 'ops-charge-pass-1',
      role: 'operations_manager'
    });
    const salesToken = await createUserAndLogin(app, database, {
      username: 'sales-charge-1',
      password: 'sales-charge-pass-1',
      role: 'sales_associate'
    });
    const auditorToken = await createUserAndLogin(app, database, {
      username: 'auditor-charge-1',
      password: 'auditor-charge-pass-1',
      role: 'auditor'
    });

    const unauthStart = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      payload: {
        customerId: 'cust-1',
        chargerAssetId: 'charger-a1',
        initialMeteredKwh: '0.000'
      }
    });
    expect(unauthStart.statusCode).toBe(401);
    expectErrorEnvelope(unauthStart, 'UNAUTHORIZED');

    const auditorForbiddenStart = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${auditorToken}` },
      payload: {
        customerId: 'cust-1',
        chargerAssetId: 'charger-a1',
        initialMeteredKwh: '0.000'
      }
    });
    expect(auditorForbiddenStart.statusCode).toBe(403);
    expectErrorEnvelope(auditorForbiddenStart, 'FORBIDDEN');

    const salesStart = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        customerId: 'cust-1',
        chargerAssetId: 'charger-a1',
        initialMeteredKwh: '0.000'
      }
    });
    expect(salesStart.statusCode).toBe(201);
    const sessionId = salesStart.json().chargingSession.id as number;

    const readAsAuditor = await app.inject({
      method: 'GET',
      url: `/v1/charging/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${auditorToken}` }
    });
    expect(readAsAuditor.statusCode).toBe(200);
    expect(readAsAuditor.json().chargingSession.status).toBe('started');

    const opsEnd = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${sessionId}/end`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '3.210'
      }
    });
    expect(opsEnd.statusCode).toBe(200);
    expect(opsEnd.json().chargingSession.meteredKwhThousandths).toBe(3210);
    expect(opsEnd.json().chargingSession.meteredKwh).toBe('3.210');
  });

  it('enforces legal lifecycle transitions with clean 404/409 errors', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const opsToken = await createUserAndLogin(app, database, {
      username: 'ops-charge-2',
      password: 'ops-charge-pass-2',
      role: 'operations_manager'
    });

    const missingEnd = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/999999/end',
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '1.000'
      }
    });
    expect(missingEnd.statusCode).toBe(404);
    expectErrorEnvelope(missingEnd, 'NOT_FOUND');

    const started = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        customerId: 'cust-2',
        chargerAssetId: 'charger-a2',
        startedAt: 2000,
        initialMeteredKwh: '0.500'
      }
    });
    expect(started.statusCode).toBe(201);
    const startedId = started.json().chargingSession.id as number;

    const endBeforeStart = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedId}/end`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '1.000',
        endedAt: 1000
      }
    });
    expect(endBeforeStart.statusCode).toBe(409);
    expectErrorEnvelope(endBeforeStart, 'CONFLICT');

    const invalidCompensate = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedId}/compensate`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        note: 'Cannot compensate directly'
      }
    });
    expect(invalidCompensate.statusCode).toBe(409);
    expectErrorEnvelope(invalidCompensate, 'CONFLICT');

    const ended = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedId}/end`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '2.000'
      }
    });
    expect(ended.statusCode).toBe(200);

    const exceptionAfterEnded = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedId}/exception`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        reason: 'late exception should fail'
      }
    });
    expect(exceptionAfterEnded.statusCode).toBe(409);
    expectErrorEnvelope(exceptionAfterEnded, 'CONFLICT');

    const decreasingMeter = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedId}/end`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '1.000'
      }
    });
    expect(decreasingMeter.statusCode).toBe(409);
    expectErrorEnvelope(decreasingMeter, 'CONFLICT');
  });

  it('supports started -> exception -> compensated flow with deterministic kWh exposure', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const salesToken = await createUserAndLogin(app, database, {
      username: 'sales-charge-3',
      password: 'sales-charge-pass-3',
      role: 'sales_associate'
    });

    const started = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        customerId: 'cust-3',
        chargerAssetId: 'charger-a3',
        initialMeteredKwh: '1.250'
      }
    });
    expect(started.statusCode).toBe(201);
    const sessionId = started.json().chargingSession.id as number;
    expect(started.json().chargingSession.meteredKwh).toBe('1.250');
    expect(started.json().chargingSession.meteredKwhThousandths).toBe(1250);

    const exception = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${sessionId}/exception`,
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        reason: 'charger communication failure'
      }
    });
    expect(exception.statusCode).toBe(200);
    expect(exception.json().chargingSession.status).toBe('exception');
    expect(exception.json().chargingSession.exceptionReason).toBe('charger communication failure');

    const compensated = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${sessionId}/compensate`,
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        note: 'waive session charge'
      }
    });
    expect(compensated.statusCode).toBe(200);
    expect(compensated.json().chargingSession.status).toBe('compensated');
    expect(compensated.json().chargingSession.compensationNote).toBe('waive session charge');
    expect(compensated.json().chargingSession.compensatedAt).toBeTypeOf('number');

    const secondCompensate = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${sessionId}/compensate`,
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        note: 'duplicate compensate'
      }
    });
    expect(secondCompensate.statusCode).toBe(409);
    expectErrorEnvelope(secondCompensate, 'CONFLICT');
  });

  it('supports filtered read/list linkage and audit logging for charging mutations', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const opsToken = await createUserAndLogin(app, database, {
      username: 'ops-charge-4',
      password: 'ops-charge-pass-4',
      role: 'operations_manager'
    });

    const unauthList = await app.inject({
      method: 'GET',
      url: '/v1/charging/sessions'
    });
    expect(unauthList.statusCode).toBe(401);
    expectErrorEnvelope(unauthList, 'UNAUTHORIZED');

    const missingRead = await app.inject({
      method: 'GET',
      url: '/v1/charging/sessions/999999',
      headers: { authorization: `Bearer ${opsToken}` }
    });
    expect(missingRead.statusCode).toBe(404);
    expectErrorEnvelope(missingRead, 'NOT_FOUND');

    const startedA = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        customerId: 'cust-link-a',
        chargerAssetId: 'charger-link-a',
        initialMeteredKwh: '0.100'
      }
    });
    expect(startedA.statusCode).toBe(201);
    const startedAId = startedA.json().chargingSession.id as number;

    const startedB = await app.inject({
      method: 'POST',
      url: '/v1/charging/sessions/start',
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        customerId: 'cust-link-b',
        chargerAssetId: 'charger-link-b',
        initialMeteredKwh: '2.500'
      }
    });
    expect(startedB.statusCode).toBe(201);
    const startedBId = startedB.json().chargingSession.id as number;

    const endedA = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedAId}/end`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        meteredKwh: '1.234'
      }
    });
    expect(endedA.statusCode).toBe(200);

    const exceptionB = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedBId}/exception`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        reason: 'power interruption'
      }
    });
    expect(exceptionB.statusCode).toBe(200);

    const compensatedB = await app.inject({
      method: 'POST',
      url: `/v1/charging/sessions/${startedBId}/compensate`,
      headers: { authorization: `Bearer ${opsToken}` },
      payload: {
        note: 'issue credit'
      }
    });
    expect(compensatedB.statusCode).toBe(200);

    const filteredEnded = await app.inject({
      method: 'GET',
      url: '/v1/charging/sessions?page=1&pageSize=10&status=ended&customerId=cust-link-a&chargerAssetId=charger-link-a',
      headers: { authorization: `Bearer ${opsToken}` }
    });
    expect(filteredEnded.statusCode).toBe(200);
    const filteredEndedBody = filteredEnded.json();
    expect(filteredEndedBody.items).toHaveLength(1);
    expect(filteredEndedBody.items[0].id).toBe(startedAId);
    expect(filteredEndedBody.items[0].customerId).toBe('cust-link-a');
    expect(filteredEndedBody.items[0].chargerAssetId).toBe('charger-link-a');
    expect(filteredEndedBody.items[0].status).toBe('ended');

    const filteredCompensated = await app.inject({
      method: 'GET',
      url: '/v1/charging/sessions?page=1&pageSize=10&status=compensated&customerId=cust-link-b&chargerAssetId=charger-link-b',
      headers: { authorization: `Bearer ${opsToken}` }
    });
    expect(filteredCompensated.statusCode).toBe(200);
    const filteredCompensatedBody = filteredCompensated.json();
    expect(filteredCompensatedBody.items).toHaveLength(1);
    expect(filteredCompensatedBody.items[0].id).toBe(startedBId);
    expect(filteredCompensatedBody.items[0].status).toBe('compensated');

    const chargingAuditRows = await database.db
      .select({
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId
      })
      .from(auditLogs)
      .where(eq(auditLogs.entityType, 'charging_session'));

    expect(chargingAuditRows).toHaveLength(5);
    expect(chargingAuditRows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'charging.session.started',
        'charging.session.ended',
        'charging.session.exception',
        'charging.session.compensated'
      ])
    );
    expect(chargingAuditRows.map((row) => row.entityId)).toEqual(
      expect.arrayContaining([String(startedAId), String(startedBId)])
    );
  });
});
