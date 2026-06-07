UPDATE player_ids
SET fangraphs_key = CAST(fangraphs_id AS TEXT)
WHERE fangraphs_id IS NOT NULL AND fangraphs_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_player_ids_fg_key ON player_ids(fangraphs_key);
