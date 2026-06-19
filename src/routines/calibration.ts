import * as Effect from "effect/Effect";

import {
  buildRetrospective,
  CalibrationHarness,
  isClosedOut,
  outcomesFromTotals,
} from "../services/CalibrationHarness.ts";
import { activeWeeklyLines, rankAddCandidates } from "../services/DecisionEngine.ts";
import { LeagueState } from "../services/LeagueState.ts";
import { StandingsHistory } from "../services/StandingsHistory.ts";
import { WeeklyProjections } from "../services/WeeklyProjections.ts";
import { YahooClient } from "../services/YahooClient.ts";

// F8 recording loop. Two idempotent steps, run from the scheduler tick:
//  - recordCurrentWeekPrediction: upsert the current week's predicted category win-probs plus the
//    exact rosters that were simulated, so the week can be re-scored/swept later.
//  - closeOutPreviousWeek: once a week is final, attach the realized per-category totals.

// Records (or refreshes) the open retrospective for the current matchup week. Upserting on every
// tick keeps the most-informed prediction of the week — lineups/projections firm up as the week
// progresses — which is what we want to grade. Returns the week recorded.
export const recordCurrentWeekPrediction = Effect.gen(function* () {
  const weeklyProjections = yield* WeeklyProjections;
  const leagueState = yield* LeagueState;
  const standingsHistory = yield* StandingsHistory;
  const harness = yield* CalibrationHarness;

  const [set, snapshot, totals] = yield* Effect.all([
    weeklyProjections.currentMatchup,
    leagueState.snapshot,
    standingsHistory.categoryTotals,
  ]);

  const report = rankAddCandidates(set, snapshot, totals);
  const myRoster = activeWeeklyLines(set.myRoster, snapshot);

  yield* harness.record(
    buildRetrospective({
      week: snapshot.matchup.week,
      recordedAt: new Date().toISOString(),
      baseline: report.baseline,
      myRoster,
      opponentRoster: set.opponentRoster,
    }),
  );

  return snapshot.matchup.week;
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
      readonly stat: { readonly stat_id: string | number; readonly value: string | number };
    }>,
  ) => new Map(stats.map((entry) => [String(entry.stat.stat_id), entry.stat.value]));
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
