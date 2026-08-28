CREATE TABLE `attempt_questions` (
	`attempt_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`question_kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_question_id` integer,
	`score_value` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	`presented_at` integer,
	PRIMARY KEY(`attempt_id`, `question_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attempt_questions_attempt_ordinal` ON `attempt_questions` (`attempt_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_attempt_questions_question_presentation` ON `attempt_questions` (`question_id`,`presented_at`);--> statement-breakpoint
CREATE TABLE `question_bank_revision_items` (
	`revision_hash` text NOT NULL,
	`question_id` integer NOT NULL,
	`active` integer NOT NULL,
	PRIMARY KEY(`revision_hash`, `question_id`),
	FOREIGN KEY (`revision_hash`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `test_config_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`scoring_version` integer NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `answers` ADD `fact_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `answers` ADD `answer_origin` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `answers` ADD `canonical_selected_index` integer;--> statement-breakpoint
ALTER TABLE `answers` ADD `awarded_score` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `scoring_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `app_version` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `test_config_id` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `test_profile_id` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `analytics_facts_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_attempts_analytics_cohort` ON `attempts` (`status`,`scoring_version`,`test_config_id`,`test_profile_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_analytics_latest` ON `attempts` (`analytics_facts_version`,`status`,`scoring_version`,`test_config_id`,`test_profile_id`,`bank_revision`,`candidate_key`,`completed_at`);
--> statement-breakpoint
UPDATE `attempts`
SET `scoring_version` = 1,
    `app_version` = 'legacy-unknown',
    `test_config_id` = 'legacy-50',
    `test_profile_id` = 'legacy-v1',
    `analytics_facts_version` = 0
WHERE `base_max_score` = 50 AND `status` != 'active';
--> statement-breakpoint
UPDATE `attempts`
SET `scoring_version` = 2,
    `app_version` = '0.7.0',
    `test_config_id` = '8c50cc5d8d7b8b0c738b1357d0acbfef0242e3600a2fe140aa2b2b8d375c76da',
    `test_profile_id` = 'general-v1',
    `analytics_facts_version` = 0
WHERE `base_max_score` = 100 AND `status` != 'active';
