CREATE TABLE `analytics_refresh_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_report_aggregates` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`report_type` text NOT NULL,
	`generation` integer NOT NULL,
	`period_from` text,
	`period_to` text,
	`payload_json` text NOT NULL,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_report_aggregates_type_period` ON `analytics_report_aggregates` (`report_type`,`period_from`,`period_to`);
--> statement-breakpoint
INSERT INTO `analytics_refresh_state` (`id`, `generation`, `updated_at`)
VALUES (1, 1, CAST(strftime('%s', 'now') AS integer) * 1000);
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_attempt_completion_insert`
AFTER INSERT ON `attempts`
WHEN NEW.`status` IN ('completed', 'aborted')
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_attempt_completion_update`
AFTER UPDATE OF `status`, `completed_at`, `score`, `correct_count`, `wrong_count`, `verdict`, `duration_seconds`
ON `attempts`
WHEN NEW.`status` IN ('completed', 'aborted') AND (
  OLD.`status` IS NOT NEW.`status`
  OR OLD.`completed_at` IS NOT NEW.`completed_at`
  OR OLD.`score` IS NOT NEW.`score`
  OR OLD.`correct_count` IS NOT NEW.`correct_count`
  OR OLD.`wrong_count` IS NOT NEW.`wrong_count`
  OR OLD.`verdict` IS NOT NEW.`verdict`
  OR OLD.`duration_seconds` IS NOT NEW.`duration_seconds`
)
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_attempt_delete`
AFTER DELETE ON `attempts`
WHEN OLD.`status` IN ('completed', 'aborted')
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_answer_insert`
AFTER INSERT ON `answers`
WHEN EXISTS (
  SELECT 1 FROM `attempts`
  WHERE `id` = NEW.`attempt_id` AND `status` IN ('completed', 'aborted')
)
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_answer_update`
AFTER UPDATE ON `answers`
WHEN EXISTS (
  SELECT 1 FROM `attempts`
  WHERE `id` = NEW.`attempt_id` AND `status` IN ('completed', 'aborted')
)
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_analytics_answer_delete`
AFTER DELETE ON `answers`
WHEN EXISTS (
  SELECT 1 FROM `attempts`
  WHERE `id` = OLD.`attempt_id` AND `status` IN ('completed', 'aborted')
)
BEGIN
  UPDATE `analytics_refresh_state`
  SET `generation` = `generation` + 1,
      `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
  WHERE `id` = 1;
END;
