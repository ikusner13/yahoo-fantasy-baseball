-- Player ID mapping across sources (seeded from Chadwick Register)
CREATE TABLE IF NOT EXISTS player_ids (
  yahoo_id TEXT PRIMARY KEY,
  mlb_id INTEGER,
  fangraphs_id INTEGER,
  fangraphs_key TEXT,
  name TEXT NOT NULL,
  positions TEXT,
  team TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_ids_mlb ON player_ids(mlb_id);
CREATE INDEX IF NOT EXISTS idx_player_ids_fg ON player_ids(fangraphs_id);
CREATE INDEX IF NOT EXISTS idx_player_ids_fg_key ON player_ids(fangraphs_key);

-- Rest-of-season projections
CREATE TABLE IF NOT EXISTS projections (
  yahoo_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  player_type TEXT NOT NULL,
  pa INTEGER,
  r REAL,
  h REAL,
  hr REAL,
  rbi REAL,
  sb REAL,
  tb REAL,
  obp REAL,
  ip REAL,
  k REAL,
  era REAL,
  whip REAL,
  qs REAL,
  svhd REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (yahoo_id, season)
);

-- Decision audit log
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  reasoning TEXT,
  result TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);

-- Cached daily stats (Statcast, game logs, etc.)
CREATE TABLE IF NOT EXISTS daily_stats (
  yahoo_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (yahoo_id, date)
);

-- Generic API response cache (key-value with TTL)
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Weekly retrospectives
CREATE TABLE IF NOT EXISTS retrospectives (
  week INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User feedback for learning loop
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  week INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_week ON feedback(week);

CREATE TABLE IF NOT EXISTS gm_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reflection TEXT NOT NULL,
  runs_covered TEXT NOT NULL
);

-- Park factors (static-ish, refresh yearly)
CREATE TABLE IF NOT EXISTS park_factors (
  team TEXT PRIMARY KEY,
  park_name TEXT,
  runs_factor REAL DEFAULT 1.0,
  hr_factor REAL DEFAULT 1.0,
  updated_at TEXT
);
