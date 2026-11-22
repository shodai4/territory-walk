/**
 * TERRITORY WALK - Node tests
 * 2026-11-22 の集客改善2点。
 *
 *   1) ニックネーム（表示名）を設定しやすい導線
 *      - 未設定のあいだは #nickname-banner を出す（「あとで」「名前をつける」）
 *      - 「あとで」は端末に1キーだけ残して以後は出さない
 *      - 「名前をつける」は戦績モーダルのマイ戦績タブを開いて #input-nickname にフォーカス
 *      - 保存は既存の #btn-save-nickname と同じ処理を使い、保存後はバナーも隠す
 *      - 未入力のあいだは従来どおりユーザーID表示のまま（仮名を作らない）
 *   2) 「今週の戦果」「今の戦況」を SNS へシェアするボタン
 *      - 実データから文言を組み立て、App Store の短縮URLを添える
 *      - navigator.share 優先、無ければ X の投稿画面（twitter intent）へフォールバック
 *      - コインは付与しない（ボーナスは既存の1日1回シェアだけ）
 *      - X の280字（URLは23換算）に収まり、ハッシュタグが切られない
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readWwwAppSource, APP_SOURCE_FILES, readAppFile } = require('./helpers/app-sources');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const INDEX_HTML = read('index.html');
const WWW_HTML = read('www/index.html');
const APP_STORE_URL = 'https://apps.apple.com/jp/app/id6834676433';
const EXPECTED_TAGS = ['#テリウォーク', '#テリトリーウォーク', '#TerritoryWalk'];
const DISMISS_KEY = 'tw_nickname_banner_dismissed';
const TEST_USER_ID = '5f1c9a2e-8b7d-4c6a-9f30-1d2b3c4d5e6f';

/* ------------------------------------------------------------------ *
 * 小道具（文字数・タグ）
 * ------------------------------------------------------------------ */
function hashtagsIn(text) {
    return String(text).match(/#[^\s#]+/g) || [];
}

function countTag(text, tag) {
    return String(text).split(tag).length - 1;
}

/** X の加重文字数（全角2・URL 23） */
function xWeight(text) {
    const withoutUrl = String(text).replace(/https?:\/\/\S+/g, '');
    let weight = /https?:\/\/\S+/.test(String(text)) ? 23 : 0;
    for (const ch of withoutUrl) {
        const code = ch.codePointAt(0);
        const wide = (code >= 0x1100 && code <= 0x115f)
            || (code >= 0x2e80 && code <= 0xa4cf)
            || (code >= 0xac00 && code <= 0xd7a3)
            || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xfe30 && code <= 0xfe4f)
            || (code >= 0xff00 && code <= 0xff60)
            || (code >= 0xffe0 && code <= 0xffe6);
        weight += wide ? 2 : 1;
    }
    return weight;
}

/* ------------------------------------------------------------------ *
 * localStorage / DOM / vm のスタブ
 * ------------------------------------------------------------------ */
function createStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; }
    };
}

function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        set,
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name),
        toggle: (name, force) => {
            const on = typeof force === 'boolean' ? force : !set.has(name);
            if (on) set.add(name); else set.delete(name);
            return on;
        }
    };
}

function createElement(initialClasses = []) {
    const listeners = {};
    return {
        listeners,
        classList: createClassList(initialClasses),
        style: {},
        dataset: {},
        textContent: '',
        innerHTML: '',
        value: '',
        disabled: false,
        focused: false,
        scrolled: false,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        removeEventListener() {},
        click() {
            (listeners.click || []).forEach((handler) => handler({ target: this, preventDefault() {} }));
        },
        focus() { this.focused = true; },
        scrollIntoView() { this.scrolled = true; },
        getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 }; },
        setAttribute() {},
        getAttribute() { return null; }
    };
}

/**
 * app-*.js / stats.js / coins.js を1つの vm で読み、
 * 実コードのメソッドを載せたアプリ断片を返す。
 */
function createApp(options = {}) {
    const storage = options.storage || createStorage();
    const shared = { calls: [], opened: [] };
    const header = createElement();
    header.getBoundingClientRect = () => ({ top: 0, bottom: 96, height: 96, width: 390, left: 0, right: 390 });

    const elements = {
        'nickname-banner': createElement(['hidden']),
        'btn-nickname-later': createElement(),
        'btn-nickname-setup': createElement(),
        'stats-modal': createElement(['hidden']),
        'menu-modal': createElement(['hidden']),
        'input-nickname': createElement(),
        'btn-save-nickname': createElement(),
        'tab-my-stats': createElement(),
        'panel-my-stats': createElement(['hidden']),
        'tab-weekly-rank': createElement(),
        'panel-weekly-rank': createElement(['hidden']),
        'tab-lifetime-rank': createElement(),
        'panel-lifetime-rank': createElement(['hidden']),
        'stat-battles-record': createElement(),
        'battle-detail-content': createElement(['hidden']),
        'battle-detail-loading': createElement(),
        'battle-detail-empty': createElement(['hidden']),
        'battle-detail-extra-note': createElement(['hidden']),
        'battle-detail-source': createElement(),
        'battle-detail-week': createElement(),
        'btn-share-weekly-battle': createElement(['hidden'])
    };
    Object.entries(options.extraElements || {}).forEach(([id, el]) => { elements[id] = el; });

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById: (id) => elements[id] || null,
            querySelector: (selector) => (selector === 'header' ? header : null),
            querySelectorAll: () => [],
            createElement: () => createElement(),
            addEventListener() {},
            visibilityState: 'visible'
        },
        navigator: options.navigator || {},
        localStorage: storage,
        crypto: { randomUUID: () => TEST_USER_ID },
        setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        Date,
        JSON,
        Number,
        Math,
        String,
        Array,
        Object,
        Promise,
        screen: {}
    };
    const opened = shared.opened;
    sandbox.window = {
        open: (url, target) => { opened.push({ url, target }); return null; },
        addEventListener() {},
        document: sandbox.document,
        localStorage: storage,
        navigator: sandbox.navigator
    };
    sandbox.globalThis = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(read('stats.js'), context, { filename: 'stats.js' });
    vm.runInContext(read('coins.js'), context, { filename: 'coins.js' });
    APP_SOURCE_FILES.forEach((file) => {
        vm.runInContext(readAppFile(file), context, { filename: file });
    });
    vm.runInContext('globalThis.__CoinManager = CoinManager; globalThis.__StatsManager = StatsManager;', context);

    const app = vm.runInContext('Object.create(TerritoryWalkApp.prototype)', context);
    app.showToast = (message) => shared.calls.push(['toast', message]);
    app.coinAdds = [];
    app.coinManager = { addCoins: (amount, reason) => app.coinAdds.push([amount, reason]) };

    const statsManager = new context.__StatsManager(null, null);
    app.statsManager = statsManager;
    app.currentTeam = 'black';
    app.supabaseManager = {
        getCurrentWeekId: () => '2026-W47'
    };

    return { app, elements, storage, shared, context, header, statsManager };
}

/* ------------------------------------------------------------------ *
 * 1. 文言ビルダー（coins.js）
 * ------------------------------------------------------------------ */
test('文言: 今週の戦果はチーム・マス数・順位とApp Store URLを含む', () => {
    const { context } = createApp();
    const CoinManager = context.__CoinManager;

    const text = CoinManager.buildMyWeeklyResultShareText({ tiles: 1245, rank: 7, myTeam: 'black' });
    assert.match(text, /今週の戦果：1,245マス開拓（黒組）/);
    assert.match(text, /今週の順位は7位！/);
    assert.ok(text.includes(APP_STORE_URL), `App Store URL が無い:\n${text}`);
    assert.ok(text.includes('#テリウォーク'));
    assert.equal(countTag(text, '#テリウォーク'), 1);
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS);
});

test('文言: 0マスの日は「0マス」と晒さず、これから参戦の一文にする', () => {
    const { context } = createApp();
    const CoinManager = context.__CoinManager;

    const text = CoinManager.buildMyWeeklyResultShareText({ tiles: 0, rank: null, myTeam: 'white' });
    assert.match(text, /今週はここから参戦（白組）/);
    assert.ok(!/0マス/.test(text), '0マスとは書かない');
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS);
});

test('文言: 今の戦況は黒白％・マス数・参加人数・自分の貢献を含む', () => {
    const { context } = createApp();
    const CoinManager = context.__CoinManager;

    const text = CoinManager.buildWeeklyBattleShareText({
        blackPct: 62,
        whitePct: 38,
        blackTiles: 6200,
        whiteTiles: 3800,
        totalPlayers: 128,
        myTeam: 'black',
        myTiles: 340
    });

    assert.match(text, /今週の戦況：黒 62%（6,200マス）vs 白 38%（3,800マス）/);
    assert.match(text, /全国 128人が参戦中/);
    assert.match(text, /私は黒組で 340マス貢献/);
    assert.ok(text.includes(APP_STORE_URL));
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS);
});

test('文言: 自分が未参加でも戦況は共有できる（チームで参戦中の一文）', () => {
    const { context } = createApp();
    const CoinManager = context.__CoinManager;

    const text = CoinManager.buildWeeklyBattleShareText({
        blackPct: 50, whitePct: 50, blackTiles: 0, whiteTiles: 0, totalPlayers: 0, myTeam: 'white', myTiles: 0
    });
    assert.match(text, /白組で参戦中/);
    assert.ok(!/全国 0人/.test(text), '0人のときは参加人数を書かない');
});

test('文言: X の280字（URLは23換算）に収まり、タグが切られない', () => {
    const { context } = createApp();
    const CoinManager = context.__CoinManager;

    const texts = {
        mine: CoinManager.buildMyWeeklyResultShareText({ tiles: 9999, rank: 9999, myTeam: 'white' }),
        battle: CoinManager.buildWeeklyBattleShareText({
            blackPct: 100,
            whitePct: 0,
            blackTiles: 999999,
            whiteTiles: 999999,
            totalPlayers: 999999,
            myTeam: 'white',
            myTiles: 999999
        })
    };

    Object.entries(texts).forEach(([kind, text]) => {
        const weight = xWeight(text);
        assert.ok(weight <= 280, `${kind} が ${weight} で上限超過（タグが切れる）`);
        assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS, `${kind} のタグが欠けている`);
    });
});

/* ------------------------------------------------------------------ *
 * 2. 共有ヘルパー（共有シート優先・Xフォールバック）
 * ------------------------------------------------------------------ */
test('共有: navigator.share があればシェアシートを開き、Xは開かない', async () => {
    const sharedPayloads = [];
    const { context, shared } = createApp({
        navigator: { share: (payload) => { sharedPayloads.push(payload); return Promise.resolve(); } }
    });
    const CoinManager = context.__CoinManager;

    const result = await CoinManager.shareText('テスト本文', 'タイトル');

    assert.equal(result, true);
    assert.equal(sharedPayloads.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(sharedPayloads[0])), { title: 'タイトル', text: 'テスト本文' });
    assert.equal(shared.opened.length, 0, 'フォールバックのXは開かない');
});

test('共有: シェアシートが無ければ twitter intent を開く', async () => {
    const { context, shared } = createApp({ navigator: {} });
    const CoinManager = context.__CoinManager;

    const result = await CoinManager.shareText('本文 #テリウォーク');

    assert.equal(result, true);
    assert.equal(shared.opened.length, 1);
    const url = new URL(shared.opened[0].url);
    assert.equal(url.hostname, 'twitter.com');
    assert.equal(url.pathname, '/intent/tweet');
    assert.equal(url.searchParams.get('text'), '本文 #テリウォーク');
});

test('共有: ユーザーがシェアシートを閉じただけならXを開かない', async () => {
    const abort = new Error('cancel');
    abort.name = 'AbortError';
    const { context, shared } = createApp({ navigator: { share: () => Promise.reject(abort) } });
    const CoinManager = context.__CoinManager;

    const result = await CoinManager.shareText('本文');

    assert.equal(result, false);
    assert.equal(shared.opened.length, 0, 'キャンセルで勝手にXへ飛ばさない');
});

test('共有: シェアシートが失敗したらXへフォールバックする', async () => {
    const { context, shared } = createApp({ navigator: { share: () => Promise.reject(new Error('not allowed')) } });
    const CoinManager = context.__CoinManager;

    const result = await CoinManager.shareText('本文');

    assert.equal(result, true);
    assert.equal(shared.opened.length, 1);
});

/* ------------------------------------------------------------------ *
 * 3. 画面からの配線（実データ・コイン付与なし）
 * ------------------------------------------------------------------ */
test('配線: マイ戦績のシェアは今週のマス数・順位を実データから組み立てる', async () => {
    const { app, context, shared } = createApp();
    const payloads = [];
    // vm の navigator を差し替えて共有内容を捕まえる
    context.navigator.share = (payload) => { payloads.push(payload); return Promise.resolve(); };

    app.currentTeam = 'white';
    app.statsManager = {
        getMyWeeklyRank: async (weekId) => {
            assert.equal(weekId, '2026-W47');
            return { rank: 3, tilesCount: 512, text: '3位 (512マス)' };
        }
    };

    const result = await app.shareMyWeeklyResult();

    assert.equal(result, true);
    assert.equal(payloads.length, 1);
    assert.match(payloads[0].text, /今週の戦果：512マス開拓（白組）/);
    assert.match(payloads[0].text, /今週の順位は3位！/);
    assert.ok(payloads[0].text.includes(APP_STORE_URL));
    assert.deepEqual(app.coinAdds, [], 'シェアでコインは付与しない');
    assert.ok(shared.calls.some(([kind, message]) => kind === 'toast' && /共有画面/.test(message)));
});

test('配線: 戦況詳細のシェアは画面と同じ％と参加人数を使う', async () => {
    const { app, elements, context } = createApp();
    const payloads = [];
    context.navigator.share = (payload) => { payloads.push(payload); return Promise.resolve(); };

    app.currentTeam = 'black';
    app.globalTeamCounts = { black: 600, white: 400, loaded: true };
    app.statsManager = { getMyWeeklyRank: async () => ({ rank: 4, tilesCount: 42 }) };

    app.renderWeeklyBattleDetail({
        ok: true,
        weekId: '2026-W47',
        blackPlayers: 6,
        whitePlayers: 4,
        playerTotal: 10,
        participantTiles: 900
    });

    assert.equal(elements['btn-share-weekly-battle'].classList.contains('hidden'), false, '集計が出たら共有ボタンを出す');

    await app.shareWeeklyBattle();

    assert.equal(payloads.length, 1);
    assert.match(payloads[0].text, /今週の戦況：黒 60%（600マス）vs 白 40%（400マス）/);
    assert.match(payloads[0].text, /全国 10人が参戦中/);
    assert.match(payloads[0].text, /私は黒組で 42マス貢献/);
    assert.deepEqual(app.coinAdds, [], 'シェアでコインは付与しない');
});

test('配線: 集計が空の週は戦況の共有ボタンを出さない', () => {
    const { app, elements } = createApp();
    app.globalTeamCounts = { black: 0, white: 0, loaded: true };

    app.renderWeeklyBattleDetail({ ok: true, blackPlayers: 0, whitePlayers: 0, playerTotal: 0, participantTiles: 0 });

    assert.equal(elements['btn-share-weekly-battle'].classList.contains('hidden'), true);
    assert.equal(app.weeklyBattleDetailSummary, null);
});

/* ------------------------------------------------------------------ *
 * 4. 表示名バナー（未設定時はID表示を維持）
 * ------------------------------------------------------------------ */
test('バナー: 未設定なら出し、表示名はユーザーIDのまま（仮名を作らない）', () => {
    const { app, elements, statsManager } = createApp();

    app.initNicknameBanner();

    assert.equal(elements['nickname-banner'].classList.contains('hidden'), false, '未設定なら出す');
    assert.equal(statsManager.nickname, TEST_USER_ID, '表示名はユーザーIDのまま');
    assert.equal(statsManager.getFormattedDisplayName(), TEST_USER_ID);
    assert.equal(statsManager.hasCustomNickname(), false);
    assert.equal(elements['nickname-banner'].style.top, '104px', 'ヘッダー実測（96px）の直下に置く');
});

test('バナー: 設定済みの人には出さない', () => {
    const { app, elements } = createApp({ storage: createStorage({ tw_nickname: 'しょうだい' }) });

    app.initNicknameBanner();

    assert.equal(elements['nickname-banner'].classList.contains('hidden'), true);
});

test('バナー: 「あとで」は端末に1キー残し、以後は出さない', () => {
    const { app, elements, storage } = createApp();

    app.initNicknameBanner();
    elements['btn-nickname-later'].click();

    assert.equal(elements['nickname-banner'].classList.contains('hidden'), true);
    assert.equal(storage.getItem(DISMISS_KEY), 'true');
    assert.equal(storage.getItem('tw_nickname'), null, '「あとで」で名前は作らない');
});

test('バナー: 「あとで」済みの端末では起動時から出さない', () => {
    const { app, elements } = createApp({ storage: createStorage({ [DISMISS_KEY]: 'true' }) });

    app.initNicknameBanner();

    assert.equal(elements['nickname-banner'].classList.contains('hidden'), true);
});

test('バナー: 「名前をつける」はマイ戦績タブを開いて入力欄にフォーカスする', () => {
    const { app, elements } = createApp();

    app.initNicknameBanner();
    elements['btn-nickname-setup'].click();

    assert.equal(elements['stats-modal'].classList.contains('hidden'), false, '戦績モーダルを開く');
    assert.equal(elements['panel-my-stats'].classList.contains('hidden'), false, 'マイ戦績タブ');
    assert.match(elements['tab-my-stats'].className || '', /active/, 'マイ戦績タブを選択状態にする');
    assert.equal(elements['input-nickname'].focused, true, '入力欄にフォーカス');
    assert.equal(elements['nickname-banner'].classList.contains('hidden'), true, '押したらバナーは引っ込む');
});

test('バナー: 保存するとバナーも隠れ、表示名が変わる', async () => {
    const { app, elements, statsManager } = createApp();
    app.initNicknameBanner();
    assert.equal(elements['nickname-banner'].classList.contains('hidden'), false);

    elements['input-nickname'].value = '  しょうだい  ';
    await app.saveNicknameFromInput();

    assert.equal(statsManager.getFormattedDisplayName(), 'しょうだい');
    assert.equal(elements['nickname-banner'].classList.contains('hidden'), true);
});

test('バナー: 保存処理は入力欄の保存ボタンと共通（配線）', () => {
    const stats = read('app-stats.js');
    assert.match(stats, /saveNickBtn\.addEventListener\('click', \(\) => this\.saveNicknameFromInput\(\)\)/);
    assert.match(stats, /async saveNicknameFromInput\(\)/);
    assert.match(stats, /this\.initNicknameBanner\(\)/);
});

test('バナー: 仮名（「散歩人#123」など）を組み立てない', () => {
    ['index.html', 'app-stats.js', 'stats.js', 'coins.js'].forEach((file) => {
        const source = read(file);
        // 「初級散歩人」のような称号は残ってよい。仮名の生成（散歩人#123・散歩人${n}）だけを見る
        assert.doesNotMatch(source, /散歩人\s*#|散歩人\$\{/, `${file} に仮名の生成がある`);
        assert.doesNotMatch(source, /walkername|anonymous#/i, `${file} に仮名っぽい生成がある`);
    });
});

/* ------------------------------------------------------------------ *
 * 5. 画面の要素と www/ 反映
 * ------------------------------------------------------------------ */
test('画面: バナー・シェアボタンの要素と文言が揃っている', () => {
    ['nickname-banner', 'btn-nickname-later', 'btn-nickname-setup',
        'btn-stats-share-weekly', 'btn-share-weekly-battle'].forEach((id) => {
        assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `${id} がある`);
        assert.match(WWW_HTML, new RegExp(`id="${id}"`), `${id} が www/ にも反映される`);
    });

    assert.match(INDEX_HTML, /表示名を設定できます/);
    assert.match(INDEX_HTML, /あとで/);
    assert.match(INDEX_HTML, /名前をつける/);
    assert.match(INDEX_HTML, /今週の戦果をシェア/);
    assert.match(INDEX_HTML, /今の戦況をシェア/);
});

test('画面: 未設定時のバナーはID表示のままであることを明記する', () => {
    const banner = /<div id="nickname-banner"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(INDEX_HTML);
    assert.ok(banner, 'バナーが見つからない');
    assert.match(banner[0], /未設定はIDのまま/);
});

test('画面: バナーは「あとで」「名前をつける」の順に並ぶ', () => {
    const later = INDEX_HTML.indexOf('id="btn-nickname-later"');
    const setup = INDEX_HTML.indexOf('id="btn-nickname-setup"');
    assert.ok(later > 0 && setup > later, '「あとで」→「名前をつける」の順');
});

test('www/: シェアのビルダーとバナー制御がビルド成果物にも入る', () => {
    const wwwStats = readWwwAppSource();
    assert.match(wwwStats, /initNicknameBanner\(/);
    assert.match(wwwStats, /buildMyWeeklyResultShareText\(/);
    assert.match(read('www/app-battle.js'), /buildWeeklyBattleShareText\(/);
    assert.match(read('www/coins.js'), /apps\.apple\.com\/jp\/app\/id6834676433/);
});

test('配線: 文言は coins.js の共通ビルダーだけを使う', () => {
    const stats = read('app-stats.js');
    const battle = read('app-battle.js');
    assert.match(stats, /CoinManager\.buildMyWeeklyResultShareText\(/);
    assert.match(battle, /CoinManager\.buildWeeklyBattleShareText\(/);
    assert.match(stats, /CoinManager\.shareText\(/);
    assert.match(battle, /CoinManager\.shareText\(/);
    assert.doesNotMatch(stats, /https:\/\/apps\.apple\.com/, 'URLを画面側へ直書きしない');
    assert.doesNotMatch(battle, /https:\/\/apps\.apple\.com/, 'URLを画面側へ直書きしない');
});

test('キャッシュバスター: 変更したファイルは新しい版を指す', () => {
    assert.match(INDEX_HTML, /coins\.js\?v=20261122v56/);
    assert.match(INDEX_HTML, /app-stats\.js\?v=20261122v67/);
    assert.match(INDEX_HTML, /app-battle\.js\?v=20261122v67/);
    assert.match(WWW_HTML, /app-stats\.js\?v=20261122v67/);
});
