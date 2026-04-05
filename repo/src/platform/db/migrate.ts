import path from 'node:path';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { AppDatabase } from './client';

export const runMigrations = (database: AppDatabase) => {
  migrate(database.db, {
    migrationsFolder: path.resolve(process.cwd(), 'drizzle/migrations')
  });
};
