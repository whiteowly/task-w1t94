ALTER TABLE `vouchers` ADD COLUMN `promotion_id` integer REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
CREATE INDEX `vouchers_promotion_idx` ON `vouchers` (`promotion_id`);
--> statement-breakpoint

CREATE TABLE `promotion_redemptions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `promotion_id` integer NOT NULL,
  `customer_id` text NOT NULL,
  `order_id` integer NOT NULL,
  `redeemed_at` integer NOT NULL,
  FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `promotion_redemptions_promotion_customer_idx` ON `promotion_redemptions` (`promotion_id`, `customer_id`);
--> statement-breakpoint
CREATE INDEX `promotion_redemptions_order_idx` ON `promotion_redemptions` (`order_id`);
