CREATE INDEX `idx_attempts_leaderboard` ON `attempts` (`status`,`score`,`duration_seconds`);--> statement-breakpoint
CREATE INDEX `idx_questions_pool` ON `questions` (`active`,`difficulty`);