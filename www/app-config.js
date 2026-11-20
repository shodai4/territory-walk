/**
 * TERRITORY WALK - app-config.js
 * 設定値（CONFIG）・省電力／測位の定数・測位オプションの純粋関数
 *
 * app.js の先頭150行をそのまま移したもの。ここで宣言した const / function は
 * 同じグローバルスコープで後続の app-*.js から参照する（値・計算式は不変）。
 */

/**
 * TERRITORY WALK - app.js
 * Core Application Controller, Geolocation, Real-time Grid Updates & Supabase Sync
 */

const CONFIG = {
    DEFAULT_CENTER: [35.658034, 139.701636], // 渋谷（フォールバック座標。前回の現在地が無い初回起動で使う）
    DEFAULT_ZOOM: 17,
    // 前回の現在地が無い初回起動の初期倍率（日本全体が見える広域表示で測位を待つ）
    WIDE_ZOOM: 5,
    MIN_ZOOM: 2,
    MAX_ZOOM: 20,
    // 地図の描画はズームで4段階（grid.js の displayModeForZoom）:
    //   zoom >= 14 … 100mマス（初期配置＋実績＋自分の足跡）
    //   10〜13 … 10×10マス（約1km四方）のブロックに集計して薄く描く
    //   6〜9 … 10×10ブロック（約10km四方）に集計してさらに薄く描く
    //   5以下 … マスもブロックも一切描かない（広域での居場所特定を防ぐ）
    // 100mマスを描く下限ズーム
    TILE_DETAIL_MIN_ZOOM: 14,
    // 1kmブロックを描く下限ズーム。これ未満は1kmブロックを描かない
    TILE_RENDER_MIN_ZOOM: 10,
    // 10kmブロックを描く下限ズーム。これ未満（zoom 5以下）は何も描かない
    MACRO_RENDER_MIN_ZOOM: 6,
    // 100mマスの取得下限ズーム。
    //   zoom 13 はブロック表示だが、取得した実績はブロックの色に効くため 13 から取得する。
    //   画面全体が15km四方を超える場合は supabase.js の MAX_INDEX_SPAN（150マス≒15km）で止める。
    REMOTE_FETCH_MIN_ZOOM: 13,
    // 画面に描く枚数の上限（375×812 の画面あたり）
    //   100mマス：zoom 14 で約1,950枚 / 1kmブロック：zoom 10 で約4,950枚
    //   10kmブロック：zoom 6 で約12,500枚（実績なしはハッシュ1回で色を決めるので軽い）
    MAX_TILES_PER_RENDER: 3000,
    BLOCK_RENDER_MAX_COUNT: 6500,
    MACRO_RENDER_MAX_COUNT: 13000,
    // デバッグ機能（D-PAD・コイン操作・プレビュー・チーム切替等）のマスタースイッチ
    // App Store 提出ビルドのため false（UIごと非表示になり、AdMob も本番IDへ自動切替）
    ENABLE_DEBUG_TOOLS: false
};

// 画面消灯・ロック中も測位を続けるネイティブプラグイン（Capacitor 6 互換）
// 陣地マーキング（自動塗り）の ON/OFF を保存するキー。
// 停止中にアプリを終了→再起動したときに、一瞬でも塗ってしまわないよう起動前に読む。
const MARKING_PAUSE_STORAGE_KEY = 'tw_marking_paused';
const BACKGROUND_GEOLOCATION_PLUGIN_NAME = 'BackgroundGeolocation';
const NATIVE_GEOLOCATION_PLUGIN_NAME = 'Geolocation';
/* ================================================================== *
 * v1.2 省電力設定
 *
 * 実測したプラグイン仕様（@capacitor-community/background-geolocation 1.3.1）:
 *   definitions.d.ts の WatcherOptions は
 *     backgroundMessage / backgroundTitle / requestPermissions / stale / distanceFilter
 *   の5つだけ。desiredAccuracy や pausesLocationUpdatesAutomatically という口は無い。
 *   iOS ネイティブ（ios/Plugin/Swift/Plugin.swift の addWatcher）は
 *     manager.desiredAccuracy = 充電中 ? kCLLocationAccuracyBestForNavigation : kCLLocationAccuracyBest
 *     manager.pausesLocationUpdatesAutomatically = false
 *     manager.allowsBackgroundLocationUpdates = (backgroundMessage が有るか)
 *   を固定で設定している。だから JS から省電力を調整できるのは distanceFilter だけ
 *   （存在しないオプションを書くと黙って無視されるので、ここに増やさないこと）。
 *
 * マスは約100m四方（grid.js の latStep=0.0009 / lngStep=0.0011）。
 * distanceFilter は「これ以上動いたら次の更新」なので、100m未満に保てば
 * 直進中は1マスにつき最低1回は更新が届く。既定40m・省電力60m。
 * ================================================================== */
const DISTANCE_FILTER_STANDARD_M = 40;
const DISTANCE_FILTER_POWER_SAVE_M = 60;
// 同じマスに留まっている間、これ未満の移動はGPS誤差とみなして再処理を省く（m）
const STATIONARY_SKIP_STANDARD_M = 5;
const STATIONARY_SKIP_POWER_SAVE_M = 12;
// 省電力モードの ON/OFF を保存するキー（端末内のみ）
const POWER_SAVE_STORAGE_KEY = 'tw_power_save';

/* ================================================================== *
 * v1.2 画面表示中だけ動く定期処理（電池対策）
 *
 *   ・8秒ごとの loadRemoteTiles()（他プレイヤーの陣地の取り込み）
 *   ・1秒ごとのリセットまでのカウントダウン
 * は、どちらも「画面に見えている」ときだけ意味がある処理。
 * document.hidden の間は setInterval ごと止め（タイマー起床もゼロ）、
 * visibilitychange で戻ってきた瞬間にカウントダウンを即更新し、
 * 陣地の取得は1回だけやり直す。
 *
 * 注意：歩行記録用のバックグラウンド測位（BackgroundGeolocation の watcher）は
 * 画面が見えていなくても塗り続けるのが仕様なので、ここでは止めない。
 * ================================================================== */
// 他プレイヤーの陣地を取り込むポーリング間隔（ms）
const REMOTE_TILES_POLL_MS = 8000;
// 週リセットまでのカウントダウンを刻む間隔（ms）
const RESET_COUNTDOWN_TICK_MS = 1000;
// 復帰時に陣地を取り直す最短間隔（ms）。画面の連続切替で通信を重ねない
const FOREGROUND_REFRESH_MIN_INTERVAL_MS = 1000;

const BACKGROUND_GEOLOCATION_OPTIONS = {
    // backgroundMessage を定義すると、画面消灯・バックグラウンド中も位置更新が届く
    backgroundMessage: '画面を消灯しても陣地を塗り続けます',
    backgroundTitle: 'テリトリーウォーク',
    requestPermissions: true,
    // 古い測位結果で別のマスを塗らないようにする
    stale: false,
    // 100mマスを取りこぼさず、電池消費も抑える距離フィルタ（m）
    distanceFilter: DISTANCE_FILTER_STANDARD_M
};

/** 省電力モードに応じた距離フィルタ（m）。プラグインに実際に渡せる唯一の省電力つまみ */
function resolveDistanceFilter(powerSaveMode) {
    return powerSaveMode === true ? DISTANCE_FILTER_POWER_SAVE_M : DISTANCE_FILTER_STANDARD_M;
}

/** 省電力モードに応じた「静止中スキップ」のしきい値（m） */
function resolveStationarySkipDistance(powerSaveMode) {
    return powerSaveMode === true ? STATIONARY_SKIP_POWER_SAVE_M : STATIONARY_SKIP_STANDARD_M;
}

/** addWatcher へ渡すオプション一式（存在するキーだけを載せる） */
function buildBackgroundGeolocationOptions(powerSaveMode) {
    return Object.assign({}, BACKGROUND_GEOLOCATION_OPTIONS, {
        distanceFilter: resolveDistanceFilter(powerSaveMode === true)
    });
}

/**
 * 同一マス滞在中の位置更新を「捨ててよい」か（純粋関数・テスト対象）。
 * 捨てるのは、同じマス・そこは既に自陣・移動が誤差レベル、が全部そろったときだけ。
 * 初回取得 / 明示的な再取得(force) / 誤差の大きい測位(skipClaim) / チーム変更や未取得マス
 * （cellAlreadyMine が false）は必ず処理する。
 */
function shouldSkipStationaryUpdate(params) {
    const p = params || {};
    if (p.isFirst === true || p.force === true) return false;
    if (p.skipClaim === true) return false;
    if (p.sameMesh !== true || p.cellAlreadyMine !== true) return false;
    const distance = Number(p.distanceMeters);
    if (!Number.isFinite(distance)) return false;
    const threshold = Number.isFinite(Number(p.thresholdMeters))
        ? Number(p.thresholdMeters)
        : STATIONARY_SKIP_STANDARD_M;
    return distance < threshold;
}

// Web（navigator.geolocation）測位のオプション。
// 衛星測位（enableHighAccuracy: true）は室内・ビルの谷間だと10秒以内に返らず
// TIMEOUT(code=3) / POSITION_UNAVAILABLE(code=2) になりやすい。
// その場合は Wi-Fi・基地局・IP で推定する低精度の測位へ自動で切り替え、
// 「測位できないまま」で止まらないようにする（Chrome の Web 版の対策）。
const WEB_GEOLOCATION_PRECISE_OPTIONS = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
};
const WEB_GEOLOCATION_COARSE_OPTIONS = {
    enableHighAccuracy: false,
    timeout: 15000,
    maximumAge: 60000
};
// 低精度測位（IP推定など）の誤差がこれ以上なら、地図・ピンは動かしても陣地は塗らない。
// 100mマスに対して数km単位でずれた位置を開拓してしまうのを防ぐ。
const WEB_GEOLOCATION_MAX_CLAIM_ACCURACY_M = 1000;
