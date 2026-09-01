CREATE TABLE `security_challenge_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`start_key` text NOT NULL,
	`nickname` text NOT NULL,
	`normalized_nickname` text NOT NULL,
	`participant_key` text NOT NULL,
	`config_id` text NOT NULL,
	`scoring_version` integer NOT NULL,
	`bank_revision` text NOT NULL,
	`pool_revision` text NOT NULL,
	`pool_question_ids` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`completion_reason` text,
	`started_at` integer NOT NULL,
	`total_deadline_at` integer NOT NULL,
	`current_question_started_at` integer NOT NULL,
	`question_deadline_at` integer NOT NULL,
	`current_question_id` integer,
	`current_ordinal` integer DEFAULT 1 NOT NULL,
	`score_units` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`incorrect_count` integer DEFAULT 0 NOT NULL,
	`timeout_count` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`duration_seconds` integer,
	FOREIGN KEY (`config_id`) REFERENCES `security_challenge_configs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_security_challenge_attempts_start_key` ON `security_challenge_attempts` (`start_key`);--> statement-breakpoint
CREATE INDEX `idx_security_challenge_attempts_active_deadline` ON `security_challenge_attempts` (`status`,`total_deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_security_challenge_attempts_leaderboard` ON `security_challenge_attempts` (`config_id`,`scoring_version`,`pool_revision`,`status`,`score_units`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_security_challenge_attempts_participant` ON `security_challenge_attempts` (`participant_key`,`started_at`);--> statement-breakpoint
CREATE TABLE `security_challenge_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`scoring_version` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `security_challenge_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`question_event_id` integer NOT NULL,
	`participant_key` text NOT NULL,
	`comment` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`admin_session_fingerprint` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `security_challenge_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_event_id`) REFERENCES `security_challenge_question_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_security_challenge_feedback_attempt_event` ON `security_challenge_feedback` (`attempt_id`,`question_event_id`);--> statement-breakpoint
CREATE INDEX `idx_security_challenge_feedback_status_created` ON `security_challenge_feedback` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `security_challenge_question_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`difficulty` text NOT NULL,
	`choice_order_json` text NOT NULL,
	`selected_index` integer,
	`canonical_selected_index` integer,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`score_delta_units` integer DEFAULT 0 NOT NULL,
	`presented_at` integer NOT NULL,
	`resolved_at` integer,
	`elapsed_seconds` integer,
	FOREIGN KEY (`attempt_id`) REFERENCES `security_challenge_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_security_challenge_events_attempt_ordinal` ON `security_challenge_question_events` (`attempt_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_security_challenge_events_attempt_question` ON `security_challenge_question_events` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `idx_security_challenge_events_question_outcome` ON `security_challenge_question_events` (`question_id`,`outcome`,`resolved_at`);