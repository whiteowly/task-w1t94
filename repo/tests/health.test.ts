import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/app/build-server';

import { createMigratedTestDb, buildTestConfig } from './test-utils';

describe('health routes', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      fn?.();
    }
  });

  it('returns live and ready statuses', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({
      config: buildTestConfig(dbPath),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json().status).toBe('ok');

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
  });
});
