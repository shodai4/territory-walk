/**
 * TERRITORY WALK - Node tests
 * Apple Watch の白黒＋モノトーン地図（5点改修の 5）
 *   1) 白チーム＝白、黒チーム＝黒（アンバー/オレンジを使わない）
 *   2) 黒マスは白寄りの縁取り、白マスは灰色の縁取りで境界がわかる
 *   3) 地図自体は彩度を落としたモノトーン（.saturation(0)）＋ダーク配色
 *   4) CI（ENABLE_WATCH_TARGET）で Watch ターゲットがビルド対象になっている
 *   5) ズームは画面の ＋／－ をやめ、Digital Crown（リューズ）で4段階（2026-11-19）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WATCH_APP = fs.readFileSync(path.join(ROOT, 'watch', 'TerritoryWatch', 'TerritoryWatchApp.swift'), 'utf8');
const WATCH_MODEL = fs.readFileSync(path.join(ROOT, 'watch', 'TerritoryWatch', 'WatchModel.swift'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ios-build.yml'), 'utf8');
const WATCH_SETUP = fs.readFileSync(path.join(ROOT, 'ci', 'watch-setup.sh'), 'utf8');

test('Watch配色: 白チーム＝白・黒チーム＝黒（オレンジを使わない）', () => {
    assert.match(WATCH_APP, /private func color\(for team: Int\) -> Color \{[\s\S]*?team == 1 \? \.white : \.black/);
    assert.doesNotMatch(WATCH_APP, /\.orange/, '黒陣営をオレンジで塗らない');
    assert.doesNotMatch(WATCH_APP, /Color\.orange/);
});

test('Watch配色: 黒マスは白寄りの縁取り・白マスは灰色の縁取りで境界を出す', () => {
    assert.match(WATCH_APP, /private func strokeColor\(for team: Int\) -> Color \{[\s\S]*?Color\.gray\.opacity\(0\.6\)[\s\S]*?Color\.white\.opacity\(0\.45\)/,
        '白マスは灰色、黒マスは白寄りの線');
    assert.match(WATCH_APP, /private func strokeWidth\(for team: Int\) -> CGFloat \{[\s\S]*?0\.6[\s\S]*?0\.7/, '線の太さも陣営で変える');
    assert.match(WATCH_APP, /\.stroke\(strokeColor\(for: cell\.team\), lineWidth: strokeWidth\(for: cell\.team\)\)/,
        'マスの描画に縁取りを渡す');
    assert.match(WATCH_APP, /\.foregroundStyle\(color\(for: cell\.team\)\.opacity\(fillOpacity\(for: cell\.team\)\)\)/,
        '塗りは半透明（下の地図が透ける）');
});

test('Watch配色: 地図はモノトーン寄り（彩度0＋ダーク配色）', () => {
    assert.match(WATCH_APP, /\.saturation\(0\.0\)/, '彩度を落とす');
    assert.match(WATCH_APP, /\.colorScheme\(\.dark\)/, 'ダーク配色で白黒マスを引き立てる');
    assert.match(WATCH_APP, /\.mapStyle\(\.standard\(pointsOfInterest: \.excludingAll\)\)/, '標準スタイルは維持');
});

test('Watch配線: CI は Watch ターゲットを組み込んでビルドする（vars.ENABLE_WATCH_TARGET）', () => {
    assert.match(WORKFLOW, /Add watchOS companion target \(optional, vars\.ENABLE_WATCH_TARGET=true\)/);
    assert.match(WORKFLOW, /if: vars\.ENABLE_WATCH_TARGET == 'true'/);
    assert.match(WORKFLOW, /run: bash ci\/watch-setup\.sh/);
    const configureWatch = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-watch.js'), 'utf8');
    assert.match(configureWatch, /watch', 'TerritoryWatch'|TerritoryWatch/, 'Watch ソースを生成 iOS プロジェクトへ配置する');
});

/* ------------------------------------------------------------------ *
 * 5: Digital Crown ズーム（画面の＋／－を廃止）
 * ------------------------------------------------------------------ */

test('Watchズーム: 画面の ＋／－ ボタンと zoomButton 定義は残っていない', () => {
    assert.doesNotMatch(WATCH_APP, /"plus"/, '＋ボタンを削除');
    assert.doesNotMatch(WATCH_APP, /"minus"/, '－ボタンを削除');
    assert.doesNotMatch(WATCH_APP, /func zoomButton/, 'zoomButton の定義を削除');
    assert.doesNotMatch(WATCH_APP, /zoomButton\(/, 'zoomButton の呼び出しを削除');
});

test('Watchズーム: Digital Crown を focusable にして4段階にスナップする', () => {
    assert.match(WATCH_APP, /\.focusable\(true\)/, 'クラウンを受けるために focusable にする');
    assert.match(WATCH_APP, /\.digitalCrownRotation\([\s\S]*?crownBinding/, 'Digital Crown をバインドする');
    assert.match(WATCH_APP, /by: 1\.0/, '1段ずつスナップ');
    assert.match(WATCH_APP, /from: 0,[\s\S]*?to: Double\(model\.maxZoomIndex\)/, '0〜3 の4段階');
    assert.match(WATCH_APP, /isContinuous: false/, '両端で止める（回り続けない）');
    assert.match(WATCH_APP, /isHapticFeedbackEnabled: true/, '段が変わるたびに手応えを返す');
    assert.match(WATCH_APP, /model\.setCrownPosition\(\$0\)/, 'クラウンの値はモデルへ渡す');
});

test('Watchズーム: モデルは既存の spans[1] 初期値と連動し、段が変わったときだけ窓を取り直す', () => {
    assert.match(WATCH_MODEL, /private let spans: \[Double\] = \[0\.00225, 0\.0045, 0\.009, 0\.018\]/,
        '既存の4段階を維持');
    assert.match(WATCH_MODEL, /@Published private\(set\) var zoomIndex = 1/, '初期値は 1');
    assert.match(WATCH_MODEL, /var maxZoomIndex: Int \{ spans\.count - 1 \}/);
    assert.match(WATCH_MODEL, /var crownPosition: Double \{ Double\(maxZoomIndex - zoomIndex\) \}/,
        '初期値 1 ならクラウン側は 2 で始まる（上へ回す＝拡大）');
    assert.match(WATCH_MODEL, /func setCrownPosition\(_ position: Double\)/, 'クラウンの連続値を段へ丸める');
    assert.match(WATCH_MODEL, /func setZoomIndex\(_ index: Int\)/);
    // 同じ段のあいだは何もしない＝ requestWindow の連打を防ぐ
    assert.match(WATCH_MODEL, /func setZoomIndex\(_ index: Int\) \{[\s\S]*?guard next != zoomIndex else \{ return \}[\s\S]*?recenterAnimated\(\)[\s\S]*?requestWindow\(\)/);
    assert.match(WATCH_MODEL, /func zoomIn\(\) \{ setZoomIndex\(zoomIndex - 1\) \}/);
    assert.match(WATCH_MODEL, /func zoomOut\(\) \{ setZoomIndex\(zoomIndex \+ 1\) \}/);
});

test('Watch画面: ズームを外してもマーキング ON/OFF は残っている', () => {
    assert.match(WATCH_APP, /model\.toggleMarking\(\)/);
    assert.match(WATCH_APP, /"マーキング ON" : "停止中"/);
    assert.match(WATCH_MODEL, /func toggleMarking\(\)/);
});
