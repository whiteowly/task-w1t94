CREATE VIRTUAL TABLE `products_fts_vocab` USING fts5vocab(`products_fts`, 'row');
--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);
--> statement-breakpoint
CREATE INDEX `products_updated_at_idx` ON `products` (`updated_at`);
