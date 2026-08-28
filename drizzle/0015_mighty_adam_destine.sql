CREATE INDEX `idx_attempts_facts_readiness` ON `attempts` (`analytics_facts_version`,`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_retention_started` ON `attempts` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_attempts_retention_completed` ON `attempts` (`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_outbox_retention` ON `telegram_outbox` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_outbox_attempt_status` ON `telegram_outbox` (`attempt_id`,`status`);