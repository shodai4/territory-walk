/**
 * TERRITORY WALK - Node tests
 * app.js のモジュール分割（役割ごとのファイル・機能完全不変の確認）
 *
 *   1) 分割されたファイルが index.html の読み込み順どおりに並んでいる（app.js が最後）
 *   2) 各ファイルは前のファイルのクラスを extends してメソッドを積み上げる
 *   3) 分割前の全メソッドが最終クラス（TerritoryWalkApp）に載っている（1つも欠けない）
 *   4) scripts/build.js が全モジュールを www/ にコピーし、404 参照チェックも通る
 *   5) 配布物（www/）にも同じ内容が入っている
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { APP_SOURCE_FILES, readAppFile, readAppSource, readWwwAppSource } = require('./helpers/app-sources');
const build = require(path.join(ROOT, 'scripts', 'build.js'));

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. ファイルの並びと index.html の読み込み順
 * ------------------------------------------------------------------ */

test('分割: すべてのモジュールが存在し、1ファイルあたりの行数が抑えられている', () => {
    APP_SOURCE_FILES.forEach((file) => {
        const full = path.join(ROOT, file);
        assert.ok(fs.existsSync(full), `${file} がある`);
        const lines = readAppFile(file).split('\n').length;
        assert.ok(lines > 0, `${file} が空でない`);
    });

    // 旧 app.js は 4,283行。分割後はどのファイルも 800行未満に収まっている
    APP_SOURCE_FILES.forEach((file) => {
        const lines = readAppFile(file).split('\n').length;
        assert.ok(lines < 800, `${file} は 800行未満（実際 ${lines} 行）`);
    });

    // 入口の app.js は起動処理だけ（薄い）
    assert.ok(readAppFile('app.js').split('\n').length < 60, 'app.js は起動処理だけ');
});

test('分割: index.html が 12 本をこの順で読み、最後が app.js', () => {
    const srcs = [...HTML.matchAll(/<script src="(app(?:-[a-z]+)?\.js)\?v=(\d{8}v\d+)"><\/script>/g)]
        .map((m) => ({ file: m[1], version: m[2] }));

    assert.deepEqual(srcs.map((s) => s.file), APP_SOURCE_FILES, '読み込み順が APP_SOURCE_FILES と一致する');
    assert.equal(srcs[srcs.length - 1].file, 'app.js', '最後に app.js（起動）');

    const versions = new Set(srcs.map((s) => s.version));
    assert.equal(versions.size, 1, '分割モジュールは同じキャッシュバスターで揃える');
    assert.ok([...versions][0] >= '20261121v65', '今回の変更版に上がっている');
});

test('分割: 各ファイルは前のファイルのクラスを継承している', () => {
    const chain = [];
    let previous = null;

    APP_SOURCE_FILES.forEach((file) => {
        const source = readAppFile(file);
        if (file === 'app-config.js') {
            assert.match(source, /^const CONFIG = \{/m, 'app-config.js は設定値から始まる');
            return;
        }
        const match = /^class (TerritoryWalkApp[A-Za-z]*) extends (TerritoryWalkApp[A-Za-z]*) \{/m.exec(source)
            || /^class (TerritoryWalkApp[A-Za-z]*) \{\}/m.exec(source)
            || /^class (TerritoryWalkAppCore) \{/m.exec(source);
        assert.ok(match, `${file} にクラス宣言がある`);

        const name = match[1];
        if (previous) {
            assert.equal(match[2], previous, `${file} は ${previous} を継承する`);
        } else {
            assert.equal(name, 'TerritoryWalkAppCore', '土台は TerritoryWalkAppCore');
        }
        chain.push(name);
        previous = name;
    });

    assert.deepEqual(chain, [
        'TerritoryWalkAppCore',
        'TerritoryWalkAppMap',
        'TerritoryWalkAppStats',
        'TerritoryWalkAppBattle',
        'TerritoryWalkAppActions',
        'TerritoryWalkAppMenus',
        'TerritoryWalkAppGeolocation',
        'TerritoryWalkAppMarking',
        'TerritoryWalkAppTracking',
        'TerritoryWalkAppGameplay',
        'TerritoryWalkApp'
    ]);
});

/* ------------------------------------------------------------------ *
 * 2. 機能完全不変: 全メソッドが最終クラスに載っている
 * ------------------------------------------------------------------ */

/** ソース上のメソッド定義（4スペース字下げ）を拾う */
function sourceMembers(source) {
    const instance = new Set();
    const statics = new Set();
    const re = /^    (async |static |get |set )?([A-Za-z_$][A-Za-z0-9_$]*)\(.*\) \{$/gm;
    let m;
    while ((m = re.exec(source))) {
        if (m[1] === 'static ') statics.add(m[2]);
        else instance.add(m[2]);
    }
    return { instance, statics };
}

function loadAppClasses() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
            addEventListener() {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        window: {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        navigator: {},
        screen: {},
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    APP_SOURCE_FILES.forEach((file) => {
        vm.runInContext(readAppFile(file), context, { filename: file });
    });
    return { context, sandbox };
}

test('不変: 分割前の全メソッドが TerritoryWalkApp のプロトタイプに載っている', () => {
    const { context } = loadAppClasses();
    const AppClass = vm.runInContext('TerritoryWalkApp', context);
    assert.equal(typeof AppClass, 'function', 'TerritoryWalkApp が定義される');

    // ソース上のメソッド（constructor を除く）とプロトタイプ上のメソッドが一致する
    const { instance, statics } = sourceMembers(readAppSource());
    instance.delete('constructor');

    // vm コンテキスト側の Object.prototype も含めて継承をたどり、標準のメソッドは除外する
    const baseNames = new Set(vm.runInContext('Object.getOwnPropertyNames(Object.prototype)', context));
    const onPrototype = new Set();
    let proto = AppClass.prototype;
    while (proto) {
        Object.getOwnPropertyNames(proto).forEach((name) => {
            if (name === 'constructor') return;
            if (baseNames.has(name)) return;
            // Function.prototype 側の標準メソッド（call/apply 等）は対象外
            if (typeof proto[name] === 'function' && !/^[a-z]/.test(name)) return;
            onPrototype.add(name);
        });
        proto = Object.getPrototypeOf(proto);
    }

    const missing = [...instance].filter((name) => !onPrototype.has(name));
    const extra = [...onPrototype].filter((name) => !instance.has(name));
    assert.deepEqual(missing, [], `載っていないメソッド: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `ソースに無いメソッド: ${extra.join(', ')}`);
    assert.ok(instance.size > 100, `全メソッドを数えている（${instance.size} 件）`);

    // static メソッドはコンストラクタ側に残る
    assert.deepEqual([...statics].sort(), ['chooseBalancedTeam', 'identityKeys']);
    statics.forEach((name) => {
        assert.equal(typeof AppClass[name], 'function', `static ${name} が使える`);
    });
});

test('不変: 主要なメソッドが各モジュールから揃っている', () => {
    const { context } = loadAppClasses();
    const sample = {
        'app-core.js': ['showToast', 'initTeam', 'initDOM'],
        'app-map.js': ['initMap', 'initGrid', 'loadRemoteTiles', 'refreshGlobalTeamCounts'],
        'app-stats.js': ['initStatsModal', 'loadWeeklyRankings', 'showWeeklyResultModal'],
        'app-battle.js': ['initWeeklyBattleDetail', 'openWeeklyBattleDetail', 'loadBattleHistory'],
        'app-actions.js': ['initProModal', 'exportPosterAction', 'toggleDebugMode', 'recenterToCurrentPosition'],
        'app-menus.js': ['initMenuModal', 'initRulesModal', 'applyTransferCode'],
        'app-geolocation.js': ['initGeolocation', 'startBackgroundGeolocation', 'startWebGeolocation'],
        'app-marking.js': ['setMarkingPaused', 'renderMarkingPauseUI', 'setPowerSaveMode'],
        'app-tracking.js': ['startLocationTracking', 'initLifecycleListeners', 'pauseForegroundUpdates'],
        'app-gameplay.js': ['handlePositionUpdate', 'processMeshAndClaim', 'initEvents', 'initRealtimeSync']
    };

    Object.entries(sample).forEach(([file, methods]) => {
        const source = readAppFile(file);
        methods.forEach((name) => {
            assert.match(source, new RegExp(`^    (async )?${name}\\(`, 'm'), `${file} に ${name} がある`);
            const type = vm.runInContext(`typeof TerritoryWalkApp.prototype.${name}`, context);
            assert.equal(type, 'function', `TerritoryWalkApp から ${name} を呼べる`);
        });
    });
});

test('不変: 定数・設定は app-config.js の1か所（CONFIG が重複定義されない）', () => {
    const config = readAppFile('app-config.js');
    assert.match(config, /^const CONFIG = \{/m);
    assert.match(config, /ENABLE_DEBUG_TOOLS: false/);

    APP_SOURCE_FILES.slice(1).forEach((file) => {
        assert.doesNotMatch(readAppFile(file), /^const CONFIG = /m, `${file} で CONFIG を再定義しない`);
    });
});

/* ------------------------------------------------------------------ *
 * 3. ビルド（www/ へのコピーと 404 検証）
 * ------------------------------------------------------------------ */

test('ビルド: ASSETS_TO_COPY が分割モジュールを同じ順で持っている', () => {
    const inAssets = build.ASSETS_TO_COPY.filter((f) => APP_SOURCE_FILES.includes(f));
    assert.deepEqual(inAssets, APP_SOURCE_FILES);
});

test('ビルド: 一時ディレクトリでも全モジュールが www/ に漏れなくコピーされる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-modules-'));
    const wwwDir = path.join(dir, 'www');
    fs.mkdirSync(wwwDir, { recursive: true });

    const result = build.build({ rootDir: ROOT, wwwDir, quiet: true });
    assert.deepEqual(result.missing, [], '参照先の欠けが無い');

    APP_SOURCE_FILES.forEach((file) => {
        const copied = path.join(wwwDir, file);
        assert.ok(fs.existsSync(copied), `www/${file} がコピーされる`);
        assert.equal(fs.readFileSync(copied, 'utf8'), readAppFile(file), `www/${file} がルートと同一`);
    });

    fs.rmSync(dir, { recursive: true, force: true });
});

test('ビルド: モジュールを1本でも欠けさせると 404 検証で落ちる（CIが気づく）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-modules-missing-'));
    const wwwDir = path.join(dir, 'www');
    fs.mkdirSync(wwwDir, { recursive: true });

    // index.html だけを置き、参照先（モジュール）を一切コピーしない
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="app-core.js?v=1"></script>');
    build.ASSETS_TO_COPY.length = build.ASSETS_TO_COPY.length; // 参照のみ

    assert.throws(
        () => build.build({ rootDir: dir, wwwDir, quiet: true }),
        /Missing referenced asset\(s\) in www\/: index\.html -> app-core\.js/
    );
    fs.rmSync(dir, { recursive: true, force: true });
});

test('配布物: www/ の分割モジュールがルートと同期している', () => {
    const wwwDir = path.join(ROOT, 'www');
    if (!fs.existsSync(wwwDir)) return;
    APP_SOURCE_FILES.forEach((file) => {
        assert.ok(fs.existsSync(path.join(wwwDir, file)), `www/${file} がある`);
    });
    assert.equal(readWwwAppSource(), readAppSource(), 'www/ はルートと同一（npm run build 後）');
});
