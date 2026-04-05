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

  it('bootstrap-admin succeeds on empty DB with valid secret', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({
      config: buildTestConfig(dbPath, { bootstrapSecret: 'test-secret-123' }),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap-admin',
      headers: { 'x-bootstrap-secret': 'test-secret-123' },
      payload: { username: 'myadmin', password: 'longpassword' }
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.username).toBe('myadmin');
    expect(res.json().user.role).toBe('administrator');
  });

  it('bootstrap-admin blocked without secret header', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({
      config: buildTestConfig(dbPath, { bootstrapSecret: 'test-secret-123' }),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap-admin',
      payload: { username: 'myadmin', password: 'longpassword' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Invalid bootstrap secret');
  });

  it('bootstrap-admin blocked with wrong secret', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({
      config: buildTestConfig(dbPath, { bootstrapSecret: 'test-secret-123' }),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap-admin',
      headers: { 'x-bootstrap-secret': 'wrong-secret' },
      payload: { username: 'myadmin', password: 'longpassword' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Invalid bootstrap secret');
  });

  it('bootstrap-admin blocked when users exist', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    await database.db.insert(users).values({
      username: 'existing',
      passwordHash: hashPassword('some-password'),
      role: 'administrator'
    });

    const app = await buildServer({
      config: buildTestConfig(dbPath, { bootstrapSecret: 'test-secret-123' }),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap-admin',
      headers: { 'x-bootstrap-secret': 'test-secret-123' },
      payload: { username: 'myadmin', password: 'longpassword' }
    });

    expect(res.statusCode).toBe(409);
  });

  it('bootstrap-admin blocked when disabled (no BOOTSTRAP_SECRET)', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({
      config: buildTestConfig(dbPath),
      database
    });
    cleanup.push(() => {
      void app.close();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/bootstrap-admin',
      payload: { username: 'myadmin', password: 'longpassword' }
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('Bootstrap is disabled');
  });

  it('session revoke: logout invalidates the token', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    await database.db.insert(users).values({
      username: 'revokeuser',
      passwordHash: hashPassword('pass12345678'),
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
      payload: { username: 'revokeuser', password: 'pass12345678' }
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    // Confirm token works
    const meBefore = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meBefore.statusCode).toBe(200);

    // Logout (revoke session)
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(logout.statusCode).toBe(204);

    // Confirm token no longer works
    const meAfter = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(meAfter.statusCode).toBe(401);
  });
});
