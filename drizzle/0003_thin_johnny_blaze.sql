CREATE TABLE `question_bank_revisions` (
	`hash` text PRIMARY KEY NOT NULL,
	`applied_at` integer NOT NULL,
	`total_count` integer NOT NULL,
	`active_count` integer NOT NULL,
	`pools_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_delivery_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`config_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` integer,
	`event_type` text NOT NULL,
	`payload_text` text NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_telegram_outbox_attempt_event` ON `telegram_outbox` (`attempt_id`,`question_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `idx_telegram_outbox_pending` ON `telegram_outbox` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `start_key` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `candidate_name` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `bank_revision` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attempts_start_key` ON `attempts` (`start_key`);--> statement-breakpoint
ALTER TABLE `questions` ADD `content_hash` text;
