ALTER TABLE `charging_sessions` ADD COLUMN `exception_reason` text;
--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD COLUMN `compensation_note` text;
--> statement-breakpoint
ALTER TABLE `charging_sessions` ADD COLUMN `compensated_at` integer;
