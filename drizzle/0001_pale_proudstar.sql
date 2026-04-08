CREATE TABLE `gm_reflections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`reflection` text NOT NULL,
	`runs_covered` text NOT NULL
);
