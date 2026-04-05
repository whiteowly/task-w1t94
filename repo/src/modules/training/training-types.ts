import { z } from 'zod';

export const courseCreateSchema = z.object({
  code: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(120),
  difficulty: z.string().min(1).max(80),
  agePrerequisiteMin: z.number().int().min(0).max(120).nullable().optional(),
  foundationPrerequisites: z.array(z.string().min(1).max(120)).default([]),
  active: z.boolean().default(true)
});

export const courseUpdateSchema = courseCreateSchema
  .partial()
  .refine((payload) => Object.keys(payload).length > 0, { message: 'At least one field is required' });

export const classCreateSchema = z
  .object({
    courseId: z.number().int().positive(),
    startsAt: z.number().int().positive(),
    endsAt: z.number().int().positive(),
    capacity: z.number().int().min(1).max(200),
    waitlistCap: z.number().int().min(0).max(50),
    instructorUserId: z.number().int().positive().nullable().optional(),
    proctorUserIds: z.array(z.number().int().positive()).max(20).optional(),
    changeNotes: z.string().min(1).max(2000),
    publishState: z.enum(['published', 'unpublished']).default('unpublished')
  })
  .refine((payload) => payload.endsAt > payload.startsAt, {
    message: 'endsAt must be greater than startsAt',
    path: ['endsAt']
  });

export const classUpdateSchema = z
  .object({
    startsAt: z.number().int().positive().optional(),
    endsAt: z.number().int().positive().optional(),
    capacity: z.number().int().min(1).max(200).optional(),
    waitlistCap: z.number().int().min(0).max(50).optional(),
    instructorUserId: z.number().int().positive().nullable().optional(),
    proctorUserIds: z.array(z.number().int().positive()).max(20).optional(),
    changeNotes: z.string().min(1).max(2000)
  })
  .refine(
    (payload) =>
      payload.startsAt !== undefined ||
      payload.endsAt !== undefined ||
      payload.capacity !== undefined ||
      payload.waitlistCap !== undefined ||
      payload.instructorUserId !== undefined ||
      payload.proctorUserIds !== undefined,
    { message: 'At least one mutable field is required' }
  );

export const publishMutationSchema = z.object({
  changeNotes: z.string().min(1).max(2000)
});

export const enrollmentCreateSchema = z.object({
  customerId: z.string().min(1).max(120)
});

export const attendanceRecordSchema = z.object({
  customerId: z.string().min(1).max(120),
  status: z.enum(['present', 'absent', 'violation']),
  personalNote: z.string().max(4000).optional()
});

export const listCoursesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  category: z.string().optional(),
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'))
});

export const listClassesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  courseId: z.coerce.number().int().positive().optional(),
  publishState: z.enum(['published', 'unpublished']).optional()
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive()
});

export const classCustomerParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  customerId: z.string().min(1).max(120)
});
