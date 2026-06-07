import { inArray } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { playerIds } from "../db/schema.ts";
import { Db } from "./Db.ts";

export class PlayerIdentityRow extends Schema.Class<PlayerIdentityRow>("PlayerIdentityRow")({
  yahooId: Schema.String,
  mlbId: Schema.optional(Schema.Finite),
  fangraphsId: Schema.optional(Schema.Finite),
  fangraphsKey: Schema.optional(Schema.String),
  name: Schema.String,
  positions: Schema.optional(Schema.String),
  team: Schema.optional(Schema.String),
}) {}

export class PlayerIdentityError extends Data.TaggedError("PlayerIdentityError")<{
  readonly message: string;
}> {}

const toOptional = <A>(value: A | null | undefined) => value ?? undefined;

const toRow = (row: typeof playerIds.$inferSelect) =>
  new PlayerIdentityRow({
    yahooId: row.yahooId,
    mlbId: toOptional(row.mlbId),
    fangraphsId: toOptional(row.fangraphsId),
    fangraphsKey: toOptional(row.fangraphsKey),
    name: row.name,
    positions: toOptional(row.positions),
    team: toOptional(row.team),
  });

export class PlayerIdentity extends Context.Service<
  PlayerIdentity,
  {
    readonly findByYahooIds: (
      yahooIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, PlayerIdentityRow>, PlayerIdentityError>;
    readonly upsertMany: (
      rows: ReadonlyArray<PlayerIdentityRow>,
    ) => Effect.Effect<void, PlayerIdentityError>;
  }
>()("fantasy-gm/PlayerIdentity") {
  static readonly layerLive = Layer.effect(
    PlayerIdentity,
    Effect.gen(function* () {
      const db = yield* Db;
      const database = yield* db.drizzle;

      const findByYahooIds = (yahooIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (yahooIds.length === 0) return new Map<string, PlayerIdentityRow>();
          const rows = yield* Effect.tryPromise({
            try: () =>
              database
                .select()
                .from(playerIds)
                .where(inArray(playerIds.yahooId, [...yahooIds])),
            catch: (error) => new PlayerIdentityError({ message: String(error) }),
          });
          return new Map(rows.map((row) => [row.yahooId, toRow(row)]));
        });

      const upsertMany = (rows: ReadonlyArray<PlayerIdentityRow>) =>
        Effect.gen(function* () {
          if (rows.length === 0) return;
          yield* Effect.tryPromise({
            try: async () => {
              for (const row of rows) {
                await database
                  .insert(playerIds)
                  .values({
                    yahooId: row.yahooId,
                    mlbId: row.mlbId ?? null,
                    fangraphsId: row.fangraphsId ?? null,
                    fangraphsKey: row.fangraphsKey ?? null,
                    name: row.name,
                    positions: row.positions ?? null,
                    team: row.team ?? null,
                  })
                  .onConflictDoUpdate({
                    target: playerIds.yahooId,
                    set: {
                      mlbId: row.mlbId ?? null,
                      fangraphsId: row.fangraphsId ?? null,
                      fangraphsKey: row.fangraphsKey ?? null,
                      name: row.name,
                      positions: row.positions ?? null,
                      team: row.team ?? null,
                    },
                  });
              }
            },
            catch: (error) => new PlayerIdentityError({ message: String(error) }),
          });
        });

      return PlayerIdentity.of({ findByYahooIds, upsertMany });
    }),
  );
}

export const makePlayerIdentityTest = (store = new Map<string, PlayerIdentityRow>()) =>
  Layer.succeed(
    PlayerIdentity,
    PlayerIdentity.of({
      findByYahooIds: (yahooIds) =>
        Effect.succeed(
          new Map(
            yahooIds
              .map((yahooId) => store.get(yahooId))
              .filter((row): row is PlayerIdentityRow => row != null)
              .map((row) => [row.yahooId, row]),
          ),
        ),
      upsertMany: (rows) =>
        Effect.sync(() => {
          for (const row of rows) {
            const existing = store.get(row.yahooId);
            store.set(
              row.yahooId,
              new PlayerIdentityRow({
                yahooId: row.yahooId,
                mlbId: row.mlbId ?? existing?.mlbId,
                fangraphsId: row.fangraphsId ?? existing?.fangraphsId,
                fangraphsKey: row.fangraphsKey ?? existing?.fangraphsKey,
                name: row.name,
                positions: row.positions ?? existing?.positions,
                team: row.team ?? existing?.team,
              }),
            );
          }
        }),
    }),
  );
