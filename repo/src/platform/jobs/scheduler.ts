import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';

import type { AppConfig } from '../config';
import type { AppDatabase } from '../db/client';

import { runDailyAnalyticsExport, runDailyReconciliationExport, runMissedDailyExports } from '../../modules/exports/export-jobs';
import { expireUnpaidDraftOrders } from '../../modules/orders/draft-expiration-job';

export class JobScheduler {
  private readonly tasks: ScheduledTask[] = [];
  private started = false;

  public constructor(
    private readonly database: AppDatabase,
    private readonly config: Pick<AppConfig, 'facilityTimezone' | 'exportDir'>,
    private readonly logger: FastifyBaseLogger
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    await runMissedDailyExports(this.database, this.config);

    this.tasks.push(
      cron.schedule(
        '0 2 * * *',
        async () => {
          this.logger.info({ job: 'daily-analytics-export' }, 'Running scheduled analytics export');
          await runDailyAnalyticsExport(this.database, this.config);
        },
        {
          timezone: this.config.facilityTimezone
        }
      )
    );

    this.tasks.push(
      cron.schedule(
        '15 2 * * *',
        async () => {
          this.logger.info({ job: 'daily-reconciliation-export' }, 'Running scheduled reconciliation export');
          await runDailyReconciliationExport(this.database, this.config);
        },
        {
          timezone: this.config.facilityTimezone
        }
      )
    );

    this.tasks.push(
      cron.schedule('* * * * *', async () => {
        const canceledCount = await expireUnpaidDraftOrders(this.database);
        if (canceledCount > 0) {
          this.logger.info({ job: 'expire-draft-orders', canceledCount }, 'Auto-canceled unpaid draft orders');
        }
      })
    );

    this.logger.info('Scheduler started');
  }

  public async stop(): Promise<void> {
    for (const task of this.tasks) {
      task.stop();
      task.destroy();
    }
    this.tasks.length = 0;
    this.started = false;
    this.logger.info('Scheduler stopped');
  }
}
