export const FREE_TIER_MODE = {
  mode: "cloudflare-workers-free" as const,
  maxCronTriggers: 1,
  workerRequestsPerDayBudget: 100_000,
  maxExternalSubrequestsPerInvocation: 50,
  dailyTaskLimits: {
    "refresh-projections": 2,
    "refresh-context": 12,
    "apply-lineup": 1,
    "send-briefing": 2,
  },
  defaults: {
    maxConfirmedLineupBoxscores: 0,
    useStandingsHistory: true,
    dailyMorningBriefingHourEastern: 10,
    dailyBriefingHourUtcFallback: 22,
  },
};

export type FreeTierTaskName = keyof typeof FREE_TIER_MODE.dailyTaskLimits;
