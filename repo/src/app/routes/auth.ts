import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { unauthorized, validationFailed } from '../../platform/errors/app-error';
import { rolePermissionMatrix } from '../../platform/auth/permissions';
import { hashPassword, verifyPassword } from '../../platform/auth/password';
import { issueSession, revokeSession } from '../../platform/auth/session';
import { sessions, users } from '../../platform/db/schema';
import { appendAuditLog } from '../../modules/audit/audit-log-service';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const bootstrapAdminSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8)
});

const nowEpoch = () => Math.floor(Date.now() / 1000);

export const registerAuthRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed('Invalid login payload', parsed.error.flatten());
    }

    const { username, password } = parsed.data;
    const userRows = await fastify.appDb.db.select().from(users).where(eq(users.username, username)).limit(1);
    const user = userRows[0];

    if (!user || !verifyPassword(password, user.passwordHash)) {
      if (user) {
        await fastify.appDb.db
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1`, updatedAt: nowEpoch() })
          .where(eq(users.id, user.id));
      }

      await appendAuditLog(fastify.appDb, {
        actorUserId: user?.id,
        action: 'auth.login.failed',
        entityType: 'user',
        entityId: user ? String(user.id) : username,
        before: null,
        after: { success: false },
        correlationId: request.id,
        metadata: { username }
      });

      throw unauthorized('Invalid username or password');
    }

    await fastify.appDb.db
      .update(users)
      .set({ failedLoginCount: 0, lastLoginAt: nowEpoch(), updatedAt: nowEpoch() })
      .where(eq(users.id, user.id));

    const session = await issueSession(fastify.appDb, user.id, fastify.appConfig.sessionTtlHours, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent']
    });

    await appendAuditLog(fastify.appDb, {
      actorUserId: user.id,
      action: 'auth.login.succeeded',
      entityType: 'session',
      entityId: session.sessionId,
      before: null,
      after: { userId: user.id, expiresAt: session.expiresAt },
      correlationId: request.id,
      metadata: { username: user.username }
    });

    return reply.send({
      token: session.token,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      },
      correlationId: request.id
    });
  });

  fastify.post('/v1/auth/logout', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.auth) {
      throw unauthorized();
    }

    await revokeSession(fastify.appDb, request.auth.sessionId);
    await appendAuditLog(fastify.appDb, {
      actorUserId: request.auth.userId,
      action: 'auth.logout',
      entityType: 'session',
      entityId: request.auth.sessionId,
      before: { revoked: false },
      after: { revoked: true },
      correlationId: request.id
    });

    return reply.code(204).send();
  });

  fastify.get('/v1/auth/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.auth) {
      throw unauthorized();
    }

    return reply.send({
      user: {
        id: request.auth.userId,
        username: request.auth.username,
        role: request.auth.role
      },
      correlationId: request.id
    });
  });

  fastify.get('/v1/auth/permissions', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.auth) {
      throw unauthorized();
    }

    return reply.send({
      role: request.auth.role,
      permissions: rolePermissionMatrix[request.auth.role],
      correlationId: request.id
    });
  });

  // Explicitly admin-only bootstrap endpoint for local/dev initialization.
  fastify.post('/v1/auth/bootstrap-admin', async (request, reply) => {
    const existingCount = fastify.appDb.sqlite.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (existingCount.count > 0) {
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Bootstrap admin can only be created on an empty user table',
          details: null,
          correlationId: request.id
        }
      });
    }

    const parsed = bootstrapAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed('Invalid bootstrap payload', parsed.error.flatten());
    }

    const now = nowEpoch();
    const [created] = await fastify.appDb.db
      .insert(users)
      .values({
        username: parsed.data.username,
        passwordHash: hashPassword(parsed.data.password),
        role: 'administrator',
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: users.id, username: users.username, role: users.role });

    await appendAuditLog(fastify.appDb, {
      actorUserId: created.id,
      action: 'auth.bootstrap_admin.created',
      entityType: 'user',
      entityId: String(created.id),
      before: null,
      after: { id: created.id, username: created.username, role: created.role },
      correlationId: request.id
    });

    return reply.code(201).send({
      user: created,
      correlationId: request.id
    });
  });

  fastify.delete('/v1/auth/sessions/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    if (!request.auth) {
      throw unauthorized();
    }

    const sessionId = (request.params as { id: string }).id;
    await fastify.appDb.db
      .update(sessions)
      .set({ revokedAt: nowEpoch() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, request.auth.userId)));

    await appendAuditLog(fastify.appDb, {
      actorUserId: request.auth.userId,
      action: 'auth.session.revoked',
      entityType: 'session',
      entityId: sessionId,
      before: { revoked: false },
      after: { revoked: true },
      correlationId: request.id
    });

    return reply.code(204).send();
  });
};
