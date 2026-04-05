import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/app/build-server';
import { hashPassword } from '../src/platform/auth/password';
import { users } from '../src/platform/db/schema';

import { buildTestConfig, createMigratedTestDb } from './test-utils';

const expectErrorEnvelope = (response: { json: () => any }, code: string) => {
  const body = response.json();
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(typeof body.error.correlationId).toBe('string');
};

const createUserAndLogin = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  database: ReturnType<typeof createMigratedTestDb>['database'],
  payload: { username: string; password: string; role: (typeof users.$inferInsert)['role'] }
): Promise<string> => {
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

describe('catalog management and search slice', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces admin-only mutations and handles validation/conflict paths', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const adminToken = await createUserAndLogin(app, database, {
      username: 'admin-catalog',
      password: 'admin-password-1',
      role: 'administrator'
    });

    const salesToken = await createUserAndLogin(app, database, {
      username: 'sales-catalog',
      password: 'sales-password-1',
      role: 'sales_associate'
    });

    const forbiddenCreate = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${salesToken}` },
      payload: {
        sku: 'SKU-001',
        name: 'Helmet Alpha',
        description: 'Entry helmet',
        category: 'gear',
        attributes: { color: 'black' },
        fitmentDimensions: { frame: 'medium' },
        active: true
      }
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: '',
        category: 'gear'
      }
    });
    expect(invalidCreate.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: 'SKU-001',
        name: 'Helmet Alpha',
        description: 'Entry helmet',
        category: 'gear',
        attributes: { color: 'black', size: ['m'] },
        fitmentDimensions: { frame: ['medium'] },
        active: true
      }
    });

    expect(created.statusCode).toBe(201);
    const productId = created.json().product.id as number;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: 'SKU-001',
        name: 'Helmet Beta',
        description: 'Duplicate sku',
        category: 'gear',
        attributes: {},
        fitmentDimensions: {},
        active: true
      }
    });

    expect(duplicate.statusCode).toBe(409);

    const readAsSales = await app.inject({
      method: 'GET',
      url: `/v1/catalog/products/${productId}`,
      headers: { authorization: `Bearer ${salesToken}` }
    });

    expect(readAsSales.statusCode).toBe(200);
    expect(readAsSales.json().product.sku).toBe('SKU-001');

    const auditCount = database.sqlite
      .prepare("SELECT COUNT(*) as count FROM audit_logs WHERE action = 'catalog.product.created'")
      .get() as { count: number };
    expect(auditCount.count).toBeGreaterThanOrEqual(1);
  });

  it('supports keyword search with combined filters, metadata, suggestions, and cache invalidation', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const adminToken = await createUserAndLogin(app, database, {
      username: 'admin-search',
      password: 'admin-password-2',
      role: 'administrator'
    });

    const instructorToken = await createUserAndLogin(app, database, {
      username: 'instructor-search',
      password: 'instr-password-2',
      role: 'instructor'
    });

    const productA = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: 'SKU-HELM-1',
        name: 'Helmet Prime',
        description: 'Protective helmet for racing',
        category: 'gear',
        attributes: { color: ['black'], size: ['m'] },
        fitmentDimensions: { frame: ['medium'] },
        active: true
      }
    });
    expect(productA.statusCode).toBe(201);
    const productAId = productA.json().product.id as number;

    const productB = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: 'SKU-HELM-2',
        name: 'Helmet Trail',
        description: 'Helmet for trail riding',
        category: 'gear',
        attributes: { color: ['red'], size: ['l'] },
        fitmentDimensions: { frame: ['large'] },
        active: true
      }
    });
    expect(productB.statusCode).toBe(201);

    const searchPayload = {
      keyword: 'helmet',
      filters: {
        categories: ['gear'],
        attributes: { color: ['black'] },
        fitmentDimensions: { frame: ['medium'] },
        active: true
      },
      page: 1,
      pageSize: 10,
      sort: 'relevance' as const,
      includeSuggestedTerms: true
    };

    const firstSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: searchPayload
    });

    expect(firstSearch.statusCode).toBe(200);
    expect(firstSearch.json().items).toHaveLength(1);
    expect(firstSearch.json().items[0].sku).toBe('SKU-HELM-1');
    expect(firstSearch.json().meta.appliedFilters.attributes.color[0]).toBe('black');
    expect(firstSearch.json().meta.sort.requested).toBe('relevance');
    expect(firstSearch.json().meta.cache.hit).toBe(false);

    const secondSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: searchPayload
    });

    expect(secondSearch.statusCode).toBe(200);
    expect(secondSearch.json().meta.cache.hit).toBe(true);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/catalog/products/${productAId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Safety Cap Prime',
        description: 'Protective safety cap for racing'
      }
    });
    expect(updated.statusCode).toBe(200);

    const postUpdateSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: searchPayload
    });

    expect(postUpdateSearch.statusCode).toBe(200);
    expect(postUpdateSearch.json().meta.cache.hit).toBe(false);
    expect(postUpdateSearch.json().items).toHaveLength(0);

    const suggestionSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: {
        keyword: 'helmt',
        filters: {
          categories: ['gear'],
          attributes: {},
          fitmentDimensions: {},
          active: true
        },
        page: 1,
        pageSize: 10,
        sort: 'relevance',
        includeSuggestedTerms: true
      }
    });

    expect(suggestionSearch.statusCode).toBe(200);
    const suggestedTerms = suggestionSearch.json().meta.suggestedTerms as string[] | undefined;
    expect(suggestedTerms?.length ?? 0).toBeGreaterThan(0);
    expect(suggestedTerms).toContain('helmet');
  });

  it('requires authentication for search reads', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const unauthorizedSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      payload: {
        keyword: 'helmet',
        filters: { categories: [], attributes: {}, fitmentDimensions: {} },
        page: 1,
        pageSize: 10,
        sort: 'relevance',
        includeSuggestedTerms: false
      }
    });

    expect(unauthorizedSearch.statusCode).toBe(401);
    expectErrorEnvelope(unauthorizedSearch, 'UNAUTHORIZED');
  });

  it('returns normalized 404 envelopes for missing catalog resources and enforces authz', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const adminToken = await createUserAndLogin(app, database, {
      username: 'admin-404',
      password: 'admin-password-404',
      role: 'administrator'
    });

    const salesToken = await createUserAndLogin(app, database, {
      username: 'sales-404',
      password: 'sales-password-404',
      role: 'sales_associate'
    });

    const missingId = 987654;

    const readMissing = await app.inject({
      method: 'GET',
      url: `/v1/catalog/products/${missingId}`,
      headers: { authorization: `Bearer ${salesToken}` }
    });
    expect(readMissing.statusCode).toBe(404);
    expectErrorEnvelope(readMissing, 'NOT_FOUND');

    const patchMissing = await app.inject({
      method: 'PATCH',
      url: `/v1/catalog/products/${missingId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'missing-product' }
    });
    expect(patchMissing.statusCode).toBe(404);
    expectErrorEnvelope(patchMissing, 'NOT_FOUND');

    const activateMissing = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${missingId}/activate`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(activateMissing.statusCode).toBe(404);
    expectErrorEnvelope(activateMissing, 'NOT_FOUND');

    const deactivateMissing = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${missingId}/deactivate`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(deactivateMissing.statusCode).toBe(404);
    expectErrorEnvelope(deactivateMissing, 'NOT_FOUND');

    const forbiddenActivate = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${missingId}/activate`,
      headers: { authorization: `Bearer ${salesToken}` }
    });
    expect(forbiddenActivate.statusCode).toBe(403);
    expectErrorEnvelope(forbiddenActivate, 'FORBIDDEN');

    const unauthenticatedRead = await app.inject({
      method: 'GET',
      url: `/v1/catalog/products/${missingId}`
    });
    expect(unauthenticatedRead.statusCode).toBe(401);
    expectErrorEnvelope(unauthenticatedRead, 'UNAUTHORIZED');
  });

  it('applies activate/deactivate state transitions and reflects them in reads and search filters', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const adminToken = await createUserAndLogin(app, database, {
      username: 'admin-activate',
      password: 'admin-password-activate',
      role: 'administrator'
    });

    const instructorToken = await createUserAndLogin(app, database, {
      username: 'instructor-activate',
      password: 'instructor-password-activate',
      role: 'instructor'
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/catalog/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        sku: 'SKU-ACT-1',
        name: 'Activation Helmet',
        description: 'Activation state coverage item',
        category: 'gear',
        attributes: { color: ['black'] },
        fitmentDimensions: { frame: ['medium'] },
        active: true
      }
    });
    expect(created.statusCode).toBe(201);
    const productId = created.json().product.id as number;

    const activeSearchPayload = {
      keyword: 'activation',
      filters: {
        categories: ['gear'],
        attributes: { color: ['black'] },
        fitmentDimensions: { frame: ['medium'] },
        active: true
      },
      page: 1,
      pageSize: 10,
      sort: 'relevance' as const,
      includeSuggestedTerms: false
    };

    const initialActiveSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: activeSearchPayload
    });
    expect(initialActiveSearch.statusCode).toBe(200);
    expect(initialActiveSearch.json().items).toHaveLength(1);

    const deactivated = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${productId}/deactivate`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().product.active).toBe(false);

    const readAfterDeactivate = await app.inject({
      method: 'GET',
      url: `/v1/catalog/products/${productId}`,
      headers: { authorization: `Bearer ${instructorToken}` }
    });
    expect(readAfterDeactivate.statusCode).toBe(200);
    expect(readAfterDeactivate.json().product.active).toBe(false);

    const activeSearchAfterDeactivate = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: activeSearchPayload
    });
    expect(activeSearchAfterDeactivate.statusCode).toBe(200);
    expect(activeSearchAfterDeactivate.json().items).toHaveLength(0);

    const inactiveSearch = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: {
        ...activeSearchPayload,
        filters: {
          ...activeSearchPayload.filters,
          active: false
        }
      }
    });
    expect(inactiveSearch.statusCode).toBe(200);
    expect(inactiveSearch.json().items).toHaveLength(1);
    expect(inactiveSearch.json().items[0].sku).toBe('SKU-ACT-1');

    const forbiddenActivate = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${productId}/activate`,
      headers: { authorization: `Bearer ${instructorToken}` }
    });
    expect(forbiddenActivate.statusCode).toBe(403);
    expectErrorEnvelope(forbiddenActivate, 'FORBIDDEN');

    const activated = await app.inject({
      method: 'POST',
      url: `/v1/catalog/products/${productId}/activate`,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().product.active).toBe(true);

    const activeSearchAfterActivate = await app.inject({
      method: 'POST',
      url: '/v1/search/products',
      headers: { authorization: `Bearer ${instructorToken}` },
      payload: activeSearchPayload
    });
    expect(activeSearchAfterActivate.statusCode).toBe(200);
    expect(activeSearchAfterActivate.json().items).toHaveLength(1);
    expect(activeSearchAfterActivate.json().items[0].sku).toBe('SKU-ACT-1');
  });
});
