CREATE TABLE `question_bank_change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`status` text NOT NULL,
	`base_revision` text NOT NULL,
	`published_revision` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	`admin_session_fingerprint` text,
	FOREIGN KEY (`base_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_revision`) REFERENCES `question_bank_revisions`(`hash`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_sets_status_updated` ON `question_bank_change_sets` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_sets_base_revision` ON `question_bank_change_sets` (`base_revision`);--> statement-breakpoint
CREATE TABLE `question_bank_change_set_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`change_set_id` text NOT NULL,
	`question_id` integer NOT NULL,
	`patch_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`change_set_id`) REFERENCES `question_bank_change_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_question_bank_change_set_items_question` ON `question_bank_change_set_items` (`change_set_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `idx_question_bank_change_set_items_change_set` ON `question_bank_change_set_items` (`change_set_id`,`id`);--> statement-breakpoint
CREATE TABLE `question_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`selection_key` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_question_categories_normalized_name` ON `question_categories` (`normalized_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_question_categories_selection_key` ON `question_categories` (`selection_key`);--> statement-breakpoint
CREATE INDEX `idx_question_categories_active_name` ON `question_categories` (`active`,`name`);--> statement-breakpoint
ALTER TABLE `questions` ADD `category_id` integer;
