/**
 * TERRITORY WALK - supabase.js
 * Supabase Client & Territory Data Sync Module with Asia/Tokyo ISO Week Support
 */

const SUPABASE_URL = 'https://your-supabase-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-supabase-anon-key-here';

class SupabaseManager {
    constructor() {
        this.client = null;
        this.initClient();
    }

    initClient() {
        if (typeof window.supabase !== 'undefined' && SUPABASE_URL !== 'https://your-supabase-project.supabase.co') {
            try {
                this.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                console.log('Supabase client initialized successfully.');
            } catch (e) {
                console.warn('Failed to initialize Supabase client:', e);
            }
        } else {
            console.warn('Supabase CDN or credentials not configured. Running in offline/mock mode.');
        }
    }

    /**
     * Get current ISO week identifier based on Asia/Tokyo time (Monday reset)
     * e.g., "2026-W46"
     */
    getCurrentWeekId() {
        // Convert current time to Asia/Tokyo timezone
        const now = new Date();
        const jstString = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
        const jstDate = new Date(jstString);

        // Target Thursday in current week to calculate ISO week number
        const target = new Date(jstDate.valueOf());
        const dayNum = (jstDate.getDay() + 6) % 7; // Monday = 0, Sunday = 6
        target.setDate(target.getDate() - dayNum + 3);

        const firstThursday = new Date(target.getFullYear(), 0, 4);
        const firstThursdayDayNum = (firstThursday.getDay() + 6) % 7;
        firstThursday.setDate(firstThursday.getDate() - firstThursdayDayNum + 3);

        const weekNum = Math.round(((target - firstThursday) / 86400000 - 3) / 7) + 1;
        
        return `${target.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }

    /**
     * Claim or update a tile in Supabase (UPSERT)
     */
    async claimTile(tileId, latIdx, lngIdx, team, weekId = this.getCurrentWeekId()) {
        if (!this.client) {
            console.warn('[Mock] claimTile called offline:', { tileId, weekId, team, latIdx, lngIdx });
            return { success: false, mode: 'offline' };
        }

        try {
            const { data, error } = await this.client
                .from('territory_tiles')
                .upsert({
                    tile_id: tileId,
                    week_id: weekId,
                    team: team,
                    lat_idx: latIdx,
                    lng_idx: lngIdx,
                    updated_at: new Date().toISOString()
                }, {
                    onConflict: 'tile_id,week_id'
                });

            if (error) {
                console.error('Error claiming tile in Supabase:', error);
                return { success: false, error };
            }

            return { success: true, data };
        } catch (err) {
            console.error('Exception in claimTile:', err);
            return { success: false, error: err };
        }
    }

    /**
     * Fetch all tiles within bounds and current week from Supabase
     */
    async fetchTilesInBounds(minLat, maxLat, minLng, maxLng, weekId = this.getCurrentWeekId()) {
        if (!this.client) {
            return [];
        }

        const LAT_GRID = 0.0009;
        const LNG_GRID = LAT_GRID / Math.cos(35.0 * Math.PI / 180);
        const minLatIdx = Math.floor(minLat / LAT_GRID) - 1;
        const maxLatIdx = Math.floor(maxLat / LAT_GRID) + 1;
        const minLngIdx = Math.floor(minLng / LNG_GRID) - 2;
        const maxLngIdx = Math.floor(maxLng / LNG_GRID) + 2;

        try {
            const { data, error } = await this.client
                .from('territory_tiles')
                .select('*')
                .eq('week_id', weekId)
                .gte('lat_idx', minLatIdx)
                .lte('lat_idx', maxLatIdx)
                .gte('lng_idx', minLngIdx)
                .lte('lng_idx', maxLngIdx);

            if (error) {
                console.error('Error fetching tiles from Supabase:', error);
                return [];
            }

            return data || [];
        } catch (err) {
            console.error('Exception in fetchTilesInBounds:', err);
            return [];
        }
    }
}

