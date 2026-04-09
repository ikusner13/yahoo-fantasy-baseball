import type { Env, LineupMove, Roster, RosterEntry } from "../types";
import type { ILAction } from "../analysis/il-manager";
import type { PitcherPickupAnalysis } from "../analysis/pitcher-pickups";

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
  freshLineup = false,
  benchReasons?: Map<string, string>,
): string {
  const urls = yahooUrls(env);
  const starters = moves.filter((m) => m.position !== "BN" && m.position !== "IL");
  const bench = moves.filter((m) => m.position === "BN");
  const lines: string[] = [];

  const benchLine = (m: LineupMove): string => {
    const name = esc(playerName(roster, m.playerId));
    const reason = benchReasons?.get(m.playerId);
    return reason ? `  ${name} — ${reason}` : `  ${name}`;
  };

  if (freshLineup) {
    // Fresh lineup day: lead with bench (actionable), collapse starters
    lines.push(`<b>Lineup — ${date}</b>`);

    if (bench.length > 0) {
      lines.push("");
      lines.push("<b>Bench today:</b>");
      for (const m of bench) lines.push(benchLine(m));
    }

    lines.push("");
    lines.push(`Start everyone else (${starters.length} players).`);
  } else {
    // Mid-day changes: show specific moves
    lines.push(`<b>Lineup Changes — ${date}</b>`);

    // Only show starters whose position actually changed
    const changed = starters.filter((m) => currentPos(roster, m.playerId) !== m.position);
    if (changed.length > 0) {
      lines.push("");
      for (const m of changed) {
        const name = esc(playerName(roster, m.playerId));
        const from = currentPos(roster, m.playerId);
        lines.push(`  ${name}: ${from} → ${m.position}`);
      }
    }

    if (bench.length > 0) {
      // Only show players newly benched (were in an active slot)
      const newlyBenched = bench.filter((m) => currentPos(roster, m.playerId) !== "BN");
      if (newlyBenched.length > 0) {
        lines.push("");
        lines.push("<b>Bench:</b>");
        for (const m of newlyBenched) lines.push(benchLine(m));
      }
    }

    if (
      changed.length === 0 &&
      bench.filter((m) => currentPos(roster, m.playerId) !== "BN").length === 0
    ) {
      lines.push("", "No changes needed.");
    }
  }

  lines.push("");
  lines.push(`<a href="${urls.roster(date)}">Set lineup on Yahoo</a>`);
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
  winProbabilityDelta?: number;
  expectedCategoryWinsDelta?: number;
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
    const headline =
      p.winProbabilityDelta != null
        ? `${p.winProbabilityDelta >= 0 ? "+" : ""}${(p.winProbabilityDelta * 100).toFixed(1)}pp win odds`
        : `+${p.netValue.toFixed(1)} value`;
    const catDelta =
      p.expectedCategoryWinsDelta != null
        ? ` | ${p.expectedCategoryWinsDelta >= 0 ? "+" : ""}${p.expectedCategoryWinsDelta.toFixed(2)} cats`
        : "";
    lines.push(
      `${i + 1}. Add <b>${esc(p.addName)}</b>, drop <b>${esc(p.dropName)}</b> (${headline}${catDelta}) [${p.priority}]`,
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
// Streaming SP notification (legacy — single opponent)
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
// Pitcher pickup notification (schedule-aware, multi-start)
// ---------------------------------------------------------------------------

export function formatPitcherPickupNotification(
  env: Env,
  analysis: PitcherPickupAnalysis,
  dropName: string,
  streamReasoning: string,
  metricsStr: string,
): string {
  const urls = yahooUrls(env);
  const lines: string[] = [];

  const tag = analysis.isTwoStart ? "2-Start Pitcher" : "Streaming Pitcher";
  lines.push(`<b>${tag}</b>`);
  lines.push("");

  lines.push(
    `Add <b>${esc(analysis.player.name)}</b> (score: ${analysis.totalScore.toFixed(1)})${metricsStr}`,
  );
  lines.push(`Drop <b>${esc(dropName)}</b>`);
  lines.push("");

  // Per-start breakdown
  lines.push("<b>Starts:</b>");
  for (const s of analysis.starts) {
    const dayLabel = formatShortDate(s.date);
    const homeAway = s.isHome ? "vs" : "@";
    const conf = s.confidence === "confirmed" ? "" : ` [${s.confidence}]`;
    const strength =
      s.opponentStrength < 0.3 ? " (weak)" : s.opponentStrength > 0.34 ? " (tough)" : "";
    lines.push(
      `  ${dayLabel}: ${homeAway} ${s.opponent}${strength} — ${s.score.toFixed(1)} pts${conf}`,
    );
  }

  if (analysis.matchupImpact) {
    const { netCategoriesHelped, netCategoriesHurt } = analysis.matchupImpact;
    if (netCategoriesHelped > 0 || netCategoriesHurt > 0) {
      lines.push("");
      lines.push(`Matchup: helps ${netCategoriesHelped} cats, risks ${netCategoriesHurt}`);
    }
  }

  lines.push("");
  lines.push(esc(streamReasoning));
  lines.push("");
  lines.push(`<a href="${urls.transactions()}">Open transactions on Yahoo</a>`);

  return lines.join("\n");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = DAY_NAMES[d.getUTCDay()];
  const month = d.getUTCMonth() + 1;
  const date = d.getUTCDate();
  return `${day} ${month}/${date}`;
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
