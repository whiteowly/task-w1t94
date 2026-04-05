import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';

import { authPlugin } from '../platform/auth/auth-plugin';
import { roleHasPermission, rolePermissionMatrix, type Permission } from '../platform/auth/permissions';
import { loadConfig, type AppConfig } from '../platform/config';
import { createDatabase, type AppDatabase } from '../platform/db/client';
import { registerErrorHandler } from '../platform/errors/error-handler';
import { forbidden, unauthorized } from '../platform/errors/app-error';
import { JobScheduler } from '../platform/jobs/scheduler';
import { createLogger } from '../platform/logging/logger';

import { registerRoutes } from './routes';

type BuildServerOptions = {
  config?: AppConfig;
  database?: AppDatabase;
};

export const buildServer = async (options: BuildServerOptions = {}) => {
  const config = options.config ?? loadConfig();
  const appDb = options.database ?? createDatabase({ databaseUrl: config.databaseUrl });

  const fastify = Fastify({
    logger: createLogger(config),
    requestIdHeader: 'x-correlation-id',
    genReqId: (request) => {
      const incoming = request.headers['x-correlation-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    }
  });

  fastify.decorate('appConfig', config);
  fastify.decorate('appDb', appDb);
  fastify.decorate('rolePermissionMatrix', rolePermissionMatrix);
  fastify.decorate('scheduler', null);

  fastify.decorate('requirePermission', (permission: Permission) => async (request: FastifyRequest) => {
    if (!request.auth) {
      throw unauthorized();
    }
    if (!roleHasPermission(request.auth.role, permission)) {
      throw forbidden();
    }
  });

  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  registerErrorHandler(fastify);

  fastify.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        details: null,
        correlationId: request.id
      }
    })
  );

  await fastify.register(authPlugin);
  await registerRoutes(fastify);

  if (config.schedulerEnabled) {
    fastify.scheduler = new JobScheduler(appDb, config, fastify.log);
  }

  fastify.addHook('onClose', async () => {
    if (fastify.scheduler) {
      await fastify.scheduler.stop();
    }
    appDb.close();
  });

  return fastify;
};
