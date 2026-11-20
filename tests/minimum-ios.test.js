/**
 * TERRITORY WALK - Node tests
 * 最低対応OS（iOS 15.0）への引き上げ。
 *
 * TestFlight アップロード時に出ていた Apple の警告
 *   code 90068: Deployment target too low. Your app targets iOS 13.0.
 *   Starting in April 2027, iOS apps must target 15.0 or later ...
 * を根絶するため、CI で生成される Capacitor プロジェクトの
 *   - Podfile の `platform :ios`
 *   - project.pbxproj の IPHONEOS_DEPLOYMENT_TARGET（Debug / Release）
 * の両方を configure-ios.js が 15.0 に揃えることを検証する。
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
    MINIMUM_IOS_VERSION,
    configurePodfileContent,
    configureProjectContent,
    verifyPodfileContent,
    verifyProjectContent,
    compareVersions,
    applyMinimumOS
} = require(SCRIPT);

/* ------------------------------------------------------------------ *
 * Capacitor 6 テンプレートに近い Podfile
 * ------------------------------------------------------------------ */
function templatePodfile(platform = "13.0") {
    return `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '${platform}'
use_frameworks!
use_modular_headers!

install! 'cocoapods', :disable_input_output_paths => true

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'CapacitorCordova', :path => '../../node_modules/@capacitor/ios'
  pod 'CordovaPlugins', :path => '../capacitor-cordova-ios-plugins'
end

target 'App' do
  capacitor_pods
end
`;
}

/** Debug / Release の両方に展開先OSが入っている pbxproj の抜粋 */
function templateProject(debug = '13.0', release = '13.0') {
    return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 60;
	objects = {

/* Begin XCBuildConfiguration section */
		AB0001 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				IPHONEOS_DEPLOYMENT_TARGET = ${debug};
				PRODUCT_BUNDLE_IDENTIFIER = com.oekaki.territorywalk;
			};
			name = Debug;
		};
		AB0002 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				IPHONEOS_DEPLOYMENT_TARGET = ${release};
				PRODUCT_BUNDLE_IDENTIFIER = com.oekaki.territorywalk;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
	};
	rootObject = AB0000;
}
`;
}

/* ------------------------------------------------------------------ *
 * 1. バージョン比較
 * ------------------------------------------------------------------ */
test('比較: 13.0 は 15.0 より低く、15.0 と 15 は同じ', () => {
    assert.ok(compareVersions('13.0', '15.0') < 0);
    assert.ok(compareVersions('15.0', '15') === 0);
    assert.ok(compareVersions('15.1', '15.0') > 0);
    assert.ok(compareVersions('16.0', '15.0') > 0);
});

/* ------------------------------------------------------------------ *
 * 2. Podfile
 * ------------------------------------------------------------------ */
test('Podfile: 13.0 は 15.0 に引き上げられる', () => {
    const { content, modified, added } = configurePodfileContent(templatePodfile('13.0'));

    assert.equal(modified, true);
    assert.equal(added, false);
    assert.match(content, /^platform :ios, '15\.0'$/m);
    assert.doesNotMatch(content, /platform :ios, '13\.0'/);
    assert.deepEqual(verifyPodfileContent(content), []);
});

test('Podfile: 既に 15.0 なら書き換えない（冪等）', () => {
    const first = configurePodfileContent(templatePodfile('15.0'));
    const second = configurePodfileContent(first.content);

    assert.equal(first.modified, false);
    assert.equal(second.modified, false);
    assert.equal(second.content, first.content);
});

test('Podfile: platform 行が無いテンプレートでも use_frameworks! の前に追記する', () => {
    const raw = "require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'\n\nuse_frameworks!\n\ntarget 'App' do\n  capacitor_pods\nend\n";
    const { content, modified, added } = configurePodfileContent(raw);

    assert.equal(modified, true);
    assert.equal(added, true);
    assert.match(content, /platform :ios, '15\.0'\nuse_frameworks!/);
    assert.deepEqual(verifyPodfileContent(content), []);
});

test('Podfile: 13.0 のままなら verifyPodfileContent が問題を返す', () => {
    const problems = verifyPodfileContent(templatePodfile('13.0'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /13\.0/);
});

/* ------------------------------------------------------------------ *
 * 3. project.pbxproj
 * ------------------------------------------------------------------ */
test('pbxproj: Debug / Release の両方が 15.0 に上がる', () => {
    const { content, modified, occurrences, raised } = configureProjectContent(templateProject('13.0', '13.0'));

    assert.equal(occurrences, 2);
    assert.equal(raised, 2);
    assert.equal(modified, true);
    assert.equal((content.match(/IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/g) || []).length, 2);
    assert.doesNotMatch(content, /IPHONEOS_DEPLOYMENT_TARGET = 13\.0;/);
    assert.deepEqual(verifyProjectContent(content), []);
});

test('pbxproj: 片方だけ古くても、古い方だけ 15.0 に揃える', () => {
    const { content, raised } = configureProjectContent(templateProject('15.0', '12.4'));

    assert.equal(raised, 1);
    assert.match(content, /Debug[\s\S]*IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
    assert.match(content, /Release[\s\S]*IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
});

test('pbxproj: 既に 15.0 以上なら書き換えない（冪等）', () => {
    const first = configureProjectContent(templateProject('16.0', '16.0'));
    assert.equal(first.modified, false);
    assert.equal(first.raised, 0);
});

test('pbxproj: 指定が無ければ verifyProjectContent が問題を返す', () => {
    const problems = verifyProjectContent('// empty project\n');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /IPHONEOS_DEPLOYMENT_TARGET/);
});

/* ------------------------------------------------------------------ *
 * 4. CLI（実ファイルを書き換える・存在しないものは飛ばす）
 * ------------------------------------------------------------------ */
test('CLI: Podfile と project.pbxproj を実際に書き換え、iOS 15.0 になる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-min-ios-'));
    const plistPath = path.join(dir, 'Info.plist');
    const podfilePath = path.join(dir, 'Podfile');
    const projectPath = path.join(dir, 'project.pbxproj');
    try {
        fs.writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Territory Walk</string>
</dict>
</plist>
`, 'utf8');
        fs.writeFileSync(podfilePath, templatePodfile('13.0'), 'utf8');
        fs.writeFileSync(projectPath, templateProject('13.0', '13.0'), 'utf8');

        const out = execFileSync(process.execPath, [SCRIPT], {
            env: {
                ...process.env,
                IOS_PLIST_PATH: plistPath,
                IOS_PODFILE_PATH: podfilePath,
                IOS_PROJECT_PATH: projectPath
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');

        assert.match(out, /Podfile: minimum iOS set to 15\.0/);
        assert.match(out, /project\.pbxproj: minimum iOS set to 15\.0/);
        assert.match(fs.readFileSync(podfilePath, 'utf8'), /^platform :ios, '15\.0'$/m);
        assert.equal((fs.readFileSync(projectPath, 'utf8').match(/IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/g) || []).length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('applyMinimumOS: ファイルが無ければ何もせず空の結果を返す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-min-ios-'));
    try {
        const results = applyMinimumOS({
            podfilePath: path.join(dir, 'Podfile'),
            projectPath: path.join(dir, 'project.pbxproj')
        });
        assert.deepEqual(results, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ *
 * 5. 配線（CI がこのスクリプトを pod install より前に通すか）
 * ------------------------------------------------------------------ */
test('配線: 最低対応OSは iOS 15.0 で、Apple の 2027年4月要件を満たす', () => {
    assert.equal(MINIMUM_IOS_VERSION, '15.0');
    assert.ok(compareVersions(MINIMUM_IOS_VERSION, '15.0') >= 0);
});

test('配線: CI は configure-ios.js を pod install より先に実行する', () => {
    // 実際に動いているワークフロー（.github/workflows）で確認する。
    // 生成された Podfile / pbxproj を pod install とアーカイブの前に書き換える必要がある。
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'ios-build.yml');
    if (!fs.existsSync(workflowPath)) return; // ローカルに無い場合はスキップ
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const configureIndex = workflow.indexOf('node scripts/configure-ios.js');
    const podInstallIndex = workflow.indexOf('pod install');

    assert.ok(configureIndex > 0, 'configure-ios.js を実行している');
    assert.ok(podInstallIndex > configureIndex, 'pod install より前に設定する');
});

test('配線: ci/ios-build.yml は実際に動くワークフローと同一（手順書の記述と一致）', () => {
    const deployedPath = path.join(ROOT, '.github', 'workflows', 'ios-build.yml');
    const canonicalPath = path.join(ROOT, 'ci', 'ios-build.yml');
    if (!fs.existsSync(deployedPath)) return; // ローカルに無い場合はスキップ
    // 行末の空白は問わない（Web UI で編集すると空行にインデントが残ることがある）
    const normalize = (text) => text.replace(/[ \t]+$/gm, '');
    assert.equal(
        normalize(fs.readFileSync(canonicalPath, 'utf8')),
        normalize(fs.readFileSync(deployedPath, 'utf8')),
        'ci/ios-build.yml と .github/workflows/ios-build.yml がずれている'
    );
});

/* ------------------------------------------------------------------ *
 * バージョン: 公開済みバージョンより上で出す（TestFlight アップロードの 90186/90062 対策）
 * ------------------------------------------------------------------ */
test('バージョン: MARKETING_VERSION を 1.2.1 に揃える（App / Watch 共通）', () => {
    const ios = require(path.join(ROOT, 'scripts', 'configure-ios.js'));
    assert.equal(ios.APP_MARKETING_VERSION, '1.2.1');

    const before = `
        MARKETING_VERSION = 1.0;
        CURRENT_PROJECT_VERSION = 1;
    `;
    const { content, modified, occurrences } = ios.configureMarketingVersionContent(before);
    assert.equal(modified, true);
    assert.equal(occurrences, 1);
    assert.match(content, /MARKETING_VERSION = 1\.2\.1;/);
    assert.match(content, /CURRENT_PROJECT_VERSION = 1;/, 'ビルド番号は触らない');

    // App と Watch の2ターゲット分あっても両方そろえる
    const two = 'MARKETING_VERSION = 1.0;\nMARKETING_VERSION = 1.0;';
    const applied = ios.configureMarketingVersionContent(two);
    assert.equal(applied.occurrences, 2);
    assert.equal((applied.content.match(/MARKETING_VERSION = 1\.2\.1;/g) || []).length, 2);

    // すでに 1.2.1 なら変更しない（冪等）
    assert.equal(ios.configureMarketingVersionContent('MARKETING_VERSION = 1.2.1;').modified, false);
});

test('バージョン: 古い MARKETING_VERSION は点検で検出できる', () => {
    const ios = require(path.join(ROOT, 'scripts', 'configure-ios.js'));
    const problems = ios.verifyMarketingVersionContent('MARKETING_VERSION = 1.0;');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /1\.0/);

    assert.deepEqual(ios.verifyMarketingVersionContent('MARKETING_VERSION = 1.2.1;'), []);
});

test('バージョン: package.json も 1.2.1 に上がっている', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.2.1');
});
