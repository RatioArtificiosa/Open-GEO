CREATE TABLE `billing_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
