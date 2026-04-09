// --- Interfaces ---

export interface TwoStartWeek {
  week: number;
  startDate: string;
  endDate: string;
  twoStartPitchers: TwoStartPitcher[];
}

export interface TwoStartPitcher {
  mlbId: number;
  name: string;
  team: string;
  starts: Array<{ date: string; opponent: string }>;
  confidence: "confirmed" | "probable" | "projected";
}

// --- Constants ---

const BASE = "https://statsapi.mlb.com/api/v1";

/** 2026 MLB season: week 1 starts Mon March 30 */
const SEASON_WEEK1_START = "2026-03-30";

const ID_TO_ABBR: Record<number, string> = {
  109: "ARI",
  144: "ATL",
  110: "BAL",
  111: "BOS",
  112: "CHC",
  145: "CWS",
  113: "CIN",
  114: "CLE",
  115: "COL",
  116: "DET",
  117: "HOU",
  118: "KC",
  108: "LAA",
  119: "LAD",
  146: "MIA",
  158: "MIL",
  142: "MIN",
  121: "NYM",
  147: "NYY",
  133: "OAK",
  143: "PHI",
  134: "PIT",
  135: "SD",
  137: "SF",
  136: "SEA",
  138: "STL",
  139: "TB",
  140: "TEX",
  141: "TOR",
  120: "WSH",
};

const ABBR_TO_ID: Record<string, number> = Object.fromEntries(
  Object.entries(ID_TO_ABBR).map(([id, abbr]) => [abbr, Number(id)]),
);

// --- Date helpers ---

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekStartDate(week: number): string {
  return addDays(SEASON_WEEK1_START, (week - 1) * 7);
}

function weekEndDate(week: number): string {
  return addDays(weekStartDate(week), 6);
}

/** Current fantasy week number based on today's date */
function currentWeekNumber(): number {
  const start = new Date(SEASON_WEEK1_START + "T12:00:00Z");
  const now = new Date();
  const diff = now.getTime() - start.getTime();
  return Math.max(1, Math.floor(diff / (7 * 86400000)) + 1);
}

// --- MLB API helpers ---

interface PitcherAppearance {
  mlbId: number;
  name: string;
  team: string;
  date: string;
  opponent: string;
}

/**
 * Fetch games for a date range with probable pitcher hydration.
 * Returns parsed ScheduledGame-like structures plus pitcher metadata.
 */
async function fetchScheduleWithProbables(
  startDate: string,
  endDate: string,
): Promise<PitcherAppearance[]> {
  const url = `${BASE}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=probablePitcher(note),team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const appearances: PitcherAppearance[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const dateEntry of json.dates ?? []) {
    const date = dateEntry.date as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const game of dateEntry.games ?? []) {
      const homeAbbr =
        (game.teams?.home?.team?.abbreviation as string | undefined) ??
        (game.teams?.home?.team?.id != null
          ? ID_TO_ABBR[game.teams.home.team.id as number]
          : undefined);
      const awayAbbr =
        (game.teams?.away?.team?.abbreviation as string | undefined) ??
        (game.teams?.away?.team?.id != null
          ? ID_TO_ABBR[game.teams.away.team.id as number]
          : undefined);

      if (!homeAbbr || !awayAbbr) continue;

      const homePitcher = game.teams?.home?.probablePitcher;
      const awayPitcher = game.teams?.away?.probablePitcher;

      if (homePitcher?.id) {
        appearances.push({
          mlbId: homePitcher.id as number,
          name: (homePitcher.fullName as string) ?? "",
          team: homeAbbr,
          date,
          opponent: awayAbbr,
        });
      }
      if (awayPitcher?.id) {
        appearances.push({
          mlbId: awayPitcher.id as number,
          name: (awayPitcher.fullName as string) ?? "",
          team: awayAbbr,
          date,
          opponent: homeAbbr,
        });
      }
    }
  }

  return appearances;
}

// --- Rotation projection ---

interface RotationSlot {
  date: string;
  projectedStarter?: { mlbId: number; name: string };
}

function uniqueSortedDates(dates: string[]): string[] {
  return [...new Set(dates)].sort((a, b) => a.localeCompare(b));
}

function limitStarts(
  starts: Array<{ date: string; opponent: string }>,
  maxStarts: number,
): Array<{ date: string; opponent: string }> {
  const seen = new Set<string>();
  const ordered = [...starts].sort((a, b) => a.date.localeCompare(b.date));
  const deduped: Array<{ date: string; opponent: string }> = [];

  for (const start of ordered) {
    if (seen.has(start.date)) continue;
    seen.add(start.date);
    deduped.push(start);
    if (deduped.length >= maxStarts) break;
  }

  return deduped;
}

/**
 * Fetch recent starts for a team and infer the 5-man rotation order,
 * then project forward.
 */
export async function getRotationProjection(
  team: string,
  startDate: string,
  daysAhead: number,
): Promise<RotationSlot[]> {
  // Fetch last 10 days of schedule to find recent starters
  const lookbackStart = addDays(startDate, -10);
  const appearances = await fetchScheduleWithProbables(lookbackStart, startDate);
  const teamAppearances = appearances.filter((a) => a.team === team);

  // Build rotation order from most recent appearances
  const seen = new Map<number, { name: string; lastDate: string }>();
  for (const a of teamAppearances) {
    const existing = seen.get(a.mlbId);
    if (!existing || a.date > existing.lastDate) {
      seen.set(a.mlbId, { name: a.name, lastDate: a.date });
    }
  }

  // Sort by last start date to infer rotation order
  const rotation = [...seen.entries()]
    .sort(([, a], [, b]) => a.lastDate.localeCompare(b.lastDate))
    .map(([mlbId, info]) => ({ mlbId, name: info.name }));

  // Fetch team's game dates for the projection window
  const projEnd = addDays(startDate, Math.max(0, daysAhead - 1));
  const teamId = ABBR_TO_ID[team];
  if (!teamId) return [];

  const schedUrl = `${BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${projEnd}&hydrate=team`;
  const schedRes = await fetch(schedUrl);
  if (!schedRes.ok) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schedJson: any = await schedRes.json();

  const gameDates: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const dateEntry of schedJson.dates ?? []) {
    // Count each game on this date (doubleheaders = 2 starters needed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const _game of dateEntry.games ?? []) {
      gameDates.push(dateEntry.date as string);
    }
  }

  // Project rotation: cycle through the 5 starters in order
  const rotationSize = rotation.length || 5;
  return gameDates.map((date, i): RotationSlot => {
    if (rotation.length === 0) return { date };
    const starter = rotation[i % rotationSize];
    return { date, projectedStarter: starter };
  });
}

// --- Core exports ---

/**
 * Find all pitchers with two starts in the given date range.
 * Uses confirmed probable pitchers from the MLB API, supplemented
 * by rotation projections for dates without confirmed starters.
 */
export async function getTwoStartPitchers(
  weekStart: string,
  weekEnd: string,
): Promise<TwoStartPitcher[]> {
  const appearances = await fetchScheduleWithProbables(weekStart, weekEnd);

  // Group appearances by pitcher mlbId
  const pitcherMap = new Map<
    number,
    { name: string; team: string; starts: Array<{ date: string; opponent: string }> }
  >();

  for (const a of appearances) {
    let entry = pitcherMap.get(a.mlbId);
    if (!entry) {
      entry = { name: a.name, team: a.team, starts: [] };
      pitcherMap.set(a.mlbId, entry);
    }
    // Avoid duplicate dates (e.g., same game appearing twice)
    if (!entry.starts.some((s) => s.date === a.date)) {
      entry.starts.push({ date: a.date, opponent: a.opponent });
    }
  }

  // Confirmed two-start pitchers: appear as probable on 2+ distinct dates
  const confirmed: TwoStartPitcher[] = [];
  const singleStart = new Map<
    number,
    { name: string; team: string; date: string; opponent: string }
  >();

  for (const [mlbId, entry] of pitcherMap) {
    if (entry.starts.length >= 2) {
      confirmed.push({
        mlbId,
        name: entry.name,
        team: entry.team,
        starts: entry.starts,
        confidence: "confirmed",
      });
    } else if (entry.starts.length === 1) {
      singleStart.set(mlbId, {
        name: entry.name,
        team: entry.team,
        date: entry.starts[0].date,
        opponent: entry.starts[0].opponent,
      });
    }
  }

  // For single-start pitchers: check if rotation projection gives them a second start
  const confirmedIds = new Set(confirmed.map((p) => p.mlbId));
  const teamProjections = new Map<string, RotationSlot[]>();

  for (const [mlbId, info] of singleStart) {
    if (confirmedIds.has(mlbId)) continue;

    // Get or fetch rotation projection for this team
    let projection = teamProjections.get(info.team);
    if (!projection) {
      projection = await getRotationProjection(info.team, weekStart, 7);
      teamProjections.set(info.team, projection);
    }

    // Count how many times this pitcher appears in the projection
    const projectedDates = uniqueSortedDates(
      projection
      .filter((s) => s.projectedStarter?.mlbId === mlbId && s.date !== info.date)
      .map((s) => s.date),
    ).slice(0, 1);

    if (projectedDates.length > 0) {
      // Determine confidence: "probable" if one start is confirmed + one projected,
      // Stays "probable" since one date is from the API
      const starts = limitStarts(
        [
          { date: info.date, opponent: info.opponent },
          ...projectedDates.map((d) => ({ date: d, opponent: "TBD" })),
        ],
        2,
      );
      confirmed.push({
        mlbId,
        name: info.name,
        team: info.team,
        starts,
        confidence: "probable",
      });
    }
  }

  // Also check rotation projections for pitchers with NO confirmed starts
  // who might get 2 projected starts in the week
  for (const [team, projection] of teamProjections) {
    // Group projected starters by mlbId
    const projCounts = new Map<number, Array<{ date: string; name: string }>>();
    for (const slot of projection) {
      if (!slot.projectedStarter) continue;
      const { mlbId, name } = slot.projectedStarter;
      if (confirmedIds.has(mlbId) || singleStart.has(mlbId)) continue;

      let arr = projCounts.get(mlbId);
      if (!arr) {
        arr = [];
        projCounts.set(mlbId, arr);
      }
      arr.push({ date: slot.date, name });
    }

    for (const [mlbId, dates] of projCounts) {
      if (dates.length >= 2) {
        confirmed.push({
          mlbId,
          name: dates[0].name,
          team,
          starts: limitStarts(
            dates.map((d) => ({ date: d.date, opponent: "TBD" })),
            2,
          ),
          confidence: "projected",
        });
      }
    }
  }

  return confirmed.sort((a, b) => {
    // Sort: confirmed first, then probable, then projected
    const order = { confirmed: 0, probable: 1, projected: 2 };
    return order[a.confidence] - order[b.confidence];
  });
}

/**
 * Build a two-start calendar for the next N weeks.
 * Week boundaries = Mon-Sun.
 */
export async function getTwoStartCalendar(weeksAhead: number): Promise<TwoStartWeek[]> {
  const startWeek = currentWeekNumber();
  const weeks: TwoStartWeek[] = [];

  for (let i = 0; i < weeksAhead; i++) {
    const week = startWeek + i;
    const start = weekStartDate(week);
    const end = weekEndDate(week);
    const twoStartPitchers = await getTwoStartPitchers(start, end);
    weeks.push({ week, startDate: start, endDate: end, twoStartPitchers });
  }

  return weeks;
}

/**
 * Quick check: does a specific pitcher have two starts in a given week?
 */
export async function isTwoStartWeek(
  mlbId: number,
  weekStart: string,
  weekEnd: string,
): Promise<boolean> {
  const pitchers = await getTwoStartPitchers(weekStart, weekEnd);
  return pitchers.some((p) => p.mlbId === mlbId);
}
