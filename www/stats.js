/**
 * TERRITORY WALK - stats.js
 * Player Statistics, Local Persistence, Sync Buffer & Leaderboard Manager
 */

class StatsManager {
    static parseFormattedName(raw) {
        if (!raw) return { name: '名もなき歩行者', title: '' };
        const match = String(raw).match(/^\[(.*?)\]\s*(.*)$/);
        if (match) {
            return { title: match[1], name: match[2] || '名もなき歩行者' };
        }
        return { title: '', name: String(raw) };
    }

    constructor(supabaseManager, appInstance) {
        this.supabaseManager = supabaseManager;
        this.app = appInstance;

        this.userId = this.getOrCreateUserId();
        this.nickname = localStorage.getItem('tw_nickname') || '名もなき歩行者';
        this.unlockedTitles = this.loadUnlockedTitles();
        this.activeTitle = localStorage.getItem('tw_active_title') || '';
        
        this.stats = this.loadLocalStats();
        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;

        this.checkMilestoneTitles();
        
        setInterval(() => {
            this.flushSyncBuffer();
        }, 60000);
    }

    loadUnlockedTitles() {
        try {
            const raw = localStorage.getItem('tw_unlocked_titles');
            return raw ? JSON.parse(raw) : ['初陣'];
        } catch (e) {
            return ['初陣'];
        }
    }

    checkDailyLoginBonus() {
        const today = new Date().toISOString().split('T')[0];
        const lastLogin = localStorage.getItem('tw_last_login');
        let streak = parseInt(localStorage.getItem('tw_login_streak') || '0', 10);

        if (lastLogin !== today) {
            const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            streak = (lastLogin === yesterday) ? (streak + 1) : 1;

            localStorage.setItem('tw_last_login', today);
            localStorage.setItem('tw_login_streak', streak.toString());

            if (streak >= 3) this.unlockTitle('日課の達人');
            if (streak >= 7) this.unlockTitle('継続の鬼');

            return { isNew: true, streak: streak };
        }
        return { isNew: false, streak: streak || 1 };
    }

    checkMilestoneTitles() {
        if (this.stats.lifetime_tiles >= 1) this.unlockTitle('初陣');
        if (this.stats.lifetime_reclaimed >= 1) this.unlockTitle('オセロスナイパー');
        if (this.stats.lifetime_tiles >= 10) this.unlockTitle('街の探索者');
        if (this.stats.lifetime_reclaimed >= 10) this.unlockTitle('奪還マスター');
        if (this.stats.lifetime_tiles >= 50) this.unlockTitle('東大阪の覇者');
        if (this.stats.lifetime_tiles >= 100) this.unlockTitle('ナスカの地上絵師');
    }

    unlockTitle(titleName) {
        if (!this.unlockedTitles.includes(titleName)) {
            this.unlockedTitles.push(titleName);
            localStorage.setItem('tw_unlocked_titles', JSON.stringify(this.unlockedTitles));
            if (!this.activeTitle) {
                this.setActiveTitle(titleName);
            }
            if (this.app && this.app.showToast) {
                this.app.showToast(`称号獲得: [${titleName}]`);
            }
        }
    }

    setActiveTitle(titleName) {
        this.activeTitle = titleName;
        localStorage.setItem('tw_active_title', titleName);
        this.syncUserProfileImmediate();
    }

    getFormattedDisplayName() {
        if (this.activeTitle) {
            return `[${this.activeTitle}] ${this.nickname}`;
        }
        return this.nickname;
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

    async setNickname(name) {
        if (!name || typeof name !== 'string') return;
        this.nickname = name.trim().substring(0, 20) || '名もなき歩行者';
        localStorage.setItem('tw_nickname', this.nickname);
        await this.syncUserProfileImmediate();
    }

    async syncUserProfileImmediate() {
        if (!this.supabaseManager || !this.supabaseManager.client) return;

        try {
            const weekId = this.supabaseManager.getCurrentWeekId();
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';

            // 1. Upsert territory_users
            const formattedName = this.getFormattedDisplayName();
            await this.supabaseManager.client.from('territory_users').upsert({
                user_id: this.userId,
                nickname: formattedName,
                team: myTeam,
                lifetime_tiles: this.stats.lifetime_tiles,
                lifetime_reclaimed: this.stats.lifetime_reclaimed,
                battles_won: this.stats.battles_won,
                battles_lost: this.stats.battles_lost,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });

            // 2. Update territory_weekly_rankings
            await this.supabaseManager.client.from('territory_weekly_rankings').update({
                nickname: formattedName,
                updated_at: new Date().toISOString()
            }).eq('week_id', weekId).eq('user_id', this.userId);

            console.log('[Stats] Nickname and stats synced to Supabase:', formattedName);
        } catch (e) {
            console.warn('[Stats] Failed to sync nickname immediately:', e);
        }
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
        this.checkMilestoneTitles();

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
            const displayName = this.getFormattedDisplayName();

            await this.supabaseManager.client.from('territory_users').upsert({
                user_id: this.userId,
                nickname: displayName,
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
                nickname: displayName,
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
            .select('user_id, nickname, tiles_count')
            .eq('week_id', weekId)
            .order('tiles_count', { ascending: false })
            .limit(10);
        return data || [];
    }

    async getLifetimeLeaderboard() {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return [{ message: '現在オフラインです' }];
        }
        try {
            const { data } = await this.supabaseManager.client
                .from('territory_users')
                .select('user_id, nickname, lifetime_tiles')
                .order('lifetime_tiles', { ascending: false })
                .limit(10);
            return data || [];
        } catch (e) {
            return [{ message: '現在オフラインです' }];
        }
    }

    async getLifetimeReclaimedLeaderboard() {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return [];
        }
        try {
            const { data } = await this.supabaseManager.client
                .from('territory_users')
                .select('user_id, nickname, lifetime_reclaimed')
                .order('lifetime_reclaimed', { ascending: false })
                .limit(10);
            return data || [];
        } catch (e) {
            console.warn('[Stats] Failed to get reclaim leaderboard:', e);
            return [];
        }
    }

    async getPreviousWeekResult(prevWeekId) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return null;
        }
        try {
            const { data } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('user_id, team, tiles_count')
                .eq('week_id', prevWeekId);

            let blackTotal = 0;
            let whiteTotal = 0;
            let myTiles = 0;
            let myTeam = this.app ? this.app.currentTeam : 'black';

            if (data && data.length > 0) {
                data.forEach(row => {
                    if (row.team === 'black') blackTotal += (row.tiles_count || 0);
                    if (row.team === 'white') whiteTotal += (row.tiles_count || 0);
                    if (row.user_id === this.userId) {
                        myTiles = row.tiles_count || 0;
                        if (row.team) myTeam = row.team;
                    }
                });
            }

            const total = blackTotal + whiteTotal;
            const blackPct = total > 0 ? Math.round((blackTotal / total) * 100) : 50;
            const whitePct = total > 0 ? 100 - blackPct : 50;

            let winnerTeam = 'draw';
            if (blackTotal > whiteTotal) winnerTeam = 'black';
            else if (whiteTotal > blackTotal) winnerTeam = 'white';

            let isWin = false;
            let isDraw = (winnerTeam === 'draw');
            if (winnerTeam === myTeam) isWin = true;

            return {
                weekId: prevWeekId,
                blackTotal,
                whiteTotal,
                blackPct,
                whitePct,
                winnerTeam,
                myTeam,
                myTiles,
                isWin,
                isDraw
            };
        } catch (e) {
            console.warn('[Stats] Failed to fetch prev week result:', e);
            return null;
        }
    }
}
