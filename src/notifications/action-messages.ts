import type { Env, LineupMove, Roster, RosterEntry } from "../types";
import type { ILAction } from "../analysis/il-manager";

// Yahoo Fantasy Baseball base URL (/b1 = 2026 MLB season code)
const YAHOO_BASE = "https://baseball.fantasysports.yahoo.com/b1";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Yahoo deep links
// ---------------------------------------------------------------------------

export function yahooUrls(env: Env) {
  const L = env.YAHOO_LEAGUE_ID;
  const T = env.YAHOO_TEAM_ID;
  return {
    roster: (date?: string) =>
      date ? `${YAHOO_BASE}/${L}/${T}/team?date=${date}` : `${YAHOO_BASE}/${L}/${T}`,
    transactions: () => `${YAHOO_BASE}/${L}/${T}/transactions`,
    players: () => `${YAHOO_BASE}/${L}/players`,
    trade: () => `${YAHOO_BASE}/${L}/${T}/trade`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function playerName(roster: Roster, playerId: string): string {
  return roster.entries.find((e) => e.player.yahooId === playerId)?.player.name ?? playerId;
}

function currentPos(roster: Roster, playerId: string): string {
  return roster.entries.find((e) => e.player.yahooId === playerId)?.currentPosition ?? "?";
}

// ---------------------------------------------------------------------------
// Lineup notification
// ---------------------------------------------------------------------------

export function formatLineupNotification(
  env: Env,
  date: string,
  moves: LineupMove[],
  roster: Roster,
): string {
  const urls = yahooUrls(env);
  const lines: string[] = [`<b>Lineup Changes - ${date}</b>`, ""];

  const starters = moves.filter((m) => m.position !== "BN" && m.position !== "IL");
  const bench = moves.filter((m) => m.position === "BN");

  if (starters.length > 0) {
    for (const m of starters) {
      const name = esc(playerName(roster, m.playerId));
      const from = currentPos(roster, m.playerId);
      lines.push(`  ${name}: ${from} -> ${m.position}`);
    }
  }
  if (bench.length > 0) {
    lines.push("");
    lines.push("<b>Bench:</b>");
    for (const m of bench) {
      lines.push(`  ${esc(playerName(roster, m.playerId))} -> BN`);
    }
  }

  lines.push("");
  lines.push(`<a href="${urls.roster(date)}">Open roster on Yahoo</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IL moves notification
// ---------------------------------------------------------------------------

export function formatILNotification(
  env: Env,
  ilActions: ILAction[],
  ilMoves: LineupMove[],
): string {
  const urls = yahooUrls(env);
  const lines: string[] = [`<b>IL Moves Needed (${ilMoves.length})</b>`, ""];

  for (const a of ilActions) {
    lines.push(`  ${esc(a.reasoning)}`);
  }

  lines.push("");
  lines.push(`<a href="${urls.roster()}">Open roster on Yahoo</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Waiver / add-drop pickup notification
// ---------------------------------------------------------------------------

export interface PickupNotificationItem {
  addName: string;
  dropName: string;
  netValue: number;
  priority: string;
  reasoning: string;
  method: "waiver" | "add/drop";
}

export function formatPickupNotification(
  env: Env,
  pickups: PickupNotificationItem[],
  addsRemaining: number,
): string {
  const urls = yahooUrls(env);
  const lines: string[] = [
    `<b>Recommended Pickups (${pickups.length})</b>`,
    `${addsRemaining} adds remaining this week`,
    "",
  ];

  for (let i = 0; i < pickups.length; i++) {
    const p = pickups[i];
    lines.push(
      `${i + 1}. Add <b>${esc(p.addName)}</b>, drop <b>${esc(p.dropName)}</b> (+${p.netValue.toFixed(1)}) [${p.priority}]`,
    );
    lines.push(`   ${esc(p.reasoning)}`);
    lines.push(`   via ${p.method}`);
    lines.push("");
  }

  lines.push(`<a href="${urls.transactions()}">Open transactions on Yahoo</a>`);
  lines.push(`<a href="${urls.players()}">Browse free agents</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Streaming SP notification
// ---------------------------------------------------------------------------

export function formatStreamingNotification(
  env: Env,
  pitcherName: string,
  opponent: string,
  score: number,
  dropName: string,
  reasoning: string,
): string {
  const urls = yahooUrls(env);
  return [
    `<b>Streaming Pitcher</b>`,
    "",
    `Add <b>${esc(pitcherName)}</b> vs ${esc(opponent)} (score: ${score.toFixed(1)})`,
    `Drop <b>${esc(dropName)}</b>`,
    `${esc(reasoning)}`,
    "",
    `<a href="${urls.transactions()}">Open transactions on Yahoo</a>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Late scratch re-optimization notification
// ---------------------------------------------------------------------------

export function formatLateScratchNotification(
  env: Env,
  date: string,
  moves: LineupMove[],
  injured: RosterEntry[],
  roster: Roster,
): string {
  const urls = yahooUrls(env);
  const lines: string[] = [`<b>Late Scratch - Lineup Changes Needed</b>`, ""];

  lines.push("<b>Injured in active slots:</b>");
  for (const entry of injured) {
    lines.push(`  ${esc(entry.player.name)} (${entry.player.status}) in ${entry.currentPosition}`);
  }

  lines.push("");
  lines.push(`<b>Recommended moves (${moves.length}):</b>`);
  for (const m of moves) {
    const name = esc(playerName(roster, m.playerId));
    const from = currentPos(roster, m.playerId);
    lines.push(`  ${name}: ${from} -> ${m.position}`);
  }

  lines.push("");
  lines.push(`<a href="${urls.roster(date)}">Open roster on Yahoo</a>`);
  return lines.join("\n");
}
