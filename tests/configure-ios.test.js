/**
 * TERRITORY WALK - Node tests
 * scripts/configure-ios.js が Info.plist に
 * ITSAppUsesNonExemptEncryption = false（輸出コンプライアンス）を
 * 冪等に注入し、既存設定を壊さないことを検証する。
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
const { configureContent, verifyContent, CONFIG_ENTRIES, APP_DISPLAY_NAME } = require(SCRIPT);

const KEY = 'ITSAppUsesNonExemptEncryption';

/* ------------------------------------------------------------------ *
 * Capacitor 6 の iOS テンプレートに近い Info.plist
 * ------------------------------------------------------------------ */
function templatePlist(extra = '') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Territory Walk</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UISceneConfigurationName</key>
			<string>Default Configuration</string>
		</dict>
	</dict>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>armv7</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<false/>
${extra}</dict>
</plist>
`;
}

/** キーの出現回数 */
function countKey(xml, key) {
    return xml.split(`<key>${key}</key>`).length - 1;
}

/** Info.plist を python3 の plistlib で読み、オブジェクトとして返す（無ければ null） */
function readPlistWithPython(filePath) {
    try {
        const out = execFileSync(
            'python3',
            ['-c', 'import json,plistlib,sys;print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),ensure_ascii=False,default=str))', filePath],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        return JSON.parse(out.toString('utf8'));
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.status === 127)) return null;
        throw err;
    }
}

/* ------------------------------------------------------------------ *
 * 1. 注入
 * ------------------------------------------------------------------ */
test('輸出コンプライアンス: 未設定なら <key>ITSAppUsesNonExemptEncryption</key><false/> を注入する', () => {
    const before = templatePlist();
    assert.equal(countKey(before, KEY), 0);

    const { content, modified, actions } = configureContent(before);

    assert.equal(modified, true);
    assert.equal(countKey(content, KEY), 1, 'キーは1件だけ');
    assert.match(content, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.ok(actions.some((item) => item.key === KEY && item.action === 'injected'));
    assert.deepEqual(verifyContent(content), []);
});

test('輸出コンプライアンス: 注入先はルート dict で、入れ子の dict の中に入らない', () => {
    const { content } = configureContent(templatePlist());
    const rootClose = content.lastIndexOf('</dict>');
    const keyIndex = content.indexOf(`<key>${KEY}</key>`);

    assert.ok(keyIndex > 0);
    assert.ok(keyIndex < rootClose, 'キーはルート dict の閉じタグより前');
    // 入れ子の UIApplicationSceneManifest ブロックより後ろ（＝ルート直下）に置かれている
    assert.ok(keyIndex > content.indexOf('<key>UIApplicationSceneManifest</key>'));
    assert.ok(keyIndex > content.indexOf('<key>UILaunchStoryboardName</key>'));
});

/* ------------------------------------------------------------------ *
 * 2. 冪等性・重複排除
 * ------------------------------------------------------------------ */
test('冪等性: 2回続けて実行しても出力が変わらず、キーも1件のまま', () => {
    const first = configureContent(templatePlist());
    const second = configureContent(first.content);

    assert.equal(second.content, first.content);
    assert.equal(second.modified, false, '2回目は書き換えなし');
    assert.equal(countKey(second.content, KEY), 1);
    assert.ok(second.actions.every((item) => item.action === 'verified' || item.action === 'deduped'));
});

test('重複排除: 同じキーが複数あっても1件にまとめる', () => {
    const duplicated = templatePlist(`\t<key>${KEY}</key>\n\t<false/>\n\t<key>${KEY}</key>\n\t<false/>\n`);
    assert.equal(countKey(duplicated, KEY), 2);

    const { content, actions } = configureContent(duplicated);

    assert.equal(countKey(content, KEY), 1);
    assert.ok(actions.some((item) => item.key === KEY && item.action === 'deduped'));
    assert.match(content, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.deepEqual(verifyContent(content), []);
});

test('値の訂正: 既に <true/> で入っていても <false/> に直す', () => {
    const wrong = templatePlist(`\t<key>${KEY}</key>\n\t<true/>\n`);
    const { content, actions } = configureContent(wrong);

    assert.match(content, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    assert.equal(countKey(content, KEY), 1);
    assert.doesNotMatch(content, new RegExp(`<key>${KEY}</key>\\s*<true/>`));
    assert.ok(actions.some((item) => item.key === KEY && item.action === 'updated'));
    assert.deepEqual(verifyContent(content), []);
});

/* ------------------------------------------------------------------ *
 * 3. 既存設定を壊さない
 * ------------------------------------------------------------------ */
test('既存設定の保護: 手で足した SKAdNetworkItems / UIBackgroundModes を上書きしない', () => {
    const extra = `\t<key>SKAdNetworkItems</key>
	<array>
		<dict>
			<key>SKAdNetworkIdentifier</key>
			<string>cstr6suwn9.skadnetwork</string>
		</dict>
		<dict>
			<key>SKAdNetworkIdentifier</key>
			<string>v9wttpbfk9.skadnetwork</string>
		</dict>
	</array>
	<key>UIBackgroundModes</key>
	<array>
		<string>location</string>
		<string>audio</string>
	</array>
`;
    const raw = templatePlist(extra);
    const { content } = configureContent(raw);

    assert.match(content, /v9wttpbfk9\.skadnetwork/, '追加済みネットワークが残る');
    assert.match(content, /<string>audio<\/string>/, '追加済みバックグラウンドモードが残る');
    assert.equal(countKey(content, 'SKAdNetworkItems'), 1);
    assert.equal(countKey(content, 'UIBackgroundModes'), 1);
    assert.equal(countKey(content, KEY), 1);
});

test('位置情報の説明文: 古い文言は現行の文言に更新される', () => {
    const stale = templatePlist(`\t<key>NSLocationWhenInUseUsageDescription</key>\n\t<string>古い説明</string>\n`);
    const { content } = configureContent(stale);
    const expected = CONFIG_ENTRIES.find((entry) => entry.key === 'NSLocationWhenInUseUsageDescription').value;

    assert.ok(content.includes(`<key>NSLocationWhenInUseUsageDescription</key>\n\t${expected}`));
    assert.doesNotMatch(content, /古い説明/);
});

test('検証: キーが欠けていれば verifyContent が問題を返す', () => {
    const problems = verifyContent(templatePlist());
    assert.ok(problems.length > 0);
    assert.ok(problems.some((problem) => problem.includes(KEY)));
});

/* ------------------------------------------------------------------ *
 * 4. CLI（実際にファイルを書き換える）
 * ------------------------------------------------------------------ */
test('CLI: Info.plist を書き換え、plistlib で読んでも false になっている', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-config-'));
    const plistPath = path.join(dir, 'Info.plist');
    try {
        fs.writeFileSync(plistPath, templatePlist(), 'utf8');

        const out = execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, IOS_PLIST_PATH: plistPath },
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');

        assert.match(out, /Injected permission\/config: <key>ITSAppUsesNonExemptEncryption<\/key>/);
        assert.match(out, /Export compliance: ITSAppUsesNonExemptEncryption = false/);

        const written = fs.readFileSync(plistPath, 'utf8');
        assert.match(written, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);

        const parsed = readPlistWithPython(plistPath);
        if (parsed) {
            assert.equal(parsed[KEY], false, 'plist として読んで false');
            assert.equal(parsed.CFBundleDisplayName, APP_DISPLAY_NAME, 'ホーム画面のアプリ名は日本語');
            assert.ok(parsed.UIApplicationSceneManifest, '入れ子 dict も保たれている');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CLI: 2回目の実行では書き換えず「already fully configured」で終わる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-config-'));
    const plistPath = path.join(dir, 'Info.plist');
    try {
        fs.writeFileSync(plistPath, templatePlist(), 'utf8');
        execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, IOS_PLIST_PATH: plistPath },
            stdio: 'pipe'
        });
        const afterFirst = fs.readFileSync(plistPath, 'utf8');

        const out = execFileSync(process.execPath, [SCRIPT], {
            env: { ...process.env, IOS_PLIST_PATH: plistPath },
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');

        assert.match(out, /already fully configured/);
        assert.equal(fs.readFileSync(plistPath, 'utf8'), afterFirst);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CLI: ios プロジェクトが無いときは何もせず正常終了する', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ios-config-'));
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

/* ------------------------------------------------------------------ *
 * 5. 配線の回帰チェック（CI がこの設定を実際に通るか）
 * ------------------------------------------------------------------ */
test('配線: package.json の cap:sync / ios:config が configure-ios.js を実行する', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['cap:sync'], /node scripts\/configure-ios\.js/);
    assert.match(pkg.scripts['ios:config'], /node scripts\/configure-ios\.js/);
});

test('配線: GitHub Actions が Info.plist 設定ステップで configure-ios.js を実行する', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ios-build.yml'), 'utf8');
    assert.match(workflow, /node scripts\/configure-ios\.js/);
    // 設定はビルド（アーカイブ）より前に行われること
    const configureIndex = workflow.indexOf('node scripts/configure-ios.js');
    const archiveIndex = workflow.indexOf('Archive iOS App');
    assert.ok(configureIndex > 0 && archiveIndex > configureIndex);
});
