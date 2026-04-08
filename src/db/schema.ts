import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";

export const playerIds = sqliteTable(
  "player_ids",
  {
    yahooId: text("yahoo_id").primaryKey(),
    mlbId: integer("mlb_id"),
    fangraphsId: integer("fangraphs_id"),
    name: text("name").notNull(),
    positions: text("positions"),
    team: text("team"),
  },
  (t) => [index("idx_player_ids_mlb").on(t.mlbId), index("idx_player_ids_fg").on(t.fangraphsId)],
);

export const projections = sqliteTable(
  "projections",
  {
    yahooId: text("yahoo_id").notNull(),
    season: integer("season").notNull(),
    playerType: text("player_type").notNull(),
    // batter stats
    pa: integer("pa"),
    r: real("r"),
    h: real("h"),
    hr: real("hr"),
    rbi: real("rbi"),
    sb: real("sb"),
    tb: real("tb"),
    obp: real("obp"),
    // pitcher stats
    ip: real("ip"),
    k: real("k"),
    era: real("era"),
    whip: real("whip"),
    qs: real("qs"),
    svhd: real("svhd"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.yahooId, t.season] })],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    timestamp: text("timestamp").notNull().default("(datetime('now'))"),
    type: text("type").notNull(),
    action: text("action").notNull(),
    reasoning: text("reasoning"),
    result: text("result").notNull(),
  },
  (t) => [index("idx_decisions_type").on(t.type), index("idx_decisions_ts").on(t.timestamp)],
);

export const dailyStats = sqliteTable(
  "daily_stats",
  {
    yahooId: text("yahoo_id").notNull(),
    date: text("date").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.yahooId, t.date] })],
);

export const apiCache = sqliteTable("api_cache", {
  cacheKey: text("cache_key").primaryKey(),
  data: text("data").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const retrospectives = sqliteTable("retrospectives", {
  week: integer("week").primaryKey(),
  data: text("data").notNull(),
  createdAt: text("created_at").notNull().default("(datetime('now'))"),
});

export const feedback = sqliteTable(
  "feedback",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    timestamp: text("timestamp").notNull().default("(datetime('now'))"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    week: integer("week"),
  },
  (t) => [index("idx_feedback_week").on(t.week)],
);

export const gmReflections = sqliteTable("gm_reflections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull().default("(datetime('now'))"),
  reflection: text("reflection").notNull(),
  runsCovered: text("runs_covered").notNull(),
});

export const parkFactors = sqliteTable("park_factors", {
  team: text("team").primaryKey(),
  parkName: text("park_name"),
  runsFactor: real("runs_factor").default(1.0),
  hrFactor: real("hr_factor").default(1.0),
  updatedAt: text("updated_at"),
});
