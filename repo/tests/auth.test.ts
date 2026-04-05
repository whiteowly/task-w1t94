import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/app/build-server';
import { hashPassword } from '../src/platform/auth/password';
import { users } from '../src/platform/db/schema';

import { buildTestConfig, createMigratedTestDb } from './test-utils';

describe('auth routes', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      fn?.();
    }
  });

  it('supports login, me, and permissions with opaque bearer sessions', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    await database.db.insert(users).values({
      username: 'sales1',
      passwordHash: hashPassword('super-secret-pass'),
      role: 'sales_associate'
    });

    const app = await buildServer({
      config: buildTestConfig(dbPath),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'sales1', password: 'super-secret-pass' }
    });

    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('sales1');

    const permissions = await app.inject({
      method: 'GET',
      url: '/v1/auth/permissions',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(permissions.statusCode).toBe(200);
    expect(permissions.json().permissions).toContain('sales.create_orders');
  });

  it('returns 401 for invalid credentials and protected access without token', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    await database.db.insert(users).values({
      username: 'admin1',
      passwordHash: hashPassword('correct-password'),
      role: 'administrator'
    });

    const app = await buildServer({
      config: buildTestConfig(dbPath),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const badLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'admin1', password: 'wrong-password' }
    });
    expect(badLogin.statusCode).toBe(401);

    const unauthorized = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(unauthorized.statusCode).toBe(401);
  });
});
