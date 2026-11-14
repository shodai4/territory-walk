/**
 * TERRITORY WALK - Node tests
 * アプリ起動時の地図初期位置（渋谷）:
 *   1) CONFIG.DEFAULT_CENTER が渋谷駅の座標になっている
 *   2) 地図の center / プレイヤーマーカー / D-Pad（仮想散歩）の出発点が同じ定数を使う
 *   3) 旧フォールバック座標の数値が残っていない（数値はハッシュで照合し、生値をソースに置かない）
 *   4) 実GPSの初回測位では実座標へ移動する（初期位置は取得前のフォールバックのみ）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** 渋谷駅（ハチ公口付近）の座標 */
const SHIBUYA = { lat: 35.658034, lng: 139.701636 };
/** 渋谷とは別の場所（東京駅）— 実GPSで初期位置から実座標へ移ることを確かめるためのダミー */
const TOKYO_STATION = { lat: 35.68124, lng: 139.76712 };

/**
 * 旧フォールバック座標（関西方面）の SHA-256。
 * 旧値をこのファイルに生の数値で残さないため、文字列をハッシュ化した値だけを保持し、
 * ソース中に見つかった座標トークンを同じ方法でハッシュ化して照合する。
 * 対象は 旧緯度 / 旧経度 / そのカンマ区切りの並び。
 */
const LEGACY_COORD_DIGESTS = new Set([
    '8c8299bf27e1d5c98f0e08ad10e992b9fbed85143c42b01243ac2a3f329c3386',
    'b188bd2442591d5653ba8b6bb983896b68b448a0808e73fe16af6e5fc99db20d',
    'd8e660d541f79074d8dce65703fc74d991c529f9443a1f7904527ba2c791c931',
    'a4ed5de136d9d57f4d8e4f3516405bb5ae75867cb88fd059887b164daedfe953'
]);

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 文章中から座標らしい数値（小数第3位以上）を重複なく拾う */
function coordinateTokens(text) {
    return [...new Set(text.match(/\d{2,3}\.\d{3,}/g) || [])];
}

/** 文章中から座標ペア（緯度, 経度）らしい並びを拾う */
function coordinatePairs(text) {
    const pairs = text.match(/\d{2,3}\.\d{3,}\s*,\s*\d{2,3}\.\d{3,}/g) || [];
    return [...new Set(pairs)];
}

/** 検査対象のテキストファイル（依存・生成物・バイナリ資源・VCS は対象外） */
const SCAN_EXTENSIONS = new Set(['.js', '.html', '.css', '.md', '.json', '.yml', '.yaml', '.sql', '.txt']);
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'resources', 'ios', 'android']);

function collectScanFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SCAN_SKIP_DIRS.has(entry.name)) continue;
            collectScanFiles(full, acc);
        } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            acc.push(full);
        }
    }
    return acc;
}

/* ------------------------------------------------------------------ *
 * app.js を vm で読み込み、CONFIG と TerritoryWalkApp を取り出す
 * ------------------------------------------------------------------ */
function loadApp(options = {}) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: options.document || {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            body: { dataset: {} }
        },
        navigator: {},
        window: {},
        localStorage: {
            getItem: () => null,
            setItem() {},
            removeItem() {}
        },
        setTimeout,
        clearTimeout,
        setInterval: () => 0,
        clearInterval() {}
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(APP_SOURCE, context, { filename: 'app.js' });
    return {
        context,
        CONFIG: vm.runInContext('CONFIG', context),
        TerritoryWalkApp: vm.runInContext('TerritoryWalkApp', context)
    };
}

/** 距離（m）— 座標が本当に渋谷かを確かめるための簡易ヒュベニ計算 */
function distanceMeters(a, b) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat = toRad((a.lat + b.lat) / 2);
    const x = dLng * Math.cos(lat);
    return Math.sqrt(x * x + dLat * dLat) * R;
}

const toPlain = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * 1. 定数の値
 * ------------------------------------------------------------------ */
test('初期位置: CONFIG.DEFAULT_CENTER は渋谷駅の座標', () => {
    const { CONFIG } = loadApp();
    assert.deepEqual(
        toPlain(CONFIG.DEFAULT_CENTER),
        [SHIBUYA.lat, SHIBUYA.lng],
        'DEFAULT_CENTER を渋谷駅の座標にする'
    );
});

test('初期位置: 渋谷駅から500m以内（別の街の座標になっていない）', () => {
    const { CONFIG } = loadApp();
    const [lat, lng] = toPlain(CONFIG.DEFAULT_CENTER);
    const d = distanceMeters({ lat, lng }, SHIBUYA);
    assert.ok(d < 500, `渋谷駅から ${Math.round(d)}m（500m以内であること）`);
});

test('初期位置: ズームは従来どおり 17（100mマスが見える倍率）', () => {
    const { CONFIG } = loadApp();
    assert.equal(CONFIG.DEFAULT_ZOOM, 17);
});

test('初期位置: デバッグ機能のマスタースイッチは true のまま', () => {
    const { CONFIG } = loadApp();
    assert.equal(CONFIG.ENABLE_DEBUG_TOOLS, true);
});

/* ------------------------------------------------------------------ *
 * 2. 同じ定数を初期表示の3か所が使っている
 * ------------------------------------------------------------------ */
test('初期表示: 地図 center・プレイヤーマーカー・D-Pad出発点がすべて DEFAULT_CENTER を参照', () => {
    assert.match(APP_SOURCE, /DEFAULT_CENTER:\s*\[/, 'CONFIG に DEFAULT_CENTER がある');
    assert.match(APP_SOURCE, /center:\s*CONFIG\.DEFAULT_CENTER/, 'L.map の center に使う');
    assert.match(APP_SOURCE, /updatePlayerMarker\(CONFIG\.DEFAULT_CENTER\)/, '初期マーカー位置に使う');
    assert.match(APP_SOURCE, /this\.virtualPos\s*=\s*\[\.\.\.CONFIG\.DEFAULT_CENTER\]/, 'D-Pad の出発点に使う');
});

test('初期表示: ハードコードされた座標リテラルは DEFAULT_CENTER の1か所だけ', () => {
    const literals = APP_SOURCE.match(/\b\d{2,3}\.\d{4,}\b/g) || [];
    const unique = [...new Set(literals)];
    assert.deepEqual(
        unique.sort(),
        [String(SHIBUYA.lat), String(SHIBUYA.lng)].sort(),
        `app.js の座標リテラルは渋谷の緯度経度のみ（実際: ${unique.join(', ')}）`
    );
});

test('初期位置: 初期表示は関東圏の座標（旧生活圏の座標に戻っていない）', () => {
    const { CONFIG } = loadApp();
    const [lat, lng] = toPlain(CONFIG.DEFAULT_CENTER);
    assert.ok(lat >= 35.0 && lat <= 36.5, `緯度が関東圏: ${lat}`);
    assert.ok(lng >= 139.0 && lng <= 140.5, `経度が関東圏: ${lng}`);
});

/* 旧値そのものはこのファイルに書かず、SHA-256 で照合する */
function findLegacyCoordinates(text) {
    const hits = [];
    for (const token of coordinateTokens(text)) {
        if (LEGACY_COORD_DIGESTS.has(sha256(token))) hits.push(token);
    }
    for (const pair of coordinatePairs(text)) {
        if (LEGACY_COORD_DIGESTS.has(sha256(pair))) hits.push(pair);
        // 空白の入れ方が違うだけの並びも同じ扱いにする
        const compact = pair.replace(/\s+/g, '');
        if (LEGACY_COORD_DIGESTS.has(sha256(compact))) hits.push(pair);
    }
    return [...new Set(hits)];
}

test('初期位置: 旧フォールバック座標の数値は app.js に残っていない（ハッシュ照合）', () => {
    assert.deepEqual(findLegacyCoordinates(APP_SOURCE), [], 'app.js に旧座標の数値が残っている');
});

test('初期位置: 旧フォールバック座標の数値はソース全体・配布物にも残っていない（ハッシュ照合）', () => {
    const violations = [];
    for (const file of collectScanFiles(ROOT)) {
        const hits = findLegacyCoordinates(fs.readFileSync(file, 'utf8'));
        if (hits.length > 0) violations.push(`${path.relative(ROOT, file)}: ${hits.join(', ')}`);
    }
    assert.deepEqual(violations, [], `旧座標の数値が残っている: ${violations.join(' / ')}`);
});

/* ------------------------------------------------------------------ *
 * 3. 実GPSが来たら実座標へ移る（初期位置はフォールバックのみ）
 * ------------------------------------------------------------------ */
function createApp(loaded, overrides = {}) {
    const app = Object.create(loaded.TerritoryWalkApp.prototype);
    const mapCalls = [];
    Object.assign(
        app,
        {
            locationBanner: null,
            gridManager: null,
            isAppInBackground: false,
            isDebugMode: false,
            debugEnabled: true,
            currentMeshId: null,
            lastProcessedLat: null,
            lastProcessedLng: null,
            virtualPos: toPlain(loaded.CONFIG.DEFAULT_CENTER),
            map: {
                getZoom: () => 17,
                setView: (center, zoom) => mapCalls.push([toPlain(center), zoom]),
                panTo: () => {}
            },
            markerPositions: [],
            claims: [],
            gpsStatuses: []
        },
        overrides
    );
    app.mapCalls = mapCalls;
    app.updateGPSStatus = (label) => app.gpsStatuses.push(label);
    app.updatePlayerMarker = (pos) => app.markerPositions.push(toPlain(pos));
    app.processMeshAndClaim = (lat, lng) => {
        app.claims.push([lat, lng]);
        return Promise.resolve({ changed: true });
    };
    app.showToast = () => {};
    return app;
}

test('実GPS: 初回測位で実座標へ setView（初期位置のまま固定されない）', async () => {
    const loaded = loadApp();
    const app = createApp(loaded);

    // 渋谷とは別の場所で測位できたケース＝実データを壊さない
    app.handlePositionUpdate(
        { coords: { latitude: TOKYO_STATION.lat, longitude: TOKYO_STATION.lng } },
        true
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(app.markerPositions[0], [TOKYO_STATION.lat, TOKYO_STATION.lng], 'マーカーは実座標');
    assert.deepEqual(app.mapCalls[0], [[TOKYO_STATION.lat, TOKYO_STATION.lng], 17], '初回測位で実座標へ寄る');
    assert.deepEqual(toPlain(app.virtualPos), [TOKYO_STATION.lat, TOKYO_STATION.lng], '以降の基準点も実座標');
});

test('実GPS: 測位前は渋谷が初期表示（フォールバック）', () => {
    const loaded = loadApp();
    const app = createApp(loaded);
    assert.deepEqual(app.virtualPos, [SHIBUYA.lat, SHIBUYA.lng]);
    assert.equal(app.mapCalls.length, 0, '測位前は地図移動を起こさない');
});
