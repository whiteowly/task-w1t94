CREATE TABLE `class_proctor_assignments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `class_instance_id` integer NOT NULL,
  `proctor_user_id` integer NOT NULL,
  `assigned_by_user_id` integer,
  `assigned_at` integer NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (`class_instance_id`) REFERENCES `class_instances`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`proctor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`assigned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `class_proctor_assignments_unique` ON `class_proctor_assignments` (`class_instance_id`, `proctor_user_id`);
--> statement-breakpoint
CREATE INDEX `class_proctor_assignments_class_idx` ON `class_proctor_assignments` (`class_instance_id`);
--> statement-breakpoint
CREATE INDEX `class_proctor_assignments_proctor_idx` ON `class_proctor_assignments` (`proctor_user_id`);
