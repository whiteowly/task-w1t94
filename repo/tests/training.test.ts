import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/app/build-server';
import { hashPassword } from '../src/platform/auth/password';
import { users } from '../src/platform/db/schema';

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

describe('courses/classes/enrollments/attendance slice', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it('enforces role boundaries for operations management and attendance recording', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const ops = await createUserAndLogin(app, database, {
      username: 'ops-role',
      password: 'ops-role-password',
      role: 'operations_manager'
    });
    const admin = await createUserAndLogin(app, database, {
      username: 'admin-role',
      password: 'admin-role-password',
      role: 'administrator'
    });
    const instructor = await createUserAndLogin(app, database, {
      username: 'inst-role',
      password: 'inst-role-password',
      role: 'instructor'
    });
    const proctor = await createUserAndLogin(app, database, {
      username: 'proc-role',
      password: 'proc-role-password',
      role: 'proctor'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-role',
      password: 'sales-role-password',
      role: 'sales_associate'
    });

    const adminForbiddenCourse = await app.inject({
      method: 'POST',
      url: '/v1/courses',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        code: 'COURSE-R1',
        title: 'Role Test Course',
        category: 'safety',
        difficulty: 'beginner',
        agePrerequisiteMin: 16,
        foundationPrerequisites: [],
        active: true
      }
    });
    expect(adminForbiddenCourse.statusCode).toBe(403);
    expectErrorEnvelope(adminForbiddenCourse, 'FORBIDDEN');

    const course = await app.inject({
      method: 'POST',
      url: '/v1/courses',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        code: 'COURSE-R2',
        title: 'Role Test Course',
        category: 'safety',
        difficulty: 'beginner',
        agePrerequisiteMin: 16,
        foundationPrerequisites: ['intro-check'],
        active: true
      }
    });
    expect(course.statusCode).toBe(201);
    const courseId = course.json().course.id as number;

    const classInstance = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        courseId,
        startsAt: 2000000000,
        endsAt: 2000003600,
        capacity: 5,
        waitlistCap: 2,
        instructorUserId: instructor.userId,
        proctorUserIds: [proctor.userId],
        changeNotes: 'Initial schedule',
        publishState: 'unpublished'
      }
    });
    expect(classInstance.statusCode).toBe(201);
    const classId = classInstance.json().classInstance.id as number;

    const salesForbiddenAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/attendance`,
      headers: { authorization: `Bearer ${sales.token}` },
      payload: {
        customerId: 'cust-1',
        status: 'violation',
        personalNote: 'Unsafe behavior'
      }
    });
    expect(salesForbiddenAttendance.statusCode).toBe(403);
    expectErrorEnvelope(salesForbiddenAttendance, 'FORBIDDEN');

    const enrollForAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        customerId: 'cust-1'
      }
    });
    expect(enrollForAttendance.statusCode).toBe(201);
    expect(enrollForAttendance.json().enrollment.status).toBe('enrolled');

    const nonEnrolledAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/attendance`,
      headers: { authorization: `Bearer ${instructor.token}` },
      payload: {
        customerId: 'cust-not-enrolled',
        status: 'absent'
      }
    });
    expect(nonEnrolledAttendance.statusCode).toBe(409);
    expectErrorEnvelope(nonEnrolledAttendance, 'CONFLICT');

    const instructorAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/attendance`,
      headers: { authorization: `Bearer ${instructor.token}` },
      payload: {
        customerId: 'cust-1',
        status: 'violation',
        personalNote: 'Unsafe behavior'
      }
    });
    expect(instructorAttendance.statusCode).toBe(200);
    expect(instructorAttendance.json().attendance.status).toBe('violation');
    expect(instructorAttendance.json().attendance.notesCiphertext).not.toBe('Unsafe behavior');

    const proctorAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/attendance`,
      headers: { authorization: `Bearer ${proctor.token}` },
      payload: {
        customerId: 'cust-1',
        status: 'present'
      }
    });
    expect(proctorAttendance.statusCode).toBe(200);
    expect(proctorAttendance.json().attendance.status).toBe('present');

    const unauthAttendance = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/attendance`,
      payload: {
        customerId: 'cust-2',
        status: 'absent'
      }
    });
    expect(unauthAttendance.statusCode).toBe(401);
    expectErrorEnvelope(unauthAttendance, 'UNAUTHORIZED');
  });

  it('enforces capacity/waitlist operations and promotes waitlisted enrollment when seat opens', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const ops = await createUserAndLogin(app, database, {
      username: 'ops-enroll',
      password: 'ops-enroll-password',
      role: 'operations_manager'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-enroll',
      password: 'sales-enroll-password',
      role: 'sales_associate'
    });

    const course = await app.inject({
      method: 'POST',
      url: '/v1/courses',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        code: 'COURSE-E1',
        title: 'Enrollment Course',
        category: 'operations',
        difficulty: 'intermediate',
        agePrerequisiteMin: null,
        foundationPrerequisites: [],
        active: true
      }
    });
    const courseId = course.json().course.id as number;

    const classResponse = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        courseId,
        startsAt: 2100000000,
        endsAt: 2100003600,
        capacity: 1,
        waitlistCap: 2,
        changeNotes: 'Small class for waitlist testing',
        publishState: 'published'
      }
    });
    expect(classResponse.statusCode).toBe(201);
    const classId = classResponse.json().classInstance.id as number;

    const forbiddenEnroll = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${sales.token}` },
      payload: { customerId: 'cust-A' }
    });
    expect(forbiddenEnroll.statusCode).toBe(403);
    expectErrorEnvelope(forbiddenEnroll, 'FORBIDDEN');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { customerId: 'cust-A' }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().enrollment.status).toBe('enrolled');

    const second = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { customerId: 'cust-B' }
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().enrollment.status).toBe('waitlisted');
    expect(second.json().enrollment.waitlistPosition).toBe(1);

    const third = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { customerId: 'cust-C' }
    });
    expect(third.statusCode).toBe(201);
    expect(third.json().enrollment.status).toBe('waitlisted');
    expect(third.json().enrollment.waitlistPosition).toBe(2);

    const full = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { customerId: 'cust-D' }
    });
    expect(full.statusCode).toBe(409);
    expectErrorEnvelope(full, 'CONFLICT');

    const cancelEnrolled = await app.inject({
      method: 'DELETE',
      url: `/v1/classes/${classId}/enrollments/cust-A`,
      headers: { authorization: `Bearer ${ops.token}` }
    });
    expect(cancelEnrolled.statusCode).toBe(200);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/classes/${classId}/enrollments`,
      headers: { authorization: `Bearer ${ops.token}` }
    });
    expect(listed.statusCode).toBe(200);

    const items = listed.json().items as Array<{ customerId: string; status: string; waitlistPosition: number | null }>;
    const promoted = items.find((row) => row.customerId === 'cust-B');
    const resequenced = items.find((row) => row.customerId === 'cust-C');

    expect(promoted?.status).toBe('enrolled');
    expect(promoted?.waitlistPosition).toBeNull();
    expect(resequenced?.status).toBe('waitlisted');
    expect(resequenced?.waitlistPosition).toBe(1);
  });

  it('tracks class publish/unpublish transitions with version history and handles missing/conflict paths', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const ops = await createUserAndLogin(app, database, {
      username: 'ops-version',
      password: 'ops-version-password',
      role: 'operations_manager'
    });

    const course = await app.inject({
      method: 'POST',
      url: '/v1/courses',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        code: 'COURSE-V1',
        title: 'Versioned Course',
        category: 'advanced',
        difficulty: 'expert',
        agePrerequisiteMin: 18,
        foundationPrerequisites: ['base-a', 'base-b'],
        active: true
      }
    });
    expect(course.statusCode).toBe(201);
    const courseId = course.json().course.id as number;

    const classInstance = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        courseId,
        startsAt: 2200000000,
        endsAt: 2200003600,
        capacity: 10,
        waitlistCap: 5,
        changeNotes: 'Created for version tracking',
        publishState: 'unpublished'
      }
    });
    expect(classInstance.statusCode).toBe(201);
    const classId = classInstance.json().classInstance.id as number;

    const publish = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/publish`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { changeNotes: 'Publishing schedule' }
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().classInstance.publishState).toBe('published');
    expect(publish.json().classInstance.version).toBe(2);

    const republishConflict = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/publish`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { changeNotes: 'Already published' }
    });
    expect(republishConflict.statusCode).toBe(409);
    expectErrorEnvelope(republishConflict, 'CONFLICT');

    const unpublish = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classId}/unpublish`,
      headers: { authorization: `Bearer ${ops.token}` },
      payload: { changeNotes: 'Unpublishing schedule' }
    });
    expect(unpublish.statusCode).toBe(200);
    expect(unpublish.json().classInstance.publishState).toBe('unpublished');
    expect(unpublish.json().classInstance.version).toBe(3);

    const versions = await app.inject({
      method: 'GET',
      url: `/v1/classes/${classId}/versions`,
      headers: { authorization: `Bearer ${ops.token}` }
    });
    expect(versions.statusCode).toBe(200);
    const versionItems = versions.json().versions as Array<{ version: number; changeNotes: string }>;
    expect(versionItems.length).toBeGreaterThanOrEqual(3);
    expect(versionItems[0].version).toBe(3);
    expect(versionItems.some((entry) => entry.changeNotes === 'Publishing schedule')).toBe(true);

    const missingCourseRead = await app.inject({
      method: 'GET',
      url: '/v1/courses/999999',
      headers: { authorization: `Bearer ${ops.token}` }
    });
    expect(missingCourseRead.statusCode).toBe(404);
    expectErrorEnvelope(missingCourseRead, 'NOT_FOUND');

    const missingClassPatch = await app.inject({
      method: 'PATCH',
      url: '/v1/classes/999999',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        capacity: 11,
        changeNotes: 'Missing class update'
      }
    });
    expect(missingClassPatch.statusCode).toBe(404);
    expectErrorEnvelope(missingClassPatch, 'NOT_FOUND');
  });

  it('enforces class-scoped attendance authorization for instructor writes and attendance reads', async () => {
    const { database, dbPath } = createMigratedTestDb();
    cleanup.push(() => database.close());

    const app = await buildServer({ config: buildTestConfig(dbPath), database });
    cleanup.push(() => {
      void app.close();
    });

    const ops = await createUserAndLogin(app, database, {
      username: 'ops-attn-authz',
      password: 'ops-attn-authz-pass',
      role: 'operations_manager'
    });
    const instructorA = await createUserAndLogin(app, database, {
      username: 'inst-attn-a',
      password: 'inst-attn-a-pass',
      role: 'instructor'
    });
    const instructorB = await createUserAndLogin(app, database, {
      username: 'inst-attn-b',
      password: 'inst-attn-b-pass',
      role: 'instructor'
    });
    const proctor = await createUserAndLogin(app, database, {
      username: 'proc-attn-authz',
      password: 'proc-attn-authz-pass',
      role: 'proctor'
    });
    const sales = await createUserAndLogin(app, database, {
      username: 'sales-attn-authz',
      password: 'sales-attn-authz-pass',
      role: 'sales_associate'
    });

    const course = await app.inject({
      method: 'POST',
      url: '/v1/courses',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        code: 'COURSE-ATTN-AUTHZ-1',
        title: 'Attendance Authz Course',
        category: 'safety',
        difficulty: 'intermediate',
        agePrerequisiteMin: null,
        foundationPrerequisites: [],
        active: true
      }
    });
    expect(course.statusCode).toBe(201);
    const courseId = course.json().course.id as number;

    const classA = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        courseId,
        startsAt: 2300000000,
        endsAt: 2300003600,
        capacity: 5,
        waitlistCap: 2,
        instructorUserId: instructorA.userId,
        proctorUserIds: [proctor.userId],
        changeNotes: 'Class A',
        publishState: 'published'
      }
    });
    expect(classA.statusCode).toBe(201);
    const classAId = classA.json().classInstance.id as number;

    const classB = await app.inject({
      method: 'POST',
      url: '/v1/classes',
      headers: { authorization: `Bearer ${ops.token}` },
      payload: {
        courseId,
        startsAt: 2300010000,
        endsAt: 2300013600,
        capacity: 5,
        waitlistCap: 2,
        instructorUserId: instructorB.userId,
        changeNotes: 'Class B',
        publishState: 'published'
      }
    });
    expect(classB.statusCode).toBe(201);
    const classBId = classB.json().classInstance.id as number;

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/classes/${classAId}/enrollments`,
          headers: { authorization: `Bearer ${ops.token}` },
          payload: { customerId: 'cust-a' }
        })
      ).statusCode
    ).toBe(201);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/classes/${classBId}/enrollments`,
          headers: { authorization: `Bearer ${ops.token}` },
          payload: { customerId: 'cust-b' }
        })
      ).statusCode
    ).toBe(201);

    const instructorAOwnWrite = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classAId}/attendance`,
      headers: { authorization: `Bearer ${instructorA.token}` },
      payload: {
        customerId: 'cust-a',
        status: 'present'
      }
    });
    expect(instructorAOwnWrite.statusCode).toBe(200);

    const instructorACrossClassWrite = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classBId}/attendance`,
      headers: { authorization: `Bearer ${instructorA.token}` },
      payload: {
        customerId: 'cust-b',
        status: 'present'
      }
    });
    expect(instructorACrossClassWrite.statusCode).toBe(403);
    expectErrorEnvelope(instructorACrossClassWrite, 'FORBIDDEN');

    const instructorBCrossClassRead = await app.inject({
      method: 'GET',
      url: `/v1/classes/${classAId}/attendance`,
      headers: { authorization: `Bearer ${instructorB.token}` }
    });
    expect(instructorBCrossClassRead.statusCode).toBe(403);
    expectErrorEnvelope(instructorBCrossClassRead, 'FORBIDDEN');

    const salesReadForbidden = await app.inject({
      method: 'GET',
      url: `/v1/classes/${classAId}/attendance`,
      headers: { authorization: `Bearer ${sales.token}` }
    });
    expect(salesReadForbidden.statusCode).toBe(403);
    expectErrorEnvelope(salesReadForbidden, 'FORBIDDEN');

    const opsReadAllowed = await app.inject({
      method: 'GET',
      url: `/v1/classes/${classAId}/attendance`,
      headers: { authorization: `Bearer ${ops.token}` }
    });
    expect(opsReadAllowed.statusCode).toBe(200);
    expect(opsReadAllowed.json().items).toHaveLength(1);

    const proctorCrossClassWrite = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classBId}/attendance`,
      headers: { authorization: `Bearer ${proctor.token}` },
      payload: {
        customerId: 'cust-b',
        status: 'violation',
        personalNote: 'Observed proctor violation'
      }
    });
    expect(proctorCrossClassWrite.statusCode).toBe(403);
    expectErrorEnvelope(proctorCrossClassWrite, 'FORBIDDEN');

    const proctorAssignedWrite = await app.inject({
      method: 'POST',
      url: `/v1/classes/${classAId}/attendance`,
      headers: { authorization: `Bearer ${proctor.token}` },
      payload: {
        customerId: 'cust-a',
        status: 'violation',
        personalNote: 'Observed assigned-class violation'
      }
    });
    expect(proctorAssignedWrite.statusCode).toBe(200);
  });
});
