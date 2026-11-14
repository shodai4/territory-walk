/**
 * TERRITORY WALK - startup-gate.js
 * 初回起動ゲート：ルール説明の「ゲームをはじめる」を押すまで、位置情報の許可要求と
 * AdMob / ATT の初期化を待たせる。
 *
 * - 初回起動（territory_rules_seen_v1 が未設定）
 *     ルール説明 → チーム決定画面 → 「ゲーム開始」の順に進み、最後のタップで初めて
 *     位置情報の許可要求と AdMob / ATT の初期化を開始する。
 * - 2回目以降の起動（territory_rules_seen_v1 が設定済み）
 *     同画面はスキップし、起動直前に開始する（従来どおり起動直後）。
 * - 開始は一度だけ。ルール説明をメニューから開き直して閉じても二重には走らない。
 */

const RULES_SEEN_KEY = 'territory_rules_seen_v1';

class StartupGate {
    /**
     * @param {{
     *   storage?: Storage|null,
     *   rulesSeenKey?: string,
     *   onStart?: (trigger: string) => void
     * }} options
     */
    constructor(options = {}) {
        this.storage = options.storage !== undefined
            ? options.storage
            : StartupGate.defaultStorage();
        this.rulesSeenKey = options.rulesSeenKey || RULES_SEEN_KEY;
        this.onStart = typeof options.onStart === 'function' ? options.onStart : null;

        // 位置情報・AdMob(ATT) を開始済みか（二重開始の防止）
        this.started = false;
        // 何が開始の契機だったか（'repeat-launch' / 'rules-dismissed' / 'manual'）
        this.startedBy = null;
    }

    /** localStorage が使えない環境（SSR・プライベートモード等）でも落ちないようにする */
    static defaultStorage() {
        try {
            return typeof localStorage !== 'undefined' ? localStorage : null;
        } catch (e) {
            return null;
        }
    }

    /** ルール説明を読み終えたか（= 2回目以降の起動か） */
    hasSeenRules() {
        try {
            return !!(this.storage && this.storage.getItem(this.rulesSeenKey));
        } catch (e) {
            return false;
        }
    }

    /** 「ゲームをはじめる」でルール既読を記録する */
    markRulesSeen() {
        try {
            if (this.storage) this.storage.setItem(this.rulesSeenKey, 'true');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 起動時の入口。初回は待機して false、2回目以降は即開始して true。
     * @returns {boolean} この場で開始したか
     */
    begin() {
        if (!this.hasSeenRules()) {
            this.startedBy = null;
            return false;
        }
        this.start('repeat-launch');
        return true;
    }

    /**
     * 待っていた処理を開始する（2回目以降は一度だけ）。
     * @returns {boolean} 実際に開始したか
     */
    start(trigger = 'manual') {
        if (this.started) return false;
        this.started = true;
        this.startedBy = trigger;
        if (this.onStart) {
            try {
                this.onStart(trigger);
            } catch (e) {
                console.warn('[Startup] onStart failed:', e);
            }
        }
        return true;
    }

    /**
     * ルール説明の「ゲームをはじめる」を押した直後、チーム決定画面を出す必要があるか。
     * 初回起動（未既読・未開始）のときだけ true。2回目以降は false。
     * @returns {boolean}
     */
    needsTeamDecision() {
        return !this.started && !this.hasSeenRules();
    }

    /**
     * チーム決定画面の「ゲーム開始」。ここでルール既読を確定し、
     * 待機していた位置情報・ATTの許可要求を一度だけ開始する。
     * @param {string|null} team 決定した陣営（'black' / 'white'）
     * @returns {boolean} 実際に開始したか
     */
    confirmTeamSelection(team = null) {
        this.selectedTeam = team || null;
        this.markRulesSeen();
        return this.start('team-decision');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StartupGate, RULES_SEEN_KEY };
}
