CREATE TABLE `analytics_candidate_dimensions` (
	`policy` text NOT NULL,
	`attempt_id` text NOT NULL,
	`topic` text NOT NULL,
	`difficulty` text NOT NULL,
	`question_kind` text NOT NULL,
	PRIMARY KEY(`policy`, `attempt_id`, `topic`, `difficulty`, `question_kind`)
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_candidate_dimensions_filter` ON `analytics_candidate_dimensions` (`policy`,`topic`,`difficulty`,`question_kind`,`attempt_id`);