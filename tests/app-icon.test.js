/**
 * TERRITORY WALK - Node tests
 * 確定アプリアイコン「案A」（orange GPS pin on white/black tiles）が
 * iOS・Web・PWA の全アセットに行き渡り、旧デザインの自動生成アイコンに
 * 上書きされないことを固定する。
 *
 *   1) マスター画像 resources/icon-source.png が 1024x1024 RGB（透過なし）
 *   2) resources/icon.png と iOS 1024 マーケティングアイコンがマスターとバイト一致
 *   3) AppIcon.appiconset の全サイズが存在し、寸法・RGB・Contents.json が一致
 *   4) Web/PWA アイコン（favicon.png / favicon.ico / icon-192 / icon-512 / apple-touch-icon）
 *   5) www/ と iOS の Assets.xcassets に同じアイコンが同期されている
 *   6) generate-assets.py がマスター画像から生成する実装であること（旧デザイン復活の防止）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_ICON = path.join(ROOT, 'resources', 'icon-source.png');
const BASE_ICON = path.join(ROOT, 'resources', 'icon.png');
const ICONSET_DIR = path.join(ROOT, 'resources', 'AppIcon.appiconset');
const IOS_ASSETS_ICONSET = path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const GENERATE_SCRIPT = path.join(ROOT, 'scripts', 'generate-assets.py');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build.js');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ios-build.yml');

/** (filename, pixels) - iOS AppIcon.appiconset */
const IOS_SIZES = [
    ['AppIcon-20x20@2x.png', 40],
    ['AppIcon-20x20@3x.png', 60],
    ['AppIcon-29x29@2x.png', 58],
    ['AppIcon-29x29@3x.png', 87],
    ['AppIcon-40x40@2x.png', 80],
    ['AppIcon-40x40@3x.png', 120],
    ['AppIcon-60x60@2x.png', 120],
    ['AppIcon-60x60@3x.png', 180],
    ['AppIcon-76x76@2x.png', 152],
    ['AppIcon-83.5x83.5@2x.png', 167],
    ['AppIcon-512@2x.png', 1024]
];

/** (filename, pixels) - リポジトリ直下の Web / PWA アイコン */
const WEB_ICONS = [
    ['favicon.png', 32],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['apple-touch-icon.png', 180]
];

/** PNG の IHDR を読み、寸法・ビット深度・カラータイプ・透過チャンクの有無を返す */
function readPng(file) {
    const buf = fs.readFileSync(file);
    const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(buf.subarray(0, 8).equals(SIGNATURE), `${path.basename(file)} が PNG ではない`);

    assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${path.basename(file)} に IHDR がない`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];

    // 透過を持ちうるチャンク / カラータイプを検出する
    const colorTypesWithAlpha = [4, 6]; // grayscale+alpha / RGBA
    const paletteWithAlpha = colorType === 3 && buf.includes(Buffer.from('tRNS'));
    const hasTransparencyChunk = buf.includes(Buffer.from('tRNS'));

    return {
        width,
        height,
        bitDepth,
        colorType,
        hasAlpha: colorTypesWithAlpha.includes(colorType) || paletteWithAlpha || hasTransparencyChunk
    };
}

function assertRgbIcon(file, expectedSize) {
    assert.ok(fs.existsSync(file), `アイコンが見つからない: ${path.relative(ROOT, file)}`);
    const png = readPng(file);
    assert.equal(png.width, expectedSize, `${path.basename(file)} の幅が ${expectedSize}px ではない (${png.width}px)`);
    assert.equal(png.height, expectedSize, `${path.basename(file)} の高さが ${expectedSize}px ではない (${png.height}px)`);
    assert.equal(png.bitDepth, 8, `${path.basename(file)} のビット深度が 8 ではない (${png.bitDepth})`);
    assert.equal(png.colorType, 2, `${path.basename(file)} が RGB（カラータイプ2）ではない (${png.colorType})`);
    assert.equal(png.hasAlpha, false, `${path.basename(file)} に透過（tRNS / アルファ）がある`);
}

function readFaviconIcoSizes(file) {
    const buf = fs.readFileSync(file);
    // ICONDIR: reserved(2)=0, type(2)=1, count(2)
    assert.equal(buf.readUInt16LE(0), 0, 'favicon.ico の予約フィールドが 0 ではない');
    assert.equal(buf.readUInt16LE(2), 1, 'favicon.ico が ICO 形式ではない');
    const count = buf.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i += 1) {
        const entry = 6 + i * 16;
        sizes.push([buf[entry], buf[entry + 1]]); // 0 は 256px を意味する
    }
    return sizes;
}

test('マスターアイコン resources/icon-source.png は 1024x1024・透過なし RGB', () => {
    assertRgbIcon(MASTER_ICON, 1024);
});

test('resources/icon.png はマスターとバイト一致（案AがそのままApp Store用アイコンになる）', () => {
    const master = fs.readFileSync(MASTER_ICON);
    const base = fs.readFileSync(BASE_ICON);
    assert.ok(base.equals(master), 'resources/icon.png がマスター画像と一致しない（旧デザインに戻っている可能性）');
});

test('AppIcon.appiconset の全サイズが存在し、寸法・RGB・マスター由来である', () => {
    const contents = JSON.parse(fs.readFileSync(path.join(ICONSET_DIR, 'Contents.json'), 'utf8'));
    const declared = new Set(
        contents.images.filter((image) => image.filename).map((image) => image.filename)
    );

    for (const [filename, px] of IOS_SIZES) {
        const file = path.join(ICONSET_DIR, filename);
        assertRgbIcon(file, px);
        assert.ok(declared.has(filename), `Contents.json に ${filename} の宣言がない`);
    }

    const marketing = contents.images.find((image) => image.idiom === 'ios-marketing');
    assert.ok(marketing, 'Contents.json に ios-marketing（1024x1024）の定義がない');
    assert.equal(marketing.filename, 'AppIcon-512@2x.png');
    assert.equal(marketing.size, '1024x1024');

    const marketingBytes = fs.readFileSync(path.join(ICONSET_DIR, marketing.filename));
    assert.ok(
        marketingBytes.equals(fs.readFileSync(MASTER_ICON)),
        '1024x1024 マーケティングアイコンがマスター画像と一致しない'
    );
});

test('Web/PWA アイコンが揃っていて、すべて寸法どおりの透過なしRGB', () => {
    for (const [filename, px] of WEB_ICONS) {
        assertRgbIcon(path.join(ROOT, filename), px);
    }

    const ico = path.join(ROOT, 'favicon.ico');
    assert.ok(fs.existsSync(ico), 'favicon.ico がない');
    const sizes = readFaviconIcoSizes(ico);
    for (const expected of [[16, 16], [32, 32], [48, 48]]) {
        assert.ok(
            sizes.some(([w, h]) => w === expected[0] && h === expected[1]),
            `favicon.ico に ${expected[0]}x${expected[1]} が含まれていない（実際: ${JSON.stringify(sizes)}）`
        );
    }
});

test('index.html が全アイコンを参照している', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const [filename] of WEB_ICONS) {
        assert.ok(html.includes(filename), `index.html に ${filename} の参照がない`);
    }
    assert.ok(html.includes('rel="icon" href="favicon.ico"'), 'index.html に favicon.ico の参照がない');
    assert.ok(html.includes('rel="apple-touch-icon"'), 'index.html に apple-touch-icon の参照がない');
});

test('www/ と iOS の Assets.xcassets に同じアイコンが同期されている', () => {
    const wwwDir = path.join(ROOT, 'www');
    if (fs.existsSync(wwwDir)) {
        for (const filename of [...WEB_ICONS.map(([name]) => name), 'favicon.ico']) {
            const rootFile = path.join(ROOT, filename);
            const wwwFile = path.join(wwwDir, filename);
            assert.ok(fs.existsSync(wwwFile), `www/${filename} がない（npm run build 未実行）`);
            assert.ok(
                fs.readFileSync(wwwFile).equals(fs.readFileSync(rootFile)),
                `www/${filename} がリポジトリ直下のものと一致しない`
            );
        }
    }

    if (fs.existsSync(IOS_ASSETS_ICONSET)) {
        for (const [filename] of IOS_SIZES) {
            const source = path.join(ICONSET_DIR, filename);
            const target = path.join(IOS_ASSETS_ICONSET, filename);
            assert.ok(fs.existsSync(target), `iOS Assets.xcassets に ${filename} がない`);
            assert.ok(
                fs.readFileSync(target).equals(fs.readFileSync(source)),
                `iOS Assets.xcassets の ${filename} が resources 側と一致しない`
            );
        }
    }
});

test('generate-assets.py はマスター画像から生成し、旧デザインを描画しない', () => {
    const script = fs.readFileSync(GENERATE_SCRIPT, 'utf8');
    assert.ok(script.includes('icon-source.png'), 'generate-assets.py がマスター画像 resources/icon-source.png を参照していない');
    assert.ok(script.includes('shutil.copyfile'), 'generate-assets.py が 1024 アイコンをバイトコピーしていない');

    // 旧デザイン（背景 #09090b にグリッドとアンバーリングを描く手続き型アイコン）の痕跡を禁止する
    assert.equal(script.includes('def create_app_icon'), false, 'generate-assets.py に旧デザインの描画関数が残っている');
    assert.equal(script.includes('draw.pieslice'), false, 'generate-assets.py に旧デザインの描画処理が残っている');
    assert.equal(script.includes('ImageDraw'), false, 'generate-assets.py が図形描画でアイコンを作っている');
});

test('ビルドとCIが全アイコンを同期・検証する配線になっている', () => {
    const build = fs.readFileSync(BUILD_SCRIPT, 'utf8');
    for (const filename of [...WEB_ICONS.map(([name]) => name), 'favicon.ico']) {
        assert.ok(build.includes(`'${filename}'`), `scripts/build.js が ${filename} を www/ へコピーしていない`);
    }

    const workflow = fs.readFileSync(WORKFLOW, 'utf8');
    assert.ok(workflow.includes('python3 scripts/generate-assets.py'), 'CI が generate-assets.py を実行していない');
    assert.ok(workflow.includes('node scripts/setup-ios-assets.js'), 'CI が setup-ios-assets.js を実行していない');

    // generate-assets.py 自体が生成後に寸法・RGB・マスター一致を自己検証し、失敗すれば CI を落とす
    const generate = fs.readFileSync(GENERATE_SCRIPT, 'utf8');
    assert.ok(generate.includes('verification failed'), 'generate-assets.py に生成後の自己検証がない');
    assert.ok(generate.includes('SystemExit'), 'generate-assets.py が検証失敗時に異常終了しない');
});
