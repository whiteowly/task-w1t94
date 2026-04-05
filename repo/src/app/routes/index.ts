import type { FastifyInstance } from 'fastify';

import { registerAuditReportingRoutes } from './audit-reporting';
import { registerAuthRoutes } from './auth';
import { registerCatalogRoutes } from './catalog';
import { registerChargingRoutes } from './charging';
import { registerCommerceRoutes } from './commerce';
import { registerHealthRoutes } from './health';
import { registerReconciliationRoutes } from './reconciliation';
import { registerTrainingRoutes } from './training';

export const registerRoutes = async (fastify: FastifyInstance) => {
  await registerHealthRoutes(fastify);
  await registerAuthRoutes(fastify);
  await registerCatalogRoutes(fastify);
  await registerTrainingRoutes(fastify);
  await registerCommerceRoutes(fastify);
  await registerChargingRoutes(fastify);
  await registerReconciliationRoutes(fastify);
  await registerAuditReportingRoutes(fastify);
};
