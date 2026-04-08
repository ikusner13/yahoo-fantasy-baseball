import type { Env } from "./types";
import {
  runDailyMorning,
  runLateScratchCheck,
  runWeeklyMatchupAnalysis,
  runMidWeekAdjustment,
  runTradeEvaluation,
  runNewsMonitor,
  runSundayTactics,
  runTwoStartPreview,
} from "./gm";
import { withRunContext, logCronStart, logCronEnd, logError } from "./observability/log";

export async function dispatchCron(env: Env, cronPattern: string): Promise<void> {
  const routine = resolveRoutine(cronPattern);
  if (!routine) {
    logError("cron_dispatch", `unknown pattern: ${cronPattern}`);
    return;
  }

  await withRunContext(routine.name, async () => {
    logCronStart(routine.name);
    const start = Date.now();
    try {
      await routine.fn(env);
    } catch (e) {
      logError(`cron_${routine.name}`, e);
      throw e;
    } finally {
      logCronEnd(routine.name, Date.now() - start);
    }
  });
}

function resolveRoutine(
  cronPattern: string,
): { name: string; fn: (env: Env) => Promise<void> } | null {
  switch (cronPattern) {
    case "0 13 * * *":
      return { name: "daily_morning", fn: runDailyMorning };
    case "0 22 * * *":
      return { name: "late_scratch", fn: runLateScratchCheck };
    case "0 14 * * 1,5,6,SUN": {
      const day = new Date().getUTCDay();
      if (day === 1) return { name: "weekly_matchup", fn: runWeeklyMatchupAnalysis };
      if (day === 5) return { name: "two_start_preview", fn: runTwoStartPreview };
      if (day === 6) return { name: "trade_evaluation", fn: runTradeEvaluation };
      if (day === 0) return { name: "sunday_tactics", fn: runSundayTactics };
      return null;
    }
    case "0 19 * * 3":
      return { name: "midweek_adjustment", fn: runMidWeekAdjustment };
    case "15,45 13-23 * * *":
      return { name: "news_monitor", fn: runNewsMonitor };
    default:
      return null;
  }
}
