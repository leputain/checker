CREATE TABLE `question_review_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`bank_revision` text NOT NULL,
	`decision` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`admin_session_fingerprint` text,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_question_review_history_question` ON `question_review_history` (`question_id`,`created_at`);