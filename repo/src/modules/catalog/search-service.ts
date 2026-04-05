import type Database from 'better-sqlite3';

import type { AppDatabase } from '../../platform/db/client';

import { TtlLruCache } from './search-cache';
import type { SearchRequest } from './catalog-types';

type ProductSearchResult = {
  items: Array<{
    id: number;
    sku: string;
    name: string;
    description: string;
    category: string;
    attributes: Record<string, unknown>;
    fitmentDimensions: Record<string, unknown>;
    active: boolean;
    updatedAt: number;
    relevance: number | null;
  }>;
  meta: {
    totalMatched: number;
    page: number;
    pageSize: number;
    totalPages: number;
    appliedFilters: {
      keyword?: string;
      categories: string[];
      attributes: Record<string, string[]>;
      fitmentDimensions: Record<string, string[]>;
      active?: boolean;
    };
    sort: {
      requested: SearchRequest['sort'];
      applied: SearchRequest['sort'] | 'updated_at_desc';
    };
    suggestedTerms?: string[];
    cache: {
      hit: boolean;
      ttlSeconds: number;
    };
  };
};

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 1000;

export const catalogSearchCache = new TtlLruCache<ProductSearchResult>(SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX_ENTRIES);

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

const normalizeFilterMap = (map: Record<string, string[]>): Record<string, string[]> => {
  const normalized: Record<string, string[]> = {};
  for (const key of Object.keys(map).sort()) {
    normalized[key.trim().toLowerCase()] = [...new Set(map[key].map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  }
  return normalized;
};

const normalizeSearchRequest = (request: SearchRequest): SearchRequest => ({
  ...request,
  keyword: request.keyword?.trim(),
  filters: {
    categories: [...new Set(request.filters.categories.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort(),
    attributes: normalizeFilterMap(request.filters.attributes),
    fitmentDimensions: normalizeFilterMap(request.filters.fitmentDimensions),
    active: request.filters.active
  }
});

const buildCacheKey = (request: SearchRequest): string => JSON.stringify(normalizeSearchRequest(request));

const escapeFtsToken = (token: string): string => token.replace(/"/g, '""');

const buildFtsQuery = (keyword?: string): string | null => {
  if (!keyword) {
    return null;
  }
  const tokens = tokenize(keyword);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${escapeFtsToken(token)}"*`).join(' AND ');
};

const damerauLevenshtein = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }

  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) {
    d[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    d[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[a.length][b.length];
};

const suggestTerms = (sqlite: Database.Database, keyword?: string): string[] => {
  if (!keyword) {
    return [];
  }

  const tokens = tokenize(keyword);
  if (tokens.length === 0) {
    return [];
  }

  const suggestions = new Set<string>();
  const stmt = sqlite.prepare(
    `SELECT term, doc
     FROM products_fts_vocab
     WHERE term GLOB ?
     ORDER BY doc DESC
     LIMIT 250`
  );

  for (const token of tokens) {
    const pattern = `${token[0]}*`;
    const rows = stmt.all(pattern) as Array<{ term: string; doc: number }>;
    const best = rows
      .map((row) => ({
        term: row.term,
        distance: damerauLevenshtein(token, row.term),
        score: row.doc
      }))
      .filter((row) => row.distance > 0 && row.distance <= Math.max(2, Math.floor(token.length / 3)))
      .sort((a, b) => a.distance - b.distance || b.score - a.score)
      .slice(0, 2);

    for (const candidate of best) {
      suggestions.add(candidate.term);
      if (suggestions.size >= 5) {
        return [...suggestions];
      }
    }
  }

  return [...suggestions];
};

const buildSortClause = (requestedSort: SearchRequest['sort'], hasKeyword: boolean): { clause: string; applied: SearchRequest['sort'] | 'updated_at_desc' } => {
  if (requestedSort === 'relevance') {
    if (hasKeyword) {
      return { clause: 'relevance ASC, p.updated_at DESC', applied: 'relevance' };
    }
    return { clause: 'p.updated_at DESC', applied: 'updated_at_desc' };
  }

  const map: Record<Exclude<SearchRequest['sort'], 'relevance'>, string> = {
    name_asc: 'p.name ASC',
    name_desc: 'p.name DESC',
    sku_asc: 'p.sku ASC',
    sku_desc: 'p.sku DESC',
    updated_at_asc: 'p.updated_at ASC',
    updated_at_desc: 'p.updated_at DESC'
  };

  return { clause: map[requestedSort], applied: requestedSort };
};

export const searchProducts = (database: AppDatabase, rawRequest: SearchRequest): ProductSearchResult => {
  const request = normalizeSearchRequest(rawRequest);
  const cacheKey = buildCacheKey(request);
  const cached = catalogSearchCache.get(cacheKey);
  if (cached) {
    return {
      ...cached,
      meta: {
        ...cached.meta,
        cache: {
          hit: true,
          ttlSeconds: SEARCH_CACHE_TTL_MS / 1000
        }
      }
    };
  }

  const ftsQuery = buildFtsQuery(request.keyword);
  const hasKeyword = Boolean(ftsQuery);
  const filterClauses: string[] = [];
  const filterParams: Array<string | number> = [];

  if (request.filters.active !== undefined) {
    filterClauses.push('p.active = ?');
    filterParams.push(request.filters.active ? 1 : 0);
  }

  if (request.filters.categories.length > 0) {
    const placeholders = request.filters.categories.map(() => '?').join(',');
    filterClauses.push(`p.category IN (${placeholders})`);
    filterParams.push(...request.filters.categories);
  }

  for (const [key, values] of Object.entries(request.filters.attributes)) {
    const placeholders = values.map(() => '?').join(',');
    filterClauses.push(
      `EXISTS (
         SELECT 1 FROM product_attribute_facets paf
         WHERE paf.product_id = p.id
           AND paf.key = ?
           AND paf.value_norm IN (${placeholders})
       )`
    );
    filterParams.push(key, ...values);
  }

  for (const [dimension, values] of Object.entries(request.filters.fitmentDimensions)) {
    const placeholders = values.map(() => '?').join(',');
    filterClauses.push(
      `EXISTS (
         SELECT 1 FROM product_fitment_facets pff
         WHERE pff.product_id = p.id
           AND pff.dimension = ?
           AND pff.value_norm IN (${placeholders})
       )`
    );
    filterParams.push(dimension, ...values);
  }

  const selectWhereClauses = hasKeyword ? ['products_fts MATCH ?', ...filterClauses] : [...filterClauses];
  const selectParams: Array<string | number> = hasKeyword ? [ftsQuery as string, ...filterParams] : [...filterParams];

  const selectWhereSql = selectWhereClauses.length > 0 ? `WHERE ${selectWhereClauses.join(' AND ')}` : '';
  const selectSourceSql = hasKeyword
    ? 'FROM products p INNER JOIN products_fts ON products_fts.rowid = p.id'
    : 'FROM products p';

  const countWhereClauses = hasKeyword
    ? ['p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)', ...filterClauses]
    : [...filterClauses];
  const countParams: Array<string | number> = hasKeyword ? [ftsQuery as string, ...filterParams] : [...filterParams];
  const countWhereSql = countWhereClauses.length > 0 ? `WHERE ${countWhereClauses.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) AS total FROM products p ${countWhereSql}`;
  const totalRow = database.sqlite.prepare(countSql).get(...countParams) as { total: number };
  const totalMatched = Number(totalRow.total ?? 0);

  const sort = buildSortClause(request.sort, hasKeyword);
  const offset = (request.page - 1) * request.pageSize;

  const selectSql = `
    SELECT
      p.id,
      p.sku,
      p.name,
      p.description,
      p.category,
      p.attributes_json,
      p.fitment_json,
      p.active,
      p.updated_at,
      ${hasKeyword ? 'bm25(products_fts) as relevance' : 'NULL as relevance'}
    ${selectSourceSql}
    ${selectWhereSql}
    ORDER BY ${sort.clause}
    LIMIT ? OFFSET ?`;

  const rows = database.sqlite.prepare(selectSql).all(...selectParams, request.pageSize, offset) as Array<{
    id: number;
    sku: string;
    name: string;
    description: string;
    category: string;
    attributes_json: string;
    fitment_json: string;
    active: number;
    updated_at: number;
    relevance: number | null;
  }>;

  const suggestedTerms = request.includeSuggestedTerms ? suggestTerms(database.sqlite, request.keyword) : [];

  const result: ProductSearchResult = {
    items: rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      category: row.category,
      attributes: JSON.parse(row.attributes_json),
      fitmentDimensions: JSON.parse(row.fitment_json),
      active: Boolean(row.active),
      updatedAt: row.updated_at,
      relevance: row.relevance
    })),
    meta: {
      totalMatched,
      page: request.page,
      pageSize: request.pageSize,
      totalPages: totalMatched === 0 ? 0 : Math.ceil(totalMatched / request.pageSize),
      appliedFilters: {
        keyword: request.keyword,
        categories: request.filters.categories,
        attributes: request.filters.attributes,
        fitmentDimensions: request.filters.fitmentDimensions,
        active: request.filters.active
      },
      sort: {
        requested: request.sort,
        applied: sort.applied
      },
      suggestedTerms: suggestedTerms.length > 0 ? suggestedTerms : undefined,
      cache: {
        hit: false,
        ttlSeconds: SEARCH_CACHE_TTL_MS / 1000
      }
    }
  };

  catalogSearchCache.set(cacheKey, result);
  return result;
};
