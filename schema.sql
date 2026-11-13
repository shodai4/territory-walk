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


-- ==========================================================
-- RANKING FEATURE TABLES & POLICIES
-- ==========================================================

-- 1. User Profile & Lifetime Stats Table (territory_users)
CREATE TABLE IF NOT EXISTS territory_users (
    user_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL DEFAULT '名もなき歩行者',
    team TEXT NOT NULL CHECK (team IN ('white', 'black')),
    lifetime_tiles INTEGER NOT NULL DEFAULT 0,
    lifetime_reclaimed INTEGER NOT NULL DEFAULT 0,
    battles_won INTEGER NOT NULL DEFAULT 0,
    battles_lost INTEGER NOT NULL DEFAULT 0,
    coins INTEGER NOT NULL DEFAULT 100,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration for existing tables:
ALTER TABLE territory_users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 100;

-- 2. Weekly Rankings Table (territory_weekly_rankings)
CREATE TABLE IF NOT EXISTS territory_weekly_rankings (
    week_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    team TEXT NOT NULL CHECK (team IN ('white', 'black')),
    tiles_count INTEGER NOT NULL DEFAULT 0,
    reclaimed_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (week_id, user_id)
);

-- 3. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_weekly_rankings_sort 
ON territory_weekly_rankings (week_id, tiles_count DESC);

CREATE INDEX IF NOT EXISTS idx_users_lifetime_tiles 
ON territory_users (lifetime_tiles DESC);

CREATE INDEX IF NOT EXISTS idx_users_lifetime_reclaimed 
ON territory_users (lifetime_reclaimed DESC);

-- 4. Row Level Security (RLS) & Public Policies for Rankings & Users
ALTER TABLE territory_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE territory_weekly_rankings ENABLE ROW LEVEL SECURITY;

-- territory_users policies
DROP POLICY IF EXISTS "Public select territory_users" ON territory_users;
CREATE POLICY "Public select territory_users" 
ON territory_users 
FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Public upsert territory_users" ON territory_users;
CREATE POLICY "Public upsert territory_users" 
ON territory_users 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- territory_weekly_rankings policies
DROP POLICY IF EXISTS "Public select territory_weekly_rankings" ON territory_weekly_rankings;
CREATE POLICY "Public select territory_weekly_rankings" 
ON territory_weekly_rankings 
FOR SELECT 
USING (true);

DROP POLICY IF EXISTS "Public upsert territory_weekly_rankings" ON territory_weekly_rankings;
CREATE POLICY "Public upsert territory_weekly_rankings" 
ON territory_weekly_rankings 
FOR ALL 
USING (true) 
WITH CHECK (true);
