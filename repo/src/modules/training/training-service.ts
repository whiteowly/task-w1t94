import { createHash } from 'node:crypto';

import { and, count, desc, eq, inArray } from 'drizzle-orm';

import { appendAuditLog } from '../audit/audit-log-service';
import { conflict, forbidden, notFound, validationFailed } from '../../platform/errors/app-error';
import { encryptSensitive } from '../../platform/crypto/aes-gcm';
import type { AppDatabase } from '../../platform/db/client';
import {
  attendance,
  classProctorAssignments,
  classInstances,
  classInstanceVersions,
  courses,
  enrollments,
  users,
  type UserRole
} from '../../platform/db/schema';

const nowEpoch = () => Math.floor(Date.now() / 1000);

const hashClassSnapshot = (snapshot: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

const isSqliteUnique = (error: unknown, tableOrIndex: string): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const coded = error as Error & { code?: string };
  return coded.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes(tableOrIndex);
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

const assertInstructorAssignment = async (database: AppDatabase, instructorUserId: number | null | undefined): Promise<void> => {
  if (instructorUserId === undefined || instructorUserId === null) {
    return;
  }

  const rows = await database.db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, instructorUserId))
    .limit(1);

  const assigned = rows[0];
  if (!assigned) {
    throw notFound('Instructor user not found');
  }

  if (assigned.role !== 'instructor') {
    throw conflict('Assigned user must have instructor role', { instructorUserId });
  }
};

const normalizeProctorUserIds = (proctorUserIds: number[] | undefined): number[] =>
  [...new Set((proctorUserIds ?? []).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);

const assertProctorAssignments = async (database: AppDatabase, proctorUserIds: number[]): Promise<void> => {
  if (proctorUserIds.length === 0) {
    return;
  }

  const rows = await database.db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, proctorUserIds));

  const byId = new Map(rows.map((row) => [row.id, row.role]));
  for (const userId of proctorUserIds) {
    const role = byId.get(userId);
    if (!role) {
      throw notFound('Proctor user not found');
    }
    if (role !== 'proctor') {
      throw conflict('Assigned proctor user must have proctor role', { proctorUserId: userId });
    }
  }
};

const replaceProctorAssignments = async (
  database: AppDatabase,
  classId: number,
  proctorUserIds: number[],
  actorUserId: number
): Promise<void> => {
  await database.db.delete(classProctorAssignments).where(eq(classProctorAssignments.classInstanceId, classId));
  if (proctorUserIds.length === 0) {
    return;
  }

  await database.db.insert(classProctorAssignments).values(
    proctorUserIds.map((proctorUserId) => ({
      classInstanceId: classId,
      proctorUserId,
      assignedByUserId: actorUserId,
      assignedAt: nowEpoch()
    }))
  );
};

const isProctorAssignedToClass = async (database: AppDatabase, classId: number, proctorUserId: number): Promise<boolean> => {
  const rows = await database.db
    .select({ id: classProctorAssignments.id })
    .from(classProctorAssignments)
    .where(
      and(
        eq(classProctorAssignments.classInstanceId, classId),
        eq(classProctorAssignments.proctorUserId, proctorUserId)
      )
    )
    .limit(1);
  return Boolean(rows[0]);
};

const writeClassVersion = async (
  database: AppDatabase,
  classRow: typeof classInstances.$inferSelect,
  changedByUserId: number,
  changeNotes: string
): Promise<void> => {
  const snapshotHash = hashClassSnapshot({
    id: classRow.id,
    courseId: classRow.courseId,
    startsAt: classRow.startsAt,
    endsAt: classRow.endsAt,
    capacity: classRow.capacity,
    waitlistCap: classRow.waitlistCap,
    instructorUserId: classRow.instructorUserId,
    publishState: classRow.publishState,
    version: classRow.version,
    changeNotes
  });

  await database.db.insert(classInstanceVersions).values({
    classInstanceId: classRow.id,
    version: classRow.version,
    changeNotes,
    snapshotHash,
    changedByUserId,
    changedAt: nowEpoch()
  });
};

const getClassOrThrow = async (database: AppDatabase, classId: number) => {
  const rows = await database.db.select().from(classInstances).where(eq(classInstances.id, classId)).limit(1);
  const found = rows[0];
  if (!found) {
    throw notFound('Class instance not found');
  }
  return found;
};

const assertAttendanceAccess = async (
  database: AppDatabase,
  classRow: typeof classInstances.$inferSelect,
  actor: { userId: number; role: UserRole },
  mode: 'read' | 'write'
): Promise<void> => {
  if (actor.role === 'proctor') {
    const assigned = await isProctorAssignedToClass(database, classRow.id, actor.userId);
    if (!assigned) {
      throw forbidden('Proctor is not assigned to this class');
    }
    return;
  }

  if (actor.role === 'instructor') {
    if (classRow.instructorUserId !== actor.userId) {
      throw forbidden('Instructor is not assigned to this class');
    }
    return;
  }

  if (mode === 'read' && actor.role === 'operations_manager') {
    return;
  }

  throw forbidden('Attendance access denied for this class');
};

const getEnrollmentCounts = async (database: AppDatabase, classId: number) => {
  const [enrolledCountRow] = await database.db
    .select({ total: count() })
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.status, 'enrolled')));

  const [waitlistedCountRow] = await database.db
    .select({ total: count() })
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.status, 'waitlisted')));

  return {
    enrolledCount: enrolledCountRow.total,
    waitlistedCount: waitlistedCountRow.total
  };
};

const resequenceWaitlist = async (database: AppDatabase, classId: number): Promise<void> => {
  const rows = await database.db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.status, 'waitlisted')))
    .orderBy(enrollments.waitlistPosition, enrollments.createdAt);

  for (let index = 0; index < rows.length; index += 1) {
    const targetPosition = index + 1;
    await database.db
      .update(enrollments)
      .set({ waitlistPosition: targetPosition, updatedAt: nowEpoch() })
      .where(eq(enrollments.id, rows[index].id));
  }
};

const promoteFromWaitlistIfPossible = async (database: AppDatabase, classId: number): Promise<string | null> => {
  const classRow = await getClassOrThrow(database, classId);
  const { enrolledCount } = await getEnrollmentCounts(database, classId);
  if (enrolledCount >= classRow.capacity) {
    return null;
  }

  const waitlistedRows = await database.db
    .select({ id: enrollments.id, customerId: enrollments.customerId })
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.status, 'waitlisted')))
    .orderBy(enrollments.waitlistPosition, enrollments.createdAt)
    .limit(1);

  const promoted = waitlistedRows[0];
  if (!promoted) {
    return null;
  }

  await database.db
    .update(enrollments)
    .set({ status: 'enrolled', waitlistPosition: null, updatedAt: nowEpoch() })
    .where(eq(enrollments.id, promoted.id));

  await resequenceWaitlist(database, classId);
  return promoted.customerId;
};

export const createCourse = async (
  database: AppDatabase,
  payload: {
    code: string;
    title: string;
    category: string;
    difficulty: string;
    agePrerequisiteMin: number | null;
    foundationPrerequisites: string[];
    active: boolean;
  },
  actor: { userId: number; correlationId: string }
) => {
  const now = nowEpoch();

  try {
    const [created] = await database.db
      .insert(courses)
      .values({
        code: payload.code,
        title: payload.title,
        category: payload.category,
        difficulty: payload.difficulty,
        agePrerequisiteMin: payload.agePrerequisiteMin,
        foundationPrerequisitesJson: JSON.stringify(payload.foundationPrerequisites),
        active: payload.active,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'training.course.created',
      entityType: 'course',
      entityId: String(created.id),
      before: null,
      after: { id: created.id, code: created.code, active: created.active },
      correlationId: actor.correlationId
    });

    return created;
  } catch (error) {
    if (isSqliteUnique(error, 'courses_code_unique') || isSqliteUnique(error, 'UNIQUE constraint failed: courses.code')) {
      throw conflict('Course code already exists', { code: payload.code });
    }
    throw error;
  }
};

export const updateCourse = async (
  database: AppDatabase,
  courseId: number,
  payload: Partial<{
    code: string;
    title: string;
    category: string;
    difficulty: string;
    agePrerequisiteMin: number | null;
    foundationPrerequisites: string[];
    active: boolean;
  }>,
  actor: { userId: number; correlationId: string }
) => {
  const rows = await database.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  const current = rows[0];
  if (!current) {
    throw notFound('Course not found');
  }

  try {
    const [updated] = await database.db
      .update(courses)
      .set({
        code: payload.code ?? current.code,
        title: payload.title ?? current.title,
        category: payload.category ?? current.category,
        difficulty: payload.difficulty ?? current.difficulty,
        agePrerequisiteMin: payload.agePrerequisiteMin === undefined ? current.agePrerequisiteMin : payload.agePrerequisiteMin,
        foundationPrerequisitesJson:
          payload.foundationPrerequisites === undefined
            ? current.foundationPrerequisitesJson
            : JSON.stringify(payload.foundationPrerequisites),
        active: payload.active ?? current.active,
        updatedAt: nowEpoch()
      })
      .where(eq(courses.id, courseId))
      .returning();

    await appendAuditLog(database, {
      actorUserId: actor.userId,
      action: 'training.course.updated',
      entityType: 'course',
      entityId: String(courseId),
      before: { code: current.code, active: current.active },
      after: { code: updated.code, active: updated.active },
      correlationId: actor.correlationId
    });

    return updated;
  } catch (error) {
    if (isSqliteUnique(error, 'courses_code_unique') || isSqliteUnique(error, 'UNIQUE constraint failed: courses.code')) {
      throw conflict('Course code already exists', { code: payload.code });
    }
    throw error;
  }
};

export const getCourse = async (database: AppDatabase, courseId: number) => {
  const rows = await database.db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  const course = rows[0];
  if (!course) {
    throw notFound('Course not found');
  }
  return course;
};

export const listCourses = async (
  database: AppDatabase,
  query: { page: number; pageSize: number; category?: string; active?: boolean }
) => {
  const filter = and(
    query.category ? eq(courses.category, query.category) : undefined,
    query.active === undefined ? undefined : eq(courses.active, query.active)
  );

  const [totalRow] = await database.db.select({ total: count() }).from(courses).where(filter);
  const rows = await database.db
    .select()
    .from(courses)
    .where(filter)
    .orderBy(desc(courses.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows,
    total: totalRow.total
  };
};

export const createClassInstance = async (
  database: AppDatabase,
  payload: {
    courseId: number;
    startsAt: number;
    endsAt: number;
    capacity: number;
    waitlistCap: number;
    instructorUserId?: number | null;
    proctorUserIds?: number[];
    changeNotes: string;
    publishState: 'published' | 'unpublished';
  },
  actor: { userId: number; correlationId: string }
) => {
  await getCourse(database, payload.courseId);
  await assertInstructorAssignment(database, payload.instructorUserId ?? null);
  const normalizedProctorUserIds = normalizeProctorUserIds(payload.proctorUserIds);
  await assertProctorAssignments(database, normalizedProctorUserIds);

  const now = nowEpoch();

  const created = await withSqliteTransaction(database, async () => {
    const [row] = await database.db
      .insert(classInstances)
      .values({
        courseId: payload.courseId,
        startsAt: payload.startsAt,
        endsAt: payload.endsAt,
        capacity: payload.capacity,
        waitlistCap: payload.waitlistCap,
        instructorUserId: payload.instructorUserId ?? null,
        publishState: payload.publishState,
        version: 1,
        changeNotes: payload.changeNotes,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    await writeClassVersion(database, row, actor.userId, payload.changeNotes);
    await replaceProctorAssignments(database, row.id, normalizedProctorUserIds, actor.userId);
    return row;
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'training.class.created',
    entityType: 'class_instance',
    entityId: String(created.id),
    before: null,
    after: {
      id: created.id,
      capacity: created.capacity,
      waitlistCap: created.waitlistCap,
      publishState: created.publishState,
      version: created.version
    },
    correlationId: actor.correlationId
  });

  return created;
};

export const updateClassInstance = async (
  database: AppDatabase,
  classId: number,
  payload: {
    startsAt?: number;
    endsAt?: number;
    capacity?: number;
    waitlistCap?: number;
    instructorUserId?: number | null;
    proctorUserIds?: number[];
    changeNotes: string;
  },
  actor: { userId: number; correlationId: string }
) => {
  const current = await getClassOrThrow(database, classId);

  if (payload.instructorUserId !== undefined) {
    await assertInstructorAssignment(database, payload.instructorUserId);
  }
  const normalizedProctorUserIds =
    payload.proctorUserIds === undefined ? undefined : normalizeProctorUserIds(payload.proctorUserIds);
  if (normalizedProctorUserIds !== undefined) {
    await assertProctorAssignments(database, normalizedProctorUserIds);
  }

  const nextStartsAt = payload.startsAt ?? current.startsAt;
  const nextEndsAt = payload.endsAt ?? current.endsAt;
  if (nextEndsAt <= nextStartsAt) {
    throw validationFailed('Invalid class schedule', { endsAt: 'must be greater than startsAt' });
  }

  const nextCapacity = payload.capacity ?? current.capacity;
  const nextWaitlistCap = payload.waitlistCap ?? current.waitlistCap;

  const { enrolledCount, waitlistedCount } = await getEnrollmentCounts(database, classId);
  if (nextCapacity < enrolledCount) {
    throw conflict('Capacity cannot be lower than current enrolled count', { enrolledCount, capacity: nextCapacity });
  }
  if (nextWaitlistCap < waitlistedCount) {
    throw conflict('Waitlist cap cannot be lower than current waitlist size', {
      waitlistedCount,
      waitlistCap: nextWaitlistCap
    });
  }

  const updated = await withSqliteTransaction(database, async () => {
    const [row] = await database.db
      .update(classInstances)
      .set({
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
        capacity: nextCapacity,
        waitlistCap: nextWaitlistCap,
        instructorUserId: payload.instructorUserId === undefined ? current.instructorUserId : payload.instructorUserId,
        version: current.version + 1,
        changeNotes: payload.changeNotes,
        updatedAt: nowEpoch()
      })
      .where(eq(classInstances.id, classId))
      .returning();

    await writeClassVersion(database, row, actor.userId, payload.changeNotes);

    if (normalizedProctorUserIds !== undefined) {
      await replaceProctorAssignments(database, classId, normalizedProctorUserIds, actor.userId);
    }

    if (nextCapacity > enrolledCount) {
      for (let i = enrolledCount; i < nextCapacity; i += 1) {
        const promoted = await promoteFromWaitlistIfPossible(database, classId);
        if (!promoted) {
          break;
        }
      }
    }

    return row;
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'training.class.updated',
    entityType: 'class_instance',
    entityId: String(classId),
    before: { version: current.version, capacity: current.capacity, waitlistCap: current.waitlistCap },
    after: { version: updated.version, capacity: updated.capacity, waitlistCap: updated.waitlistCap },
    correlationId: actor.correlationId
  });

  return updated;
};

export const mutateClassPublishState = async (
  database: AppDatabase,
  classId: number,
  publishState: 'published' | 'unpublished',
  changeNotes: string,
  actor: { userId: number; correlationId: string }
) => {
  const current = await getClassOrThrow(database, classId);
  if (current.publishState === publishState) {
    throw conflict(`Class already ${publishState}`);
  }

  const updated = await withSqliteTransaction(database, async () => {
    const [row] = await database.db
      .update(classInstances)
      .set({
        publishState,
        version: current.version + 1,
        changeNotes,
        updatedAt: nowEpoch()
      })
      .where(eq(classInstances.id, classId))
      .returning();

    await writeClassVersion(database, row, actor.userId, changeNotes);
    return row;
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: publishState === 'published' ? 'training.class.published' : 'training.class.unpublished',
    entityType: 'class_instance',
    entityId: String(classId),
    before: { publishState: current.publishState, version: current.version },
    after: { publishState: updated.publishState, version: updated.version },
    correlationId: actor.correlationId
  });

  return updated;
};

export const getClass = async (database: AppDatabase, classId: number) => getClassOrThrow(database, classId);

export const listClasses = async (
  database: AppDatabase,
  query: { page: number; pageSize: number; courseId?: number; publishState?: 'published' | 'unpublished' }
) => {
  const filter = and(
    query.courseId ? eq(classInstances.courseId, query.courseId) : undefined,
    query.publishState ? eq(classInstances.publishState, query.publishState) : undefined
  );

  const [totalRow] = await database.db.select({ total: count() }).from(classInstances).where(filter);
  const rows = await database.db
    .select()
    .from(classInstances)
    .where(filter)
    .orderBy(desc(classInstances.startsAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return {
    rows,
    total: totalRow.total
  };
};

export const getClassVersionHistory = async (database: AppDatabase, classId: number) => {
  await getClassOrThrow(database, classId);

  return database.db
    .select()
    .from(classInstanceVersions)
    .where(eq(classInstanceVersions.classInstanceId, classId))
    .orderBy(desc(classInstanceVersions.version));
};

export const enrollCustomer = async (
  database: AppDatabase,
  classId: number,
  customerId: string,
  actor: { userId: number; correlationId: string }
) => {
  const classRow = await getClassOrThrow(database, classId);

  const existingRows = await database.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.customerId, customerId)))
    .limit(1);
  const existing = existingRows[0];

  if (existing && (existing.status === 'enrolled' || existing.status === 'waitlisted')) {
    throw conflict('Customer already has active enrollment state', { customerId, status: existing.status });
  }

  const { enrolledCount, waitlistedCount } = await getEnrollmentCounts(database, classId);

  const targetStatus =
    enrolledCount < classRow.capacity
      ? 'enrolled'
      : waitlistedCount < classRow.waitlistCap
        ? 'waitlisted'
        : null;

  if (!targetStatus) {
    throw conflict('Class and waitlist are full', {
      capacity: classRow.capacity,
      waitlistCap: classRow.waitlistCap
    });
  }

  const waitlistPosition = targetStatus === 'waitlisted' ? waitlistedCount + 1 : null;
  const now = nowEpoch();

  const enrollment = await withSqliteTransaction(database, async () => {
    if (existing) {
      const [updated] = await database.db
        .update(enrollments)
        .set({
          status: targetStatus,
          waitlistPosition,
          updatedAt: now
        })
        .where(eq(enrollments.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await database.db
      .insert(enrollments)
      .values({
        classInstanceId: classId,
        customerId,
        status: targetStatus,
        waitlistPosition,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    return created;
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'training.enrollment.created_or_updated',
    entityType: 'enrollment',
    entityId: String(enrollment.id),
    before: existing ? { status: existing.status, waitlistPosition: existing.waitlistPosition } : null,
    after: { status: enrollment.status, waitlistPosition: enrollment.waitlistPosition, customerId: enrollment.customerId },
    correlationId: actor.correlationId
  });

  return enrollment;
};

export const cancelEnrollment = async (
  database: AppDatabase,
  classId: number,
  customerId: string,
  actor: { userId: number; correlationId: string }
) => {
  await getClassOrThrow(database, classId);

  const rows = await database.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.customerId, customerId)))
    .limit(1);

  const existing = rows[0];
  if (!existing) {
    throw notFound('Enrollment not found');
  }
  if (existing.status === 'canceled') {
    throw conflict('Enrollment already canceled', { customerId });
  }

  let promotedCustomerId: string | null = null;

  const result = await withSqliteTransaction(database, async () => {
    const [updated] = await database.db
      .update(enrollments)
      .set({ status: 'canceled', waitlistPosition: null, updatedAt: nowEpoch() })
      .where(eq(enrollments.id, existing.id))
      .returning();

    if (existing.status === 'enrolled') {
      promotedCustomerId = await promoteFromWaitlistIfPossible(database, classId);
    } else {
      await resequenceWaitlist(database, classId);
    }

    return updated;
  });

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'training.enrollment.canceled',
    entityType: 'enrollment',
    entityId: String(result.id),
    before: { status: existing.status, waitlistPosition: existing.waitlistPosition },
    after: { status: result.status, waitlistPosition: result.waitlistPosition },
    correlationId: actor.correlationId,
    metadata: promotedCustomerId ? { promotedCustomerId } : undefined
  });

  return result;
};

export const listClassEnrollments = async (database: AppDatabase, classId: number) => {
  await getClassOrThrow(database, classId);
  return database.db
    .select()
    .from(enrollments)
    .where(eq(enrollments.classInstanceId, classId))
    .orderBy(enrollments.status, enrollments.waitlistPosition, enrollments.createdAt);
};

export const recordAttendance = async (
  database: AppDatabase,
  config: { encryptionKey: Buffer },
  classId: number,
  payload: { customerId: string; status: 'present' | 'absent' | 'violation'; personalNote?: string },
  actor: { userId: number; role: UserRole; correlationId: string }
) => {
  const classRow = await getClassOrThrow(database, classId);
  await assertAttendanceAccess(database, classRow, actor, 'write');

  const enrollmentRows = await database.db
    .select({ status: enrollments.status })
    .from(enrollments)
    .where(and(eq(enrollments.classInstanceId, classId), eq(enrollments.customerId, payload.customerId)))
    .limit(1);

  const enrollmentState = enrollmentRows[0]?.status;
  if (enrollmentState !== 'enrolled') {
    throw conflict('Attendance can only be recorded for enrolled customers', {
      classId,
      customerId: payload.customerId,
      enrollmentState: enrollmentState ?? 'none'
    });
  }

  const now = nowEpoch();

  const existingRows = await database.db
    .select()
    .from(attendance)
    .where(and(eq(attendance.classInstanceId, classId), eq(attendance.customerId, payload.customerId)))
    .limit(1);
  const existing = existingRows[0];

  const encryptedNote = payload.personalNote
    ? encryptSensitive(payload.personalNote, config.encryptionKey, `attendance:${classId}:${payload.customerId}`)
    : null;

  const nextValues = {
    status: payload.status,
    recordedByUserId: actor.userId,
    notesCiphertext: encryptedNote?.ciphertext ?? null,
    notesIv: encryptedNote?.iv ?? null,
    notesAuthTag: encryptedNote?.authTag ?? null,
    notesKeyVersion: encryptedNote?.keyVersion ?? null,
    recordedAt: now
  };

  const result = existing
    ? (
        await database.db
          .update(attendance)
          .set(nextValues)
          .where(eq(attendance.id, existing.id))
          .returning()
      )[0]
    : (
        await database.db
          .insert(attendance)
          .values({
            classInstanceId: classId,
            customerId: payload.customerId,
            ...nextValues
          })
          .returning()
      )[0];

  await appendAuditLog(database, {
    actorUserId: actor.userId,
    action: 'training.attendance.recorded',
    entityType: 'attendance',
    entityId: String(result.id),
    before: existing ? { status: existing.status } : null,
    after: { status: result.status, customerId: result.customerId },
    correlationId: actor.correlationId,
    metadata: { role: actor.role }
  });

  return result;
};

export const listAttendanceByClass = async (
  database: AppDatabase,
  classId: number,
  actor: { userId: number; role: UserRole }
) => {
  const classRow = await getClassOrThrow(database, classId);
  await assertAttendanceAccess(database, classRow, actor, 'read');

  return database.db
    .select()
    .from(attendance)
    .where(eq(attendance.classInstanceId, classId))
    .orderBy(desc(attendance.recordedAt));
};
