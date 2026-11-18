/**
 * TERRITORY WALK - Node tests
 * iOS バンドル（www/）の容量監査と 404 防止
 *
 *   1) build.js は www/ の HTML が参照するローカルファイルをすべて揃える（404 を出さない）
 *   2) 参照先が欠けていたらビルドを失敗させる（CI が気づく）
 *   3) Web/PWA 用アイコンは index.html が参照しているため www から外さない
 *      （外すと WKWebView 側で 404。GitHub Pages はルート配信なので影響しないが、
 *        iOS バンドルと Web の表示を分けない方針）
 *   4) www/ の容量とアイコンの内訳を測定できる（容量監査）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const build = require(path.join(ROOT, 'scripts', 'build.js'));

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. 参照の収集（ローカルの href / src だけ）
 * ------------------------------------------------------------------ */

test('参照収集: 外部URL・アンカー・クエリ付きを正しく扱う', () => {
    const html = [
        '<link rel="icon" href="icon-512.png">',
        '<link rel="stylesheet" href="style.css?v=20261119v50">',
        '<script src="https://cdn.tailwindcss.com"></script>',
        '<a href="#top">top</a>',
        '<a href="privacy.html">privacy</a>',
        '<img src="data:image/png;base64,AAAA">',
        '<script src="//cdn.example.com/x.js"></script>'
    ].join('\n');

    const refs = build.collectLocalReferences(html).sort();
    assert.deepEqual(refs, ['icon-512.png', 'privacy.html', 'style.css']);
});

/* ------------------------------------------------------------------ *
 * 2. 実際の www/ に 404 が無い
 * ------------------------------------------------------------------ */

test('404防止: www/ が参照しているローカルファイルはすべて存在する', () => {
    const wwwDir = path.join(ROOT, 'www');
    if (!fs.existsSync(wwwDir)) {
        assert.ok(true, 'www/ が未生成の環境ではスキップ（CI は npm run build 後に実行）');
        return;
    }

    const { checked, missing } = build.auditReferences(wwwDir);
    assert.ok(checked >= 20, `参照を実際に検査している（${checked} 件）`);
    assert.deepEqual(missing, [], `www/ に無い参照先: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 3. アイコンは「参照されているから」残す（容量監査）
 * ------------------------------------------------------------------ */

test('容量: Web/PWA 用アイコンは index.html が参照しているので www から外さない', () => {
    const html = read('index.html');
    for (const icon of build.WEB_ICON_FILES) {
        assert.ok(html.includes(icon), `index.html が ${icon} を参照している`);
    }

    const wwwDir = path.join(ROOT, 'www');
    if (!fs.existsSync(wwwDir)) return;
    for (const icon of build.WEB_ICON_FILES) {
        assert.ok(fs.existsSync(path.join(wwwDir, icon)), `www/${icon} がある（参照されているので 404 にしない）`);
    }
});

test('容量: www/ の合計サイズとアイコンの内訳を測定できる', () => {
    const wwwDir = path.join(ROOT, 'www');
    if (!fs.existsSync(wwwDir)) {
        assert.ok(true, 'www/ が未生成の環境ではスキップ');
        return;
    }

    const { files, totalBytes } = build.measureBundle(wwwDir);
    assert.ok(files.length >= 25, '配布物のファイルを列挙する');
    assert.ok(totalBytes > 0);

    const iconBytes = files
        .filter((f) => build.WEB_ICON_FILES.includes(f.name))
        .reduce((sum, f) => sum + f.bytes, 0);
    assert.ok(iconBytes > 0, 'アイコンの容量を合算できる');
    assert.ok(iconBytes < totalBytes, 'アイコンはバンドル全体より小さい');
});

/* ------------------------------------------------------------------ *
 * 4. 一時ディレクトリでビルドを再現する
 * ------------------------------------------------------------------ */

function createTempRoot(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-build-'));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
}

test('ビルド: 参照が揃っていれば成功し、www/ にコピーされる', () => {
    const indexHtml = '<link rel="stylesheet" href="style.css?v=1"><script src="app.js?v=1"></script>';
    const dir = createTempRoot({
        'index.html': indexHtml,
        'style.css': 'body{}',
        'app.js': 'console.log(1);'
    });

    const result = build.build({ rootDir: dir, wwwDir: path.join(dir, 'www'), quiet: true });
    assert.equal(result.copied >= 3, true);
    assert.deepEqual(result.missing, []);
    assert.equal(fs.readFileSync(path.join(dir, 'www', 'app.js'), 'utf8'), 'console.log(1);');
    assert.ok(result.totalBytes > 0);
});

test('ビルド: 参照先が欠けていれば失敗する（404 を配布しない）', () => {
    const dir = createTempRoot({
        'index.html': '<link rel="icon" href="icon-512.png">'
    });

    assert.throws(
        () => build.build({ rootDir: dir, wwwDir: path.join(dir, 'www'), quiet: true }),
        /Missing referenced asset\(s\) in www\/: index\.html -> icon-512\.png/
    );
});

test('ビルド: アプリ側のファイル一覧と www/ の実体が一致する（余計なもの・欠けがない）', () => {
    const wwwDir = path.join(ROOT, 'www');
    if (!fs.existsSync(wwwDir)) {
        assert.ok(true, 'www/ が未生成の環境ではスキップ');
        return;
    }
    const actual = fs.readdirSync(wwwDir).filter((name) => fs.statSync(path.join(wwwDir, name)).isFile()).sort();
    const expected = [...build.ASSETS_TO_COPY].sort();
    assert.deepEqual(actual, expected, 'npm run build のコピー対象と www/ が一致する');
});
