PRAGMA foreign_keys=ON;
--> statement-breakpoint

CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `username` text NOT NULL,
  `password_hash` text NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('administrator','operations_manager','proctor','instructor','sales_associate','auditor')),
  `failed_login_count` integer NOT NULL DEFAULT 0,
  `last_login_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint

CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` integer NOT NULL,
  `token_hash` text NOT NULL,
  `issued_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `revoked_at` integer,
  `ip_address` text,
  `user_agent` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint

CREATE TABLE `products` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sku` text NOT NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `category` text NOT NULL,
  `attributes_json` text NOT NULL DEFAULT '{}',
  `fitment_json` text NOT NULL DEFAULT '{}',
  `active` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);
--> statement-breakpoint
CREATE INDEX `products_active_category_idx` ON `products` (`active`, `category`);
--> statement-breakpoint

CREATE TABLE `product_attribute_facets` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_id` integer NOT NULL,
  `key` text NOT NULL,
  `value_norm` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_attribute_facets_unique` ON `product_attribute_facets` (`product_id`, `key`, `value_norm`);
--> statement-breakpoint
CREATE INDEX `product_attribute_facets_filter_idx` ON `product_attribute_facets` (`key`, `value_norm`, `product_id`);
--> statement-breakpoint

CREATE TABLE `product_fitment_facets` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_id` integer NOT NULL,
  `dimension` text NOT NULL,
  `value_norm` text NOT NULL,
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_fitment_facets_unique` ON `product_fitment_facets` (`product_id`, `dimension`, `value_norm`);
--> statement-breakpoint
CREATE INDEX `product_fitment_facets_filter_idx` ON `product_fitment_facets` (`dimension`, `value_norm`, `product_id`);
--> statement-breakpoint

CREATE VIRTUAL TABLE `products_fts` USING fts5(`name`, `description`, content='products', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER `products_ai_fts` AFTER INSERT ON `products` BEGIN
  INSERT INTO `products_fts`(rowid, name, description) VALUES (new.id, new.name, new.description);
END;
--> statement-breakpoint
CREATE TRIGGER `products_au_fts` AFTER UPDATE ON `products` BEGIN
  INSERT INTO `products_fts`(`products_fts`, rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
  INSERT INTO `products_fts`(rowid, name, description) VALUES (new.id, new.name, new.description);
END;
--> statement-breakpoint
CREATE TRIGGER `products_ad_fts` AFTER DELETE ON `products` BEGIN
  INSERT INTO `products_fts`(`products_fts`, rowid, name, description) VALUES ('delete', old.id, old.name, old.description);
END;
--> statement-breakpoint

CREATE TABLE `promotions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `priority` integer NOT NULL CHECK (`priority` BETWEEN 1 AND 100),
  `stackability` text NOT NULL CHECK (`stackability` IN ('exclusive','stackable')),
  `max_redemptions_per_user` integer NOT NULL DEFAULT 1,
  `valid_from_local` text NOT NULL,
  `valid_to_local` text NOT NULL,
  `valid_from_utc_epoch` integer NOT NULL,
  `valid_to_utc_epoch` integer NOT NULL,
  `applicability_selectors_json` text NOT NULL,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `promotions_validity_idx` ON `promotions` (`valid_from_utc_epoch`, `valid_to_utc_epoch`);
--> statement-breakpoint
CREATE INDEX `promotions_active_idx` ON `promotions` (`active`);
--> statement-breakpoint

CREATE TABLE `vouchers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL,
  `customer_binding` text,
  `expiration_local` text NOT NULL,
  `expiration_utc_epoch` integer NOT NULL,
  `redeemed_at` integer,
  `redeemed_order_id` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_code_unique` ON `vouchers` (`code`);
--> statement-breakpoint
CREATE INDEX `vouchers_expiration_idx` ON `vouchers` (`expiration_utc_epoch`);
--> statement-breakpoint

CREATE TABLE `courses` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL,
  `title` text NOT NULL,
  `category` text NOT NULL,
  `difficulty` text NOT NULL,
  `age_prerequisite_min` integer,
  `foundation_prerequisites_json` text NOT NULL DEFAULT '[]',
  `active` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_code_unique` ON `courses` (`code`);
--> statement-breakpoint
CREATE INDEX `courses_category_idx` ON `courses` (`category`);
--> statement-breakpoint

CREATE TABLE `class_instances` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `course_id` integer NOT NULL,
  `starts_at` integer NOT NULL,
  `ends_at` integer NOT NULL,
  `capacity` integer NOT NULL CHECK (`capacity` BETWEEN 1 AND 200),
  `waitlist_cap` integer NOT NULL DEFAULT 0 CHECK (`waitlist_cap` BETWEEN 0 AND 50),
  `instructor_user_id` integer,
  `publish_state` text NOT NULL DEFAULT 'unpublished',
  `version` integer NOT NULL DEFAULT 1,
  `change_notes` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`instructor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `class_instances_starts_at_idx` ON `class_instances` (`starts_at`);
--> statement-breakpoint

CREATE TABLE `class_instance_versions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `class_instance_id` integer NOT NULL,
  `version` integer NOT NULL,
  `change_notes` text NOT NULL DEFAULT '',
  `snapshot_hash` text NOT NULL,
  `changed_by_user_id` integer,
  `changed_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`class_instance_id`) REFERENCES `class_instances`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`changed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `class_instance_versions_unique` ON `class_instance_versions` (`class_instance_id`, `version`);
--> statement-breakpoint

CREATE TABLE `enrollments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `class_instance_id` integer NOT NULL,
  `customer_id` text NOT NULL,
  `status` text NOT NULL,
  `waitlist_position` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`class_instance_id`) REFERENCES `class_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_class_customer_unique` ON `enrollments` (`class_instance_id`, `customer_id`);
--> statement-breakpoint
CREATE INDEX `enrollments_class_status_idx` ON `enrollments` (`class_instance_id`, `status`);
--> statement-breakpoint

CREATE TABLE `attendance` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `class_instance_id` integer NOT NULL,
  `customer_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('present','absent','violation')),
  `recorded_by_user_id` integer NOT NULL,
  `notes_ciphertext` text,
  `notes_iv` text,
  `notes_auth_tag` text,
  `notes_key_version` text,
  `recorded_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`class_instance_id`) REFERENCES `class_instances`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_class_customer_unique` ON `attendance` (`class_instance_id`, `customer_id`);
--> statement-breakpoint
CREATE INDEX `attendance_status_idx` ON `attendance` (`status`);
--> statement-breakpoint

CREATE TABLE `charging_sessions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `customer_id` text NOT NULL,
  `charger_asset_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('started','ended','exception','compensated')),
  `metered_kwh_thousandths` integer NOT NULL DEFAULT 0,
  `started_at` integer NOT NULL,
  `ended_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `charging_sessions_status_idx` ON `charging_sessions` (`status`);
--> statement-breakpoint

CREATE TABLE `orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('draft','finalized','canceled','refunded')),
  `customer_id` text,
  `subtotal_minor` integer NOT NULL DEFAULT 0,
  `discount_minor` integer NOT NULL DEFAULT 0,
  `tax_minor` integer NOT NULL DEFAULT 0,
  `deposit_minor` integer NOT NULL DEFAULT 0,
  `balance_minor` integer NOT NULL DEFAULT 0,
  `total_minor` integer NOT NULL DEFAULT 0,
  `pricing_breakdown_json` text NOT NULL DEFAULT '{}',
  `draft_expires_at` integer,
  `finalized_at` integer,
  `canceled_at` integer,
  `refunded_at` integer,
  `created_by_user_id` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);
--> statement-breakpoint
CREATE INDEX `orders_draft_expiry_idx` ON `orders` (`draft_expires_at`);
--> statement-breakpoint

CREATE TABLE `order_idempotency_keys` (
  `key` text PRIMARY KEY NOT NULL,
  `order_id` integer,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_idempotency_keys_expires_idx` ON `order_idempotency_keys` (`expires_at`);
--> statement-breakpoint

CREATE TABLE `order_lines` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer NOT NULL,
  `line_type` text NOT NULL,
  `sku` text,
  `description` text NOT NULL DEFAULT '',
  `quantity` integer NOT NULL DEFAULT 1,
  `unit_amount_minor` integer NOT NULL,
  `line_amount_minor` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_lines_order_idx` ON `order_lines` (`order_id`);
--> statement-breakpoint

CREATE TABLE `payments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer NOT NULL,
  `method` text NOT NULL CHECK (`method` IN ('cash','check','manual_card_entry')),
  `amount_minor` integer NOT NULL,
  `reference_ciphertext` text,
  `reference_iv` text,
  `reference_auth_tag` text,
  `reference_key_version` text,
  `notes_ciphertext` text,
  `notes_iv` text,
  `notes_auth_tag` text,
  `notes_key_version` text,
  `recorded_at` integer NOT NULL DEFAULT (unixepoch()),
  `recorded_by_user_id` integer,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);
--> statement-breakpoint

CREATE TABLE `reconciliation_records` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` integer,
  `state` text NOT NULL DEFAULT 'pending' CHECK (`state` IN ('pending','reviewed','exported','archived')),
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliation_records_state_idx` ON `reconciliation_records` (`state`);
--> statement-breakpoint

CREATE TABLE `reconciliation_transitions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `record_id` integer NOT NULL,
  `from_state` text NOT NULL,
  `to_state` text NOT NULL,
  `transitioned_at` integer NOT NULL DEFAULT (unixepoch()),
  `transitioned_by_user_id` integer,
  `transition_note` text,
  FOREIGN KEY (`record_id`) REFERENCES `reconciliation_records`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`transitioned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliation_transitions_record_idx` ON `reconciliation_transitions` (`record_id`, `transitioned_at`);
--> statement-breakpoint

CREATE TABLE `audit_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `occurred_at` integer NOT NULL DEFAULT (unixepoch()),
  `actor_user_id` integer,
  `action` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `before_hash` text NOT NULL,
  `after_hash` text NOT NULL,
  `prev_hash` text,
  `entry_hash` text NOT NULL,
  `correlation_id` text NOT NULL,
  `metadata_json` text NOT NULL DEFAULT '{}',
  FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_logs_occurred_idx` ON `audit_logs` (`occurred_at`);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`, `entity_id`);
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs` BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs` BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;
--> statement-breakpoint

CREATE TABLE `export_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `job_type` text NOT NULL CHECK (`job_type` IN ('analytics','reconciliation')),
  `status` text NOT NULL CHECK (`status` IN ('pending','running','completed','failed')),
  `scheduled_for_local` text NOT NULL,
  `started_at` integer,
  `completed_at` integer,
  `file_path` text,
  `checksum_sha256` text,
  `row_count` integer,
  `error_message` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX `export_jobs_job_type_idx` ON `export_jobs` (`job_type`);
--> statement-breakpoint
CREATE INDEX `export_jobs_status_idx` ON `export_jobs` (`status`);
