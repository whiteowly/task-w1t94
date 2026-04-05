import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDatabase } from '../src/platform/db/client';
import { runMigrations } from '../src/platform/db/migrate';
import type { AppConfig } from '../src/platform/config';

export const buildTestConfig = (dbPath: string, opts?: { bootstrapSecret?: string }): AppConfig => ({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'error',
  databaseUrl: dbPath,
  exportDir: path.join(path.dirname(dbPath), 'exports'),
  facilityTimezone: 'UTC',
  encryptionKey: Buffer.alloc(32, 1),
  sessionTtlHours: 12,
  schedulerEnabled: false,
  bootstrapSecret: opts?.bootstrapSecret
});

export const createMigratedTestDb = () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facility-api-'));
  const dbPath = path.join(tempDir, 'test.db');
  const database = createDatabase({ databaseUrl: dbPath });
  runMigrations(database);

  return { database, tempDir, dbPath };
};
