import type { NewsAlert } from "../monitors/news";
import type { Player } from "../types";
import type { PickupRecommendation } from "../analysis/waivers";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

export function normalizePlayerName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ").filter(Boolean).filter((part) => !SUFFIXES.has(part));
  return parts.join(" ");
}

export function matchAlertToFreeAgent(
  alert: Pick<NewsAlert, "playerName" | "team">,
  freeAgents: Player[],
): Player | null {
  const normalizedAlert = normalizePlayerName(alert.playerName);
  if (!normalizedAlert) return null;

  const sameName = freeAgents.filter(
    (player) => normalizePlayerName(player.name) === normalizedAlert,
  );
  if (sameName.length === 0) return null;

  if (alert.team) {
    const sameTeam = sameName.find((player) => player.team === alert.team);
    if (sameTeam) return sameTeam;
  }

  return sameName[0] ?? null;
}

export type WatchlistTier = "must_add_now" | "strong_watch" | "monitor";

export interface WatchlistRecommendation {
  alert: NewsAlert;
  player: Player;
  tier: WatchlistTier;
  pickup?: PickupRecommendation;
  summary: string;
}

function classifyTier(
  alert: NewsAlert,
  pickup: PickupRecommendation | undefined,
): WatchlistTier {
  if (pickup) {
    const winDelta = pickup.winProbabilityDelta ?? 0;
    const catDelta = pickup.expectedCategoryWinsDelta ?? 0;
    if (
      winDelta >= 0.01 ||
      catDelta >= 0.2 ||
      (alert.type === "closer_change" && (winDelta >= 0.005 || catDelta >= 0.12))
    ) {
      return "must_add_now";
    }
    return "strong_watch";
  }

  return alert.type === "closer_change" ? "strong_watch" : "monitor";
}

function buildSummary(
  player: Player,
  tier: WatchlistTier,
  pickup: PickupRecommendation | undefined,
): string {
  if (pickup) {
    const delta =
      pickup.winProbabilityDelta != null
        ? `${pickup.winProbabilityDelta >= 0 ? "+" : ""}${(pickup.winProbabilityDelta * 100).toFixed(1)}pp win odds`
        : `${(pickup.expectedCategoryWinsDelta ?? 0) >= 0 ? "+" : ""}${(pickup.expectedCategoryWinsDelta ?? 0).toFixed(2)} cats`;
    const prefix =
      tier === "must_add_now"
        ? `Must add ${player.name} now`
        : `Watch ${player.name} closely`;
    return `${prefix}: drop ${pickup.drop.name}. ${delta}.`;
  }

  return tier === "strong_watch"
    ? `${player.name} is worth tracking closely if the role sticks.`
    : `${player.name} is on the watchlist.`;
}

export function buildWatchlistRecommendations(
  alerts: NewsAlert[],
  freeAgents: Player[],
  pickupRecommendations: PickupRecommendation[],
): WatchlistRecommendation[] {
  const recMap = new Map(pickupRecommendations.map((pickup) => [pickup.add.yahooId, pickup]));
  const results: WatchlistRecommendation[] = [];

  for (const alert of alerts) {
    const player = matchAlertToFreeAgent(alert, freeAgents);
    if (!player) continue;

    const pickup = recMap.get(player.yahooId);
    const tier = classifyTier(alert, pickup);
    results.push({
      alert,
      player,
      tier,
      pickup,
      summary: buildSummary(player, tier, pickup),
    });
  }

  const priority: Record<WatchlistTier, number> = {
    must_add_now: 0,
    strong_watch: 1,
    monitor: 2,
  };

  return results.sort((a, b) => priority[a.tier] - priority[b.tier]);
}
