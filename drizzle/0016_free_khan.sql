ALTER TABLE `analytics_refresh_state` ADD `refresh_token` text;--> statement-breakpoint
ALTER TABLE `analytics_refresh_state` ADD `refresh_generation` integer;--> statement-breakpoint
ALTER TABLE `analytics_refresh_state` ADD `refresh_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `analytics_refresh_state` ADD `refresh_lease_until` integer;