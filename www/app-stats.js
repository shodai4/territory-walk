/**
 * TERRITORY WALK - app-stats.js
 * 戦績モーダル・ランキング（週間／通算）・週間リザルト
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppMap を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppStats extends TerritoryWalkAppMap {
    initStatsModal() {
        const modal = document.getElementById('stats-modal');
        const openBtn = document.getElementById('btn-open-stats');
        const closeBtn = document.getElementById('btn-close-stats');
        const footerCloseBtn = document.getElementById('btn-stats-footer-close');

        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (this.menuModal) this.menuModal.classList.add('hidden');
                modal.classList.remove('hidden');
                this.updateStatsDisplay();
                this.switchStatsTab('my-stats');
            });
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

        // Save Nickname (表示名)
        const saveNickBtn = document.getElementById('btn-save-nickname');
        if (saveNickBtn) {
            saveNickBtn.addEventListener('click', async () => {
                const input = document.getElementById('input-nickname');
                if (input && this.statsManager) {
                    saveNickBtn.disabled = true;
                    saveNickBtn.textContent = '保存中...';
                    await this.statsManager.setNickname(input.value);
                    saveNickBtn.textContent = '保存完了';
                    this.showToast('表示名を更新しました');
                    setTimeout(() => {
                        saveNickBtn.textContent = '保存';
                        saveNickBtn.disabled = false;
                    }, 1200);
                    this.updateStatsDisplay();
                }
            });
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

        const battleEl = document.getElementById('stat-battles-record');
        if (battleEl) battleEl.textContent = `${stats.battles_won}勝 ${stats.battles_lost}敗`;

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
                const shareUrl = 'https://shodai4.com/territory-walk/';

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

    async checkWeeklyResetResult() {
        if (!this.supabaseManager || !this.statsManager) return;
        const currentWeek = this.supabaseManager.getCurrentWeekId();
        const lastSeen = localStorage.getItem('tw_last_seen_week');

        // If first time ever on this device, just mark current week
        if (!lastSeen) {
            localStorage.setItem('tw_last_seen_week', currentWeek);
            return;
        }

        if (lastSeen !== currentWeek) {
            // New week has arrived!
            setTimeout(() => {
                this.showWeeklyResultModal(false, lastSeen);
            }, 1000);
        }
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
                this.statsManager.stats.battles_won += 1;
                this.statsManager.saveLocalStats();
            }
        } else {
            outcome.innerHTML = '<span class="text-zinc-400">DEFEAT (敗北陣営)</span>';
            if (!isManual && this.statsManager) {
                this.statsManager.stats.battles_lost += 1;
                this.statsManager.saveLocalStats();
            }
        }

        this.lastResultData = result;
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
