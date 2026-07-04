import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as schema from "../../src/db/schema";
import { Db, type AppDatabase } from "../../src/services/Db";
import {
  D1_MAX_BOUND_PARAMS_SAFE,
  PlayerIdentity,
  PlayerIdentityRow,
} from "../../src/services/PlayerIdentity";
import {
  sqliteProxyBatchCallback,
  sqliteProxyCallback,
  type D1ProxyMethod,
} from "../../src/services/WorkerAdmin";

const endpoint = "https://worker.example/admin/d1/query?token=test";

afterEach(() => {
  vi.restoreAllMocks();
});

const identityRow = (index: number) =>
  new PlayerIdentityRow({
    yahooId: `mlb.p.${index}`,
    mlbId: 1000 + index,
    fangraphsId: 2000 + index,
    fangraphsKey: `fg-${index}`,
    name: `Player ${index}`,
    positions: index % 2 === 0 ? "OF" : "SP",
    team: index % 3 === 0 ? "NYY" : "SEA",
  });

const rawRow = (row: PlayerIdentityRow) => [
  row.yahooId,
  row.mlbId ?? null,
  row.fangraphsId ?? null,
  row.fangraphsKey ?? null,
  row.name,
  row.positions ?? null,
  row.team ?? null,
];

const optionalString = (value: unknown) =>
  value == null ? undefined : typeof value === "string" ? value : JSON.stringify(value);

const makeDbLayer = () =>
  Layer.succeed(
    Db,
    Db.of({
      d1: undefined as never,
      drizzle: Effect.succeed(
        drizzleSqliteProxy(sqliteProxyCallback(endpoint), sqliteProxyBatchCallback(endpoint), {
          schema,
        }) as unknown as AppDatabase,
      ),
    }),
  );

describe("PlayerIdentity D1 parameter chunking", () => {
  it("round-trips 250 ids without any statement exceeding the D1-safe param budget", () =>
    Effect.gen(function* () {
      const store = new Map<string, PlayerIdentityRow>();
      const paramCounts: Array<number> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const requestBody = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(requestBody) as {
          readonly sql?: string;
          readonly params?: ReadonlyArray<unknown>;
          readonly method?: D1ProxyMethod;
          readonly queries?: ReadonlyArray<{
            readonly sql: string;
            readonly params: ReadonlyArray<unknown>;
            readonly method: D1ProxyMethod;
          }>;
        };
        const queries = body.queries ?? [
          { sql: body.sql ?? "", params: body.params ?? [], method: body.method! },
        ];
        const results = queries.map((query) => {
          paramCounts.push(query.params.length);
          expect(query.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS_SAFE);

          if (query.sql.startsWith("insert into")) {
            for (let index = 0; index < query.params.length; index += 7) {
              const [yahooId, mlbId, fangraphsId, fangraphsKey, name, positions, team] =
                query.params.slice(index, index + 7);
              store.set(
                String(yahooId),
                new PlayerIdentityRow({
                  yahooId: String(yahooId),
                  mlbId: Number(mlbId),
                  fangraphsId: Number(fangraphsId),
                  fangraphsKey: String(fangraphsKey),
                  name: String(name),
                  positions: optionalString(positions),
                  team: optionalString(team),
                }),
              );
            }
            return { rows: [] };
          }

          if (query.sql.startsWith("select")) {
            return {
              rows: query.params
                .map((id) => store.get(String(id)))
                .filter((row): row is PlayerIdentityRow => row != null)
                .map(rawRow),
            };
          }

          return { rows: [] };
        });
        const payload = body.queries == null ? results[0] : { results };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      const service = yield* PlayerIdentity;
      const rows = Array.from({ length: 250 }, (_, index) => identityRow(index));
      yield* service.upsertMany(rows);

      const found = yield* service.findByYahooIds(rows.map((row) => row.yahooId));

      expect(found.size).toBe(250);
      expect(found.get("mlb.p.0")).toEqual(rows[0]);
      expect(found.get("mlb.p.249")).toEqual(rows[249]);
      expect(Math.max(...paramCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS_SAFE);
      expect(paramCounts.some((count) => count > 90)).toBe(false);
    }).pipe(
      Effect.provide(PlayerIdentity.layerLive),
      Effect.provide(makeDbLayer()),
      Effect.runPromise,
    ));
});
