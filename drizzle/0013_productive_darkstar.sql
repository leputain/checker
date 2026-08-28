CREATE TABLE `analytics_candidate_aggregates` (
	`policy` text NOT NULL,
	`attempt_id` text NOT NULL,
	`candidate_key` text NOT NULL,
	`display_alias` text NOT NULL,
	`day` text NOT NULL,
	`bank_revision` text NOT NULL,
	`app_version` text NOT NULL,
	`scoring_version` integer NOT NULL,
	`test_config_id` text NOT NULL,
	`test_profile_id` text NOT NULL,
	`selection_version` integer NOT NULL,
	`selection_strategy` text NOT NULL,
	`coverage_score` real,
	`shadow_coverage_score` real,
	`status` text NOT NULL,
	`score` integer NOT NULL,
	`correct_count` integer NOT NULL,
	`wrong_count` integer NOT NULL,
	`verdict` text,
	`completed_at` integer,
	`event_at` integer NOT NULL,
	`duration_seconds` integer,
	`base_answered` integer NOT NULL,
	`base_correct` integer NOT NULL,
	`additional_answered` integer NOT NULL,
	`additional_correct` integer NOT NULL,
	`timeout_count` integer NOT NULL,
	PRIMARY KEY(`policy`, `attempt_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_candidates_cohort_day` ON `analytics_candidate_aggregates` (`policy`,`scoring_version`,`test_config_id`,`test_profile_id`,`bank_revision`,`day`,`completed_at`);--> statement-breakpoint
CREATE TABLE `analytics_daily_choice_aggregates` (
	`policy` text NOT NULL,
	`day` text NOT NULL,
	`bank_revision` text NOT NULL,
	`app_version` text NOT NULL,
	`scoring_version` integer NOT NULL,
	`test_config_id` text NOT NULL,
	`test_profile_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`question_kind` text NOT NULL,
	`canonical_index` integer NOT NULL,
	`selected_count` integer NOT NULL,
	PRIMARY KEY(`policy`, `day`, `bank_revision`, `app_version`, `scoring_version`, `test_config_id`, `test_profile_id`, `question_id`, `question_kind`, `canonical_index`)
);
--> statement-breakpoint
CREATE TABLE `analytics_daily_question_aggregates` (
	`policy` text NOT NULL,
	`day` text NOT NULL,
	`bank_revision` text NOT NULL,
	`app_version` text NOT NULL,
	`scoring_version` integer NOT NULL,
	`test_config_id` text NOT NULL,
	`test_profile_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`question_kind` text NOT NULL,
	`topic` text NOT NULL,
	`difficulty` text NOT NULL,
	`active` integer NOT NULL,
	`assigned_count` integer NOT NULL,
	`presented_count` integer NOT NULL,
	`outcome_count` integer NOT NULL,
	`correct_count` integer NOT NULL,
	`incorrect_count` integer NOT NULL,
	`timeout_count` integer NOT NULL,
	`response_count` integer NOT NULL,
	`elapsed_sum` integer NOT NULL,
	`elapsed_min` integer,
	`elapsed_max` integer,
	`last_presented_at` integer,
	`last_answered_at` integer,
	`earned_score` integer NOT NULL,
	`max_score` integer NOT NULL,
	`discrimination_n` integer NOT NULL,
	`discrimination_sum_x` real NOT NULL,
	`discrimination_sum_y` real NOT NULL,
	`discrimination_sum_y2` real NOT NULL,
	`discrimination_sum_xy` real NOT NULL,
	PRIMARY KEY(`policy`, `day`, `bank_revision`, `app_version`, `scoring_version`, `test_config_id`, `test_profile_id`, `question_id`, `question_kind`)
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_daily_questions_cohort` ON `analytics_daily_question_aggregates` (`policy`,`scoring_version`,`test_config_id`,`test_profile_id`,`bank_revision`,`day`);--> statement-breakpoint
CREATE TABLE `analytics_daily_timing_aggregates` (
	`policy` text NOT NULL,
	`day` text NOT NULL,
	`bank_revision` text NOT NULL,
	`app_version` text NOT NULL,
	`scoring_version` integer NOT NULL,
	`test_config_id` text NOT NULL,
	`test_profile_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`question_kind` text NOT NULL,
	`elapsed_seconds` integer NOT NULL,
	`response_count` integer NOT NULL,
	PRIMARY KEY(`policy`, `day`, `bank_revision`, `app_version`, `scoring_version`, `test_config_id`, `test_profile_id`, `question_id`, `question_kind`, `elapsed_seconds`)
);
--> statement-breakpoint
ALTER TABLE `analytics_refresh_state` ADD `built_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analytics_refresh_state` ADD `built_at` integer;
