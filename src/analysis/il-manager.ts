import type { Roster, RosterEntry, Player } from "../types";
import { ROSTER_SLOTS } from "../types";

export interface ILAction {
  type: "move_to_il" | "activate_from_il" | "drop_for_il";
  player: Player;
  dropPlayer?: Player; // only for drop_for_il
  reasoning: string;
}

/**
 * Identify all IL-related moves the roster needs:
 * 1. Injured active players → move to IL
 * 2. Healthy IL players → activate to BN
 * 3. If IL full + injured active player → drop least valuable bench player
 */
export function getILMoves(roster: Roster): ILAction[] {
  const actions: ILAction[] = [];
  const { available } = countILSlots(roster);

  // Healthy players sitting on IL → activate to bench
  const healthyOnIL = roster.entries.filter(
    (e) => e.currentPosition === "IL" && e.player.status === "healthy",
  );
  for (const entry of healthyOnIL) {
    actions.push({
      type: "activate_from_il",
      player: entry.player,
      reasoning: `${entry.player.name} is healthy but occupying IL slot — activate to BN`,
    });
  }

  // After activations, recalc available IL slots
  const projectedAvailable = available + healthyOnIL.length;

  // Injured players in active (non-BN, non-IL) slots → move to IL
  const injuredActive = getInjuredActivePlayers(roster);
  // Only consider IL-eligible (status === "IL") for actual IL moves
  const ilEligible = injuredActive.filter((e) => e.player.status === "IL");
  const daysToDay = injuredActive.filter(
    (e) => e.player.status === "DTD" || e.player.status === "OUT",
  );

  let slotsRemaining = projectedAvailable;

  for (const entry of ilEligible) {
    if (slotsRemaining > 0) {
      actions.push({
        type: "move_to_il",
        player: entry.player,
        reasoning: `${entry.player.name} (${entry.player.status}) in active slot ${entry.currentPosition} — move to IL`,
      });
      slotsRemaining--;
    } else {
      // IL full — find least valuable bench player to drop
      const dropCandidate = findLeastValuableBenchPlayer(roster);
      if (dropCandidate) {
        actions.push({
          type: "drop_for_il",
          player: entry.player,
          dropPlayer: dropCandidate.player,
          reasoning: `IL full, dropping ${dropCandidate.player.name} (${dropCandidate.player.ownership ?? "?"}% owned) to IL ${entry.player.name}`,
        });
      } else {
        actions.push({
          type: "drop_for_il",
          player: entry.player,
          reasoning: `IL full, need to IL ${entry.player.name} but no droppable bench player found`,
        });
      }
    }
  }

  // DTD/OUT players: just flag them, don't auto-IL (they may not be IL-eligible in Yahoo)
  for (const _entry of daysToDay) {
    // Only surface as info in reasoning — no action unless status is "IL"
    // Could extend later with a "bench_injured" action type
  }

  return actions;
}

/** Count how many IL slots are used vs available. */
export function countILSlots(roster: Roster): { used: number; available: number } {
  const maxIL = ROSTER_SLOTS["IL"] ?? 4;
  const used = roster.entries.filter((e) => e.currentPosition === "IL").length;
  return { used, available: maxIL - used };
}

/** Players in active (non-IL, non-BN) slots with injury status. */
export function getInjuredActivePlayers(roster: Roster): RosterEntry[] {
  return roster.entries.filter((e) => {
    if (e.currentPosition === "IL" || e.currentPosition === "BN") return false;
    return e.player.status === "IL" || e.player.status === "DTD" || e.player.status === "OUT";
  });
}

/**
 * Find the least valuable bench player as a drop candidate.
 * Uses ownership% as a proxy for value — lowest ownership = most droppable.
 */
function findLeastValuableBenchPlayer(roster: Roster): RosterEntry | undefined {
  const benchPlayers = roster.entries.filter(
    (e) => e.currentPosition === "BN" && e.player.status !== "IL",
  );
  if (benchPlayers.length === 0) return undefined;

  return benchPlayers.reduce((worst, entry) => {
    const worstOwn = worst.player.ownership ?? 100;
    const entryOwn = entry.player.ownership ?? 100;
    return entryOwn < worstOwn ? entry : worst;
  });
}
