/**
 * TERRITORY WALK - Node tests
 * AdMob 本番IDの組み込みと「テスト広告 / 本番広告」の切り替え（無効トラフィック対策）。
 *
 *   1) 本番ID（App ID / バナー / リワード）が admob.js に正しく入っている
 *   2) Google のサンプル（テスト）ユニットIDが残っていない
 *   3) CONFIG.ENABLE_DEBUG_TOOLS が true の間は isTesting: true（テスト広告）で
 *      initialize / リワード / バナーの全リクエストを送る
 *   4) false に切り替えた瞬間に isTesting: false（本番広告）へ自動で切り替わる
 *   5) CONFIG が無い環境は安全側（テスト広告）に倒れる
 *   6) Info.plist の GADApplicationIdentifier（configure-ios.js）が本番 App ID と一致し、
 *      サンプル App ID は書き換えられる
 *   7) index.html のキャッシュバスターと www/ の同期
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMOB_SOURCE = fs.readFileSync(path.join(ROOT, 'admob.js'), 'utf8');
const { CONFIG_ENTRIES } = require(path.join(ROOT, 'scripts', 'configure-ios.js'));

/** 2026-11-15 に AdMob 管理画面から発行された本番ID */
const PROD_APP_ID = 'ca-app-pub-5739782559889389~3477680072';
const PROD_BANNER_ID = 'ca-app-pub-5739782559889389/9566456603';
const PROD_REWARD_ID = 'ca-app-pub-5739782559889389/9650217089';

/* ------------------------------------------------------------------ *
 * スタブ（jsdom を使わず、admob.js が触る最小限の DOM と Capacitor だけ用意する）
 * ------------------------------------------------------------------ */
function createPluginCalls() {
    return {
        initialize: [],
        prepareRewardVideoAd: [],
        showBanner: [],
        hideBanner: 0,
        removeBanner: 0,
        showRewardVideoAd: 0
    };
}

function createElement(id) {
    return {
        id,
        classList: {
            _classes: new Set(),
            add(name) { this._classes.add(name); },
            remove(name) { this._classes.delete(name); },
            contains(name) { return this._classes.has(name); },
            toggle(name, force) {
                const on = force === undefined ? !this._classes.has(name) : !!force;
                if (on) this._classes.add(name);
                else this._classes.delete(name);
                return on;
            }
        }
    };
}

/**
 * admob.js を vm で読み込み、AdMobManager を動かせる環境を返す。
 * @param {{ config?: any, native?: boolean }} options
 */
function createHarness(options = {}) {
    const calls = createPluginCalls();
    const plugin = {
        async initialize(opts) { calls.initialize.push(opts); },
        async prepareRewardVideoAd(opts) { calls.prepareRewardVideoAd.push(opts); },
        async showBanner(opts) { calls.showBanner.push(opts); },
        async hideBanner() { calls.hideBanner += 1; },
        async removeBanner() { calls.removeBanner += 1; },
        async showRewardVideoAd() { calls.showRewardVideoAd += 1; },
        addListener() { return { remove() {} }; }
    };

    const elements = new Map();
    const body = {
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; }
    };

    const native = options.native !== false;
    const context = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            body,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, createElement(id));
                return elements.get(id);
            }
        },
        window: {
            Capacitor: {
                isNativePlatform: () => native,
                Plugins: native ? { AdMob: plugin } : {}
            }
        }
    };
    if (Object.prototype.hasOwnProperty.call(options, 'config')) {
        context.CONFIG = options.config;
    }

    vm.createContext(context);
    vm.runInContext(
        `${ADMOB_SOURCE}\n;globalThis.__twAdMob = { AdMobManager, ADMOB_AD_UNITS, ADMOB_TESTING_DEVICES, isAdMobTestingMode };`,
        context
    );

    const api = context.__twAdMob;
    const app = { coinManager: { isAdFree: () => false } };
    const manager = new api.AdMobManager(app, { deferInit: true });

    return { context, api, manager, calls, body, elements, app };
}

/* ------------------------------------------------------------------ *
 * 1. 本番IDの組み込み
 * ------------------------------------------------------------------ */
test('本番ID: App ID / バナー / リワードが admob.js にそのまま入っている', () => {
    const { api } = createHarness();

    assert.equal(api.ADMOB_AD_UNITS.appId, PROD_APP_ID);
    assert.equal(api.ADMOB_AD_UNITS.banner, PROD_BANNER_ID);
    assert.equal(api.ADMOB_AD_UNITS.reward, PROD_REWARD_ID);

    // AdMob のID形式（アプリIDは ~、広告ユニットは /）
    assert.match(api.ADMOB_AD_UNITS.appId, /^ca-app-pub-\d{16}~\d{10}$/);
    assert.match(api.ADMOB_AD_UNITS.banner, /^ca-app-pub-\d{16}\/\d{10}$/);
    assert.match(api.ADMOB_AD_UNITS.reward, /^ca-app-pub-\d{16}\/\d{10}$/);
});

test('本番ID: バナーとリワードは別ユニット（取り違えていない）', () => {
    const { api } = createHarness();
    assert.notEqual(api.ADMOB_AD_UNITS.banner, api.ADMOB_AD_UNITS.reward);
    assert.notEqual(api.ADMOB_AD_UNITS.banner.split('/')[0], 'ca-app-pub-3940256099942544');
});

test('旧サンプルID: Google のテスト用ユニットIDがコードに残っていない', () => {
    const files = ['admob.js', 'index.html', 'scripts/configure-ios.js'];
    for (const file of files) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(source, /ca-app-pub-3940256099942544/, `${file} に Google サンプルIDが残っている`);
    }
});

test('本番ID: リワード動画のリクエストは本番ユニットIDを使う', async () => {
    const { manager } = createHarness({ config: { ENABLE_DEBUG_TOOLS: false } });

    assert.equal(manager.rewardAdId, PROD_REWARD_ID);
    assert.equal(manager.bannerAdId, PROD_BANNER_ID);
});

/* ------------------------------------------------------------------ *
 * 2. ENABLE_DEBUG_TOOLS 連動（無効トラフィック対策）
 * ------------------------------------------------------------------ */
test('テストモード: ENABLE_DEBUG_TOOLS=true なら isTesting=true で全リクエストを送る', async () => {
    const { manager, calls } = createHarness({ config: { ENABLE_DEBUG_TOOLS: true } });

    assert.equal(manager.isTesting, true);

    await manager.init();
    assert.equal(calls.initialize.length, 1);
    assert.equal(calls.initialize[0].initializeForTesting, true);
    assert.equal(calls.initialize[0].requestTrackingAuthorization, true);
    assert.ok(Array.isArray(calls.initialize[0].testingDevices));
    assert.ok(calls.initialize[0].testingDevices.length > 0, 'テストデバイスを登録する');

    // init() の中でバナー表示とリワード先読みまで走る
    assert.equal(calls.showBanner.length, 1);
    assert.equal(calls.showBanner[0].isTesting, true, 'テスト中はテスト広告を要求');
    assert.equal(calls.prepareRewardVideoAd.length, 1);
    assert.equal(calls.prepareRewardVideoAd[0].isTesting, true, 'リワードもテスト広告を要求');

    // 本番ユニットIDは admob.js に残したまま、isTesting でテスト広告に差し替えさせる
    assert.equal(calls.showBanner[0].adId, PROD_BANNER_ID);
    assert.equal(calls.prepareRewardVideoAd[0].adId, PROD_REWARD_ID);
});

test('本番モード: ENABLE_DEBUG_TOOLS=false なら isTesting=false で本番広告を要求する', async () => {
    const { manager, calls } = createHarness({ config: { ENABLE_DEBUG_TOOLS: false } });

    assert.equal(manager.isTesting, false);

    await manager.init();
    assert.equal(calls.initialize[0].initializeForTesting, false);
    assert.equal('testingDevices' in calls.initialize[0], false, '本番ではテストデバイスを登録しない');
    assert.equal(calls.showBanner[0].isTesting, false);
    assert.equal(calls.prepareRewardVideoAd[0].isTesting, false);
    assert.equal(calls.showBanner[0].adId, PROD_BANNER_ID);
    assert.equal(calls.prepareRewardVideoAd[0].adId, PROD_REWARD_ID);
});

test('切り替え1か所: CONFIG.ENABLE_DEBUG_TOOLS を false にした瞬間から本番広告になる', async () => {
    const harness = createHarness({ config: { ENABLE_DEBUG_TOOLS: true } });
    const { manager, calls, context } = harness;

    await manager.init();
    assert.equal(calls.prepareRewardVideoAd[0].isTesting, true);

    // app.js のフラグを書き換えるだけで、AdMobManager は作り直さずに本番へ移る
    context.CONFIG.ENABLE_DEBUG_TOOLS = false;
    assert.equal(manager.isTesting, false);

    await manager.preloadRewardVideo();
    const latest = calls.prepareRewardVideoAd[calls.prepareRewardVideoAd.length - 1];
    assert.equal(latest.isTesting, false, 'フラグ変更後は本番リクエスト');
    assert.equal(latest.adId, PROD_REWARD_ID);
});

test('安全側: CONFIG が無い環境ではテスト広告に倒す（誤って本番広告を出さない）', () => {
    const { manager, api } = createHarness();
    assert.equal(api.isAdMobTestingMode(), true);
    assert.equal(manager.isTesting, true);
});

test('Webブラウザ: ネイティブでなければ AdMob を呼ばず、Webシミュレータに任せる', async () => {
    const { manager, calls } = createHarness({ config: { ENABLE_DEBUG_TOOLS: true }, native: false });

    await manager.init();
    assert.equal(calls.initialize.length, 0);
    assert.equal(calls.showBanner.length, 0);

    let simulated = 0;
    const app = { coinManager: { showRewardAdModal: (cb) => { simulated += 1; cb(); } } };
    manager.app = app;
    manager.showRewardVideo(() => {});
    assert.equal(simulated, 1);
});

/* ------------------------------------------------------------------ *
 * 3. Info.plist（GADApplicationIdentifier）との整合
 * ------------------------------------------------------------------ */
test('Info.plist: GADApplicationIdentifier は本番 App ID を「値で」固定する', () => {
    const entry = CONFIG_ENTRIES.find((item) => item.key === 'GADApplicationIdentifier');
    assert.ok(entry, 'GADApplicationIdentifier の設定がある');
    assert.equal(entry.mode, 'value', 'presence ではなく value（違えば書き換える）');
    assert.match(entry.value, /^<string>ca-app-pub-\d{16}~\d{10}<\/string>$/);
    assert.ok(entry.value.includes(PROD_APP_ID));
});

test('Info.plist: App ID は admob.js の本番 App ID と一致する', () => {
    const { api } = createHarness();
    const entry = CONFIG_ENTRIES.find((item) => item.key === 'GADApplicationIdentifier');
    assert.equal(entry.value, `<string>${api.ADMOB_AD_UNITS.appId}</string>`);
});

test('Info.plist: AdMob に必要な NSUserTrackingUsageDescription と SKAdNetworkItems がある', () => {
    const keys = CONFIG_ENTRIES.map((item) => item.key);
    assert.ok(keys.includes('NSUserTrackingUsageDescription'), 'ATT の説明文');
    assert.ok(keys.includes('SKAdNetworkItems'), 'SKAdNetwork の配列');
});

/* ------------------------------------------------------------------ *
 * 4. 配線（キャッシュバスター / www 同期）
 * ------------------------------------------------------------------ */
test('配線: index.html は admob.js を新しいバージョンで読み、www/ と同期されている', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const wwwHtml = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
    const wwwAdmob = fs.readFileSync(path.join(ROOT, 'www', 'admob.js'), 'utf8');

    assert.match(html, /admob\.js\?v=\d{8}v\d+/, 'キャッシュバスター付きで読み込む');
    assert.match(html, /admob\.js\?v=20261115v51/, '今回の更新版に上がっている');
    assert.equal(wwwAdmob, ADMOB_SOURCE, 'www/admob.js は admob.js と同一（npm run build で同期）');
    assert.match(wwwHtml, /admob\.js\?v=20261115v51/);
});
