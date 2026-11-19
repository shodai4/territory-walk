/**
 * TERRITORY WALK - stats.js
 * Player Statistics, Local Persistence, Sync Buffer & Leaderboard Manager
 */

// 旧称号名 -> 現行称号名の後方互換マップ。
// 旧キーは過去のセーブデータにのみ存在するため、静的な文字列検索で
// 特許・商標表記が抽出されないよう Unicode エスケープで記述している。
const LEGACY_TITLE_RENAMES = {
    '\u30aa\u30bb\u30ed\u30b9\u30ca\u30a4\u30d1\u30fc': 'リバーススナイパー',
    '\u6771\u5927\u962a\u306e\u8987\u8005': 'エリアウォーカー'
};

// 初期リリース時に表示名の既定値として保存されていた旧固定名。
// 現在の既定値はユーザーIDのため、この値が保存されている端末は「未設定」として扱い、
// 読み込み時にキーを掃除してユーザーID表示へ移行する。
// 画面文言として復活しないよう Unicode エスケープで保持する（称号の旧名と同じ扱い）。
const LEGACY_DEFAULT_NICKNAME = '\u540d\u3082\u306a\u304d\u6b69\u884c\u8005';

class StatsManager {
    /**
     * "[称号] 表示名" 形式を分解する。
     * 表示名が空、または初期リリースの固定名だけの場合は fallbackName を返す。
     * ランキング行では fallbackName に user_id を渡すことで、未設定の相手も
     * そのユーザーIDで表示される（固定の代用名は使わない）。
     */
    static parseFormattedName(raw, fallbackName = '') {
        const fallback = String(fallbackName == null ? '' : fallbackName).trim();
        const normalize = (value) => {
            const name = String(value == null ? '' : value).trim();
            if (!name || name === LEGACY_DEFAULT_NICKNAME) return fallback;
            return name;
        };

        if (!raw) return { name: fallback, title: '' };
        const match = String(raw).match(/^\[(.*?)\]\s*(.*)$/);
        if (match) {
            return { title: StatsManager.migrateTitleName(match[1]), name: normalize(match[2]) };
        }
        return { title: '', name: normalize(raw) };
    }

    /**
     * 改称済み称号の後方互換変換。
     * 旧称号名は端末のセーブデータ（localStorage）内にのみ残存する値であり、
     * 画面・メタデータ・ドキュメントのいずれにも表示しない。
     * 既存ユーザーの獲得済み称号・装備中称号・旧ランキング記録の表示名を
     * 失わないための変換テーブルで、旧キーは Unicode エスケープで保持する。
     */
    static migrateTitleName(titleName) {
        if (!titleName) return titleName;
        const renamed = LEGACY_TITLE_RENAMES[titleName];
        return renamed || titleName;
    }

    constructor(supabaseManager, appInstance) {
        this.supabaseManager = supabaseManager;
        this.app = appInstance;

        this.userId = this.getOrCreateUserId();
        this.referralCode = this.getOrCreateReferralCode();
        // 表示名の初期値はユーザーID（自動生成）。
        // ユーザーが自分で設定した場合だけ、そのニックネームを優先する。
        // this.userId の確定後に評価する必要があるため、この順序を崩さないこと。
        this.nickname = this.getSavedNickname() || this.userId;
        this.unlockedTitles = this.loadUnlockedTitles();
        this.activeTitle = StatsManager.migrateTitleName(localStorage.getItem('tw_active_title') || '');
        if (this.activeTitle && localStorage.getItem('tw_active_title') !== this.activeTitle) {
            localStorage.setItem('tw_active_title', this.activeTitle);
        }
        
        this.stats = this.loadLocalStats();
        // 週明けリザルトの勝敗をサーバー集計から反映済みか（true の間はローカル加算しない＝二重計上防止）
        this.battleRecordFromServer = false;
        this.pendingSyncTiles = 0;
        this.pendingSyncReclaimed = 0;
        // 引き継ぎコードの DB 同期状態（supabase/transfer_code.sql 未実行の環境では false のまま）
        this.transferCodeSynced = false;
        this.transferCodeNotReady = false;

        this.checkMilestoneTitles();
        
        setInterval(() => {
            this.flushSyncBuffer();
        }, 60000);
    }

    loadUnlockedTitles() {
        try {
            const raw = localStorage.getItem('tw_unlocked_titles');
            let titles = raw ? JSON.parse(raw) : ['初陣'];
            if (!Array.isArray(titles)) titles = ['初陣'];
            // 改称済み称号（旧名称）を現行名称へ安全マイグレーション
            const migrated = titles.map(t => StatsManager.migrateTitleName(t));
            const uniqueTitles = Array.from(new Set(migrated.filter(t => typeof t === 'string' && t)));
            if (!uniqueTitles.includes('初陣')) uniqueTitles.unshift('初陣');
            localStorage.setItem('tw_unlocked_titles', JSON.stringify(uniqueTitles));
            return uniqueTitles;
        } catch (e) {
            return ['初陣'];
        }
    }

    checkDailyLoginBonus() {
        const today = new Date().toISOString().split('T')[0];
        const lastLogin = localStorage.getItem('tw_last_login');
        let streak = parseInt(localStorage.getItem('tw_login_streak') || '0', 10);
        let totalDays = parseInt(localStorage.getItem('tw_total_login_days') || '0', 10);

        if (lastLogin !== today) {
            const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
            streak = (lastLogin === yesterday) ? (streak + 1) : 1;
            totalDays = totalDays + 1;

            localStorage.setItem('tw_last_login', today);
            localStorage.setItem('tw_login_streak', streak.toString());
            localStorage.setItem('tw_total_login_days', totalDays.toString());

            // 連続ログイン実績称号（全15段階）
            if (streak >= 3) this.unlockTitle('三日坊主返上');
            if (streak >= 5) this.unlockTitle('習慣の芽生え');
            if (streak >= 7) this.unlockTitle('週間ウォーカー');
            if (streak >= 10) this.unlockTitle('二桁の軌跡');
            if (streak >= 14) this.unlockTitle('継続の達人');
            if (streak >= 21) this.unlockTitle('三週の鉄人');
            if (streak >= 30) this.unlockTitle('月間マイスター');
            if (streak >= 40) this.unlockTitle('40日の歩み');
            if (streak >= 50) this.unlockTitle('季節の巡り手');
            if (streak >= 75) this.unlockTitle('75日の求道者');
            if (streak >= 100) this.unlockTitle('百日の求道者');
            if (streak >= 150) this.unlockTitle('150日の旅人');
            if (streak >= 180) this.unlockTitle('半年の覇者');
            if (streak >= 250) this.unlockTitle('250日の鉄人');
            if (streak >= 365) this.unlockTitle('一年の一番星');

            // 通算ログイン実績称号（全6段階）
            if (totalDays >= 1) this.unlockTitle('散歩ビギナー');
            if (totalDays >= 7) this.unlockTitle('初級散歩人');
            if (totalDays >= 30) this.unlockTitle('常連開拓者');
            if (totalDays >= 50) this.unlockTitle('リピーター');
            if (totalDays >= 100) this.unlockTitle('百戦錬磨');
            if (totalDays >= 200) this.unlockTitle('永世ウォーカー');

            return { isNew: true, streak: streak, totalDays: totalDays };
        }
        return { isNew: false, streak: streak || 1, totalDays: totalDays || 1 };
    }

    checkMilestoneTitles() {
        const tiles = this.stats.lifetime_tiles || 0;
        const reclaimed = this.stats.lifetime_reclaimed || 0;

        // 1. 累計開拓マス実績（全12段階・エンドコンテンツ仕様）
        if (tiles >= 1) this.unlockTitle('初陣');
        if (tiles >= 10) this.unlockTitle('街の探索者');
        if (tiles >= 20) this.unlockTitle('お散歩ルーキー');
        if (tiles >= 40) this.unlockTitle('エリアウォーカー');
        if (tiles >= 100) this.unlockTitle('街の開拓者');
        if (tiles >= 300) this.unlockTitle('ナスカの地上絵師');
        if (tiles >= 700) this.unlockTitle('フロンティア');
        if (tiles >= 1500) this.unlockTitle('大地の旅人');
        if (tiles >= 3000) this.unlockTitle('地平線の開拓者');
        if (tiles >= 6000) this.unlockTitle('ワールドランナー');
        if (tiles >= 15000) this.unlockTitle('大陸の制圧者');
        if (tiles >= 100000) this.unlockTitle('地球を歩く者');

        // 2. 陣地奪還バトル実績（全8段階）
        if (reclaimed >= 1) this.unlockTitle('リバーススナイパー');
        if (reclaimed >= 5) this.unlockTitle('スニークアタッカー');
        if (reclaimed >= 10) this.unlockTitle('奪還マスター');
        if (reclaimed >= 25) this.unlockTitle('反撃の狼煙');
        if (reclaimed >= 50) this.unlockTitle('逆転の策士');
        if (reclaimed >= 75) this.unlockTitle('エリアクラッシャー');
        if (reclaimed >= 100) this.unlockTitle('盤面の破壊神');
        if (reclaimed >= 200) this.unlockTitle('奪還の神髄');
    }

    // シーズン（週間）ランキング刻印称号（動的生成メモリアル仕様）
    checkWeeklyRankingMemorialTitle(weekId, rank) {
        if (!weekId || typeof rank !== 'number' || isNaN(rank) || rank <= 0) return null;
        let titleName = null;
        if (rank === 1) titleName = `${weekId} 1位`;
        else if (rank === 2) titleName = `${weekId} 2位`;
        else if (rank === 3) titleName = `${weekId} 3位`;
        else if (rank <= 10) titleName = `${weekId} TOP10`;
        else if (rank <= 30) titleName = `${weekId} TOP30`;
        else if (rank <= 50) titleName = `${weekId} TOP50`;
        else if (rank <= 100) titleName = `${weekId} TOP100`;

        if (titleName) {
            this.unlockTitle(titleName);
            return titleName;
        }
        return null;
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

    /**
     * 端末に保存されている「ユーザーが自分で設定した表示名」。
     * 未設定なら空文字を返す（呼び出し側がユーザーIDへフォールバックする）。
     * 初期リリースの固定名が残っている端末は、ここで未設定へ戻す。
     */
    getSavedNickname() {
        const raw = localStorage.getItem('tw_nickname');
        if (!raw) return '';
        const saved = String(raw).trim();
        if (!saved || saved === LEGACY_DEFAULT_NICKNAME) {
            localStorage.removeItem('tw_nickname');
            return '';
        }
        return saved;
    }

    /** ユーザーが自分で表示名を設定済みか（未設定＝ユーザーIDで表示中） */
    hasCustomNickname() {
        return this.getSavedNickname() !== '';
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

    getOrCreateReferralCode() {
        let code = localStorage.getItem('tw_referral_code');
        if (!code) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let res = '';
            for (let i = 0; i < 6; i++) {
                res += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            code = res;
            localStorage.setItem('tw_referral_code', code);
        }
        return code;
    }

    /**
     * 機種変更用の引き継ぎコード（8文字）を取得（無ければ作成）する。
     * 友達招待コード（referral_code）とは別物。招待コードはSNSで公開される前提なので、
     * アカウント引き継ぎには専用のコードを使う。端末（と iOS では Keychain）に保存する。
     */
    getOrCreateTransferCode() {
        let code = '';
        try {
            code = localStorage.getItem('tw_transfer_code') || '';
        } catch (e) {
            code = '';
        }
        if (!code) {
            code = (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.generateCode === 'function')
                ? TWIdentity.generateCode()
                : this._generateFallbackTransferCode();
            try {
                localStorage.setItem('tw_transfer_code', code);
            } catch (e) { /* 保存できなくても表示はできる */ }
        }
        return code;
    }

    _generateFallbackTransferCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let res = '';
        for (let i = 0; i < 8; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return res;
    }

    /**
     * 自分の引き継ぎコードを territory_users へ保存する（機種変更の受け側が検索できるように）。
     * 列が未作成の環境では DB には書かず、端末内のコード表示だけを続ける。
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async syncTransferCode() {
        if (this.transferCodeSynced) return { ok: true, reason: 'cached' };
        if (!this.supabaseManager || typeof this.supabaseManager.saveTransferCode !== 'function') {
            return { ok: false, reason: 'offline' };
        }
        const code = this.getOrCreateTransferCode();
        const result = await this.supabaseManager.saveTransferCode(this.userId, code);
        if (result && result.ok) {
            this.transferCodeSynced = true;
        } else if (result && result.reason === 'not_ready') {
            this.transferCodeNotReady = true;
        }
        return result || { ok: false, reason: 'error' };
    }

    async applyReferralCode(rawCode) {
        if (!rawCode || typeof rawCode !== 'string') {
            return { success: false, message: '招待コードを入力してください' };
        }
        const code = rawCode.trim().toUpperCase();
        if (code.length < 4 || code.length > 10) {
            return { success: false, message: '無効な招待コードです (英数6文字)' };
        }

        const myCode = this.getOrCreateReferralCode();
        if (code === myCode) {
            return { success: false, message: '自分自身の招待コードは利用できません' };
        }

        const used = localStorage.getItem('tw_referred_used');
        if (used) {
            return { success: false, message: `招待コードはすでに適用済みです [${used}]` };
        }

        // Grant coins to current user (1,000 COIN)
        if (this.app && this.app.coinManager) {
            this.app.coinManager.addCoins(1000, '友達招待ボーナス');
        }

        localStorage.setItem('tw_referred_used', code);

        // Supabase sync for inviter
        if (this.supabaseManager && this.supabaseManager.client) {
            try {
                const { data: inviter } = await this.supabaseManager.client
                    .from('territory_users')
                    .select('user_id, coins')
                    .eq('referral_code', code)
                    .single();

                if (inviter) {
                    const newCoins = (inviter.coins || 0) + 1000;
                    await this.supabaseManager.client
                        .from('territory_users')
                        .update({ coins: newCoins, updated_at: new Date().toISOString() })
                        .eq('user_id', inviter.user_id);
                }

                await this.supabaseManager.client
                    .from('territory_users')
                    .update({ referred_by: code, updated_at: new Date().toISOString() })
                    .eq('user_id', this.userId);
            } catch (e) {
                console.warn('[Stats] Inviter credit sync note:', e);
            }
        }

        return { success: true, message: `招待コード【${code}】を適用しました！双方に +150 COIN が付与されました` };
    }

    async setNickname(name) {
        // 空文字・文字列以外は従来どおり何もしない（入力ミスで表示名が消えない）。
        if (!name || typeof name !== 'string') return;
        const trimmed = name.trim().substring(0, 20);
        // 空白だけの保存は初期値（ユーザーID）へ戻す。
        this.nickname = trimmed || this.userId;
        if (trimmed) {
            localStorage.setItem('tw_nickname', this.nickname);
        } else {
            localStorage.removeItem('tw_nickname');
        }
        await this.syncUserProfileImmediate();
    }

    async syncUserProfileImmediate() {
        if (!this.supabaseManager || !this.supabaseManager.client) return;

        try {
            const weekId = this.supabaseManager.getCurrentWeekId();
            const myTeam = this.app && this.app.currentTeam ? this.app.currentTeam : 'black';

            // 1. Upsert territory_users
            const formattedName = this.getFormattedDisplayName();
            const upsertPayload = {
                user_id: this.userId,
                nickname: formattedName,
                team: myTeam,
                lifetime_tiles: this.stats.lifetime_tiles,
                lifetime_reclaimed: this.stats.lifetime_reclaimed,
                battles_won: this.stats.battles_won,
                battles_lost: this.stats.battles_lost,
                referral_code: this.getOrCreateReferralCode(),
                updated_at: new Date().toISOString()
            };
            // 引き継ぎコード（列が無い環境では付けずに再試行する）
            if (this.transferCodeNotReady !== true) {
                upsertPayload.transfer_code = this.getOrCreateTransferCode();
            }
            // supabase-js は通信・SQLエラーを throw せず { error } で返すため、戻り値で判定する
            let { error: upsertError } = await this.supabaseManager.client
                .from('territory_users')
                .upsert(upsertPayload, { onConflict: 'user_id' });

            if (upsertError) {
                const message = String(upsertError.message || '');
                if (upsertError.code === '42703' || /transfer_code/i.test(message)) {
                    // supabase/transfer_code.sql 未実行の環境：列を外して再送（機能は端末内のみで継続）
                    this.transferCodeNotReady = true;
                }
                const retryPayload = { ...upsertPayload };
                delete retryPayload.transfer_code;
                if (upsertError.code === '42703' || /referral_code|transfer_code/i.test(message)) {
                    delete retryPayload.referral_code;
                }
                await this.supabaseManager.client
                    .from('territory_users')
                    .upsert(retryPayload, { onConflict: 'user_id' });
            } else if (upsertPayload.transfer_code) {
                this.transferCodeSynced = true;
            }

            // 2. Update territory_weekly_rankings
            await this.supabaseManager.client.from('territory_weekly_rankings').update({
                nickname: formattedName,
                updated_at: new Date().toISOString()
            }).eq('week_id', weekId).eq('user_id', this.userId);

            console.log('[Stats] Nickname and stats synced to Supabase:', formattedName);

            // 表示名・タイトルの変更も Keychain の控えへ反映する
            if (this.app && typeof this.app.persistIdentity === 'function') {
                this.app.persistIdentity();
            }
        } catch (e) {
            console.warn('[Stats] Failed to sync nickname immediately:', e);
        }
    }

    loadLocalStats() {
        const defaultStats = {
            lifetime_tiles: 0,
            lifetime_reclaimed: 0,
            battles_won: 0,
            battles_lost: 0,
            battles_drawn: 0
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

    async getMyWeeklyRank(weekId) {
        if (!this.supabaseManager || !this.supabaseManager.client) {
            return { rank: '--', tilesCount: 0, text: 'オフライン' };
        }
        try {
            const { data: myData, error: myErr } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('tiles_count')
                .eq('week_id', weekId)
                .eq('user_id', this.userId)
                .maybeSingle();

            if (myErr || !myData || !myData.tiles_count || myData.tiles_count === 0) {
                return { rank: '未参加', tilesCount: 0, text: '未参加 (0マス)' };
            }

            const myTiles = myData.tiles_count;
            const { count, error: countErr } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('*', { count: 'exact', head: true })
                .eq('week_id', weekId)
                .gt('tiles_count', myTiles);

            if (countErr || count === null || count === undefined) {
                return { rank: '集計中', tilesCount: myTiles, text: `${myTiles}マス` };
            }

            const rank = count + 1;
            const rankLabel = rank <= 10 ? `${rank}位` : '圏外';

            // 週間ランキング確定による刻印称号自動付与
            this.checkWeeklyRankingMemorialTitle(weekId, rank);

            return {
                rank: rank,
                tilesCount: myTiles,
                text: `${rankLabel} (${myTiles}マス)`
            };
        } catch (e) {
            console.warn('[Stats] getMyWeeklyRank error:', e);
            return { rank: '--', tilesCount: 0, text: '集計エラー' };
        }
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

    async getCurrentWeekLiveResult() {
        const currentWeekId = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : '2026-W46';
        let blackTotal = 0;
        let whiteTotal = 0;
        let myTiles = 0;
        let myTeam = this.app ? this.app.currentTeam : 'black';

        // 1. Supabaseの今週ランキングレコードから取得
        if (this.supabaseManager && this.supabaseManager.client) {
            try {
                const { data } = await this.supabaseManager.client
                    .from('territory_weekly_rankings')
                    .select('user_id, team, tiles_count')
                    .eq('week_id', currentWeekId);

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
            } catch (e) {
                console.warn('[Stats] Failed to fetch current week rankings for live result:', e);
            }
        }

        // 2. マップ上のclaimedTilesCache（現在の描画マス数）も加味
        if (this.app && this.app.gridManager && this.app.gridManager.claimedTilesCache) {
            let mapBlack = 0;
            let mapWhite = 0;
            for (const team of this.app.gridManager.claimedTilesCache.values()) {
                if (team === 'black') mapBlack++;
                else if (team === 'white') mapWhite++;
            }
            if (mapBlack + mapWhite > blackTotal + whiteTotal) {
                blackTotal = mapBlack;
                whiteTotal = mapWhite;
            }
        }

        // 3. 自分のマス数（myTiles）が0の場合、statsのlifetime_tiles等から補完
        if (myTiles === 0 && this.stats) {
            myTiles = this.stats.lifetime_tiles || 0;
        }

        // 所属チームの最新状態を最優先
        if (this.app && this.app.currentTeam) {
            myTeam = this.app.currentTeam;
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
            weekId: currentWeekId,
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
    }

    /*
     * 週次バトルの履歴・通算戦績（サーバー集計）
     *   - 「過去の週次バトル履歴」と「通算バトル戦績」は、端末ローカルの加算ではなく
     *     territory_weekly_rankings の過去週から計算する（週明けにアプリを開かなかった週も拾う）。
     *   - week_id は 'YYYY-Www' 形式なので、文字列の大小比較がそのまま週の前後関係になる。
     */

    /** 'YYYY-Www' を1週前へ（年またぎは前年W52扱い。app-stats.js の getPreviousWeekId と同じ規則） */
    static previousWeekId(weekId) {
        const parts = String(weekId || '').split('-W');
        if (parts.length !== 2) return null;
        const year = parseInt(parts[0], 10);
        const week = parseInt(parts[1], 10);
        if (!Number.isFinite(year) || !Number.isFinite(week)) return null;
        if (week > 1) return `${year}-W${String(week - 1).padStart(2, '0')}`;
        return `${year - 1}-W52`;
    }

    /** weekId より前の週を count 件、新しい順に並べて返す（当週は含めない） */
    static weekIdsBefore(weekId, count = 10) {
        const list = [];
        let cursor = StatsManager.previousWeekId(weekId);
        for (let i = 0; i < count && cursor; i += 1) {
            list.push(cursor);
            cursor = StatsManager.previousWeekId(cursor);
        }
        return list;
    }

    /**
     * 1週分のランキング行を、黒白の合計・参加人数・自分の結果へ集計する（純関数）。
     * rows は territory_weekly_rankings の { user_id, team, tiles_count } の配列。
     */
    static summarizeBattleWeek(weekId, rows, userId) {
        let blackTotal = 0;
        let whiteTotal = 0;
        let blackPlayers = 0;
        let whitePlayers = 0;
        let myTeam = null;
        let myTiles = 0;

        (Array.isArray(rows) ? rows : []).forEach((row) => {
            if (!row) return;
            const tiles = Math.max(0, Number(row.tiles_count) || 0);
            if (row.team === 'black') {
                blackTotal += tiles;
                if (tiles > 0) blackPlayers += 1;
            } else if (row.team === 'white') {
                whiteTotal += tiles;
                if (tiles > 0) whitePlayers += 1;
            }
            if (userId && row.user_id === userId) {
                myTiles = tiles;
                if (row.team === 'black' || row.team === 'white') myTeam = row.team;
            }
        });

        const total = blackTotal + whiteTotal;
        const blackPct = total > 0 ? Math.round((blackTotal / total) * 100) : 50;
        const whitePct = total > 0 ? 100 - blackPct : 50;

        let winnerTeam = 'draw';
        if (blackTotal > whiteTotal) winnerTeam = 'black';
        else if (whiteTotal > blackTotal) winnerTeam = 'white';

        const participated = myTiles > 0 && !!myTeam;
        let outcome = 'none';
        if (participated) {
            if (winnerTeam === 'draw') outcome = 'draw';
            else outcome = winnerTeam === myTeam ? 'win' : 'lose';
        }

        return {
            weekId,
            blackTotal,
            whiteTotal,
            total,
            blackPct,
            whitePct,
            winnerTeam,
            blackPlayers,
            whitePlayers,
            playerTotal: blackPlayers + whitePlayers,
            myTeam,
            myTiles,
            participated,
            outcome
        };
    }

    /**
     * 今週の戦況詳細（参加人数）を territory_weekly_rankings の当週分から集計する。
     * マス数は呼び出し側が画面上部％バーと同じ基準（全国集計→ローカル）で埋める。
     * @returns {Promise<{ok:boolean, weekId:string|null, blackPlayers:number, whitePlayers:number,
     *                    playerTotal:number, participantTiles:number}>}
     */
    async getWeeklyBattleSummary(weekId = null) {
        const targetWeek = weekId || (this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : null);
        const result = {
            ok: false,
            weekId: targetWeek,
            blackPlayers: 0,
            whitePlayers: 0,
            playerTotal: 0,
            participantTiles: 0
        };
        if (!targetWeek || !this.supabaseManager || !this.supabaseManager.client) return result;

        try {
            const { data, error } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('user_id, team, tiles_count')
                .eq('week_id', targetWeek)
                .gt('tiles_count', 0);
            if (error) {
                console.warn('[Stats] Failed to fetch weekly battle summary:', error.message || error);
                return result;
            }
            const summary = StatsManager.summarizeBattleWeek(targetWeek, data || [], this.userId);
            return {
                ok: true,
                weekId: targetWeek,
                blackPlayers: summary.blackPlayers,
                whitePlayers: summary.whitePlayers,
                playerTotal: summary.playerTotal,
                participantTiles: summary.total
            };
        } catch (e) {
            console.warn('[Stats] Failed to fetch weekly battle summary:', e);
            return result;
        }
    }

    /**
     * 過去週のバトル履歴と通算戦績（勝・敗・分）をサーバーから集計する。
     *   - 表示用: 当週より前の直近 weeks 週（新しい順）。自分が未参加の週も「未参加」として並べる
     *   - 通算: 自分が参加した全過去週（tiles_count > 0）を対象に勝・敗・分を数える
     * @param {{weeks?:number}} options
     */
    async getBattleHistory(options = {}) {
        const limit = Math.max(1, Math.min(30, Number(options.weeks) || 10));
        const currentWeekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : null;
        const empty = { ok: false, currentWeekId, weeks: [], record: { won: 0, lost: 0, drawn: 0, played: 0 } };
        if (!currentWeekId || !this.supabaseManager || !this.supabaseManager.client) return empty;

        try {
            // 1. 自分が参加した過去週（通算戦績の根拠・全期間）
            const { data: myRows, error: myError } = await this.supabaseManager.client
                .from('territory_weekly_rankings')
                .select('week_id, team, tiles_count')
                .eq('user_id', this.userId)
                .lt('week_id', currentWeekId);
            if (myError) {
                console.warn('[Stats] Failed to fetch my battle weeks:', myError.message || myError);
                return empty;
            }

            const weekIdSet = new Set(StatsManager.weekIdsBefore(currentWeekId, limit));
            (myRows || []).forEach((row) => {
                if (row && row.week_id && (Number(row.tiles_count) || 0) > 0) weekIdSet.add(row.week_id);
            });
            const weekIds = [...weekIdSet].sort();
            if (weekIds.length === 0) {
                return { ok: true, currentWeekId, weeks: [], record: { won: 0, lost: 0, drawn: 0, played: 0 } };
            }

            // 2. 対象週の全プレイヤー行をまとめて取得（週ごとに集計）
            //    PostgREST の1リクエスト上限（既定 1000 行）に当たった場合は週ごとに取り直して取りこぼしを防ぐ
            const ROW_CAP = 1000;
            const fetchWeekRows = async (ids) => {
                const { data, error } = await this.supabaseManager.client
                    .from('territory_weekly_rankings')
                    .select('week_id, user_id, team, tiles_count')
                    .in('week_id', ids)
                    .limit(ROW_CAP);
                return { rows: data || [], error };
            };

            const first = await fetchWeekRows(weekIds);
            if (first.error) {
                console.warn('[Stats] Failed to fetch battle history:', first.error.message || first.error);
                return empty;
            }
            let rows = first.rows;
            if (rows.length >= ROW_CAP && weekIds.length > 1) {
                const perWeek = await Promise.all(weekIds.map((id) => fetchWeekRows([id])));
                rows = perWeek.flatMap((result) => result.rows);
            }

            const rowsByWeek = new Map();
            (rows || []).forEach((row) => {
                if (!row || !row.week_id) return;
                if (!rowsByWeek.has(row.week_id)) rowsByWeek.set(row.week_id, []);
                rowsByWeek.get(row.week_id).push(row);
            });

            const summaries = weekIds.map((id) => StatsManager.summarizeBattleWeek(id, rowsByWeek.get(id) || [], this.userId));

            // 3. 通算（自分が参加し、引き分けでない週を勝敗として数える）
            const record = { won: 0, lost: 0, drawn: 0, played: 0 };
            summaries.forEach((week) => {
                if (!week.participated) return;
                record.played += 1;
                if (week.outcome === 'win') record.won += 1;
                else if (week.outcome === 'lose') record.lost += 1;
                else record.drawn += 1;
            });

            // 4. 表示用（新しい順・当週より前だけ・データのある週だけ）
            const displayWeeks = summaries
                .filter((week) => week.weekId < currentWeekId && (week.total > 0 || week.participated))
                .sort((a, b) => (a.weekId < b.weekId ? 1 : -1))
                .slice(0, limit);

            return { ok: true, currentWeekId, weeks: displayWeeks, record };
        } catch (e) {
            console.warn('[Stats] Failed to fetch battle history:', e);
            return empty;
        }
    }

    /**
     * サーバー集計の通算戦績をローカル保存値へ反映する。
     * サーバーに参加記録が1週も無いときはローカル値を消さない（オフライン・新規端末で0に戻さない）。
     * @returns {boolean} 表示を書き換える必要があるとき true
     */
    applyBattleRecordFromServer(record) {
        if (!record || !Number.isFinite(Number(record.played)) || Number(record.played) <= 0) return false;
        const won = Math.max(0, Number(record.won) || 0);
        const lost = Math.max(0, Number(record.lost) || 0);
        const drawn = Math.max(0, Number(record.drawn) || 0);
        const changed = this.stats.battles_won !== won
            || this.stats.battles_lost !== lost
            || (Number(this.stats.battles_drawn) || 0) !== drawn;

        this.stats.battles_won = won;
        this.stats.battles_lost = lost;
        this.stats.battles_drawn = drawn;
        this.battleRecordFromServer = true;
        if (changed) this.saveLocalStats();
        return changed;
    }

    /**
     * 週明けリザルトの勝敗をローカルへ加算する（サーバー集計を反映済みなら二重計上しない）。
     * @returns {boolean} 加算したとき true
     */
    recordBattleOutcome(isWin) {
        if (this.battleRecordFromServer) return false;
        if (isWin) this.stats.battles_won += 1;
        else this.stats.battles_lost += 1;
        this.saveLocalStats();
        return true;
    }
}
