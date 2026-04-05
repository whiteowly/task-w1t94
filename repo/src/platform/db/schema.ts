import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const roleValues = [
  'administrator',
  'operations_manager',
  'proctor',
  'instructor',
  'sales_associate',
  'auditor'
] as const;

export type UserRole = (typeof roleValues)[number];

const nowEpoch = sql`(unixepoch())`;

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lastLoginAt: integer('last_login_at'),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    usernameUnique: uniqueIndex('users_username_unique').on(table.username),
    roleCheck: check('users_role_check', sql`${table.role} in (${sql.raw(roleValues.map((v) => `'${v}'`).join(','))})`)
  })
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull().default(nowEpoch)
  },
  (table) => ({
    tokenHashUnique: uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    userIdx: index('sessions_user_idx').on(table.userId),
    expiresIdx: index('sessions_expires_idx').on(table.expiresAt)
  })
);

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull(),
    attributesJson: text('attributes_json').notNull().default('{}'),
    fitmentJson: text('fitment_json').notNull().default('{}'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    skuUnique: uniqueIndex('products_sku_unique').on(table.sku),
    activeCategoryIdx: index('products_active_category_idx').on(table.active, table.category)
  })
);

export const productAttributeFacets = sqliteTable(
  'product_attribute_facets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    valueNorm: text('value_norm').notNull()
  },
  (table) => ({
    uniqueFacet: uniqueIndex('product_attribute_facets_unique').on(table.productId, table.key, table.valueNorm),
    filterIdx: index('product_attribute_facets_filter_idx').on(table.key, table.valueNorm, table.productId),
    productFilterIdx: index('product_attribute_facets_product_filter_idx').on(table.productId, table.key, table.valueNorm)
  })
);

export const productFitmentFacets = sqliteTable(
  'product_fitment_facets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    dimension: text('dimension').notNull(),
    valueNorm: text('value_norm').notNull()
  },
  (table) => ({
    uniqueFacet: uniqueIndex('product_fitment_facets_unique').on(table.productId, table.dimension, table.valueNorm),
    filterIdx: index('product_fitment_facets_filter_idx').on(table.dimension, table.valueNorm, table.productId),
    productFilterIdx: index('product_fitment_facets_product_filter_idx').on(table.productId, table.dimension, table.valueNorm)
  })
);

export const promotions = sqliteTable(
  'promotions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    priority: integer('priority').notNull(),
    stackability: text('stackability').notNull(),
    maxRedemptionsPerUser: integer('max_redemptions_per_user').notNull().default(1),
    validFromLocal: text('valid_from_local').notNull(),
    validToLocal: text('valid_to_local').notNull(),
    validFromUtcEpoch: integer('valid_from_utc_epoch').notNull(),
    validToUtcEpoch: integer('valid_to_utc_epoch').notNull(),
    applicabilitySelectorsJson: text('applicability_selectors_json').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    priorityRangeCheck: check('promotions_priority_check', sql`${table.priority} between 1 and 100`),
    validityIdx: index('promotions_validity_idx').on(table.validFromUtcEpoch, table.validToUtcEpoch),
    activeIdx: index('promotions_active_idx').on(table.active)
  })
);

export const vouchers = sqliteTable(
  'vouchers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    promotionId: integer('promotion_id').references(() => promotions.id),
    customerBinding: text('customer_binding'),
    expirationLocal: text('expiration_local').notNull(),
    expirationUtcEpoch: integer('expiration_utc_epoch').notNull(),
    redeemedAt: integer('redeemed_at'),
    redeemedOrderId: integer('redeemed_order_id'),
    createdAt: integer('created_at').notNull().default(nowEpoch)
  },
  (table) => ({
    codeUnique: uniqueIndex('vouchers_code_unique').on(table.code),
    expirationIdx: index('vouchers_expiration_idx').on(table.expirationUtcEpoch),
    promotionIdx: index('vouchers_promotion_idx').on(table.promotionId)
  })
);

export const courses = sqliteTable(
  'courses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    difficulty: text('difficulty').notNull(),
    agePrerequisiteMin: integer('age_prerequisite_min'),
    foundationPrerequisitesJson: text('foundation_prerequisites_json').notNull().default('[]'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    codeUnique: uniqueIndex('courses_code_unique').on(table.code),
    categoryIdx: index('courses_category_idx').on(table.category)
  })
);

export const classInstances = sqliteTable(
  'class_instances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    capacity: integer('capacity').notNull(),
    waitlistCap: integer('waitlist_cap').notNull().default(0),
    instructorUserId: integer('instructor_user_id').references(() => users.id),
    publishState: text('publish_state').notNull().default('unpublished'),
    version: integer('version').notNull().default(1),
    changeNotes: text('change_notes').notNull().default(''),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    capacityRangeCheck: check('class_instances_capacity_check', sql`${table.capacity} between 1 and 200`),
    waitlistRangeCheck: check('class_instances_waitlist_cap_check', sql`${table.waitlistCap} between 0 and 50`),
    startsAtIdx: index('class_instances_starts_at_idx').on(table.startsAt)
  })
);

export const classInstanceVersions = sqliteTable(
  'class_instance_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    classInstanceId: integer('class_instance_id')
      .notNull()
      .references(() => classInstances.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    changeNotes: text('change_notes').notNull().default(''),
    snapshotHash: text('snapshot_hash').notNull(),
    changedByUserId: integer('changed_by_user_id').references(() => users.id),
    changedAt: integer('changed_at').notNull().default(nowEpoch)
  },
  (table) => ({
    classVersionUnique: uniqueIndex('class_instance_versions_unique').on(table.classInstanceId, table.version)
  })
);

export const classProctorAssignments = sqliteTable(
  'class_proctor_assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    classInstanceId: integer('class_instance_id')
      .notNull()
      .references(() => classInstances.id, { onDelete: 'cascade' }),
    proctorUserId: integer('proctor_user_id')
      .notNull()
      .references(() => users.id),
    assignedByUserId: integer('assigned_by_user_id').references(() => users.id),
    assignedAt: integer('assigned_at').notNull().default(nowEpoch)
  },
  (table) => ({
    classProctorUnique: uniqueIndex('class_proctor_assignments_unique').on(table.classInstanceId, table.proctorUserId),
    classIdx: index('class_proctor_assignments_class_idx').on(table.classInstanceId),
    proctorIdx: index('class_proctor_assignments_proctor_idx').on(table.proctorUserId)
  })
);

export const enrollments = sqliteTable(
  'enrollments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    classInstanceId: integer('class_instance_id')
      .notNull()
      .references(() => classInstances.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    status: text('status').notNull(),
    waitlistPosition: integer('waitlist_position'),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    classStatusIdx: index('enrollments_class_status_idx').on(table.classInstanceId, table.status),
    classCustomerUnique: uniqueIndex('enrollments_class_customer_unique').on(table.classInstanceId, table.customerId)
  })
);

export const attendance = sqliteTable(
  'attendance',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    classInstanceId: integer('class_instance_id')
      .notNull()
      .references(() => classInstances.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    status: text('status').notNull(),
    recordedByUserId: integer('recorded_by_user_id')
      .notNull()
      .references(() => users.id),
    notesCiphertext: text('notes_ciphertext'),
    notesIv: text('notes_iv'),
    notesAuthTag: text('notes_auth_tag'),
    notesKeyVersion: text('notes_key_version'),
    recordedAt: integer('recorded_at').notNull().default(nowEpoch)
  },
  (table) => ({
    classCustomerUnique: uniqueIndex('attendance_class_customer_unique').on(table.classInstanceId, table.customerId),
    statusIdx: index('attendance_status_idx').on(table.status)
  })
);

export const chargingSessions = sqliteTable(
  'charging_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    customerId: text('customer_id').notNull(),
    chargerAssetId: text('charger_asset_id').notNull(),
    status: text('status').notNull(),
    meteredKwhThousandths: integer('metered_kwh_thousandths').notNull().default(0),
    exceptionReason: text('exception_reason'),
    compensationNote: text('compensation_note'),
    compensatedAt: integer('compensated_at'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    statusIdx: index('charging_sessions_status_idx').on(table.status)
  })
);

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    customerId: text('customer_id'),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    taxMinor: integer('tax_minor').notNull().default(0),
    depositMinor: integer('deposit_minor').notNull().default(0),
    balanceMinor: integer('balance_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull().default(0),
    pricingBreakdownJson: text('pricing_breakdown_json').notNull().default('{}'),
    draftExpiresAt: integer('draft_expires_at'),
    finalizedAt: integer('finalized_at'),
    canceledAt: integer('canceled_at'),
    refundedAt: integer('refunded_at'),
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    statusIdx: index('orders_status_idx').on(table.status),
    draftExpiryIdx: index('orders_draft_expiry_idx').on(table.draftExpiresAt)
  })
);

export const orderIdempotencyKeys = sqliteTable(
  'order_idempotency_keys',
  {
    key: text('key').primaryKey(),
    orderId: integer('order_id').references(() => orders.id),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull().default(nowEpoch)
  },
  (table) => ({
    expiresIdx: index('order_idempotency_keys_expires_idx').on(table.expiresAt)
  })
);

export const orderLines = sqliteTable(
  'order_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineType: text('line_type').notNull(),
    sku: text('sku'),
    description: text('description').notNull().default(''),
    quantity: integer('quantity').notNull().default(1),
    unitAmountMinor: integer('unit_amount_minor').notNull(),
    lineAmountMinor: integer('line_amount_minor').notNull()
  },
  (table) => ({
    orderIdx: index('order_lines_order_idx').on(table.orderId)
  })
);

export const payments = sqliteTable(
  'payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    referenceCiphertext: text('reference_ciphertext'),
    referenceIv: text('reference_iv'),
    referenceAuthTag: text('reference_auth_tag'),
    referenceKeyVersion: text('reference_key_version'),
    notesCiphertext: text('notes_ciphertext'),
    notesIv: text('notes_iv'),
    notesAuthTag: text('notes_auth_tag'),
    notesKeyVersion: text('notes_key_version'),
    recordedAt: integer('recorded_at').notNull().default(nowEpoch),
    recordedByUserId: integer('recorded_by_user_id').references(() => users.id)
  },
  (table) => ({
    orderIdx: index('payments_order_idx').on(table.orderId)
  })
);

export const promotionRedemptions = sqliteTable(
  'promotion_redemptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    promotionId: integer('promotion_id')
      .notNull()
      .references(() => promotions.id),
    customerId: text('customer_id').notNull(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    redeemedAt: integer('redeemed_at').notNull()
  },
  (table) => ({
    promotionCustomerIdx: index('promotion_redemptions_promotion_customer_idx').on(table.promotionId, table.customerId),
    orderIdx: index('promotion_redemptions_order_idx').on(table.orderId)
  })
);

export const reconciliationRecords = sqliteTable(
  'reconciliation_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').references(() => orders.id),
    state: text('state').notNull().default('pending'),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    stateIdx: index('reconciliation_records_state_idx').on(table.state)
  })
);

export const reconciliationTransitions = sqliteTable(
  'reconciliation_transitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recordId: integer('record_id')
      .notNull()
      .references(() => reconciliationRecords.id, { onDelete: 'cascade' }),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    transitionedAt: integer('transitioned_at').notNull().default(nowEpoch),
    transitionedByUserId: integer('transitioned_by_user_id').references(() => users.id),
    transitionNote: text('transition_note')
  },
  (table) => ({
    recordTransitionIdx: index('reconciliation_transitions_record_idx').on(table.recordId, table.transitionedAt)
  })
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    occurredAt: integer('occurred_at').notNull().default(nowEpoch),
    actorUserId: integer('actor_user_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    beforeHash: text('before_hash').notNull(),
    afterHash: text('after_hash').notNull(),
    prevHash: text('prev_hash'),
    entryHash: text('entry_hash').notNull(),
    correlationId: text('correlation_id').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}')
  },
  (table) => ({
    occurredIdx: index('audit_logs_occurred_idx').on(table.occurredAt),
    entityIdx: index('audit_logs_entity_idx').on(table.entityType, table.entityId)
  })
);

export const exportJobs = sqliteTable(
  'export_jobs',
  {
    id: text('id').primaryKey(),
    jobType: text('job_type').notNull(),
    status: text('status').notNull(),
    scheduledForLocal: text('scheduled_for_local').notNull(),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    filePath: text('file_path'),
    checksumSha256: text('checksum_sha256'),
    rowCount: integer('row_count'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at').notNull().default(nowEpoch),
    updatedAt: integer('updated_at').notNull().default(nowEpoch)
  },
  (table) => ({
    jobTypeIdx: index('export_jobs_job_type_idx').on(table.jobType),
    statusIdx: index('export_jobs_status_idx').on(table.status)
  })
);

export const schema = {
  users,
  sessions,
  products,
  productAttributeFacets,
  productFitmentFacets,
  promotions,
  vouchers,
  promotionRedemptions,
  courses,
  classInstances,
  classInstanceVersions,
  classProctorAssignments,
  enrollments,
  attendance,
  chargingSessions,
  orders,
  orderIdempotencyKeys,
  orderLines,
  payments,
  reconciliationRecords,
  reconciliationTransitions,
  auditLogs,
  exportJobs
};
