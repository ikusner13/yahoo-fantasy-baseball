import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { getBatterStatcast, getPitcherStatcast } from "../../src/data/statcast";

// Sample CSV data matching Statcast leaderboard format
const BATTER_CSV = `player_id,player_name,xwoba,barrel_batted_rate,hard_hit_percent,avg_hit_speed,sprint_speed
660271,"Ohtani, Shohei",0.410,18.5,52.3,93.1,27.5
545361,"Trout, Mike",0.385,16.2,48.7,92.0,28.0
665742,"Judge, Aaron",0.420,20.1,54.0,95.2,
111111,"Nobody, Some",0.300,8.0,35.0,88.0,25.0`;

const BATTER_CSV_WITH_BOM = `\uFEFF${BATTER_CSV}`;

const PITCHER_CSV = `player_id,player_name,xwoba,barrel_batted_rate,whiff_percent,k_percent
477132,"Cole, Gerrit",0.270,5.2,32.1,29.5
669203,"Skubal, Tarik",0.255,4.8,34.5,31.2`;

// Mock fetch globally
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe("getBatterStatcast", () => {
  it("parses CSV and filters to requested IDs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => BATTER_CSV,
    });

    const result = await getBatterStatcast([660271, 545361]);
    expect(result).toHaveLength(2);

    const ohtani = result.find((r) => r.mlbId === 660271)!;
    expect(ohtani).toBeDefined();
    expect(ohtani.xwoba).toBeCloseTo(0.41);
    expect(ohtani.barrelPct).toBeCloseTo(18.5);
    expect(ohtani.hardHitPct).toBeCloseTo(52.3);
    expect(ohtani.exitVelo).toBeCloseTo(93.1);
    expect(ohtani.sprintSpeed).toBeCloseTo(27.5);

    const trout = result.find((r) => r.mlbId === 545361)!;
    expect(trout).toBeDefined();
    expect(trout.xwoba).toBeCloseTo(0.385);
  });

  it("excludes IDs not in the request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => BATTER_CSV,
    });

    const result = await getBatterStatcast([660271]);
    expect(result).toHaveLength(1);
    expect(result[0].mlbId).toBe(660271);
  });

  it("handles BOM in CSV", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => BATTER_CSV_WITH_BOM,
    });

    const result = await getBatterStatcast([660271, 545361]);
    expect(result).toHaveLength(2);
    // BOM should not corrupt the first column
    expect(result.find((r) => r.mlbId === 660271)).toBeDefined();
  });

  it("handles missing sprint_speed as undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => BATTER_CSV,
    });

    const result = await getBatterStatcast([665742]);
    const judge = result[0];
    expect(judge.sprintSpeed).toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect(getBatterStatcast([660271])).rejects.toThrow("Savant batter fetch failed");
  });

  it("returns empty array when no matching IDs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => BATTER_CSV,
    });

    const result = await getBatterStatcast([999999]);
    expect(result).toHaveLength(0);
  });
});

describe("getPitcherStatcast", () => {
  it("parses pitcher CSV correctly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => PITCHER_CSV,
    });

    const result = await getPitcherStatcast([477132, 669203]);
    expect(result).toHaveLength(2);

    const cole = result.find((r) => r.mlbId === 477132)!;
    expect(cole.xwoba).toBeCloseTo(0.27);
    expect(cole.whiffPct).toBeCloseTo(32.1);
    expect(cole.barrelPctAgainst).toBeCloseTo(5.2);
    expect(cole.kPct).toBeCloseTo(29.5);
  });

  it("filters to requested pitcher IDs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => PITCHER_CSV,
    });

    const result = await getPitcherStatcast([669203]);
    expect(result).toHaveLength(1);
    expect(result[0].mlbId).toBe(669203);
  });
});
