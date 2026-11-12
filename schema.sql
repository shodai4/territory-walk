-- ==========================================================
-- TERRITORY WALK - schema.sql
-- Supabase Table DDL & RLS Policies for Territory Tiles
-- ==========================================================

-- 1. Create territory_tiles table with composite primary key (tile_id, week_id)
CREATE TABLE IF NOT EXISTS territory_tiles (
    tile_id TEXT NOT NULL,
    week_id TEXT NOT NULL,
    team TEXT NOT NULL CHECK (team IN ('white', 'black')),
    lat_idx INTEGER NOT NULL,
    lng_idx INTEGER NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tile_id, week_id)
);

-- 2. Create performance indexes for bounds queries and week filtering
CREATE INDEX IF NOT EXISTS idx_territory_tiles_week_bounds 
ON territory_tiles (week_id, lat_idx, lng_idx);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE territory_tiles ENABLE ROW LEVEL SECURITY;

-- 4. Create RLS Policies allowing public read and upsert (insert/update)
DROP POLICY IF EXISTS "Public select territory tiles" ON territory_tiles;
CREATE POLICY "Public select territory tiles" 
ON territory_tiles 
FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Public upsert territory tiles" ON territory_tiles;
CREATE POLICY "Public upsert territory tiles" 
ON territory_tiles 
FOR ALL 
USING (true) 
WITH CHECK (true);
