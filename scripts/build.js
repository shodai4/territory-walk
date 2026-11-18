/**
 * TERRITORY WALK - build.js
 * Synchronizes web distribution assets into www/ for Capacitor iOS build
 *
 * v1.2 追加（容量と404の点検）:
 *   - コピー後に「www/index.html などが参照しているローカルファイルが www に全部あるか」を
 *     検証する。1つでも欠けると WKWebView 側で 404 になるので、ここでビルドを失敗させる
 *     （GitHub Actions も止まる）。
 *   - www/ の容量監査をログに出す。iOS ネイティブには Web/PWA 用アイコンが不要に見えるが、
 *     index.html が favicon / icon-192 / icon-512 / apple-touch-icon を参照しているため、
 *     www から外すと 404 になる。よって削らず、サイズの内訳だけを毎回可視化する。
 *
 * これらの関数は tests/ios-bundle-assets.test.js が一時ディレクトリで直接呼ぶ。
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const WWW_DIR = path.join(ROOT_DIR, 'www');

const ASSETS_TO_COPY = [
    'index.html',
    'privacy.html',
    'terms.html',
    'support.html',
    'style.css',
    'permission.js',
    'startup-gate.js',
    'debug-tools.js',
    // app.js 分割モジュール（この並びが読み込み順＝依存順。index.html の <script> 順と一致させる）
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
    'app.js',
    'admob.js',
    'iap.js',
    'coins.js',
    'grid.js',
    'outbox.js',
    'privacy.js',
    'notifications.js',
    'watch-bridge.js',
    'poster.js',
    'pro.js',
    'search.js',
    'identity.js',
    'stats.js',
    'supabase.js',
    'favicon.png',
    'favicon.ico',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
    'app-ads.txt'
];

// ローカル参照（href/src）を持つHTML。参照先が www に無いと 404 になる
const HTML_FILES = ['index.html', 'privacy.html', 'terms.html', 'support.html'];

// Web/PWA 用アイコン。index.html が参照しているので www からは外さない（外すと 404）
const WEB_ICON_FILES = ['favicon.ico', 'favicon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

/**
 * HTML からローカルの参照先（href/src のパス部分）を集める。
 * 外部URL（https: など）・プロトコル相対（//）・アンカー（#）・data: は対象外。
 * @param {string} html
 * @returns {string[]} 重複なしの参照パス
 */
function collectLocalReferences(html) {
    const refs = new Set();
    const re = /(?:href|src)\s*=\s*"([^"]+)"/g;
    let match;
    while ((match = re.exec(html))) {
        const raw = String(match[1] || '').trim();
        if (!raw) continue;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
        const withoutQuery = raw.split('?')[0].split('#')[0];
        if (withoutQuery) refs.add(withoutQuery);
    }
    return [...refs];
}

/**
 * www/ の HTML が参照しているローカルファイルが、すべて www/ にあるか検証する。
 * @param {string} wwwDir
 * @returns {{checked: number, missing: string[]}}
 */
function auditReferences(wwwDir = WWW_DIR) {
    const missing = [];
    let checked = 0;

    for (const file of HTML_FILES) {
        const filePath = path.join(wwwDir, file);
        if (!fs.existsSync(filePath)) continue;
        const html = fs.readFileSync(filePath, 'utf8');
        for (const ref of collectLocalReferences(html)) {
            checked += 1;
            if (!fs.existsSync(path.join(wwwDir, ref))) {
                missing.push(`${file} -> ${ref}`);
            }
        }
    }

    return { checked, missing };
}

/** www/ の容量をファイル別に集計する（容量監査用） */
function measureBundle(wwwDir = WWW_DIR) {
    if (!fs.existsSync(wwwDir)) return { files: [], totalBytes: 0 };
    const files = fs.readdirSync(wwwDir)
        .map((name) => {
            const stat = fs.statSync(path.join(wwwDir, name));
            return stat.isFile() ? { name, bytes: stat.size } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.bytes - a.bytes);
    return { files, totalBytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

const formatKB = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;

/**
 * www/ を組み立てる（コピー → 404 検証 → 容量監査）。
 * @param {{rootDir?: string, wwwDir?: string, quiet?: boolean}} options テスト用に出力先を差し替えられる
 * @returns {{copied: number, missing: string[], totalBytes: number, wwwDir: string}}
 */
function build(options = {}) {
    const rootDir = options.rootDir || ROOT_DIR;
    const wwwDir = options.wwwDir || path.join(rootDir, 'www');
    const log = options.quiet === true ? () => {} : (message) => console.log(message);

    log('[Build] Preparing www/ directory for Capacitor iOS...');

    if (!fs.existsSync(wwwDir)) {
        fs.mkdirSync(wwwDir, { recursive: true });
        log('[Build] Created www/ directory.');
    }

    let copiedCount = 0;
    for (const file of ASSETS_TO_COPY) {
        const srcPath = path.join(rootDir, file);
        const destPath = path.join(wwwDir, file);

        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
            log(`[Build] Synced: ${file} -> www/${file}`);
            copiedCount++;
        } else {
            console.warn(`[Build] Warning: Source file ${file} not found.`);
        }
    }

    log(`[Build] Complete! Successfully synced ${copiedCount} files into www/`);

    // 404 検証: HTML が参照しているファイルが www に揃っているか
    const { checked, missing } = auditReferences(wwwDir);
    if (missing.length > 0) {
        throw new Error(`[Build] Missing referenced asset(s) in www/: ${missing.join(', ')}`);
    }
    log(`[Build] Reference check: ${checked} local reference(s) resolved in www/ (no 404).`);

    // 容量監査: iOS バンドルに入る Web 資産の内訳
    const { files, totalBytes } = measureBundle(wwwDir);
    log(`[Build] Bundle size: ${formatKB(totalBytes)} across ${files.length} file(s).`);
    const iconBytes = files
        .filter((f) => WEB_ICON_FILES.includes(f.name))
        .reduce((sum, f) => sum + f.bytes, 0);
    log(`[Build] Web/PWA icons: ${formatKB(iconBytes)} (kept: index.html references them, removing would 404).`);
    for (const file of files.slice(0, 6)) {
        log(`[Build]   ${formatKB(file.bytes).padStart(8)}  ${file.name}`);
    }

    return { copied: copiedCount, missing, totalBytes, wwwDir };
}

if (require.main === module) {
    build();
}

module.exports = {
    ASSETS_TO_COPY,
    HTML_FILES,
    WEB_ICON_FILES,
    collectLocalReferences,
    auditReferences,
    measureBundle,
    build
};
