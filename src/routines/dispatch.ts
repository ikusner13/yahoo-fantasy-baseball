import * as Effect from "effect/Effect";

import type { RoutineName } from "../infra/crons.ts";
import { DiscordNotifier } from "../services/DiscordNotifier.ts";
import { LeagueState } from "../services/LeagueState.ts";
import { ManagerBriefing } from "../services/ManagerBriefing.ts";
import { Scheduler } from "../services/Scheduler.ts";
import { TelegramNotifier } from "../services/TelegramNotifier.ts";

const briefingRoutines = new Set<string>([
  "daily-morning",
  "weekly-planning",
  "mid-week-adjustment",
  "late-scratch-check",
]);

export const dispatchRoutine = (routine: RoutineName) =>
  Effect.gen(function* () {
    const leagueState = yield* LeagueState;
    const snapshot = yield* leagueState.snapshot;

    yield* Effect.log("routine stub dispatched", {
      routine,
      leagueId: snapshot.leagueId,
      teamId: snapshot.teamId,
    });

    if (routine === "scheduler-tick") {
      const scheduler = yield* Scheduler;
      const task = yield* scheduler.tick;
      yield* Effect.log("scheduler tick completed", { task });
      return;
    }

    if (!briefingRoutines.has(routine)) return;

    const managerBriefing = yield* ManagerBriefing;
    const telegram = yield* TelegramNotifier;
    const discord = yield* DiscordNotifier;
    const briefing = yield* managerBriefing.currentBriefing;

    yield* telegram.postManagerBriefing(briefing);
    yield* discord.postManagerBriefing(briefing);
  });
