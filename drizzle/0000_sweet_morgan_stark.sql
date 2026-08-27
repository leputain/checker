CREATE TABLE `answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`selected_index` integer,
	`is_correct` integer NOT NULL,
	`answered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_answers_attempt_question` ON `answers` (`attempt_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`public_alias` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer NOT NULL,
	`total_deadline_at` integer NOT NULL,
	`question_deadline_at` integer NOT NULL,
	`current_question_id` integer,
	`pending_question_ids` text NOT NULL,
	`asked_question_ids` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`wrong_count` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`duration_seconds` integer
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY NOT NULL,
	`difficulty` text NOT NULL,
	`prompt` text NOT NULL,
	`choices_json` text NOT NULL,
	`correct_index` integer NOT NULL,
	`weight` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
