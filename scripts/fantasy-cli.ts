import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as dotenv from "dotenv";
import { Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { makeApiCacheTest } from "../src/services/ApiCache.ts";
import {
  DailyLineupAdvisor,
  dailyLineupPlayersFromPayload,
} from "../src/services/DailyLineupAdvisor.ts";
import { LeagueState } from "../src/services/LeagueState.ts";
import {
  buildYahooApplyPlan,
  ManagerBriefing,
  StrategicBriefInputs,
  type YahooApplyPlan,
} from "../src/services/ManagerBriefing.ts";
import { makePlayerIdentityTest } from "../src/services/PlayerIdentity.ts";
import { ProjectionData } from "../src/services/ProjectionData.ts";
import { StandingsHistory } from "../src/services/StandingsHistory.ts";
import { computeSgpDenominators } from "../src/services/DecisionEngine.ts";
import { renderManagerBriefingForTelegram } from "../src/services/TelegramNotifier.ts";
import { TransactionPlanner } from "../src/services/TransactionPlanner.ts";
import { WeeklyProjections } from "../src/services/WeeklyProjections.ts";
import { YahooLineupExecutor } from "../src/services/YahooLineupExecutor.ts";
import { managerHealthDefaults } from "../src/services/ManagerHealth.ts";
import {
  memoryYahooTokenStore,
  YahooOAuth,
  type YahooStoredTokens,
} from "../src/services/YahooOAuth.ts";
import {
  buildTransactionXml,
  YahooClient,
  type YahooRosterPayload,
} from "../src/services/YahooClient.ts";

const envFileFromArgv = () => {
  const index = process.argv.indexOf("--env-file");
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith("--env-file="));
  return inline?.slice("--env-file=".length);
};

dotenv.config({
  path: envFileFromArgv() ?? process.env["FANTASY_GM_ENV_FILE"] ?? ".env.local",
  quiet: true,
});

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON output"),
);

const envFileFlag = Flag.string("env-file").pipe(
  Flag.withDescription("Environment file to load before contacting Yahoo"),
  Flag.withDefault(".env.local"),
);

const countFlag = Flag.integer("count").pipe(
  Flag.withDescription("Number of rows to fetch"),
  Flag.withDefault(25),
);

const dateFlag = Flag.string("date").pipe(
  Flag.withDescription("Yahoo roster date, formatted YYYY-MM-DD"),
  Flag.withDefault(new Date().toISOString().slice(0, 10)),
);

const workerUrlFlag = Flag.string("worker-url").pipe(
  Flag.withDescription("Fantasy GM Worker base URL for admin status checks"),
  Flag.withDefault(
    process.env["FANTASY_GM_WORKER_URL"] ??
      "https://fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l.ikusner13.workers.dev",
  ),
);

const maxBriefingAgeMinutesFlag = Flag.integer("max-briefing-age-minutes").pipe(
  Flag.withDescription("Fail status when cached briefing is older than this many minutes"),
  Flag.withDefault(managerHealthDefaults.maxBriefingAgeMinutes),
);

const requireSentTodayFlag = Flag.boolean("require-sent-today").pipe(
  Flag.withDescription("Fail status when send-briefing has not completed today"),
);

const requireDeliveryFlag = Flag.boolean("require-delivery").pipe(
  Flag.withDescription("Fail status when the latest briefing has no successful delivery report"),
);

const requireDeliveredTodayFlag = Flag.boolean("require-delivered-today").pipe(
  Flag.withDescription("Fail status when no channel successfully delivered today's briefing"),
);

const allowMissingTodayMessageFlag = Flag.boolean("allow-missing-today-message").pipe(
  Flag.withDescription("Do not fail status when today's briefing was not sent or delivered"),
);

const allowUnauthorizedWritesFlag = Flag.boolean("allow-unauthorized-writes").pipe(
  Flag.withDescription("Do not fail status when Yahoo read/write lineup execution is unauthorized"),
);

const forceRegenerateFlag = Flag.boolean("force-regenerate").pipe(
  Flag.withDescription("Recover stale or missing briefings by forcing send-briefing"),
);

const workerFlag = Flag.boolean("worker").pipe(
  Flag.withDescription("Recompute the briefing in the production Worker without sending it"),
);

const cachedFlag = Flag.boolean("cached").pipe(
  Flag.withDescription("Read the cached production Worker briefing instead of recomputing it"),
);

const applyFlag = Flag.boolean("apply").pipe(
  Flag.withDescription("Actually write safe lineup position moves to Yahoo"),
);

const allPitchersFlag = Flag.boolean("all").pipe(
  Flag.withDescription("Show every rostered pitcher, including IL and zero-start pitchers"),
);

const root = Command.make("gm").pipe(
  Command.withSharedFlags({
    json: jsonFlag,
    envFile: envFileFlag,
  }),
  Command.withDescription("Local Yahoo Fantasy Baseball GM inspection tools"),
);

const loadEnv = (path: string) =>
  Effect.sync(() => {
    dotenv.config({ path, override: true, quiet: true });
  });

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const requireEnv = (name: string) =>
  Effect.sync(() => {
    const value = process.env[name];
    if (value == null || value === "") {
      throw new Error(`${name} is required`);
    }
    return value;
  });

const fetchJson = (url: string, method = "GET", allowErrorStatus = false) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { method });
      const body = await response.text();
      if (!response.ok && !allowErrorStatus) {
        throw new Error(`${response.status} ${response.statusText}: ${body}`);
      }
      return JSON.parse(body) as unknown;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

type SchedulerStatusPayload = {
  readonly ok: boolean;
  readonly status: {
    readonly date: string;
    readonly tasks: ReadonlyArray<{
      readonly task: string;
      readonly completedAt?: string;
      readonly runCountToday: number;
      readonly canRunToday: boolean;
    }>;
  };
};

type ManagerHealthPayload = {
  readonly ok: boolean;
  readonly health: {
    readonly ok: boolean;
    readonly failures: ReadonlyArray<string>;
    readonly briefingAgeMinutes?: number;
    readonly sendBriefingCompletedAt?: string;
    readonly deliveryDeliveredAt?: string;
    readonly deliverySucceeded?: boolean;
  };
  readonly status: SchedulerStatusPayload["status"];
  readonly briefing?: {
    readonly generatedAt: string;
    readonly summary: string;
    readonly managerTakeaways: ReadonlyArray<string>;
    readonly lineupAlertCount: number;
  };
  readonly delivery?: {
    readonly generatedAt: string;
    readonly deliveredAt: string;
    readonly channels: ReadonlyArray<{
      readonly channel: string;
      readonly ok: boolean;
      readonly completedAt: string;
      readonly error?: string;
    }>;
  };
  readonly writeStatus?: {
    readonly checkedAt: string;
    readonly capability: "authorized" | "unauthorized" | "dry-run-only" | "unknown";
    readonly action: string;
    readonly ok: boolean;
    readonly date?: string;
    readonly error?: string;
  };
};

type RecoverBriefingResponse = {
  readonly ok: boolean;
  readonly action: "none" | "resend" | "force-send-briefing" | "blocked";
  readonly error?: string;
  readonly health?: ManagerHealthPayload["health"];
  readonly healthBefore?: ManagerHealthPayload["health"];
  readonly briefingGeneratedAt?: string;
  readonly delivery?: ManagerHealthPayload["delivery"];
  readonly ran?: boolean;
};

type RunSchedulerTaskResponse = {
  readonly ok: boolean;
  readonly task: string;
  readonly ran: boolean;
  readonly force: boolean;
};

type BriefingPreviewResponse = {
  readonly ok: boolean;
  readonly live: boolean;
  readonly briefing?: {
    readonly generatedAt: string;
    readonly summary: string;
  };
  readonly telegramText?: string;
  readonly error?: string;
};

type YahooAuthUrlPayload = {
  readonly ok: boolean;
  readonly scope: string;
  readonly redirectUri: string;
  readonly authUrl: string;
};

const fetchYahooAuthUrl = (baseUrl: string, token: string) =>
  fetchJson(`${baseUrl}/admin/yahoo/auth-url?token=${encodeURIComponent(token)}`) as Effect.Effect<
    YahooAuthUrlPayload,
    Error
  >;

const formatAge = (isoTime: string | undefined) => {
  if (isoTime == null) return "never";
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return isoTime;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const formatEasternTime = (isoTime: string | undefined) => {
  if (isoTime == null) return "time TBD";
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return isoTime;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const formatPlayerLine = (player: {
  readonly name: string;
  readonly team: string;
  readonly selectedPosition: string;
  readonly eligiblePositions: ReadonlyArray<string>;
  readonly status?: string;
}) => {
  const status = player.status == null || player.status === "" ? "" : ` ${player.status}`;
  return `${player.selectedPosition.padEnd(4)} ${player.name.padEnd(24)} ${player.team.padEnd(
    4,
  )} ${player.eligiblePositions.join(",")}${status}`;
};

const rosterPlayersFromPayload = (payload: YahooRosterPayload) =>
  payload.fantasy_content.team[1].roster["0"].players.map((entry) => {
    const [player, selectedPosition] = entry.player;
    return {
      playerKey: player.playerKey,
      playerId: player.playerId,
      name: player.name,
      team: player.team,
      eligiblePositions: player.eligiblePositions,
      selectedPosition: selectedPosition?.position ?? "BN",
      status: player.status,
    };
  });

type RosterPlayer = {
  readonly playerKey: string;
  readonly playerId: string;
  readonly name: string;
  readonly team: string;
  readonly eligiblePositions: ReadonlyArray<string>;
  readonly selectedPosition: string;
  readonly status?: string;
};

const reserveSlots = new Set(["BN", "IL", "NA"]);
const activeRosterSlots = new Set(["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]);
const lowerIsBetterCategories = new Set(["ERA", "WHIP"]);
const plausibleFlipThresholds: Readonly<Record<string, number>> = {
  R: 8,
  H: 6,
  HR: 2,
  RBI: 8,
  SB: 2,
  TB: 12,
  OBP: 0.015,
  OUT: 12,
  K: 8,
  ERA: 0.5,
  WHIP: 0.12,
  QS: 1,
  "SV+H": 1,
};

type MatchupCategory = {
  readonly category: string;
  readonly myValue: string;
  readonly opponentValue: string;
};

const numericMatchupValue = (value: string) => {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const matchupCategoryStatus = (category: MatchupCategory) => {
  const mine = numericMatchupValue(category.myValue);
  const opponent = numericMatchupValue(category.opponentValue);
  if (mine == null || opponent == null || Math.abs(mine - opponent) < 0.0001) return "tied";
  const winning = lowerIsBetterCategories.has(category.category)
    ? mine < opponent
    : mine > opponent;
  return winning ? "winning" : "losing";
};

const matchupDeficit = (category: MatchupCategory) => {
  const mine = numericMatchupValue(category.myValue);
  const opponent = numericMatchupValue(category.opponentValue);
  if (mine == null || opponent == null) return Number.POSITIVE_INFINITY;
  return lowerIsBetterCategories.has(category.category) ? mine - opponent : opponent - mine;
};

const isPlausibleMatchupFlip = (category: MatchupCategory) => {
  const status = matchupCategoryStatus(category);
  if (status === "tied") return true;
  if (status !== "losing") return false;
  return matchupDeficit(category) <= (plausibleFlipThresholds[category.category] ?? 0);
};

const matchupTriage = (categories: ReadonlyArray<MatchupCategory>) => ({
  protect: categories.filter((category) => matchupCategoryStatus(category) === "winning"),
  flips: categories.filter(isPlausibleMatchupFlip),
  longShots: categories.filter(
    (category) => matchupCategoryStatus(category) === "losing" && !isPlausibleMatchupFlip(category),
  ),
});

const matchupCategoryLine = (category: MatchupCategory) =>
  `${category.category} ${category.myValue}-${category.opponentValue}`;

const selectedPositionRank = (position: string) => {
  if (position === "C") return 0;
  if (position === "1B") return 1;
  if (position === "2B") return 2;
  if (position === "3B") return 3;
  if (position === "SS") return 4;
  if (position === "OF") return 5;
  if (position === "Util") return 6;
  if (position === "SP") return 7;
  if (position === "RP") return 8;
  if (position === "P") return 9;
  if (position === "BN") return 10;
  if (position === "IL") return 11;
  if (position === "NA") return 12;
  return 13;
};

const lineupBuckets = (players: ReadonlyArray<RosterPlayer>) => ({
  active: players
    .filter((player) => !reserveSlots.has(player.selectedPosition))
    .sort(
      (a, b) =>
        selectedPositionRank(a.selectedPosition) - selectedPositionRank(b.selectedPosition) ||
        a.name.localeCompare(b.name),
    ),
  bench: players
    .filter((player) => player.selectedPosition === "BN")
    .sort((a, b) => a.name.localeCompare(b.name)),
  il: players
    .filter((player) => player.selectedPosition === "IL")
    .sort((a, b) => a.name.localeCompare(b.name)),
  na: players
    .filter((player) => player.selectedPosition === "NA")
    .sort((a, b) => a.name.localeCompare(b.name)),
});

const runWithEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const options = yield* root;
    yield* loadEnv(options.envFile);
    return yield* effect;
  });

const team = Command.make(
  "team",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const leagueState = yield* LeagueState;
        const snapshot = yield* leagueState.snapshot;

        if (options.json) {
          yield* printJson(snapshot);
          return;
        }

        yield* Console.log(`League ${snapshot.leagueId} / Team ${snapshot.teamId}`);
        yield* Console.log(
          `Week ${snapshot.matchup.week}: ${snapshot.matchup.weekStart}..${snapshot.matchup.weekEnd}`,
        );
        yield* Console.log(
          `Opponent: ${snapshot.matchup.opponentTeamName} (${snapshot.matchup.opponentTeamKey})`,
        );
        yield* Console.log(
          `Adds: ${snapshot.addsUsed}/${snapshot.weeklyAddLimit} used, ${
            snapshot.weeklyAddLimit - snapshot.addsUsed
          } remaining`,
        );
        yield* Console.log(
          `Waiver priority: ${snapshot.waiverPriority ?? "unknown"} | FAAB: ${
            snapshot.faabBalance ?? "unknown"
          }`,
        );
        yield* Console.log(`IL: ${snapshot.ilUsed}/${snapshot.ilSlots}`);
        yield* Console.log("");
        yield* Console.log("Empty slots");
        if (snapshot.emptySlots.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const slot of snapshot.emptySlots) {
            yield* Console.log(`- ${slot.position}: ${slot.count}`);
          }
        }
        yield* Console.log("");
        yield* Console.log("Closest matchup categories");
        for (const category of snapshot.matchup.categories) {
          yield* Console.log(
            `- ${category.category}: ${category.myValue} vs ${category.opponentValue}`,
          );
        }
      }),
    );
  }),
).pipe(
  Command.withDescription("Show the current team snapshot: matchup, adds, slots, and roster state"),
);

const roster = Command.make(
  "roster",
  {
    date: dateFlag,
  },
  Effect.fn(function* ({ date }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getRosterForDate(date);
        const players = rosterPlayersFromPayload(payload);

        if (options.json) {
          yield* printJson({ date, players });
          return;
        }

        yield* Console.log(`Roster ${date} (${players.length})`);
        for (const player of players) {
          yield* Console.log(formatPlayerLine(player));
        }
      }),
    );
  }),
).pipe(
  Command.withDescription("List your current Yahoo roster with selected and eligible positions"),
);

const lineup = Command.make(
  "lineup",
  {
    date: dateFlag,
  },
  Effect.fn(function* ({ date }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getRosterForDate(date);
        const players = dailyLineupPlayersFromPayload(payload);
        const buckets = lineupBuckets(players);

        if (options.json) {
          yield* printJson({ date, ...buckets });
          return;
        }

        yield* Console.log(`Lineup ${date}`);
        yield* Console.log("");
        yield* Console.log("Active");
        for (const player of buckets.active) {
          yield* Console.log(formatPlayerLine(player));
        }
        yield* Console.log("");
        yield* Console.log("Bench");
        if (buckets.bench.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const player of buckets.bench) {
            yield* Console.log(formatPlayerLine(player));
          }
        }
        yield* Console.log("");
        yield* Console.log("IL");
        if (buckets.il.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const player of buckets.il) {
            yield* Console.log(formatPlayerLine(player));
          }
        }
        yield* Console.log("");
        yield* Console.log("NA");
        if (buckets.na.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const player of buckets.na) {
            yield* Console.log(formatPlayerLine(player));
          }
        }
      }),
    );
  }),
).pipe(Command.withDescription("Show active, bench, IL, and NA slots for a specific Yahoo date"));

const lineupCheck = Command.make(
  "lineup-check",
  {
    date: dateFlag,
  },
  Effect.fn(function* ({ date }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const advisor = yield* DailyLineupAdvisor;
        const report = yield* advisor.forDate(date);

        if (options.json) {
          yield* printJson(report);
          return;
        }

        yield* Console.log(`Lineup check ${date}`);
        yield* Console.log("Scope: lineup-only; no drops recommended.");
        yield* Console.log("");
        yield* Console.log("IL capacity");
        if (report.ilUsed == null || report.ilSlots == null || report.openIlSlots == null) {
          yield* Console.log("- unavailable");
        } else {
          yield* Console.log(
            `- ${report.ilUsed}/${report.ilSlots} used, ${report.openIlSlots} open (${report.ilBatterUsed ?? 0} batter, ${report.ilPitcherUsed ?? 0} pitcher)`,
          );
        }
        yield* Console.log("");
        yield* Console.log("Empty slots");
        if (report.emptySlots.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const slot of report.emptySlots) {
            yield* Console.log(`- ${slot.position}: ${slot.count}`);
          }
        }
        const openActiveSlots = report.emptySlots.filter((slot) =>
          activeRosterSlots.has(slot.position),
        );
        yield* Console.log("");
        yield* Console.log("Open active slots");
        if (openActiveSlots.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const slot of openActiveSlots) {
            yield* Console.log(`- ${slot.position}: ${slot.count}`);
          }
        }
        yield* Console.log("");
        yield* Console.log("Hard-unavailable active players");
        if (report.activeUnavailable.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const player of report.activeUnavailable) {
            yield* Console.log(
              `- ${player.name} is active at ${player.selectedPosition} with status ${player.status}`,
            );
          }
        }
        yield* Console.log("");
        yield* Console.log("Recommended internal moves");
        if (
          report.ilActivationMoves.length === 0 &&
          report.activeToIlMoves.length === 0 &&
          report.replacementOptions.length === 0
        ) {
          yield* Console.log("- none");
        } else {
          const pairedActivationKeys = new Set<string>();
          const pairedIlMoveKeys = new Set<string>();
          const pairedReplacementKeys = new Set<string>();
          for (const activation of report.ilActivationMoves) {
            if (activation.to === "BN") continue;
            const ilMove = report.activeToIlMoves.find(
              (move) => !pairedIlMoveKeys.has(move.playerKey) && move.from === activation.to,
            );
            if (ilMove == null) continue;
            pairedActivationKeys.add(activation.playerKey);
            pairedIlMoveKeys.add(ilMove.playerKey);
            yield* Console.log(
              `- Swap ${activation.playerName} into ${activation.to} and move ${ilMove.playerName} to IL (${ilMove.status})`,
            );
          }
          for (const ilMove of report.activeToIlMoves) {
            if (pairedIlMoveKeys.has(ilMove.playerKey)) continue;
            const replacement = report.replacementOptions.find(
              (move) =>
                !pairedReplacementKeys.has(move.replacementPlayerKey) &&
                move.outPlayerKey === ilMove.playerKey &&
                move.slot === ilMove.from,
            );
            if (replacement == null) continue;
            pairedIlMoveKeys.add(ilMove.playerKey);
            pairedReplacementKeys.add(replacement.replacementPlayerKey);
            yield* Console.log(
              `- Swap ${replacement.replacementPlayerName} into ${replacement.slot} and move ${ilMove.playerName} to IL (${ilMove.status})`,
            );
          }
          for (const move of report.ilActivationMoves) {
            if (pairedActivationKeys.has(move.playerKey)) continue;
            yield* Console.log(`- Move ${move.playerName} from IL to ${move.to}`);
          }
          for (const move of report.activeToIlMoves) {
            if (pairedIlMoveKeys.has(move.playerKey)) continue;
            yield* Console.log(
              `- Move ${move.playerName} from ${move.from} to IL (${move.status})`,
            );
          }
          for (const move of report.replacementOptions) {
            if (pairedReplacementKeys.has(move.replacementPlayerKey)) continue;
            yield* Console.log(
              `- Replace ${move.outPlayerName} at ${move.slot} with ${move.replacementPlayerName} from BN`,
            );
          }
          if (report.blockedIlMoves > 0) {
            yield* Console.log(
              `- ${report.blockedIlMoves} additional active unavailable player(s) cannot move to IL until capacity opens`,
            );
          }
        }
        yield* Console.log("");
        yield* Console.log("Bench players who can fill open roster slots");
        if (report.fillableOpenSlots.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const move of report.fillableOpenSlots) {
            yield* Console.log(`- Move ${move.playerName} from BN to ${move.slot}`);
          }
        }
        yield* Console.log("");
        yield* Console.log("Softer active status risks");
        if (report.activeStatusRisks.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const player of report.activeStatusRisks) {
            yield* Console.log(
              `- ${player.name} is active at ${player.selectedPosition} with status ${player.status}`,
            );
          }
        }
        yield* Console.log("");
        yield* Console.log("Drop guardrail");
        yield* Console.log(
          "- This command does not recommend drops; long-term value is preserved.",
        );
      }),
    );
  }),
).pipe(Command.withDescription("Find conservative daily lineup issues without recommending drops"));

const pitcherStarts = Command.make(
  "pitcher-starts",
  {
    all: allPitchersFlag,
  },
  Effect.fn(function* ({ all }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const planner = yield* TransactionPlanner;
        const leagueState = yield* LeagueState;
        const [plan, snapshot] = yield* Effect.all([planner.currentPlan, leagueState.snapshot], {
          concurrency: 1,
        });
        const pitcherSlots = snapshot.emptySlots.filter((slot) =>
          ["SP", "RP", "P"].includes(slot.position),
        );
        const starts = plan.pitcherStarts ?? [];
        const visibleStarts = all
          ? starts
          : starts.filter(
              (pitcher) =>
                !["IL", "IL+"].includes(pitcher.selectedPosition) || pitcher.expectedStarts > 0,
            );
        const activeNoStart = starts.filter(
          (pitcher) =>
            !["BN", "IL", "IL+"].includes(pitcher.selectedPosition) && pitcher.expectedStarts <= 0,
        );
        const activeSpNoStart = activeNoStart.filter(
          (pitcher) => pitcher.selectedPosition === "SP",
        );
        const activeFlexibleNoStart = activeNoStart.filter(
          (pitcher) => pitcher.selectedPosition === "P",
        );
        const activeReliefNoStart = activeNoStart.filter(
          (pitcher) => pitcher.selectedPosition === "RP",
        );
        const benchStarts = starts.filter(
          (pitcher) => pitcher.selectedPosition === "BN" && pitcher.expectedStarts > 0,
        );
        const activeStarts = starts.filter(
          (pitcher) =>
            !["BN", "IL", "IL+"].includes(pitcher.selectedPosition) && pitcher.expectedStarts > 0,
        );

        if (options.json) {
          yield* printJson({
            matchup: snapshot.matchup,
            projectedWeeklyIp: plan.projectedWeeklyIp,
            emptyPitcherSlots: pitcherSlots,
            activeStarts,
            benchStarts,
            activeNoStart,
            pitcherStarts: visibleStarts,
          });
          return;
        }

        yield* Console.log(
          `Pitcher starts: week ${snapshot.matchup.week} (${snapshot.matchup.weekStart}..${snapshot.matchup.weekEnd})`,
        );
        yield* Console.log(`Projected IP: ${plan.projectedWeeklyIp.toFixed(1)} / 20.0 floor`);
        yield* Console.log("");
        yield* Console.log("Open pitcher slots");
        if (pitcherSlots.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const slot of pitcherSlots) {
            yield* Console.log(`- ${slot.position}: ${slot.count}`);
          }
        }
        yield* Console.log("");
        yield* Console.log("Rostered pitchers");
        if (visibleStarts.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const pitcher of visibleStarts) {
            const marker =
              pitcher.expectedStarts >= 2
                ? "two-start"
                : pitcher.expectedStarts > 0
                  ? "scheduled"
                  : "no remaining start";
            const details =
              pitcher.starts == null || pitcher.starts.length === 0
                ? marker
                : pitcher.starts
                    .map(
                      (start) =>
                        `${start.date} ${formatEasternTime(start.gameTime)} ${start.homeAway === "home" ? "vs" : "@"} ${start.opponentTeam}`,
                    )
                    .join("; ");
            yield* Console.log(
              `- ${pitcher.selectedPosition.padEnd(3)} ${pitcher.playerName.padEnd(24)} ${pitcher.expectedStarts.toFixed(1)} start(s), ${pitcher.projectedIp.toFixed(1)} IP, ${pitcher.projectedK.toFixed(1)} K (${details})`,
            );
          }
        }
        yield* Console.log("");
        yield* Console.log("Decision checks");
        if (benchStarts.length > 0) {
          for (const pitcher of benchStarts) {
            yield* Console.log(
              `- Bench scheduled start: ${pitcher.playerName} has ${pitcher.expectedStarts.toFixed(1)} expected start(s); make sure a SP/P slot is filled before lock.`,
            );
          }
        }
        if (activeSpNoStart.length > 0) {
          for (const pitcher of activeSpNoStart) {
            yield* Console.log(
              `- Active SP with no remaining start: ${pitcher.playerName} is in ${pitcher.selectedPosition}; use this slot for a scheduled starter when one is available before lock.`,
            );
          }
        }
        if (activeFlexibleNoStart.length > 0) {
          for (const pitcher of activeFlexibleNoStart) {
            yield* Console.log(
              `- Active P with no remaining start: ${pitcher.playerName} is in ${pitcher.selectedPosition}; keep only if no scheduled SP is available or ratios/SV+H matter more than start volume.`,
            );
          }
        }
        if (activeReliefNoStart.length > 0) {
          for (const pitcher of activeReliefNoStart) {
            yield* Console.log(
              `- Active RP context: ${pitcher.playerName} has no start projection; evaluate as SV+H/ratio volume, not as a missed SP start.`,
            );
          }
        }
        if (benchStarts.length === 0 && activeNoStart.length === 0) {
          yield* Console.log("- no obvious pitcher-start positioning issue");
        }
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Audit rostered pitchers by expected starts, projected IP/K, and open SP/RP/P slots",
  ),
);

const matchup = Command.make(
  "matchup",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const leagueState = yield* LeagueState;
        const snapshot = yield* leagueState.snapshot;

        if (options.json) {
          yield* printJson(snapshot.matchup);
          return;
        }

        yield* Console.log(
          `Week ${snapshot.matchup.week}: ${snapshot.matchup.weekStart}..${snapshot.matchup.weekEnd}`,
        );
        yield* Console.log(`Opponent: ${snapshot.matchup.opponentTeamName}`);
        yield* Console.log("");
        for (const category of snapshot.matchup.categories) {
          yield* Console.log(
            `${category.category.padEnd(5)} ${category.myValue} vs ${category.opponentValue}`,
          );
        }
        const triage = matchupTriage(snapshot.matchup.categories);
        yield* Console.log("");
        yield* Console.log("Category triage");
        yield* Console.log(
          triage.flips.length > 0
            ? `- Plausible flips: ${triage.flips.map(matchupCategoryLine).join(", ")}`
            : "- Plausible flips: none within the simple event-distance thresholds",
        );
        yield* Console.log(
          triage.protect.length > 0
            ? `- Protect: ${triage.protect.map(matchupCategoryLine).join(", ")}`
            : "- Protect: no current category leads",
        );
        yield* Console.log(
          triage.longShots.length > 0
            ? `- Long shots: ${triage.longShots.map(matchupCategoryLine).join(", ")}`
            : "- Long shots: none",
        );
        yield* Console.log("");
        yield* Console.log(
          "Note: triage is scoreboard distance only; manager decisions still require lineup legality, locks, adds, schedules, and drop guardrails.",
        );
      }),
    );
  }),
).pipe(Command.withDescription("Show the live Yahoo matchup scoreboard"));

const briefing = Command.make(
  "briefing",
  {
    workerUrl: workerUrlFlag,
    worker: workerFlag,
    cached: cachedFlag,
  },
  Effect.fn(function* ({ workerUrl, worker, cached }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        if (worker || cached) {
          const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
          const baseUrl = workerUrl.replace(/\/$/, "");
          const previewUrl = new URL(`${baseUrl}/admin/preview/briefing`);
          previewUrl.searchParams.set("token", token);
          if (worker) previewUrl.searchParams.set("live", "1");
          const response = (yield* fetchJson(previewUrl.toString(), "GET", true)) as {
            readonly ok: boolean;
            readonly live: boolean;
            readonly briefing?: ManagerHealthPayload["briefing"] & Record<string, unknown>;
            readonly telegramText?: string;
            readonly error?: string;
          };
          if (options.json) {
            yield* printJson({ workerUrl: baseUrl, ...response });
            return;
          }
          if (!response.ok || response.telegramText == null) {
            yield* Console.log(response.error ?? "Worker briefing preview failed.");
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
            return;
          }
          yield* Console.log(
            response.live
              ? "Source: Worker live preview (not sent)"
              : "Source: Worker cached delivered briefing",
          );
          yield* Console.log("");
          yield* Console.log(response.telegramText);
          return;
        }

        const managerBriefing = yield* ManagerBriefing;
        const report = yield* managerBriefing.currentBriefing;

        if (options.json) {
          yield* printJson(report);
          return;
        }

        yield* Console.log(renderManagerBriefingForTelegram(report));
      }),
    );
  }),
).pipe(Command.withDescription("Render the current manager briefing locally or from the Worker"));

const nextDecision = Command.make(
  "next",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const managerBriefing = yield* ManagerBriefing;
        const report = yield* managerBriefing.currentBriefing;
        const applyPlan = buildYahooApplyPlan(report);
        const lineupSteps = applyPlan.steps.filter((step) => step.kind === "lineup");
        const transaction = applyPlan.transaction;
        const action =
          lineupSteps.length > 0
            ? `Fix lineup only: ${lineupSteps.length} internal move(s), then regenerate.`
            : transaction != null
              ? `${transaction.confidence === "act" ? "Make" : "Hold"} ${transaction.type}: add ${transaction.addPlayerName}${transaction.dropPlayerName == null ? "" : `, drop ${transaction.dropPlayerName}`}.`
              : report.addsRemaining <= 0
                ? "No transaction: weekly add limit is exhausted."
                : "No transaction clears the manager bar right now.";
        const confidence =
          lineupSteps.length > 0
            ? "HIGH"
            : transaction?.confidence === "act"
              ? "MEDIUM"
              : transaction != null
                ? "LOW/HOLD"
                : "HOLD";
        const evidence = [
          `summary: ${report.summary}`,
          `adds: ${report.addsRemaining} left, ${report.reservedAdds} reserved`,
          `projected IP: ${report.projectedWeeklyIp.toFixed(1)}`,
          `closest categories: ${report.closestCategories.join(", ") || "none"}`,
          ...report.managerTakeaways.slice(0, 4),
        ];
        const nextSteps =
          lineupSteps.length > 0
            ? [
                ...lineupSteps.map((step) => step.text),
                "Save roster changes.",
                "Run `vpr gm:next` again before considering any transaction.",
              ]
            : applyPlan.steps.length > 0
              ? applyPlan.steps.map((step) => step.text)
              : ["Do nothing right now; re-check after lineup/status/category context changes."];
        const blockers = [
          ...report.addTriggers.filter((line) => line.includes("paused")),
          ...(report.writeAlerts ?? []),
          ...report.warnings.slice(0, 2),
        ];
        const payload = {
          generatedAt: report.generatedAt,
          action,
          confidence,
          nextSteps,
          evidence,
          blockers,
        };

        if (options.json) {
          yield* printJson(payload);
          return;
        }

        yield* Console.log("Best current change to improve winning odds");
        yield* Console.log(`Confidence: ${confidence}`);
        yield* Console.log(`Action: ${action}`);
        yield* Console.log("");
        yield* Console.log("Do this");
        for (const [index, step] of nextSteps.entries()) {
          yield* Console.log(`${index + 1}. ${step}`);
        }
        yield* Console.log("");
        yield* Console.log("Evidence");
        for (const line of evidence) {
          yield* Console.log(`- ${line}`);
        }
        if (blockers.length > 0) {
          yield* Console.log("");
          yield* Console.log("Blocked / guardrails");
          for (const line of blockers) {
            yield* Console.log(`- ${line}`);
          }
        }
      }),
    );
  }),
).pipe(Command.withDescription("Show one read-only manager decision with confidence and evidence"));

const applyGuardrailLabel = (guardrail: string) => {
  switch (guardrail) {
    case "empty-slot-urgency":
      return "open active slot creates immediate lineup value";
    case "open-roster-capacity":
      return "open bench capacity avoids dropping long-term value";
    case "reserve-adds":
      return "weekly add budget is being protected";
    case "sixth-add-weekend":
      return "late-week move must directly affect the matchup";
    case "svh-program":
      return "reliever helps the SV+H category";
    case "streaming-skills":
      return "pitcher clears strikeout/role streaming skill checks";
    case "ratio-protection":
      return "ERA/WHIP risk is inside the matchup guardrail";
    case "ip-floor":
      return "projected innings are below the 20-IP floor";
    case "remaining-start":
      return "starter has a remaining expected start";
    case "two-start-planning":
      return "probable schedule shows multi-start volume";
    case "il-stash-stream":
      return "IL capacity can preserve injured long-term value";
    default:
      return guardrail;
  }
};

const formatApplyGuardrails = (guardrails: ReadonlyArray<string>) =>
  guardrails.length === 0 ? "none" : guardrails.map(applyGuardrailLabel).join("; ");

type LineupExecutionMoveView = {
  readonly playerName: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
};

const formatLineupExecutionActions = (moves: ReadonlyArray<LineupExecutionMoveView>) => {
  const usedMoveIndexes = new Set<number>();
  const actions: Array<string> = [];
  for (const [index, ilMove] of moves.entries()) {
    if (ilMove.to !== "IL") continue;
    const replacementIndex = moves.findIndex(
      (move, candidateIndex) =>
        candidateIndex !== index &&
        !usedMoveIndexes.has(candidateIndex) &&
        move.from === "BN" &&
        move.to === ilMove.from,
    );
    if (replacementIndex === -1) continue;
    const replacement = moves[replacementIndex]!;
    usedMoveIndexes.add(index);
    usedMoveIndexes.add(replacementIndex);
    actions.push(
      `Swap ${replacement.playerName} into ${replacement.to} and move ${ilMove.playerName} to IL.`,
    );
  }
  for (const [index, move] of moves.entries()) {
    if (usedMoveIndexes.has(index)) continue;
    if (move.from === "BN") {
      actions.push(`Move ${move.playerName} from BN to ${move.to}.`);
    } else {
      actions.push(`Move ${move.playerName} from ${move.from} to ${move.to}.`);
    }
  }
  return actions;
};

const printApplyPlan = (plan: YahooApplyPlan, teamKey: string | undefined) =>
  Effect.gen(function* () {
    yield* Console.log("Yahoo apply plan");
    yield* Console.log(`Mode: ${plan.mode}`);
    yield* Console.log(`Generated: ${plan.generatedAt}`);
    yield* Console.log(`Summary: ${plan.summary}`);
    yield* Console.log("");
    if (plan.transaction != null) {
      yield* Console.log("Selected transaction");
      yield* Console.log(`- type: ${plan.transaction.type}`);
      yield* Console.log(`- timing: ${plan.transaction.timing}`);
      yield* Console.log(
        `- add: ${plan.transaction.addPlayerName} (${plan.transaction.addPlayerKey})`,
      );
      if (plan.transaction.dropPlayerName != null) {
        yield* Console.log(
          `- drop: ${plan.transaction.dropPlayerName} (${plan.transaction.dropPlayerKey ?? "unknown key"})`,
        );
      }
      yield* Console.log(`- confidence: ${plan.transaction.confidence}`);
      yield* Console.log(`- score: ${plan.transaction.score.toFixed(2)}`);
      yield* Console.log(`- categories: ${plan.transaction.affectedCategories.join(", ")}`);
      yield* Console.log(`- guardrails: ${formatApplyGuardrails(plan.transaction.guardrails)}`);
      yield* Console.log("");
      yield* Console.log("Yahoo transaction XML preview");
      yield* Console.log("Preview only: this command does not send writes to Yahoo.");
      if (plan.yahooTransaction == null || teamKey == null) {
        yield* Console.log("- no safe Yahoo transaction payload can be built from this plan");
      } else {
        yield* Console.log(buildTransactionXml(teamKey, plan.yahooTransaction));
      }
      yield* Console.log("");
    }
    if (plan.steps.length === 0) {
      yield* Console.log("- no Yahoo action clears the current manager bar");
      return;
    }
    for (const [index, step] of plan.steps.entries()) {
      yield* Console.log(`${index + 1}. [${step.kind}] ${step.text}`);
    }
  });

const applyPlan = Command.make(
  "apply-plan",
  {
    workerUrl: workerUrlFlag,
    worker: workerFlag,
  },
  Effect.fn(function* ({ workerUrl, worker }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        if (worker) {
          const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
          const baseUrl = workerUrl.replace(/\/$/, "");
          const previewUrl = new URL(`${baseUrl}/admin/preview/apply-plan`);
          previewUrl.searchParams.set("token", token);
          const response = (yield* fetchJson(previewUrl.toString(), "GET", true)) as {
            readonly ok: boolean;
            readonly live: boolean;
            readonly applyPlan?: YahooApplyPlan;
            readonly error?: string;
          };
          if (options.json) {
            yield* printJson({ workerUrl: baseUrl, ...response });
            return;
          }
          if (!response.ok || response.applyPlan == null) {
            yield* Console.log(response.error ?? "Worker apply-plan preview failed.");
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
            return;
          }
          yield* printApplyPlan(response.applyPlan, undefined);
          return;
        }

        const managerBriefing = yield* ManagerBriefing;
        const briefingReport = yield* managerBriefing.currentBriefing;
        const plan = buildYahooApplyPlan(briefingReport);

        if (options.json) {
          yield* printJson(plan);
          return;
        }

        const yahoo = yield* YahooClient;
        const teamKey = `mlb.l.${yahoo.config.leagueId}.t.${yahoo.config.teamId}`;
        yield* printApplyPlan(plan, teamKey);
      }),
    );
  }),
).pipe(
  Command.withDescription("Show the ordered Yahoo actions from a local or Worker manager plan"),
);

const applyLineup = Command.make(
  "apply-lineup",
  {
    date: dateFlag,
    apply: applyFlag,
  },
  Effect.fn(function* ({ date, apply }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const executor = yield* YahooLineupExecutor;
        const result = yield* executor.applyForDate(date, { dryRun: !apply });

        if (options.json) {
          yield* printJson(result);
          return;
        }

        yield* Console.log(`Yahoo lineup executor ${date}`);
        yield* Console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
        yield* Console.log(`Applied: ${result.applied}`);
        yield* Console.log(`Verified: ${result.verified}`);
        yield* Console.log("");
        yield* Console.log("Manager actions");
        if (result.moves.length === 0) {
          yield* Console.log("- no safe internal lineup moves");
        } else {
          for (const [index, action] of formatLineupExecutionActions(result.moves).entries()) {
            yield* Console.log(`${index + 1}. ${action}`);
          }
        }
        yield* Console.log("");
        yield* Console.log("Yahoo position writes");
        if (result.moves.length === 0) {
          yield* Console.log("- none");
        } else {
          for (const [index, move] of result.moves.entries()) {
            yield* Console.log(
              `${index + 1}. ${move.playerName}: ${move.from} -> ${move.to} (${move.reason})`,
            );
          }
        }
        yield* Console.log("");
        yield* Console.log("Guardrails");
        for (const warning of result.warnings) {
          yield* Console.log(`- ${warning}`);
        }
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Dry-run or apply safe Yahoo lineup/IL position moves without adds/drops",
  ),
);

const yahooAuthUrl = Command.make(
  "yahoo-auth-url",
  {
    workerUrl: workerUrlFlag,
  },
  Effect.fn(function* ({ workerUrl }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const response = (yield* fetchJson(
          `${baseUrl}/admin/yahoo/auth-url?token=${encodeURIComponent(token)}`,
        )) as {
          readonly ok: boolean;
          readonly scope: string;
          readonly redirectUri: string;
          readonly authUrl: string;
        };

        if (options.json) {
          yield* printJson({ workerUrl: baseUrl, ...response });
          return;
        }

        yield* Console.log("Yahoo read/write authorization");
        yield* Console.log(`Worker: ${baseUrl}`);
        yield* Console.log(`Scope: ${response.scope}`);
        yield* Console.log(`Callback: ${response.redirectUri}`);
        yield* Console.log("");
        yield* Console.log(response.authUrl);
      }),
    );
  }),
).pipe(
  Command.withDescription("Print the Yahoo OAuth URL that upgrades the Worker to read/write scope"),
);

const status = Command.make(
  "status",
  {
    workerUrl: workerUrlFlag,
    maxBriefingAgeMinutes: maxBriefingAgeMinutesFlag,
    requireSentToday: requireSentTodayFlag,
    requireDelivery: requireDeliveryFlag,
    requireDeliveredToday: requireDeliveredTodayFlag,
    allowMissingTodayMessage: allowMissingTodayMessageFlag,
    allowUnauthorizedWrites: allowUnauthorizedWritesFlag,
  },
  Effect.fn(function* ({
    workerUrl,
    maxBriefingAgeMinutes,
    requireSentToday,
    requireDelivery,
    requireDeliveredToday,
    allowMissingTodayMessage,
    allowUnauthorizedWrites,
  }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const healthUrl = new URL(`${baseUrl}/admin/health/manager`);
        healthUrl.searchParams.set("token", token);
        healthUrl.searchParams.set("maxBriefingAgeMinutes", String(maxBriefingAgeMinutes));
        const enforceTodayMessage =
          !allowMissingTodayMessage || requireSentToday || requireDelivery || requireDeliveredToday;
        if (enforceTodayMessage || requireSentToday) {
          healthUrl.searchParams.set("requireSentToday", "1");
        }
        if (enforceTodayMessage || requireDelivery)
          healthUrl.searchParams.set("requireDelivery", "1");
        if (enforceTodayMessage || requireDeliveredToday) {
          healthUrl.searchParams.set("requireDeliveredToday", "1");
        }
        if (!allowUnauthorizedWrites) healthUrl.searchParams.set("requireYahooWrites", "1");
        const healthPayload = (yield* fetchJson(
          healthUrl.toString(),
          "GET",
          true,
        )) as ManagerHealthPayload;
        const { health, status: schedulerStatus, briefing, delivery, writeStatus } = healthPayload;
        const needsYahooAuth =
          writeStatus == null || writeStatus.capability !== "authorized" || !writeStatus.ok;
        const authUrlPayload = needsYahooAuth
          ? yield* fetchYahooAuthUrl(baseUrl, token).pipe(Effect.option)
          : undefined;

        if (options.json) {
          yield* printJson({
            workerUrl: baseUrl,
            ...healthPayload,
            yahooAuth:
              authUrlPayload?._tag === "Some"
                ? {
                    scope: authUrlPayload.value.scope,
                    redirectUri: authUrlPayload.value.redirectUri,
                    authUrl: authUrlPayload.value.authUrl,
                  }
                : undefined,
          });
          if (!health.ok) {
            yield* Effect.sync(() => {
              process.exitCode = 1;
            });
          }
          return;
        }

        yield* Console.log(`Worker status ${baseUrl}`);
        yield* Console.log(`Health: ${health.ok ? "ok" : "failing"}`);
        if (!health.ok) {
          for (const failure of health.failures) {
            yield* Console.log(`- ${failure}`);
          }
        }
        yield* Console.log(`Scheduler date: ${schedulerStatus.date}`);
        yield* Console.log("");
        yield* Console.log("Tasks");
        for (const task of schedulerStatus.tasks) {
          yield* Console.log(
            `- ${task.task}: ${task.completedAt ?? "never"} (${formatAge(
              task.completedAt,
            )}), runs today ${task.runCountToday}, ${
              task.canRunToday ? "can run again" : "daily limit reached"
            }`,
          );
        }
        yield* Console.log("");
        yield* Console.log("Cached briefing");
        yield* Console.log(`- generated: ${briefing?.generatedAt ?? "missing"}`);
        yield* Console.log(`- age: ${formatAge(briefing?.generatedAt)}`);
        yield* Console.log(`- summary: ${briefing?.summary ?? "missing"}`);
        yield* Console.log("");
        yield* Console.log("Delivery");
        yield* Console.log(
          `- delivered: ${delivery?.deliveredAt ?? "missing"} (${formatAge(delivery?.deliveredAt)})`,
        );
        yield* Console.log(`- succeeded: ${health.deliverySucceeded ?? false}`);
        for (const channel of delivery?.channels ?? []) {
          yield* Console.log(
            `- ${channel.channel}: ${channel.ok ? "ok" : `failed (${channel.error ?? "unknown"})`}`,
          );
        }
        yield* Console.log("");
        yield* Console.log("Yahoo writes");
        if (writeStatus == null) {
          yield* Console.log("- status: unknown; no apply-lineup write attempt recorded");
        } else {
          yield* Console.log(`- capability: ${writeStatus.capability}`);
          yield* Console.log(
            `- checked: ${writeStatus.checkedAt} (${formatAge(writeStatus.checkedAt)})`,
          );
          yield* Console.log(
            `- action: ${writeStatus.action}${writeStatus.date == null ? "" : ` for ${writeStatus.date}`}`,
          );
          if (writeStatus.error != null) yield* Console.log(`- error: ${writeStatus.error}`);
        }
        if (needsYahooAuth) {
          yield* Console.log("");
          yield* Console.log("Yahoo write auth fix");
          if (authUrlPayload?._tag === "Some") {
            yield* Console.log(`- scope: ${authUrlPayload.value.scope}`);
            yield* Console.log(`- callback: ${authUrlPayload.value.redirectUri}`);
            yield* Console.log(`- open: ${authUrlPayload.value.authUrl}`);
          } else {
            yield* Console.log("- run: vpr gm:yahoo-auth-url");
          }
        }
        yield* Console.log("");
        yield* Console.log("Manager read");
        for (const takeaway of briefing?.managerTakeaways.slice(0, 5) ?? []) {
          yield* Console.log(`- ${takeaway}`);
        }
        yield* Console.log("");
        yield* Console.log(`Lineup alerts: ${briefing?.lineupAlertCount ?? "unknown"}`);
        if (!health.ok) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(
  Command.withDescription("Check production Worker scheduler state and cached briefing freshness"),
);

const resendBriefing = Command.make(
  "resend-briefing",
  {
    workerUrl: workerUrlFlag,
  },
  Effect.fn(function* ({ workerUrl }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const response = (yield* fetchJson(
          `${baseUrl}/admin/run/resend-briefing?token=${encodeURIComponent(token)}`,
          "POST",
        )) as {
          readonly ok: boolean;
          readonly briefingGeneratedAt: string;
          readonly delivery: ManagerHealthPayload["delivery"];
        };

        if (options.json) {
          yield* printJson({ workerUrl: baseUrl, ...response });
          return;
        }

        yield* Console.log(`Resent cached briefing from ${response.briefingGeneratedAt}`);
        yield* Console.log(`Delivery: ${response.ok ? "ok" : "failed"}`);
        for (const channel of response.delivery?.channels ?? []) {
          yield* Console.log(
            `- ${channel.channel}: ${channel.ok ? "ok" : `failed (${channel.error ?? "unknown"})`}`,
          );
        }
        if (!response.ok) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(Command.withDescription("Resend the cached manager briefing without recomputing it"));

const sendBriefing = Command.make(
  "send-briefing",
  {
    workerUrl: workerUrlFlag,
  },
  Effect.fn(function* ({ workerUrl }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const sendUrl = new URL(`${baseUrl}/admin/run/task/send-briefing`);
        sendUrl.searchParams.set("token", token);
        sendUrl.searchParams.set("force", "1");
        const response = (yield* fetchJson(
          sendUrl.toString(),
          "POST",
          true,
        )) as RunSchedulerTaskResponse;

        if (options.json) {
          yield* printJson({ workerUrl: baseUrl, ...response });
          return;
        }

        yield* Console.log(`Fresh briefing send ${baseUrl}`);
        yield* Console.log("Mode: recompute, cache, and deliver");
        yield* Console.log("Yahoo writes: not attempted");
        yield* Console.log(`Task: ${response.task}`);
        yield* Console.log(`Forced: ${response.force}`);
        yield* Console.log(`Ran: ${response.ran}`);
        if (!response.ok || !response.ran) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Recompute, cache, and send a fresh manager briefing without Yahoo writes",
  ),
);

const recoverBriefing = Command.make(
  "recover-briefing",
  {
    workerUrl: workerUrlFlag,
    maxBriefingAgeMinutes: maxBriefingAgeMinutesFlag,
    forceRegenerate: forceRegenerateFlag,
  },
  Effect.fn(function* ({ workerUrl, maxBriefingAgeMinutes, forceRegenerate }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const recoverUrl = new URL(`${baseUrl}/admin/run/recover-briefing`);
        recoverUrl.searchParams.set("token", token);
        recoverUrl.searchParams.set("maxBriefingAgeMinutes", String(maxBriefingAgeMinutes));
        if (forceRegenerate) recoverUrl.searchParams.set("forceRegenerate", "1");
        const response = (yield* fetchJson(
          recoverUrl.toString(),
          "POST",
          true,
        )) as RecoverBriefingResponse;

        if (options.json) {
          yield* printJson({ workerUrl: baseUrl, ...response });
        } else if (response.action === "none") {
          yield* Console.log("Manager health is ok; no recovery needed.");
        } else if (response.action === "resend") {
          yield* Console.log("Recovered by resending cached briefing.");
          yield* Console.log(`Briefing: ${response.briefingGeneratedAt}`);
          yield* Console.log(`Delivery: ${response.ok ? "ok" : "failed"}`);
          for (const channel of response.delivery?.channels ?? []) {
            yield* Console.log(
              `- ${channel.channel}: ${channel.ok ? "ok" : `failed (${channel.error ?? "unknown"})`}`,
            );
          }
        } else if (response.action === "force-send-briefing") {
          yield* Console.log(
            `Recovered by forcing send-briefing: ${response.ran ? "ran" : "did not run"}`,
          );
        } else {
          yield* Console.log("Recovery needs a fresh briefing.");
          yield* Console.log("Pass --force-regenerate to recompute and send one.");
          for (const failure of response.health?.failures ??
            response.healthBefore?.failures ??
            []) {
            yield* Console.log(`- ${failure}`);
          }
        }
        if (!response.ok) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(
  Command.withDescription("Recover manager delivery by resending cache or optionally regenerating"),
);

const monitor = Command.make(
  "monitor",
  {
    workerUrl: workerUrlFlag,
    maxBriefingAgeMinutes: maxBriefingAgeMinutesFlag,
    forceRegenerate: forceRegenerateFlag,
    allowUnauthorizedWrites: allowUnauthorizedWritesFlag,
  },
  Effect.fn(function* ({
    workerUrl,
    maxBriefingAgeMinutes,
    forceRegenerate,
    allowUnauthorizedWrites,
  }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");
        const schedulerUrl = new URL(`${baseUrl}/admin/preview/scheduler`);
        schedulerUrl.searchParams.set("token", token);
        const schedulerPayload = (yield* fetchJson(
          schedulerUrl.toString(),
          "GET",
          true,
        )) as SchedulerStatusPayload;
        const cachedUrl = new URL(`${baseUrl}/admin/preview/briefing`);
        cachedUrl.searchParams.set("token", token);
        const cachedPreview = (yield* fetchJson(cachedUrl.toString(), "GET", true).pipe(
          Effect.catch((error: Error) =>
            Effect.succeed({
              ok: false,
              live: false,
              error: error.message,
            } satisfies BriefingPreviewResponse),
          ),
        )) as BriefingPreviewResponse;
        const freshPreview = (yield* Effect.gen(function* () {
          const managerBriefing = yield* ManagerBriefing;
          const briefing = yield* managerBriefing.currentBriefing;
          return {
            ok: true,
            live: true,
            briefing: {
              generatedAt: briefing.generatedAt,
              summary: briefing.summary,
            },
          } satisfies BriefingPreviewResponse;
        }).pipe(
          Effect.catch((error: Error) =>
            Effect.succeed({
              ok: false,
              live: true,
              error: error.message,
            } satisfies BriefingPreviewResponse),
          ),
        )) as BriefingPreviewResponse;
        const cachedGeneratedAt = cachedPreview.briefing?.generatedAt;
        const cachedAgeMs =
          cachedGeneratedAt == null
            ? Number.POSITIVE_INFINITY
            : Date.now() - Date.parse(cachedGeneratedAt);
        const cachedAgeMinutes = Math.floor(cachedAgeMs / (60 * 1000));
        const sendBriefingTask = schedulerPayload.status.tasks.find(
          (task) => task.task === "send-briefing",
        );
        const lightweightHealthOk =
          cachedPreview.ok &&
          cachedAgeMinutes <= maxBriefingAgeMinutes &&
          sendBriefingTask?.completedAt != null;

        if (options.json) {
          yield* printJson({
            workerUrl: baseUrl,
            forceRegenerateRequested: forceRegenerate,
            allowUnauthorizedWrites,
            health: {
              ok: lightweightHealthOk,
              cachedAgeMinutes: Number.isFinite(cachedAgeMinutes) ? cachedAgeMinutes : undefined,
            },
            scheduler: schedulerPayload.status,
            cachedPreview,
            freshPreview,
          });
        } else {
          yield* Console.log(`Manager monitor ${baseUrl}`);
          yield* Console.log("Recovery: skipped (lightweight monitor)");
          if (forceRegenerate) {
            yield* Console.log(
              "- force regeneration requested; use `vpr gm:send-briefing` to send a fresh message",
            );
          }
          yield* Console.log(`Health: ${lightweightHealthOk ? "ok" : "failing"}`);
          yield* Console.log(`Scheduler date: ${schedulerPayload.status.date}`);
          yield* Console.log(
            `Send task: ${sendBriefingTask?.completedAt ?? "missing"}; can run today: ${sendBriefingTask?.canRunToday ?? false}`,
          );
          yield* Console.log(
            `Briefing: ${cachedPreview.briefing?.generatedAt ?? "missing"} (${formatAge(
              cachedPreview.briefing?.generatedAt,
            )})`,
          );
          if (!cachedPreview.ok)
            yield* Console.log(
              `- cached briefing unavailable: ${cachedPreview.error ?? "unknown"}`,
            );
          yield* Console.log(`Summary: ${cachedPreview.briefing?.summary ?? "missing"}`);
          yield* Console.log("");
          yield* Console.log("Fresh preview");
          if (!freshPreview.ok || freshPreview.briefing == null) {
            yield* Console.log(`- unavailable: ${freshPreview.error ?? "unknown"}`);
          } else {
            const cachedSummary = cachedPreview.briefing?.summary;
            const freshSummary = freshPreview.briefing.summary;
            const differsFromCached = cachedSummary != null && cachedSummary !== freshSummary;
            yield* Console.log("- source: local");
            yield* Console.log(
              `- generated: ${freshPreview.briefing.generatedAt} (${formatAge(
                freshPreview.briefing.generatedAt,
              )})`,
            );
            yield* Console.log(`- summary: ${freshSummary}`);
            yield* Console.log(`- differs from cached: ${differsFromCached}`);
            if (differsFromCached) {
              yield* Console.log("");
              yield* Console.log("Action");
              yield* Console.log(
                "- cached Telegram is strategically stale; run `vpr gm:send-briefing` to recompute and send the fresh manager message",
              );
              yield* Console.log("- this refresh does not attempt Yahoo writes");
            }
          }
        }

        if (!lightweightHealthOk) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(
  Command.withDescription("Check today's manager delivery, recover if needed, then report health"),
);

const decision = Command.make(
  "decision",
  {
    workerUrl: workerUrlFlag,
    maxBriefingAgeMinutes: maxBriefingAgeMinutesFlag,
    forceRegenerate: forceRegenerateFlag,
  },
  Effect.fn(function* ({ workerUrl, maxBriefingAgeMinutes, forceRegenerate }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const token = yield* requireEnv("ADMIN_TRIGGER_TOKEN");
        const baseUrl = workerUrl.replace(/\/$/, "");

        const decisionUrl = new URL(`${baseUrl}/admin/decision`);
        decisionUrl.searchParams.set("token", token);
        decisionUrl.searchParams.set("maxBriefingAgeMinutes", String(maxBriefingAgeMinutes));
        if (forceRegenerate) decisionUrl.searchParams.set("forceRegenerate", "1");
        const response = (yield* fetchJson(decisionUrl.toString(), "POST", true)) as {
          readonly ok: boolean;
          readonly recovery: RecoverBriefingResponse;
          readonly health?: ManagerHealthPayload["health"];
          readonly writeStatus?: ManagerHealthPayload["writeStatus"];
          readonly telegramText?: string;
          readonly briefing?: Record<string, unknown>;
          readonly freshPreview?: {
            readonly generatedAt: string;
            readonly summary: string;
            readonly differsFromCached: boolean;
          };
          readonly applyPlan?: YahooApplyPlan;
          readonly error?: string;
        };

        if (options.json) {
          yield* printJson({
            workerUrl: baseUrl,
            ...response,
          });
        } else {
          yield* Console.log(`Manager decision ${baseUrl}`);
          yield* Console.log(`Recovery: ${response.recovery.action}`);
          yield* Console.log(`Health: ${response.health?.ok === true ? "ok" : "failing"}`);
          if (response.writeStatus == null) {
            yield* Console.log("Yahoo writes: unknown");
          } else {
            yield* Console.log(
              `Yahoo writes: ${response.writeStatus.capability}${
                response.writeStatus.ok ? "" : " (not ready)"
              }`,
            );
            if (response.writeStatus.error != null) {
              yield* Console.log(`Yahoo write error: ${response.writeStatus.error}`);
            }
          }
          if (!response.recovery.ok) {
            yield* Console.log(`Recovery error: ${response.recovery.error ?? "unknown"}`);
          }
          for (const failure of response.health?.failures ?? []) {
            yield* Console.log(`- ${failure}`);
          }
          const briefingGeneratedAt =
            typeof response.briefing?.["generatedAt"] === "string"
              ? response.briefing["generatedAt"]
              : undefined;
          yield* Console.log(
            `Briefing source: cached delivered decision${
              briefingGeneratedAt == null ? "" : ` from ${briefingGeneratedAt}`
            }${
              response.health?.briefingAgeMinutes == null
                ? ""
                : ` (${response.health.briefingAgeMinutes}m old)`
            }`,
          );
          if (response.freshPreview == null) {
            yield* Console.log("Fresh preview: vpr gm:briefing:worker");
          } else {
            yield* Console.log(
              `Fresh preview: ${response.freshPreview.generatedAt}; differs from cached: ${response.freshPreview.differsFromCached}`,
            );
            if (response.freshPreview.differsFromCached) {
              yield* Console.log(`Fresh summary: ${response.freshPreview.summary}`);
            }
          }
          yield* Console.log("");
          if (!response.ok || response.telegramText == null) {
            yield* Console.log(response.error ?? "Worker decision briefing failed.");
          } else {
            yield* Console.log(response.telegramText);
          }
          yield* Console.log("");
          if (!response.ok || response.applyPlan == null) {
            yield* Console.log(response.error ?? "Worker decision apply-plan failed.");
          } else {
            yield* printApplyPlan(response.applyPlan, undefined);
          }
        }

        if (!response.ok) {
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Show the Worker-source manager decision after checking delivery recovery",
  ),
);

const settings = Command.make(
  "settings",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getLeagueSettings;

        if (options.json) {
          yield* printJson(payload);
          return;
        }

        const settingsPayload = payload.fantasy_content.league[1].settings;
        const rosterSettings = settingsPayload.find((entry) => entry.roster_positions != null);
        const scoringSettings = settingsPayload.find((entry) => entry.stat_categories != null);
        yield* Console.log(`League ${yahoo.config.leagueId} settings`);
        yield* Console.log("");
        yield* Console.log("Roster slots");
        for (const slot of rosterSettings?.roster_positions ?? []) {
          yield* Console.log(`- ${slot.position}: ${slot.count}`);
        }
        yield* Console.log("");
        yield* Console.log("Scoring categories");
        for (const category of scoringSettings?.stat_categories?.stats ?? []) {
          if (category.stat.is_only_display_stat === "1") continue;
          yield* Console.log(`- ${category.stat.display_name}: ${category.stat.name}`);
        }
        yield* Console.log("");
        yield* Console.log(
          `Weekly adds: ${rosterSettings?.max_weekly_adds ?? scoringSettings?.max_weekly_adds ?? "unknown"}`,
        );
      }),
    );
  }),
).pipe(Command.withDescription("Show roster slots, scoring categories, and add limits"));

const freeAgents = Command.make(
  "free-agents",
  {
    count: countFlag,
  },
  Effect.fn(function* ({ count }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getAvailablePlayers(count);
        const players = payload.fantasy_content.league[1].players.map((entry) => {
          const [player] = entry.player;
          return {
            playerKey: player.playerKey,
            playerId: player.playerId,
            name: player.name,
            team: player.team,
            eligiblePositions: player.eligiblePositions,
            status: player.status,
          };
        });

        if (options.json) {
          yield* printJson(players);
          return;
        }

        yield* Console.log(`Free agents (${players.length})`);
        for (const player of players) {
          yield* Console.log(
            formatPlayerLine({
              ...player,
              selectedPosition: "FA",
            }),
          );
        }
      }),
    );
  }),
).pipe(Command.withDescription("List Yahoo free agents"));

const transactions = Command.make(
  "transactions",
  {
    count: countFlag,
  },
  Effect.fn(function* ({ count }) {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getLeagueTransactions(count);

        if (options.json) {
          yield* printJson(payload.transactions);
          return;
        }

        yield* Console.log(`Recent add/drop transactions (${payload.transactions.length})`);
        for (const transaction of payload.transactions) {
          const when = new Date(transaction.timestamp * 1000).toLocaleString("en-US", {
            timeZone: "America/New_York",
          });
          yield* Console.log(
            `${when} ${transaction.type} ${transaction.status} ${transaction.transactionKey}`,
          );
        }
      }),
    );
  }),
).pipe(Command.withDescription("List recent Yahoo add/drop transactions counted by the app"));

const rawRoster = Command.make(
  "raw-roster",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const yahoo = yield* YahooClient;
        const payload = yield* yahoo.getRoster;
        if (options.json) {
          yield* printJson(payload);
          return;
        }
        yield* printJson(rosterPlayersFromPayload(payload));
      }),
    );
  }),
).pipe(Command.withDescription("Dump the direct Yahoo roster parse used by YahooClient"));

const calibration = Command.make(
  "calibration",
  {},
  Effect.fn(function* () {
    yield* runWithEnv(
      Effect.gen(function* () {
        const options = yield* root;
        const leagueState = yield* LeagueState;
        const standingsHistory = yield* StandingsHistory;
        const snapshot = yield* leagueState.snapshot;
        const totals = yield* standingsHistory.categoryTotals;
        const denominators = computeSgpDenominators(totals);
        const denominatorByCategory: Readonly<Record<string, number>> = denominators;
        const usableCategories = snapshot.scoringCategories.filter((category) => {
          const count = totals.reduce(
            (sum, total) => sum + (total.categories[category] == null ? 0 : 1),
            0,
          );
          return count >= 2;
        });
        const source = usableCategories.length > 0 ? "standings-history" : "fallback";
        const payload = {
          leagueId: snapshot.leagueId,
          scoringFormat: snapshot.scoringFormat,
          scoringCategories: snapshot.scoringCategories,
          standingsTeamCount: totals.length,
          sgpDenominatorSource: source,
          usableSgpCategories: usableCategories,
          denominators,
          standingsTotals: totals,
        };

        if (options.json) {
          yield* printJson(payload);
          return;
        }

        yield* Console.log(`League ${snapshot.leagueId} calibration`);
        yield* Console.log(`Format: ${snapshot.scoringFormat}`);
        yield* Console.log(
          "Objective: maximize cumulative weekly category points in the regular season.",
        );
        yield* Console.log("");
        yield* Console.log(`Scoring categories (${snapshot.scoringCategories.length})`);
        yield* Console.log(`- ${snapshot.scoringCategories.join(", ")}`);
        yield* Console.log("");
        yield* Console.log(`Standings rows: ${totals.length}`);
        yield* Console.log(`SGP denominator source: ${source}`);
        if (source === "fallback") {
          yield* Console.log(
            "- Yahoo standings totals did not provide at least two numeric rows for any scoring category.",
          );
          yield* Console.log(
            "- The manager will rank season value with fallback league estimates.",
          );
        } else {
          yield* Console.log(`- Calibrated categories: ${usableCategories.join(", ")}`);
        }
        yield* Console.log("");
        yield* Console.log("SGP denominators");
        for (const category of snapshot.scoringCategories) {
          const rowCount = totals.reduce(
            (sum, total) => sum + (total.categories[category] == null ? 0 : 1),
            0,
          );
          const suffix = rowCount >= 2 ? `Yahoo rows ${rowCount}` : "fallback";
          yield* Console.log(
            `- ${category.padEnd(5)} ${String(denominatorByCategory[category] ?? "n/a").padEnd(8)} ${suffix}`,
          );
        }
      }),
    );
  }),
).pipe(Command.withDescription("Show league scoring categories and SGP calibration status"));

const OAuthLayer = YahooOAuth.layer(
  memoryYahooTokenStore(undefined as YahooStoredTokens | undefined),
).pipe(Layer.provide(FetchHttpClient.layer));
const YahooLayer = YahooClient.layer.pipe(
  Layer.provide(Layer.mergeAll(OAuthLayer, FetchHttpClient.layer)),
);
const DailyLineupAdvisorLayer = DailyLineupAdvisor.layerLive.pipe(Layer.provide(YahooLayer));
const YahooLineupExecutorLayer = YahooLineupExecutor.layerLive.pipe(
  Layer.provide(Layer.mergeAll(DailyLineupAdvisorLayer, YahooLayer)),
);
const LeagueStateLayer = LeagueState.layerLive.pipe(Layer.provide(YahooLayer));
const ProjectionDataLayer = ProjectionData.layerLive.pipe(Layer.provide(FetchHttpClient.layer));
const WeeklyProjectionLayer = WeeklyProjections.layerLive.pipe(
  Layer.provide(
    Layer.mergeAll(LeagueStateLayer, YahooLayer, ProjectionDataLayer, makePlayerIdentityTest()),
  ),
);
const StandingsHistoryLayer = StandingsHistory.layerLive.pipe(Layer.provide(YahooLayer));
const TransactionPlannerLayer = TransactionPlanner.layerLive.pipe(
  Layer.provide(Layer.mergeAll(WeeklyProjectionLayer, LeagueStateLayer, StandingsHistoryLayer)),
);
const ManagerBriefingLayer = ManagerBriefing.layerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      TransactionPlannerLayer,
      DailyLineupAdvisorLayer,
      makeApiCacheTest(),
      LeagueStateLayer,
      StandingsHistoryLayer,
      YahooLayer,
      ProjectionDataLayer,
      // Node path — enable the strategic block (worker path deliberately omits this).
      StrategicBriefInputs.layer,
    ),
  ),
);
const AppLayer = Layer.mergeAll(
  YahooLayer,
  DailyLineupAdvisorLayer,
  LeagueStateLayer,
  ProjectionDataLayer,
  WeeklyProjectionLayer,
  StandingsHistoryLayer,
  TransactionPlannerLayer,
  ManagerBriefingLayer,
  YahooLineupExecutorLayer,
);

root.pipe(
  Command.withSubcommands([
    team,
    roster,
    lineup,
    lineupCheck,
    pitcherStarts,
    matchup,
    briefing,
    nextDecision,
    applyPlan,
    applyLineup,
    yahooAuthUrl,
    status,
    monitor,
    decision,
    resendBriefing,
    sendBriefing,
    recoverBriefing,
    settings,
    freeAgents,
    transactions,
    rawRoster,
    calibration,
  ]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(AppLayer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
