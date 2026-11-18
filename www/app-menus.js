/**
 * TERRITORY WALK - app-menus.js
 * ルール／陣営／MENU モーダル・はじめのゲート・引き継ぎコード
 *
 * app.js（旧4,283行の単一クラス）を役割ごとに分割したモジュール。
 * 読み込み順は index.html の <script> 順（app-config → app-core → … → app-gameplay → app.js）。
 * このファイルは TerritoryWalkAppActions を継承してメソッドを積み上げる。
 * メソッドの中身は分割前と同一（挙動・保存データ・DOM 操作は変えない）。
 */
class TerritoryWalkAppMenus extends TerritoryWalkAppActions {
    initRulesModal() {
        const hasSeenRules = localStorage.getItem('territory_rules_seen_v1');
        if (!hasSeenRules && this.rulesModal) {
            this.rulesModal.classList.remove('hidden');
            this.resetViewportScroll();
        }

        if (this.btnCloseRules) {
            this.btnCloseRules.addEventListener('click', () => this.dismissRulesModal());
        }
        this.setupSwipeUpToClose('rules-modal', () => this.dismissRulesModal());
    }

    /**
     * ルール説明モーダルを閉じる（初回の「ゲームをはじめる」もここ）。
     * 初回起動はここでチーム決定画面へ進み、そこで「ゲーム開始」を押すまで
     * 位置情報と AdMob/ATT の許可要求は出さない。
     */
    dismissRulesModal() {
        const needsTeamDecision = this.startupGate ? this.startupGate.needsTeamDecision() : false;

        if (this.rulesModal) {
            this.rulesModal.classList.add('hidden');
            this.resetViewportScroll();
        }

        if (needsTeamDecision) {
            this.showTeamDecisionModal();
            return;
        }

        if (this.startupGate) return;

        // startup-gate.js が読まれていない場合のフォールバック（従来の即時開始）
        try {
            localStorage.setItem('territory_rules_seen_v1', 'true');
        } catch (e) { /* ignore */ }
        this.startDeferredServices('rules-dismissed');
    }

    /** チーム決定画面のボタン配線（初回起動の許可要求より前に使う） */
    initTeamDecisionModal() {
        if (this.btnStartGame) {
            this.btnStartGame.addEventListener('click', () => this.confirmTeamDecision());
        }
    }

    /** 決定した陣営（Black / White）を描き込んでチーム決定画面を開く */
    showTeamDecisionModal() {
        const isWhite = this.currentTeam === 'white';
        this.teamDecisionModalShown = true;

        if (this.teamDecisionBadge) {
            this.teamDecisionBadge.className = isWhite
                ? 'w-28 h-28 rounded-full flex items-center justify-center border-4 border-white bg-white shadow-2xl transition-all'
                : 'w-28 h-28 rounded-full flex items-center justify-center border-4 border-zinc-500 bg-black shadow-2xl transition-all';
        }
        if (this.teamDecisionSymbol) {
            this.teamDecisionSymbol.textContent = isWhite ? 'WHITE' : 'BLACK';
            this.teamDecisionSymbol.className = isWhite
                ? 'font-mono font-bold text-2xl tracking-wider text-black'
                : 'font-mono font-bold text-2xl tracking-wider text-white';
        }
        if (this.teamDecisionName) {
            this.teamDecisionName.textContent = isWhite ? 'WHITE（白）陣営' : 'BLACK（黒）陣営';
        }
        if (this.teamDecisionDescription) {
            // 単語の途中で折り返さないよう、読点と文末で明示的に改行する（375px幅でも各行が収まる長さに分割）
            this.teamDecisionDescription.innerHTML = isWhite
                ? 'オートバランサーにより、<br>あなたは白陣営に配属されました。<br>街を歩いた場所が白の陣地になります。'
                : 'オートバランサーにより、<br>あなたは黒陣営に配属されました。<br>街を歩いた場所が黒の陣地になります。';
        }
        if (this.teamDecisionModal) {
            this.teamDecisionModal.classList.remove('hidden');
            this.resetViewportScroll();
        }
    }

    /**
     * チーム決定画面の「ゲーム開始」。既読を確定し、位置情報と AdMob/ATT を開始する。
     */
    confirmTeamDecision() {
        this.teamDecisionModalShown = false;
        if (this.teamDecisionModal) {
            this.teamDecisionModal.classList.add('hidden');
            this.resetViewportScroll();
        }

        if (this.startupGate) {
            this.startupGate.confirmTeamSelection(this.currentTeam);
            return;
        }

        try {
            localStorage.setItem('territory_rules_seen_v1', 'true');
        } catch (e) { /* ignore */ }
        this.startDeferredServices('team-decision');
    }

    /**
     * 起動ゲート。初回起動はルール説明 → チーム決定画面を経て開始し、
     * 2回目以降の起動はこれまでどおり起動直後に開始する。
     */
    initStartupGate() {
        if (typeof StartupGate === 'undefined') {
            // モジュール未読込でも機能を止めない（従来どおり即時開始）
            this.startDeferredServices('fallback');
            return;
        }

        this.startupGate = new StartupGate({
            onStart: (trigger) => this.startDeferredServices(trigger)
        });

        // true なら2回目以降の起動で、ここで開始済み。初回はルール説明を閉じるまで待機。
        this.startupGate.begin();
    }

    /**
     * 位置情報の取得と AdMob（ATT 許可要求を含む）の初期化を開始する。
     * 初回起動ではチーム決定画面の「ゲーム開始」で1回だけ、2回目以降は起動直後に一度だけ走る。
     */
    startDeferredServices(trigger = 'manual') {
        if (this.servicesStarted) return false;
        this.servicesStarted = true;
        this.servicesStartedBy = trigger;

        // マーキング停止中に起動した場合は測位を始めない（起動直後の一瞬塗り防止）。
        // 再開操作（setMarkingPaused(false)）で初めて startLocationTracking() が走る。
        if (this.markingPaused === true) {
            this.updateGPSStatus('GPS: マーキング停止中', 'bg-sky-400', 'text-sky-300');
            this.renderMarkingPauseUI();
        } else {
            this.startLocationTracking();
        }

        if (this.adMobManager && typeof this.adMobManager.init === 'function') {
            this.adMobManager.init();
        }

        // 歩き始めてから Watch 連携と通知の予約を始める（起動直後の許可要求を増やさない）
        this.initWatchBridge();
        if (this.weeklyNotifier && typeof this.weeklyNotifier.init === 'function') {
            Promise.resolve(this.weeklyNotifier.init()).catch(() => {});
        }
        return true;
    }

    initMenuModal() {
        if (!this.menuModal) return;

        const openModal = () => {
            this.menuModal.classList.remove('hidden');
            this.updateAutoBalanceUI();
            this.renderPrivacySummary();
            this.refreshTransferCodeUI();
            this.resetViewportScroll();
        };

        const closeModal = () => {
            this.menuModal.classList.add('hidden');
            this.resetViewportScroll();
        };

        if (this.btnMenu) this.btnMenu.addEventListener('click', openModal);
        if (this.btnCloseMenu) this.btnCloseMenu.addEventListener('click', closeModal);
        if (this.btnModalCloseIcon) this.btnModalCloseIcon.addEventListener('click', closeModal);
        this.setupSwipeUpToClose('menu-modal', closeModal);

        if (this.btnOpenRules) {
            this.btnOpenRules.addEventListener('click', () => {
                closeModal();
                if (this.rulesModal) {
                    this.rulesModal.classList.remove('hidden');
                    this.resetViewportScroll();
                }
            });
        }

        if (this.btnToggleMap) {
            this.btnToggleMap.addEventListener('click', () => this.toggleMapVisibility());
        }

        if (this.btnToggleDebug) {
            this.btnToggleDebug.addEventListener('click', () => this.toggleDebugMode());
        }
    }

    /* ------------------------------------------------------------------ *
     * 引き継ぎコード（機種変更・再インストール対策）
     *   MENU の中の「引き継ぎコード」セクションを配線する。
     *   自分のコードの表示・コピーと、他端末から引き継ぐためのコード入力。
     * ------------------------------------------------------------------ */

    initTransferCodeUI() {
        this.transferCodeDisplay = document.getElementById('display-my-transfer-code');
        this.transferCodeStatus = document.getElementById('transfer-code-status');
        this.transferCodeInput = document.getElementById('input-transfer-code');
        this.btnCopyTransferCode = document.getElementById('btn-copy-my-transfer-code');
        this.btnApplyTransferCode = document.getElementById('btn-apply-transfer-code');

        if (this.btnCopyTransferCode) {
            this.btnCopyTransferCode.addEventListener('click', () => this.copyTransferCode());
        }
        if (this.btnApplyTransferCode) {
            this.btnApplyTransferCode.addEventListener('click', () => this.handleTransferCodeApply());
        }
        if (this.transferCodeInput) {
            this.transferCodeInput.addEventListener('keydown', (event) => {
                if (event && event.key === 'Enter') {
                    event.preventDefault();
                    this.handleTransferCodeApply();
                }
            });
        }

        this.refreshTransferCodeUI();
    }

    /** 自分の引き継ぎコードを画面に出す（必要なら DB への同期も試す） */
    refreshTransferCodeUI() {
        if (!this.statsManager || typeof this.statsManager.getOrCreateTransferCode !== 'function') return;

        const code = this.statsManager.getOrCreateTransferCode();
        const display = this.transferCodeDisplay || document.getElementById('display-my-transfer-code');
        if (display) {
            display.textContent = (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.formatCode === 'function')
                ? TWIdentity.formatCode(code)
                : code;
        }

        // 自分のコードをサーバーへ登録しておく（未登録だと別端末から引き継げない）
        if (typeof this.statsManager.syncTransferCode === 'function') {
            Promise.resolve(this.statsManager.syncTransferCode()).then((result) => {
                this.updateTransferCodeStatus(result);
                if (result && result.reason === 'not_ready') {
                    console.info('[Transfer] transfer_code 列がありません。supabase/transfer_code.sql を実行すると機種変更の引き継ぎが有効になります。');
                }
            }).catch(() => {});
        }
    }

    /** 引き継ぎコードの状態表示（サーバー登録済みか / SQL 未実行か） */
    updateTransferCodeStatus(result) {
        const status = this.transferCodeStatus || document.getElementById('transfer-code-status');
        if (!status) return;

        const reason = result && result.reason;
        if (result && result.ok) {
            status.textContent = 'このコードはサーバーに登録済みです。機種変更時にこのコードを新しい端末で入力してください。';
            status.className = 'text-[10px] leading-snug text-zinc-500';
            return;
        }
        if (reason === 'not_ready') {
            status.textContent = 'サーバーとの準備が整い次第、コードの登録は自動で行われます。端末内のデータは保持されます。';
            status.className = 'text-[10px] leading-snug text-amber-400';
            return;
        }
        if (reason === 'offline') {
            status.textContent = 'オフラインのため、コードのサーバー登録は通信回復後に自動で行われます。';
            status.className = 'text-[10px] leading-snug text-zinc-500';
            return;
        }
        if (reason === 'no_row') {
            status.textContent = '初回のプレイ（オンライン）後にコードがサーバーへ登録されます。';
            status.className = 'text-[10px] leading-snug text-zinc-500';
            return;
        }
        status.textContent = 'コードのサーバー登録を確認できませんでした。通信状況をご確認ください。';
        status.className = 'text-[10px] leading-snug text-zinc-500';
    }

    /** 自分の引き継ぎコードをクリップボードへコピー */
    copyTransferCode() {
        if (!this.statsManager) return;
        const code = (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.formatCode === 'function')
            ? TWIdentity.formatCode(this.statsManager.getOrCreateTransferCode())
            : this.statsManager.getOrCreateTransferCode();

        const done = () => {
            if (this.showToast) this.showToast(`引き継ぎコード [${code}] をコピーしました`);
        };

        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(done).catch(() => {
                try { prompt('引き継ぎコードをコピーしてください:', code); } catch (e) { /* ignore */ }
            });
            return;
        }
        try { prompt('引き継ぎコードをコピーしてください:', code); } catch (e) { /* ignore */ }
    }

    /** 入力欄のコードを読み取って引き継ぎを実行する（UI 側の入口） */
    async handleTransferCodeApply() {
        const input = this.transferCodeInput || document.getElementById('input-transfer-code');
        const raw = input ? input.value : '';
        if (this.btnApplyTransferCode) this.btnApplyTransferCode.disabled = true;

        let message = '';
        try {
            const result = await this.applyTransferCode(raw);
            message = result.message || '';
            if (this.showToast) this.showToast(message, result.success ? 'アプリを再起動します' : null);
            if (this.transferCodeStatus) {
                this.transferCodeStatus.textContent = message;
                this.transferCodeStatus.className = result.success
                    ? 'text-[10px] leading-snug text-emerald-400'
                    : 'text-[10px] leading-snug text-rose-400';
            }
        } finally {
            if (this.btnApplyTransferCode) this.btnApplyTransferCode.disabled = false;
        }
        return message;
    }

    /**
     * 引き継ぎコードを検証し、この端末を相手の匿名ID・チーム・戦績へ切り替える。
     * @param {string} rawCode
     * @returns {Promise<{success:boolean, message:string, reload?:boolean}>}
     */
    async applyTransferCode(rawCode) {
        const normalize = (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.normalizeCode === 'function')
            ? TWIdentity.normalizeCode
            : (value) => String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const code = normalize(rawCode);

        if (!code) return { success: false, message: '引き継ぎコードを入力してください' };
        if (code.length < 6 || code.length > 10) {
            return { success: false, message: '引き継ぎコードは英数字6〜10文字です' };
        }

        const myCode = this.statsManager && typeof this.statsManager.getOrCreateTransferCode === 'function'
            ? normalize(this.statsManager.getOrCreateTransferCode())
            : '';
        if (myCode && code === myCode) {
            return { success: false, message: 'このコードはこの端末自身のものです' };
        }

        if (!this.supabaseManager || typeof this.supabaseManager.fetchUserByTransferCode !== 'function') {
            return { success: false, message: '引き継ぎ機能を利用できません（アプリを最新版に更新してください）' };
        }

        const found = await this.supabaseManager.fetchUserByTransferCode(code);
        if (!found.ok) {
            if (found.reason === 'offline') {
                return { success: false, message: 'オフラインのため引き継ぎできません。通信できる場所でお試しください' };
            }
            if (found.reason === 'not_ready') {
                return { success: false, message: 'ただいま引き継ぎをご利用いただけません。時間をおいて、もう一度お試しください' };
            }
            if (found.reason === 'not_found') {
                return { success: false, message: 'そのコードは見つかりませんでした。コードをご確認ください（初回はオンラインで一度プレイすると登録されます）' };
            }
            return { success: false, message: '引き継ぎに失敗しました。通信状況をご確認のうえ、もう一度お試しください' };
        }

        const writes = (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.buildTransferStorageWrites === 'function')
            ? TWIdentity.buildTransferStorageWrites(found.user, { code })
            : null;
        if (!writes) return { success: false, message: '引き継ぎデータを読み取れませんでした' };

        const keys = TerritoryWalkApp.identityKeys();

        if (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.applyStorageWrites === 'function') {
            TWIdentity.applyStorageWrites(writes);
        } else {
            Object.keys(writes.set || {}).forEach((key) => { try { localStorage.setItem(key, writes.set[key]); } catch (e) { /* ignore */ } });
            (writes.remove || []).forEach((key) => { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } });
        }

        // Keychain（Web は localStorage）にも同じIDを控え、再起動後も同じIDで再開できるようにする
        try {
            if (typeof TWIdentity !== 'undefined' && TWIdentity && typeof TWIdentity.persist === 'function') {
                await TWIdentity.persist({
                    userId: found.user.user_id,
                    team: writes.set[keys.team],
                    nickname: writes.set[keys.nickname] || null,
                    transferCode: writes.set[keys.transferCode] || code
                });
            }
        } catch (e) {
            console.warn('[Transfer] Keychain persist failed:', e);
        }

        const teamLabel = writes.set[keys.team] === 'white' ? 'White（白）' : 'Black（黒）';
        const message = `引き継ぎが完了しました（${teamLabel}陣営）。アプリを再起動して反映します`;

        // 画面を再起動して全モジュールを新しいIDで初期化する（状態の取りこぼしを防ぐ）
        if (typeof location !== 'undefined' && typeof location.reload === 'function') {
            setTimeout(() => {
                try { location.reload(); } catch (e) { /* テスト環境など */ }
            }, 1200);
        }

        return { success: true, message, reload: true };
    }
}
