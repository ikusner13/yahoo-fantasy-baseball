import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";

import { ApiCache } from "../services/ApiCache.ts";
import {
  buildRetrospective,
  CalibrationHarness,
  CalibrationVolatilityScale,
  computeVolatilityScaleUpdate,
  isClosedOut,
  outcomesFromTotals,
  VOLATILITY_SCALE_CACHE_KEY,
} from "../services/CalibrationHarness.ts";
import { calibrationInputsFromSpec, StoredSimJob } from "../services/DecisionEngine.ts";
import { LeagueState } from "../services/LeagueState.ts";
import { SIM_JOB_MAX_AGE_MS, simSpecKey } from "../services/SimJob.ts";
import { YahooClient } from "../services/YahooClient.ts";

// F8 recording loop. Two idempotent steps, run from the scheduler tick:
//  - recordCurrentWeekPrediction: upsert the current week's predicted category win-probs plus the
//    exact rosters that were simulated, so the week can be re-scored/swept later.
//  - closeOutPreviousWeek: once a week is final, attach the realized per-category totals.

const easternDateKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

// Records (or refreshes) the open retrospective for the current matchup week. REUSES today's
// already-built sim spec (its baseline counters + the exact simulated rosters are computed ONCE
// during spec-build and persisted) instead of re-running the full Monte Carlo on every tick — that
// inline re-sim was the dominant per-tick CPU cost that defeated the fan-out and stalled the briefing
// pipeline. If today's spec is not built yet, this is a no-op (a later tick records once it lands).
// Returns the week recorded, or undefined when there is nothing to record yet.
export const recordCurrentWeekPrediction = Effect.gen(function* () {
  const cache = yield* ApiCache;
  const leagueState = yield* LeagueState;
  const harness = yield* CalibrationHarness;

  const snapshot = yield* leagueState.snapshot;
  const stored = yield* cache.get(
    simSpecKey(easternDateKey(new Date())),
    StoredSimJob,
    SIM_JOB_MAX_AGE_MS,
  );
  if (stored == null) return undefined;

  const { baseline, myRoster, opponentRoster } = calibrationInputsFromSpec(stored);
  yield* harness.record(
    buildRetrospective({
      week: snapshot.matchup.week,
      recordedAt: new Date().toISOString(),
      baseline,
      myRoster,
      opponentRoster,
    }),
  );

  return snapshot.matchup.week;
});

export const loadVolatilityScale = (cache: Context.Service.Shape<typeof ApiCache>) =>
  cache
    .get(VOLATILITY_SCALE_CACHE_KEY, CalibrationVolatilityScale, 365 * 24 * 60 * 60 * 1000)
    .pipe(Effect.map((record) => record?.scale ?? 1));

export const sweepAndPersistVolatilityScale = Effect.gen(function* () {
  const cache = yield* ApiCache;
  const harness = yield* CalibrationHarness;
  const retros = yield* harness.load();
  const update = computeVolatilityScaleUpdate(retros, [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2]);
  if (update == null) return undefined;
  yield* cache.put(VOLATILITY_SCALE_CACHE_KEY, update);
  return update;
});

// Closes out the just-completed week (current − 1) if it was recorded and is still open. Pulls that
// week's final Yahoo matchup totals and derives win/loss/tie per scoring category. Returns the week
// closed out, or undefined when there is nothing to do.
export const closeOutPreviousWeek = Effect.gen(function* () {
  const leagueState = yield* LeagueState;
  const yahoo = yield* YahooClient;
  const harness = yield* CalibrationHarness;

  const snapshot = yield* leagueState.snapshot;
  const previousWeek = snapshot.matchup.week - 1;
  if (previousWeek < 1) return undefined;

  const recorded = yield* harness.load();
  const existing = recorded.find((retro) => retro.week === previousWeek);
  if (existing == null || isClosedOut(existing)) return undefined;

  const settingsPayload = yield* yahoo.getLeagueSettings;
  const scoringSettings = settingsPayload.fantasy_content.league[1].settings.find(
    (entry) => entry.stat_categories != null,
  );
  const statIdByCategory = new Map(
    scoringSettings?.stat_categories?.stats.map((entry) => [
      entry.stat.display_name,
      String(entry.stat.stat_id),
    ]) ?? [],
  );

  const payload = yield* yahoo.getMatchupForWeek(previousWeek);
  const matchup = payload.fantasy_content.team[1].matchups["0"].matchup;
  // Guard against Yahoo returning the current matchup for an out-of-range week.
  if (matchup.week !== previousWeek) return undefined;

  const valueByStatId = (
    stats: ReadonlyArray<{
      readonly stat: { readonly stat_id: string | number; readonly value: string | number | null };
    }>,
  ) => new Map(stats.map((entry) => [String(entry.stat.stat_id), entry.stat.value ?? Number.NaN]));
  const myValues = valueByStatId(matchup["0"].teams["0"].team[1].team_stats.stats);
  const opponentValues = valueByStatId(matchup["0"].teams["1"].team[1].team_stats.stats);

  const totals = snapshot.scoringCategories.flatMap((category) => {
    const statId = statIdByCategory.get(category);
    if (statId == null) return [];
    const myTotal = Number(myValues.get(statId));
    const opponentTotal = Number(opponentValues.get(statId));
    if (!Number.isFinite(myTotal) || !Number.isFinite(opponentTotal)) return [];
    return [{ category, myTotal, opponentTotal }];
  });
  if (totals.length === 0) return undefined;

  yield* harness.closeOut(previousWeek, outcomesFromTotals(totals));
  return previousWeek;
});
