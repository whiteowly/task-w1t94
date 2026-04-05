import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { permissions } from '../../platform/auth/permissions';
import { validationFailed } from '../../platform/errors/app-error';
import {
  cancelEnrollment,
  createClassInstance,
  createCourse,
  enrollCustomer,
  getClass,
  getClassVersionHistory,
  getCourse,
  listAttendanceByClass,
  listClassEnrollments,
  listClasses,
  listCourses,
  mutateClassPublishState,
  recordAttendance,
  updateClassInstance,
  updateCourse
} from '../../modules/training/training-service';
import {
  attendanceRecordSchema,
  classCreateSchema,
  classCustomerParamsSchema,
  classUpdateSchema,
  courseCreateSchema,
  courseUpdateSchema,
  enrollmentCreateSchema,
  idParamSchema,
  listClassesQuerySchema,
  listCoursesQuerySchema,
  publishMutationSchema
} from '../../modules/training/training-types';

const parseOrFail = <S extends z.ZodTypeAny>(schema: S, payload: unknown, message: string): z.infer<S> => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw validationFailed(message, parsed.error.flatten());
  }
  return parsed.data;
};

const serializeCourse = (row: {
  id: number;
  code: string;
  title: string;
  category: string;
  difficulty: string;
  agePrerequisiteMin: number | null;
  foundationPrerequisitesJson: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: row.id,
  code: row.code,
  title: row.title,
  category: row.category,
  difficulty: row.difficulty,
  agePrerequisiteMin: row.agePrerequisiteMin,
  foundationPrerequisites: JSON.parse(row.foundationPrerequisitesJson),
  active: row.active,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

const serializeClassInstance = (row: {
  id: number;
  courseId: number;
  startsAt: number;
  endsAt: number;
  capacity: number;
  waitlistCap: number;
  instructorUserId: number | null;
  publishState: string;
  version: number;
  changeNotes: string;
  createdAt: number;
  updatedAt: number;
}) => ({
  id: row.id,
  courseId: row.courseId,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  capacity: row.capacity,
  waitlistCap: row.waitlistCap,
  instructorUserId: row.instructorUserId,
  publishState: row.publishState,
  version: row.version,
  changeNotes: row.changeNotes,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export const registerTrainingRoutes = async (fastify: FastifyInstance) => {
  // Courses
  fastify.post('/v1/courses', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const payload = parseOrFail(courseCreateSchema, request.body, 'Invalid course payload');
    const created = await createCourse(
      fastify.appDb,
      {
        code: payload.code,
        title: payload.title,
        category: payload.category,
        difficulty: payload.difficulty,
        agePrerequisiteMin: payload.agePrerequisiteMin ?? null,
        foundationPrerequisites: payload.foundationPrerequisites,
        active: payload.active
      },
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.code(201).send({ course: serializeCourse(created), correlationId: request.id });
  });

  fastify.patch('/v1/courses/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid course id');
    const payload = parseOrFail(courseUpdateSchema, request.body, 'Invalid course update payload');

    const updated = await updateCourse(
      fastify.appDb,
      params.id,
      {
        code: payload.code,
        title: payload.title,
        category: payload.category,
        difficulty: payload.difficulty,
        agePrerequisiteMin: payload.agePrerequisiteMin,
        foundationPrerequisites: payload.foundationPrerequisites,
        active: payload.active
      },
      { userId: request.auth!.userId, correlationId: request.id }
    );

    return reply.send({ course: serializeCourse(updated), correlationId: request.id });
  });

  fastify.get('/v1/courses/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid course id');
    const course = await getCourse(fastify.appDb, params.id);
    return reply.send({ course: serializeCourse(course), correlationId: request.id });
  });

  fastify.get('/v1/courses', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const query = parseOrFail(listCoursesQuerySchema, request.query, 'Invalid courses query');
    const listed = await listCourses(fastify.appDb, query);
    return reply.send({
      items: listed.rows.map(serializeCourse),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  // Classes
  fastify.post('/v1/classes', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const payload = parseOrFail(classCreateSchema, request.body, 'Invalid class payload');
    const created = await createClassInstance(
      fastify.appDb,
      payload,
      { userId: request.auth!.userId, correlationId: request.id }
    );
    return reply.code(201).send({ classInstance: serializeClassInstance(created), correlationId: request.id });
  });

  fastify.patch('/v1/classes/:id', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const payload = parseOrFail(classUpdateSchema, request.body, 'Invalid class update payload');
    const updated = await updateClassInstance(fastify.appDb, params.id, payload, {
      userId: request.auth!.userId,
      correlationId: request.id
    });
    return reply.send({ classInstance: serializeClassInstance(updated), correlationId: request.id });
  });

  fastify.post('/v1/classes/:id/publish', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const payload = parseOrFail(publishMutationSchema, request.body, 'Invalid publish payload');
    const updated = await mutateClassPublishState(fastify.appDb, params.id, 'published', payload.changeNotes, {
      userId: request.auth!.userId,
      correlationId: request.id
    });
    return reply.send({ classInstance: serializeClassInstance(updated), correlationId: request.id });
  });

  fastify.post('/v1/classes/:id/unpublish', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const payload = parseOrFail(publishMutationSchema, request.body, 'Invalid unpublish payload');
    const updated = await mutateClassPublishState(fastify.appDb, params.id, 'unpublished', payload.changeNotes, {
      userId: request.auth!.userId,
      correlationId: request.id
    });
    return reply.send({ classInstance: serializeClassInstance(updated), correlationId: request.id });
  });

  fastify.get('/v1/classes/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const classInstance = await getClass(fastify.appDb, params.id);
    return reply.send({ classInstance: serializeClassInstance(classInstance), correlationId: request.id });
  });

  fastify.get('/v1/classes', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const query = parseOrFail(listClassesQuerySchema, request.query, 'Invalid classes query');
    const listed = await listClasses(fastify.appDb, query);
    return reply.send({
      items: listed.rows.map(serializeClassInstance),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: listed.total,
        totalPages: listed.total === 0 ? 0 : Math.ceil(listed.total / query.pageSize)
      },
      correlationId: request.id
    });
  });

  fastify.get('/v1/classes/:id/versions', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const versions = await getClassVersionHistory(fastify.appDb, params.id);
    return reply.send({ versions, correlationId: request.id });
  });

  // Enrollment/waitlist operations
  fastify.post('/v1/classes/:id/enrollments', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const payload = parseOrFail(enrollmentCreateSchema, request.body, 'Invalid enrollment payload');
    const enrollment = await enrollCustomer(fastify.appDb, params.id, payload.customerId, {
      userId: request.auth!.userId,
      correlationId: request.id
    });

    return reply.code(201).send({ enrollment, correlationId: request.id });
  });

  fastify.delete('/v1/classes/:id/enrollments/:customerId', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(classCustomerParamsSchema, request.params, 'Invalid enrollment route params');
    const canceled = await cancelEnrollment(fastify.appDb, params.id, params.customerId, {
      userId: request.auth!.userId,
      correlationId: request.id
    });

    return reply.send({ enrollment: canceled, correlationId: request.id });
  });

  fastify.get('/v1/classes/:id/enrollments', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.courses.manageSchedules)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const rows = await listClassEnrollments(fastify.appDb, params.id);
    return reply.send({ items: rows, correlationId: request.id });
  });

  // Attendance
  fastify.post('/v1/classes/:id/attendance', { preHandler: [fastify.authenticate, fastify.requirePermission(permissions.attendance.record)] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const payload = parseOrFail(attendanceRecordSchema, request.body, 'Invalid attendance payload');

    const recorded = await recordAttendance(
      fastify.appDb,
      { encryptionKey: fastify.appConfig.encryptionKey },
      params.id,
      payload,
      {
        userId: request.auth!.userId,
        role: request.auth!.role,
        correlationId: request.id
      }
    );

    return reply.send({ attendance: recorded, correlationId: request.id });
  });

  fastify.get('/v1/classes/:id/attendance', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const params = parseOrFail(idParamSchema, request.params, 'Invalid class id');
    const rows = await listAttendanceByClass(fastify.appDb, params.id, {
      userId: request.auth!.userId,
      role: request.auth!.role
    });
    return reply.send({ items: rows, correlationId: request.id });
  });
};
