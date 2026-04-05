import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../platform/config';
import type { AppDatabase } from '../platform/db/client';
import type { JobScheduler } from '../platform/jobs/scheduler';
import type { Permission, rolePermissionMatrix } from '../platform/auth/permissions';
import type { SessionContext } from '../platform/auth/session';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    appDb: AppDatabase;
    scheduler: JobScheduler | null;
    authenticate: (request: FastifyRequest) => Promise<void>;
    requirePermission: (permission: Permission) => (request: FastifyRequest) => Promise<void>;
    rolePermissionMatrix: typeof rolePermissionMatrix;
  }

  interface FastifyRequest {
    auth: SessionContext | null;
  }
}
