import type { AppDatabase } from '../../platform/db/client';

const nowEpoch = () => Math.floor(Date.now() / 1000);

export const expireUnpaidDraftOrders = async (database: AppDatabase): Promise<number> => {
  const now = nowEpoch();

  const result = database.sqlite
    .prepare(
      `UPDATE orders
       SET status = 'canceled',
           canceled_at = @now,
           updated_at = @now
       WHERE status = 'draft'
         AND draft_expires_at IS NOT NULL
         AND draft_expires_at <= @now
         AND NOT EXISTS (
           SELECT 1
           FROM payments p
           WHERE p.order_id = orders.id
         )`
    )
    .run({ now });

  return Number(result.changes);
};
