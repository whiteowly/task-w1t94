CREATE INDEX IF NOT EXISTS `product_attribute_facets_product_filter_idx`
ON `product_attribute_facets` (`product_id`, `key`, `value_norm`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_fitment_facets_product_filter_idx`
ON `product_fitment_facets` (`product_id`, `dimension`, `value_norm`);
