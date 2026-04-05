import { and, count, desc, eq } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import { conflict, notFound } from '../../platform/errors/app-error';
import type { AppDatabase } from '../../platform/db/client';
import { productAttributeFacets, productFitmentFacets, products } from '../../platform/db/schema';

import { catalogSearchCache } from './search-service';

type FacetRecord = Record<string, string | number | boolean | Array<string | number | boolean>>;

const nowEpoch = () => Math.floor(Date.now() / 1000);

const isSkuUniqueConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: string };
  return (
    errorWithCode.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.message.includes('products_sku_unique') ||
    error.message.includes('UNIQUE constraint failed: products.sku')
  );
};

type NormalizedFacet = {
  key: string;
  valueNorm: string;
};

const normalizeFacetValue = (value: string | number | boolean): string => String(value).trim().toLowerCase();

const normalizeFacetRecord = (record: FacetRecord): NormalizedFacet[] => {
  const seen = new Set<string>();
  const output: NormalizedFacet[] = [];

  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) {
      continue;
    }

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      const valueNorm = normalizeFacetValue(value);
      if (!valueNorm) {
        continue;
      }
      const dedupeKey = `${key}|${valueNorm}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      output.push({ key, valueNorm });
    }
  }

  return output;
};

const syncFacetRows = async (
  executor: any,
  productId: number,
  attributes: FacetRecord,
  fitmentDimensions: FacetRecord
): Promise<void> => {
  await executor.delete(productAttributeFacets).where(eq(productAttributeFacets.productId, productId));
  await executor.delete(productFitmentFacets).where(eq(productFitmentFacets.productId, productId));

  const normalizedAttributes = normalizeFacetRecord(attributes).map((facet) => ({
    productId,
    key: facet.key,
    valueNorm: facet.valueNorm
  }));

  const normalizedFitment = normalizeFacetRecord(fitmentDimensions).map((facet) => ({
    productId,
    dimension: facet.key,
    valueNorm: facet.valueNorm
  }));

  if (normalizedAttributes.length > 0) {
    await executor.insert(productAttributeFacets).values(normalizedAttributes);
  }

  if (normalizedFitment.length > 0) {
    await executor.insert(productFitmentFacets).values(normalizedFitment);
  }
};

const withSqliteTransaction = async <T>(database: AppDatabase, callback: () => Promise<T>): Promise<T> => {
  database.sqlite.prepare('BEGIN IMMEDIATE').run();
  try {
    const result = await callback();
    database.sqlite.prepare('COMMIT').run();
    return result;
  } catch (error) {
    database.sqlite.prepare('ROLLBACK').run();
    throw error;
  }
};

export const createProduct = async (
  database: AppDatabase,
  payload: {
    sku: string;
    name: string;
    description: string;
    category: string;
    attributes: FacetRecord;
    fitmentDimensions: FacetRecord;
    active: boolean;
  },
  actor: { userId: number; correlationId: string }
) => {
  const now = nowEpoch();

  try {
    const created = await withSqliteTransaction(database, async () => {
      const [row] = await database.db
        .insert(products)
        .values({
          sku: payload.sku,
          name: payload.name,
          description: payload.description,
          category: payload.category,
          attributesJson: JSON.stringify(payload.attributes),
          fitmentJson: JSON.stringify(payload.fitmentDimensions),
          active: payload.active,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      await syncFacetRows(database.db, row.id, payload.attributes, payload.fitmentDimensions);
      return row;
    });

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'catalog.product.created',
      entityType: 'product',
      entityId: String(created.id),
      before: null,
      after: { id: created.id, sku: created.sku, active: created.active },
      correlationId: actor.correlationId
    });

    catalogSearchCache.clear();
    return created;
  } catch (error) {
    if (isSkuUniqueConflict(error)) {
      throw conflict('SKU already exists', { sku: payload.sku });
    }
    throw error;
  }
};

export const updateProduct = async (
  database: AppDatabase,
  productId: number,
  payload: Partial<{
    sku: string;
    name: string;
    description: string;
    category: string;
    attributes: FacetRecord;
    fitmentDimensions: FacetRecord;
    active: boolean;
  }>,
  actor: { userId: number; correlationId: string }
) => {
  const existing = await database.db.select().from(products).where(eq(products.id, productId)).limit(1);
  const current = existing[0];
  if (!current) {
    throw notFound('Product not found');
  }

  const now = nowEpoch();

  try {
    const updated = await withSqliteTransaction(database, async () => {
      const [row] = await database.db
        .update(products)
        .set({
          sku: payload.sku ?? current.sku,
          name: payload.name ?? current.name,
          description: payload.description ?? current.description,
          category: payload.category ?? current.category,
          attributesJson: JSON.stringify(payload.attributes ?? JSON.parse(current.attributesJson)),
          fitmentJson: JSON.stringify(payload.fitmentDimensions ?? JSON.parse(current.fitmentJson)),
          active: payload.active ?? current.active,
          updatedAt: now
        })
        .where(eq(products.id, productId))
        .returning();

      await syncFacetRows(
        database.db,
        productId,
        payload.attributes ?? (JSON.parse(current.attributesJson) as FacetRecord),
        payload.fitmentDimensions ?? (JSON.parse(current.fitmentJson) as FacetRecord)
      );

      return row;
    });

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'catalog.product.updated',
      entityType: 'product',
      entityId: String(productId),
      before: { sku: current.sku, active: current.active, updatedAt: current.updatedAt },
      after: { sku: updated.sku, active: updated.active, updatedAt: updated.updatedAt },
      correlationId: actor.correlationId
    });

    catalogSearchCache.clear();
    return updated;
  } catch (error) {
    if (isSkuUniqueConflict(error)) {
      throw conflict('SKU already exists', { sku: payload.sku });
    }
    throw error;
  }
};

export const setProductActiveState = async (
  database: AppDatabase,
  productId: number,
  active: boolean,
  actor: { userId: number; correlationId: string }
) => {
  const rows = await database.db.select().from(products).where(eq(products.id, productId)).limit(1);
  const existing = rows[0];
  if (!existing) {
    throw notFound('Product not found');
  }

  const [updated] = await database.db
    .update(products)
    .set({
      active,
      updatedAt: nowEpoch()
    })
    .where(eq(products.id, productId))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: active ? 'catalog.product.activated' : 'catalog.product.deactivated',
    entityType: 'product',
    entityId: String(productId),
    before: { active: existing.active },
    after: { active: updated.active },
    correlationId: actor.correlationId
  });

  catalogSearchCache.clear();
  return updated;
};

export const getProductById = async (database: AppDatabase, productId: number) => {
  const rows = await database.db.select().from(products).where(eq(products.id, productId)).limit(1);
  const product = rows[0];
  if (!product) {
    throw notFound('Product not found');
  }
  return product;
};

export const listProducts = async (
  database: AppDatabase,
  options: { page: number; pageSize: number; category?: string; active?: boolean }
) => {
  const offset = (options.page - 1) * options.pageSize;

  const filter = and(
    options.category ? eq(products.category, options.category) : undefined,
    options.active === undefined ? undefined : eq(products.active, options.active)
  );

  const rows = await database.db
    .select()
    .from(products)
    .where(filter)
    .limit(options.pageSize)
    .offset(offset)
    .orderBy(desc(products.updatedAt));

  const [{ total }] = await database.db
    .select({ total: count() })
    .from(products)
    .where(filter);

  return {
    rows,
    total
  };
};
