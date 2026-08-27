DROP INDEX `idx_attempts_leaderboard`;--> statement-breakpoint
ALTER TABLE `attempts` ADD `base_question_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `base_max_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `verdict` text;--> statement-breakpoint
CREATE INDEX `idx_attempts_leaderboard` ON `attempts` (`status`,`score` DESC,`wrong_count` ASC,`duration_seconds` ASC);--> statement-breakpoint
ALTER TABLE `questions` ADD `topic` text DEFAULT 'general' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_answers_question_id` ON `answers` (`question_id`);
