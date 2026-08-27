ALTER TABLE `attempts` ADD `telegram_root_message_id` integer;--> statement-breakpoint
CREATE TABLE `__new_telegram_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` integer,
	`event_type` text NOT NULL,
	`payload_text` text NOT NULL,
	`delivery_method` text DEFAULT 'send' NOT NULL,
	`parse_mode` text,
	`silent` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`telegram_message_id` integer,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_telegram_outbox` (
	`id`, `attempt_id`, `question_id`, `event_type`, `payload_text`,
	`delivery_method`, `parse_mode`, `silent`, `status`, `attempt_count`,
	`next_attempt_at`, `lease_token`, `lease_until`, `telegram_message_id`,
	`last_error_code`, `created_at`, `sent_at`
) SELECT
	`id`, `attempt_id`, `question_id`, `event_type`, `payload_text`,
	'send', NULL, 0, `status`, `attempt_count`, `next_attempt_at`, `lease_token`,
	`lease_until`, `telegram_message_id`, `last_error_code`, `created_at`, `sent_at`
FROM `telegram_outbox`;--> statement-breakpoint
DROP TABLE `telegram_outbox`;--> statement-breakpoint
ALTER TABLE `__new_telegram_outbox` RENAME TO `telegram_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_outbox_attempt_event` ON `telegram_outbox` (`attempt_id`,`question_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `idx_telegram_outbox_pending` ON `telegram_outbox` (`status`,`next_attempt_at`,`created_at`);
