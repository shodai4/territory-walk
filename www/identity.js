/**
 * TERRITORY WALK - identity.js
 * 匿名ID・所属チーム・引き継ぎコードの永続化と、機種変更の引き継ぎ。
 *
 * ■ なぜ Keychain なのか
 *   匿名ID（tw_user_id）は localStorage にしか無いと、アプリを削除した時点で
 *   消えてしまう。iOS の Keychain はアプリを削除しても項目が残るため、再インストール
 *   しても同じ匿名IDで再開でき、累計戦績が戻り、チームの選び直し（実質セマラ）も防げる。
 *   → ネイティブ（iOS）では ios-plugins/tw-keychain（TWKeychain）に保存する。
 *   → Web（GitHub Pages）では localStorage をそのまま使う安全なフォールバック。
 *
 * ■ 何を保存するか
 *   tw_user_id      匿名ユーザーID（territory_users の主キー）
 *   player_team     所属チーム（black / white）
 *   tw_nickname     自分で設定した表示名（未設定なら空）
 *   tw_transfer_code 引き継ぎコード（機種変更で新しい端末に入力するコード）
 *
 * ■ 引き継ぎ（機種変更）
 *   1. 旧端末: MENU →「引き継ぎコード」に自分のコードを表示・コピー
 *   2. 新端末: 同じ欄にコードを入力 →「引き継ぐ」
 *      → territory_users を transfer_code で検索し、user_id / team / 戦績 / コイン を
 *        新しい端末の localStorage と Keychain へ書き写して再起動する。
 *   ※ コードは推測されにくいランダム8文字。DB 側の追加は supabase/transfer_code.sql。
 */

const TW_IDENTITY_STORAGE_KEYS = {
    userId: 'tw_user_id',
    team: 'player_team',
    nickname: 'tw_nickname',
    transferCode: 'tw_transfer_code'
};

const TW_KEYCHAIN_PLUGIN_NAME = 'TWKeychain';

// 引き継ぎコードに使う文字（見間違えやすい O/0/I/1 を除く）
const TW_TRANSFER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TW_TRANSFER_CODE_LENGTH = 8;

class TWIdentityStore {
    /**
     * @param {{storage?: Storage|null, plugin?: object|null}} options
     *   plugin に { get, set, remove } を持つネイティブプラグインを渡すと Keychain を使う。
     *   省略時は iOS ネイティブなら TWKeychain、それ以外（Web）は localStorage。
     */
    constructor(options = {}) {
        this.storage = options.storage !== undefined ? options.storage : TWIdentityStore.defaultStorage();
        this.plugin = options.plugin !== undefined ? options.plugin : TWIdentityStore.resolveKeychainPlugin();
        this.native = !!this.plugin;
    }

    static defaultStorage() {
        try {
            return typeof localStorage !== 'undefined' ? localStorage : null;
        } catch (e) {
            return null;
        }
    }

    /** ネイティブの iOS 上で動いているか */
    static isNativeIOS(cap) {
        const capacitor = cap !== undefined ? cap : (typeof window !== 'undefined' ? window.Capacitor : null);
        if (!capacitor) return false;
        try {
            const isNative = typeof capacitor.isNativePlatform === 'function'
                ? capacitor.isNativePlatform()
                : !!capacitor.isNative;
            if (!isNative) return false;
            const platform = typeof capacitor.getPlatform === 'function'
                ? capacitor.getPlatform()
                : capacitor.platform;
            return platform === 'ios';
        } catch (e) {
            return false;
        }
    }

    /** ネイティブの TWKeychain プラグインを解決する（Web では null） */
    static resolveKeychainPlugin(cap) {
        const capacitor = cap !== undefined ? cap : (typeof window !== 'undefined' ? window.Capacitor : null);
        if (!capacitor) return null;
        if (!TWIdentityStore.isNativeIOS(capacitor)) return null;
        try {
            if (capacitor.Plugins && capacitor.Plugins[TW_KEYCHAIN_PLUGIN_NAME]) {
                return capacitor.Plugins[TW_KEYCHAIN_PLUGIN_NAME];
            }
            if (typeof capacitor.registerPlugin === 'function') {
                return capacitor.registerPlugin(TW_KEYCHAIN_PLUGIN_NAME);
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    /** 'keychain' / 'localStorage'（ログ・UI 表示用） */
    get backend() {
        return this.native ? 'keychain' : 'localStorage';
    }

    _readLocal(key) {
        try {
            const value = this.storage ? this.storage.getItem(key) : null;
            return value === null || value === undefined || value === '' ? null : String(value);
        } catch (e) {
            return null;
        }
    }

    _writeLocal(key, value) {
        try {
            if (this.storage) this.storage.setItem(key, String(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    _removeLocal(key) {
        try {
            if (this.storage) this.storage.removeItem(key);
            return true;
        } catch (e) {
            return false;
        }
    }

    /** @returns {Promise<string|null>} */
    async get(key) {
        if (!this.native) return this._readLocal(key);
        try {
            const result = await this.plugin.get({ key });
            const value = result ? result.value : null;
            if (value === null || value === undefined || value === '') return null;
            return String(value);
        } catch (e) {
            // 未登録（Keychain に項目が無い）はプラグインが reject する環境もある
            return null;
        }
    }

    /** @returns {Promise<boolean>} */
    async set(key, value) {
        if (value === null || value === undefined) return this.remove(key);
        const text = String(value);
        if (!this.native) return this._writeLocal(key, text);
        try {
            await this.plugin.set({ key, value: text });
            return true;
        } catch (e) {
            return false;
        }
    }

    /** @returns {Promise<boolean>} */
    async remove(key) {
        if (!this.native) return this._removeLocal(key);
        try {
            await this.plugin.remove({ key });
            return true;
        } catch (e) {
            return false;
        }
    }
}

class TWIdentity {
    /** 入力されたコードを正規化する（大文字化・記号と空白を除去・最大10文字） */
    static normalizeCode(raw) {
        return String(raw == null ? '' : raw)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 10);
    }

    /** 表示用に4文字ずつ区切る（ABCD-EFGH） */
    static formatCode(raw) {
        const code = TWIdentity.normalizeCode(raw);
        if (code.length !== TW_TRANSFER_CODE_LENGTH) return code;
        return `${code.slice(0, 4)}-${code.slice(4)}`;
    }

    /** 引き継ぎコードを新しく作る（8文字） */
    static generateCode(random) {
        const rnd = typeof random === 'function' ? random : Math.random;
        let code = '';
        for (let i = 0; i < TW_TRANSFER_CODE_LENGTH; i += 1) {
            const idx = Math.floor(rnd() * TW_TRANSFER_CODE_ALPHABET.length) % TW_TRANSFER_CODE_ALPHABET.length;
            code += TW_TRANSFER_CODE_ALPHABET.charAt(idx);
        }
        return code;
    }

    /** 入力されたコードが形式として妥当か（6〜10文字の英数） */
    static isValidCode(raw) {
        const code = TWIdentity.normalizeCode(raw);
        return code.length >= 6 && code.length <= 10;
    }

    /**
     * "[称号] 表示名" から表示名だけを取り出す。
     * 未設定（空・ユーザーIDと同じ）なら null を返し、端末側の表示名を書き換えない。
     */
    static parseDisplayName(raw, userId) {
        const text = String(raw == null ? '' : raw).trim();
        if (!text) return null;
        const match = text.match(/^\[(.*?)\]\s*(.*)$/);
        const name = (match ? match[2] : text).trim();
        if (!name || (userId && name === String(userId))) return null;
        return name;
    }

    /**
     * 引き継ぎ先の端末へ書き込む内容を組み立てる（純粋関数）。
     * @param {object} user territory_users の1行
     * @param {{code?: string}} options 入力された引き継ぎコード（DBに無い場合の控え）
     * @returns {{set: Object<string,string>, remove: string[]}|null}
     */
    static buildTransferStorageWrites(user, options = {}) {
        if (!user || !user.user_id) return null;

        const set = {};
        const remove = [];

        set[TW_IDENTITY_STORAGE_KEYS.userId] = String(user.user_id);

        const team = user.team === 'white' ? 'white' : (user.team === 'black' ? 'black' : null);
        if (team) set[TW_IDENTITY_STORAGE_KEYS.team] = team;

        const nickname = TWIdentity.parseDisplayName(user.nickname, user.user_id);
        if (nickname) set[TW_IDENTITY_STORAGE_KEYS.nickname] = nickname;
        else remove.push(TW_IDENTITY_STORAGE_KEYS.nickname);

        const toCount = (value) => {
            const num = Number(value);
            return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
        };
        set['tw_user_stats'] = JSON.stringify({
            lifetime_tiles: toCount(user.lifetime_tiles),
            lifetime_reclaimed: toCount(user.lifetime_reclaimed),
            battles_won: toCount(user.battles_won),
            battles_lost: toCount(user.battles_lost)
        });

        if (user.coins !== null && user.coins !== undefined) {
            const coins = Number(user.coins);
            if (Number.isFinite(coins) && coins >= 0) set['tw_coins'] = String(Math.floor(coins));
        }

        const code = TWIdentity.normalizeCode(user.transfer_code || options.code || '');
        if (code) set[TW_IDENTITY_STORAGE_KEYS.transferCode] = code;

        return { set, remove };
    }

    /** 端末（localStorage）に書き込み内容を適用する */
    static applyStorageWrites(writes, storage) {
        const target = storage !== undefined ? storage : TWIdentityStore.defaultStorage();
        if (!writes || !target) return false;
        try {
            Object.keys(writes.set || {}).forEach((key) => {
                target.setItem(key, writes.set[key]);
            });
            (writes.remove || []).forEach((key) => {
                target.removeItem(key);
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 既定のストア（初回だけ生成して使い回す） */
    static defaultStore(options = {}) {
        if (!TWIdentity._store) {
            TWIdentity._store = new TWIdentityStore(options);
        }
        return TWIdentity._store;
    }

    /** テスト用にストアを差し替える */
    static setDefaultStore(store) {
        TWIdentity._store = store || null;
    }

    static readLocal(key, storage) {
        const target = storage !== undefined ? storage : TWIdentityStore.defaultStorage();
        try {
            const value = target ? target.getItem(key) : null;
            return value === null || value === undefined || value === '' ? null : String(value);
        } catch (e) {
            return null;
        }
    }

    /**
     * 起動時の復元。localStorage が空でも Keychain にIDがあれば書き戻す。
     * app.js の生成より前に await すること（StatsManager が localStorage を読むため）。
     * @returns {Promise<{restored:boolean, source:string, backend:string, identity:object|null}>}
     */
    static async bootstrap(options = {}) {
        const storage = options.storage !== undefined ? options.storage : TWIdentityStore.defaultStorage();
        const store = options.store || TWIdentity.defaultStore({ storage });
        const result = { restored: false, source: 'none', backend: store.backend, identity: null };
        if (!storage) return result;

        const localUserId = TWIdentity.readLocal(TW_IDENTITY_STORAGE_KEYS.userId, storage);
        if (localUserId) {
            // 端末にIDがある ＝ 通常起動。Keychain 側が空（旧バージョンからの更新）なら控えを取る
            result.source = 'local';
            result.identity = {
                userId: localUserId,
                team: TWIdentity.readLocal(TW_IDENTITY_STORAGE_KEYS.team, storage),
                nickname: TWIdentity.readLocal(TW_IDENTITY_STORAGE_KEYS.nickname, storage),
                transferCode: TWIdentity.readLocal(TW_IDENTITY_STORAGE_KEYS.transferCode, storage)
            };
            await TWIdentity.persist(result.identity, { store, storage });
            return result;
        }

        const userId = await store.get(TW_IDENTITY_STORAGE_KEYS.userId);
        if (!userId) return result;

        const team = await store.get(TW_IDENTITY_STORAGE_KEYS.team);
        const nickname = await store.get(TW_IDENTITY_STORAGE_KEYS.nickname);
        const transferCode = await store.get(TW_IDENTITY_STORAGE_KEYS.transferCode);

        const writes = {
            set: { [TW_IDENTITY_STORAGE_KEYS.userId]: userId },
            remove: []
        };
        if (team === 'black' || team === 'white') writes.set[TW_IDENTITY_STORAGE_KEYS.team] = team;
        if (nickname) writes.set[TW_IDENTITY_STORAGE_KEYS.nickname] = nickname;
        if (transferCode) writes.set[TW_IDENTITY_STORAGE_KEYS.transferCode] = transferCode;

        TWIdentity.applyStorageWrites(writes, storage);

        result.restored = true;
        result.source = store.backend;
        result.identity = { userId, team, nickname, transferCode };
        return result;
    }

    /**
     * 現在のID・チーム・表示名・引き継ぎコードを保存する（Keychain / Web は localStorage）。
     * @returns {Promise<boolean>}
     */
    static async persist(identity, options = {}) {
        if (!identity) return false;
        const storage = options.storage !== undefined ? options.storage : TWIdentityStore.defaultStorage();
        const store = options.store || TWIdentity.defaultStore({ storage });

        const entries = [
            [TW_IDENTITY_STORAGE_KEYS.userId, identity.userId],
            [TW_IDENTITY_STORAGE_KEYS.team, identity.team],
            [TW_IDENTITY_STORAGE_KEYS.nickname, identity.nickname],
            [TW_IDENTITY_STORAGE_KEYS.transferCode, identity.transferCode]
        ];

        let ok = true;
        for (const [key, value] of entries) {
            if (value === undefined) continue;
            const text = value === null ? '' : String(value);
            // 空文字は「未設定」なので既存の保存値は消さない（IDを消さないため）
            if (!text) continue;
            if (key === TW_IDENTITY_STORAGE_KEYS.nickname && options.skipNickname) continue;
            const saved = await store.set(key, text);
            if (!saved) ok = false;
        }
        return ok;
    }

    /** app.js から呼ぶ薄いラッパー（失敗してもゲーム進行は止めない） */
    static persistCurrent(identity) {
        try {
            return TWIdentity.persist(identity).catch(() => false);
        } catch (e) {
            return Promise.resolve(false);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TWIdentity,
        TWIdentityStore,
        TW_IDENTITY_STORAGE_KEYS,
        TW_KEYCHAIN_PLUGIN_NAME,
        TW_TRANSFER_CODE_ALPHABET,
        TW_TRANSFER_CODE_LENGTH
    };
}
