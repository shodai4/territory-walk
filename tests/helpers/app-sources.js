/**
 * TERRITORY WALK - Node tests helper
 * 分割後のアプリ本体（app-config / app-core / … / app.js）を、index.html と同じ順で
 * まとめて読むためのヘルパー。
 *
 * app.js は役割ごとのモジュールに分割されたが、読み込み順に連結したテキストは
 * 分割前の単一 app.js と同じ並び（メソッドの定義順）になる。ソース点検（正規表現）も
 * vm での起動も、この1本の文字列に対して行えば従来どおり検証できる。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// index.html の <script> 順（依存順）。scripts/build.js の ASSETS_TO_COPY と同じ並び
const APP_SOURCE_FILES = [
    'app-config.js',
    'app-core.js',
    'app-map.js',
    'app-stats.js',
    'app-actions.js',
    'app-menus.js',
    'app-geolocation.js',
    'app-marking.js',
    'app-tracking.js',
    'app-gameplay.js',
    'app.js'
];

const readAppFile = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readAppSource = () => APP_SOURCE_FILES.map(readAppFile).join('\n');
// 配布物（www/）側も同じ順で連結して、ルートとの同一性を比べられるようにする
const readWwwAppSource = () => APP_SOURCE_FILES
    .map((file) => fs.readFileSync(path.join(ROOT, 'www', file), 'utf8'))
    .join('\n');

module.exports = { ROOT, APP_SOURCE_FILES, readAppFile, readAppSource, readWwwAppSource };
