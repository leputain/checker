ALTER TABLE `attempts` ADD `current_question_started_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `attempts`
SET `current_question_started_at` = MAX(`started_at`, `question_deadline_at` - 60000)
WHERE `current_question_started_at` = 0;
