export const CRON_ROUTINES = [{ expression: "0 12-23 * * *", routine: "scheduler-tick" }] as const;

export type ScheduledRoutineName = (typeof CRON_ROUTINES)[number]["routine"];
export type RoutineName =
  | ScheduledRoutineName
  | "daily-morning"
  | "weekly-planning"
  | "mid-week-adjustment"
  | "late-scratch-check";
