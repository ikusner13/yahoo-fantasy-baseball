export const FREE_TIER_MODE = {
  mode: "cloudflare-workers-free" as const,
  maxCronTriggers: 1,
  workerRequestsPerDayBudget: 100_000,
  maxExternalSubrequestsPerInvocation: 50,
  dailyTaskLimits: {
    "refresh-projections": 2,
    "refresh-context": 12,
    "apply-lineup": 1,
    // precompute runs many ticks/day (spec → fan-out → reduce, gated on D1 state) and must be able
    // to retry a died dispatcher on every tick; send-briefing reads the prepared briefing and
    // retries across all 12 daily ticks until it lands — both need generous headroom over the cap.
    precompute: 12,
    "send-briefing": 12,
  },
  defaults: {
    maxConfirmedLineupBoxscores: 0,
    useStandingsHistory: true,
    dailyMorningBriefingHourEastern: 10,
    dailyBriefingHourUtcFallback: 22,
  },
};

export type FreeTierTaskName = keyof typeof FREE_TIER_MODE.dailyTaskLimits;
