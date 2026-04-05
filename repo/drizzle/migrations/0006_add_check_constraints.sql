-- Add CHECK constraints to promotions.type, class_instances.publish_state, and enrollments.status
-- Using SQLite table-rebuild pattern since ALTER TABLE cannot add CHECK constraints

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

-- 1. promotions.type CHECK constraint
CREATE TABLE `promotions_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('spend_and_save','percentage_discount','amount_discount','bundle','member_pricing_tier','voucher')),
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
INSERT INTO `promotions_new` SELECT * FROM `promotions`;
--> statement-breakpoint
DROP TABLE `promotions`;
--> statement-breakpoint
ALTER TABLE `promotions_new` RENAME TO `promotions`;
--> statement-breakpoint
CREATE INDEX `promotions_validity_idx` ON `promotions` (`valid_from_utc_epoch`, `valid_to_utc_epoch`);
--> statement-breakpoint
CREATE INDEX `promotions_active_idx` ON `promotions` (`active`);
--> statement-breakpoint

-- 2. class_instances.publish_state CHECK constraint
CREATE TABLE `class_instances_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `course_id` integer NOT NULL,
  `starts_at` integer NOT NULL,
  `ends_at` integer NOT NULL,
  `capacity` integer NOT NULL CHECK (`capacity` BETWEEN 1 AND 200),
  `waitlist_cap` integer NOT NULL DEFAULT 0 CHECK (`waitlist_cap` BETWEEN 0 AND 50),
  `instructor_user_id` integer,
  `publish_state` text NOT NULL DEFAULT 'unpublished' CHECK (`publish_state` IN ('unpublished','published')),
  `version` integer NOT NULL DEFAULT 1,
  `change_notes` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`instructor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `class_instances_new` SELECT * FROM `class_instances`;
--> statement-breakpoint
DROP TABLE `class_instances`;
--> statement-breakpoint
ALTER TABLE `class_instances_new` RENAME TO `class_instances`;
--> statement-breakpoint
CREATE INDEX `class_instances_starts_at_idx` ON `class_instances` (`starts_at`);
--> statement-breakpoint

-- 3. enrollments.status CHECK constraint
CREATE TABLE `enrollments_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `class_instance_id` integer NOT NULL,
  `customer_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('enrolled','waitlisted','canceled')),
  `waitlist_position` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`class_instance_id`) REFERENCES `class_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `enrollments_new` SELECT * FROM `enrollments`;
--> statement-breakpoint
DROP TABLE `enrollments`;
--> statement-breakpoint
ALTER TABLE `enrollments_new` RENAME TO `enrollments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_class_customer_unique` ON `enrollments` (`class_instance_id`, `customer_id`);
--> statement-breakpoint
CREATE INDEX `enrollments_class_status_idx` ON `enrollments` (`class_instance_id`, `status`);
--> statement-breakpoint

PRAGMA foreign_keys=ON;
