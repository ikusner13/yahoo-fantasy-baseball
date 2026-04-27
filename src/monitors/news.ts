import type { Category, Env } from "../types";
import { askLLMJson } from "../ai/llm";
import { newsSignalPrompt } from "../ai/prompts";
import { z } from "zod";

// --- Interfaces ---

export interface NewsAlert {
  type: "closer_change" | "callup" | "injury" | "trade" | "lineup_change";
  playerName: string;
  team: string;
  headline: string;
  fantasyImpact: string; // brief description of impact
  actionable: boolean; // true = should consider adding/dropping
  timestamp: string;
  structured?: NewsStructuredSignal;
}

export type NewsImpactLevel = "low" | "medium" | "high";
export type NewsRoleChange =
  | "closer_up"
  | "closer_down"
  | "rotation_up"
  | "rotation_down"
  | "lineup_up"
  | "lineup_down"
  | "playing_time_up"
  | "playing_time_down"
  | "none";
export type NewsAbsence = "none" | "day_to_day" | "short_il" | "long_il" | "season_risk" | "unknown";
export type NewsActionBias = "add" | "hold" | "drop" | "watch" | "ignore";
export type NewsPlayingTimeDelta = "up" | "down" | "stable" | "unclear";

export interface NewsStructuredSignal {
  impactLevel: NewsImpactLevel;
  roleChange: NewsRoleChange;
  expectedAbsence: NewsAbsence;
  actionBias: NewsActionBias;
  playingTimeDelta: NewsPlayingTimeDelta;
  targetCategories: Category[];
  confidence: number;
  summary: string;
}

// --- Constants ---

const CLOSER_KEYWORDS = ["closer", "save", "saves", "ninth inning", "closing"];
const INJURY_KEYWORDS = ["IL", "injured", "injury", "DL", "disabled"];
const CALLUP_KEYWORDS = ["called up", "promoted", "recalled", "selected"];
const ACTIONABLE_KEYWORDS = [
  ...CLOSER_KEYWORDS,
  ...INJURY_KEYWORDS,
  ...CALLUP_KEYWORDS,
  "designated",
];

const newsSignalSchema = z.object({
  impactLevel: z.enum(["low", "medium", "high"]),
  roleChange: z.enum([
    "closer_up",
    "closer_down",
    "rotation_up",
    "rotation_down",
    "lineup_up",
    "lineup_down",
    "playing_time_up",
    "playing_time_down",
    "none",
  ]),
  expectedAbsence: z.enum(["none", "day_to_day", "short_il", "long_il", "season_risk", "unknown"]),
  actionBias: z.enum(["add", "hold", "drop", "watch", "ignore"]),
  playingTimeDelta: z.enum(["up", "down", "stable", "unclear"]),
  targetCategories: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(4).max(80),
});

const CATEGORY_ALIASES: Record<string, Category> = {
  r: "R",
  runs: "R",
  h: "H",
  hits: "H",
  hr: "HR",
  home_runs: "HR",
  home_runss: "HR",
  rbi: "RBI",
  sb: "SB",
  steals: "SB",
  tb: "TB",
  total_bases: "TB",
  obp: "OBP",
  out: "OUT",
  outs: "OUT",
  k: "K",
  ks: "K",
  strikeouts: "K",
  era: "ERA",
  whip: "WHIP",
  qs: "QS",
  svhd: "SVHD",
  "sv+h": "SVHD",
  sv_h: "SVHD",
  saves: "SVHD",
  holds: "SVHD",
};

// --- Helpers ---

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

/** Classify an MLB Stats API transaction type into a NewsAlert type. */
export function classifyTransaction(
  typeCode: string,
  description: string,
): NewsAlert["type"] | null {
  const desc = description.toLowerCase();
  const code = typeCode.toLowerCase();

  if (code.includes("trade") || desc.includes("trade")) return "trade";
  // Check injury BEFORE callup — "Status Change" typeCode covers both IL placements and call-ups
  if (
    code.includes("injured") ||
    code.includes("disabled") ||
    desc.includes("injured list") ||
    desc.includes("placed on il") ||
    desc.includes("placed on the")
  )
    return "injury";
  if (
    code.includes("status change") ||
    code.includes("call-up") ||
    code.includes("recalled") ||
    desc.includes("called up") ||
    desc.includes("promoted") ||
    desc.includes("selected to")
  )
    return "callup";
  if (code.includes("optioned") || desc.includes("optioned")) return "callup";

  return null;
}

/** Detect if a headline/description relates to closer changes. */
export function isCloserRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return CLOSER_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Extract fantasy impact string from transaction description. */
export function assessImpact(type: NewsAlert["type"], _description: string): string {
  switch (type) {
    case "closer_change":
      return "Potential saves/holds impact — check closer depth chart";
    case "injury":
      return "Check IL eligibility and replacement options";
    case "callup":
      return "New MLB player — evaluate for roster add";
    case "trade":
      return "Role/playing time may change — monitor new team context";
    case "lineup_change":
      return "Lineup position change — may affect counting stats";
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeCategory(value: string): Category | null {
  const key = value.toLowerCase().replace(/[^a-z+]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return CATEGORY_ALIASES[key] ?? null;
}

function uniqueCategories(values: Iterable<Category>): Category[] {
  return [...new Set(values)];
}

function shouldUseLLM(alert: NewsAlert): boolean {
  return alert.type === "closer_change" || alert.type === "callup" || alert.type === "injury" || alert.type === "trade";
}

export function inferFallbackNewsSignal(alert: NewsAlert): NewsStructuredSignal {
  const lower = `${alert.headline} ${alert.fantasyImpact}`.toLowerCase();
  const isCloser = alert.type === "closer_change" || lower.includes("closer") || lower.includes("save");
  const categories = new Set<Category>();

  let roleChange: NewsRoleChange = "none";
  let expectedAbsence: NewsAbsence = "none";
  let impactLevel: NewsImpactLevel = "medium";
  let actionBias: NewsActionBias = "watch";
  let playingTimeDelta: NewsPlayingTimeDelta = "stable";
  let summary = alert.fantasyImpact;

  if (isCloser) {
    roleChange = "closer_up";
    actionBias = "add";
    impactLevel = "high";
    playingTimeDelta = "up";
    categories.add("SVHD");
    summary = "Closer role likely gained";
  } else if (alert.type === "callup") {
    roleChange = lower.includes("rotation") || lower.includes("starter") ? "rotation_up" : "playing_time_up";
    actionBias = "watch";
    impactLevel = "medium";
    playingTimeDelta = "up";
    summary = "Promotion may create playing time";
  } else if (alert.type === "injury") {
    actionBias = "hold";
    playingTimeDelta = "down";
    roleChange = "playing_time_down";
    if (
      lower.includes("out for season") ||
      lower.includes("tommy john") ||
      lower.includes("surgery") ||
      lower.includes("60-day")
    ) {
      expectedAbsence = "season_risk";
      impactLevel = "high";
      actionBias = "drop";
      summary = "Long absence risk";
    } else if (lower.includes("10-day") || lower.includes("15-day") || lower.includes("il")) {
      expectedAbsence = "short_il";
      impactLevel = "medium";
      summary = "Likely short IL absence";
    } else if (lower.includes("day to day") || lower.includes("dtd")) {
      expectedAbsence = "day_to_day";
      impactLevel = "low";
      summary = "Short-term injury concern";
    } else {
      expectedAbsence = "unknown";
      impactLevel = "medium";
      summary = "Injury impact unclear";
    }
  } else if (alert.type === "trade") {
    impactLevel = "medium";
    actionBias = "watch";
    summary = "Role may change on new team";
  } else if (alert.type === "lineup_change") {
    impactLevel = "low";
    actionBias = "watch";
    summary = "Lineup role may be changing";
  }

  if (lower.includes("bat leadoff") || lower.includes("leading off") || lower.includes("move up") || lower.includes("batting second")) {
    roleChange = "lineup_up";
    playingTimeDelta = "up";
    impactLevel = impactLevel === "low" ? "medium" : impactLevel;
  } else if (lower.includes("bat ninth") || lower.includes("batting ninth") || lower.includes("platoon") || lower.includes("resting")) {
    roleChange = "lineup_down";
    playingTimeDelta = "down";
  }

  if (lower.includes("speed") || lower.includes("steal")) categories.add("SB");
  if (lower.includes("power") || lower.includes("home run")) categories.add("HR");
  if (lower.includes("run production") || lower.includes("middle of the order")) categories.add("RBI");

  return {
    impactLevel,
    roleChange,
    expectedAbsence,
    actionBias,
    playingTimeDelta,
    targetCategories: uniqueCategories(categories),
    confidence: isCloser ? 0.82 : alert.type === "injury" ? 0.72 : 0.64,
    summary,
  };
}

function reconcileTargetCategories(
  alert: NewsAlert,
  fallback: NewsStructuredSignal,
  parsedCategories: Category[],
): Category[] {
  const merged = uniqueCategories([...fallback.targetCategories, ...parsedCategories]);

  if (alert.type === "closer_change") {
    return uniqueCategories(["SVHD", ...merged.filter((category) => category !== "H")]);
  }

  return merged;
}

function mergeNewsSignals(
  alert: NewsAlert,
  fallback: NewsStructuredSignal,
  llmSignal: Partial<Omit<NewsStructuredSignal, "targetCategories">> & { targetCategories?: string[] },
): NewsStructuredSignal {
  const parsedCategories = uniqueCategories(
    (llmSignal.targetCategories ?? [])
      .map((value) => normalizeCategory(value))
      .filter((value): value is Category => value != null),
  );

  return {
    impactLevel: llmSignal.impactLevel ?? fallback.impactLevel,
    roleChange: llmSignal.roleChange ?? fallback.roleChange,
    expectedAbsence: llmSignal.expectedAbsence ?? fallback.expectedAbsence,
    actionBias: llmSignal.actionBias ?? fallback.actionBias,
    playingTimeDelta: llmSignal.playingTimeDelta ?? fallback.playingTimeDelta,
    targetCategories: reconcileTargetCategories(alert, fallback, parsedCategories),
    confidence:
      llmSignal.confidence == null ? fallback.confidence : Math.max(fallback.confidence * 0.6, clamp01(llmSignal.confidence)),
    summary:
      typeof llmSignal.summary === "string" && llmSignal.summary.trim().length > 0
        ? llmSignal.summary.trim()
        : fallback.summary,
  };
}

export async function enrichNewsAlert(env: Env, alert: NewsAlert): Promise<NewsAlert> {
  const fallback = inferFallbackNewsSignal(alert);
  if (!shouldUseLLM(alert) || (!env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY)) {
    return { ...alert, structured: fallback };
  }

  const briefing = [
    `TYPE: ${alert.type}`,
    `PLAYER: ${alert.playerName}`,
    `TEAM: ${alert.team || "unknown"}`,
    `HEADLINE: ${alert.headline}`,
    `BASE IMPACT: ${alert.fantasyImpact}`,
  ].join("\n");
  const prompt = newsSignalPrompt(briefing);
  const llmSignal = await askLLMJson<
    Partial<Omit<NewsStructuredSignal, "targetCategories">> & { targetCategories?: string[] }
  >(env, prompt.system, prompt.user, newsSignalSchema, prompt.touchpoint);

  return {
    ...alert,
    structured: llmSignal ? mergeNewsSignals(alert, fallback, llmSignal) : fallback,
  };
}

export async function enrichNewsAlerts(env: Env, alerts: NewsAlert[]): Promise<NewsAlert[]> {
  if (alerts.length === 0) return alerts;
  return Promise.all(alerts.map((alert) => enrichNewsAlert(env, alert)));
}

/** Simple XML tag content extractor (avoids heavy XML parser dep). */
function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim() ?? "";
}

/** Extract all instances of a tag from XML. */
function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

// --- Core exports ---

/**
 * Fetch today's transactions from MLB Stats API.
 * Parses into NewsAlert format, filtering to actionable fantasy transactions.
 */
export async function checkMLBTransactions(_env: Env): Promise<NewsAlert[]> {
  const today = todayISO();
  const url = `https://statsapi.mlb.com/api/v1/transactions?sportId=1&startDate=${today}&endDate=${today}`;

  const res = await fetch(url);
  if (!res.ok) return [];

  const data = (await res.json()) as {
    transactions?: Array<{
      id: number;
      person?: { fullName?: string };
      toTeam?: { name?: string; abbreviation?: string };
      fromTeam?: { name?: string; abbreviation?: string };
      date: string;
      effectiveDate?: string;
      typeCode?: string;
      typeName?: string;
      description?: string;
    }>;
  };

  if (!data.transactions) return [];

  const alerts: NewsAlert[] = [];

  for (const tx of data.transactions) {
    const description = tx.description ?? tx.typeName ?? "";
    const typeCode = tx.typeCode ?? tx.typeName ?? "";
    const alertType = classifyTransaction(typeCode, description);
    if (!alertType) continue;

    const playerName = tx.person?.fullName ?? "Unknown";
    const team = tx.toTeam?.abbreviation ?? tx.fromTeam?.abbreviation ?? "???";

    // Check if this is closer-related (upgrade type if so)
    const finalType = isCloserRelated(description) ? "closer_change" : alertType;

    alerts.push({
      type: finalType,
      playerName,
      team,
      headline: description.slice(0, 200),
      fantasyImpact: assessImpact(finalType, description),
      actionable: finalType === "closer_change" || finalType === "injury" || finalType === "callup",
      timestamp: tx.effectiveDate ?? tx.date ?? today,
    });
  }

  return alerts;
}

/**
 * Fetch and parse RSS feeds for fantasy-relevant MLB news.
 * Checks main MLB feed and RotoBaller for items from last 2 hours.
 */
export async function checkRSSFeeds(): Promise<NewsAlert[]> {
  // RotoWire RSS removed — paywalled, returns HTML instead of XML
  const feeds = ["https://www.mlb.com/feeds/news/rss.xml"];

  const cutoff = hoursAgo(2);
  const alerts: NewsAlert[] = [];

  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "FantasyBaseballBot/1.0" },
      });
      if (!res.ok) continue;

      const xml = await res.text();
      const items = extractAllTags(xml, "item");

      for (const item of items) {
        const title = extractTag(item, "title");
        const pubDate = extractTag(item, "pubDate");
        const description = extractTag(item, "description");
        const combined = `${title} ${description}`.toLowerCase();

        // Filter to recent items
        if (pubDate) {
          const itemDate = new Date(pubDate);
          if (itemDate < cutoff) continue;
        }

        // Check for actionable keywords
        const hasKeyword = ACTIONABLE_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()));
        if (!hasKeyword) continue;

        // Determine type from content
        let type: NewsAlert["type"] = "lineup_change";
        if (CLOSER_KEYWORDS.some((kw) => combined.includes(kw))) type = "closer_change";
        else if (INJURY_KEYWORDS.some((kw) => combined.includes(kw))) type = "injury";
        else if (CALLUP_KEYWORDS.some((kw) => combined.includes(kw))) type = "callup";

        alerts.push({
          type,
          playerName: title.split(":")[0]?.trim().split("—")[0]?.trim() ?? title,
          team: "", // RSS doesn't always include team
          headline: title.slice(0, 200),
          fantasyImpact: assessImpact(type, combined),
          actionable: type !== "lineup_change",
          timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        });
      }
    } catch {
      // Feed unavailable — skip silently
    }
  }

  return alerts;
}

/**
 * Filter alerts to those affecting closer roles.
 * Closer changes are the highest-impact fantasy moves (SV+HLD).
 */
export function detectCloserChanges(transactions: NewsAlert[]): NewsAlert[] {
  return transactions.filter((a) => a.type === "closer_change");
}

/**
 * Combine MLB transactions + RSS feeds, deduplicate, and return
 * actionable alerts sorted by impact priority.
 */
export async function getActionableAlerts(env: Env): Promise<NewsAlert[]> {
  const [transactions, rssAlerts] = await Promise.all([checkMLBTransactions(env), checkRSSFeeds()]);

  const all = [...transactions, ...rssAlerts];

  // Deduplicate by playerName + type (keep first occurrence)
  const seen = new Set<string>();
  const deduped: NewsAlert[] = [];
  for (const alert of all) {
    const key = `${alert.playerName.toLowerCase()}:${alert.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(alert);
  }

  // Sort by impact: closer_change > injury > callup > trade > lineup_change
  const typePriority: Record<NewsAlert["type"], number> = {
    closer_change: 0,
    injury: 1,
    callup: 2,
    trade: 3,
    lineup_change: 4,
  };

  deduped.sort((a, b) => typePriority[a.type] - typePriority[b.type]);

  return deduped.filter((a) => a.actionable);
}

/**
 * Format a single alert as Telegram HTML string.
 */
export function formatAlertForTelegram(alert: NewsAlert): string {
  const emoji: Record<NewsAlert["type"], string> = {
    closer_change: "\u{1F514}",
    injury: "\u{1F3E5}",
    callup: "\u{1F4E2}",
    trade: "\u{1F4E6}",
    lineup_change: "\u{1F4CB}",
  };

  const label: Record<NewsAlert["type"], string> = {
    closer_change: "CLOSER CHANGE",
    injury: "INJURY",
    callup: "CALL-UP",
    trade: "TRADE",
    lineup_change: "LINEUP",
  };

  const icon = emoji[alert.type];
  const tag = label[alert.type];
  const teamStr = alert.team ? ` (${alert.team})` : "";
  const structured = alert.structured?.summary ? ` ${alert.structured.summary}.` : "";

  return `<b>${icon} ${tag}:</b> ${alert.playerName}${teamStr} — ${alert.headline}.${structured} <i>${alert.fantasyImpact}</i>`;
}
