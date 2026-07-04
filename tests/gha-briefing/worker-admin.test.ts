import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
    ["all", [{ id: 1 }], [{ id: 1 }]],
    ["values", [[1, "a"]], [[1, "a"]]],
  ] satisfies ReadonlyArray<[D1ProxyMethod, ReadonlyArray<unknown>, unknown]>)(
    "maps %s requests and rows",
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

  it("unwraps get rows for drizzle's sqlite-proxy get mapper", async () => {
    mockFetchJson({ rows: [{ id: 1, name: "A" }] });

    const result = await sqliteProxyCallback(endpoint)("select 1", [], "get");

    expect(result.rows).toEqual({ id: 1, name: "A" });
  });

  it("maps batch requests and unwraps get responses by query method", async () => {
    const fetch = mockFetchJson({
      results: [{ rows: [{ id: 1 }] }, { rows: [[2]] }],
    });
    const queries = [
      { sql: "select 1", params: [], method: "get" as const },
      { sql: "select 2", params: [], method: "values" as const },
    ];

    const result = await sqliteProxyBatchCallback(endpoint)(queries);

    expect(result).toEqual([{ rows: { id: 1 } }, { rows: [[2]] }]);
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
});
