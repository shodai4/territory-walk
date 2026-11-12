/**
 * TERRITORY WALK - stats.js
 * Player Statistics, Local Persistence, Sync Buffer & Leaderboard Manager
 */

class StatsManager {
    constructor(supabaseManager, appInstance) {
        this.supabaseManager = supabaseManager;
        this.app = appInstance;

        this.userId = this.getOrCreateUserId();
        this.nickname = localStorage.getItem('tw_nickname') || '名もなき歩行者';
        
        this.stats = this.loadLocalStats();
        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;
        
        setInterval(() => {
            this.flushSyncBuffer();
        }, 60000);
    }

    getOrCreateUserId() {
        let uid = localStorage.getItem('tw_user_id');
        if (!uid) {
            uid = typeof crypto !== 'undefined' && crypto.randomUUID 
                ? crypto.randomUUID() 
                : 'user_' + Math.random().toString(36).substring(2, 15);
            localStorage.setItem('tw_user_id', uid);
        }
        return uid;
    }

    setNickname(name) {
        if (!name || typeof name !== 'string') return;
        this.nickname = name.trim().substring(0, 20) || '名もなき歩行者';
        localStorage.setItem('tw_nickname', this.nickname);
    }

    loadLocalStats() {
        const defaultStats = {
            lifetime_tiles: 0,
            lifetime_reclaimed: 0,
            battles_won: 0,
            battles_lost: 0
        };

        try {
            const raw = localStorage.getItem('tw_user_stats');
            return raw ? { ...defaultStats, ...JSON.parse(raw) } : defaultStats;
        } catch (e) {
            return defaultStats;
        }
    }

    saveLocalStats() {
        localStorage.setItem('tw_user_stats', JSON.stringify(this.stats));
    }

    recordTileClaimed(isReclaimed) {
        this.stats.lifetime_tiles += 1;
        if (isReclaimed) {
            this.stats.lifetime_reclaimed += 1;
        }
        this.saveLocalStats();

        this.pendingSyncTiles += 1;
        if (isReclaimed) {
            this.pendingSyncReclaimed += 1;
        }

        if (this.pendingSyncTiles >= 5) {
            this.flushSyncBuffer();
        }
    }

    async flushSyncBuffer() {
        if (this.pendingSyncTiles === 0) return;

        const tilesToSync = this.pendingSyncTiles;
        const reclaimedToSync = this.pendingSyncReclaimed;
        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;

        if (!this.supabaseManager || !this.supabaseManager.client) return;

        try {
            const weekId = this.supabaseManager.getCurrentWeekId();
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';

            await this.supabaseManager.client.from('territory_users').upsert({
                user_id: this.userId,
                nickname: this.nickname,
                team: myTeam,
                lifetime_tiles: this.stats.lifetime_tiles,
                lifetime_reclaimed: this.stats.lifetime_reclaimed,
                battles_won: this.stats.battles_won,
                battles_lost: this.stats.battles_lost,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

            const { data: existing } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('tiles_count, reclaimed_count')
                .eq('week_id', weekId)
                .eq('user_id', this.userId)
                .single();

            await this.supabaseManager.client.from('territory_weekly_rankings').upsert({
                week_id: weekId,
                user_id: this.userId,
                nickname: this.nickname,
                team: myTeam,
                tiles_count: (existing ? existing.tiles_count : 0) + tilesToSync,
                reclaimed_count: (existing ? existing.reclaimed_count : 0) + reclaimedToSync,
                updated_at: new Date().toISOString()
            }, { onConflict: 'week_id,user_id' });

        } catch (e) {
            console.warn('Sync failed:', e);
            this.pendingSyncTiles += tilesToSync;
            this.pendingSyncReclaimed += reclaimedToSync;
        }
    }

    async getWeeklyLeaderboard(weekId) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return [{ message: '現在オフラインです' }];
        }
        const { data } = await this.supabaseManager.client
            .from('territory_weekly_rankings')
            .select('nickname, tiles_count')
            .eq('week_id', weekId)
            .order('tiles_count', { ascending: false })
            .limit(10);
        return data || [];
    }

    async getLifetimeLeaderboard() {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return [{ message: '現在オフラインです' }];
        }
        const { data } = await this.supabaseManager.client
            .from('territory_users')
            .select('nickname, lifetime_tiles')
            .order('lifetime_tiles', { ascending: false })
            .limit(10);
        return data || [];
    }
}
