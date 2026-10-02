ALTER TABLE `ai_interpretations` ADD `validation_state` text;--> statement-breakpoint
ALTER TABLE `ai_interpretations` ADD `warnings` text;--> statement-breakpoint
ALTER TABLE `ai_interpretations` ADD `unresolved_fields` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `context_refs` text;