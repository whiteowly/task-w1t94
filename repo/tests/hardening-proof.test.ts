import { Writable } from 'node:stream';

import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { appendAuditLog } from '../src/modules/audit/audit-log-service';
import { createLogger } from '../src/platform/logging/logger';
import { hashPassword } from '../src/platform/auth/password';
import { auditLogs, users } from '../src/platform/db/schema';

import { buildTestConfig, createMigratedTestDb } from './test-utils';

describe('hardening proofs', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces append-only audit log immutability against update/delete attempts', async () => {
    const { database } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const [actor] = await database.db
      .insert(users)
      .values({
        username: 'audit-proof-admin',
        passwordHash: hashPassword('audit-proof-pass'),
        role: 'administrator'
      })
      .returning({ id: users.id });

    await appendAuditLog(database, {
      actorUserId: actor.id,
      action: 'audit.proof.seeded',
      entityType: 'proof',
      entityId: 'seed-1',
      before: null,
      after: { ok: true },
      correlationId: 'hardening-audit-proof-1'
    });

    const [stored] = await database.db
      .select({ id: auditLogs.id, action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.entityId, 'seed-1'))
      .limit(1);

    expect(stored).toBeDefined();

    expect(() => {
      database.sqlite.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('tampered.action', stored.id);
    }).toThrowError(/append-only/i);

    expect(() => {
      database.sqlite.prepare('DELETE FROM audit_logs WHERE id = ?').run(stored.id);
    }).toThrowError(/append-only/i);

    const [afterAttempts] = await database.db
      .select({ id: auditLogs.id, action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.id, stored.id))
      .limit(1);

    expect(afterAttempts).toBeDefined();
    expect(afterAttempts.action).toBe('audit.proof.seeded');
  });

  it('redacts sensitive fields through the shared logger redaction path', async () => {
    const config = buildTestConfig('/tmp/logger-redaction-proof.db');
    config.logLevel = 'info';

    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      }
    });

    const logger = pino(createLogger(config) as pino.LoggerOptions, sink);

    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer super-secret-token',
            cookie: 'session=abcdef'
          }
        },
        body: {
          method: 'check',
          amountMinor: 13000,
          password: 'plain-password',
          token: 'plain-token',
          referenceText: 'CHK-424242',
          personalNote: 'Manual desk entry note'
        },
        payment: {
          ciphertext: 'encrypted-value',
          authTag: 'auth-tag-value',
          iv: 'iv-value'
        },
        nested: {
          password: 'nested-password',
          token: 'nested-token'
        }
      },
      'redaction proof log'
    );

    logger.flush();

    expect(chunks.length).toBeGreaterThan(0);
    const serialized = chunks.join('');
    expect(serialized).not.toContain('plain-password');
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('CHK-424242');
    expect(serialized).not.toContain('Manual desk entry note');

    const parsed = JSON.parse(chunks[0]);
    expect(parsed.req.headers.authorization).toBe('[REDACTED]');
    expect(parsed.req.headers.cookie).toBe('[REDACTED]');
    expect(parsed.body.password).toBe('[REDACTED]');
    expect(parsed.body.token).toBe('[REDACTED]');
    expect(parsed.body.referenceText).toBe('[REDACTED]');
    expect(parsed.body.personalNote).toBe('[REDACTED]');
    expect(parsed.payment.ciphertext).toBe('[REDACTED]');
    expect(parsed.payment.authTag).toBe('[REDACTED]');
    expect(parsed.payment.iv).toBe('[REDACTED]');
    expect(parsed.nested.password).toBe('[REDACTED]');
    expect(parsed.nested.token).toBe('[REDACTED]');
  });
});
