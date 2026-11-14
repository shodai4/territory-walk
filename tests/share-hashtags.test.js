/**
 * TERRITORY WALK - Node tests
 * X（旧Twitter）シェア文言のハッシュタグを固める。
 *
 * 2026年11月15日、翔大さんの指示「エックスの共有でのハッシュタグも #テリウォーク 増やしといて」。
 * ホーム画面の表示名を『テリウォーク』へ短縮したのと対で、投稿からも短い名前で
 * 見つけてもらえるようにする。
 *
 *   1) 共通ハッシュタグの定義（#テリウォーク を含む・重複なし）
 *   2) 3種類のシェア文言（戦績／招待／週次リザルト）すべてに #テリウォーク が入る
 *   3) 同じタグを二度書かない（本文側に書かれていても二重にならない）
 *   4) X の文字数上限（280・全角2換算＋URLは23）に収まり、タグが切り捨てられない
 *   5) 実際の X シェア（shareToX）が組み立てる URL に #テリウォーク が乗る
 *   6) ポスター画像の共有文言にも #テリウォーク が入る
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const NEW_TAG = '#テリウォーク';
const EXPECTED_TAGS = [NEW_TAG, '#テリトリーウォーク', '#TerritoryWalk'];
const SHARE_URL = 'https://shodai4.github.io/territory-walk/';

/** 文言中のハッシュタグを出現順に取り出す（重複もそのまま残す） */
function hashtagsIn(text) {
    return String(text).match(/#[^\s#]+/g) || [];
}

/** 出現回数 */
function countTag(text, tag) {
    return String(text).split(tag).length - 1;
}

/** X の加重文字数（日本語などの全角は2、URL は23として数える） */
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
 * coins.js を読み込む（DOM は最小スタブ）
 * ------------------------------------------------------------------ */
function loadCoinManager() {
    const storage = {};
    const opened = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            querySelector: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
            addEventListener() {},
            removeEventListener() {}
        },
        window: {
            open: (url) => {
                opened.push(url);
                return null;
            }
        },
        navigator: {},
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        confirm: () => true,
        alert() {},
        prompt: () => ''
    });

    vm.runInContext(read('coins.js'), context, { filename: 'coins.js' });
    const CoinManager = vm.runInContext('CoinManager', context);

    const app = {
        showToast() {},
        currentTeam: 'black',
        statsManager: {
            stats: { lifetime_tiles: 123 },
            unlockedTitles: [],
            activeTitle: '',
            getOrCreateReferralCode: () => 'ABC123'
        }
    };
    const manager = new CoinManager(app, null);
    app.coinManager = manager;
    // シェア URL 生成だけを見たいので、コイン加算と再描画は差し替える
    manager.addCoins = () => {};
    manager.renderEarnPanel = () => {};

    return { CoinManager, manager, app, opened, storage };
}

/* ------------------------------------------------------------------ *
 * 1. 共通のハッシュタグ定義
 * ------------------------------------------------------------------ */
test('ハッシュタグ: 共通定義に #テリウォーク が入り、重複も抜けもない', () => {
    const { CoinManager } = loadCoinManager();
    // vm の別レルムで生成された配列なので、比較は素の配列に写してから行う
    const tags = Array.from(CoinManager.getShareHashtags());

    assert.deepEqual(tags, EXPECTED_TAGS, '短い名前 → これまでの名前 → 英字の順で固定');
    assert.equal(new Set(tags).size, tags.length, '同じタグを二度定義しない');
    assert.equal(CoinManager.getShareHashtagLine(), EXPECTED_TAGS.join(' '));
});

/* ------------------------------------------------------------------ *
 * 2. 3種類のシェア文言
 * ------------------------------------------------------------------ */
test('シェア文言: 戦績（毎日）の文言に #テリウォーク が入る', () => {
    const { CoinManager } = loadCoinManager();
    const text = CoinManager.buildDailyShareText({ tiles: 123, myTeam: 'Black (黒)', code: 'ABC123' });

    assert.ok(text.includes(NEW_TAG), `#テリウォーク が無い:\n${text}`);
    assert.match(text, /123 マス開拓中/);
    assert.match(text, /招待コード: ABC123/);
    assert.match(text, /Black \(黒\)/);
    assert.equal(countTag(text, NEW_TAG), 1, '#テリウォーク は1回だけ');
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS, 'タグは3つで重複なし');
});

test('シェア文言: 友達招待の文言に #テリウォーク が入る', () => {
    const { CoinManager } = loadCoinManager();
    const text = CoinManager.buildReferralShareText({ code: 'ABC123' });

    assert.ok(text.includes(NEW_TAG), `#テリウォーク が無い:\n${text}`);
    assert.match(text, /招待コード【ABC123】/);
    assert.match(text, /\+150 COIN/);
    assert.equal(countTag(text, NEW_TAG), 1);
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS);
});

test('シェア文言: 週次シーズン結果の文言に #テリウォーク が入る', () => {
    const { CoinManager } = loadCoinManager();
    const text = CoinManager.buildWeeklyResultShareText({
        teamName: 'BLACK',
        outcomeText: '勝利陣営！',
        blackPct: 52,
        whitePct: 48,
        tiles: 321,
        inviteCode: 'ABC123'
    });

    assert.ok(text.includes(NEW_TAG), `#テリウォーク が無い:\n${text}`);
    assert.match(text, /所属: BLACKチーム \(勝利陣営！\)/);
    assert.match(text, /最終制圧比率: Black 52% vs White 48%/);
    assert.match(text, /個人開拓貢献: 321マス/);
    assert.equal(countTag(text, NEW_TAG), 1);
    assert.deepEqual(hashtagsIn(text), EXPECTED_TAGS);
});

/* ------------------------------------------------------------------ *
 * 3. 二重付与の防止
 * ------------------------------------------------------------------ */
test('シェア文言: 本文側に同じタグが書かれていても二重にならない', () => {
    const { CoinManager } = loadCoinManager();
    const body = 'テスト投稿 #テリウォーク #テリトリーウォーク #TerritoryWalk\n#テリウォーク #TerritoryWalk';
    const text = CoinManager.withShareHashtags(body);

    EXPECTED_TAGS.forEach((tag) => {
        assert.equal(countTag(text, tag), 1, `${tag} が二重に出ている:\n${text}`);
    });
    assert.match(text, /^テスト投稿/, '本文は残す');
    assert.ok(text.endsWith(CoinManager.getShareHashtagLine()), '末尾にタグ行を1つだけ置く');
});

test('シェア文言: 本文が空でもタグ行だけで壊れない', () => {
    const { CoinManager } = loadCoinManager();
    const text = CoinManager.withShareHashtags('');
    assert.equal(text, CoinManager.getShareHashtagLine());
    assert.equal(countTag(text, NEW_TAG), 1);
});

/* ------------------------------------------------------------------ *
 * 4. X の文字数上限（タグが切り捨てられない）
 * ------------------------------------------------------------------ */
test('シェア文言: X の280字（URLは23換算）に収まり、タグが切られない', () => {
    const { CoinManager } = loadCoinManager();
    // 実機で取り得る最大寄りの値（4桁マス・長い陣営名・6桁招待コード）
    const texts = {
        daily: CoinManager.buildDailyShareText({ tiles: 9999, myTeam: 'White (白)', code: 'ZZZZZZ' }) + '\n' + SHARE_URL,
        referral: CoinManager.buildReferralShareText({ code: 'ZZZZZZ' }) + '\n' + SHARE_URL,
        weekly: CoinManager.buildWeeklyResultShareText({
            teamName: 'BLACK',
            outcomeText: '引き分け！',
            blackPct: 50,
            whitePct: 50,
            tiles: 9999,
            inviteCode: 'ZZZZZZ'
        }) + '\n' + SHARE_URL
    };

    Object.entries(texts).forEach(([kind, text]) => {
        const weight = xWeight(text);
        assert.ok(weight <= 280, `${kind} が ${weight} で上限超過（#テリウォーク が切れる）`);
    });
});

/* ------------------------------------------------------------------ *
 * 5. 実際の X シェア（shareToX）の中身
 * ------------------------------------------------------------------ */
test('shareToX: 開く URL の本文に #テリウォーク が入る', () => {
    const { manager, opened } = loadCoinManager();

    manager.shareToX();

    assert.equal(opened.length, 1, 'X の投稿画面を1回開く');
    const url = new URL(opened[0]);
    assert.equal(url.hostname, 'x.com');
    assert.equal(url.pathname, '/intent/tweet');

    const text = url.searchParams.get('text');
    assert.ok(text.includes(NEW_TAG), `#テリウォーク が無い:\n${text}`);
    assert.equal(countTag(text, NEW_TAG), 1);
    assert.equal(url.searchParams.get('url'), SHARE_URL);
    assert.ok(xWeight(text + '\n' + SHARE_URL) <= 280);
});

test('invite: 招待シェア（OS共有シート）の文言に #テリウォーク が入る', () => {
    const shared = [];
    // navigator.share がある環境を再現する
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            querySelector: () => null,
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
            addEventListener() {},
            removeEventListener() {}
        },
        window: {},
        navigator: { share: (payload) => { shared.push(payload); return Promise.resolve(); } },
        localStorage: {
            getItem: () => null,
            setItem() {},
            removeItem() {}
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        confirm: () => true,
        alert() {},
        prompt: () => ''
    });
    vm.runInContext(read('coins.js'), context, { filename: 'coins.js' });
    const CoinManager = vm.runInContext('CoinManager', context);
    const app = {
        showToast() {},
        statsManager: { stats: {}, unlockedTitles: [], activeTitle: '', getOrCreateReferralCode: () => 'ABC123' }
    };
    const managerWithShare = new CoinManager(app, null);
    managerWithShare.shareReferralNative();

    assert.equal(shared.length, 1, '共有シートを1回開く');
    assert.ok(shared[0].text.includes(NEW_TAG), `#テリウォーク が無い:\n${shared[0].text}`);
    assert.equal(countTag(shared[0].text, NEW_TAG), 1);
    assert.equal(shared[0].url, SHARE_URL);
});

/* ------------------------------------------------------------------ *
 * 6. 入口の配線（文言を組み立てる場所が1か所であること）
 * ------------------------------------------------------------------ */
test('配線: shareToX / 招待シェア / 週次リザルトは共通ビルダーを使う', () => {
    const coins = read('coins.js');
    const app = read('app.js');

    assert.match(coins, /const tweetText = CoinManager\.buildDailyShareText\(/);
    assert.match(coins, /const text = CoinManager\.buildReferralShareText\(/);
    assert.match(app, /CoinManager\.buildWeeklyResultShareText\(/);

    // 文言を直に書き戻すとタグが抜けるので、シェア用のハッシュタグをここで直書きしない
    assert.doesNotMatch(coins, /#テリトリーウォーク #TerritoryWalk`/, 'タグを文言へ直書きしない');
    assert.doesNotMatch(app, /#テリトリーウォーク #TerritoryWalk`/, 'タグを文言へ直書きしない');
});

test('配線: ポスター画像の共有文言にも #テリウォーク が入る', () => {
    const poster = read('poster.js');
    const literal = /text: '([^']*)'/.exec(poster);
    assert.ok(literal, 'navigator.share の text が見つからない');

    assert.ok(literal[1].includes(NEW_TAG), `#テリウォーク が無い:\n${literal[1]}`);
    assert.equal(countTag(literal[1], NEW_TAG), 1, 'ポスターの文言でも1回だけ');
    assert.deepEqual(hashtagsIn(literal[1]), EXPECTED_TAGS);
});

test('配線: 画面の案内文は iOS の設定に並ぶ名前（テリウォーク）に合わせる', () => {
    const html = read('index.html');
    assert.match(html, /設定 ＞ テリウォーク ＞ 位置情報/);
    assert.doesNotMatch(html, /設定 ＞ テリトリーウォーク ＞ 位置情報/);
    // www/ はビルドで同期されるので、同じ内容が入っていること
    const wwwHtml = read('www/index.html');
    assert.match(wwwHtml, /設定 ＞ テリウォーク ＞ 位置情報/);
    assert.match(read('www/coins.js'), /#テリウォーク/);
    assert.match(read('www/app.js'), /CoinManager\.buildWeeklyResultShareText\(/);
});
