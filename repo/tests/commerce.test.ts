import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildServer } from '../src/app/build-server';
import { expireUnpaidDraftOrders } from '../src/modules/orders/draft-expiration-job';
import { hashPassword } from '../src/platform/auth/password';
import { orders, payments, users } from '../src/platform/db/schema';

import { buildTestConfig, createMigratedTestDb } from './test-utils';

const expectErrorEnvelope = (response: { json: () => any }, code: string) => {
  const body = response.json();
  expect(body.error.code).toBe(code);
  expect(typeof body.error.correlationId).toBe('string');
};

const createUserAndLogin = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  database: ReturnType<typeof createMigratedTestDb>['database'],
  payload: { username: string; password: string; role: (typeof users.$inferInsert)['role'] }
) => {
  const [created] = await database.db
    .insert(users)
    .values({
      username: payload.username,
      passwordHash: hashPassword(payload.password),
      role: payload.role
    })
    .returning({ id: users.id });

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {
      username: payload.username,
      password: payload.password
    }
  });

  expect(login.statusCode).toBe(200);
  return {
    userId: created.id,
    token: login.json().token as string
  };
};

const openWindow = {
  validFromLocal: '2000-01-01T00:00:00',
  validToLocal: '2100-01-01T00:00:00'
};

describe('commerce promotions/vouchers/orders slice', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces admin-only promotion/voucher management with clean 401/403/404 responses', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-commerce-1',
      password: 'admin-commerce-pass-1',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-1',
      password: 'sales-commerce-pass-1',
      role: 'sales_associate'
    });

    const unauthCreatePromo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      payload: {
        name: 'NoAuthPromo',
        type: 'amount_discount',
        priority: 20,
        stackability: 'exclusive',
        ...openWindow,
        applicabilitySelectors: {},
        rule: { discountAmountMinor: 1000 },
        active: true
      }
    });
    expect(unauthCreatePromo.statusCode).toBe(401);
    expectErrorEnvelope(unauthCreatePromo, 'UNAUTHORIZED');

    const forbiddenCreatePromo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        name: 'SalesForbiddenPromo',
        type: 'amount_discount',
        priority: 20,
        stackability: 'exclusive',
        ...openWindow,
        applicabilitySelectors: {},
        rule: { discountAmountMinor: 1000 },
        active: true
      }
    });
    expect(forbiddenCreatePromo.statusCode).toBe(403);
    expectErrorEnvelope(forbiddenCreatePromo, 'FORBIDDEN');

    const createdVoucherPromo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Voucher Promotion',
        type: 'voucher',
        priority: 5,
        stackability: 'exclusive',
        maxRedemptionsPerUser: 1,
        ...openWindow,
        applicabilitySelectors: { voucherCodes: ['WELCOME10'] },
        rule: { discountAmountMinor: 1000 },
        active: true
      }
    });
    expect(createdVoucherPromo.statusCode).toBe(201);
    const promotionId = createdVoucherPromo.json().promotion.id as number;

    const missingPromo = await app.inject({
      method: 'GET',
      url: '/v1/promotions/999999',
      headers: { authorization: `Bearer ${admin.token}` }
    });
    expect(missingPromo.statusCode).toBe(404);
    expectErrorEnvelope(missingPromo, 'NOT_FOUND');

    const voucherCreated = await app.inject({
      method: 'POST',
      url: '/v1/vouchers',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        code: 'WELCOME10',
        promotionId,
        customerBinding: 'cust-bound',
        expirationLocal: '2100-01-01T00:00:00'
      }
    });
    expect(voucherCreated.statusCode).toBe(201);

    const salesVoucherListForbidden = await app.inject({
      method: 'GET',
      url: '/v1/vouchers',
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(salesVoucherListForbidden.statusCode).toBe(403);
    expectErrorEnvelope(salesVoucherListForbidden, 'FORBIDDEN');
  });

  it('computes pricing quote with exclusive/stackable handling and best eligible savings', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-commerce-2',
      password: 'admin-commerce-pass-2',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-2',
      password: 'sales-commerce-pass-2',
      role: 'sales_associate'
    });

    const createPromo = async (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/promotions',
        headers: { authorization: `Bearer ${admin.token}` },
        payload
      });

    expect(
      (
        await createPromo({
          name: 'Stackable Percent 10',
          type: 'percentage_discount',
          priority: 30,
          stackability: 'stackable',
          ...openWindow,
          applicabilitySelectors: {},
          rule: { percentBasisPoints: 1000 },
          active: true
        })
      ).statusCode
    ).toBe(201);

    expect(
      (
        await createPromo({
          name: 'Stackable Amount 500',
          type: 'amount_discount',
          priority: 40,
          stackability: 'stackable',
          ...openWindow,
          applicabilitySelectors: {},
          rule: { discountAmountMinor: 500 },
          active: true
        })
      ).statusCode
    ).toBe(201);

    expect(
      (
        await createPromo({
          name: 'Exclusive Amount 1200',
          type: 'amount_discount',
          priority: 10,
          stackability: 'exclusive',
          ...openWindow,
          applicabilitySelectors: {},
          rule: { discountAmountMinor: 1200 },
          active: true
        })
      ).statusCode
    ).toBe(201);

    const quote = await app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        customerId: 'cust-quote',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-QUOTE-1',
            description: 'Quote item',
            quantity: 1,
            unitPriceMinor: 10000
          }
        ]
      }
    });

    expect(quote.statusCode).toBe(200);
    expect(quote.json().quote.subtotalMinor).toBe(10000);
    expect(quote.json().quote.discountMinor).toBe(1500);
    expect(quote.json().quote.appliedStrategy).toBe('stackable_combo');
    expect(quote.json().quote.appliedOffers).toHaveLength(2);
  });

  it('handles order checkout, idempotency, voucher lock, and encrypted payment reference storage', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-commerce-3',
      password: 'admin-commerce-pass-3',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-3',
      password: 'sales-commerce-pass-3',
      role: 'sales_associate'
    });
    const ops = await createUserAndLogin(app, database, {
      username: 'ops-commerce-3',
      password: 'ops-commerce-pass-3',
      role: 'operations_manager'
    });

    const voucherPromo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Voucher Save20',
        type: 'voucher',
        priority: 1,
        stackability: 'exclusive',
        maxRedemptionsPerUser: 1,
        ...openWindow,
        applicabilitySelectors: { voucherCodes: ['SAVE20'] },
        rule: { discountAmountMinor: 2000 },
        active: true
      }
    });
    expect(voucherPromo.statusCode).toBe(201);
    const voucherPromotionId = voucherPromo.json().promotion.id as number;

    const voucher = await app.inject({
      method: 'POST',
      url: '/v1/vouchers',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        code: 'SAVE20',
        promotionId: voucherPromotionId,
        expirationLocal: '2100-01-01T00:00:00'
      }
    });
    expect(voucher.statusCode).toBe(201);

    const opsForbiddenOrderCreate = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        authorization: `Bearer ${ops.token}`,
        'Idempotency-Key': 'ops-idem-1'
      },
      payload: {
        customerId: 'cust-order-1',
        voucherCode: 'SAVE20',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-ORDER-1',
            description: 'Order item',
            quantity: 1,
            unitPriceMinor: 15000
          }
        ]
      }
    });
    expect(opsForbiddenOrderCreate.statusCode).toBe(403);
    expectErrorEnvelope(opsForbiddenOrderCreate, 'FORBIDDEN');

    const createdOrder = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        authorization: `Bearer ${sales.token}`,
        'Idempotency-Key': 'sales-order-idem-1'
      },
      payload: {
        customerId: 'cust-order-1',
        voucherCode: 'SAVE20',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-ORDER-1',
            description: 'Order item',
            quantity: 1,
            unitPriceMinor: 15000
          }
        ]
      }
    });
    expect(createdOrder.statusCode).toBe(201);
    const orderId = createdOrder.json().order.id as number;

    const duplicateCreate = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        authorization: `Bearer ${sales.token}`,
        'Idempotency-Key': 'sales-order-idem-1'
      },
      payload: {
        customerId: 'cust-order-1',
        voucherCode: 'SAVE20',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-ORDER-1',
            description: 'Order item',
            quantity: 1,
            unitPriceMinor: 15000
          }
        ]
      }
    });
    expect(duplicateCreate.statusCode).toBe(409);
    expectErrorEnvelope(duplicateCreate, 'CONFLICT');

    const missingOrderRead = await app.inject({
      method: 'GET',
      url: '/v1/orders/999999',
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(missingOrderRead.statusCode).toBe(404);
    expectErrorEnvelope(missingOrderRead, 'NOT_FOUND');

    const finalized = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/finalize`,
      headers: {
        authorization: `Bearer ${sales.token}`,
        'Idempotency-Key': 'sales-finalize-idem-1'
      },
      payload: {}
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json().order.status).toBe('finalized');

    const secondOrder = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        authorization: `Bearer ${sales.token}`,
        'Idempotency-Key': 'sales-order-idem-2'
      },
      payload: {
        customerId: 'cust-order-1',
        voucherCode: 'SAVE20',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-ORDER-2',
            description: 'Second order item',
            quantity: 1,
            unitPriceMinor: 15000
          }
        ]
      }
    });
    expect(secondOrder.statusCode).toBe(409);
    expectErrorEnvelope(secondOrder, 'CONFLICT');

    const payment = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/payments`,
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        method: 'check',
        amountMinor: 13000,
        referenceText: 'CHK-123',
        personalNote: 'Manual desk entry'
      }
    });
    expect(payment.statusCode).toBe(201);

    const [storedPayment] = await database.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .limit(1);

    expect(storedPayment.referenceCiphertext).toBeTruthy();
    expect(storedPayment.referenceCiphertext).not.toContain('CHK-123');
    expect(storedPayment.referenceIv).toBeTruthy();
    expect(storedPayment.referenceAuthTag).toBeTruthy();
  });

  it('enforces sales-associate object-level authorization for order read/finalize/cancel/payment routes', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const salesOwner = await createUserAndLogin(app, database, {
      username: 'sales-commerce-owner',
      password: 'sales-commerce-owner-pass',
      role: 'sales_associate'
    });
    const salesOther = await createUserAndLogin(app, database, {
      username: 'sales-commerce-other',
      password: 'sales-commerce-other-pass',
      role: 'sales_associate'
    });

    const createdOrder = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: {
        authorization: `Bearer ${salesOwner.token}`,
        'Idempotency-Key': 'sales-owner-order-idem-1'
      },
      payload: {
        customerId: 'cust-order-authz',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-ORDER-AUTHZ-1',
            description: 'Owner order item',
            quantity: 1,
            unitPriceMinor: 11000
          }
        ]
      }
    });
    expect(createdOrder.statusCode).toBe(201);
    const orderId = createdOrder.json().order.id as number;

    const otherRead = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${salesOther.token}` }
    });
    expect(otherRead.statusCode).toBe(403);
    expectErrorEnvelope(otherRead, 'FORBIDDEN');

    const otherFinalize = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/finalize`,
      headers: {
        authorization: `Bearer ${salesOther.token}`,
        'Idempotency-Key': 'sales-other-finalize-idem-1'
      },
      payload: {}
    });
    expect(otherFinalize.statusCode).toBe(403);
    expectErrorEnvelope(otherFinalize, 'FORBIDDEN');

    const otherCancel = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${salesOther.token}` }
    });
    expect(otherCancel.statusCode).toBe(403);
    expectErrorEnvelope(otherCancel, 'FORBIDDEN');

    const otherPayment = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/payments`,
      headers: { authorization: `Bearer ${salesOther.token}` },
      payload: {
        method: 'cash',
        amountMinor: 1000,
        referenceText: 'CASH-1000',
        personalNote: 'Should not be allowed'
      }
    });
    expect(otherPayment.statusCode).toBe(403);
    expectErrorEnvelope(otherPayment, 'FORBIDDEN');

    const ownerRead = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { authorization: `Bearer ${salesOwner.token}` }
    });
    expect(ownerRead.statusCode).toBe(200);
    expect(ownerRead.json().order.id).toBe(orderId);
  });

  it('enforces max redemptions per user after first successful redemption', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-commerce-4',
      password: 'admin-commerce-pass-4',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-4',
      password: 'sales-commerce-pass-4',
      role: 'sales_associate'
    });

    const promo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'One-time customer promo',
        type: 'amount_discount',
        priority: 15,
        stackability: 'exclusive',
        maxRedemptionsPerUser: 1,
        ...openWindow,
        applicabilitySelectors: {},
        rule: { discountAmountMinor: 900 },
        active: true
      }
    });
    expect(promo.statusCode).toBe(201);

    const createAndFinalize = async (orderKey: string, finalizeKey: string) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: {
          authorization: `Bearer ${sales.token}`,
          'Idempotency-Key': orderKey
        },
        payload: {
          customerId: 'cust-max-redemption',
          taxRateBasisPoints: 0,
          depositMinor: 0,
          items: [
            {
              lineType: 'product',
              sku: 'SKU-MAX-RED',
              description: 'Promo eligible item',
              quantity: 1,
              unitPriceMinor: 5000
            }
          ]
        }
      });
      expect(created.statusCode).toBe(201);
      const orderId = created.json().order.id as number;

      const finalized = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/finalize`,
        headers: {
          authorization: `Bearer ${sales.token}`,
          'Idempotency-Key': finalizeKey
        },
        payload: {}
      });
      expect(finalized.statusCode).toBe(200);
      return finalized.json().order as { discountMinor: number; status: string };
    };

    const firstFinalized = await createAndFinalize('max-red-order-1', 'max-red-final-1');
    expect(firstFinalized.status).toBe('finalized');
    expect(firstFinalized.discountMinor).toBe(900);

    const secondQuote = await app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        customerId: 'cust-max-redemption',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-MAX-RED',
            description: 'Promo eligible item',
            quantity: 1,
            unitPriceMinor: 5000
          }
        ]
      }
    });
    expect(secondQuote.statusCode).toBe(200);
    expect(secondQuote.json().quote.discountMinor).toBe(0);
    expect(secondQuote.json().quote.appliedOffers).toHaveLength(0);

    const secondFinalized = await createAndFinalize('max-red-order-2', 'max-red-final-2');
    expect(secondFinalized.discountMinor).toBe(0);
  });

  it('applies local-time validity windows and rejects expired voucher usage cleanly', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const admin = await createUserAndLogin(app, database, {
      username: 'admin-commerce-5',
      password: 'admin-commerce-pass-5',
      role: 'administrator'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-5',
      password: 'sales-commerce-pass-5',
      role: 'sales_associate'
    });

    const futurePromotion = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Future window promo',
        type: 'amount_discount',
        priority: 20,
        stackability: 'exclusive',
        maxRedemptionsPerUser: 1,
        validFromLocal: '2999-01-01T00:00:00',
        validToLocal: '3000-01-01T00:00:00',
        applicabilitySelectors: {},
        rule: { discountAmountMinor: 700 },
        active: true
      }
    });
    expect(futurePromotion.statusCode).toBe(201);

    const quoteOutsideWindow = await app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        customerId: 'cust-window-1',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-WINDOW-1',
            description: 'Window test item',
            quantity: 1,
            unitPriceMinor: 5000
          }
        ]
      }
    });
    expect(quoteOutsideWindow.statusCode).toBe(200);
    expect(quoteOutsideWindow.json().quote.discountMinor).toBe(0);
    expect(quoteOutsideWindow.json().quote.appliedOffers).toHaveLength(0);

    const voucherPromo = await app.inject({
      method: 'POST',
      url: '/v1/promotions',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Voucher expired test',
        type: 'voucher',
        priority: 1,
        stackability: 'exclusive',
        ...openWindow,
        applicabilitySelectors: { voucherCodes: ['EXPIRED1'] },
        rule: { discountAmountMinor: 1000 },
        active: true
      }
    });
    expect(voucherPromo.statusCode).toBe(201);

    const expiredVoucher = await app.inject({
      method: 'POST',
      url: '/v1/vouchers',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        code: 'EXPIRED1',
        promotionId: voucherPromo.json().promotion.id,
        expirationLocal: '2000-01-01T00:00:00'
      }
    });
    expect(expiredVoucher.statusCode).toBe(201);

    const expiredVoucherQuote = await app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        customerId: 'cust-window-1',
        voucherCode: 'EXPIRED1',
        taxRateBasisPoints: 0,
        depositMinor: 0,
        items: [
          {
            lineType: 'product',
            sku: 'SKU-WINDOW-2',
            description: 'Window test item two',
            quantity: 1,
            unitPriceMinor: 7000
          }
        ]
      }
    });
    expect(expiredVoucherQuote.statusCode).toBe(409);
    expectErrorEnvelope(expiredVoucherQuote, 'CONFLICT');
  });

  it('expires unpaid drafts while preserving valid or paid drafts via the expiration job', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const sales = await createUserAndLogin(app, database, {
      username: 'sales-commerce-6',
      password: 'sales-commerce-pass-6',
      role: 'sales_associate'
    });

    const createDraft = async (idempotencyKey: string, customerId: string) => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: {
          authorization: `Bearer ${sales.token}`,
          'Idempotency-Key': idempotencyKey
        },
        payload: {
          customerId,
          taxRateBasisPoints: 0,
          depositMinor: 0,
          items: [
            {
              lineType: 'product',
              sku: `SKU-${customerId}`,
              description: 'Draft exp item',
              quantity: 1,
              unitPriceMinor: 4000
            }
          ]
        }
      });
      expect(created.statusCode).toBe(201);
      return created.json().order.id as number;
    };

    const expiredUnpaidOrderId = await createDraft('draft-exp-order-1', 'cust-exp-1');
    const validUnpaidOrderId = await createDraft('draft-exp-order-2', 'cust-exp-2');
    const expiredPaidOrderId = await createDraft('draft-exp-order-3', 'cust-exp-3');

    const now = Math.floor(Date.now() / 1000);
    await database.db
      .update(orders)
      .set({ draftExpiresAt: now - 60 })
      .where(eq(orders.id, expiredUnpaidOrderId));

    await database.db
      .update(orders)
      .set({ draftExpiresAt: now + 3600 })
      .where(eq(orders.id, validUnpaidOrderId));

    await database.db
      .update(orders)
      .set({ draftExpiresAt: now - 60 })
      .where(eq(orders.id, expiredPaidOrderId));

    const paymentForExpiredPaid = await app.inject({
      method: 'POST',
      url: `/v1/orders/${expiredPaidOrderId}/payments`,
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        method: 'cash',
        amountMinor: 1000
      }
    });
    expect(paymentForExpiredPaid.statusCode).toBe(201);

    const canceledCount = await expireUnpaidDraftOrders(database);
    expect(canceledCount).toBe(1);

    const readExpiredUnpaid = await app.inject({
      method: 'GET',
      url: `/v1/orders/${expiredUnpaidOrderId}`,
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(readExpiredUnpaid.statusCode).toBe(200);
    expect(readExpiredUnpaid.json().order.status).toBe('canceled');

    const readValidUnpaid = await app.inject({
      method: 'GET',
      url: `/v1/orders/${validUnpaidOrderId}`,
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(readValidUnpaid.statusCode).toBe(200);
    expect(readValidUnpaid.json().order.status).toBe('draft');

    const readExpiredPaid = await app.inject({
      method: 'GET',
      url: `/v1/orders/${expiredPaidOrderId}`,
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(readExpiredPaid.statusCode).toBe(200);
    expect(readExpiredPaid.json().order.status).toBe('draft');
  });
});
