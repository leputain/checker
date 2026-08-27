ALTER TABLE `attempts` ADD `candidate_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `attempts`
SET `candidate_key` = 'legacy:' || `id`
WHERE `candidate_key` = '';
