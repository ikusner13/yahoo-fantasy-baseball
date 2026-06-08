import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DailyLineupAdvisor,
  DailyLineupAdvisorError,
  dailyLineupPlayersFromPayload,
  type DailyLineupReport,
} from "./DailyLineupAdvisor.ts";
import { YahooApiError, YahooClient, type YahooRosterPositionMove } from "./YahooClient.ts";

export class YahooLineupExecutionMove extends Schema.Class<YahooLineupExecutionMove>(
  "YahooLineupExecutionMove",
)({
  playerKey: Schema.String,
  playerName: Schema.String,
  from: Schema.String,
  to: Schema.String,
  reason: Schema.String,
}) {}

export class YahooLineupExecutionReport extends Schema.Class<YahooLineupExecutionReport>(
  "YahooLineupExecutionReport",
)({
  date: Schema.String,
  dryRun: Schema.Boolean,
  applied: Schema.Boolean,
  verified: Schema.Boolean,
  moves: Schema.Array(YahooLineupExecutionMove),
  warnings: Schema.Array(Schema.String),
}) {}

export class YahooLineupWriteAccessReport extends Schema.Class<YahooLineupWriteAccessReport>(
  "YahooLineupWriteAccessReport",
)({
  date: Schema.String,
  attempted: Schema.Boolean,
  verified: Schema.Boolean,
  playersWritten: Schema.Finite,
}) {}

export class YahooLineupExecutorError extends Data.TaggedError("YahooLineupExecutorError")<{
  readonly message: string;
}> {}

export interface YahooLineupExecutionOptions {
  readonly dryRun?: boolean;
}

const addMove = (
  moves: Array<YahooLineupExecutionMove>,
  usedPlayers: Set<string>,
  usedDestinations: Set<string>,
  move: YahooLineupExecutionMove,
) => {
  if (usedPlayers.has(move.playerKey)) return;
  if (move.to !== "IL" && move.to !== "BN" && usedDestinations.has(move.to)) return;
  usedPlayers.add(move.playerKey);
  if (move.to !== "IL" && move.to !== "BN") usedDestinations.add(move.to);
  moves.push(move);
};

export const buildYahooLineupExecutionMoves = (report: DailyLineupReport) => {
  const moves: Array<YahooLineupExecutionMove> = [];
  const usedPlayers = new Set<string>();
  const usedDestinations = new Set<string>();
  const ilMoveKeys = new Set(report.activeToIlMoves.map((move) => move.playerKey));

  for (const move of report.ilActivationMoves) {
    addMove(
      moves,
      usedPlayers,
      usedDestinations,
      new YahooLineupExecutionMove({
        playerKey: move.playerKey,
        playerName: move.playerName,
        from: move.from,
        to: move.to,
        reason: move.reason,
      }),
    );
  }

  for (const move of report.activeToIlMoves) {
    addMove(
      moves,
      usedPlayers,
      usedDestinations,
      new YahooLineupExecutionMove({
        playerKey: move.playerKey,
        playerName: move.playerName,
        from: move.from,
        to: move.to,
        reason: `${move.playerName} is active with status ${move.status}.`,
      }),
    );
  }

  for (const move of report.replacementOptions) {
    if (!ilMoveKeys.has(move.outPlayerKey)) continue;
    addMove(
      moves,
      usedPlayers,
      usedDestinations,
      new YahooLineupExecutionMove({
        playerKey: move.replacementPlayerKey,
        playerName: move.replacementPlayerName,
        from: move.currentPosition,
        to: move.slot,
        reason: `Replace ${move.outPlayerName} without dropping anyone.`,
      }),
    );
  }

  for (const move of report.fillableOpenSlots) {
    addMove(
      moves,
      usedPlayers,
      usedDestinations,
      new YahooLineupExecutionMove({
        playerKey: move.playerKey,
        playerName: move.playerName,
        from: move.currentPosition,
        to: move.slot,
        reason: `Fill open ${move.slot} slot without a transaction.`,
      }),
    );
  }

  return moves;
};

const toYahooMove = (move: YahooLineupExecutionMove): YahooRosterPositionMove => ({
  playerKey: move.playerKey,
  position: move.to,
});

const verifyMoves = (
  rosterPositions: ReadonlyMap<string, string>,
  moves: ReadonlyArray<YahooLineupExecutionMove>,
) => moves.every((move) => rosterPositions.get(move.playerKey) === move.to);

const mapError = (error: YahooApiError | DailyLineupAdvisorError) =>
  new YahooLineupExecutorError({ message: `${error._tag}: ${error.message}` });

export class YahooLineupExecutor extends Context.Service<
  YahooLineupExecutor,
  {
    readonly applyForDate: (
      date: string,
      options?: YahooLineupExecutionOptions,
    ) => Effect.Effect<YahooLineupExecutionReport, YahooLineupExecutorError>;
    readonly verifyWriteAccessForDate: (
      date: string,
    ) => Effect.Effect<YahooLineupWriteAccessReport, YahooLineupExecutorError>;
  }
>()("fantasy-gm/YahooLineupExecutor") {
  static readonly layerLive = Layer.effect(
    YahooLineupExecutor,
    Effect.gen(function* () {
      const advisor = yield* DailyLineupAdvisor;
      const yahoo = yield* YahooClient;

      const verifyWriteAccessForDate = (date: string) =>
        Effect.gen(function* () {
          const roster = yield* yahoo.getRosterForDate(date);
          const players = dailyLineupPlayersFromPayload(roster);
          const moves = players.map((player) => ({
            playerKey: player.playerKey,
            position: player.selectedPosition,
          }));
          yield* yahoo.putRosterPositions(date, moves);
          const verifiedRoster = yield* yahoo.getRosterForDate(date);
          const verifiedPositions = new Map(
            dailyLineupPlayersFromPayload(verifiedRoster).map((player) => [
              player.playerKey,
              player.selectedPosition,
            ]),
          );
          const verified = moves.every(
            (move) => verifiedPositions.get(move.playerKey) === move.position,
          );
          return new YahooLineupWriteAccessReport({
            date,
            attempted: true,
            verified,
            playersWritten: moves.length,
          });
        }).pipe(Effect.mapError(mapError));

      return YahooLineupExecutor.of({
        verifyWriteAccessForDate,
        applyForDate: (date, options = {}) =>
          Effect.gen(function* () {
            const dryRun = options.dryRun ?? true;
            const report = yield* advisor.forDate(date);
            const moves = buildYahooLineupExecutionMoves(report);
            const warnings = [
              "Only internal Yahoo roster-position moves are eligible here; no adds, drops, claims, or trades.",
              ...report.guardrails.slice(0, 3),
            ];

            if (moves.length === 0) {
              return new YahooLineupExecutionReport({
                date,
                dryRun,
                applied: false,
                verified: true,
                moves,
                warnings,
              });
            }

            if (dryRun) {
              return new YahooLineupExecutionReport({
                date,
                dryRun,
                applied: false,
                verified: false,
                moves,
                warnings,
              });
            }

            yield* yahoo.putRosterPositions(date, moves.map(toYahooMove));
            const roster = yield* yahoo.getRosterForDate(date);
            const positions = new Map(
              dailyLineupPlayersFromPayload(roster).map((player) => [
                player.playerKey,
                player.selectedPosition,
              ]),
            );

            return new YahooLineupExecutionReport({
              date,
              dryRun,
              applied: true,
              verified: verifyMoves(positions, moves),
              moves,
              warnings,
            });
          }).pipe(Effect.mapError(mapError)),
      });
    }),
  );
}
