/**
 * TERRITORY WALK - Node tests
 * 表示名（ニックネーム）の初期値をユーザーIDにする。
 *
 *   1) 未設定なら表示名＝自動生成されたユーザーID（this.userId）
 *   2) ユーザーが設定した名前はそのまま優先される
 *   3) 初期リリースの旧固定名が端末に残っていても、ユーザーID表示へ移行する
 *   4) 空文字保存は従来どおり何もしない（入力ミスで表示名が消えない）
 *   5) "[称号] 表示名" の分解は、名前が空なら相手の user_id で補完する
 *   6) 画面・ソース・DB定義に旧固定名が残っていない
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const STATS_SOURCE = fs.readFileSync(path.join(ROOT, 'stats.js'), 'utf8');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 旧既定名（stats.js 内では Unicode エスケープで保持している値をテスト側で復元） */
const LEGACY_DEFAULT = '\u540d\u3082\u306a\u304d\u6b69\u884c\u8005';
const TEST_USER_ID = '5f1c9a2e-8b7d-4c6a-9f30-1d2b3c4d5e6f';

/* ------------------------------------------------------------------ *
 * localStorage / 実行環境のスタブ
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

function createStatsManager(initial = {}, options = {}) {
    const storage = createStorage(initial);
    const sandbox = {
        localStorage: storage,
        crypto: options.uuid === null
            ? {}
            : { randomUUID: () => options.uuid || TEST_USER_ID },
        setInterval: () => 0,
        clearInterval: () => {},
        console: { log() {}, warn() {}, error() {} }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(
        `${STATS_SOURCE}\n;globalThis.__StatsManager = StatsManager;`,
        context,
        { filename: 'stats.js' }
    );

    const StatsManager = context.__StatsManager;
    const manager = new StatsManager(null, null);
    return { StatsManager, manager, storage };
}

/** vm コンテキスト越しの戻り値を、テスト側の素のオブジェクトに写す */
function parse(StatsManager, raw, fallback) {
    const result = typeof fallback === 'undefined'
        ? StatsManager.parseFormattedName(raw)
        : StatsManager.parseFormattedName(raw, fallback);
    return { name: result.name, title: result.title };
}

/* ------------------------------------------------------------------ *
 * 1. 初期表示名はユーザーID
 * ------------------------------------------------------------------ */
test('初期表示名: 未設定なら自動生成されたユーザーIDが表示名になる', () => {
    const { manager, storage } = createStatsManager();

    assert.equal(manager.userId, TEST_USER_ID, 'ユーザーIDは自動生成される');
    assert.equal(storage.getItem('tw_user_id'), TEST_USER_ID, 'ユーザーIDは端末に保存される');
    assert.equal(manager.nickname, TEST_USER_ID, 'nickname の初期値はユーザーID');
    assert.equal(manager.getFormattedDisplayName(), TEST_USER_ID);
    assert.equal(manager.hasCustomNickname(), false, 'ユーザーが設定した名前はまだ無い');
    assert.equal(storage.getItem('tw_nickname'), null, '未設定を保存値として書き込まない');
});

test('初期表示名: 称号を付けても本文はユーザーIDのまま', () => {
    const { manager } = createStatsManager();
    manager.activeTitle = '初陣';

    assert.equal(manager.getFormattedDisplayName(), `[初陣] ${TEST_USER_ID}`);
});

test('初期表示名: crypto.randomUUID が無い環境でも生成したIDを初期値にする', () => {
    const { manager } = createStatsManager({}, { uuid: null });

    assert.match(manager.userId, /^user_[a-z0-9]+$/);
    assert.equal(manager.nickname, manager.userId);
});

/* ------------------------------------------------------------------ *
 * 2. 設定済みの名前は優先される
 * ------------------------------------------------------------------ */
test('既存ユーザー: 保存済みのニックネームはそのまま表示名になる', () => {
    const { manager } = createStatsManager({ tw_nickname: 'しょうだい' });

    assert.equal(manager.nickname, 'しょうだい');
    assert.equal(manager.getFormattedDisplayName(), 'しょうだい');
    assert.equal(manager.hasCustomNickname(), true);
});

test('変更: 保存すると新しい名前になり、端末にも保存される', async () => {
    const { manager, storage } = createStatsManager();

    await manager.setNickname('  あたらしい名前  ');

    assert.equal(manager.nickname, 'あたらしい名前', '前後の空白は落とす');
    assert.equal(storage.getItem('tw_nickname'), 'あたらしい名前');
    assert.equal(manager.getFormattedDisplayName(), 'あたらしい名前');
});

test('変更: 20文字を超える入力は20文字に丸める', async () => {
    const { manager } = createStatsManager();

    await manager.setNickname('あ'.repeat(30));

    assert.equal(manager.nickname.length, 20);
});

/* ------------------------------------------------------------------ *
 * 3. 旧固定名からの移行
 * ------------------------------------------------------------------ */
test('移行: 旧固定名が保存されていてもユーザーIDで表示し、保存値を掃除する', () => {
    const { manager, storage } = createStatsManager({ tw_nickname: LEGACY_DEFAULT });

    assert.equal(manager.nickname, TEST_USER_ID, '旧固定名ではなくユーザーIDを使う');
    assert.equal(storage.getItem('tw_nickname'), null, '旧固定名は端末から消す');
    assert.equal(manager.hasCustomNickname(), false);
});

/* ------------------------------------------------------------------ *
 * 4. 空文字保存の扱いは従来どおり
 * ------------------------------------------------------------------ */
test('空文字保存: 表示名は変わらない（従来どおり何もしない）', async () => {
    const { manager, storage } = createStatsManager({ tw_nickname: 'しょうだい' });

    await manager.setNickname('');
    assert.equal(manager.nickname, 'しょうだい');

    await manager.setNickname(null);
    assert.equal(manager.nickname, 'しょうだい');
    assert.equal(storage.getItem('tw_nickname'), 'しょうだい');
});

test('空白だけの保存: 初期値（ユーザーID）へ戻る', async () => {
    const { manager, storage } = createStatsManager({ tw_nickname: 'しょうだい' });

    await manager.setNickname('   ');

    assert.equal(manager.nickname, TEST_USER_ID);
    assert.equal(storage.getItem('tw_nickname'), null, '空の保存値は残さない');
});

test('未設定のまま空文字保存: 表示名はユーザーIDのまま', async () => {
    const { manager } = createStatsManager();

    await manager.setNickname('');

    assert.equal(manager.nickname, TEST_USER_ID);
});

/* ------------------------------------------------------------------ *
 * 5. ランキング表示のフォールバック
 * ------------------------------------------------------------------ */
test('分解: 表示名が空なら渡した user_id で補完する（固定の代用名を出さない）', () => {
    const { StatsManager } = createStatsManager();

    assert.deepEqual(parse(StatsManager, null, 'user-abc'), { name: 'user-abc', title: '' });
    assert.deepEqual(parse(StatsManager, '', 'user-abc'), { name: 'user-abc', title: '' });
    assert.deepEqual(parse(StatsManager, '[初陣]', 'user-abc'), { name: 'user-abc', title: '初陣' });
    assert.deepEqual(
        parse(StatsManager, LEGACY_DEFAULT, 'user-abc'),
        { name: 'user-abc', title: '' },
        '旧固定名の行も user_id で表示する'
    );
});

test('分解: フォールバック未指定なら空文字（旧固定名を勝手に補わない）', () => {
    const { StatsManager } = createStatsManager();

    assert.deepEqual(parse(StatsManager, null), { name: '', title: '' });
    assert.deepEqual(parse(StatsManager, LEGACY_DEFAULT), { name: '', title: '' });
});

test('分解: 称号付きの表示名は従来どおり分解する', () => {
    const { StatsManager } = createStatsManager();

    assert.deepEqual(
        parse(StatsManager, '[エリアウォーカー] しょうだい', 'user-abc'),
        { name: 'しょうだい', title: 'エリアウォーカー' }
    );
    assert.deepEqual(
        parse(StatsManager, 'しょうだい', 'user-abc'),
        { name: 'しょうだい', title: '' }
    );
});

test('配線: ランキング描画は相手の user_id をフォールバックに渡す', () => {
    const calls = APP_SOURCE.match(/parseNicknameAndTitle\(item\.nickname[^)]*\)/g) || [];
    assert.ok(calls.length >= 3, `ランキング3か所で呼ばれている（実際: ${calls.length}）`);
    calls.forEach((call) => {
        assert.match(call, /item\.nickname,\s*item\.user_id\)/, `${call} が user_id を渡している`);
    });
});

/* ------------------------------------------------------------------ *
 * 6. 旧固定名が画面・ソース・DB定義に残っていない
 * ------------------------------------------------------------------ */
test('文言: ソース・HTML・SQL に旧固定名が残っていない', () => {
    const files = ['stats.js', 'app.js', 'index.html', 'schema.sql', 'coins.js', 'supabase.js'];

    files.forEach((file) => {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.ok(!text.includes(LEGACY_DEFAULT), `${file} に旧固定名が残っている`);
    });
});

test('文言: 入力欄のプレースホルダーは未設定＝ユーザーID表示だと分かる', () => {
    assert.match(INDEX_HTML, /id="input-nickname"[^>]*placeholder="未設定時はユーザーIDで表示"/);
    assert.match(APP_SOURCE, /nickInput\.placeholder = '未設定時はユーザーIDで表示'/);
    assert.match(APP_SOURCE, /nickInput\.value = savedName/, '入力欄には設定済みの名前だけを出す');
});

test('キャッシュバスター: stats.js / app.js は最新版を参照する', () => {
    assert.match(INDEX_HTML, /stats\.js\?v=20261115v53/);
    assert.match(INDEX_HTML, /app\.js\?v=20261115v53/);
});
