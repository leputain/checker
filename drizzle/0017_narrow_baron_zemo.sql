CREATE TABLE `question_bank_change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`question_id` integer NOT NULL,
	`predecessor_question_id` integer,
	`successor_question_id` integer,
	`bank_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	`note` text,
	`admin_session_fingerprint` text,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`predecessor_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`successor_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bank_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_events_question` ON `question_bank_change_events` (`question_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_events_predecessor` ON `question_bank_change_events` (`predecessor_question_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_events_successor` ON `question_bank_change_events` (`successor_question_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `question_bank_mutations` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`expected_revision` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_question_bank_mutations_created_at` ON `question_bank_mutations` (`created_at`);--> statement-breakpoint
CREATE TABLE `question_bank_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`current_revision` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`current_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `question_version_links` (
	`predecessor_question_id` integer PRIMARY KEY NOT NULL,
	`successor_question_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`bank_revision` text NOT NULL,
	`admin_session_fingerprint` text,
	FOREIGN KEY (`predecessor_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`successor_question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bank_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_question_version_links_successor` ON `question_version_links` (`successor_question_id`);
--> statement-breakpoint
CREATE TRIGGER `question_bank_mutation_revision_guard`
BEFORE INSERT ON `question_bank_mutations`
WHEN NEW.`expected_revision` != COALESCE(
	(SELECT `current_revision` FROM `question_bank_state` WHERE `id` = 1),
	''
)
BEGIN
	SELECT RAISE(ABORT, 'bank_revision_conflict');
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `question_bank_state` (`id`, `current_revision`, `updated_at`)
SELECT 1, `hash`, `applied_at`
FROM `question_bank_revisions`
ORDER BY `applied_at` DESC, `hash` DESC
LIMIT 1;
--> statement-breakpoint
INSERT INTO `question_bank_change_events` (
	`event_type`, `question_id`, `bank_revision`, `created_at`, `note`
)
SELECT 'created', questions.`id`, state.`current_revision`, state.`updated_at`, 'Импортировано из базового банка'
FROM `questions` questions
JOIN `question_bank_state` state ON state.`id` = 1
JOIN `question_bank_revision_items` membership
	ON membership.`revision_hash` = state.`current_revision`
	AND membership.`question_id` = questions.`id`;
