/**
 * TERRITORY WALK - supabase.js
 * Supabase Client & Territory Data Sync Module with Asia/Tokyo ISO Week Support
 */

const SUPABASE_URL = 'https://xxzmrdfroqeflfgszgls.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sPah3iPPh-CesDyG0hxG_A_ZMu2VTkb';

/**
 * PostgREST の Content-Range ヘッダーから総件数だけを取り出す。
 *   例: "0-13/14" → 14  /  "100-199/12345" → 12345
 * 件数不明（末尾がワイルドカード）・ヘッダーが無い・壊れている場合は null
 * （呼び出し側はローカル集計へフォールバック）。
 */
function parseContentRangeTotal(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return null;
    const slash = headerValue.lastIndexOf('/');
    if (slash < 0) return null;
    const totalText = headerValue.slice(slash + 1).trim();
    if (!/^\d+$/.test(totalText)) return null;
    const total = Number(totalText);
    return Number.isFinite(total) ? total : null;
}

/**
 * 新規ユーザーを「人数の少ない方のチーム」へ配属するか決める（純粋関数）。
 *   ・黒が少ない → 'black' / 白が少ない → 'white'
 *   ・同数・集計失敗（null）・不正値 → null（呼び出し側が 50% ランダムへフォールバック）
 * @param {{black:number, white:number}|null} counts territory_users の人数
 * @returns {'black'|'white'|null}
 */
function chooseBalancedTeam(counts) {
    if (!counts || typeof counts !== 'object') return null;
    const black = Number(counts.black);
    const white = Number(counts.white);
    if (!Number.isFinite(black) || !Number.isFinite(white)) return null;
    if (black < 0 || white < 0) return null;
    if (black === white) return null;
    return black < white ? 'black' : 'white';
}

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
     * サーバー全体（territory_tiles）の指定チームのマス数を数える。
     * PostgREST の HEAD リクエスト + `Prefer: count=exact` で行を転送させず、
     * Content-Range ヘッダーの総件数だけを読む（DB側のSQL変更は不要）。
     * @param {'black'|'white'} team
     * @param {string|null} weekId 集計する週（null / '' なら全期間）
     * @returns {Promise<number|null>} 取得できなければ null
     */
    async fetchTeamTileCount(team, weekId = this.getCurrentWeekId()) {
        if (!this.client) return null;
        if (typeof fetch !== 'function') return null;
        if (team !== 'black' && team !== 'white') return null;

        const params = new URLSearchParams({ select: 'team', team: `eq.${team}` });
        if (weekId) params.set('week_id', `eq.${weekId}`);

        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/territory_tiles?${params.toString()}`, {
                method: 'HEAD',
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    Prefer: 'count=exact',
                    Accept: 'application/json'
                },
                cache: 'no-store'
            });
            if (!res || !res.ok) return null;
            const header = res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('content-range')
                : null;
            return parseContentRangeTotal(header);
        } catch (err) {
            console.warn('[Supabase] Failed to count tiles:', err && err.message ? err.message : err);
            return null;
        }
    }

    /**
     * 全国の黒・白マス数を並列で取得する。
     * オフライン・通信エラー・片方でも取れなかった場合は null（従来動作を壊さない）。
     * @returns {Promise<{black:number, white:number, weekId:string|null, fetchedAt:number}|null>}
     */
    async fetchGlobalTeamCounts(weekId = this.getCurrentWeekId()) {
        if (!this.client) return null;
        if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return null;

        try {
            const [black, white] = await Promise.all([
                this.fetchTeamTileCount('black', weekId),
                this.fetchTeamTileCount('white', weekId)
            ]);
            if (black === null || white === null) return null;
            return {
                black,
                white,
                weekId: weekId || null,
                fetchedAt: Date.now()
            };
        } catch (err) {
            console.warn('[Supabase] Failed to fetch global team counts:', err);
            return null;
        }
    }

    /**
     * territory_users の指定チームの人数を数える。
     * territory_tiles の集計と同じく HEAD + `Prefer: count=exact` で
     * Content-Range の総件数だけを読む（RLS は SELECT 公開なので RPC 不要）。
     * @param {'black'|'white'} team
     * @returns {Promise<number|null>} 取得できなければ null
     */
    async fetchUserTeamCount(team) {
        if (!this.client) return null;
        if (typeof fetch !== 'function') return null;
        if (team !== 'black' && team !== 'white') return null;

        const params = new URLSearchParams({ select: 'team', team: `eq.${team}` });

        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/territory_users?${params.toString()}`, {
                method: 'HEAD',
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    Prefer: 'count=exact',
                    Accept: 'application/json'
                },
                cache: 'no-store'
            });
            if (!res || !res.ok) return null;
            const header = res.headers && typeof res.headers.get === 'function'
                ? res.headers.get('content-range')
                : null;
            return parseContentRangeTotal(header);
        } catch (err) {
            console.warn('[Supabase] Failed to count users:', err && err.message ? err.message : err);
            return null;
        }
    }

    /**
     * 黒・白それぞれの登録人数を並列で取得する（チーム均等配属の判定材料）。
     * オフライン・通信エラー・片方でも取れなかった場合は null（従来の 50% ランダム）。
     * @returns {Promise<{black:number, white:number, fetchedAt:number}|null>}
     */
    async fetchUserTeamCounts() {
        if (!this.client) return null;
        if (typeof navigator !== 'undefined' && navigator && navigator.onLine === false) return null;

        try {
            const [black, white] = await Promise.all([
                this.fetchUserTeamCount('black'),
                this.fetchUserTeamCount('white')
            ]);
            if (black === null || white === null) return null;
            return { black, white, fetchedAt: Date.now() };
        } catch (err) {
            console.warn('[Supabase] Failed to fetch user team counts:', err);
            return null;
        }
    }

    /**
     * 引き継ぎコードから territory_users の1行を取得する。
     * @param {string} code 正規化済みの引き継ぎコード
     * @returns {Promise<{ok:boolean, reason?:string, user?:object, error?:object}>}
     *   reason: 'offline' | 'invalid' | 'not_ready'（列未作成）| 'not_found' | 'error'
     */
    async fetchUserByTransferCode(code) {
        if (!this.client) return { ok: false, reason: 'offline' };
        const normalized = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!normalized) return { ok: false, reason: 'invalid' };

        try {
            const { data, error } = await this.client
                .from('territory_users')
                .select('user_id, nickname, team, lifetime_tiles, lifetime_reclaimed, battles_won, battles_lost, coins, transfer_code')
                .eq('transfer_code', normalized)
                .limit(1);

            if (error) {
                const message = String(error.message || '');
                if (error.code === '42703' || /transfer_code/i.test(message)) {
                    // supabase/transfer_code.sql が未実行の環境
                    return { ok: false, reason: 'not_ready', error };
                }
                console.warn('[Supabase] fetchUserByTransferCode error:', message);
                return { ok: false, reason: 'error', error };
            }

            if (!Array.isArray(data) || data.length === 0) {
                return { ok: false, reason: 'not_found' };
            }
            return { ok: true, user: data[0] };
        } catch (err) {
            console.warn('[Supabase] Exception in fetchUserByTransferCode:', err);
            return { ok: false, reason: 'error', error: err };
        }
    }

    /**
     * 自分の引き継ぎコードを territory_users へ保存する。
     * 列が無い環境（SQL 未実行）では reason:'not_ready' を返すだけで、
     * 呼び出し側は端末内のコード表示を続けられる。
     * @param {string} userId
     * @param {string} code
     */
    async saveTransferCode(userId, code) {
        if (!this.client || !userId) return { ok: false, reason: 'offline' };
        const normalized = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!normalized) return { ok: false, reason: 'invalid' };

        try {
            const { data, error } = await this.client
                .from('territory_users')
                .update({ transfer_code: normalized, updated_at: new Date().toISOString() })
                .eq('user_id', userId)
                .select('user_id');

            if (error) {
                const message = String(error.message || '');
                if (error.code === '42703' || /transfer_code/i.test(message)) {
                    return { ok: false, reason: 'not_ready', error };
                }
                return { ok: false, reason: 'error', error };
            }

            // まだ territory_users に行が無い新規ユーザー（初回起動直後）は 0 件更新になる
            if (!Array.isArray(data) || data.length === 0) {
                return { ok: false, reason: 'no_row' };
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: 'error', error: err };
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SupabaseManager,
        parseContentRangeTotal,
        chooseBalancedTeam,
        SUPABASE_URL,
        SUPABASE_ANON_KEY
    };
}

