ALTER TABLE `analytics_daily_question_aggregates` ADD `penalty_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `answers` ADD `penalty_score` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `analytics_refresh_state` SET `generation` = `generation` + 1 WHERE `id` = 1;--> statement-breakpoint
DELETE FROM `analytics_report_aggregates`;
