/**
 * TERRITORY WALK - app-battle.js
 * 週次バトルの見える化（画面上部％バーのタップ＝今週の戦況詳細／過去週の履歴／通算戦績）
 * と、週明けの「先週の最終結果」モーダル（起動・フォアグラウンド復帰・週跨ぎで1回だけ）
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppStats を継承してメソッドを積み上げる。
 * データの集計そのものは stats.js（StatsManager）が持ち、ここは DOM の描画と操作だけを扱う。
 */
class TerritoryWalkAppBattle extends TerritoryWalkAppStats {
    /** 「通算バトル戦績（○勝 ○敗 ○分）」の表示だけを更新する */
    renderBattleRecord() {
        if (!this.statsManager) return;
        const stats = this.statsManager.stats || {};
        const battleEl = document.getElementById('stat-battles-record');
        if (!battleEl) return;
        const won = Number(stats.battles_won) || 0;
        const lost = Number(stats.battles_lost) || 0;
        const drawn = Number(stats.battles_drawn) || 0;
        battleEl.textContent = drawn > 0
            ? `${won}勝 ${lost}敗 ${drawn}分`
            : `${won}勝 ${lost}敗`;
    }

    /**
     * 過去週のバトル履歴（#container-battle-history）と通算戦績を読み込む。
     * サーバー実績が取れたときは stats.battles_won / battles_lost / battles_drawn へ同期する。
     */
    loadBattleHistory(options = {}) {
        const container = document.getElementById('container-battle-history');
        if (!this.statsManager || typeof this.statsManager.getBattleHistory !== 'function') {
            this.renderBattleHistory(null);
            return Promise.resolve(null);
        }

        const force = !!(options && options.force);
        const now = Date.now();
        if (!force && this.battleHistoryLastLoadAt && (now - this.battleHistoryLastLoadAt) < 20000) {
            return Promise.resolve(this.battleHistoryCache || null);
        }
        if (this.battleHistoryRequest) return this.battleHistoryRequest;

        if (container) {
            container.innerHTML = '<div class="text-zinc-500 text-[10px] text-center py-2">読み込み中...</div>';
        }

        this.battleHistoryRequest = this.statsManager.getBattleHistory({ weeks: 10 })
            .then((history) => {
                this.battleHistoryLastLoadAt = Date.now();
                this.battleHistoryCache = history;
                if (history && history.ok && typeof this.statsManager.applyBattleRecordFromServer === 'function') {
                    this.statsManager.applyBattleRecordFromServer(history.record);
                }
                this.renderBattleHistory(history);
                this.renderBattleRecord();
                return history;
            })
            .catch(() => {
                this.renderBattleHistory(null);
                return null;
            })
            .finally(() => {
                this.battleHistoryRequest = null;
            });
        return this.battleHistoryRequest;
    }

    /** 過去週のバトル履歴をカード一覧で描画する（記録なしは案内文） */
    renderBattleHistory(history) {
        const el = document.getElementById('container-battle-history');
        if (!el) return;

        if (!history || !history.ok) {
            el.innerHTML = '<div class="text-zinc-500 text-[10px] text-center py-2">過去のバトル履歴を取得できませんでした</div>';
            return;
        }

        const weeks = Array.isArray(history.weeks) ? history.weeks : [];
        if (weeks.length === 0) {
            el.innerHTML = '<div class="text-zinc-500 text-[10px] text-center py-2">過去のバトル履歴はまだありません</div>';
            return;
        }

        const winnerLabel = (week) => {
            if (week.winnerTeam === 'black') return '<span class="text-zinc-100 font-bold">黒 勝利</span>';
            if (week.winnerTeam === 'white') return '<span class="text-zinc-100 font-bold">白 勝利</span>';
            return '<span class="text-zinc-400">引き分け</span>';
        };
        const myLabel = (week) => {
            if (!week.participated) return '<span class="text-zinc-600">未参加</span>';
            const team = week.myTeam === 'black' ? '黒' : '白';
            const tiles = Number(week.myTiles || 0).toLocaleString();
            if (week.outcome === 'win') return `<span class="text-emerald-400 font-bold">自分 ${team} ${tiles}マス・勝利</span>`;
            if (week.outcome === 'lose') return `<span class="text-zinc-400">自分 ${team} ${tiles}マス・敗北</span>`;
            return `<span class="text-zinc-400">自分 ${team} ${tiles}マス・引き分け</span>`;
        };

        el.innerHTML = weeks.map((week) => `
            <div class="bg-zinc-950/80 border border-zinc-800 rounded-lg px-2 py-1.5 font-mono">
                <div class="flex items-center justify-between gap-1.5 text-[10px]">
                    <span class="text-zinc-400">${week.weekId}</span>
                    ${winnerLabel(week)}
                    <span class="text-zinc-300">黒${week.blackPct}% / 白${week.whitePct}%</span>
                </div>
                <div class="flex items-center justify-between gap-1.5 text-[9px] mt-0.5">
                    <span class="text-zinc-500">黒 ${Number(week.blackTotal || 0).toLocaleString()} / 白 ${Number(week.whiteTotal || 0).toLocaleString()} マス</span>
                    ${myLabel(week)}
                </div>
            </div>`).join('');
    }

    /** 画面上部％バー（#battle-bar-container）のタップで「今週の戦況詳細」を開く */
    initWeeklyBattleDetail() {
        const bar = document.getElementById('battle-bar-container');
        if (bar && !this.weeklyBattleDetailBound) {
            this.weeklyBattleDetailBound = true;
            bar.addEventListener('click', () => this.openWeeklyBattleDetail());
            bar.addEventListener('keydown', (e) => {
                if (e && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    this.openWeeklyBattleDetail();
                }
            });
        }

        const modal = document.getElementById('weekly-battle-modal');
        const closeModal = () => {
            if (modal) modal.classList.add('hidden');
        };
        ['btn-close-weekly-battle', 'btn-battle-detail-footer-close'].forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.addEventListener('click', closeModal);
        });

        // 今の戦況をシェア（コイン付与なし・共有シート優先）
        const shareBtn = document.getElementById('btn-share-weekly-battle');
        if (shareBtn) shareBtn.addEventListener('click', () => this.shareWeeklyBattle());
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });
            this.setupSwipeUpToClose('weekly-battle-modal', closeModal);
        }
    }

    /** 「今週の戦況詳細」モーダルを開き、最新データを取り直して表示する */
    async openWeeklyBattleDetail() {
        const modal = document.getElementById('weekly-battle-modal');
        if (!modal) return;
        modal.classList.remove('hidden');

        // シェアをタップした瞬間に通信待ちでタップ判定が切れないよう、自分のマス数を先読みする
        if (typeof this.prefetchMyWeeklyRank === 'function') this.prefetchMyWeeklyRank();

        const loadingEl = document.getElementById('battle-detail-loading');
        const contentEl = document.getElementById('battle-detail-content');
        const emptyEl = document.getElementById('battle-detail-empty');
        const sourceEl = document.getElementById('battle-detail-source');
        const weekEl = document.getElementById('battle-detail-week');

        if (loadingEl) loadingEl.classList.remove('hidden');
        if (contentEl) contentEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (sourceEl) sourceEl.textContent = '';
        // 集計が描画されるまでは前回の数字で共有させない
        this.weeklyBattleDetailSummary = null;
        this.setWeeklyBattleShareVisible(false);

        const weekId = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : null;
        if (weekEl) weekEl.textContent = weekId || '----W--';

        // 上部％バーと同じ基準に揃える（全国集計を強制リフレッシュ）
        if (typeof this.refreshGlobalTeamCounts === 'function') {
            try {
                await this.refreshGlobalTeamCounts({ force: true });
            } catch (e) { /* 通信できなくてもローカル集計で表示する */ }
        }
        // 今週の実参加者（territory_weekly_rankings）と、チームに振り分けられた登録人数
        // （territory_users の黒・白の総人数）を同時に取りに行く。週明け直後は実参加者が
        // 0 人でも、登録人数は前の週から変わらないので戦況の規模が伝わる。
        const summaryRequest = this.statsManager && typeof this.statsManager.getWeeklyBattleSummary === 'function'
            ? Promise.resolve()
                .then(() => this.statsManager.getWeeklyBattleSummary(weekId))
                .catch(() => null)
            : Promise.resolve(null);
        const teamCountsRequest = this.supabaseManager && typeof this.supabaseManager.fetchUserTeamCounts === 'function'
            ? Promise.resolve()
                .then(() => this.supabaseManager.fetchUserTeamCounts())
                .catch(() => null)
            : Promise.resolve(null);
        const [summary, teamCounts] = await Promise.all([summaryRequest, teamCountsRequest]);

        this.renderWeeklyBattleDetail(summary, teamCounts);
    }

    /**
     * 集計結果を「今週の戦況詳細」モーダルへ描画する（オフライン時はローカル集計へフォールバック）。
     * @param {object|null} summary getWeeklyBattleSummary の結果（今週の実参加者・参加者マス合計）
     * @param {{black:number, white:number}|null} [teamCounts] fetchUserTeamCounts の結果（チーム配属人数）
     */
    renderWeeklyBattleDetail(summary, teamCounts = null) {
        const loadingEl = document.getElementById('battle-detail-loading');
        const contentEl = document.getElementById('battle-detail-content');
        const emptyEl = document.getElementById('battle-detail-empty');
        const sourceEl = document.getElementById('battle-detail-source');
        if (!contentEl) return;

        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(value);
        };

        const counts = typeof this.getScoreCounts === 'function'
            ? this.getScoreCounts()
            : { black: 0, white: 0, source: 'local' };
        const blackTiles = Number(counts.black) || 0;
        const whiteTiles = Number(counts.white) || 0;
        const totalTiles = blackTiles + whiteTiles;
        const blackPct = totalTiles > 0 ? Math.round((blackTiles / totalTiles) * 100) : 50;
        const whitePct = totalTiles > 0 ? 100 - blackPct : 50;

        const summaryOk = !!(summary && summary.ok);
        const playerTotal = summaryOk ? Number(summary.playerTotal) || 0 : 0;

        // チームに振り分けられた登録人数（territory_users）。取れなければ null ＝ 表示は「—」
        const toCount = (value) => {
            if (value == null) return null;
            const num = Number(value);
            return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : null;
        };
        const registeredBlack = teamCounts ? toCount(teamCounts.black) : null;
        const registeredWhite = teamCounts ? toCount(teamCounts.white) : null;
        const registeredOk = registeredBlack !== null && registeredWhite !== null;
        const registeredTotal = registeredOk ? registeredBlack + registeredWhite : 0;

        if (loadingEl) loadingEl.classList.add('hidden');

        // 共有ボタンは、この描画で出した数字（summary・マス数）を使い回す
        this.weeklyBattleDetailSummary = summaryOk ? summary : null;

        // 今週まだ誰も塗っておらず、登録人数も取れていない週だけ案内文へ
        // （週明け直後でも、振り分けられた登録人数が分かるなら戦況の規模は見せる）
        if (summaryOk && totalTiles === 0 && playerTotal === 0 && !registeredOk) {
            contentEl.classList.add('hidden');
            if (emptyEl) emptyEl.classList.remove('hidden');
            // この週は共有する数字が無い（前回の値を共有させない）
            this.weeklyBattleDetailSummary = null;
            this.setWeeklyBattleShareVisible(false);
            return;
        }

        if (emptyEl) emptyEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
        this.setWeeklyBattleShareVisible(true);

        // チームの登録人数（territory_users の配属人数。取得できないときは「—」）
        setText('battle-detail-players-total', registeredOk ? registeredTotal.toLocaleString() : '—');
        setText('battle-detail-players-black', registeredOk ? registeredBlack.toLocaleString() : '—');
        setText('battle-detail-players-white', registeredOk ? registeredWhite.toLocaleString() : '—');
        const playersNoteEl = document.getElementById('battle-detail-players-note');
        if (playersNoteEl) {
            playersNoteEl.textContent = registeredOk
                ? '黒・白に振り分けられた登録メンバーの人数です'
                : 'チームの登録人数を取得できませんでした';
        }

        // マス数（上部％バーと同じ基準）
        setText('battle-detail-tiles-total', totalTiles.toLocaleString());
        setText('battle-detail-tiles-black', blackTiles.toLocaleString());
        setText('battle-detail-tiles-white', whiteTiles.toLocaleString());

        // 現在の割合（％バーと同じ計算式）
        setText('battle-detail-pct-black', blackPct);
        setText('battle-detail-pct-white', whitePct);
        const barBlack = document.getElementById('battle-detail-bar-black');
        const barWhite = document.getElementById('battle-detail-bar-white');
        if (barBlack) barBlack.style.width = `${blackPct}%`;
        if (barWhite) barWhite.style.width = `${whitePct}%`;
        setText('battle-detail-formula', `黒 ${blackTiles.toLocaleString()}マス ÷ 合計 ${totalTiles.toLocaleString()}マス = ${blackPct}%`);

        // 取得元の注記（オフライン／集計中はローカル集計であることを明示）
        if (sourceEl) {
            if (!summaryOk && !registeredOk) {
                sourceEl.textContent = '最新の集計を取得できませんでした（オフライン）。マス数はこの端末が読み込んだ範囲の値です';
            } else if (!summaryOk) {
                sourceEl.textContent = '通信できないため、マス数はこの端末が読み込んだ範囲の値です（登録人数は黒・白の配属人数）';
            } else if (!registeredOk) {
                sourceEl.textContent = '登録人数を取得できませんでした。マス数は全国の週次塗り替えから集計しています';
            } else if (counts.source !== 'global') {
                sourceEl.textContent = '全国集計がまだ取得できていないため、マス数はこの端末が読み込んだ範囲の値です';
            } else {
                sourceEl.textContent = '登録人数は黒・白に振り分けられた総人数、マス数は全国の週次塗り替えから集計しています';
            }
        }
    }

    /** 「今の戦況をシェア」ボタンの表示切り替え（数字が無いときは出さない） */
    setWeeklyBattleShareVisible(visible) {
        const btn = document.getElementById('btn-share-weekly-battle');
        if (!btn || !btn.classList) return;
        if (visible) btn.classList.remove('hidden');
        else btn.classList.add('hidden');
    }

    /**
     * 「今の戦況」を共有する。画面に出ている％・マス数（getScoreCounts）をそのまま使う。
     * 参戦人数はシェア文面に載せない（画面の人数欄だけに留める）。コインは付与しない。
     */
    async shareWeeklyBattle() {
        if (typeof CoinManager === 'undefined') return 'failed';

        const counts = typeof this.getScoreCounts === 'function'
            ? this.getScoreCounts()
            : { black: 0, white: 0 };
        const blackTiles = Number(counts.black) || 0;
        const whiteTiles = Number(counts.white) || 0;
        const totalTiles = blackTiles + whiteTiles;
        const blackPct = totalTiles > 0 ? Math.round((blackTiles / totalTiles) * 100) : 50;
        const whitePct = totalTiles > 0 ? 100 - blackPct : 50;

        const weekId = this.supabaseManager && typeof this.supabaseManager.getCurrentWeekId === 'function'
            ? this.supabaseManager.getCurrentWeekId()
            : null;

        // タップの直後に共有シートを開けるよう、自分のマス数は先読み済みの値を使う
        let myTiles = 0;
        const cache = this.weeklyRankCache;
        if (cache && cache.weekId === weekId) {
            myTiles = cache.tilesCount;
        } else if (this.statsManager && typeof this.statsManager.getMyWeeklyRank === 'function') {
            try {
                const mine = await this.statsManager.getMyWeeklyRank(weekId);
                myTiles = mine ? Math.max(0, Math.floor(Number(mine.tilesCount) || 0)) : 0;
            } catch (e) { /* オフライン時は0マスで共有 */ }
        }

        const text = CoinManager.buildWeeklyBattleShareText({
            blackPct,
            whitePct,
            blackTiles,
            whiteTiles,
            myTeam: this.currentTeam || 'black',
            myTiles
        });
        const status = await CoinManager.shareText(text, 'テリトリーウォーク 今週の戦況');
        this.showShareResult(status, document.getElementById('btn-share-weekly-battle'));
        return status;
    }

    initWeeklyResultModal() {
        const modal = document.getElementById('weekly-result-modal');
        const closeBtn = document.getElementById('btn-close-weekly-result');
        const closeIconBtn = document.getElementById('btn-close-weekly-result-icon');
        const shareBtn = document.getElementById('btn-share-weekly-result');
        const openFromMenuBtn = document.getElementById('btn-open-weekly-result');

        const closeModal = () => {
            if (!modal) return;
            modal.classList.add('hidden');
            const currentWeek = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : 'current';
            localStorage.setItem('tw_last_seen_week', currentWeek);
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (closeIconBtn) closeIconBtn.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('weekly-result-modal', closeModal);

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });
        }

        if (shareBtn) {
            shareBtn.addEventListener('click', () => {
                const res = this.lastResultData || {};
                const outcomeText = res.isWin ? '勝利陣営！' : (res.isDraw ? '引き分け！' : '敗北陣営...');
                const teamName = (res.myTeam || this.currentTeam || 'black').toUpperCase();
                const blackPct = res.blackPct || 50;
                const whitePct = res.whitePct || 50;
                const tiles = res.myTiles || 0;
                const inviteCode = (this.coinManager && this.coinManager.getInviteCode()) || '';

                // シェア文言（末尾のハッシュタグ #テリウォーク 等）は coins.js の共通定義に一本化
                const shareText = CoinManager.buildWeeklyResultShareText({
                    teamName,
                    outcomeText,
                    blackPct,
                    whitePct,
                    tiles,
                    inviteCode
                });
                // 誘導先は App Store だけ（ブラウザ版URLは共有文面に出さない）。定義は coins.js の1か所。
                const shareUrl = CoinManager.getAppStoreUrl();

                if (navigator.share) {
                    navigator.share({
                        title: 'TERRITORY WALK シーズン結果',
                        text: shareText,
                        url: shareUrl
                    }).catch(() => {
                        window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n' + shareUrl)}`, '_blank');
                    });
                } else {
                    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText + '\n' + shareUrl)}`, '_blank');
                }
            });
        }

        if (openFromMenuBtn) {
            openFromMenuBtn.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                this.showWeeklyResultModal(true);
            });
        }
    }

    /**
     * 週が変わった（月曜0時をまたいだ）ら、先週の最終結果モーダルを1回だけ出す。
     *   - 起動時だけでなく、フォアグラウンド復帰・週跨ぎのカウントダウン更新からも呼ばれる
     *     （バックグラウンドのまま月曜0時を過ぎても取りこぼさない）
     *   - tw_last_seen_week が未設定（引き継ぎ・再インストール・設定の入れ替え）でも、
     *     前週に対戦データがあれば出す
     *   - 同じ週で何度呼ばれてもモーダルは重ねない（shownWeek ガード＋表示中の確認）
     */
    async checkWeeklyResetResult() {
        if (!this.supabaseManager || !this.statsManager) return;
        const currentWeek = this.supabaseManager.getCurrentWeekId();
        if (!currentWeek) return;
        const lastSeen = localStorage.getItem('tw_last_seen_week');

        let targetWeek = null;
        if (!lastSeen) {
            // 初回インストールのルール説明の上に先週の結果を重ねない（2回目以降の起動だけ見る）
            const rulesSeen = this.startupGate && typeof this.startupGate.hasSeenRules === 'function'
                ? this.startupGate.hasSeenRules()
                : localStorage.getItem('territory_rules_seen_v1') != null;
            if (!rulesSeen) {
                localStorage.setItem('tw_last_seen_week', currentWeek);
                return;
            }

            const previousWeek = typeof this.getPreviousWeekId === 'function' ? this.getPreviousWeekId(currentWeek) : null;
            let previousResult = null;
            if (previousWeek && typeof this.statsManager.getPreviousWeekResult === 'function') {
                try {
                    previousResult = await this.statsManager.getPreviousWeekResult(previousWeek);
                } catch (e) {
                    previousResult = null;
                }
            }
            const previousTiles = previousResult
                ? (Number(previousResult.blackTotal) || 0) + (Number(previousResult.whiteTotal) || 0)
                : 0;
            if (!previousWeek || previousTiles === 0) {
                // 前週に誰の記録も無ければ出すものは無い
                localStorage.setItem('tw_last_seen_week', currentWeek);
                return;
            }
            targetWeek = previousWeek;
        } else if (lastSeen !== currentWeek) {
            // New week has arrived!
            targetWeek = lastSeen;
        } else {
            return;
        }

        // 同じ週の結果表は1回だけ（復帰のたびに重ねない）
        if (this.weeklyResultShownWeek === targetWeek) return;
        const modal = document.getElementById('weekly-result-modal');
        if (modal && modal.classList && !modal.classList.contains('hidden')) {
            this.weeklyResultShownWeek = targetWeek;
            return;
        }
        this.weeklyResultShownWeek = targetWeek;
        setTimeout(() => {
            this.showWeeklyResultModal(false, targetWeek);
        }, 1000);
    }

    async showWeeklyResultModal(isManual = false, targetWeek = null) {
        const modal = document.getElementById('weekly-result-modal');
        if (!modal) return;

        const currentWeek = this.supabaseManager ? this.supabaseManager.getCurrentWeekId() : '2026-W46';
        const weekToShow = targetWeek || (isManual ? currentWeek : this.getPreviousWeekId(currentWeek));

        document.getElementById('result-week-id').textContent = isManual ? `${currentWeek} (現在)` : weekToShow;
        document.getElementById('result-winner-banner').textContent = '集計中...';
        modal.classList.remove('hidden');

        let result = null;
        if (isManual) {
            // デバッグプレビュー時は現在のリアルタイム実データを動的に取得
            if (this.statsManager && this.statsManager.getCurrentWeekLiveResult) {
                result = await this.statsManager.getCurrentWeekLiveResult();
            }
            if (!result) {
                let bCount = 0;
                let wCount = 0;
                if (this.gridManager) {
                    for (const team of this.gridManager.claimedTilesCache.values()) {
                        if (team === 'black') bCount++;
                        else if (team === 'white') wCount++;
                    }
                }
                const tot = bCount + wCount;
                const bPct = tot > 0 ? Math.round((bCount / tot) * 100) : 50;
                const wPct = tot > 0 ? 100 - bPct : 50;
                const myT = this.currentTeam || 'black';
                let winT = 'draw';
                if (bCount > wCount) winT = 'black';
                else if (wCount > bCount) winT = 'white';

                result = {
                    weekId: currentWeek,
                    blackTotal: bCount,
                    whiteTotal: wCount,
                    blackPct: bPct,
                    whitePct: wPct,
                    winnerTeam: winT,
                    isDraw: (winT === 'draw'),
                    myTeam: myT,
                    myTiles: (this.statsManager && this.statsManager.stats) ? (this.statsManager.stats.lifetime_tiles || 0) : 0,
                    isWin: (winT === myT)
                };
            }
        } else {
            result = this.statsManager ? await this.statsManager.getPreviousWeekResult(weekToShow) : null;
        }

        const banner = document.getElementById('result-winner-banner');
        const outcome = document.getElementById('result-battle-outcome');
        const barBlack = document.getElementById('result-bar-black');
        const barWhite = document.getElementById('result-bar-white');

        if (!result) {
            banner.textContent = '記録なし';
            document.getElementById('result-winner-subtitle').textContent = `${weekToShow} の対戦データはありません`;
            document.getElementById('result-score-black').textContent = '-';
            document.getElementById('result-score-white').textContent = '-';
            const blackTiles = document.getElementById('result-black-tiles');
            const whiteTiles = document.getElementById('result-white-tiles');
            if (blackTiles) blackTiles.textContent = '-';
            if (whiteTiles) whiteTiles.textContent = '-';
            if (barBlack) barBlack.style.width = '50%';
            if (barWhite) barWhite.style.width = '50%';
            document.getElementById('result-my-team').textContent = this.currentTeam === 'black' ? 'Black' : 'White';
            document.getElementById('result-my-tiles').textContent = '0 マス';
            document.getElementById('result-battle-outcome').textContent = '対戦なし';
            return;
        }

        if (isManual) {
            document.getElementById('result-winner-subtitle').textContent = '今シーズン終了時のリアルタイム判定シミュレーション';
        } else {
            document.getElementById('result-winner-subtitle').textContent = '前週のシーズン対戦が決着しました';
        }

        if (result.winnerTeam === 'black') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">BLACK TEAM WIN</span>';
        } else if (result.winnerTeam === 'white') {
            banner.innerHTML = '<span class="text-zinc-100 font-bold">WHITE TEAM WIN</span>';
        } else {
            banner.innerHTML = '<span class="text-amber-400 font-bold">DRAW (引き分け)</span>';
        }

        document.getElementById('result-score-black').innerHTML = `<span class="text-white font-bold">${result.blackPct}%</span>`;
        document.getElementById('result-score-white').innerHTML = `<span class="text-white font-bold">${result.whitePct}%</span>`;

        // 獲得総マス数は勢力ゲージではなく下の詳細テーブルに表示（文字溢れ防止）
        const blackTiles = document.getElementById('result-black-tiles');
        const whiteTiles = document.getElementById('result-white-tiles');
        if (blackTiles) blackTiles.textContent = `${Number(result.blackTotal || 0).toLocaleString()} マス`;
        if (whiteTiles) whiteTiles.textContent = `${Number(result.whiteTotal || 0).toLocaleString()} マス`;

        // 対戦比率ゲージバーの更新（アニメーション伸縮）
        if (barBlack) barBlack.style.width = `${Math.max(5, Math.min(95, result.blackPct))}%`;
        if (barWhite) barWhite.style.width = `${Math.max(5, Math.min(95, result.whitePct))}%`;

        document.getElementById('result-my-team').textContent = result.myTeam === 'black' ? 'Black' : 'White';
        document.getElementById('result-my-tiles').textContent = `${result.myTiles.toLocaleString()} マス`;

        if (result.isDraw) {
            outcome.innerHTML = '<span class="text-zinc-400">引き分け</span>';
        } else if (result.isWin) {
            outcome.innerHTML = '<span class="text-amber-400 font-bold">VICTORY (勝利陣営)</span>';
            if (!isManual && this.statsManager) {
                // サーバー集計済みなら二重計上しない（recordBattleOutcome が判定する）
                if (typeof this.statsManager.recordBattleOutcome === 'function') {
                    this.statsManager.recordBattleOutcome(true);
                } else {
                    this.statsManager.stats.battles_won += 1;
                    this.statsManager.saveLocalStats();
                }
            }
        } else {
            outcome.innerHTML = '<span class="text-zinc-400">DEFEAT (敗北陣営)</span>';
            if (!isManual && this.statsManager) {
                if (typeof this.statsManager.recordBattleOutcome === 'function') {
                    this.statsManager.recordBattleOutcome(false);
                } else {
                    this.statsManager.stats.battles_lost += 1;
                    this.statsManager.saveLocalStats();
                }
            }
        }

        this.lastResultData = result;

        // 週明け直後はサーバーの確定記録で通算戦績を上書きする（開かなかった週の取りこぼしも埋める）
        if (!isManual) this.loadBattleHistory({ force: true });
    }

    getPreviousWeekId(currentWeekId) {
        // e.g., '2026-W46' -> '2026-W45'
        const parts = currentWeekId.split('-W');
        if (parts.length === 2) {
            const year = parseInt(parts[0], 10);
            const week = parseInt(parts[1], 10);
            if (week > 1) {
                return `${year}-W${String(week - 1).padStart(2, '0')}`;
            } else {
                return `${year - 1}-W52`;
            }
        }
        return currentWeekId;
    }
}
