import type {
  Env,
  Decision,
  ScheduledGame,
  PlayerProjection,
  PlayerValuation,
  LineupMove,
} from "./types";
import { YahooClient } from "./yahoo/client";
import { getTodaysGames } from "./data/mlb";
import { sendMessage } from "./notifications/telegram";
import { getILMoves, countILSlots, getInjuredActivePlayers } from "./analysis/il-manager";
import { optimizeLineup } from "./analysis/lineup";
import { computeZScores } from "./analysis/valuations";
import { analyzeMatchup } from "./analysis/matchup";
import type { MatchupAnalysis } from "./analysis/matchup";
import { rankStreamingOptions, shouldStream } from "./analysis/streaming";
import { findBestPickups, shouldUseWaiverPriority } from "./analysis/waivers";
import { fetchBatterProjections, fetchPitcherProjections } from "./data/projections";
import { identifyCategoryNeeds, identifySurplus } from "./analysis/trades";
import { askLLM, summarizeForTelegram } from "./ai/llm";
import { waiverWirePrompt, matchupStrategyPrompt, tradeProposalPrompt } from "./ai/prompts";
import { getWeekSchedule, findGameCountEdge } from "./analysis/game-count";
import {
  getAddBudget,
  recordAdd,
  shouldSpendAdd,
  classifyAddPriority,
  resetWeeklyBudget,
} from "./analysis/add-budget";
import { getActionableAlerts, formatAlertForTelegram } from "./monitors/news";

// Helper to find player name from roster by ID
function findPlayerName(
  roster: { entries: Array<{ player: { yahooId: string; name: string } }> },
  playerId: string,
): string {
  return roster.entries.find((e) => e.player.yahooId === playerId)?.player.name ?? playerId;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/** Build a Map<yahooId, PlayerProjection> from FanGraphs raw projections.
 *  Uses `fg:${fangraphsId}` as key since player-ids mapping is incomplete. */
function buildProjectionMap(
  batters: Awaited<ReturnType<typeof fetchBatterProjections>>,
  pitchers: Awaited<ReturnType<typeof fetchPitcherProjections>>,
): Map<string, PlayerProjection> {
  const map = new Map<string, PlayerProjection>();
  const now = new Date().toISOString();

  for (const b of batters) {
    const key = `fg:${b.fangraphsId}`;
    map.set(key, {
      yahooId: key,
      playerType: "batter",
      batting: {
        pa: b.pa,
        r: b.r,
        h: b.h,
        hr: b.hr,
        rbi: b.rbi,
        sb: b.sb,
        tb: b.tb,
        obp: b.obp,
      },
      updatedAt: now,
    });
  }

  for (const p of pitchers) {
    const key = `fg:${p.fangraphsId}`;
    map.set(key, {
      yahooId: key,
      playerType: "pitcher",
      pitching: {
        ip: p.ip,
        outs: Math.round(p.ip * 3),
        k: p.k,
        era: p.era,
        whip: p.whip,
        qs: p.qs,
        svhd: p.svhd,
      },
      updatedAt: now,
    });
  }

  return map;
}

/** Convert projection map values to array for z-score computation. */
function projectionsToArray(map: Map<string, PlayerProjection>): PlayerProjection[] {
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Daily morning routine (9am ET)
// ---------------------------------------------------------------------------

export async function runDailyMorning(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = new Date().toISOString().slice(0, 10);
  const summaryLines: string[] = [`<b>Daily GM Report — ${today}</b>`];
  const decisions: Decision[] = [];

  // 0. Check news alerts (closer changes, call-ups, injuries)
  try {
    const alerts = await getActionableAlerts(env);
    if (alerts.length > 0) {
      summaryLines.push(`\n<b>News Alerts (${alerts.length}):</b>`);
      for (const alert of alerts.slice(0, 5)) {
        summaryLines.push(formatAlertForTelegram(alert));
      }
    }
  } catch {
    // non-fatal
  }

  // 1. Fetch roster
  let roster;
  try {
    roster = await yahoo.getRoster(today);
    summaryLines.push(`Roster: ${roster.entries.length} players`);
  } catch (e) {
    const msg = `Roster fetch failed: ${e instanceof Error ? e.message : "unknown"}`;
    summaryLines.push(msg);
    await sendMessage(env, summaryLines.join("\n"));
    return;
  }

  // 2. Fetch today's games
  let games: ScheduledGame[] = [];
  try {
    games = await getTodaysGames(today);
    summaryLines.push(`Games today: ${games.length}`);
    appendProbablePitchers(summaryLines, games);
  } catch (e) {
    summaryLines.push(`Games fetch failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 2b. Weekly game count analysis
  try {
    // Get this week's schedule (Mon-Sun)
    const dayOfWeek = new Date(today).getDay(); // 0=Sun
    const weekStartOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(new Date(today).getTime() + weekStartOffset * 86400000)
      .toISOString()
      .slice(0, 10);
    const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);
    const weekSchedule = await getWeekSchedule(weekStart, weekEnd);
    const edgeTeams = findGameCountEdge(weekSchedule);
    if (edgeTeams.length > 0) {
      summaryLines.push(`7-game teams this week: ${edgeTeams.join(", ")}`);
    }
  } catch {
    // non-fatal
  }

  // 3. Fetch projections from FanGraphs
  let projectionMap = new Map<string, PlayerProjection>();
  let allProjections: PlayerProjection[] = [];
  let valuations: PlayerValuation[] = [];
  try {
    const [rawBatters, rawPitchers] = await Promise.all([
      fetchBatterProjections(),
      fetchPitcherProjections(),
    ]);
    projectionMap = buildProjectionMap(rawBatters, rawPitchers);
    allProjections = projectionsToArray(projectionMap);
    summaryLines.push(`Projections: ${rawBatters.length} batters, ${rawPitchers.length} pitchers`);

    // 4. Compute z-scores
    valuations = computeZScores(allProjections);
    summaryLines.push(`Valuations: ${valuations.length} players scored`);
  } catch (e) {
    summaryLines.push(`Projections failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 5. Fetch current matchup for category weighting
  let matchup;
  let matchupAnalysis: MatchupAnalysis | null = null;
  try {
    matchup = await yahoo.getMatchup();
    if (matchup.categories.length > 0) {
      matchupAnalysis = analyzeMatchup(matchup);
    }
  } catch {
    // non-fatal, lineup optimization works without matchup context
  }

  // 6. IL moves
  try {
    const ilActions = getILMoves(roster);
    if (ilActions.length > 0) {
      summaryLines.push(`\n<b>IL Moves (${ilActions.length}):</b>`);

      // Convert IL actions to lineup moves and execute
      const ilMoves: LineupMove[] = [];
      for (const a of ilActions) {
        summaryLines.push(`• ${a.reasoning}`);
        if (a.type === "move_to_il") {
          ilMoves.push({ playerId: a.player.yahooId, position: "IL" });
        } else if (a.type === "activate_from_il") {
          ilMoves.push({ playerId: a.player.yahooId, position: "BN" });
        }
      }

      if (ilMoves.length > 0) {
        try {
          await yahoo.setLineup(today, ilMoves);
          summaryLines.push(`IL moves executed: ${ilMoves.length}`);
        } catch (e) {
          summaryLines.push(
            `IL move execution failed: ${e instanceof Error ? e.message : "unknown"}`,
          );
        }
      }
    } else {
      summaryLines.push("IL: no moves needed");
    }
    decisions.push({
      type: "il",
      action: { ilActions },
      reasoning: ilActions.map((a) => a.reasoning).join("; ") || "no moves",
      result: "success",
    });
  } catch (e) {
    summaryLines.push(`IL check failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 7. Optimize lineup + AI analysis
  try {
    const moves = optimizeLineup(roster, projectionMap, games, matchup);
    if (moves.length > 0) {
      await yahoo.setLineup(today, moves);
      const activeCount = moves.filter((m) => m.position !== "BN" && m.position !== "IL").length;
      summaryLines.push(`Lineup set: ${activeCount} active, ${moves.length} total moves`);
    } else {
      summaryLines.push("Lineup: no changes needed");
    }

    // AI: explain lineup decisions (supplemental — stats engine already decided)
    try {
      const starters = moves.filter((m) => m.position !== "BN" && m.position !== "IL");
      const benched = moves.filter((m) => m.position === "BN");
      const context = [
        `Stats engine set the lineup. Summarize the key decisions:`,
        `STARTERS: ${starters.map((m) => `${findPlayerName(roster, m.playerId)} → ${m.position}`).join(", ")}`,
        `BENCHED: ${benched.map((m) => findPlayerName(roster, m.playerId)).join(", ")}`,
        `GAMES: ${games
          .slice(0, 8)
          .map((g) => `${g.awayTeam}@${g.homeTeam}`)
          .join(", ")}`,
        matchupAnalysis ? `STRATEGY: ${matchupAnalysis.strategy.benchMessage}` : "",
      ].join("\n");
      const aiNotes = await summarizeForTelegram(env, context);
      if (!aiNotes.startsWith("[")) {
        summaryLines.push(`\n<b>AI Notes:</b> ${aiNotes}`);
      }
    } catch {
      // supplemental — don't fail
    }

    decisions.push({
      type: "lineup",
      action: { moves: moves.length },
      reasoning: `Set ${moves.length} lineup moves`,
      result: "success",
    });
  } catch (e) {
    summaryLines.push(`Lineup optimization failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 8. Waiver wire evaluation
  try {
    const freeAgents = await yahoo.getFreeAgents(undefined, 50);
    if (freeAgents.length > 0 && valuations.length > 0) {
      // Build valuation map for roster players
      const valMap = new Map<string, PlayerValuation>();
      for (const v of valuations) valMap.set(v.yahooId, v);

      // Build FA valuations from the z-score list (match by yahooId)
      const faValuations = valuations.filter((v) =>
        freeAgents.some((fa) => fa.yahooId === v.yahooId),
      );

      const pickups = findBestPickups(faValuations, roster.entries, valMap, 5);

      if (pickups.length > 0) {
        const budget = getAddBudget(env);
        summaryLines.push(
          `\n<b>Waiver Picks (${pickups.length}):</b> [${budget.addsRemaining} adds left this week]`,
        );
        for (const rec of pickups) {
          const priority = classifyAddPriority(rec, {});
          summaryLines.push(
            `• ${rec.add.name} for ${rec.drop.name} (+${rec.netValue.toFixed(1)}) [${priority}]`,
          );

          // Check add budget before spending
          if (!shouldSpendAdd(budget, priority)) {
            summaryLines.push(`  -> Skipped (saving adds for higher-impact moves)`);
            continue;
          }

          // Execute high-value pickups
          if (shouldUseWaiverPriority(rec, 5)) {
            try {
              await yahoo.claimWaiver(rec.add.yahooId, rec.drop.yahooId);
              summaryLines.push(`  -> Waiver claim submitted`);
              recordAdd(env);
              decisions.push({
                type: "waiver",
                action: { add: rec.add.name, drop: rec.drop.name, net: rec.netValue },
                reasoning: rec.reasoning,
                result: "success",
              });
            } catch (e) {
              summaryLines.push(`  -> Claim failed: ${e instanceof Error ? e.message : "unknown"}`);
              decisions.push({
                type: "waiver",
                action: { add: rec.add.name, drop: rec.drop.name },
                reasoning: rec.reasoning,
                result: "failed",
              });
            }
          } else {
            // Low priority — use add/drop (instant FA pickup)
            try {
              await yahoo.addDrop(rec.add.yahooId, rec.drop.yahooId);
              summaryLines.push(`  -> Add/drop executed`);
              recordAdd(env);
              decisions.push({
                type: "waiver",
                action: { add: rec.add.name, drop: rec.drop.name, net: rec.netValue },
                reasoning: rec.reasoning,
                result: "success",
              });
            } catch (e) {
              summaryLines.push(
                `  -> Add/drop failed: ${e instanceof Error ? e.message : "unknown"}`,
              );
            }
          }
        }

        // LLM: commentary on waiver recommendations (supplemental — stats engine already decided)
        try {
          const rosterNeeds =
            valuations.length > 0 ? identifyCategoryNeeds(valuations).join(", ") : "unknown";
          const prompt = waiverWirePrompt({
            recommendations: pickups.map((r) => r.reasoning).join("\n"),
            rosterNeeds,
            waiverPriority: 5,
          });
          const waiverInsight = await askLLM(env, prompt.system, prompt.user);
          if (!waiverInsight.startsWith("[")) {
            summaryLines.push(`\n<b>AI Waiver Notes:</b> ${waiverInsight}`);
          }
        } catch {
          // supplemental — don't fail
        }
      } else {
        summaryLines.push("Waivers: no upgrades found");
      }
    } else {
      summaryLines.push("Waivers: skipped (no FAs or valuations)");
    }
  } catch (e) {
    summaryLines.push(`Waiver scan failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 9. Streaming pitchers
  try {
    const faPitchers = await yahoo.getFreeAgents("SP", 25);
    if (faPitchers.length > 0 && games.length > 0) {
      // Build pitcher streaming inputs
      const streamCandidates = faPitchers.map((p) => {
        const proj = projectionMap.get(p.yahooId);
        return {
          player: p,
          projection: proj?.pitching,
        };
      });

      const ranked = rankStreamingOptions(streamCandidates, games);
      const canStream = shouldStream(matchupAnalysis, 4.0, 1.3); // conservative defaults

      if (canStream && ranked.length > 0 && ranked[0].score > 3.0) {
        const top = ranked[0];
        summaryLines.push(`\n<b>Streaming SP:</b>`);
        summaryLines.push(
          `• ${top.player.name} vs ${top.opponent} (score: ${top.score.toFixed(1)})`,
        );

        // Find worst bench pitcher to drop
        const benchPitchers = roster.entries.filter(
          (e) =>
            e.currentPosition === "BN" && e.player.positions.some((p) => p === "SP" || p === "RP"),
        );

        if (benchPitchers.length > 0) {
          const dropTarget = benchPitchers[benchPitchers.length - 1];
          try {
            await yahoo.addDrop(top.player.yahooId, dropTarget.player.yahooId);
            summaryLines.push(`  -> Added, dropping ${dropTarget.player.name}`);
            decisions.push({
              type: "stream",
              action: {
                add: top.player.name,
                drop: dropTarget.player.name,
                score: top.score,
                opponent: top.opponent,
              },
              reasoning: `Streaming ${top.player.name} vs ${top.opponent} (score ${top.score.toFixed(1)})`,
              result: "success",
            });
          } catch (e) {
            summaryLines.push(
              `  -> Stream add failed: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        } else {
          summaryLines.push("  -> No droppable bench pitcher");
        }
      } else if (!canStream) {
        summaryLines.push("Streaming: skipped (protecting ratios)");
      } else {
        summaryLines.push(
          `Streaming: no strong options (top: ${ranked[0]?.score.toFixed(1) ?? "none"})`,
        );
      }
    } else {
      summaryLines.push("Streaming: skipped (no FA pitchers or games)");
    }
  } catch (e) {
    summaryLines.push(`Streaming analysis failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 10. Send rich Telegram summary
  try {
    await sendMessage(env, summaryLines.join("\n"));
  } catch (e) {
    // last-resort: try a simpler message
    try {
      await sendMessage(
        env,
        `GM report generated but Telegram formatting failed: ${e instanceof Error ? e.message : "unknown"}`,
      );
    } catch {
      // truly nothing we can do
    }
  }

  // 11. Log all decisions to SQLite
  for (const d of decisions) {
    try {
      logDecision(env, d);
    } catch {
      // db logging is best-effort
    }
  }
  try {
    logDecision(env, {
      type: "lineup",
      action: { routine: "daily_morning", date: today, gamesCount: games.length },
      reasoning: `Morning routine completed for ${today}`,
      result: "success",
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Late scratch check (6pm ET)
// ---------------------------------------------------------------------------

export async function runLateScratchCheck(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = new Date().toISOString().slice(0, 10);

  const roster = await yahoo.getRoster(today);
  const games = await getTodaysGames(today);

  const injured = getInjuredActivePlayers(roster);
  const ilStatus = countILSlots(roster);

  const changes: string[] = [];

  if (injured.length > 0) {
    for (const entry of injured) {
      changes.push(
        `${entry.player.name} (${entry.player.status}) still in active slot ${entry.currentPosition}`,
      );
    }

    // Re-optimize lineup with empty projection map (best-effort with no projections)
    try {
      const moves = optimizeLineup(roster, new Map(), games);
      if (moves.length > 0) {
        await yahoo.setLineup(today, moves);
        changes.push(`Lineup re-optimized: ${moves.length} moves`);
      }
    } catch (e) {
      changes.push(`Re-optimization failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  if (changes.length > 0) {
    const msg = [
      `<b>Late Scratch Alert — ${today}</b>`,
      ...changes.map((c) => `• ${c}`),
      `IL slots: ${ilStatus.used}/${ilStatus.used + ilStatus.available} used`,
    ].join("\n");
    await sendMessage(env, msg);

    logDecision(env, {
      type: "lineup",
      action: { routine: "late_scratch", changes },
      reasoning: `${changes.length} late changes detected`,
      result: "success",
    });
  }
}

// ---------------------------------------------------------------------------
// Weekly matchup analysis (Monday morning)
// ---------------------------------------------------------------------------

export async function runWeeklyMatchupAnalysis(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  let matchup;
  try {
    matchup = await yahoo.getMatchup();
  } catch (e) {
    await sendMessage(
      env,
      `<b>Weekly Matchup</b>\nFailed to fetch matchup: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  let analysis: MatchupAnalysis | null = null;
  try {
    analysis = analyzeMatchup(matchup);
  } catch (e) {
    await sendMessage(
      env,
      `<b>Weekly Matchup</b>\nAnalysis failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  // Opponent scouting
  let scoutReport = "";
  try {
    const [rawBat, rawPit] = await Promise.all([
      fetchBatterProjections(),
      fetchPitcherProjections(),
    ]);
    const projMap = buildProjectionMap(rawBat, rawPit);
    const allVals = computeZScores(projectionsToArray(projMap));
    const valMap = new Map(allVals.map((v) => [v.yahooId, v]));

    const myRoster = await yahoo.getRoster();
    const myVals = myRoster.entries
      .map((e) => valMap.get(e.player.yahooId))
      .filter((v): v is PlayerValuation => !!v);

    // TODO: fetch opponent roster once API parsing is improved
    // For now, use category scores from matchup to infer opponent strength
    if (myVals.length > 0) {
      const needs = identifyCategoryNeeds(myVals);
      scoutReport = `\n<b>Our weakest cats:</b> ${needs.slice(0, 3).join(", ")}`;
    }
  } catch {
    // non-fatal
  }

  // Reset weekly add budget on Monday
  try {
    const today = new Date().toISOString().slice(0, 10);
    resetWeeklyBudget(env, today);
  } catch {}

  const lines = [
    `<b>Weekly Matchup Preview — Week ${matchup.week}</b>`,
    `vs. ${matchup.opponentTeamName}`,
    "",
    `<b>Projected:</b> ${analysis.projectedWins}W - ${analysis.projectedLosses}L - ${analysis.swingCategories.length} swing`,
    "",
  ];

  if (analysis.safeCategories.length > 0) {
    lines.push(`<b>Winning:</b> ${analysis.safeCategories.join(", ")}`);
  }
  if (analysis.swingCategories.length > 0) {
    lines.push(`<b>Swing:</b> ${analysis.swingCategories.join(", ")}`);
  }
  if (scoutReport) lines.push(scoutReport);
  if (analysis.lostCategories.length > 0) {
    lines.push(`<b>Losing:</b> ${analysis.lostCategories.join(", ")}`);
  }

  lines.push("");
  lines.push(`<b>Strategy:</b> ${analysis.strategy.benchMessage}`);

  // LLM: generate strategy memo (supplemental — stats engine already decided)
  try {
    const prompt = matchupStrategyPrompt({
      analysis: JSON.stringify(analysis, null, 2),
      currentScores: matchup.categories
        .map((c) => `${c.category}: ${c.myValue} vs ${c.opponentValue}`)
        .join(", "),
      daysRemaining: 7,
    });
    const strategyMemo = await askLLM(env, prompt.system, prompt.user);
    if (!strategyMemo.startsWith("[")) {
      lines.push("");
      lines.push(`<b>AI Strategy Memo:</b> ${strategyMemo}`);
    }
  } catch {
    // supplemental — don't fail
  }

  try {
    await sendMessage(env, lines.join("\n"));
  } catch {
    // fallback
    await sendMessage(env, `Week ${matchup.week} analysis generated but send failed`);
  }

  logDecision(env, {
    type: "lineup",
    action: {
      routine: "weekly_matchup",
      week: matchup.week,
      opponent: matchup.opponentTeamName,
      projected: `${analysis.projectedWins}-${analysis.projectedLosses}`,
      swing: analysis.swingCategories,
    },
    reasoning: `Week ${matchup.week} matchup analysis vs ${matchup.opponentTeamName}: ${analysis.projectedWins}W-${analysis.projectedLosses}L`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Mid-week adjustment (Wednesday)
// ---------------------------------------------------------------------------

export async function runMidWeekAdjustment(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  let matchup;
  try {
    matchup = await yahoo.getMatchup();
  } catch (e) {
    await sendMessage(
      env,
      `<b>Mid-Week Adjustment</b>\nFailed to fetch matchup: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  let analysis: MatchupAnalysis | null = null;
  try {
    analysis = analyzeMatchup(matchup);
  } catch (e) {
    await sendMessage(
      env,
      `<b>Mid-Week Adjustment</b>\nAnalysis failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  // Build current category scoreboard
  const catLines: string[] = [];
  for (const cs of matchup.categories) {
    const indicator =
      cs.myValue > cs.opponentValue ? "+" : cs.myValue < cs.opponentValue ? "-" : "=";
    catLines.push(`  ${indicator} ${cs.category}: ${cs.myValue} vs ${cs.opponentValue}`);
  }

  const lines = [
    `<b>Mid-Week Adjustment — Week ${matchup.week}</b>`,
    `vs. ${matchup.opponentTeamName}`,
    "",
    `<b>Current scores:</b>`,
    ...catLines,
    "",
    `<b>Updated projection:</b> ${analysis.projectedWins}W - ${analysis.projectedLosses}L - ${analysis.swingCategories.length} swing`,
    "",
  ];

  if (analysis.swingCategories.length > 0) {
    lines.push(`<b>Swing cats:</b> ${analysis.swingCategories.join(", ")}`);
  }

  lines.push("");
  lines.push(`<b>Adjustments:</b> ${analysis.strategy.benchMessage}`);

  if (analysis.strategy.protectRatios) {
    lines.push("<b>Note:</b> Protecting ERA/WHIP lead — avoid streaming risky arms.");
  }
  if (analysis.strategy.streamPitchers) {
    lines.push("<b>Note:</b> Streaming pitchers recommended to chase counting stats.");
  }

  // LLM: mid-week tactical memo (supplemental — stats engine already decided)
  try {
    const prompt = matchupStrategyPrompt({
      analysis: JSON.stringify(analysis, null, 2),
      currentScores: matchup.categories
        .map((c) => `${c.category}: ${c.myValue} vs ${c.opponentValue}`)
        .join(", "),
      daysRemaining: 4,
    });
    const strategyMemo = await askLLM(env, prompt.system, prompt.user);
    if (!strategyMemo.startsWith("[")) {
      lines.push("");
      lines.push(`<b>AI Mid-Week Tactics:</b> ${strategyMemo}`);
    }
  } catch {
    // supplemental — don't fail
  }

  try {
    await sendMessage(env, lines.join("\n"));
  } catch {
    await sendMessage(env, `Week ${matchup.week} mid-week adjustment generated but send failed`);
  }

  logDecision(env, {
    type: "lineup",
    action: {
      routine: "midweek_adjustment",
      week: matchup.week,
      projected: `${analysis.projectedWins}-${analysis.projectedLosses}`,
      swing: analysis.swingCategories,
      strategy: analysis.strategy,
    },
    reasoning: `Mid-week adjustment for week ${matchup.week}: ${analysis.projectedWins}W-${analysis.projectedLosses}L, strategy: ${analysis.strategy.benchMessage}`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Trade evaluation (Saturday)
// ---------------------------------------------------------------------------

export async function runTradeEvaluation(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const lines: string[] = ["<b>Trade Evaluation Scan</b>"];

  try {
    // 1. Fetch our roster + projections
    const roster = await yahoo.getRoster();
    const [batProj, pitProj] = await Promise.all([
      fetchBatterProjections(),
      fetchPitcherProjections(),
    ]);
    const projMap = buildProjectionMap(batProj, pitProj);
    const projArr = projectionsToArray(projMap);
    const valuations = computeZScores(projArr);

    // 2. Identify our needs and surplus
    const needs = identifyCategoryNeeds(valuations);
    const surplus = identifySurplus(valuations);

    lines.push(`\nWeakest categories: ${needs.slice(0, 3).join(", ")}`);
    lines.push(
      `Surplus categories: ${surplus
        .slice(0, 3)
        .map((s) => s.category)
        .join(", ")}`,
    );

    // 3. Fetch other teams' rosters
    await yahoo.getTeamRosters();

    // TODO: parse other teams' rosters into valuations
    // For now, log that we scanned and send needs analysis
    lines.push("\nOther team roster parsing: coming next iteration");
    lines.push(`\nScanned ${needs.length} weak categories, ${surplus.length} surplus categories`);

    if (needs.length > 0 && surplus.length > 0) {
      lines.push("\n<b>Trade targets to explore:</b>");
      for (const s of surplus.slice(0, 2)) {
        const topPlayer = s.players[0];
        if (topPlayer) {
          lines.push(
            `• Could trade ${topPlayer.name} (surplus ${s.category}) for help in ${needs[0]}`,
          );
        }
      }

      // LLM: evaluate trade opportunities (supplemental — stats engine identified needs/surplus)
      try {
        const rosterSummary = roster.entries
          .map((e) => `${e.player.name} (${e.player.positions.join("/")})`)
          .join(", ");
        const surplusDesc = surplus
          .slice(0, 3)
          .map((s) => `${s.category}: ${s.players.map((p) => p.name).join(", ")}`)
          .join("; ");
        const prompt = tradeProposalPrompt({
          myRoster: rosterSummary,
          targetRoster: "other team analysis coming soon",
          categoryNeeds: needs.join(", "),
          surplusPlayers: surplusDesc,
        });
        const tradeIdeas = await askLLM(env, prompt.system, prompt.user);
        if (!tradeIdeas.startsWith("[")) {
          lines.push("");
          lines.push(`<b>AI Trade Ideas:</b> ${tradeIdeas}`);
        }
      } catch {
        // supplemental — don't fail
      }
    } else {
      lines.push("\nRoster is balanced — no urgent trade needs.");
    }
  } catch (e) {
    lines.push(`\nError: ${e instanceof Error ? e.message : "unknown"}`);
  }

  await sendMessage(env, lines.join("\n"));

  logDecision(env, {
    type: "trade",
    action: { routine: "trade_evaluation" },
    reasoning: lines.join(" | "),
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Decision logging
// ---------------------------------------------------------------------------

export function logDecision(env: Env, decision: Decision): void {
  env.db
    .prepare("INSERT INTO decisions (type, action, reasoning, result) VALUES (?, ?, ?, ?)")
    .run(
      decision.type,
      JSON.stringify(decision.action),
      decision.reasoning ?? null,
      decision.result,
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendProbablePitchers(lines: string[], games: ScheduledGame[]): void {
  const pitchers = games.flatMap((g) => {
    const out: string[] = [];
    if (g.homeProbable) out.push(`${g.homeProbable.name} (${g.homeTeam})`);
    if (g.awayProbable) out.push(`${g.awayProbable.name} (${g.awayTeam})`);
    return out;
  });
  if (pitchers.length > 0) {
    lines.push(
      `Probable SPs: ${pitchers.slice(0, 8).join(", ")}${pitchers.length > 8 ? "..." : ""}`,
    );
  }
}
