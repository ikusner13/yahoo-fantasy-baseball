import type { Env } from "../types";

// --- Interfaces ---

export interface NewsAlert {
  type: "closer_change" | "callup" | "injury" | "trade" | "lineup_change";
  playerName: string;
  team: string;
  headline: string;
  fantasyImpact: string; // brief description of impact
  actionable: boolean; // true = should consider adding/dropping
  timestamp: string;
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

  return `<b>${icon} ${tag}:</b> ${alert.playerName}${teamStr} — ${alert.headline}. <i>${alert.fantasyImpact}</i>`;
}
