/**
 * TERRITORY WALK - stats.js (Part 1: Core, User, Storage)
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

        this.settleWeeklyBattle(
            this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
                ? this.supabaseManager.getCurrentWeekId()
                : '2026-W46'
        );
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
        this.syncUserProfileImmediate();
    }

    loadLocalStats() {
        const defaultStats = {
            lifetime_tiles: 0,
            lifetime_reclaimed: 0,
            battles_won: 0,
            battles_lost: 0,
            battle_history: [],
            weekly_tiles: 0,
            last_recorded_week: null
        };

        try {
            const raw = localStorage.getItem('tw_user_stats');
            if (raw) {
                const parsed = JSON.parse(raw);
                return { ...defaultStats, ...parsed };
            }
        } catch (e) {
            console.warn('Failed to parse local stats, using defaults:', e);
        }

        return defaultStats;
    }

    saveLocalStats() {
        try {
            localStorage.setItem('tw_user_stats', JSON.stringify(this.stats));
        } catch (e) {
    recordTileClaim(isReclaim, isDebugMode = false) {
        if (isDebugMode) return;

        const currentWeekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : '2026-W46';

        if (this.stats.last_recorded_week !== currentWeekId) {
            this.settleWeeklyBattle(currentWeekId);
            this.stats.weekly_tiles = 0;
            this.stats.last_recorded_week = currentWeekId;
        }

        this.stats.lifetime_tiles += 1;
        this.stats.weekly_tiles += 1;
        if (isReclaim) this.stats.lifetime_reclaimed += 1;

        this.saveLocalStats();

        this.pendingSyncTiles += 1;
        if (isReclaim) this.pendingSyncReclaimed += 1;

        if (this.pendingSyncTiles >= 5) this.flushSyncBuffer();
    }

    settleWeeklyBattle(currentWeekId) {
        if (!this.stats.last_recorded_week) {
            this.stats.last_recorded_week = currentWeekId;
            this.saveLocalStats();
            return;
        }

        if (this.stats.last_recorded_week !== currentWeekId) {
            const prevWeek = this.stats.last_recorded_week;
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';
            const result = this.stats.weekly_tiles > 0 ? 'PARTICIPATED' : 'INACTIVE';
            
            const historyEntry = {
                weekId: prevWeek,
                team: myTeam,
                result: result,
                tiles: this.stats.weekly_tiles,
                date: new Date().toISOString()
            };

            if (!Array.isArray(this.stats.battle_history)) this.stats.battle_history = [];

            this.stats.battle_history.unshift(historyEntry);
            if (this.stats.battle_history.length > 10) this.stats.battle_history.pop();

    async flushSyncBuffer() {
        if (this.pendingSyncTiles === 0) return;
        const tilesToSync = this.pendingSyncTiles;
        const reclaimedToSync = this.pendingSyncReclaimed;
        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;

        if (!this.supabaseManager || !this.supabaseManager.client) return;

        try {
            const currentWeekId = this.supabaseManager.getCurrentWeekId();
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

            const { data: existingRanking } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('tiles_count, reclaimed_count')
                .eq('week_id', currentWeekId)
                .eq('user_id', this.userId)
                .single();

            const currentTilesCount = existingRanking ? existingRanking.tiles_count : 0;
            const currentReclaimedCount = existingRanking ? existingRanking.reclaimed_count : 0;

            await this.supabaseManager.client.from('territory_weekly_rankings').upsert({
                week_id: currentWeekId,
                user_id: this.userId,
                nickname: this.nickname,
                team: myTeam,
                tiles_count: currentTilesCount + tilesToSync,
                reclaimed_count: currentReclaimedCount + reclaimedToSync,
                updated_at: new Date().toISOString()
            }, { onConflict: 'week_id,user_id' });
        } catch (e) {
            console.warn('Failed to sync stats buffer:', e);
            this.pendingSyncTiles += tilesToSync;
            this.pendingSyncReclaimed += reclaimedToSync;
        }
    }

            this.stats.last_recorded_week = currentWeekId;
            this.stats.weekly_tiles = 0;
    async syncUserProfileImmediate() {
        if (!this.supabaseManager || !this.supabaseManager.client) return;
        try {
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
        } catch (e) {
            console.warn('Immediate profile sync failed:', e);
        }
    }

    async fetchWeeklyRanking(weekId, limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) return this.getMockRankingData('weekly', limit);
        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('*')
                .eq('week_id', weekId)
                .order('tiles_count', { ascending: false })
                .limit(limit);
            return (error || !data) ? this.getMockRankingData('weekly', limit) : data;
        } catch (e) { return this.getMockRankingData('weekly', limit); }
    }

    async fetchLifetimeRanking(limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) return this.getMockRankingData('lifetime', limit);
        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_users')
                .select('*')
                .order('lifetime_tiles', { ascending: false })
                .limit(limit);
            return (error || !data) ? this.getMockRankingData('lifetime', limit) : data;
        } catch (e) { return this.getMockRankingData('lifetime', limit); }
    }

    async fetchReclaimRanking(limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) return this.getMockRankingData('reclaim', limit);
        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_users')
                .select('*')
                .order('lifetime_reclaimed', { ascending: false })
                .limit(limit);
            return (error || !data) ? this.getMockRankingData('reclaim', limit) : data;
        } catch (e) { return this.getMockRankingData('reclaim', limit); }
    }

    getMockRankingData(type, limit) {
        const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';
        const dummyUser = {
            user_id: this.userId,
            nickname: this.nickname,
            team: myTeam,
            tiles_count: this.stats.weekly_tiles || 12,
            lifetime_tiles: this.stats.lifetime_tiles || 45,
            lifetime_reclaimed: this.stats.lifetime_reclaimed || 8
        };
        const list = [dummyUser];
        for (let i = 2; i <= Math.min(limit, 5); i++) {
            list.push({
                user_id: `rival_${i}`,
                nickname: `歩行者_${i}`,
                team: i % 2 === 0 ? 'white' : 'black',
                tiles_count: Math.max(0, 50 - i * 7),
                lifetime_tiles: Math.max(0, 200 - i * 25),
                lifetime_reclaimed: Math.max(0, 30 - i * 4)
            });
        }
        if (type === 'weekly') list.sort((a, b) => b.tiles_count - a.tiles_count);
        else if (type === 'lifetime') list.sort((a, b) => b.lifetime_tiles - a.lifetime_tiles);
        else if (type === 'reclaim') list.sort((a, b) => b.lifetime_reclaimed - a.lifetime_reclaimed);
        return list.slice(0, limit);
    }

            this.saveLocalStats();
        }
    }

    recordTileClaim(isReclaim, isDebugMode = false) {
        if (isDebugMode) {
            return;
        }

        const currentWeekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : '2026-W46';

        if (this.stats.last_recorded_week !== currentWeekId) {
            this.settleWeeklyBattle(currentWeekId);
            this.stats.weekly_tiles = 0;
            this.stats.last_recorded_week = currentWeekId;
        }

        this.stats.lifetime_tiles += 1;
        this.stats.weekly_tiles += 1;
        if (isReclaim) {
            this.stats.lifetime_reclaimed += 1;
        }

        this.saveLocalStats();

        this.pendingSyncTiles += 1;
        if (isReclaim) {
            this.pendingSyncReclaimed += 1;
        }

        if (this.pendingSyncTiles >= 5) {
            this.flushSyncBuffer();
        }
    }

    settleWeeklyBattle(currentWeekId) {
        if (!this.stats.last_recorded_week) {
            this.stats.last_recorded_week = currentWeekId;
            this.saveLocalStats();
            return;
        }

        if (this.stats.last_recorded_week !== currentWeekId) {
            const prevWeek = this.stats.last_recorded_week;
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';
            const result = this.stats.weekly_tiles > 0 ? 'PARTICIPATED' : 'INACTIVE';
            
            const historyEntry = {
                weekId: prevWeek,
                team: myTeam,
                result: result,
                tiles: this.stats.weekly_tiles,
                date: new Date().toISOString()
            };

            if (!Array.isArray(this.stats.battle_history)) {
                this.stats.battle_history = [];
            }

            this.stats.battle_history.unshift(historyEntry);
            if (this.stats.battle_history.length > 10) {
                this.stats.battle_history.pop();
            }

            this.stats.last_recorded_week = currentWeekId;
            this.stats.weekly_tiles = 0;
            this.saveLocalStats();
        }
    }

            console.warn('Failed to save local stats:', e);
        }
    }

    async flushSyncBuffer() {
        if (this.pendingSyncTiles === 0) return;

        const tilesToSync = this.pendingSyncTiles;
        const reclaimedToSync = this.pendingSyncReclaimed;

        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;

        if (!this.supabaseManager || !this.supabaseManager.client) {
            return;
        }

        try {
            const currentWeekId = this.supabaseManager.getCurrentWeekId();
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';

            await this.supabaseManager.client
                .from('territory_users')
                .upsert({
                    user_id: this.userId,
                    nickname: this.nickname,
                    team: myTeam,
                    lifetime_tiles: this.stats.lifetime_tiles,
                    lifetime_reclaimed: this.stats.lifetime_reclaimed,
                    battles_won: this.stats.battles_won,
                    battles_lost: this.stats.battles_lost,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });

            const { data: existingRanking } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('tiles_count, reclaimed_count')
                .eq('week_id', currentWeekId)
                .eq('user_id', this.userId)
                .single();

            const currentTilesCount = existingRanking ? existingRanking.tiles_count : 0;
            const currentReclaimedCount = existingRanking ? existingRanking.reclaimed_count : 0;

            await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .upsert({
                    week_id: currentWeekId,
                    user_id: this.userId,
                    nickname: this.nickname,
                    team: myTeam,
                    tiles_count: currentTilesCount + tilesToSync,
                    reclaimed_count: currentReclaimedCount + reclaimedToSync,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'week_id,user_id' });

        } catch (e) {
            console.warn('Failed to sync stats buffer to Supabase:', e);
            this.pendingSyncTiles += tilesToSync;
            this.pendingSyncReclaimed += reclaimedToSync;
        }
    }

    async syncUserProfileImmediate() {
        if (!this.supabaseManager || !this.supabaseManager.client) return;
        try {
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';
            await this.supabaseManager.client
                .from('territory_users')
                .upsert({
                    user_id: this.userId,
                    nickname: this.nickname,
                    team: myTeam,
                    lifetime_tiles: this.stats.lifetime_tiles,
                    lifetime_reclaimed: this.stats.lifetime_reclaimed,
                    battles_won: this.stats.battles_won,
                    battles_lost: this.stats.battles_lost,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });
        } catch (e) {
            console.warn('Immediate profile sync failed:', e);
        }
    async fetchWeeklyRanking(weekId, limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return this.getMockRankingData('weekly', limit);
        }

        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('*')
                .eq('week_id', weekId)
                .order('tiles_count', { ascending: false })
                .limit(limit);

            if (error || !data) {
                return this.getMockRankingData('weekly', limit);
            }
            return data;
        } catch (e) {
            return this.getMockRankingData('weekly', limit);
        }
    }

    async fetchLifetimeRanking(limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return this.getMockRankingData('lifetime', limit);
        }

        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_users')
                .select('*')
                .order('lifetime_tiles', { ascending: false })
                .limit(limit);

            if (error || !data) {
                return this.getMockRankingData('lifetime', limit);
            }
            return data;
        } catch (e) {
            return this.getMockRankingData('lifetime', limit);
        }
    }

    async fetchReclaimRanking(limit = 10) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return this.getMockRankingData('reclaim', limit);
        }

        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_users')
                .select('*')
                .order('lifetime_reclaimed', { ascending: false })
                .limit(limit);

            if (error || !data) {
                return this.getMockRankingData('reclaim', limit);
            }
            return data;
        } catch (e) {
            return this.getMockRankingData('reclaim', limit);
        }
    }

    getMockRankingData(type, limit) {
        const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';
        const dummyUser = {
            user_id: this.userId,
            nickname: this.nickname,
            team: myTeam,
            tiles_count: this.stats.weekly_tiles || 12,
            lifetime_tiles: this.stats.lifetime_tiles || 45,
            lifetime_reclaimed: this.stats.lifetime_reclaimed || 8
        };

        const list = [dummyUser];
        for (let i = 2; i <= Math.min(limit, 5); i++) {
            list.push({
                user_id: `rival_${i}`,
                nickname: `歩行者_${i}`,
                team: i % 2 === 0 ? 'white' : 'black',
                tiles_count: Math.max(0, 50 - i * 7),
                lifetime_tiles: Math.max(0, 200 - i * 25),
                lifetime_reclaimed: Math.max(0, 30 - i * 4)
            });
        }

        if (type === 'weekly') {
            list.sort((a, b) => b.tiles_count - a.tiles_count);
        } else if (type === 'lifetime') {
            list.sort((a, b) => b.lifetime_tiles - a.lifetime_tiles);
        } else if (type === 'reclaim') {
            list.sort((a, b) => b.lifetime_reclaimed - a.lifetime_reclaimed);
        }

        return list.slice(0, limit);
    }

    }
