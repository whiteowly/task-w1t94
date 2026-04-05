import { randomUUID } from 'node:crypto';

import { createDatabase, type AppDatabase } from '../platform/db/client';
import { loadConfig } from '../platform/config';
import { runMigrations } from '../platform/db/migrate';
import { searchProducts } from '../modules/catalog/search-service';
import { catalogSearchCache } from '../modules/catalog/search-service';

const nowEpoch = () => Math.floor(Date.now() / 1000);
const BENCH_SKU_PREFIX = 'PERF50K';
const TOKEN_BUCKET_COUNT = 200;

const tokenForIndex = (index: number): string => `kw${String(index % TOKEN_BUCKET_COUNT).padStart(3, '0')}`;

const parseNumberArg = (name: string, fallback: number, minimum: number): number => {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (!arg) {
    return fallback;
  }

  const parsed = Number(arg.split('=')[1]);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return Math.floor(parsed);
};

const parseBooleanArg = (name: string, fallback: boolean): boolean => {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  if (!arg) {
    return fallback;
  }

  const value = arg.split('=')[1]?.toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  return fallback;
};

const percentile = (sorted: number[], p: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
};

const buildScenario = (iteration: number) => {
  const category = iteration % 2 === 0 ? 'gear' : 'apparel';
  const color = iteration % 2 === 0 ? 'black' : 'red';
  const frame = iteration % 2 === 0 ? 'medium' : 'large';
  const size = iteration % 3 === 0 ? 'm' : 'l';
  const keyword = tokenForIndex(iteration + 37);

  return {
    keyword,
    filters: {
      categories: [category],
      attributes: {
        color: [color],
        size: [size]
      },
      fitmentDimensions: {
        frame: [frame]
      },
      active: true
    },
    page: 1,
    pageSize: 20,
    sort: 'relevance' as const,
    includeSuggestedTerms: false
  };
};

const ensureBenchmarkDataset = (database: AppDatabase, productCount: number): void => {
  const existing = database.sqlite
    .prepare(`SELECT COUNT(*) as count FROM products WHERE sku GLOB '${BENCH_SKU_PREFIX}-[0-9]*'`)
    .get() as { count: number };

  if (existing.count >= productCount) {
    return;
  }

  const maxIndexRow = database.sqlite
    .prepare(
      `SELECT MAX(CAST(SUBSTR(sku, ${BENCH_SKU_PREFIX.length + 2}) AS INTEGER)) as max_index
       FROM products
       WHERE sku GLOB '${BENCH_SKU_PREFIX}-[0-9]*'`
    )
    .get() as { max_index: number | null };

  const startIndex = maxIndexRow.max_index === null ? 0 : maxIndexRow.max_index + 1;
  const now = nowEpoch();

  const insertProduct = database.sqlite.prepare(
    `INSERT INTO products (sku, name, description, category, attributes_json, fitment_json, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAttributeFacet = database.sqlite.prepare(
    `INSERT INTO product_attribute_facets (product_id, key, value_norm)
     VALUES (?, ?, ?)`
  );

  const insertFitmentFacet = database.sqlite.prepare(
    `INSERT INTO product_fitment_facets (product_id, dimension, value_norm)
     VALUES (?, ?, ?)`
  );

  const seedTx = database.sqlite.transaction((from: number, toExclusive: number) => {
    for (let index = from; index < toExclusive; index += 1) {
      const color = index % 2 === 0 ? 'black' : 'red';
      const size = index % 3 === 0 ? 'm' : 'l';
      const frame = index % 2 === 0 ? 'medium' : 'large';
      const keywordToken = tokenForIndex(index);
      const productInfo = insertProduct.run(
        `${BENCH_SKU_PREFIX}-${index}`,
        `Performance item ${keywordToken} ${index}`,
        `Facility catalog benchmark token ${keywordToken} descriptor ${index}`,
        index % 2 === 0 ? 'gear' : 'apparel',
        JSON.stringify({ color, size }),
        JSON.stringify({ frame }),
        1,
        now,
        now
      );

      const productId = Number(productInfo.lastInsertRowid);
      insertAttributeFacet.run(productId, 'color', color);
      insertAttributeFacet.run(productId, 'size', size);
      insertFitmentFacet.run(productId, 'frame', frame);
    }
  });

  const batchSize = 5000;
  for (let offset = startIndex; offset < productCount; offset += batchSize) {
    const toExclusive = Math.min(offset + batchSize, productCount);
    seedTx(offset, toExclusive);
  }
};

const main = async (): Promise<void> => {
  const productCount = parseNumberArg('products', 5000, 100);
  const warmupCount = parseNumberArg('warmup', 10, 0);
  const sampleCount = parseNumberArg('samples', 50, 10);
  const clearCacheBeforeSample = parseBooleanArg('clear-cache-per-sample', true);
  const targetMedianMs = parseNumberArg('target-median-ms', 200, 1);
  const config = loadConfig();
  const database = createDatabase({ databaseUrl: config.databaseUrl });

  try {
    runMigrations(database);

    ensureBenchmarkDataset(database, productCount);

    for (let i = 0; i < warmupCount; i += 1) {
      catalogSearchCache.clear();
      searchProducts(database, buildScenario(i));
    }

    const uncachedDurations: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      if (clearCacheBeforeSample) {
        catalogSearchCache.clear();
      }

      const start = process.hrtime.bigint();
      searchProducts(database, buildScenario(i + warmupCount));
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      uncachedDurations.push(elapsedMs);
    }

    catalogSearchCache.clear();
    const cachedDurations: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const scenario = buildScenario(i + warmupCount + sampleCount + 2000);
      searchProducts(database, scenario);
      const start = process.hrtime.bigint();
      searchProducts(database, scenario);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      cachedDurations.push(elapsedMs);
    }

    uncachedDurations.sort((a, b) => a - b);
    cachedDurations.sort((a, b) => a - b);
    const uncachedMedian = uncachedDurations[Math.floor(uncachedDurations.length / 2)];
    const uncachedP95 = percentile(uncachedDurations, 95);
    const cachedMedian = cachedDurations[Math.floor(cachedDurations.length / 2)];

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        benchmarkId: randomUUID(),
        products: productCount,
        targetMedianMs,
        uncachedMedianMs: Number(uncachedMedian.toFixed(2)),
        uncachedP95Ms: Number(uncachedP95.toFixed(2)),
        cachedMedianMs: Number(cachedMedian.toFixed(2)),
        sampleCount,
        warmupCount,
        clearCachePerSample: clearCacheBeforeSample,
        targetMet: uncachedMedian <= targetMedianMs
      })
    );
  } finally {
    database.close();
  }
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
