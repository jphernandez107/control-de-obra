ALTER TABLE `order_items` ADD `unit_size_milli` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `unit_size_unit` text REFERENCES units(code);