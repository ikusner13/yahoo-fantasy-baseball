import type { PlayerValuation, Category } from "../types";
import { BATTING_CATEGORIES, PITCHING_CATEGORIES } from "../types";

// --- Interfaces ---

export interface TradeCandidate {
  targetTeamKey: string;
  targetTeamName: string;
  playersToSend: PlayerValuation[];
  playersToReceive: PlayerValuation[];
  netValueGain: number; // positive = good for us
  categoryImpact: Partial<Record<Category, number>>; // z-score change per cat
  reasoning: string;
}

// --- Constants ---

const ALL_CATEGORIES: Category[] = [
  ...(BATTING_CATEGORIES as unknown as Category[]),
  ...(PITCHING_CATEGORIES as unknown as Category[]),
];

/** Trade must gain us at least this much value to be worth proposing */
const MIN_NET_VALUE = 0.3;
/** Cap net value so we don't propose lopsided trades that get rejected */
const MAX_NET_VALUE = 2.0;
/** Max trade candidates to return */
const MAX_CANDIDATES = 5;

// --- Helpers ---

function sumCategoryZScores(valuations: PlayerValuation[]): Partial<Record<Category, number>> {
  const totals: Partial<Record<Category, number>> = {};
  for (const v of valuations) {
    for (const cat of ALL_CATEGORIES) {
      const z = v.categoryZScores[cat];
      if (z !== undefined) {
        totals[cat] = (totals[cat] ?? 0) + z;
      }
    }
  }
  return totals;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(pct * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// --- Core exports ---

/**
 * Identify categories where total team z-score is bottom 25th percentile.
 * Returned sorted worst-first.
 */
export function identifyCategoryNeeds(myValuations: PlayerValuation[]): Category[] {
  const totals = sumCategoryZScores(myValuations);
  const values = ALL_CATEGORIES.map((cat) => totals[cat] ?? 0);
  const threshold = percentile(values, 0.25);

  return ALL_CATEGORIES.filter((cat) => (totals[cat] ?? 0) <= threshold).sort(
    (a, b) => (totals[a] ?? 0) - (totals[b] ?? 0),
  );
}

/**
 * Identify surplus categories (top 25th percentile) and the players
 * contributing most to each. These are sell-high candidates.
 */
export function identifySurplus(
  myValuations: PlayerValuation[],
): { category: Category; players: PlayerValuation[] }[] {
  const totals = sumCategoryZScores(myValuations);
  const values = ALL_CATEGORIES.map((cat) => totals[cat] ?? 0);
  const threshold = percentile(values, 0.75);

  const surplusCategories = ALL_CATEGORIES.filter((cat) => (totals[cat] ?? 0) >= threshold);

  return surplusCategories
    .sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0))
    .map((cat) => {
      // Players sorted by their contribution to this category (desc)
      const players = myValuations
        .filter((v) => v.categoryZScores[cat] !== undefined && v.categoryZScores[cat]! > 0)
        .sort((a, b) => (b.categoryZScores[cat] ?? 0) - (a.categoryZScores[cat] ?? 0));
      return { category: cat, players };
    });
}

/**
 * Evaluate a trade: net z-score value and per-category impact.
 */
export function evaluateTrade(
  send: PlayerValuation[],
  receive: PlayerValuation[],
): {
  netValue: number;
  categoryImpact: Partial<Record<Category, number>>;
} {
  const sendTotals = sumCategoryZScores(send);
  const receiveTotals = sumCategoryZScores(receive);

  const sendTotal = send.reduce((s, p) => s + p.totalZScore, 0);
  const receiveTotal = receive.reduce((s, p) => s + p.totalZScore, 0);

  const categoryImpact: Partial<Record<Category, number>> = {};
  for (const cat of ALL_CATEGORIES) {
    const gained = receiveTotals[cat] ?? 0;
    const lost = sendTotals[cat] ?? 0;
    const diff = gained - lost;
    if (diff !== 0) {
      categoryImpact[cat] = diff;
    }
  }

  return { netValue: receiveTotal - sendTotal, categoryImpact };
}

/**
 * Generate human-readable reasoning for a trade candidate.
 */
export function generateTradeReasoning(candidate: TradeCandidate, needs: Category[]): string {
  const sendNames = candidate.playersToSend.map((p) => p.name).join(", ");
  const receiveNames = candidate.playersToReceive.map((p) => p.name).join(", ");

  // Find which surplus categories we're selling
  const sendCats: string[] = [];
  for (const p of candidate.playersToSend) {
    for (const [cat, z] of Object.entries(p.categoryZScores)) {
      if ((z ?? 0) > 0.5 && !sendCats.includes(cat)) {
        sendCats.push(cat);
      }
    }
  }

  // Find which need categories we're filling
  const needsSet = new Set<string>(needs);
  const filledNeeds: string[] = [];
  for (const [cat, impact] of Object.entries(candidate.categoryImpact)) {
    if (needsSet.has(cat) && (impact ?? 0) > 0) {
      filledNeeds.push(cat);
    }
  }

  const surplusStr = sendCats.length > 0 ? `surplus in ${sendCats.join("/")}` : "depth";
  const needStr =
    filledNeeds.length > 0 ? `fills ${filledNeeds.join("/")} need` : "improves roster";

  return `Send ${sendNames} (${surplusStr}) for ${receiveNames} (${needStr}). Net +${candidate.netValueGain.toFixed(2)} value.`;
}

/**
 * Find trade targets across other teams.
 *
 * Algorithm:
 * 1. For each opponent, identify their needs and surplus (mirror analysis)
 * 2. Match our surplus players against their needs, their surplus against ours
 * 3. Try 1-for-1 and 2-for-2 combos
 * 4. Filter to fair value range (0.3 - 2.0 net gain)
 * 5. Return top 5 sorted by net value
 */
export function findTradeTargets(
  myValuations: PlayerValuation[],
  otherTeams: Array<{
    teamKey: string;
    teamName: string;
    valuations: PlayerValuation[];
  }>,
  needs: Category[],
  surplus: Category[],
): TradeCandidate[] {
  const needsSet = new Set(needs);
  const candidates: TradeCandidate[] = [];

  for (const team of otherTeams) {
    const theirNeeds = new Set(identifyCategoryNeeds(team.valuations));
    const theirSurplusEntries = identifySurplus(team.valuations);

    // Their surplus players in categories WE need
    const theirTargets: PlayerValuation[] = [];
    for (const entry of theirSurplusEntries) {
      if (needsSet.has(entry.category)) {
        for (const p of entry.players) {
          if (!theirTargets.some((t) => t.yahooId === p.yahooId)) {
            theirTargets.push(p);
          }
        }
      }
    }

    // Our surplus players in categories THEY need
    const ourSellable: PlayerValuation[] = [];
    for (const v of myValuations) {
      for (const cat of surplus) {
        if (
          theirNeeds.has(cat) &&
          (v.categoryZScores[cat] ?? 0) > 0.5 &&
          !ourSellable.some((s) => s.yahooId === v.yahooId)
        ) {
          ourSellable.push(v);
        }
      }
    }

    if (theirTargets.length === 0 || ourSellable.length === 0) continue;

    // Try 1-for-1 trades
    for (const send of ourSellable) {
      for (const receive of theirTargets) {
        const result = evaluateTrade([send], [receive]);
        if (result.netValue >= MIN_NET_VALUE && result.netValue <= MAX_NET_VALUE) {
          candidates.push({
            targetTeamKey: team.teamKey,
            targetTeamName: team.teamName,
            playersToSend: [send],
            playersToReceive: [receive],
            netValueGain: result.netValue,
            categoryImpact: result.categoryImpact,
            reasoning: "", // filled below
          });
        }
      }
    }

    // Try 2-for-2 trades
    for (let i = 0; i < ourSellable.length; i++) {
      for (let j = i + 1; j < ourSellable.length; j++) {
        const sendPair = [ourSellable[i], ourSellable[j]];
        for (let k = 0; k < theirTargets.length; k++) {
          for (let l = k + 1; l < theirTargets.length; l++) {
            const receivePair = [theirTargets[k], theirTargets[l]];
            const result = evaluateTrade(sendPair, receivePair);
            if (result.netValue >= MIN_NET_VALUE && result.netValue <= MAX_NET_VALUE) {
              candidates.push({
                targetTeamKey: team.teamKey,
                targetTeamName: team.teamName,
                playersToSend: sendPair,
                playersToReceive: receivePair,
                netValueGain: result.netValue,
                categoryImpact: result.categoryImpact,
                reasoning: "",
              });
            }
          }
        }
      }
    }
  }

  // Sort by net value gain (best first), take top N
  candidates.sort((a, b) => b.netValueGain - a.netValueGain);
  const top = candidates.slice(0, MAX_CANDIDATES);

  // Generate reasoning for finalists
  for (const c of top) {
    c.reasoning = generateTradeReasoning(c, needs);
  }

  return top;
}
