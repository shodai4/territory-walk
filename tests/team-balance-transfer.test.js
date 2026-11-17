/**
 * TERRITORY WALK - Node tests
 * チーム均等配属 & iOS Keychain 引き継ぎ:
 *   1) 新規ユーザーは territory_users の人数が少ない方のチームへ自動配属
 *      （同数・オフライン・集計失敗は 50% ランダムへフォールバック）
 *   2) 匿名ID・チーム・引き継ぎコードを Keychain（Web は localStorage）へ保存し、
 *      localStorage が空でも起動時に復元する
 *   3) MENU の「引き継ぎコード」で別端末へID・チーム・戦績を切り替えられる
 *   4) iOS のネイティブプラグイン（ios-plugins/tw-keychain）が Podfile と
 *      capacitor.config.json の packageClassList に冪等に組み込まれる
 *   5) 引き継ぎコード用の SQL（supabase/transfer_code.sql）と www/ 同期
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const SUPABASE_SOURCE = fs.readFileSync(path.join(ROOT, 'supabase.js'), 'utf8');
const IDENTITY_SOURCE = fs.readFileSync(path.join(ROOT, 'identity.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const { SupabaseManager, chooseBalancedTeam, SUPABASE_URL } = require(path.join(ROOT, 'supabase.js'));
const {
    TWIdentity,
    TWIdentityStore,
    TW_IDENTITY_STORAGE_KEYS
} = require(path.join(ROOT, 'identity.js'));

const {
    configurePodfileKeychain,
    verifyPodfileKeychain,
    configureCapacitorConfigContent,
    verifyCapacitorConfigContent,
    KEYCHAIN_PLUGIN_CLASS,
    KEYCHAIN_POD_LINE
} = require(path.join(ROOT, 'scripts', 'configure-ios.js'));

/* ------------------------------------------------------------------ *
 * 1. チーム均等配属の判定（純粋関数）
 * ------------------------------------------------------------------ */

test('均等配属: 黒が少なければ黒、白が少なければ白', () => {
    assert.equal(chooseBalancedTeam({ black: 3, white: 9 }), 'black');
    assert.equal(chooseBalancedTeam({ black: 9, white: 3 }), 'white');
    assert.equal(chooseBalancedTeam({ black: 0, white: 1 }), 'black');
    assert.equal(chooseBalancedTeam({ black: 1, white: 0 }), 'white');
});

test('均等配属: 同数・未取得・不正値は null（呼び出し側がランダムへフォールバック）', () => {
    assert.equal(chooseBalancedTeam({ black: 5, white: 5 }), null);
    assert.equal(chooseBalancedTeam({ black: 0, white: 0 }), null);
    assert.equal(chooseBalancedTeam(null), null);
    assert.equal(chooseBalancedTeam(undefined), null);
    assert.equal(chooseBalancedTeam({}), null);
    assert.equal(chooseBalancedTeam({ black: 'x', white: 3 }), null);
    assert.equal(chooseBalancedTeam({ black: -1, white: 3 }), null);
});

/* ------------------------------------------------------------------ *
 * 2. SupabaseManager: territory_users の人数集計
 * ------------------------------------------------------------------ */

function headerBag(contentRange) {
    return { get: (name) => (String(name).toLowerCase() === 'content-range' ? contentRange : null) };
}

function installFetchStub(options = {}) {
    const calls = [];
    const counts = options.counts || { black: 7, white: 11 };

    global.fetch = async (url, request) => {
        calls.push({ url: String(url), request: request || {} });
        if (options.failTeam && String(url).includes(`team=eq.${options.failTeam}`)) {
            return { ok: false, status: 500, headers: headerBag(null) };
        }
        const team = /team=eq\.(black|white)/.exec(String(url));
        const key = team ? team[1] : 'black';
        return { ok: true, status: 200, headers: headerBag(`0-0/${counts[key]}`) };
    };
    return { calls };
}

function createManager() {
    const manager = Object.create(SupabaseManager.prototype);
    manager.client = {};
    return manager;
}

test('人数集計: territory_users を HEAD + count=exact でチームごとに数える', async () => {
    const stub = installFetchStub({ counts: { black: 7, white: 11 } });
    const counts = await createManager().fetchUserTeamCounts();

    assert.deepEqual({ black: counts.black, white: counts.white }, { black: 7, white: 11 });
    assert.equal(stub.calls.length, 2);
    for (const call of stub.calls) {
        assert.ok(call.url.startsWith(`${SUPABASE_URL}/rest/v1/territory_users`), 'territory_users を数える');
        assert.equal(call.request.method, 'HEAD', 'HEAD で行データは転送しない');
        assert.equal(call.request.headers.Prefer, 'count=exact');
        assert.ok(call.request.headers.apikey);
    }
});

test('人数集計: 通信エラー・片方失敗・ヘッダー欠落・クライアント未初期化は null', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    assert.equal(await createManager().fetchUserTeamCounts(), null);

    installFetchStub({ failTeam: 'white' });
    assert.equal(await createManager().fetchUserTeamCounts(), null, '片方が失敗 → null');

    global.fetch = async () => ({ ok: true, status: 200, headers: headerBag(null) });
    assert.equal(await createManager().fetchUserTeamCounts(), null, 'Content-Range 無し → null');

    const noClient = Object.create(SupabaseManager.prototype);
    assert.equal(await noClient.fetchUserTeamCounts(), null);
});

test('人数集計: 偏りがあれば少ないチームが返り、同数なら null になる', async () => {
    installFetchStub({ counts: { black: 2, white: 8 } });
    assert.equal(chooseBalancedTeam(await createManager().fetchUserTeamCounts()), 'black');

    installFetchStub({ counts: { black: 6, white: 6 } });
    assert.equal(chooseBalancedTeam(await createManager().fetchUserTeamCounts()), null);
});

/* ------------------------------------------------------------------ *
 * 3. 引き継ぎコードでの検索・登録
 * ------------------------------------------------------------------ */

function stubUserTable(result, calls = []) {
    const builder = {
        select(columns) {
            calls.push({ op: 'select', columns });
            return builder;
        },
        eq(column, value) {
            calls.push({ op: 'eq', column, value });
            return builder;
        },
        update(payload) {
            calls.push({ op: 'update', payload });
            return builder;
        },
        limit(value) {
            calls.push({ op: 'limit', value });
            return Promise.resolve(result);
        },
        then(resolve, reject) {
            return Promise.resolve(result).then(resolve, reject);
        }
    };
    return { builder, calls };
}

test('引き継ぎ検索: コードで1件引き、user_id/team/戦績を返す', async () => {
    const calls = [];
    const { builder } = stubUserTable({
        data: [{
            user_id: 'user-abc',
            nickname: '[街の開拓者] しょうだい',
            team: 'white',
            lifetime_tiles: 120,
            lifetime_reclaimed: 8,
            battles_won: 3,
            battles_lost: 1,
            coins: 450,
            transfer_code: 'ABCD2345'
        }],
        error: null
    }, calls);

    const manager = createManager();
    manager.client = { from: (table) => { calls.push({ op: 'from', table }); return builder; } };

    const result = await manager.fetchUserByTransferCode('abcd-2345');

    assert.equal(result.ok, true);
    assert.equal(result.user.user_id, 'user-abc');
    assert.equal(calls[0].table, 'territory_users');
    assert.equal(calls[0].op, 'from');
    assert.ok(calls.some((c) => c.op === 'eq' && c.column === 'transfer_code' && c.value === 'ABCD2345'), '大文字に正規化して照合');
    assert.ok(calls.some((c) => c.op === 'limit' && c.value === 1));
});

test('引き継ぎ検索: 未登録・列未作成・通信失敗を区別する', async () => {
    const manager = createManager();

    let stub = stubUserTable({ data: [], error: null });
    manager.client = { from: () => stub.builder };
    assert.equal((await manager.fetchUserByTransferCode('ZZZZ9999')).reason, 'not_found');

    stub = stubUserTable({ data: null, error: { code: '42703', message: 'column territory_users.transfer_code does not exist' } });
    manager.client = { from: () => stub.builder };
    assert.equal((await manager.fetchUserByTransferCode('ZZZZ9999')).reason, 'not_ready', 'SQL未実行は not_ready');

    stub = stubUserTable({ data: null, error: { code: '08006', message: 'connection failure' } });
    manager.client = { from: () => stub.builder };
    assert.equal((await manager.fetchUserByTransferCode('ZZZZ9999')).reason, 'error');

    const noClient = Object.create(SupabaseManager.prototype);
    assert.equal((await noClient.fetchUserByTransferCode('ZZZZ9999')).reason, 'offline');
});

test('引き継ぎ登録: 自分の行へ transfer_code を update する（列未作成・行未作成も区別）', async () => {
    const calls = [];
    const stub = stubUserTable({ data: [{ user_id: 'user-abc' }], error: null }, calls);
    const manager = createManager();
    manager.client = { from: () => stub.builder };

    const saved = await manager.saveTransferCode('user-abc', 'abcd2345');
    assert.equal(saved.ok, true);
    assert.ok(calls.some((c) => c.op === 'update' && c.payload.transfer_code === 'ABCD2345'));
    assert.ok(calls.some((c) => c.op === 'eq' && c.column === 'user_id' && c.value === 'user-abc'));

    // まだ territory_users に行が無い新規ユーザー（0件更新）
    const emptyRow = stubUserTable({ data: [], error: null });
    manager.client = { from: () => emptyRow.builder };
    assert.equal((await manager.saveTransferCode('user-abc', 'abcd2345')).reason, 'no_row');

    const failing = stubUserTable({ error: { code: '42703', message: 'column "transfer_code" does not exist' } });
    manager.client = { from: () => failing.builder };
    assert.equal((await manager.saveTransferCode('user-abc', 'abcd2345')).reason, 'not_ready');
});

/* ------------------------------------------------------------------ *
 * 4. identity.js（Keychain ストア・復元・引き継ぎ内容の組み立て）
 * ------------------------------------------------------------------ */

function createFakeStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); }
    };
}

/** Capacitor 風の TWKeychain プラグイン（未登録は reject する本物と同じ挙動） */
function createFakeKeychain(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        calls: [],
        async get({ key }) {
            this.calls.push(['get', key]);
            if (!data.has(key)) throw new Error('Item with given key does not exist');
            return { value: data.get(key) };
        },
        async set({ key, value }) {
            this.calls.push(['set', key, value]);
            data.set(key, String(value));
            return { saved: true };
        },
        async remove({ key }) {
            this.calls.push(['remove', key]);
            data.delete(key);
            return { removed: true };
        }
    };
}

test('Keychain ストア: ネイティブでは get/set/remove をプラグインへ委譲し、未登録は null', async () => {
    const plugin = createFakeKeychain({ tw_user_id: 'user-1' });
    const store = new TWIdentityStore({ storage: createFakeStorage(), plugin });

    assert.equal(store.backend, 'keychain');
    assert.equal(await store.get('tw_user_id'), 'user-1');
    assert.equal(await store.get('unknown'), null, '未登録はエラーではなく null');
    assert.equal(await store.set('player_team', 'white'), true);
    assert.equal(await store.get('player_team'), 'white');
    assert.equal(await store.remove('player_team'), true);
    assert.equal(await store.get('player_team'), null);
});

test('Keychain ストア: Web では localStorage を使う安全なフォールバック', async () => {
    const storage = createFakeStorage({ tw_user_id: 'web-user' });
    const store = new TWIdentityStore({ storage, plugin: null });

    assert.equal(store.backend, 'localStorage');
    assert.equal(await store.get('tw_user_id'), 'web-user');
    assert.equal(await store.set('tw_user_id', 'web-user-2'), true);
    assert.equal(storage.getItem('tw_user_id'), 'web-user-2');
});

test('復元: localStorage が空でも Keychain の匿名ID・チームを書き戻す', async () => {
    const storage = createFakeStorage();
    const plugin = createFakeKeychain({
        tw_user_id: 'user-from-keychain',
        player_team: 'white',
        tw_nickname: 'しょうだい',
        tw_transfer_code: 'ABCD2345'
    });
    const store = new TWIdentityStore({ storage, plugin });

    const result = await TWIdentity.bootstrap({ storage, store });

    assert.equal(result.restored, true);
    assert.equal(result.source, 'keychain');
    assert.equal(storage.getItem('tw_user_id'), 'user-from-keychain');
    assert.equal(storage.getItem('player_team'), 'white');
    assert.equal(storage.getItem('tw_nickname'), 'しょうだい');
    assert.equal(storage.getItem('tw_transfer_code'), 'ABCD2345');
});

test('復元: localStorage にIDがあれば通常起動（Keychain 側へ控えを取るだけ）', async () => {
    const storage = createFakeStorage({ tw_user_id: 'local-user', player_team: 'black' });
    const plugin = createFakeKeychain();
    const store = new TWIdentityStore({ storage, plugin });

    const result = await TWIdentity.bootstrap({ storage, store });

    assert.equal(result.restored, false);
    assert.equal(result.source, 'local');
    assert.equal(plugin.data.get('tw_user_id'), 'local-user', 'Keychain に控えを保存する');
    assert.equal(plugin.data.get('player_team'), 'black');
    assert.equal(storage.getItem('tw_user_id'), 'local-user');
});

test('復元: どこにもIDが無ければ新規として何もしない', async () => {
    const storage = createFakeStorage();
    const store = new TWIdentityStore({ storage, plugin: createFakeKeychain() });

    const result = await TWIdentity.bootstrap({ storage, store });

    assert.equal(result.restored, false);
    assert.equal(result.source, 'none');
    assert.equal(storage.getItem('tw_user_id'), null);
});

test('保存: 空の値では既存のIDを消さない', async () => {
    const storage = createFakeStorage();
    const plugin = createFakeKeychain({ tw_user_id: 'keep-me' });
    const store = new TWIdentityStore({ storage, plugin });

    await TWIdentity.persist({ userId: 'keep-me', team: 'black', nickname: null, transferCode: 'ABCD2345' }, { store, storage });

    assert.equal(plugin.data.get('tw_user_id'), 'keep-me');
    assert.equal(plugin.data.get('player_team'), 'black');
    assert.equal(plugin.data.get('tw_nickname'), undefined, '未設定の表示名は書かない');
    assert.equal(plugin.data.get('tw_transfer_code'), 'ABCD2345');
});

test('引き継ぎ内容: user_id / team / 戦績 / コイン / コードを書き込み、称号は外す', () => {
    const writes = TWIdentity.buildTransferStorageWrites({
        user_id: 'user-abc',
        nickname: '[街の開拓者] しょうだい',
        team: 'white',
        lifetime_tiles: 120,
        lifetime_reclaimed: 8,
        battles_won: 3,
        battles_lost: 1,
        coins: 450,
        transfer_code: 'abcd2345'
    });

    assert.equal(writes.set.tw_user_id, 'user-abc');
    assert.equal(writes.set.player_team, 'white');
    assert.equal(writes.set.tw_nickname, 'しょうだい');
    assert.equal(writes.set.tw_transfer_code, 'ABCD2345');
    assert.equal(writes.set.tw_coins, '450');
    assert.deepEqual(JSON.parse(writes.set.tw_user_stats), {
        lifetime_tiles: 120,
        lifetime_reclaimed: 8,
        battles_won: 3,
        battles_lost: 1
    });
});

test('引き継ぎ内容: 表示名が未設定（ユーザーID）なら nickname は消す指定になる', () => {
    const writes = TWIdentity.buildTransferStorageWrites({
        user_id: 'user-abc',
        nickname: 'user-abc',
        team: 'black',
        lifetime_tiles: 0
    });
    assert.equal(writes.set.tw_nickname, undefined);
    assert.ok(writes.remove.includes('tw_nickname'));
    assert.equal(writes.set.player_team, 'black');
    assert.ok(!('tw_coins' in writes.set), 'コイン未取得なら書き換えない');
    assert.equal(TWIdentity.buildTransferStorageWrites(null), null);
});

test('コード: 生成・正規化・表示整形・形式判定', () => {
    const code = TWIdentity.generateCode(() => 0.123456789);
    assert.equal(code.length, 8);
    assert.match(code, /^[A-Z2-9]+$/);
    assert.ok(!/[OI01]/.test(code), '見間違えやすい文字は使わない');

    assert.equal(TWIdentity.normalizeCode(' abcd-2345 '), 'ABCD2345');
    assert.equal(TWIdentity.formatCode('abcd2345'), 'ABCD-2345');
    assert.equal(TWIdentity.formatCode('ABC'), 'ABC');
    assert.equal(TWIdentity.isValidCode('ABCD-2345'), true);
    assert.equal(TWIdentity.isValidCode('ABC'), false);
    assert.equal(TWIdentity.normalizeCode('ABCDEFGHIJK').length, 10, '11文字以上は10文字で切る');
});

/* ------------------------------------------------------------------ *
 * 5. app.js: 起動時の配属・引き継ぎ実行（実際のメソッドを vm で動かす）
 * ------------------------------------------------------------------ */

function createAppContext(options = {}) {
    const storage = createFakeStorage(options.storage || {});
    const timers = [];
    const reloads = [];

    const elementStub = (id) => ({
        id,
        value: '',
        textContent: '',
        className: '',
        disabled: false,
        style: {},
        classList: { add() {}, remove() {}, contains: () => false },
        addEventListener() {}
    });

    const context = {
        console,
        URLSearchParams,
        Math,
        JSON,
        Date,
        Promise,
        Object,
        Array,
        Number,
        String,
        Boolean,
        RegExp,
        Error,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        localStorage: storage,
        navigator: { onLine: options.onLine !== false, clipboard: null },
        location: { search: options.search || '', reload: () => reloads.push(Date.now()) },
        window: { location: { search: options.search || '' }, addEventListener() {} },
        document: {
            addEventListener() {},
            getElementById: (id) => elementStub(id),
            querySelector: () => null,
            body: { dataset: {} }
        },
        alert: () => {},
        prompt: () => null,
        fetch: (...args) => (global.fetch ? global.fetch(...args) : Promise.reject(new Error('offline')))
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(IDENTITY_SOURCE, context, { filename: 'identity.js' });
    vm.runInContext(`${APP_SOURCE}\n;globalThis.__TerritoryWalkApp = TerritoryWalkApp;`, context, { filename: 'app.js' });
    return { context, App: context.__TerritoryWalkApp, storage, timers, reloads };
}

test('起動配属: 黒が少ないときは黒で始まり、ランダムに落ちない', async () => {
    const { context, App, storage } = createAppContext();
    const app = Object.create(App.prototype);
    app.supabaseManager = { fetchUserTeamCounts: async () => ({ black: 4, white: 12 }) };
    app.teamDecisionModalShown = false;

    const team = await app.decideInitialTeam();

    assert.equal(team, 'black');
    assert.equal(app.teamAssignedByBalance, true);
    assert.equal(app.teamBalanceCounts.white, 12);
    assert.ok(context);
});

test('起動配属: 白が少ないときは白。同数・失敗時はランダムへフォールバック', async () => {
    const { App } = createAppContext();

    const whiteApp = Object.create(App.prototype);
    whiteApp.supabaseManager = { fetchUserTeamCounts: async () => ({ black: 12, white: 3 }) };
    assert.equal(await whiteApp.decideInitialTeam(), 'white');

    const tieApp = Object.create(App.prototype);
    tieApp.supabaseManager = { fetchUserTeamCounts: async () => ({ black: 5, white: 5 }) };
    const tieTeam = await tieApp.decideInitialTeam();
    assert.ok(['black', 'white'].includes(tieTeam), '同数はランダム');
    assert.equal(tieApp.teamAssignedByBalance, false);

    const failApp = Object.create(App.prototype);
    failApp.supabaseManager = { fetchUserTeamCounts: async () => { throw new Error('boom'); } };
    const failTeam = await failApp.decideInitialTeam();
    assert.ok(['black', 'white'].includes(failTeam), '集計失敗はランダム');
    assert.equal(failApp.teamAssignedByBalance, false);
});

test('起動配属: URL の ?team= 指定は人数集計より優先する', async () => {
    const { App } = createAppContext({ search: '?team=white' });
    const app = Object.create(App.prototype);
    let called = false;
    app.supabaseManager = { fetchUserTeamCounts: async () => { called = true; return { black: 1, white: 9 }; } };

    assert.equal(await app.decideInitialTeam(), 'white');
    assert.equal(called, false, 'URL 指定時は集計しない');
});

test('引き継ぎ実行: DBの相手IDへ localStorage を切り替えて再起動する', async () => {
    const { context, App, storage, timers, reloads } = createAppContext({ storage: { tw_user_id: 'old-user', player_team: 'black' } });
    const app = Object.create(App.prototype);
    app.statsManager = { getOrCreateTransferCode: () => 'AAAA1111' };
    app.supabaseManager = {
        fetchUserByTransferCode: async () => ({
            ok: true,
            user: {
                user_id: 'user-abc',
                nickname: '[街の開拓者] しょうだい',
                team: 'white',
                lifetime_tiles: 120,
                lifetime_reclaimed: 8,
                battles_won: 3,
                battles_lost: 1,
                coins: 450,
                transfer_code: 'ABCD2345'
            }
        })
    };

    const result = await app.applyTransferCode('abcd-2345');

    assert.equal(result.success, true);
    assert.equal(storage.getItem('tw_user_id'), 'user-abc');
    assert.equal(storage.getItem('player_team'), 'white');
    assert.equal(storage.getItem('tw_nickname'), 'しょうだい');
    assert.equal(storage.getItem('tw_coins'), '450');
    assert.equal(storage.getItem('tw_transfer_code'), 'ABCD2345');
    assert.equal(JSON.parse(storage.getItem('tw_user_stats')).lifetime_tiles, 120);
    assert.ok(timers.some((timer) => timer.ms === 1200), '再起動を予約する');

    // 予約された再起動を実行すると location.reload が呼ばれる
    const reloadTimer = timers.find((timer) => timer.ms === 1200);
    reloadTimer.fn();
    assert.equal(reloads.length, 1);
    assert.ok(context);
});

test('引き継ぎ実行: 未入力・自分のコード・未登録コードは分かりやすく失敗する', async () => {
    const { App } = createAppContext();
    const app = Object.create(App.prototype);
    app.statsManager = { getOrCreateTransferCode: () => 'AAAA1111' };

    assert.equal((await app.applyTransferCode('')).success, false);
    assert.match((await app.applyTransferCode('  ')).message, /入力/);
    assert.match((await app.applyTransferCode('AAAA-1111')).message, /この端末/);
    assert.match((await app.applyTransferCode('ABC')).message, /6〜10文字/);

    app.supabaseManager = { fetchUserByTransferCode: async () => ({ ok: false, reason: 'not_found' }) };
    const notFound = await app.applyTransferCode('ZZZZ9999');
    assert.equal(notFound.success, false);
    assert.match(notFound.message, /見つかりません/);

    app.supabaseManager = { fetchUserByTransferCode: async () => ({ ok: false, reason: 'offline' }) };
    assert.match((await app.applyTransferCode('ZZZZ9999')).message, /オフライン/);

    app.supabaseManager = { fetchUserByTransferCode: async () => ({ ok: false, reason: 'not_ready' }) };
    assert.match((await app.applyTransferCode('ZZZZ9999')).message, /準備/);
});

/* ------------------------------------------------------------------ *
 * 6. iOS ネイティブプラグイン（Keychain）の組み込み
 * ------------------------------------------------------------------ */

test('iOS組み込み: Podfile に TWKeychain を1行だけ追加する（冪等）', () => {
    const podfile = [
        'platform :ios, \'15.0\'',
        'use_frameworks!',
        '',
        'def capacitor_pods',
        "  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'",
        'end',
        '',
        "target 'App' do",
        '  capacitor_pods',
        'end'
    ].join('\n');

    const first = configurePodfileKeychain(podfile);
    assert.equal(first.modified, true);
    assert.ok(first.content.includes(KEYCHAIN_POD_LINE));
    assert.deepEqual(verifyPodfileKeychain(first.content), []);

    const second = configurePodfileKeychain(first.content);
    assert.equal(second.modified, false, '2回目は何も変えない');
    assert.equal(first.content.split('TWKeychain').length - 1, 1, 'pod 行は1つだけ');
});

test('iOS組み込み: capacitor.config.json の packageClassList に登録する（冪等・他プラグインを壊さない）', () => {
    const config = JSON.stringify({
        webDir: '../../www',
        packageClassList: ['CAPGeolocationPlugin', 'SecureStoragePlugin']
    }, null, '\t');

    const first = configureCapacitorConfigContent(config, KEYCHAIN_PLUGIN_CLASS);
    assert.equal(first.modified, true);
    const parsed = JSON.parse(first.content);
    assert.deepEqual(parsed.packageClassList, ['CAPGeolocationPlugin', 'SecureStoragePlugin', KEYCHAIN_PLUGIN_CLASS]);
    assert.equal(parsed.webDir, '../../www', '他の設定は保つ');
    assert.deepEqual(verifyCapacitorConfigContent(first.content), []);

    const second = configureCapacitorConfigContent(first.content, KEYCHAIN_PLUGIN_CLASS);
    assert.equal(second.modified, false);

    const broken = configureCapacitorConfigContent('{ not json', KEYCHAIN_PLUGIN_CLASS);
    assert.equal(broken.error, 'invalid-json');
});

test('iOS組み込み: Swift プラグインは Keychain を直接使い、Capacitor 6 の登録形に従う', () => {
    const swift = fs.readFileSync(path.join(ROOT, 'ios-plugins', 'tw-keychain', 'Plugin', 'TWKeychainPlugin.swift'), 'utf8');
    assert.match(swift, /@objc\(TWKeychainPlugin\)/);
    assert.match(swift, /CAPBridgedPlugin/);
    assert.match(swift, /let jsName = "TWKeychain"/);
    assert.match(swift, /CAPPluginMethod\(name: "get"/);
    assert.match(swift, /CAPPluginMethod\(name: "set"/);
    assert.match(swift, /CAPPluginMethod\(name: "remove"/);
    assert.match(swift, /import Security/, 'Security.framework を直接使う（外部ライブラリ非依存）');
    assert.match(swift, /kSecClassGenericPassword/);
    assert.match(swift, /kSecAttrAccessibleAfterFirstUnlock/, 'バックグラウンドでも読める');
    assert.doesNotMatch(swift, /SwiftKeychainWrapper|KeychainSwift/, '追加の Keychain Pod に依存しない');

    const podspec = fs.readFileSync(path.join(ROOT, 'ios-plugins', 'tw-keychain', 'TWKeychain.podspec'), 'utf8');
    assert.match(podspec, /s\.name\s*=\s*'TWKeychain'/);
    assert.match(podspec, /s\.source_files\s*=\s*'Plugin\/\*\*\/\*\.swift'/);
    assert.match(podspec, /s\.dependency 'Capacitor'/);
    assert.match(podspec, /deployment_target\s*=\s*'15\.0'/, 'アプリの最低iOSと揃える');
});

test('iOS組み込み: configure-ios.js は Keychain の組み込みを実行し、失敗時は終了コード1', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-ios.js'), 'utf8');
    assert.match(source, /applyKeychainPlugin\(\)\.forEach/);
    assert.match(source, /capacitor\.config\.json/);
    assert.match(source, /process\.exitCode = 1/);
});

/* ------------------------------------------------------------------ *
 * 7. UI（MENU の「引き継ぎコード」）と SQL・www/ 同期
 * ------------------------------------------------------------------ */

test('MENU: 引き継ぎコードの表示・コピー・入力・実行ボタンがある', () => {
    const menuStart = INDEX_HTML.indexOf('id="menu-modal"');
    const menuHtml = INDEX_HTML.slice(menuStart, INDEX_HTML.indexOf('id="btn-close-menu"', menuStart));

    assert.ok(menuStart > 0);
    assert.match(menuHtml, /引き継ぎコード/);
    assert.match(menuHtml, /id="display-my-transfer-code"/);
    assert.match(menuHtml, /id="btn-copy-my-transfer-code"/);
    assert.match(menuHtml, /id="input-transfer-code"/);
    assert.match(menuHtml, /id="btn-apply-transfer-code"/);
    assert.match(menuHtml, /id="transfer-code-status"/);
    assert.match(INDEX_HTML, /<script src="identity\.js\?v=\d{8}v\d+"><\/script>/, 'identity.js を読み込む');
    assert.ok(
        INDEX_HTML.indexOf('identity.js') < INDEX_HTML.indexOf('app.js?v='),
        'identity.js は app.js より先に読み込む'
    );
});

test('app.js: 起動時に Keychain を復元してからアプリを生成する', () => {
    assert.match(APP_SOURCE, /TWIdentity\.bootstrap\(\)/);
    assert.match(APP_SOURCE, /window\.__twIdentityBootstrap/);
    assert.match(APP_SOURCE, /fetchUserTeamCounts/);
    assert.match(APP_SOURCE, /applyTransferCode\(rawCode\)/);
    assert.match(APP_SOURCE, /refreshTransferCodeUI/);
    assert.match(APP_SOURCE, /persistIdentity\(\)/);
});

test('SQL: 引き継ぎコード列・既存ユーザーへの払い出し・ユニークインデックス', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'transfer_code.sql'), 'utf8');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS transfer_code TEXT/);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_territory_users_transfer_code/);
    assert.match(sql, /UPDATE territory_users/);
    assert.match(sql, /WHERE transfer_code IS NULL/);
});

test('ビルド: identity.js が www/ へ同期され、index.html と一致する', () => {
    const buildSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build.js'), 'utf8');
    assert.match(buildSource, /'identity\.js'/);

    const wwwIdentity = path.join(ROOT, 'www', 'identity.js');
    if (fs.existsSync(wwwIdentity)) {
        assert.equal(fs.readFileSync(wwwIdentity, 'utf8'), IDENTITY_SOURCE, 'www/identity.js は identity.js と同一');
        assert.equal(
            fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8'),
            INDEX_HTML,
            'www/index.html は index.html と同一'
        );
    }
});
