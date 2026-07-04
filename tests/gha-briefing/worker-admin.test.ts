import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { apiCache } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  sqliteProxyBatchCallback,
  sqliteProxyCallback,
  type D1ProxyMethod,
} from "../../src/services/WorkerAdmin";

const endpoint = "https://worker.example/admin/d1/query?token=test";

const mockFetchJson = (payload: unknown, status = 200) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      statusText: status === 200 ? "OK" : "Bad Request",
      headers: { "content-type": "application/json" },
    }),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sqlite-proxy worker admin adapter", () => {
  it.each([
    ["run", [], []],
    ["all", [[1, "a"]], [[1, "a"]]],
    ["values", [[1, "a"]], [[1, "a"]]],
  ] satisfies ReadonlyArray<[D1ProxyMethod, ReadonlyArray<unknown>, unknown]>)(
    "maps %s requests and raw rows",
    async (method, rows, expectedRows) => {
      const fetch = mockFetchJson({ rows });
      const result = await sqliteProxyCallback(endpoint)("select 1", ["x"], method);

      expect(result.rows).toEqual(expectedRows);
      expect(fetch).toHaveBeenCalledWith(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "select 1", params: ["x"], method }),
      });
    },
  );

  it("passes a get response through as one raw row for drizzle's get mapper", async () => {
    mockFetchJson({ rows: [1, "A"] });

    const result = await sqliteProxyCallback(endpoint)("select 1", [], "get");

    expect(result.rows).toEqual([1, "A"]);
  });

  it("maps batch requests and unwraps get responses by query method", async () => {
    const fetch = mockFetchJson({
      results: [{ rows: [1, "A"] }, { rows: [[2]] }],
    });
    const queries = [
      { sql: "select 1", params: [], method: "get" as const },
      { sql: "select 2", params: [], method: "values" as const },
    ];

    const result = await sqliteProxyBatchCallback(endpoint)(queries);

    expect(result).toEqual([{ rows: [1, "A"] }, { rows: [[2]] }]);
    expect(fetch).toHaveBeenCalledWith(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries }),
    });
  });

  it("propagates non-2xx worker errors", async () => {
    mockFetchJson({ error: "bad sql" }, 400);

    await expect(sqliteProxyCallback(endpoint)("select bad", [], "all")).rejects.toThrow(
      "400 Bad Request",
    );
  });

  it("round-trips real column values through drizzle sqlite-proxy", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const requestBody = typeof init?.body === "string" ? init.body : "";
      const body = JSON.parse(requestBody) as {
        readonly sql: string;
        readonly params: ReadonlyArray<unknown>;
        readonly method: D1ProxyMethod;
      };
      expect(body.method).toBe("all");
      expect(body.sql).toContain("api_cache");
      return new Response(
        JSON.stringify({
          rows: [["cache-key", '{"ok":true}', "2026-07-04T12:00:00.000Z"]],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const db = drizzleSqliteProxy(
      sqliteProxyCallback(endpoint),
      sqliteProxyBatchCallback(endpoint),
      { schema },
    );

    const rows = await db.select().from(apiCache).limit(1);

    expect(rows).toEqual([
      {
        cacheKey: "cache-key",
        data: '{"ok":true}',
        updatedAt: "2026-07-04T12:00:00.000Z",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
