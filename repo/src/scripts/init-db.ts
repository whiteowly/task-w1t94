import { createDatabase } from '../platform/db/client';
import { runMigrations } from '../platform/db/migrate';
import { loadConfig } from '../platform/config';

const main = async (): Promise<void> => {
  const config = loadConfig();
  const database = createDatabase({ databaseUrl: config.databaseUrl });

  try {
    runMigrations(database);
  } finally {
    database.close();
  }
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
