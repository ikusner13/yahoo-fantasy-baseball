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

export async function dispatchCron(env: Env, cronPattern: string): Promise<void> {
  console.log(`[cron] ${cronPattern} ${new Date().toISOString()}`);

  switch (cronPattern) {
    case "0 13 * * *":
      return runDailyMorning(env);
    case "0 22 * * *":
      return runLateScratchCheck(env);
    case "0 14 * * 1,5,6,SUN": {
      const day = new Date().getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      if (day === 1) return runWeeklyMatchupAnalysis(env);
      if (day === 5) return runTwoStartPreview(env);
      if (day === 6) return runTradeEvaluation(env);
      if (day === 0) return runSundayTactics(env);
      break;
    }
    case "0 19 * * 3":
      return runMidWeekAdjustment(env);
    case "15,45 13-23 * * *":
      return runNewsMonitor(env);
    default:
      console.log(`[cron] unknown pattern: ${cronPattern}`);
  }
}
