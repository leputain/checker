ALTER TABLE `attempts` ADD `selection_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `selection_strategy` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `coverage_score` real;--> statement-breakpoint
ALTER TABLE `attempts` ADD `shadow_coverage_score` real;
--> statement-breakpoint
UPDATE `attempts`
SET `selection_version` = 1,
    `selection_strategy` = 'random-difficulty-quota-v1'
WHERE `status` != 'active' AND `scoring_version` IN (1, 2);
