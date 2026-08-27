ALTER TABLE `answers` ADD `elapsed_seconds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `answers` ADD `timed_out` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `context_type` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `context_text` text;