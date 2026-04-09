import type { NewsAlert } from "../monitors/news";
import type { Player } from "../types";

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
