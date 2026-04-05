import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { AppConfig } from '../config';

import { schema } from './schema';

export type AppDatabase = ReturnType<typeof createDatabase>;

const applyPragmas = (sqlite: Database.Database) => {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('temp_store = MEMORY');
};

export const createDatabase = (config: Pick<AppConfig, 'databaseUrl'>) => {
  if (config.databaseUrl !== ':memory:') {
    const dbDir = path.dirname(config.databaseUrl);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const sqlite = new Database(config.databaseUrl);
  applyPragmas(sqlite);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close()
  };
};
