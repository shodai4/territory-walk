/**
 * TERRITORY WALK - app-battle.js
 * 週次バトルの見える化（画面上部％バーのタップ＝今週の戦況詳細／過去週の履歴／通算戦績）
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
        const noteEl = document.getElementById('battle-detail-extra-note');
        const sourceEl = document.getElementById('battle-detail-source');
        const weekEl = document.getElementById('battle-detail-week');

        if (loadingEl) loadingEl.classList.remove('hidden');
        if (contentEl) contentEl.classList.add('hidden');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (noteEl) noteEl.classList.add('hidden');
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
        let summary = null;
        if (this.statsManager && typeof this.statsManager.getWeeklyBattleSummary === 'function') {
            try {
                summary = await this.statsManager.getWeeklyBattleSummary(weekId);
            } catch (e) {
                summary = null;
            }
        }

        this.renderWeeklyBattleDetail(summary);
    }

    /** 集計結果を「今週の戦況詳細」モーダルへ描画する（オフライン時はローカル集計へフォールバック） */
    renderWeeklyBattleDetail(summary) {
        const loadingEl = document.getElementById('battle-detail-loading');
        const contentEl = document.getElementById('battle-detail-content');
        const emptyEl = document.getElementById('battle-detail-empty');
        const noteEl = document.getElementById('battle-detail-extra-note');
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
        const participantTiles = summaryOk ? Number(summary.participantTiles) || 0 : 0;

        if (loadingEl) loadingEl.classList.add('hidden');

        // 共有ボタンは、この描画で出した数字（summary・マス数）を使い回す
        this.weeklyBattleDetailSummary = summaryOk ? summary : null;

        // 今週まだ誰も塗っていない（＝対戦が始まっていない）週だけ案内文へ
        if (summaryOk && totalTiles === 0 && playerTotal === 0) {
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

        // 参加人数（サーバー集計が取れないときは「—」）
        setText('battle-detail-players-total', summaryOk ? playerTotal.toLocaleString() : '—');
        setText('battle-detail-players-black', summaryOk ? (Number(summary.blackPlayers) || 0).toLocaleString() : '—');
        setText('battle-detail-players-white', summaryOk ? (Number(summary.whitePlayers) || 0).toLocaleString() : '—');

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

        // AIウォーカー分の注記（参加者の合計マスより全国の塗りマスが多いとき）
        if (noteEl) {
            const aiNote = summaryOk && totalTiles > participantTiles;
            noteEl.classList.toggle('hidden', !aiNote);
        }

        // 取得元の注記（オフライン／集計中はローカル集計であることを明示）
        if (sourceEl) {
            if (!summaryOk) {
                sourceEl.textContent = '最新の集計を取得できませんでした（オフライン）。マス数はこの端末が読み込んだ範囲の値です';
            } else if (counts.source !== 'global') {
                sourceEl.textContent = '全国集計がまだ取得できていないため、マス数はこの端末が読み込んだ範囲の値です';
            } else {
                sourceEl.textContent = '全国のマス数（週の塗り替え）と、週間ランキングの実参加者から集計しています';
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
     * 「今の戦況」を共有する。画面に出ている％・マス数（getScoreCounts）と
     * 参加人数（描画済み summary）をそのまま使う。コインは付与しない。
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

        const summary = this.weeklyBattleDetailSummary || null;
        const totalPlayers = summary && summary.ok ? Number(summary.playerTotal) || 0 : 0;

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
            totalPlayers,
            myTeam: this.currentTeam || 'black',
            myTiles
        });
        const status = await CoinManager.shareText(text, 'テリトリーウォーク 今週の戦況');
        if (typeof this.showToast === 'function') {
            if (status === 'copied') this.showToast('シェア用の文面をコピーしました（Xに貼り付けて投稿できます）');
            else if (status === 'shared' || status === 'opened') this.showToast('共有画面を開きました');
        }
        return status;
    }

}
