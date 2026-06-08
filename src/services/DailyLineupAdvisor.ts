import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { type YahooApiError, YahooClient, type YahooRosterPayload } from "./YahooClient.ts";

const RESERVE_SLOTS = new Set(["BN", "IL", "NA"]);
const HARD_UNAVAILABLE_STATUSES = new Set(["NA", "O"]);

export class DailyLineupPlayer extends Schema.Class<DailyLineupPlayer>("DailyLineupPlayer")({
  playerKey: Schema.String,
  playerId: Schema.String,
  name: Schema.String,
  team: Schema.String,
  eligiblePositions: Schema.Array(Schema.String),
  selectedPosition: Schema.String,
  status: Schema.optional(Schema.String),
}) {}

export class DailyLineupSlotCount extends Schema.Class<DailyLineupSlotCount>(
  "DailyLineupSlotCount",
)({
  position: Schema.String,
  count: Schema.Finite,
}) {}

export class DailyLineupIlMove extends Schema.Class<DailyLineupIlMove>("DailyLineupIlMove")({
  playerKey: Schema.String,
  playerName: Schema.String,
  from: Schema.String,
  to: Schema.Literal("IL"),
  status: Schema.String,
}) {}

export class DailyLineupIlActivationMove extends Schema.Class<DailyLineupIlActivationMove>(
  "DailyLineupIlActivationMove",
)({
  playerKey: Schema.String,
  playerName: Schema.String,
  from: Schema.Literal("IL"),
  to: Schema.String,
  status: Schema.optional(Schema.String),
  reason: Schema.String,
}) {}

export class DailyLineupReplacementMove extends Schema.Class<DailyLineupReplacementMove>(
  "DailyLineupReplacementMove",
)({
  outPlayerKey: Schema.String,
  outPlayerName: Schema.String,
  outPlayerStatus: Schema.optional(Schema.String),
  slot: Schema.String,
  replacementPlayerKey: Schema.String,
  replacementPlayerName: Schema.String,
  currentPosition: Schema.String,
}) {}

export class DailyLineupReport extends Schema.Class<DailyLineupReport>("DailyLineupReport")({
  date: Schema.String,
  posture: Schema.Literal("lineup-only; no drop recommendations"),
  emptySlots: Schema.Array(DailyLineupSlotCount),
  ilUsed: Schema.optional(Schema.Finite),
  ilSlots: Schema.optional(Schema.Finite),
  openIlSlots: Schema.optional(Schema.Finite),
  ilBatterUsed: Schema.optional(Schema.Finite),
  ilPitcherUsed: Schema.optional(Schema.Finite),
  activeUnavailable: Schema.Array(DailyLineupPlayer),
  activeStatusRisks: Schema.Array(DailyLineupPlayer),
  ilActivationMoves: Schema.Array(DailyLineupIlActivationMove),
  activeToIlMoves: Schema.Array(DailyLineupIlMove),
  blockedIlMoves: Schema.Finite,
  replacementOptions: Schema.Array(DailyLineupReplacementMove),
  fillableOpenSlots: Schema.Array(
    Schema.Struct({
      slot: Schema.String,
      playerName: Schema.String,
      playerKey: Schema.String,
      currentPosition: Schema.String,
    }),
  ),
  guardrails: Schema.Array(Schema.String),
}) {}

export class DailyLineupAdvisorError extends Data.TaggedError("DailyLineupAdvisorError")<{
  readonly message: string;
}> {}

const isActive = (player: DailyLineupPlayer) => !RESERVE_SLOTS.has(player.selectedPosition);

export const isHardUnavailableStatus = (status: string | undefined) =>
  status != null && (status.startsWith("IL") || HARD_UNAVAILABLE_STATUSES.has(status));

export const isSoftRiskStatus = (status: string | undefined) =>
  status != null && status !== "" && !isHardUnavailableStatus(status);

const isAvailableBenchPlayer = (player: DailyLineupPlayer) =>
  player.selectedPosition === "BN" && !isHardUnavailableStatus(player.status);

const isHealthyIlPlayer = (player: DailyLineupPlayer) =>
  player.selectedPosition === "IL" && !isHardUnavailableStatus(player.status);

const isPitcher = (player: DailyLineupPlayer) =>
  player.eligiblePositions.some((position) => ["SP", "RP", "P"].includes(position));

const isBatter = (player: DailyLineupPlayer) =>
  player.eligiblePositions.some((position) =>
    ["C", "1B", "2B", "3B", "SS", "OF", "Util"].includes(position),
  );

export const playerCanFillSlot = (player: DailyLineupPlayer, slot: string) => {
  if (slot === "Util") {
    return player.eligiblePositions.some((position) =>
      ["C", "1B", "2B", "3B", "SS", "OF", "Util"].includes(position),
    );
  }
  if (slot === "P") {
    return player.eligiblePositions.some((position) => ["SP", "RP", "P"].includes(position));
  }
  return player.eligiblePositions.includes(slot);
};

export const dailyLineupPlayersFromPayload = (payload: YahooRosterPayload) =>
  payload.fantasy_content.team[1].roster["0"].players.map((entry) => {
    const [player, selectedPosition] = entry.player;
    return new DailyLineupPlayer({
      playerKey: player.playerKey,
      playerId: player.playerId,
      name: player.name,
      team: player.team,
      eligiblePositions: [...player.eligiblePositions],
      selectedPosition: selectedPosition?.position ?? "BN",
      status: player.status,
    });
  });

export const buildDailyLineupReport = (
  date: string,
  players: ReadonlyArray<DailyLineupPlayer>,
  rosterSlots: ReadonlyArray<DailyLineupSlotCount>,
) => {
  const usedSlots = new Map<string, number>();
  for (const player of players) {
    usedSlots.set(player.selectedPosition, (usedSlots.get(player.selectedPosition) ?? 0) + 1);
  }
  const emptySlots = rosterSlots
    .map(
      (slot) =>
        new DailyLineupSlotCount({
          position: slot.position,
          count: Math.max(0, slot.count - (usedSlots.get(slot.position) ?? 0)),
        }),
    )
    .filter((slot) => slot.count > 0);

  const activeWithStatus = players.filter(
    (player) => isActive(player) && player.status != null && player.status !== "",
  );
  const activeUnavailable = activeWithStatus.filter((player) =>
    isHardUnavailableStatus(player.status),
  );
  const activeStatusRisks = activeWithStatus.filter((player) => isSoftRiskStatus(player.status));
  const bench = players.filter(isAvailableBenchPlayer);
  const openIlSlots = emptySlots.find((slot) => slot.position === "IL")?.count ?? 0;
  const ilSlots = rosterSlots.find((slot) => slot.position === "IL")?.count ?? 0;
  const ilUsed = usedSlots.get("IL") ?? 0;
  const ilPlayers = players.filter((player) => player.selectedPosition === "IL");
  const ilPitcherUsed = ilPlayers.filter(isPitcher).length;
  const ilBatterUsed = ilPlayers.filter((player) => isBatter(player) && !isPitcher(player)).length;
  const openBnSlots = emptySlots.find((slot) => slot.position === "BN")?.count ?? 0;
  const healthyIlPlayers = players.filter(isHealthyIlPlayer);
  const ilSlotsNeeded = Math.max(0, activeUnavailable.length - openIlSlots);
  const usedHealthyIlPlayerKeys = new Set<string>();
  const directIlActivationMoves = activeUnavailable.flatMap((activePlayer) => {
    if (usedHealthyIlPlayerKeys.size >= ilSlotsNeeded) return [];
    const replacement = healthyIlPlayers.find(
      (candidate) =>
        !usedHealthyIlPlayerKeys.has(candidate.playerKey) &&
        playerCanFillSlot(candidate, activePlayer.selectedPosition),
    );
    if (replacement == null) return [];
    usedHealthyIlPlayerKeys.add(replacement.playerKey);
    return [
      new DailyLineupIlActivationMove({
        playerKey: replacement.playerKey,
        playerName: replacement.name,
        from: "IL",
        to: activePlayer.selectedPosition,
        status: replacement.status,
        reason: `Free an IL slot and replace ${activePlayer.name} without dropping anyone.`,
      }),
    ];
  });
  const remainingIlSlotsNeeded = Math.max(0, ilSlotsNeeded - directIlActivationMoves.length);
  const benchIlActivationMoves = healthyIlPlayers
    .filter((player) => !usedHealthyIlPlayerKeys.has(player.playerKey))
    .slice(0, Math.min(openBnSlots, remainingIlSlotsNeeded))
    .map(
      (player) =>
        new DailyLineupIlActivationMove({
          playerKey: player.playerKey,
          playerName: player.name,
          from: "IL",
          to: "BN",
          status: player.status,
          reason: "Free an IL slot for an active unavailable player without dropping anyone.",
        }),
    );
  const ilActivationMoves = [...directIlActivationMoves, ...benchIlActivationMoves];
  const effectiveOpenIlSlots = openIlSlots + ilActivationMoves.length;
  const activeToIlMoves = activeUnavailable
    .filter((player) => player.eligiblePositions.includes("IL"))
    .slice(0, effectiveOpenIlSlots)
    .map(
      (player) =>
        new DailyLineupIlMove({
          playerKey: player.playerKey,
          playerName: player.name,
          from: player.selectedPosition,
          to: "IL",
          status: player.status ?? "",
        }),
    );

  const activeToIlKeys = new Set(activeToIlMoves.map((move) => move.playerKey));
  const replacementOptions = activeUnavailable.flatMap((activePlayer) =>
    !activeToIlKeys.has(activePlayer.playerKey)
      ? []
      : bench
          .filter((benchPlayer) => playerCanFillSlot(benchPlayer, activePlayer.selectedPosition))
          .map(
            (benchPlayer) =>
              new DailyLineupReplacementMove({
                outPlayerKey: activePlayer.playerKey,
                outPlayerName: activePlayer.name,
                outPlayerStatus: activePlayer.status,
                slot: activePlayer.selectedPosition,
                replacementPlayerKey: benchPlayer.playerKey,
                replacementPlayerName: benchPlayer.name,
                currentPosition: benchPlayer.selectedPosition,
              }),
          ),
  );

  const fillableOpenSlots = emptySlots.flatMap((slot) =>
    bench
      .filter((player) => playerCanFillSlot(player, slot.position))
      .map((player) => ({
        slot: slot.position,
        playerName: player.name,
        playerKey: player.playerKey,
        currentPosition: player.selectedPosition,
      })),
  );

  return new DailyLineupReport({
    date,
    posture: "lineup-only; no drop recommendations",
    emptySlots,
    ilUsed,
    ilSlots,
    openIlSlots,
    ilBatterUsed,
    ilPitcherUsed,
    activeUnavailable,
    activeStatusRisks,
    ilActivationMoves,
    activeToIlMoves,
    blockedIlMoves: Math.max(0, activeUnavailable.length - activeToIlMoves.length),
    replacementOptions,
    fillableOpenSlots,
    guardrails: [
      "Do not drop long-term-value players from this command.",
      "Hard-unavailable active players are IL/NA/O and should not stay active if a legal replacement exists.",
      "Healthy players parked in IL should be activated into open BN capacity before drops are considered.",
      `IL capacity is ${ilUsed}/${ilSlots}; IL occupancy is ${ilBatterUsed} batter(s), ${ilPitcherUsed} pitcher(s); only ${openIlSlots} direct active-to-IL move(s) can be recommended before freeing a slot.`,
      "Prefer bench-to-active slot moves before any add/drop analysis.",
      "Use add-only recommendations when roster capacity is open.",
    ],
  });
};

const mapError = (error: YahooApiError) =>
  new DailyLineupAdvisorError({ message: `${error._tag}: ${error.message}` });

export class DailyLineupAdvisor extends Context.Service<
  DailyLineupAdvisor,
  {
    readonly forDate: (date: string) => Effect.Effect<DailyLineupReport, DailyLineupAdvisorError>;
  }
>()("fantasy-gm/DailyLineupAdvisor") {
  static readonly layerLive = Layer.effect(
    DailyLineupAdvisor,
    Effect.gen(function* () {
      const yahoo = yield* YahooClient;
      return DailyLineupAdvisor.of({
        forDate: (date) =>
          Effect.gen(function* () {
            const [settings, roster] = yield* Effect.all([
              yahoo.getLeagueSettings,
              yahoo.getRosterForDate(date),
            ]);
            const settingEntries = settings.fantasy_content.league[1]?.settings ?? [];
            const rosterPositionSettings = settingEntries.find(
              (entry) => entry.roster_positions != null,
            );
            const rosterSlots =
              rosterPositionSettings?.roster_positions?.map(
                (slot) =>
                  new DailyLineupSlotCount({
                    position: slot.position,
                    count: slot.count,
                  }),
              ) ?? [];
            return buildDailyLineupReport(date, dailyLineupPlayersFromPayload(roster), rosterSlots);
          }).pipe(Effect.mapError(mapError)),
      });
    }),
  );
}
