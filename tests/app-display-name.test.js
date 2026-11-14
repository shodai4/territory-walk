/**
 * TERRITORY WALK - Node tests
 * ホーム画面に表示されるアプリ名を「テリトリーウォーク」に固定する。
 *
 *   1) capacitor.config.json の appName
 *   2) Info.plist の CFBundleDisplayName / CFBundleName（値の更新・注入・冪等）
 *   3) 言語別 InfoPlist.strings の上書き負け防止
 *   4) CLI（実際にファイルを書き換える）まで通しで確認
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'configure-ios.js');
const {
    APP_DISPLAY_NAME,
    configureContent,
    configureStringsContent,
    verifyStringsContent,
    verifyContent,
    applyLocalizedDisplayName
} = require(SCRIPT);

const DISPLAY_NAME = 'テリトリーウォーク';

/** Capacitor 6 の iOS テンプレートに近い Info.plist（表示名は英語のまま） */
function templatePlist(extra = '') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleDisplayName</key>
\t<string>Territory Walk</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
${extra}</dict>
</plist>
`;
}

function countKey(xml, key) {
    return xml.split(`<key>${key}</key>`).length - 1;
}

/* ------------------------------------------------------------------ *
 * 1. Capacitor 設定
 * ------------------------------------------------------------------ */
test('capacitor.config.json の appName が「テリトリーウォーク」', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
    assert.equal(config.appName, DISPLAY_NAME);
    assert.equal(APP_DISPLAY_NAME, DISPLAY_NAME, 'スクリプト側の定数とも一致');
    assert.equal(config.appId, 'com.oekaki.territorywalk', 'Bundle ID は変えない');
});

/* ------------------------------------------------------------------ *
 * 2. Info.plist
 * ------------------------------------------------------------------ */
test('Info.plist: 英語の表示名を日本語に更新する', () => {
    const { content } = configureContent(templatePlist());

    assert.match(content, /<key>CFBundleDisplayName<\/key>\s*<string>テリトリーウォーク<\/string>/);
    assert.doesNotMatch(content, /Territory Walk/);
    assert.equal(countKey(content, 'CFBundleDisplayName'), 1);
    assert.deepEqual(verifyContent(content), []);
});

test('Info.plist: CFBundleName が無ければ注入し、日本語名に揃える', () => {
    const before = templatePlist();
    assert.equal(countKey(before, 'CFBundleName'), 0);

    const { content } = configureContent(before);

    assert.match(content, /<key>CFBundleName<\/key>\s*<string>テリトリーウォーク<\/string>/);
    assert.equal(countKey(content, 'CFBundleName'), 1);
    // 16文字以内（Apple の推奨）
    assert.ok(DISPLAY_NAME.length <= 16, `CFBundleName は16文字以内（実際: ${DISPLAY_NAME.length}）`);
});

test('Info.plist: 既に日本語でも書き換えず冪等（2回目は modified=false）', () => {
    const first = configureContent(templatePlist());
    const second = configureContent(first.content);

    assert.equal(second.modified, false);
    assert.equal(second.content, first.content);
    assert.deepEqual(verifyContent(second.content), []);
});

test('Info.plist: 他のキー（GPS説明文・暗号化）を壊さない', () => {
    const { content } = configureContent(templatePlist());
    assert.match(content, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.match(content, /<key>NSLocationWhenInUseUsageDescription<\/key>/);
    assert.match(content, /<key>CFBundleIdentifier<\/key>\s*<string>\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>/);
});

/* ------------------------------------------------------------------ *
 * 3. InfoPlist.strings（言語別の上書き）
 * ------------------------------------------------------------------ */
test('InfoPlist.strings: 表示名の行が無ければ追記する', () => {
    const { content, modified } = configureStringsContent('');
    assert.equal(modified, true);
    assert.equal(content, `"CFBundleDisplayName" = "${DISPLAY_NAME}";\n`);
    assert.deepEqual(verifyStringsContent(content), []);
});

test('InfoPlist.strings: 英語の表示名を日本語に差し替える', () => {
    const before = '/* Localized versions of Info.plist keys */\n"CFBundleDisplayName" = "Territory Walk";\n';
    const { content, modified } = configureStringsContent(before);

    assert.equal(modified, true);
    assert.match(content, new RegExp(`"CFBundleDisplayName" = "${DISPLAY_NAME}";`));
    assert.doesNotMatch(content, /Territory Walk/);
    assert.match(content, /Localized versions of Info\.plist keys/, '他の行は残す');
});

test('InfoPlist.strings: 既に正しければ書き換えない', () => {
    const before = `"CFBundleDisplayName" = "${DISPLAY_NAME}";\n`;
    const { content, modified } = configureStringsContent(before);
    assert.equal(modified, false);
    assert.equal(content, before);
});

test('InfoPlist.strings: 検証は古い表示名を見逃さない', () => {
    const problems = verifyStringsContent('"CFBundleDisplayName" = "Territory Walk";\n');
    assert.ok(problems.length > 0);
    assert.match(problems[0], /テリトリーウォーク/);
});

test('InfoPlist.strings: ja.lproj のファイルを実際に更新する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-name-'));
    const plistPath = path.join(dir, 'Info.plist');
    const jaDir = path.join(dir, 'ja.lproj');
    fs.mkdirSync(jaDir);
    const stringsPath = path.join(jaDir, 'InfoPlist.strings');
    fs.writeFileSync(stringsPath, '"CFBundleDisplayName" = "Territory Walk";\n', 'utf8');

    try {
        const updated = applyLocalizedDisplayName(plistPath);
        assert.equal(updated.length, 1, 'ja.lproj が更新対象になる');
        assert.match(fs.readFileSync(stringsPath, 'utf8'), new RegExp(DISPLAY_NAME));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ *
 * 4. CLI 通し
 * ------------------------------------------------------------------ */
test('CLI: Info.plist と ja.lproj の両方に日本語のアプリ名が入る', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-name-'));
    const plistPath = path.join(dir, 'Info.plist');
    const jaDir = path.join(dir, 'ja.lproj');
    fs.mkdirSync(jaDir);
    const stringsPath = path.join(jaDir, 'InfoPlist.strings');

    try {
        fs.writeFileSync(plistPath, templatePlist(), 'utf8');
        fs.writeFileSync(stringsPath, '"CFBundleDisplayName" = "Territory Walk";\n', 'utf8');

        const out = execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, IOS_PLIST_PATH: plistPath },
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');

        assert.match(out, /Home screen name: テリトリーウォーク/);

        const plist = fs.readFileSync(plistPath, 'utf8');
        assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>テリトリーウォーク<\/string>/);
        assert.match(plist, /<key>CFBundleName<\/key>\s*<string>テリトリーウォーク<\/string>/);

        const strings = fs.readFileSync(stringsPath, 'utf8');
        assert.match(strings, /"CFBundleDisplayName" = "テリトリーウォーク";/);
        assert.doesNotMatch(strings, /Territory Walk/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CLI: ios プロジェクトが無いときは何もせず正常終了する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-name-'));
    try {
        const out = execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, IOS_PLIST_PATH: path.join(dir, 'missing', 'Info.plist') },
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');
        assert.match(out, /Info\.plist not found/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
