/**
 * TERRITORY WALK - supabase.js
 * Supabase Client & Territory Data Sync Module with Asia/Tokyo ISO Week Support
 */

const SUPABASE_URL = 'https://xxzmrdfroqeflfgszgls.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sPah3iPPh-CesDyG0hxG_A_ZMu2VTkb';

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
    async claimTile(tileId, latIdx, lngIdx, team, weekId = this.getCurrentWeekId()) {        if (!this.client) {
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
     * 単一タイル送信の互換エントリポイント（app.js から従来どおり呼ばれる）。
     */
    async upsertTile(meshId, latIdx, lngIdx, team, weekId = this.getCurrentWeekId()) {
        if (!this.client) {
            return { success: false, mode: 'offline' };
        }
        return this.claimTile(meshId, latIdx, lngIdx, team, weekId);
    }

    /**
     * 複数タイルの一括UPSERT（オフラインキューからまとめて再送する）。
     * 失敗時は success:false を返し、呼び出し側がキューを保持できるようにする。
     */
    async upsertTilesBatch(entries) {
        if (!this.client) {
            return { success: false, mode: 'offline' };
        }
        if (!Array.isArray(entries) || entries.length === 0) {
            return { success: true, count: 0 };
        }

        const now = new Date().toISOString();
        const rows = [];
        const seen = new Set();
        for (const e of entries) {
            if (!e || !e.meshId) continue;
            const weekId = e.weekId || this.getCurrentWeekId();
            const key = `${weekId}|${e.meshId}`;
            if (seen.has(key)) continue; // 同一UPSERT内の重複行はPostgresエラーになるため排除
            seen.add(key);
            rows.push({
                tile_id: e.meshId,
                week_id: weekId,
                team: e.team === 'white' ? 'white' : 'black',
                lat_idx: Number(e.latIdx),
                lng_idx: Number(e.lngIdx),
                updated_at: e.updatedAt || now
            });
        }
        if (rows.length === 0) return { success: true, count: 0 };

        try {
            const { data, error } = await this.client
                .from('territory_tiles')
                .upsert(rows, { onConflict: 'tile_id,week_id' });

            if (error) {
                console.error('[Supabase] Batch tile upsert error:', error);
                return { success: false, error: error };
            }
            return { success: true, count: rows.length, data: data };
        } catch (err) {
            console.error('[Supabase] Exception in upsertTilesBatch:', err);
            return { success: false, error: err };
        }
    }

    /**
     * 指定したマス（当週）をSupabaseから削除する（デバッグの全陣地リセット用）。
     * 削除できた行数を返す。RLS等で拒否された場合は success:false と error を返す。
     */
    async deleteTiles(tileIds, weekId = this.getCurrentWeekId()) {
        if (!this.client) {
            return { success: false, mode: 'offline', deleted: 0 };
        }
        const ids = Array.from(new Set((Array.isArray(tileIds) ? tileIds : []).filter(Boolean)));
        if (ids.length === 0) {
            return { success: true, deleted: 0 };
        }

        const CHUNK_SIZE = 100;
        let deleted = 0;
        try {
            for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
                const chunk = ids.slice(i, i + CHUNK_SIZE);
                const { data, error } = await this.client
                    .from('territory_tiles')
                    .delete()
                    .eq('week_id', weekId)
                    .in('tile_id', chunk)
                    .select('tile_id');

                if (error) {
                    console.error('[Supabase] Delete tiles error:', error);
                    return { success: false, error: error, deleted: deleted };
                }
                deleted += Array.isArray(data) ? data.length : 0;
            }
            return { success: true, deleted: deleted };
        } catch (err) {
            console.error('[Supabase] Exception in deleteTiles:', err);
            return { success: false, error: err, deleted: deleted };
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

        // 広域すぎる範囲（ズームアウト時）はDB負荷を避けるため取得しない
        const MAX_INDEX_SPAN = 150; // 約150メッシュ四方（≒15km）まで
        const MAX_ROWS = 2000;
        if ((maxLatIdx - minLatIdx) > MAX_INDEX_SPAN || (maxLngIdx - minLngIdx) > MAX_INDEX_SPAN) {
            return [];
        }

        try {
            const { data, error } = await this.client
                .from('territory_tiles')
                .select('tile_id, week_id, team, lat_idx, lng_idx, updated_at')
                .eq('week_id', weekId)
                .gte('lat_idx', minLatIdx)
                .lte('lat_idx', maxLatIdx)
                .gte('lng_idx', minLngIdx)
                .lte('lng_idx', maxLngIdx)
                .limit(MAX_ROWS);

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

