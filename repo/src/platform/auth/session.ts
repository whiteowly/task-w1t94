import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, gt, isNull } from 'drizzle-orm';

import type { AppDatabase } from '../db/client';
import { sessions, users, type UserRole } from '../db/schema';

const nowEpoch = () => Math.floor(Date.now() / 1000);

export type SessionContext = {
  userId: number;
  role: UserRole;
  username: string;
  sessionId: string;
};

export const createOpaqueSessionToken = (): string => randomBytes(32).toString('base64url');

export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const issueSession = async (
  database: AppDatabase,
  userId: number,
  ttlHours: number,
  metadata: { ipAddress?: string; userAgent?: string }
): Promise<{ token: string; expiresAt: number; sessionId: string }> => {
  const token = createOpaqueSessionToken();
  const tokenHash = hashSessionToken(token);
  const issuedAt = nowEpoch();
  const expiresAt = issuedAt + ttlHours * 3600;
  const sessionId = randomUUID();

  await database.db.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash,
    issuedAt,
    expiresAt,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent
  });

  return { token, expiresAt, sessionId };
};

export const getSessionContext = async (
  database: AppDatabase,
  bearerToken: string
): Promise<SessionContext | null> => {
  const tokenHash = hashSessionToken(bearerToken);
  const now = nowEpoch();

  const rows = await database.db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      role: users.role,
      username: users.username
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  return {
    userId: row.userId,
    role: row.role,
    username: row.username,
    sessionId: row.sessionId
  };
};

export const revokeSession = async (database: AppDatabase, sessionId: string): Promise<void> => {
  await database.db
    .update(sessions)
    .set({ revokedAt: nowEpoch() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
};
