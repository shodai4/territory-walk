/**
 * TERRITORY WALK - app-stats.js
 * 戦績モーダル・ランキング（週間／通算）・週間リザルト
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppMap を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */

/** 「あとで」で閉じた表示名バナーの再表示を止める端末キー（未設定のまま人だけ保存する） */
const NICKNAME_BANNER_DISMISSED_KEY = 'tw_nickname_banner_dismissed';

class TerritoryWalkAppStats extends TerritoryWalkAppMap {
    initStatsModal() {
        const modal = document.getElementById('stats-modal');
        const openBtn = document.getElementById('btn-open-stats');
        const closeBtn = document.getElementById('btn-close-stats');
        const footerCloseBtn = document.getElementById('btn-stats-footer-close');

        if (openBtn) {
            openBtn.addEventListener('click', () => this.openStatsModal('my-stats'));
        }

        const closeModal = () => modal.classList.add('hidden');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (footerCloseBtn) footerCloseBtn.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('stats-modal', closeModal);

        // Close on backdrop overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Tab buttons
        const tabs = ['my-stats', 'weekly-rank', 'lifetime-rank'];
        tabs.forEach(tabKey => {
            const btn = document.getElementById(`tab-${tabKey}`);
            if (btn) {
                btn.addEventListener('click', () => this.switchStatsTab(tabKey));
            }
        });

        // Save Nickname (表示名) — バナー導線からの保存も同じ処理を使う
        const saveNickBtn = document.getElementById('btn-save-nickname');
        if (saveNickBtn) {
            saveNickBtn.addEventListener('click', () => this.saveNicknameFromInput());
        }

        // Title Select
        const titleSelect = document.getElementById('select-active-title');
        if (titleSelect) {
            titleSelect.addEventListener('change', (e) => {
                if (this.statsManager) {
                    this.statsManager.setActiveTitle(e.target.value);
                    this.showToast(e.target.value ? `称号を [${e.target.value}] にセットしました` : '称号を解除しました');
                    this.updateStatsDisplay();
                }
            });
        }

        // X Share Button in Stats Modal
        const btnStatsXShare = document.getElementById('btn-stats-x-share');
        if (btnStatsXShare) {
            btnStatsXShare.addEventListener('click', () => {
                if (this.coinManager) this.coinManager.shareToX();
            });
        }

        // Copy Referral in Stats Modal
        const btnStatsCopyRef = document.getElementById('btn-stats-copy-referral');
        if (btnStatsCopyRef) {
            btnStatsCopyRef.addEventListener('click', () => {
                if (this.coinManager) this.coinManager.copyReferralCode();
            });
        }

        // 今週の戦果をシェア（コイン付与なし・共有シート優先）
        const btnStatsShareWeekly = document.getElementById('btn-stats-share-weekly');
        if (btnStatsShareWeekly) {
            btnStatsShareWeekly.addEventListener('click', () => this.shareMyWeeklyResult());
        }

        // 未設定の人にだけ出す表示名バナー
        this.initNicknameBanner();
    }

    /**
     * 戦績モーダルを開く（タブ指定可）。ヘッダーの入口と表示名バナーで共通化する。
     */
    openStatsModal(tabKey = 'my-stats') {
        const modal = document.getElementById('stats-modal');
        if (!modal) return;
        if (this.menuModal) this.menuModal.classList.add('hidden');
        modal.classList.remove('hidden');
        this.updateStatsDisplay();
        this.switchStatsTab(tabKey);
        // シェアをタップした瞬間に通信待ちでタップ判定が切れないよう、開いたときに先読みしておく
        this.prefetchMyWeeklyRank();
    }

    /**
     * 今週の順位・マス数を先読みしてキャッシュする（シェアを通信待ちなしで開くため）。
     * 失敗しても何もしない（シェア側が改めて取得する）。
     */
    async prefetchMyWeeklyRank() {
        if (this.weeklyRankRequest) return this.weeklyRankRequest;
        const weekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : null;
        if (!this.statsManager || typeof this.statsManager.getMyWeeklyRank !== 'function') return null;

        this.weeklyRankRequest = (async () => {
            try {
                const mine = await this.statsManager.getMyWeeklyRank(weekId);
                if (mine) {
                    this.weeklyRankCache = {
                        weekId,
                        tilesCount: Math.max(0, Math.floor(Number(mine.tilesCount) || 0)),
                        rank: typeof mine.rank === 'number' ? mine.rank : null
                    };
                }
            } catch (e) { /* オフラインならキャッシュ無しのまま */ }
            this.weeklyRankRequest = null;
            return this.weeklyRankCache || null;
        })();
        return this.weeklyRankRequest;
    }

    /**
     * 表示名の保存（入力欄の保存ボタン／バナー導線で共通）。
     * 未入力のままなら何も変わらない（従来どおりユーザーID表示を維持）。
     */
    async saveNicknameFromInput() {
        const input = document.getElementById('input-nickname');
        const btn = document.getElementById('btn-save-nickname');
        if (!input || !this.statsManager) return;

        if (btn) {
            btn.disabled = true;
            btn.textContent = '保存中...';
        }
        await this.statsManager.setNickname(input.value);
        if (btn) {
            btn.textContent = '保存完了';
            setTimeout(() => {
                btn.textContent = '保存';
                btn.disabled = false;
            }, 1200);
        }
        this.showToast('表示名を更新しました');
        // 名前を付けたらバナーは役目を終える（再表示のキーは書かない）
        this.hideNicknameBanner();
        this.updateStatsDisplay();
    }

    /**
     * 表示名（ニックネーム）未設定者向けのバナー。
     * 未設定＝従来どおりユーザーID表示のままで、仮名は作らない。
     */
    initNicknameBanner() {
        const banner = document.getElementById('nickname-banner');
        if (!banner) return;

        const laterBtn = document.getElementById('btn-nickname-later');
        if (laterBtn) {
            laterBtn.addEventListener('click', () => this.hideNicknameBanner({ remember: true }));
        }

        const setupBtn = document.getElementById('btn-nickname-setup');
        if (setupBtn) {
            setupBtn.addEventListener('click', () => {
                this.hideNicknameBanner();
                this.openStatsModal('my-stats');
                const input = document.getElementById('input-nickname');
                if (input && typeof input.focus === 'function') {
                    try {
                        input.focus({ preventScroll: true });
                    } catch (e) {
                        input.focus();
                    }
                    if (typeof input.scrollIntoView === 'function') {
                        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            });
        }

        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function'
            && !this.nicknameBannerResizeBound) {
            this.nicknameBannerResizeBound = true;
            window.addEventListener('resize', () => this.layoutNicknameBanner());
        }

        this.refreshNicknameBanner();
    }

    /** 未設定かつ「あとで」を押していないときだけバナーを出す */
    refreshNicknameBanner() {
        const banner = document.getElementById('nickname-banner');
        if (!banner || !this.statsManager) return;

        let dismissed = null;
        try {
            dismissed = localStorage.getItem(NICKNAME_BANNER_DISMISSED_KEY);
        } catch (e) { /* 保存領域が読めないときは出さない判断をしない */ }

        const hasName = typeof this.statsManager.hasCustomNickname === 'function'
            ? this.statsManager.hasCustomNickname()
            : false;

        if (hasName || dismissed) {
            banner.classList.add('hidden');
            return;
        }

        banner.classList.remove('hidden');
        this.layoutNicknameBanner();
    }

    /** バナーを閉じる（remember=true なら次回以降も出さない） */
    hideNicknameBanner(options = {}) {
        const banner = document.getElementById('nickname-banner');
        if (banner) banner.classList.add('hidden');
        if (options && options.remember) {
            try {
                localStorage.setItem(NICKNAME_BANNER_DISMISSED_KEY, 'true');
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * バナーをヘッダー直下に置く（位置情報オフ／マーキング停止のバナーが出ていればその下）。
     * 位置は他バナーと同じくヘッダー実測で決める（セーフエリア・回転に追従）。
     */
    layoutNicknameBanner() {
        const banner = document.getElementById('nickname-banner');
        if (!banner || !banner.style) return null;
        if (banner.classList && banner.classList.contains('hidden')) return null;

        let top = 168;
        try {
            const header = typeof document.querySelector === 'function' ? document.querySelector('header') : null;
            if (header && typeof header.getBoundingClientRect === 'function') {
                const rect = header.getBoundingClientRect();
                if (rect && rect.height > 0) top = Math.round(rect.bottom + 8);
            }
            ['location-permission-banner', 'marking-paused-banner'].forEach((id) => {
                const other = document.getElementById(id);
                if (!other || !other.classList || other.classList.contains('hidden')) return;
                if (typeof other.getBoundingClientRect !== 'function') return;
                const rect = other.getBoundingClientRect();
                if (rect && rect.height > 0) top = Math.max(top, Math.round(rect.bottom + 8));
            });
        } catch (e) { /* fallback */ }

        banner.style.top = `${Math.max(top, 64)}px`;
        return banner.style.top;
    }

    /**
     * 「今週の戦果」を共有する。今週の塗りマスと順位は先読み済みの値を使い、
     * まだ無いときだけ取りに行く（取得できなくても「ここから参戦」の文言で共有できる）。
     * コインは付与しない。
     */
    async shareMyWeeklyResult() {
        if (typeof CoinManager === 'undefined') return 'failed';

        const weekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : null;

        let tiles = 0;
        let rank = null;
        const cache = this.weeklyRankCache;
        if (cache && cache.weekId === weekId) {
            tiles = cache.tilesCount;
            rank = cache.rank;
        } else if (this.statsManager && typeof this.statsManager.getMyWeeklyRank === 'function') {
            try {
                const mine = await this.statsManager.getMyWeeklyRank(weekId);
                if (mine) {
                    tiles = Math.max(0, Math.floor(Number(mine.tilesCount) || 0));
                    rank = typeof mine.rank === 'number' ? mine.rank : null;
                }
            } catch (e) { /* オフライン時は0マスの文言で共有する */ }
        }

        const text = CoinManager.buildMyWeeklyResultShareText({
            tiles,
            rank,
            myTeam: this.currentTeam || 'black'
        });
        const status = await CoinManager.shareText(text, 'テリトリーウォーク 今週の戦果');
        this.showShareResult(status, document.getElementById('btn-stats-share-weekly'));
        return status;
    }

    /**
     * シェアの結果を、モーダルを閉じても消えない形で伝える。
     * トーストはモーダル表示中キューに退避されて見えないので、共有ボタンの文言を
     * 一時的に差し替える（共有一覧が開いた共有シート自体はフィードバックになる）。
     */
    showShareResult(status, button) {
        if (status === 'copied') {
            this.flashButtonLabel(button, '文面をコピーしました');
        } else if (status === 'failed') {
            this.flashButtonLabel(button, '共有できませんでした');
        }
    }

    /** ボタンの表示文言を一時的に差し替えて元に戻す */
    flashButtonLabel(btn, message, ms = 1800) {
        if (!btn) return;
        const target = (typeof btn.querySelector === 'function' && btn.querySelector('span')) || btn;
        if (!target) return;
        if (!target.__twShareLabelSaved) {
            target.__twShareLabelSaved = target.textContent;
        }
        target.textContent = message;
        btn.disabled = true;
        setTimeout(() => {
            target.textContent = target.__twShareLabelSaved;
            delete target.__twShareLabelSaved;
            btn.disabled = false;
        }, ms);
    }

    async switchStatsTab(tabKey) {
        const tabs = ['my-stats', 'weekly-rank', 'lifetime-rank'];
        tabs.forEach(k => {
            const btn = document.getElementById(`tab-${k}`);
            const panel = document.getElementById(`panel-${k}`);
            if (btn) {
                if (k === tabKey) {
                    btn.className = 'tab-btn active flex-1 py-1.5 rounded-lg border-b-2 border-amber-500 font-medium text-center text-amber-400';
                } else {
                    btn.className = 'tab-btn flex-1 py-1.5 rounded-lg border-b-2 border-transparent font-medium text-center text-zinc-400 hover:text-white';
                }
            }
            if (panel) {
                if (k === tabKey) panel.classList.remove('hidden');
                else panel.classList.add('hidden');
            }
        });

        if (tabKey === 'weekly-rank') {
            await this.loadWeeklyRankings();
        } else if (tabKey === 'lifetime-rank') {
            await this.loadLifetimeRankings();
        }
    }

    updateStatsDisplay() {
        if (!this.statsManager) return;
        const stats = this.statsManager.stats;
        const nickInput = document.getElementById('input-nickname');
        if (nickInput) {
            // 入力欄には「ユーザーが自分で設定した名前」だけを出す。
            // 未設定のときは空欄にし、実際の表示（ユーザーID）はプレースホルダーで示す。
            const savedName = typeof this.statsManager.getSavedNickname === 'function'
                ? this.statsManager.getSavedNickname()
                : '';
            nickInput.value = savedName;
            nickInput.placeholder = '未設定時はユーザーIDで表示';
        }

        const titleSelect = document.getElementById('select-active-title');
        if (titleSelect && this.statsManager.unlockedTitles) {
            const currentTitle = this.statsManager.activeTitle || '';
            titleSelect.innerHTML = '<option value="">(称号なし)</option>' +
                this.statsManager.unlockedTitles.map(t => 
                    `<option value="${t}" ${t === currentTitle ? 'selected' : ''}>[${t}]</option>`
                ).join('');
        }

        const streakEl = document.getElementById('stat-login-streak');
        if (streakEl) {
            const streak = localStorage.getItem('tw_login_streak') || '1';
            streakEl.textContent = `${streak}日目`;
        }

        const totalLoginEl = document.getElementById('stat-total-login-days');
        if (totalLoginEl) {
            const totalDays = localStorage.getItem('tw_total_login_days') || '1';
            totalLoginEl.textContent = `${totalDays}日`;
        }

        const tileEl = document.getElementById('stat-lifetime-tiles');
        if (tileEl) tileEl.textContent = stats.lifetime_tiles.toLocaleString();

        const areaEl = document.getElementById('stat-lifetime-area');
        if (areaEl) {
            const areaM2 = stats.lifetime_tiles * 10000;
            areaEl.textContent = `${areaM2.toLocaleString()} m² (東京ドーム約 ${(areaM2 / 46755).toFixed(2)}個分)`;
        }

        const reclaimedEl = document.getElementById('stat-reclaimed-tiles');
        if (reclaimedEl) reclaimedEl.textContent = stats.lifetime_reclaimed.toLocaleString();

        this.renderBattleRecord();
        // 過去週の履歴と通算戦績はサーバー集計で補完する（20秒スロットル・戦績モーダルを開いた直後は即時）
        this.loadBattleHistory();

        const referralCodeDisplay = document.getElementById('stats-referral-code-display');
        if (referralCodeDisplay && this.statsManager) {
            referralCodeDisplay.textContent = this.statsManager.getOrCreateReferralCode();
        }

        this.updateStatsXShareButton();
    }

    updateStatsXShareButton() {
        const btn = document.getElementById('btn-stats-x-share');
        if (!btn || !this.coinManager) return;
        const canShare = this.coinManager.canShareToXToday();
        if (canShare) {
            btn.disabled = false;
            btn.className = 'w-full py-2 bg-zinc-100 hover:bg-white text-black font-bold font-mono text-xs rounded-lg shadow transition-all active:scale-95 flex items-center justify-center gap-1.5';
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5 text-black" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                <span>Xで現在の戦績をシェア (+30 COIN)</span>
            `;
        } else {
            btn.disabled = true;
            btn.className = 'w-full py-2 bg-zinc-800 text-zinc-500 font-bold font-mono text-xs rounded-lg cursor-not-allowed flex items-center justify-center gap-1.5';
            btn.innerHTML = `
                <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                <span>本日獲得済み (明日またシェアできます)</span>
            `;
        }
    }

    parseNicknameAndTitle(raw, fallbackName = '') {
        return typeof StatsManager !== 'undefined' && typeof StatsManager.parseFormattedName === 'function'
            ? StatsManager.parseFormattedName(raw, fallbackName)
            : { title: '', name: String(raw || fallbackName || '') };
    }

    async loadWeeklyRankings() {
        const listEl = document.getElementById('list-weekly-rank');
        const myRankEl = document.getElementById('my-weekly-rank');
        if (!listEl || !this.statsManager || !this.supabaseManager) return;

        if (myRankEl) {
            myRankEl.innerHTML = `
                <span class="text-zinc-400">あなたの順位:</span>
                <span id="my-weekly-rank-value" class="font-bold text-zinc-400 font-mono">集計中...</span>
            `;
        }

        listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
        const weekId = this.supabaseManager.getCurrentWeekId();
        const data = await this.statsManager.getWeeklyLeaderboard(weekId);

        // 自分の順位判定・DOM反映
        let myRankText = '未参加 (0マス)';
        let myRankColor = 'text-zinc-400';

        if (data && Array.isArray(data) && data.length > 0 && !data[0].message) {
            const myIdx = data.findIndex(item => item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname);
            if (myIdx !== -1) {
                const rank = myIdx + 1;
                const tiles = data[myIdx].tiles_count || 0;
                myRankText = `${rank}位 (${tiles}マス)`;
                myRankColor = 'text-amber-400';
            } else if (typeof this.statsManager.getMyWeeklyRank === 'function') {
                const myRankInfo = await this.statsManager.getMyWeeklyRank(weekId);
                if (myRankInfo) {
                    myRankText = myRankInfo.text || '未参加 (0マス)';
                    myRankColor = myRankInfo.tilesCount > 0 ? 'text-amber-400' : 'text-zinc-400';
                }
            }
        } else if (typeof this.statsManager.getMyWeeklyRank === 'function') {
            const myRankInfo = await this.statsManager.getMyWeeklyRank(weekId);
            if (myRankInfo) {
                myRankText = myRankInfo.text || '未参加 (0マス)';
                myRankColor = myRankInfo.tilesCount > 0 ? 'text-amber-400' : 'text-zinc-400';
            }
        }

        if (myRankEl) {
            myRankEl.innerHTML = `
                <span class="text-zinc-400">あなたの順位:</span>
                <span id="my-weekly-rank-value" class="font-bold font-mono ${myRankColor}">${myRankText}</span>
            `;
        }

        if (!data || data.length === 0 || data[0].message) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">今週の記録はまだありません</li>';
            return;
        }

        listEl.innerHTML = data.map((item, idx) => {
            const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
            const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
            return `
            <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                <div class="flex items-center gap-2 min-w-0 pr-2">
                    <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-amber-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                    <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                    ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                    ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                </div>
                <span class="font-mono text-zinc-300 font-bold shrink-0 text-right">${item.tiles_count || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
            </li>`;
        }).join('');
    }

    async loadLifetimeRankings() {
        const listEl = document.getElementById('list-lifetime-rank');
        const reclaimListEl = document.getElementById('list-reclaim-rank');
        if (!this.statsManager) return;

        if (listEl) {
            listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
            const data = await this.statsManager.getLifetimeLeaderboard();

            if (!data || data.length === 0 || data[0].message) {
                listEl.innerHTML = '<li class="text-zinc-500 text-center py-2">記録がありません</li>';
            } else {
                listEl.innerHTML = data.map((item, idx) => {
                    const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
                    const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
                    return `
                    <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                        <div class="flex items-center gap-2 min-w-0 pr-2">
                            <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-amber-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                            <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                            ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                            ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                        </div>
                        <span class="font-mono text-zinc-300 font-bold shrink-0 text-right">${item.lifetime_tiles || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
                    </li>`;
                }).join('');
            }
        }

        if (reclaimListEl) {
            reclaimListEl.innerHTML = '<li class="text-zinc-500 text-center py-2">読み込み中...</li>';
            const reclaimData = await this.statsManager.getLifetimeReclaimedLeaderboard();

            if (!reclaimData || reclaimData.length === 0) {
                reclaimListEl.innerHTML = '<li class="text-zinc-500 text-center py-2">記録がありません</li>';
            } else {
                reclaimListEl.innerHTML = reclaimData.map((item, idx) => {
                    const isMe = item.user_id === this.statsManager.userId || item.nickname === this.statsManager.nickname;
                    const parsed = this.parseNicknameAndTitle(item.nickname, item.user_id);
                    return `
                    <li class="flex items-center justify-between py-2 px-2.5 rounded-lg border-b border-zinc-800/80 ${isMe ? 'bg-amber-500/10 border-amber-500/30' : 'hover:bg-zinc-800/40'} text-xs">
                        <div class="flex items-center gap-2 min-w-0 pr-2">
                            <span class="font-bold font-mono text-xs ${idx < 3 ? 'text-emerald-400' : 'text-zinc-400'} shrink-0 w-4 text-right">${idx + 1}</span>
                            <span class="truncate font-medium text-zinc-200">${parsed.name}</span>
                            ${parsed.title ? `<span class="text-[9px] px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-amber-400 rounded shrink-0 font-mono font-normal">${parsed.title}</span>` : ''}
                            ${isMe ? '<span class="text-[9px] bg-amber-400 text-black px-1.5 py-0.5 rounded font-bold shrink-0 font-mono">YOU</span>' : ''}
                        </div>
                        <span class="font-mono text-emerald-400 font-bold shrink-0 text-right">${item.lifetime_reclaimed || 0} <span class="text-[10px] text-zinc-500 font-normal">マス</span></span>
                    </li>`;
                }).join('');
            }
        }
    }
}
