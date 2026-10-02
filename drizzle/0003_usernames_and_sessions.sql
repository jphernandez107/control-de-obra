CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_username_idx` ON `login_attempts` (`username`,`at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
DROP INDEX `users_email_uq`;--> statement-breakpoint
ALTER TABLE `users` ADD `username` text;--> statement-breakpoint
ALTER TABLE `users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `is_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);--> statement-breakpoint
-- Sign-in moves from e-mail + Worker secret to username + password hash in the database.
-- The project owner (earliest propietario who could sign in) becomes `juan`, the administrator.
-- The password is set once with `npm run cf:password -- juan` (see README).
UPDATE `users` SET `username` = 'juan', `is_admin` = 1 WHERE `id` = (SELECT `id` FROM `users` WHERE `can_login` = 1 AND `role` = 'propietario' ORDER BY `created_at`, `id` LIMIT 1);--> statement-breakpoint
-- Anyone else had a password only in the old APP_USERS secret; the administrator gives them access again from Usuarios.
UPDATE `users` SET `can_login` = 0 WHERE `can_login` = 1 AND `username` IS NULL;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email`;