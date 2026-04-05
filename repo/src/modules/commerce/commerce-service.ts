import { and, count, desc, eq, isNull, lte, sql, sum } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import { conflict, forbidden, notFound, validationFailed } from '../../platform/errors/app-error';
import { encryptSensitive } from '../../platform/crypto/aes-gcm';
import type { AppConfig } from '../../platform/config';
import type { AppDatabase } from '../../platform/db/client';
import {
  orderIdempotencyKeys,
  orderLines,
  orders,
  payments,
  promotionRedemptions,
  promotions,
  vouchers
} from '../../platform/db/schema';
import type { UserRole } from '../../platform/db/schema';

import { localDateTimeToUtcEpoch } from './local-time';

const nowEpoch = () => Math.floor(Date.now() / 1000);
const DAY_SECONDS = 24 * 3600;
const DRAFT_TTL_SECONDS = 30 * 60;

type LineItemInput = {
  lineType: string;
  sku?: string;
  description: string;
  category?: string;
  courseCategory?: string;
  classInstanceId?: number;
  quantity: number;
  unitPriceMinor: number;
};

type QuoteInput = {
  customerId?: string;
  membershipTier?: string;
  voucherCode?: string;
  taxRateBasisPoints: number;
  depositMinor: number;
  items: LineItemInput[];
};

type PromotionRow = typeof promotions.$inferSelect;

type PromotionRulePayload = {
  selectors?: Record<string, unknown>;
  rule?: Record<string, unknown>;
};

type OfferCandidate = {
  source: 'promotion' | 'voucher';
  promotionId?: number;
  voucherCode?: string;
  type: string;
  stackability: 'exclusive' | 'stackable';
  priority: number;
  savingsMinor: number;
  reason: string;
};

type QuoteResult = {
  quoteInput: QuoteInput;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  depositMinor: number;
  totalMinor: number;
  balanceMinor: number;
  appliedStrategy: 'none' | 'exclusive' | 'stackable_combo';
  appliedOffers: OfferCandidate[];
  consideredOffers: OfferCandidate[];
  lineItems: Array<{
    lineType: string;
    sku?: string;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    lineSubtotalMinor: number;
  }>;
};

type CreateOrderResult = {
  order: typeof orders.$inferSelect;
  lines: typeof orderLines.$inferSelect[];
  pricing: QuoteResult;
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

const isUniqueConstraint = (error: unknown, hint: string): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const coded = error as Error & { code?: string };
  return coded.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes(hint);
};

const parsePromotionPayload = (row: PromotionRow): { selectors: Record<string, unknown>; rule: Record<string, unknown> } => {
  const parsed = JSON.parse(row.applicabilitySelectorsJson) as PromotionRulePayload | Record<string, unknown>;
  const selectors =
    (parsed as PromotionRulePayload).selectors && typeof (parsed as PromotionRulePayload).selectors === 'object'
      ? ((parsed as PromotionRulePayload).selectors as Record<string, unknown>)
      : (parsed as Record<string, unknown>);

  const rule =
    (parsed as PromotionRulePayload).rule && typeof (parsed as PromotionRulePayload).rule === 'object'
      ? ((parsed as PromotionRulePayload).rule as Record<string, unknown>)
      : {};

  return { selectors, rule };
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0) : [];

const asNumberArray = (value: unknown): number[] =>
  Array.isArray(value)
    ? value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0)
    : [];

const toInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const selectMatchingLineItems = (items: LineItemInput[], selectors: Record<string, unknown>) => {
  const selectorSkus = new Set(asStringArray(selectors.skus));
  const selectorProductCategories = new Set(asStringArray(selectors.productCategories));
  const selectorCourseCategories = new Set(asStringArray(selectors.courseCategories));
  const selectorClassInstances = new Set(asNumberArray(selectors.classInstanceIds));
  const selectorLineTypes = new Set(asStringArray(selectors.lineTypes));
  const selectorCharging = selectors.applyToCharging === true;

  const hasLineConstraint =
    selectorSkus.size > 0 ||
    selectorProductCategories.size > 0 ||
    selectorCourseCategories.size > 0 ||
    selectorClassInstances.size > 0 ||
    selectorLineTypes.size > 0 ||
    selectorCharging;

  if (!hasLineConstraint) {
    return items;
  }

  return items.filter((item) => {
    const matchesSku = selectorSkus.size === 0 || (item.sku ? selectorSkus.has(item.sku) : false);
    const matchesCategory =
      selectorProductCategories.size === 0 || (item.category ? selectorProductCategories.has(item.category) : false);
    const matchesCourseCategory =
      selectorCourseCategories.size === 0 ||
      (item.courseCategory ? selectorCourseCategories.has(item.courseCategory) : false);
    const matchesClassInstance =
      selectorClassInstances.size === 0 ||
      (item.classInstanceId !== undefined ? selectorClassInstances.has(item.classInstanceId) : false);
    const matchesLineType = selectorLineTypes.size === 0 || selectorLineTypes.has(item.lineType);
    const matchesCharging = !selectorCharging || item.lineType === 'charging';

    return (
      matchesSku &&
      matchesCategory &&
      matchesCourseCategory &&
      matchesClassInstance &&
      matchesLineType &&
      matchesCharging
    );
  });
};

const computeLineSubtotal = (item: LineItemInput): number => item.quantity * item.unitPriceMinor;

const sumMinor = (values: number[]): number => values.reduce((acc, value) => acc + value, 0);

const ensurePromotionDateWindow = (validFromLocal: string, validToLocal: string) => {
  if (validToLocal <= validFromLocal) {
    throw validationFailed('Promotion local validity window is invalid', {
      validFromLocal,
      validToLocal
    });
  }
};

const cleanupExpiredIdempotency = async (database: AppDatabase) => {
  await database.db.delete(orderIdempotencyKeys).where(lte(orderIdempotencyKeys.expiresAt, nowEpoch()));
};

const claimIdempotencyKey = async (database: AppDatabase, key: string, orderId: number | null): Promise<void> => {
  await cleanupExpiredIdempotency(database);
  try {
    await database.db.insert(orderIdempotencyKeys).values({
      key,
      orderId,
      expiresAt: nowEpoch() + DAY_SECONDS,
      createdAt: nowEpoch()
    });
  } catch (error) {
    if (isUniqueConstraint(error, 'order_idempotency_keys.key')) {
      const existing = await database.db
        .select({ key: orderIdempotencyKeys.key, orderId: orderIdempotencyKeys.orderId, expiresAt: orderIdempotencyKeys.expiresAt })
        .from(orderIdempotencyKeys)
        .where(eq(orderIdempotencyKeys.key, key))
        .limit(1);
      const row = existing[0];
      throw conflict('Idempotency key is already in use', {
        key,
        orderId: row?.orderId ?? null,
        expiresAt: row?.expiresAt ?? null
      });
    }
    throw error;
  }
};

const getPromotionRedemptionCount = async (database: AppDatabase, promotionId: number, customerId: string): Promise<number> => {
  const [row] = await database.db
    .select({ total: count() })
    .from(promotionRedemptions)
    .where(and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.customerId, customerId)));
  return row.total;
};

const evaluatePromotionOffer = async (
  database: AppDatabase,
  row: PromotionRow,
  quoteInput: QuoteInput,
  subtotalMinor: number,
  now: number,
  customerKey: string,
  voucherCode?: string
): Promise<OfferCandidate | null> => {
  if (!row.active) {
    return null;
  }
  if (now < row.validFromUtcEpoch || now > row.validToUtcEpoch) {
    return null;
  }

  const redemptionCount = await getPromotionRedemptionCount(database, row.id, customerKey);
  if (redemptionCount >= row.maxRedemptionsPerUser) {
    return null;
  }

  const { selectors, rule } = parsePromotionPayload(row);
  const matchingItems = selectMatchingLineItems(quoteInput.items, selectors);
  if (matchingItems.length === 0 && quoteInput.items.length > 0) {
    const hasLineSelector =
      asStringArray(selectors.skus).length > 0 ||
      asStringArray(selectors.productCategories).length > 0 ||
      asStringArray(selectors.courseCategories).length > 0 ||
      asNumberArray(selectors.classInstanceIds).length > 0 ||
      asStringArray(selectors.lineTypes).length > 0 ||
      selectors.applyToCharging === true;
    if (hasLineSelector) {
      return null;
    }
  }

  const selectorMembershipTiers = asStringArray(selectors.membershipTiers);
  if (selectorMembershipTiers.length > 0 && (!quoteInput.membershipTier || !selectorMembershipTiers.includes(quoteInput.membershipTier))) {
    return null;
  }

  const selectorVoucherCodes = asStringArray(selectors.voucherCodes);
  if (selectorVoucherCodes.length > 0) {
    if (!voucherCode || !selectorVoucherCodes.includes(voucherCode)) {
      return null;
    }
  }

  const selectorMinOrderSpendMinor = selectors.minOrderSpendMinor === undefined ? undefined : toInt(selectors.minOrderSpendMinor);
  if (selectorMinOrderSpendMinor !== undefined && subtotalMinor < selectorMinOrderSpendMinor) {
    return null;
  }

  const eligibleSubtotal = sumMinor(matchingItems.map(computeLineSubtotal));
  if (eligibleSubtotal <= 0) {
    return null;
  }

  let savingsMinor = 0;

  switch (row.type) {
    case 'spend_and_save': {
      const minSpendMinor = toInt(rule.minSpendMinor);
      const discountAmountMinor = toInt(rule.discountAmountMinor);
      if (eligibleSubtotal >= minSpendMinor && discountAmountMinor > 0) {
        savingsMinor = discountAmountMinor;
      }
      break;
    }
    case 'percentage_discount': {
      const percentBasisPoints = toInt(rule.percentBasisPoints);
      if (percentBasisPoints > 0) {
        savingsMinor = Math.floor((eligibleSubtotal * percentBasisPoints) / 10000);
      }
      break;
    }
    case 'amount_discount': {
      const discountAmountMinor = toInt(rule.discountAmountMinor);
      if (discountAmountMinor > 0) {
        savingsMinor = discountAmountMinor;
      }
      break;
    }
    case 'bundle': {
      const bundleSku = String(rule.bundleSku ?? '');
      const requiredQuantity = Math.max(1, toInt(rule.requiredQuantity));
      const discountAmountMinor = Math.max(0, toInt(rule.discountAmountMinor));
      if (bundleSku && discountAmountMinor > 0) {
        const skuQty = matchingItems
          .filter((item) => item.sku === bundleSku)
          .reduce((acc, item) => acc + item.quantity, 0);
        const bundleCount = Math.floor(skuQty / requiredQuantity);
        savingsMinor = bundleCount * discountAmountMinor;
      }
      break;
    }
    case 'member_pricing_tier': {
      if (!quoteInput.membershipTier) {
        savingsMinor = 0;
        break;
      }

      const tierDiscounts = (rule.tierDiscounts ?? {}) as Record<string, unknown>;
      const tierRule = (tierDiscounts[quoteInput.membershipTier] ?? {}) as Record<string, unknown>;
      const tierAmountMinor = toInt(tierRule.amountMinor);
      const tierPercentBasisPoints = toInt(tierRule.percentBasisPoints);

      if (tierAmountMinor > 0) {
        savingsMinor = tierAmountMinor;
      } else if (tierPercentBasisPoints > 0) {
        savingsMinor = Math.floor((eligibleSubtotal * tierPercentBasisPoints) / 10000);
      }
      break;
    }
    case 'voucher': {
      if (!voucherCode) {
        return null;
      }
      const discountAmountMinor = toInt(rule.discountAmountMinor);
      const percentBasisPoints = toInt(rule.percentBasisPoints);
      if (discountAmountMinor > 0) {
        savingsMinor = discountAmountMinor;
      } else if (percentBasisPoints > 0) {
        savingsMinor = Math.floor((eligibleSubtotal * percentBasisPoints) / 10000);
      }
      break;
    }
    default:
      savingsMinor = 0;
  }

  savingsMinor = Math.max(0, Math.min(savingsMinor, subtotalMinor));
  if (savingsMinor <= 0) {
    return null;
  }

  return {
    source: 'promotion',
    promotionId: row.id,
    type: row.type,
    stackability: row.stackability as 'exclusive' | 'stackable',
    priority: row.priority,
    savingsMinor,
    reason: `promotion:${row.name}`
  };
};

const evaluateQuote = async (
  database: AppDatabase,
  quoteInput: QuoteInput,
  now: number,
  enforceVoucherUsability: boolean
): Promise<QuoteResult> => {
  const customerKey = quoteInput.customerId ?? '__guest__';
  const lineSubtotals = quoteInput.items.map((item) => computeLineSubtotal(item));
  const subtotalMinor = sumMinor(lineSubtotals);

  const activePromotions = await database.db
    .select()
    .from(promotions)
    .where(eq(promotions.active, true));

  const consideredOffers: OfferCandidate[] = [];

  for (const row of activePromotions) {
    const offer = await evaluatePromotionOffer(
      database,
      row,
      quoteInput,
      subtotalMinor,
      now,
      customerKey,
      quoteInput.voucherCode
    );
    if (offer) {
      consideredOffers.push(offer);
    }
  }

  let voucherRow: typeof vouchers.$inferSelect | null = null;
  if (quoteInput.voucherCode) {
    const found = await database.db
      .select()
      .from(vouchers)
      .where(eq(vouchers.code, quoteInput.voucherCode))
      .limit(1);
    voucherRow = found[0] ?? null;

    if (!voucherRow) {
      throw conflict('Voucher does not exist', { voucherCode: quoteInput.voucherCode });
    }
    if (voucherRow.redeemedAt) {
      throw conflict('Voucher has already been redeemed', { voucherCode: quoteInput.voucherCode });
    }
    if (now > voucherRow.expirationUtcEpoch) {
      throw conflict('Voucher is expired', { voucherCode: quoteInput.voucherCode });
    }
    if (voucherRow.customerBinding && quoteInput.customerId !== voucherRow.customerBinding) {
      throw conflict('Voucher is bound to a different customer', {
        voucherCode: quoteInput.voucherCode
      });
    }

    if (!voucherRow.promotionId && enforceVoucherUsability) {
      throw conflict('Voucher is not linked to a voucher promotion', {
        voucherCode: quoteInput.voucherCode
      });
    }
  }

  const stackableOffers = consideredOffers.filter((offer) => offer.stackability === 'stackable');
  const exclusiveOffers = consideredOffers.filter((offer) => offer.stackability === 'exclusive');

  const stackableSavings = Math.min(subtotalMinor, sumMinor(stackableOffers.map((offer) => offer.savingsMinor)));

  const bestExclusive = [...exclusiveOffers].sort((a, b) => b.savingsMinor - a.savingsMinor || a.priority - b.priority)[0] ?? null;

  let appliedOffers: OfferCandidate[] = [];
  let appliedStrategy: QuoteResult['appliedStrategy'] = 'none';
  let discountMinor = 0;

  if (bestExclusive && bestExclusive.savingsMinor > stackableSavings) {
    appliedOffers = [bestExclusive];
    appliedStrategy = 'exclusive';
    discountMinor = bestExclusive.savingsMinor;
  } else if (stackableOffers.length > 0 && stackableSavings > 0) {
    appliedOffers = stackableOffers;
    appliedStrategy = 'stackable_combo';
    discountMinor = stackableSavings;
  } else if (bestExclusive) {
    appliedOffers = [bestExclusive];
    appliedStrategy = 'exclusive';
    discountMinor = bestExclusive.savingsMinor;
  }

  discountMinor = Math.min(discountMinor, subtotalMinor);

  const taxMinor = Math.floor(((subtotalMinor - discountMinor) * quoteInput.taxRateBasisPoints) / 10000);
  const totalMinor = subtotalMinor - discountMinor + taxMinor + quoteInput.depositMinor;

  return {
    quoteInput,
    subtotalMinor,
    discountMinor,
    taxMinor,
    depositMinor: quoteInput.depositMinor,
    totalMinor,
    balanceMinor: totalMinor,
    appliedStrategy,
    appliedOffers,
    consideredOffers,
    lineItems: quoteInput.items.map((item) => ({
      lineType: item.lineType,
      sku: item.sku,
      description: item.description,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      lineSubtotalMinor: computeLineSubtotal(item)
    }))
  };
};

export const createPromotion = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'facilityTimezone'>,
  payload: {
    name: string;
    type: string;
    priority: number;
    stackability: 'exclusive' | 'stackable';
    maxRedemptionsPerUser: number;
    validFromLocal: string;
    validToLocal: string;
    applicabilitySelectors: Record<string, unknown>;
    rule: Record<string, unknown>;
    active: boolean;
  },
  actor: { userId: number; correlationId: string }
) => {
  ensurePromotionDateWindow(payload.validFromLocal, payload.validToLocal);
  const validFromUtcEpoch = localDateTimeToUtcEpoch(payload.validFromLocal, config.facilityTimezone);
  const validToUtcEpoch = localDateTimeToUtcEpoch(payload.validToLocal, config.facilityTimezone);

  const [created] = await database.db
    .insert(promotions)
    .values({
      name: payload.name,
      type: payload.type,
      priority: payload.priority,
      stackability: payload.stackability,
      maxRedemptionsPerUser: payload.maxRedemptionsPerUser,
      validFromLocal: payload.validFromLocal,
      validToLocal: payload.validToLocal,
      validFromUtcEpoch,
      validToUtcEpoch,
      applicabilitySelectorsJson: JSON.stringify({ selectors: payload.applicabilitySelectors, rule: payload.rule }),
      active: payload.active,
      createdAt: nowEpoch(),
      updatedAt: nowEpoch()
    })
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.promotion.created',
    entityType: 'promotion',
    entityId: String(created.id),
    before: null,
    after: { id: created.id, type: created.type, priority: created.priority },
    correlationId: actor.correlationId
  });

  return created;
};

export const updatePromotion = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'facilityTimezone'>,
  promotionId: number,
  payload: Partial<{
    name: string;
    type: string;
    priority: number;
    stackability: 'exclusive' | 'stackable';
    maxRedemptionsPerUser: number;
    validFromLocal: string;
    validToLocal: string;
    applicabilitySelectors: Record<string, unknown>;
    rule: Record<string, unknown>;
    active: boolean;
  }>,
  actor: { userId: number; correlationId: string }
) => {
  const rows = await database.db.select().from(promotions).where(eq(promotions.id, promotionId)).limit(1);
  const current = rows[0];
  if (!current) {
    throw notFound('Promotion not found');
  }

  const existingPayload = parsePromotionPayload(current);
  const nextValidFromLocal = payload.validFromLocal ?? current.validFromLocal;
  const nextValidToLocal = payload.validToLocal ?? current.validToLocal;
  ensurePromotionDateWindow(nextValidFromLocal, nextValidToLocal);

  const [updated] = await database.db
    .update(promotions)
    .set({
      name: payload.name ?? current.name,
      type: payload.type ?? current.type,
      priority: payload.priority ?? current.priority,
      stackability: payload.stackability ?? (current.stackability as 'exclusive' | 'stackable'),
      maxRedemptionsPerUser: payload.maxRedemptionsPerUser ?? current.maxRedemptionsPerUser,
      validFromLocal: nextValidFromLocal,
      validToLocal: nextValidToLocal,
      validFromUtcEpoch: localDateTimeToUtcEpoch(nextValidFromLocal, config.facilityTimezone),
      validToUtcEpoch: localDateTimeToUtcEpoch(nextValidToLocal, config.facilityTimezone),
      applicabilitySelectorsJson: JSON.stringify({
        selectors: payload.applicabilitySelectors ?? existingPayload.selectors,
        rule: payload.rule ?? existingPayload.rule
      }),
      active: payload.active ?? current.active,
      updatedAt: nowEpoch()
    })
    .where(eq(promotions.id, promotionId))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.promotion.updated',
    entityType: 'promotion',
    entityId: String(promotionId),
    before: { priority: current.priority, active: current.active },
    after: { priority: updated.priority, active: updated.active },
    correlationId: actor.correlationId
  });

  return updated;
};

export const getPromotion = async (database: AppDatabase, promotionId: number) => {
  const rows = await database.db.select().from(promotions).where(eq(promotions.id, promotionId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw notFound('Promotion not found');
  }
  return row;
};

export const listPromotions = async (
  database: AppDatabase,
  query: { page: number; pageSize: number; type?: string; active?: boolean }
) => {
  const filter = and(
    query.type ? eq(promotions.type, query.type) : undefined,
    query.active === undefined ? undefined : eq(promotions.active, query.active)
  );

  const [totalRow] = await database.db.select({ total: count() }).from(promotions).where(filter);
  const rows = await database.db
    .select()
    .from(promotions)
    .where(filter)
    .orderBy(desc(promotions.updatedAt), promotions.priority)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { rows, total: totalRow.total };
};

export const createVoucher = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'facilityTimezone'>,
  payload: {
    code: string;
    promotionId?: number;
    customerBinding?: string;
    expirationLocal: string;
  },
  actor: { userId: number; correlationId: string }
) => {
  if (payload.promotionId) {
    const linked = await database.db
      .select({ id: promotions.id, type: promotions.type })
      .from(promotions)
      .where(eq(promotions.id, payload.promotionId))
      .limit(1);
    const promo = linked[0];
    if (!promo) {
      throw notFound('Linked promotion not found');
    }
    if (promo.type !== 'voucher') {
      throw conflict('Voucher must link to a voucher-type promotion', { promotionId: payload.promotionId });
    }
  }

  const expirationUtcEpoch = localDateTimeToUtcEpoch(payload.expirationLocal, config.facilityTimezone);

  try {
    const [created] = await database.db
      .insert(vouchers)
      .values({
        code: payload.code,
        promotionId: payload.promotionId,
        customerBinding: payload.customerBinding,
        expirationLocal: payload.expirationLocal,
        expirationUtcEpoch,
        createdAt: nowEpoch()
      })
      .returning();

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'commerce.voucher.created',
      entityType: 'voucher',
      entityId: String(created.id),
      before: null,
      after: { code: created.code, promotionId: created.promotionId },
      correlationId: actor.correlationId
    });

    return created;
  } catch (error) {
    if (isUniqueConstraint(error, 'vouchers_code_unique') || isUniqueConstraint(error, 'UNIQUE constraint failed: vouchers.code')) {
      throw conflict('Voucher code already exists', { code: payload.code });
    }
    throw error;
  }
};

export const updateVoucher = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'facilityTimezone'>,
  voucherId: number,
  payload: Partial<{
    promotionId: number | null;
    customerBinding: string | null;
    expirationLocal: string;
  }>,
  actor: { userId: number; correlationId: string }
) => {
  const rows = await database.db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
  const current = rows[0];
  if (!current) {
    throw notFound('Voucher not found');
  }

  const nextPromotionId = payload.promotionId === undefined ? current.promotionId : payload.promotionId;
  if (nextPromotionId) {
    const linked = await database.db
      .select({ id: promotions.id, type: promotions.type })
      .from(promotions)
      .where(eq(promotions.id, nextPromotionId))
      .limit(1);
    const promo = linked[0];
    if (!promo) {
      throw notFound('Linked promotion not found');
    }
    if (promo.type !== 'voucher') {
      throw conflict('Voucher must link to a voucher-type promotion', { promotionId: nextPromotionId });
    }
  }

  const nextExpirationLocal = payload.expirationLocal ?? current.expirationLocal;

  const [updated] = await database.db
    .update(vouchers)
    .set({
      promotionId: nextPromotionId,
      customerBinding: payload.customerBinding === undefined ? current.customerBinding : payload.customerBinding,
      expirationLocal: nextExpirationLocal,
      expirationUtcEpoch: localDateTimeToUtcEpoch(nextExpirationLocal, config.facilityTimezone)
    })
    .where(eq(vouchers.id, voucherId))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.voucher.updated',
    entityType: 'voucher',
    entityId: String(voucherId),
    before: { promotionId: current.promotionId, expirationLocal: current.expirationLocal },
    after: { promotionId: updated.promotionId, expirationLocal: updated.expirationLocal },
    correlationId: actor.correlationId
  });

  return updated;
};

export const getVoucher = async (database: AppDatabase, voucherId: number) => {
  const rows = await database.db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
  const row = rows[0];
  if (!row) {
    throw notFound('Voucher not found');
  }
  return row;
};

export const listVouchers = async (
  database: AppDatabase,
  query: { page: number; pageSize: number; customerBinding?: string; redeemed?: boolean }
) => {
  const filter = and(
    query.customerBinding ? eq(vouchers.customerBinding, query.customerBinding) : undefined,
    query.redeemed === undefined
      ? undefined
      : query.redeemed
        ? sql`${vouchers.redeemedAt} is not null`
        : isNull(vouchers.redeemedAt)
  );

  const [totalRow] = await database.db.select({ total: count() }).from(vouchers).where(filter);
  const rows = await database.db
    .select()
    .from(vouchers)
    .where(filter)
    .orderBy(desc(vouchers.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { rows, total: totalRow.total };
};

export const quoteOrder = async (database: AppDatabase, input: QuoteInput): Promise<QuoteResult> => {
  return evaluateQuote(database, input, nowEpoch(), true);
};

export const createDraftOrder = async (
  database: AppDatabase,
  idempotencyKey: string,
  input: QuoteInput,
  actor: { userId: number; correlationId: string }
): Promise<CreateOrderResult> => {
  const created = await withSqliteTransaction(database, async () => {
    await claimIdempotencyKey(database, idempotencyKey, null);

    const quote = await evaluateQuote(database, input, nowEpoch(), true);

    const [order] = await database.db
      .insert(orders)
      .values({
        idempotencyKey,
        status: 'draft',
        customerId: input.customerId,
        subtotalMinor: quote.subtotalMinor,
        discountMinor: quote.discountMinor,
        taxMinor: quote.taxMinor,
        depositMinor: quote.depositMinor,
        balanceMinor: quote.totalMinor,
        totalMinor: quote.totalMinor,
        pricingBreakdownJson: JSON.stringify(quote),
        draftExpiresAt: nowEpoch() + DRAFT_TTL_SECONDS,
        createdByUserId: actor.userId,
        createdAt: nowEpoch(),
        updatedAt: nowEpoch()
      })
      .returning();

    const lineRows = input.items.map((item) => ({
      orderId: order.id,
      lineType: item.lineType,
      sku: item.sku,
      description: item.description,
      quantity: item.quantity,
      unitAmountMinor: item.unitPriceMinor,
      lineAmountMinor: computeLineSubtotal(item)
    }));

    const lines = await database.db.insert(orderLines).values(lineRows).returning();

    await database.db
      .update(orderIdempotencyKeys)
      .set({ orderId: order.id })
      .where(eq(orderIdempotencyKeys.key, idempotencyKey));

    return { order, lines, quote };
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.order.created',
    entityType: 'order',
    entityId: String(created.order.id),
    before: null,
    after: { id: created.order.id, status: created.order.status, totalMinor: created.order.totalMinor },
    correlationId: actor.correlationId
  });

  return {
    order: created.order,
    lines: created.lines,
    pricing: created.quote
  };
};

const sumPaymentsForOrder = async (database: AppDatabase, orderId: number): Promise<number> => {
  const [row] = await database.db
    .select({ total: sum(payments.amountMinor) })
    .from(payments)
    .where(eq(payments.orderId, orderId));
  return Number(row.total ?? 0);
};

const assertOrderAccess = (
  order: typeof orders.$inferSelect,
  actor: { userId: number; role: UserRole }
): void => {
  if (actor.role === 'sales_associate' && order.createdByUserId !== actor.userId) {
    throw forbidden('Order is not accessible to this sales associate');
  }
};

export const finalizeOrder = async (
  database: AppDatabase,
  idempotencyKey: string,
  orderId: number,
  overrideVoucherCode: string | undefined,
  actor: { userId: number; role: UserRole; correlationId: string }
) => {
  const finalized = await withSqliteTransaction(database, async () => {
    const rows = await database.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const order = rows[0];
    if (!order) {
      throw notFound('Order not found');
    }

    assertOrderAccess(order, actor);

    if (order.status !== 'draft') {
      throw conflict('Only draft orders can be finalized', { status: order.status });
    }
    if (order.draftExpiresAt && order.draftExpiresAt <= nowEpoch()) {
      throw conflict('Draft order has expired and must be recreated');
    }

    await claimIdempotencyKey(database, idempotencyKey, order.id);

    const breakdown = JSON.parse(order.pricingBreakdownJson) as QuoteResult;
    const quoteInput: QuoteInput = {
      ...breakdown.quoteInput,
      voucherCode: overrideVoucherCode ?? breakdown.quoteInput.voucherCode
    };

    const recalculated = await evaluateQuote(database, quoteInput, nowEpoch(), true);

    const voucherAppliedInOutcome = recalculated.appliedOffers.some((offer) => offer.type === 'voucher');

    if (quoteInput.voucherCode && voucherAppliedInOutcome) {
      const voucherRows = await database.db
        .select()
        .from(vouchers)
        .where(eq(vouchers.code, quoteInput.voucherCode))
        .limit(1);

      const voucher = voucherRows[0];
      if (!voucher) {
        throw conflict('Voucher does not exist', { voucherCode: quoteInput.voucherCode });
      }
      if (voucher.redeemedAt) {
        throw conflict('Voucher has already been redeemed', { voucherCode: quoteInput.voucherCode });
      }

      const updatedVoucher = await database.db
        .update(vouchers)
        .set({ redeemedAt: nowEpoch(), redeemedOrderId: order.id })
        .where(and(eq(vouchers.id, voucher.id), isNull(vouchers.redeemedAt)))
        .returning({ id: vouchers.id });

      if (updatedVoucher.length === 0) {
        throw conflict('Voucher has already been redeemed', { voucherCode: quoteInput.voucherCode });
      }
    }

    const customerKey = quoteInput.customerId ?? '__guest__';
    const appliedPromotionIds = [...new Set(recalculated.appliedOffers.map((offer) => offer.promotionId).filter(Boolean))] as number[];
    if (appliedPromotionIds.length > 0) {
      const redemptionRows = appliedPromotionIds.map((promotionId) => ({
        promotionId,
        customerId: customerKey,
        orderId: order.id,
        redeemedAt: nowEpoch()
      }));
      await database.db.insert(promotionRedemptions).values(redemptionRows);
    }

    const paidMinor = await sumPaymentsForOrder(database, order.id);
    const [updatedOrder] = await database.db
      .update(orders)
      .set({
        status: 'finalized',
        finalizedAt: nowEpoch(),
        subtotalMinor: recalculated.subtotalMinor,
        discountMinor: recalculated.discountMinor,
        taxMinor: recalculated.taxMinor,
        depositMinor: recalculated.depositMinor,
        totalMinor: recalculated.totalMinor,
        balanceMinor: Math.max(recalculated.totalMinor - paidMinor, 0),
        pricingBreakdownJson: JSON.stringify(recalculated),
        updatedAt: nowEpoch()
      })
      .where(eq(orders.id, order.id))
      .returning();

    await database.db
      .update(orderIdempotencyKeys)
      .set({ orderId: order.id })
      .where(eq(orderIdempotencyKeys.key, idempotencyKey));

    return {
      order: updatedOrder,
      pricing: recalculated
    };
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.order.finalized',
    entityType: 'order',
    entityId: String(finalized.order.id),
    before: { status: 'draft' },
    after: { status: finalized.order.status, totalMinor: finalized.order.totalMinor },
    correlationId: actor.correlationId
  });

  return finalized;
};

export const cancelOrder = async (
  database: AppDatabase,
  orderId: number,
  actor: { userId: number; role: UserRole; correlationId: string }
) => {
  const rows = await database.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = rows[0];
  if (!order) {
    throw notFound('Order not found');
  }

  assertOrderAccess(order, actor);

  if (order.status !== 'draft') {
    throw conflict('Only draft orders can be canceled', { status: order.status });
  }

  const [updated] = await database.db
    .update(orders)
    .set({ status: 'canceled', canceledAt: nowEpoch(), updatedAt: nowEpoch() })
    .where(eq(orders.id, orderId))
    .returning();

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.order.canceled',
    entityType: 'order',
    entityId: String(orderId),
    before: { status: order.status },
    after: { status: updated.status },
    correlationId: actor.correlationId
  });

  return updated;
};

export const recordOrderPayment = async (
  database: AppDatabase,
  config: Pick<AppConfig, 'encryptionKey'>,
  orderId: number,
  payload: {
    method: 'cash' | 'check' | 'manual_card_entry';
    amountMinor: number;
    referenceText?: string;
    personalNote?: string;
  },
  actor: { userId: number; role: UserRole; correlationId: string }
) => {
  const rows = await database.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = rows[0];
  if (!order) {
    throw notFound('Order not found');
  }

  assertOrderAccess(order, actor);

  if (order.status === 'canceled' || order.status === 'refunded') {
    throw conflict('Cannot record payment for canceled/refunded orders', { status: order.status });
  }

  const encryptedReference = payload.referenceText
    ? encryptSensitive(payload.referenceText, config.encryptionKey, `payment:reference:${orderId}`)
    : null;
  const encryptedNote = payload.personalNote
    ? encryptSensitive(payload.personalNote, config.encryptionKey, `payment:note:${orderId}`)
    : null;

  const [payment] = await database.db
    .insert(payments)
    .values({
      orderId,
      method: payload.method,
      amountMinor: payload.amountMinor,
      referenceCiphertext: encryptedReference?.ciphertext,
      referenceIv: encryptedReference?.iv,
      referenceAuthTag: encryptedReference?.authTag,
      referenceKeyVersion: encryptedReference?.keyVersion,
      notesCiphertext: encryptedNote?.ciphertext,
      notesIv: encryptedNote?.iv,
      notesAuthTag: encryptedNote?.authTag,
      notesKeyVersion: encryptedNote?.keyVersion,
      recordedAt: nowEpoch(),
      recordedByUserId: actor.userId
    })
    .returning();

  const paidMinor = await sumPaymentsForOrder(database, orderId);
  await database.db
    .update(orders)
    .set({ balanceMinor: Math.max(order.totalMinor - paidMinor, 0), updatedAt: nowEpoch() })
    .where(eq(orders.id, orderId));

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'commerce.payment.recorded',
    entityType: 'payment',
    entityId: String(payment.id),
    before: null,
    after: { orderId, amountMinor: payment.amountMinor, method: payment.method },
    correlationId: actor.correlationId
  });

  return payment;
};

export const getOrderDetail = async (
  database: AppDatabase,
  orderId: number,
  actor: { userId: number; role: UserRole }
) => {
  const rows = await database.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = rows[0];
  if (!order) {
    throw notFound('Order not found');
  }

  assertOrderAccess(order, actor);

  const lines = await database.db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.id);
  const paymentRows = await database.db
    .select({
      id: payments.id,
      method: payments.method,
      amountMinor: payments.amountMinor,
      recordedAt: payments.recordedAt,
      hasReference: sql<boolean>`${payments.referenceCiphertext} is not null`
    })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.recordedAt));

  return {
    order,
    lines,
    payments: paymentRows,
    pricingBreakdown: JSON.parse(order.pricingBreakdownJson)
  };
};
