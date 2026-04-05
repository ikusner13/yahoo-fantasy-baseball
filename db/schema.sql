-- Player ID mapping across sources (seeded from Chadwick Register)
CREATE TABLE IF NOT EXISTS player_ids (
  yahoo_id TEXT PRIMARY KEY,
  mlb_id INTEGER,
  fangraphs_id INTEGER,
  name TEXT NOT NULL,
  positions TEXT,  -- comma-separated: "C,1B,OF"
  team TEXT        -- MLB team abbreviation
);

CREATE INDEX IF NOT EXISTS idx_player_ids_mlb ON player_ids(mlb_id);
CREATE INDEX IF NOT EXISTS idx_player_ids_fg ON player_ids(fangraphs_id);

-- Rest-of-season projections (blended Steamer + ZiPS)
CREATE TABLE IF NOT EXISTS projections (
  yahoo_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  player_type TEXT NOT NULL,  -- 'batter' | 'pitcher'
  -- batter stats
  pa INTEGER, r REAL, h REAL, hr REAL, rbi REAL, sb REAL, tb REAL, obp REAL,
  -- pitcher stats
  ip REAL, k REAL, era REAL, whip REAL, qs REAL, svhd REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (yahoo_id, season)
);

-- Decision audit log
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,       -- 'lineup' | 'waiver' | 'stream' | 'trade' | 'il'
  action TEXT NOT NULL,     -- JSON: what was done
  reasoning TEXT,           -- LLM reasoning or stats summary
  result TEXT NOT NULL      -- 'success' | 'failed' | 'pending_approval'
);

CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(timestamp);

-- Cached daily stats (Statcast, game logs, etc.)
CREATE TABLE IF NOT EXISTS daily_stats (
  yahoo_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON blob of relevant stats
  PRIMARY KEY (yahoo_id, date)
);

-- Park factors (static-ish, refresh yearly)
CREATE TABLE IF NOT EXISTS park_factors (
  team TEXT PRIMARY KEY,
  park_name TEXT,
  runs_factor REAL DEFAULT 1.0,  -- >1 = hitter friendly
  hr_factor REAL DEFAULT 1.0,
  updated_at TEXT
);
