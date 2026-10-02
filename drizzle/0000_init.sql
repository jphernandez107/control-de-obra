CREATE TABLE `ai_interpretations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`document_id` text,
	`provider` text NOT NULL,
	`model` text,
	`intent` text NOT NULL,
	`confidence_pct` integer,
	`provider_output` text,
	`proposal` text NOT NULL,
	`confirmed_proposal` text,
	`status` text NOT NULL,
	`result_entity_type` text,
	`result_entity_id` text,
	`result` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_interpretations_status_idx` ON `ai_interpretations` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` text,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`summary` text NOT NULL,
	`short_summary` text,
	`changes` text,
	`reason` text,
	`metadata` text,
	`supplier_id` text,
	`order_id` text,
	`ai_interpretation_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ai_interpretation_id`) REFERENCES `ai_interpretations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_project_at_idx` ON `audit_log` (`project_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_order_idx` ON `audit_log` (`order_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text,
	`blocks` text,
	`author_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_messages_conversation_idx` ON `chat_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `computation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`computation_id` text NOT NULL,
	`material_id` text NOT NULL,
	`expected_quantity_milli` integer NOT NULL,
	`unit` text NOT NULL,
	`stage` text,
	`waste_basis_points` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`reviewed_ordered_milli` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`computation_id`) REFERENCES `computations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "computation_items_qty_ck" CHECK("computation_items"."expected_quantity_milli" > 0),
	CONSTRAINT "computation_items_waste_ck" CHECK("computation_items"."waste_basis_points" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `computation_items_material_uq` ON `computation_items` (`computation_id`,`material_id`);--> statement-breakpoint
CREATE TABLE `computation_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`computation_id` text NOT NULL,
	`material_id` text NOT NULL,
	`computation_version` integer NOT NULL,
	`change_type` text NOT NULL,
	`previous_quantity_milli` integer,
	`new_quantity_milli` integer NOT NULL,
	`previous_unit` text,
	`new_unit` text NOT NULL,
	`reason` text,
	`source` text NOT NULL,
	`actor_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`computation_id`) REFERENCES `computations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `computation_revisions_material_idx` ON `computation_revisions` (`material_id`);--> statement-breakpoint
CREATE TABLE `computations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source_document_id` text,
	`notes` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `computations_project_uq` ON `computations` (`project_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`order_id` text,
	`delivery_date` text NOT NULL,
	`reference` text,
	`notes` text,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_order_idx` ON `deliveries` (`order_id`);--> statement-breakpoint
CREATE INDEX `deliveries_supplier_idx` ON `deliveries` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `delivery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`order_item_id` text,
	`material_id` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_items_qty_ck" CHECK("delivery_items"."quantity_milli" > 0)
);
--> statement-breakpoint
CREATE INDEX `delivery_items_delivery_idx` ON `delivery_items` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `delivery_items_order_item_idx` ON `delivery_items` (`order_item_id`);--> statement-breakpoint
CREATE TABLE `document_links` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`order_id` text,
	`delivery_id` text,
	`payment_id` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_links_one_target_ck" CHECK(("document_links"."order_id" IS NOT NULL) + ("document_links"."delivery_id" IS NOT NULL) + ("document_links"."payment_id" IS NOT NULL) = 1)
);
--> statement-breakpoint
CREATE INDEX `document_links_document_idx` ON `document_links` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_links_order_idx` ON `document_links` (`order_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text,
	`supplier_id` text,
	`document_date` text,
	`uploaded_by` text,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_kind_ck" CHECK("documents"."kind" IN ('order_proof','delivery_proof','payment_proof','computation','other')),
	CONSTRAINT "documents_size_ck" CHECK("documents"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `material_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`material_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `material_aliases_uq` ON `material_aliases` (`project_id`,`normalized_alias`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`short_name` text NOT NULL,
	`spec` text,
	`base_unit` text NOT NULL,
	`category` text DEFAULT 'Varios' NOT NULL,
	`usual_supplier_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`usual_supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_project_name_uq` ON `materials` (`project_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`document_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`material_id` text NOT NULL,
	`description` text NOT NULL,
	`quantity_milli` integer NOT NULL,
	`unit` text NOT NULL,
	`unit_price_minor` integer,
	`line_total_minor` integer,
	`position` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_qty_ck" CHECK("order_items"."quantity_milli" > 0),
	CONSTRAINT "order_items_price_ck" CHECK(("order_items"."unit_price_minor" IS NULL OR "order_items"."unit_price_minor" >= 0) AND ("order_items"."line_total_minor" IS NULL OR "order_items"."line_total_minor" >= 0))
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_material_idx` ON `order_items` (`material_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`internal_number` integer NOT NULL,
	`reference` text,
	`normalized_reference` text,
	`order_date` text NOT NULL,
	`ordered_by_name` text,
	`ordered_by_user_id` text,
	`purchase_mode` text DEFAULT 'cuenta_corriente' NOT NULL,
	`currency` text DEFAULT 'ARS' NOT NULL,
	`stated_total_minor` integer,
	`notes` text,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ordered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_mode_ck" CHECK("orders"."purchase_mode" IN ('cuenta_corriente','contado')),
	CONSTRAINT "orders_total_ck" CHECK("orders"."stated_total_minor" IS NULL OR "orders"."stated_total_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_internal_number_uq` ON `orders` (`project_id`,`internal_number`);--> statement-breakpoint
CREATE INDEX `orders_supplier_idx` ON `orders` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `orders_reference_idx` ON `orders` (`project_id`,`normalized_reference`);--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_allocations_amount_ck" CHECK("payment_allocations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_idx` ON `payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_order_idx` ON `payment_allocations` (`order_id`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`payment_date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'ARS' NOT NULL,
	`method` text,
	`reference` text,
	`notes` text,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_ck" CHECK("payments"."amount_minor" > 0),
	CONSTRAINT "payments_method_ck" CHECK("payments"."method" IS NULL OR "payments"."method" IN ('transferencia','efectivo','cheque','otro'))
);
--> statement-breakpoint
CREATE INDEX `payments_supplier_idx` ON `payments` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'America/Argentina/Cordoba' NOT NULL,
	`currency` text DEFAULT 'ARS' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`category` text DEFAULT 'Varios' NOT NULL,
	`contact_name` text,
	`phone` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_project_name_uq` ON `suppliers` (`project_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `unit_conversions` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text,
	`from_unit` text NOT NULL,
	`to_unit` text NOT NULL,
	`factor_num` integer NOT NULL,
	`factor_den` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_unit`) REFERENCES `units`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "unit_conversions_factor_ck" CHECK("unit_conversions"."factor_num" > 0 AND "unit_conversions"."factor_den" > 0)
);
--> statement-breakpoint
CREATE TABLE `units` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`singular` text NOT NULL,
	`plural` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`email` text,
	`can_login` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);