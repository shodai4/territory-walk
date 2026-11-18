/**
 * TERRITORY WALK - configure-ios.js
 * Automatically configures iOS Info.plist for background GPS tracking,
 * location permissions, dark status bar, AdMob settings, and Apple
 * export compliance (ITSAppUsesNonExemptEncryption = false) for Capacitor.
 *
 * 冪等（何度実行しても同じ結果）で、既存キーの重複を作らず、
 * 値を更新すべきキーだけを更新する。テストからは configureContent() を直接呼べる。
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PLIST_PATH = process.env.IOS_PLIST_PATH
    ? path.resolve(process.env.IOS_PLIST_PATH)
    : path.join(ROOT_DIR, 'ios', 'App', 'App', 'Info.plist');
const PODFILE_PATH = process.env.IOS_PODFILE_PATH
    ? path.resolve(process.env.IOS_PODFILE_PATH)
    : path.join(ROOT_DIR, 'ios', 'App', 'Podfile');
const PROJECT_PATH = process.env.IOS_PROJECT_PATH
    ? path.resolve(process.env.IOS_PROJECT_PATH)
    : path.join(ROOT_DIR, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

/**
 * 最低対応OS（IPHONEOS_DEPLOYMENT_TARGET / Podfile の platform）。
 *
 * Capacitor 6 のテンプレートは 13.0 だが、Apple は 2027年4月以降の
 * アップロード・配布申請で「15.0 以上」を必須にすると告げている
 * （TestFlight アップロード時の警告 code 90068:
 *  "Deployment target too low. Your app targets iOS 13.0. Starting in April 2027,
 *   iOS apps must target 15.0 or later..."）。
 * 2026年11月の初回リリース時点で 15.0 に揃えておけば、
 * 1年後に再申請・再提出を迫られない。iOS 15 は iPhone 6s 以降が対象で、
 * 13.0/14.0 にしか対応していない端末はごく僅か。
 */
const MINIMUM_IOS_VERSION = '15.0';

/**
 * App Store に出すバージョン（CFBundleShortVersionString の元）。
 *
 * 公開済み・審査通過済みのバージョンと同じ番号ではアップロードできない
 * （altool: 90186 "The train version 'X' is closed" / 90062
 *  "CFBundleShortVersionString must contain a higher version than the previously approved version"）。
 *   v1.0 → 1.1（公開済み）
 *   v1.1 → 1.2（2026-11-19: v1.1 の train が closed になったため 1.2 へ）
 * ここを上げるときは package.json と tests/minimum-ios.test.js も揃える。
 * Watch アプリのバージョンも add-watch-target.rb がこの値を読んで揃える。
 */
const APP_MARKETING_VERSION = '1.2';

/**
 * ホーム画面（アイコンの下）に表示するアプリ名。
 * Xcode の PRODUCT_NAME（英語）とは別に、この日本語表示名を Info.plist に固定する。
 *
 * 2026年11月15日、翔大さんの決定でアイコン下が長すぎるため『テリウォーク』へ短縮した。
 * App Store の公式アプリ名（『テリトリーウォーク - 白黒歩行陣取り』）と
 * Web側のタイトル・ロゴ・利用規約内の名称は『テリトリーウォーク』のまま変更しない。
 * ここ（CFBundleDisplayName / CFBundleName）だけが短い表示名を持つ。
 */
const APP_DISPLAY_NAME = 'テリウォーク';

/**
 * Info.plist に入れるべきキー一覧。
 *   mode: 'value'    … 値まで一致させる（違えば書き換える）
 *   mode: 'presence' … キーの存在だけ確認する（ユーザー側の追記を壊さない）
 */
const CONFIG_ENTRIES = [
    {
        // ホーム画面のアイコン下に出るアプリ名（値が違えば書き換える）
        key: 'CFBundleDisplayName',
        value: `<string>${APP_DISPLAY_NAME}</string>`,
        mode: 'value'
    },
    {
        // 内部表示名。16文字以内が推奨のため、ホーム画面の表示名と同じ日本語名で揃える
        key: 'CFBundleName',
        value: `<string>${APP_DISPLAY_NAME}</string>`,
        mode: 'value'
    },
    {
        key: 'NSLocationWhenInUseUsageDescription',
        value: '<string>街を歩いて白黒の陣地を塗り替えるために位置情報を使用します。</string>',
        mode: 'value'
    },
    {
        key: 'NSLocationAlwaysAndWhenInUseUsageDescription',
        value: '<string>画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。</string>',
        mode: 'value'
    },
    {
        key: 'NSLocationAlwaysUsageDescription',
        value: '<string>画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。</string>',
        mode: 'value'
    },
    {
        key: 'UIBackgroundModes',
        value: '<array>\n\t\t<string>location</string>\n\t</array>',
        mode: 'presence'
    },
    {
        key: 'UIViewControllerBasedStatusBarAppearance',
        value: '<false/>',
        mode: 'presence'
    },
    {
        key: 'UIStatusBarStyle',
        value: '<string>UIStatusBarStyleLightContent</string>',
        mode: 'presence'
    },
    {
        // Google AdMob の iOS アプリID（本番。Google のサンプルIDではない）。
        // 値まで一致させる：サンプルIDのまま出荷すると TestFlight / App Store の
        // 実機で本番広告が一切配信されないため、違えば必ず書き換える。
        // 広告ユニットIDは admob.js の ADMOB_AD_UNITS（同じ ca-app-pub-5739782559889389）と対。
        key: 'GADApplicationIdentifier',
        value: '<string>ca-app-pub-5739782559889389~3477680072</string>',
        mode: 'value'
    },
    {
        // App Tracking Transparency (ATT)。審査では「何のために識別子を使うのか」が
        // 具体的に書かれているかを見られる。拒否しても全機能が使えることも明記する。
        key: 'NSUserTrackingUsageDescription',
        value: '<string>利用者に合わせた広告を表示するために、広告識別子（IDFA）の利用許可をお願いしています。許可しない場合も、陣地の塗り替えやランキングなどすべての機能を同じようにご利用いただけます。</string>',
        mode: 'value'
    },
    {
        key: 'SKAdNetworkItems',
        value: '<array>\n\t\t<dict>\n\t\t\t<key>SKAdNetworkIdentifier</key>\n\t\t\t<string>cstr6suwn9.skadnetwork</string>\n\t\t</dict>\n\t</array>',
        mode: 'presence'
    },
    {
        // 輸出コンプライアンス。Apple の暗号化を使うだけで「非免除」ではないため false。
        // これを Info.plist に入れておくと、TestFlight のビルドが
        // 「輸出コンプライアンスがありません」で保留にならず自動配信される。
        key: 'ITSAppUsesNonExemptEncryption',
        value: '<false/>',
        mode: 'value'
    }
];

/* ------------------------------------------------------------------ *
 * XML ヘルパー
 * ------------------------------------------------------------------ */

/** 文字列中の key タグ出現回数 */
function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/** 比較用に空白を正規化する */
function normalizeXml(xml) {
    return String(xml == null ? '' : xml).replace(/\s+/g, ' ').trim();
}

/**
 * `from`（= <key>…</key> の直後）から始まる要素の終端インデックスを返す。
 * 値が無い場合は `from` をそのまま返す。
 */
function findValueEnd(text, from) {
    let i = from;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '<') return from;

    const head = /^<([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/.exec(text.slice(i));
    if (!head) return from;
    if (head[3] === '/') return i + head[0].length; // <false/> のような自己完結

    const tag = head[1];
    let depth = 1;
    let position = i + head[0].length;
    const tagRe = /<\/?([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g;
    tagRe.lastIndex = position;
    let match;
    while ((match = tagRe.exec(text))) {
        if (match[1] !== tag) continue;
        if (match[0].startsWith('</')) {
            depth -= 1;
            if (depth === 0) return tagRe.lastIndex;
        } else if (match[3] !== '/') {
            depth += 1;
        }
    }
    return from;
}

/** 同一キーの2件目以降（キー＋値）を削除する */
function dedupeKey(content, key) {
    const keyTag = `<key>${key}</key>`;
    let result = content;
    let first = true;
    let searchFrom = 0;
    for (;;) {
        const index = result.indexOf(keyTag, searchFrom);
        if (index === -1) break;
        if (first) {
            first = false;
            searchFrom = index + keyTag.length;
            continue;
        }
        // 2件目以降はキー〜値の終端まで（続く空白・改行を含めて）取り除く
        let end = findValueEnd(result, index + keyTag.length);
        if (end <= index + keyTag.length) end = index + keyTag.length;
        let start = index;
        // 行頭のインデントと直前の改行も一緒に消して空行を残さない
        while (start > 0 && (result[start - 1] === '\t' || result[start - 1] === ' ')) start -= 1;
        while (end < result.length && /[ \t]/.test(result[end])) end += 1;
        if (result[end] === '\n') end += 1;
        if (result[start - 1] === '\n' && result[end - 1] === '\n') start -= 1;
        result = result.slice(0, start) + result.slice(end);
        searchFrom = start;
    }
    return result;
}

/** キー1件分の XML を組み立てる */
function entryXml(entry) {
    return `\t<key>${entry.key}</key>\n\t${entry.value}`;
}

/**
 * Info.plist の文字列を設定済みの文字列にして返す（純粋関数）。
 * @returns {{content: string, modified: boolean, actions: Array}}
 */
function configureContent(input, entries = CONFIG_ENTRIES) {
    let content = input;
    const actions = [];

    for (const entry of entries) {
        const keyTag = `<key>${entry.key}</key>`;
        const occurrences = countOccurrences(content, keyTag);

        if (occurrences === 0) {
            const lastDictIndex = content.lastIndexOf('</dict>');
            if (lastDictIndex === -1) {
                actions.push({ key: entry.key, action: 'skipped-no-dict' });
                continue;
            }
            content = content.slice(0, lastDictIndex) + entryXml(entry) + '\n' + content.slice(lastDictIndex);
            actions.push({ key: entry.key, action: 'injected' });
            continue;
        }

        if (occurrences > 1) {
            content = dedupeKey(content, entry.key);
            actions.push({ key: entry.key, action: 'deduped' });
        }

        if (entry.mode !== 'value') {
            if (!actions.some((item) => item.key === entry.key)) {
                actions.push({ key: entry.key, action: 'verified' });
            }
            continue;
        }

        const keyEnd = content.indexOf(keyTag) + keyTag.length;
        const valueEnd = findValueEnd(content, keyEnd);
        const currentValue = valueEnd > keyEnd ? content.slice(keyEnd, valueEnd) : '';
        if (normalizeXml(currentValue) !== normalizeXml(entry.value)) {
            content = content.slice(0, keyEnd) + `\n\t${entry.value}` + content.slice(valueEnd);
            actions.push({ key: entry.key, action: 'updated' });
        } else if (!actions.some((item) => item.key === entry.key)) {
            actions.push({ key: entry.key, action: 'verified' });
        }
    }

    const modified = content !== input;
    return { content, modified, actions };
}

/** 出力後の Info.plist が条件を満たしているか確認する */
function verifyContent(content) {
    const problems = [];
    for (const entry of CONFIG_ENTRIES) {
        const keyTag = `<key>${entry.key}</key>`;
        const occurrences = countOccurrences(content, keyTag);
        if (occurrences !== 1) {
            problems.push(`<key>${entry.key}</key> が ${occurrences} 件あります（1件であるべき）`);
            continue;
        }
        if (entry.mode === 'value') {
            const keyEnd = content.indexOf(keyTag) + keyTag.length;
            const valueEnd = findValueEnd(content, keyEnd);
            const currentValue = valueEnd > keyEnd ? content.slice(keyEnd, valueEnd) : '';
            if (normalizeXml(currentValue) !== normalizeXml(entry.value)) {
                problems.push(`<key>${entry.key}</key> の値が想定と違います`);
            }
        }
    }
    // 鍵括弧の対応（壊れた XML を書いていないか）の簡易チェック
    const opens = (content.match(/<dict>/g) || []).length;
    const closes = (content.match(/<\/dict>/g) || []).length;
    if (opens !== closes) problems.push(`<dict> と </dict> の数が一致しません (${opens}/${closes})`);

    // @capacitor-community/background-geolocation の要件：UIBackgroundModes に location が必要。
    // 手動で他のモードだけを足している Info.plist を見逃さないための点検。
    const modesStart = content.indexOf('<key>UIBackgroundModes</key>');
    if (modesStart !== -1) {
        const modesEnd = content.indexOf('</array>', modesStart);
        const modesBlock = modesEnd === -1 ? '' : content.slice(modesStart, modesEnd);
        if (!/<string>\s*location\s*<\/string>/.test(modesBlock)) {
            problems.push('UIBackgroundModes に location が入っていません（画面消灯中の測位に必須）');
        }
    }

    return problems;
}

/* ------------------------------------------------------------------ *
 * 最低対応OS（iOS 15.0）
 *   Info.plist の MinimumOSVersion は Xcode プロジェクトの
 *   IPHONEOS_DEPLOYMENT_TARGET と Podfile の platform 行から決まる。
 *   Capacitor のテンプレートは 13.0 のままなので、両方を揃える。
 * ------------------------------------------------------------------ */

/** "15.0" と "13" のような表記を数値の配列にして比べる（a<b なら負） */
function compareVersions(a, b) {
    const parse = (value) => String(value == null ? '' : value)
        .split('.')
        .map((part) => parseInt(part, 10))
        .map((num) => (Number.isFinite(num) ? num : 0));
    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        if (l !== r) return l - r;
    }
    return 0;
}

/**
 * Podfile の `platform :ios, '13.0'` を MINIMUM_IOS_VERSION に揃える（純粋関数）。
 * platform 行が無いテンプレートでも、`use_frameworks!` の直前に追記する。
 * @returns {{content: string, modified: boolean, added: boolean}}
 */
function configurePodfileContent(input, minimum = MINIMUM_IOS_VERSION) {
    const source = String(input == null ? '' : input);
    const line = `platform :ios, '${minimum}'`;
    const pattern = /^([ \t]*platform[ \t]+:ios[ \t]*,[ \t]*['"])[0-9.]+(['"])/m;

    if (!pattern.test(source)) {
        const anchor = /^([ \t]*use_frameworks!)/m;
        const content = anchor.test(source)
            ? source.replace(anchor, (_m, keep) => `${line}\n${keep}`)
            : `${line}\n${source}`;
        return { content, modified: content !== source, added: true };
    }

    const content = source.replace(pattern, (_m, head, tail) => `${head}${minimum}${tail}`);
    return { content, modified: content !== source, added: false };
}

/** Podfile の platform が minimum 以上かを点検する */
function verifyPodfileContent(content, minimum = MINIMUM_IOS_VERSION) {
    const found = /^[ \t]*platform[ \t]+:ios[ \t]*,[ \t]*['"]([0-9.]+)['"]/m.exec(String(content == null ? '' : content));
    if (!found) return ['Podfile に platform :ios の指定がありません'];
    if (compareVersions(found[1], minimum) < 0) {
        return [`Podfile の platform は iOS ${found[1]} です（iOS ${minimum} 以上にしてください）`];
    }
    return [];
}

/**
 * Xcode プロジェクト（project.pbxproj）の IPHONEOS_DEPLOYMENT_TARGET を
 * minimum 以上に引き上げる（純粋関数）。Debug/Release の両方に入っている。
 * @returns {{content: string, modified: boolean, occurrences: number, raised: number}}
 */
function configureProjectContent(input, minimum = MINIMUM_IOS_VERSION) {
    const source = String(input == null ? '' : input);
    let occurrences = 0;
    let raised = 0;
    const content = source.replace(/(IPHONEOS_DEPLOYMENT_TARGET[ \t]*=[ \t]*)([0-9.]+)([ \t]*;)/g, (match, head, version, tail) => {
        occurrences += 1;
        if (compareVersions(version, minimum) < 0) {
            raised += 1;
            return `${head}${minimum}${tail}`;
        }
        return match;
    });
    return { content, modified: content !== source, occurrences, raised };
}

/**
 * Xcode プロジェクト（project.pbxproj）の MARKETING_VERSION を version に揃える（純粋関数）。
 * App / Watch の両ターゲットに入っているので、すべて同じ値にする。
 * @returns {{content: string, modified: boolean, occurrences: number}}
 */
function configureMarketingVersionContent(input, version = APP_MARKETING_VERSION) {
    const source = String(input == null ? '' : input);
    let occurrences = 0;
    const content = source.replace(/(MARKETING_VERSION[ \t]*=[ \t]*)([0-9][0-9.]*)([ \t]*;)/g,
        (match, head, current, tail) => {
            occurrences += 1;
            return current === version ? match : `${head}${version}${tail}`;
        });
    return { content, modified: content !== source, occurrences };
}

/** Xcode プロジェクトの MARKETING_VERSION が version かを点検する */
function verifyMarketingVersionContent(content, version = APP_MARKETING_VERSION) {
    const source = String(content == null ? '' : content);
    const found = [...source.matchAll(/MARKETING_VERSION[ \t]*=[ \t]*([0-9][0-9.]*)[ \t]*;/g)].map((m) => m[1]);
    if (found.length === 0) return ['project.pbxproj に MARKETING_VERSION がありません'];
    return found
        .filter((value) => value !== version)
        .map((value) => `MARKETING_VERSION が ${value} です（${version} にしてください）`);
}

/** Xcode プロジェクトの展開先OSが minimum 以上かを点検する */
function verifyProjectContent(content, minimum = MINIMUM_IOS_VERSION) {
    const source = String(content == null ? '' : content);
    const found = [...source.matchAll(/IPHONEOS_DEPLOYMENT_TARGET[ \t]*=[ \t]*([0-9.]+)[ \t]*;/g)].map((m) => m[1]);
    if (found.length === 0) return ['project.pbxproj に IPHONEOS_DEPLOYMENT_TARGET がありません'];
    return found
        .filter((version) => compareVersions(version, minimum) < 0)
        .map((version) => `IPHONEOS_DEPLOYMENT_TARGET が ${version} です（iOS ${minimum} 以上にしてください）`);
}

/**
 * 実ファイルに対して上記を適用する。存在しないファイルは黙って飛ばす。
 * @returns {Array<{file: string, action: string, detail?: string}>}
 */
function applyMinimumOS(targets = {}) {
    const podfilePath = targets.podfilePath || PODFILE_PATH;
    const projectPath = targets.projectPath || PROJECT_PATH;
    const results = [];

    if (fs.existsSync(podfilePath)) {
        try {
            const before = fs.readFileSync(podfilePath, 'utf8');
            const { content, modified, added } = configurePodfileContent(before);
            if (modified) fs.writeFileSync(podfilePath, content, 'utf8');
            results.push({
                file: path.basename(podfilePath),
                action: modified ? (added ? 'added' : 'updated') : 'verified'
            });
        } catch (err) {
            results.push({ file: path.basename(podfilePath), action: 'failed', detail: err.message });
        }
    }

    if (fs.existsSync(projectPath)) {
        try {
            let before = fs.readFileSync(projectPath, 'utf8');
            const os1 = configureProjectContent(before);
            const mv = configureMarketingVersionContent(os1.content);
            if (os1.modified || mv.modified) fs.writeFileSync(projectPath, mv.content, 'utf8');
            results.push({
                file: path.basename(projectPath),
                action: (os1.modified || mv.modified) ? 'updated' : (os1.occurrences > 0 ? 'verified' : 'missing'),
                detail: os1.occurrences > 0
                    ? `${os1.raised} 件を iOS ${MINIMUM_IOS_VERSION} に引き上げ / MARKETING_VERSION ${mv.occurrences} 件を ${APP_MARKETING_VERSION} に`
                    : 'IPHONEOS_DEPLOYMENT_TARGET なし'
            });
        } catch (err) {
            results.push({ file: path.basename(projectPath), action: 'failed', detail: err.message });
        }
    }

    return results;
}

/* ------------------------------------------------------------------ *
 * 匿名IDの永続化（iOS Keychain）プラグイン
 *   ios-plugins/tw-keychain/ のローカル Pod を Podfile に1行追加し、
 *   Capacitor のプラグイン登録表（ios/App/App/capacitor.config.json の
 *   packageClassList）へ TWKeychainPlugin を追記する。
 *   → アプリを削除して再インストールしても、Keychain に残った匿名IDで
 *     同じユーザー・同じチームのまま再開できる（チームの選び直し防止）。
 *   どちらも冪等（何度実行しても重複しない）。
 * ------------------------------------------------------------------ */

const KEYCHAIN_POD_NAME = 'TWKeychain';
const KEYCHAIN_POD_PATH = '../../ios-plugins/tw-keychain';
const KEYCHAIN_POD_LINE = `pod '${KEYCHAIN_POD_NAME}', :path => '${KEYCHAIN_POD_PATH}'`;
const KEYCHAIN_PLUGIN_CLASS = 'TWKeychainPlugin';
const CAPACITOR_CONFIG_PATH = process.env.IOS_CAPACITOR_CONFIG_PATH
    ? path.resolve(process.env.IOS_CAPACITOR_CONFIG_PATH)
    : path.join(ROOT_DIR, 'ios', 'App', 'App', 'capacitor.config.json');

/**
 * Podfile にローカル Pod（TWKeychain）を追加する（純粋関数）。
 * `capacitor_pods` の直後（target 'App' の中）へ差し込む。
 * @returns {{content:string, modified:boolean, added:boolean}}
 */
function configurePodfileKeychain(input) {
    const source = String(input == null ? '' : input);
    if (new RegExp(`pod ['"]${KEYCHAIN_POD_NAME}['"]`).test(source)) {
        return { content: source, modified: false, added: false };
    }

    const anchor = /^([ \t]*)capacitor_pods[ \t]*$/m;
    if (anchor.test(source)) {
        const content = source.replace(anchor, (match, indent) => `${match}\n${indent}${KEYCHAIN_POD_LINE}`);
        return { content, modified: true, added: true };
    }

    const target = /^([ \t]*)target ['"]App['"] do[ \t]*$/m;
    if (target.test(source)) {
        const content = source.replace(target, (match, indent) => `${match}\n${indent}${KEYCHAIN_POD_LINE}`);
        return { content, modified: true, added: true };
    }

    // どのみち Podfile が想定外の形：末尾に追記せず、呼び出し側が警告する
    return { content: source, modified: false, added: false };
}

/** Podfile に TWKeychain が入っているかを点検する */
function verifyPodfileKeychain(content) {
    if (!new RegExp(`pod ['"]${KEYCHAIN_POD_NAME}['"]`).test(String(content == null ? '' : content))) {
        return [`Podfile に ${KEYCHAIN_POD_NAME} の pod 行がありません`];
    }
    return [];
}

/**
 * capacitor.config.json（Capacitor が生成）の packageClassList へ
 * TWKeychainPlugin を追記する（純粋関数）。
 * @returns {{content:string, modified:boolean, list?:string[], error?:string}}
 */
function configureCapacitorConfigContent(input, className = KEYCHAIN_PLUGIN_CLASS) {
    const source = String(input == null ? '' : input);
    let config;
    try {
        config = JSON.parse(source);
    } catch (err) {
        return { content: source, modified: false, error: 'invalid-json' };
    }
    if (!config || typeof config !== 'object') {
        return { content: source, modified: false, error: 'invalid-json' };
    }

    const list = Array.isArray(config.packageClassList) ? config.packageClassList.slice() : [];
    if (list.includes(className)) {
        return { content: source, modified: false, list };
    }

    list.push(className);
    config.packageClassList = list;
    const trailingNewline = /\n$/.test(source) ? '\n' : '';
    return { content: `${JSON.stringify(config, null, '\t')}${trailingNewline}`, modified: true, list };
}

/** capacitor.config.json に TWKeychainPlugin が入っているかを点検する */
function verifyCapacitorConfigContent(content, className = KEYCHAIN_PLUGIN_CLASS) {
    let config;
    try {
        config = JSON.parse(String(content == null ? '' : content));
    } catch (err) {
        return ['capacitor.config.json を JSON として読めません'];
    }
    const list = config && Array.isArray(config.packageClassList) ? config.packageClassList : [];
    if (!list.includes(className)) {
        return [`capacitor.config.json の packageClassList に ${className} がありません`];
    }
    return [];
}

/**
 * 実ファイルに Pod 行とプラグイン登録を適用する。存在しないファイルは黙って飛ばす。
 * @returns {Array<{file:string, action:string, detail?:string}>}
 */
function applyKeychainPlugin(targets = {}) {
    const podfilePath = targets.podfilePath || PODFILE_PATH;
    const configPath = targets.configPath || CAPACITOR_CONFIG_PATH;
    const results = [];

    if (fs.existsSync(podfilePath)) {
        try {
            const before = fs.readFileSync(podfilePath, 'utf8');
            const { content, modified, added } = configurePodfileKeychain(before);
            if (modified) fs.writeFileSync(podfilePath, content, 'utf8');
            const problems = verifyPodfileKeychain(content);
            results.push({
                file: path.basename(podfilePath),
                action: problems.length > 0 ? 'failed' : (added ? 'added' : 'verified'),
                detail: problems.length > 0 ? problems.join(' / ') : KEYCHAIN_POD_LINE
            });
        } catch (err) {
            results.push({ file: path.basename(podfilePath), action: 'failed', detail: err.message });
        }
    }

    if (fs.existsSync(configPath)) {
        try {
            const before = fs.readFileSync(configPath, 'utf8');
            const { content, modified, error } = configureCapacitorConfigContent(before);
            if (error) {
                results.push({ file: path.basename(configPath), action: 'failed', detail: error });
            } else {
                if (modified) fs.writeFileSync(configPath, content, 'utf8');
                const problems = verifyCapacitorConfigContent(content);
                results.push({
                    file: path.basename(configPath),
                    action: problems.length > 0 ? 'failed' : (modified ? 'registered' : 'verified'),
                    detail: KEYCHAIN_PLUGIN_CLASS
                });
            }
        } catch (err) {
            results.push({ file: path.basename(configPath), action: 'failed', detail: err.message });
        }
    }

    return results;
}

/* ------------------------------------------------------------------ *
 * 表示名（InfoPlist.strings）ヘルパー
 * ------------------------------------------------------------------ */

/**
 * 言語別の InfoPlist.strings（CFBundleDisplayName を上書きする）の内容を整える。
 * 既存の行があれば値だけを差し替え、なければ追記する。純粋関数。
 * @returns {{content: string, modified: boolean}}
 */
function configureStringsContent(input, displayName = APP_DISPLAY_NAME) {
    const source = String(input == null ? '' : input);
    const line = `"CFBundleDisplayName" = "${displayName}";`;
    const pattern = /^[ \t]*"CFBundleDisplayName"[ \t]*=[ \t]*"[^"]*"[ \t]*;[ \t]*$/m;

    if (pattern.test(source)) {
        const content = source.replace(pattern, line);
        return { content, modified: content !== source };
    }

    const trimmed = source.replace(/\s*$/, '');
    const content = (trimmed ? `${trimmed}\n` : '') + line + '\n';
    return { content, modified: true };
}

/** InfoPlist.strings が期待どおりの表示名になっているか点検する */
function verifyStringsContent(content, displayName = APP_DISPLAY_NAME) {
    const expected = /^[ \t]*"CFBundleDisplayName"[ \t]*=[ \t]*"([^"]*)"[ \t]*;[ \t]*$/m.exec(String(content == null ? '' : content));
    if (!expected) return ['InfoPlist.strings に "CFBundleDisplayName" がありません'];
    if (expected[1] !== displayName) {
        return [`InfoPlist.strings の表示名が「${expected[1]}」になっています（「${displayName}」であるべき）`];
    }
    return [];
}

/**
 * Info.plist と同じフォルダにある \*.lproj/InfoPlist.strings の表示名を揃える。
 * 存在しない場合は何もしない（Capacitor のテンプレートには無い）。
 * @returns {string[]} 実際に書き換えたファイルのパス
 */
function applyLocalizedDisplayName(plistPath, displayName = APP_DISPLAY_NAME) {
    const dir = path.dirname(plistPath);
    const updated = [];
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return updated;
    }

    entries
        .filter((entry) => entry.isDirectory() && /\.lproj$/.test(entry.name))
        .forEach((entry) => {
            const stringsPath = path.join(dir, entry.name, 'InfoPlist.strings');
            if (!fs.existsSync(stringsPath)) return;
            try {
                const before = fs.readFileSync(stringsPath, 'utf8');
                const { content, modified } = configureStringsContent(before, displayName);
                if (modified) {
                    fs.writeFileSync(stringsPath, content, 'utf8');
                    updated.push(stringsPath);
                }
            } catch (e) {
                console.warn(`[iOS Config] Failed to update ${stringsPath}:`, e.message);
            }
        });

    return updated;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main() {
    console.log('[iOS Config] Checking iOS project configuration...');

    if (!fs.existsSync(PLIST_PATH)) {
        console.log('[iOS Config] Note: ios/App/App/Info.plist not found.');
        console.log('[iOS Config] If you haven\'t added iOS yet, run:');
        console.log('[iOS Config]   npx cap add ios');
        console.log('[iOS Config] Or simply:');
        console.log('[iOS Config]   npm run ios:setup');
        process.exit(0);
    }

    try {
        const original = fs.readFileSync(PLIST_PATH, 'utf8');
        const { content, modified, actions } = configureContent(original);

        for (const item of actions) {
            switch (item.action) {
                case 'injected':
                    console.log(`[iOS Config] Injected permission/config: <key>${item.key}</key>`);
                    break;
                case 'updated':
                    console.log(`[iOS Config] Updated value for <key>${item.key}</key>`);
                    break;
                case 'deduped':
                    console.log(`[iOS Config] Removed duplicate entries for <key>${item.key}</key>`);
                    break;
                case 'skipped-no-dict':
                    console.log(`[iOS Config] Warning: no <dict> found, skipped <key>${item.key}</key>`);
                    break;
                default:
                    console.log(`[iOS Config] Verified: <key>${item.key}</key>`);
            }
        }

        if (modified) {
            fs.writeFileSync(PLIST_PATH, content, 'utf8');
            console.log('[iOS Config] Successfully updated Info.plist (GPS / AdMob / export compliance).');
        } else {
            console.log('[iOS Config] Info.plist is already fully configured.');
        }

        // 言語別の InfoPlist.strings があれば、そちらの表示名も揃える（上書き負けを防ぐ）
        const updatedStrings = applyLocalizedDisplayName(PLIST_PATH);
        updatedStrings.forEach((stringsPath) => {
            console.log(`[iOS Config] Updated display name in ${path.basename(path.dirname(stringsPath))}/InfoPlist.strings`);
        });

        console.log(`[iOS Config] Home screen name: ${APP_DISPLAY_NAME}`);

        // 最低対応OS: Podfile と Xcode プロジェクトを iOS 15.0 に揃える
        // （2027年4月からのApple要件。警告 code 90068 の根絶）
        applyMinimumOS().forEach((item) => {
            switch (item.action) {
                case 'updated':
                case 'added':
                    console.log(`[iOS Config] ${item.file}: minimum iOS set to ${MINIMUM_IOS_VERSION}${item.detail ? ` (${item.detail})` : ''}`);
                    break;
                case 'verified':
                    console.log(`[iOS Config] ${item.file}: minimum iOS ${MINIMUM_IOS_VERSION} verified${item.detail ? ` (${item.detail})` : ''}`);
                    break;
                case 'missing':
                    console.warn(`[iOS Config] ${item.file}: IPHONEOS_DEPLOYMENT_TARGET not found (${item.detail})`);
                    break;
                default:
                    console.warn(`[iOS Config] ${item.file}: minimum iOS could not be applied (${item.detail})`);
            }
        });

        // バージョン（CFBundleShortVersionString の元）: v1.0 は公開済みのため 1.1 に上げる
        if (fs.existsSync(PROJECT_PATH)) {
            const projectText = fs.readFileSync(PROJECT_PATH, 'utf8');
            const { occurrences } = configureMarketingVersionContent(projectText);
            if (occurrences === 0) {
                // テンプレート差異（MARKETING_VERSION を持たない生成物）では止めない
                console.warn('[iOS Config] Warning: project.pbxproj に MARKETING_VERSION がありません（テンプレート差異）');
            } else {
                const versionProblems = verifyMarketingVersionContent(projectText);
                versionProblems.forEach((problem) => console.error(`[iOS Config] ${problem}`));
                if (versionProblems.length > 0) process.exitCode = 1;
                else console.log(`[iOS Config] MARKETING_VERSION ${APP_MARKETING_VERSION} verified (app + watch).`);
            }
        }

        // Keychain（匿名IDの永続化）: ローカル Pod + プラグイン登録
        applyKeychainPlugin().forEach((item) => {
            switch (item.action) {
                case 'added':
                    console.log(`[iOS Config] ${item.file}: ${item.detail} を追記しました`);
                    break;
                case 'registered':
                    console.log(`[iOS Config] ${item.file}: ${item.detail} を packageClassList に登録しました`);
                    break;
                case 'verified':
                    console.log(`[iOS Config] ${item.file}: ${item.detail} を確認しました`);
                    break;
                default:
                    console.warn(`[iOS Config] ${item.file}: Keychain プラグインの設定に失敗しました (${item.detail})`);
                    process.exitCode = 1;
            }
        });

        const problems = verifyContent(fs.readFileSync(PLIST_PATH, 'utf8'));
        if (problems.length > 0) {
            problems.forEach((problem) => console.error(`[iOS Config] Verification failed: ${problem}`));
            process.exitCode = 1;
            return;
        }
        console.log('[iOS Config] Export compliance: ITSAppUsesNonExemptEncryption = false (TestFlight auto-delivery OK).');
    } catch (err) {
        console.error('[iOS Config] Error modifying Info.plist:', err);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    CONFIG_ENTRIES,
    APP_DISPLAY_NAME,
    MINIMUM_IOS_VERSION,
    APP_MARKETING_VERSION,
    PLIST_PATH,
    PODFILE_PATH,
    PROJECT_PATH,
    CAPACITOR_CONFIG_PATH,
    KEYCHAIN_POD_NAME,
    KEYCHAIN_POD_LINE,
    KEYCHAIN_PLUGIN_CLASS,
    configurePodfileKeychain,
    verifyPodfileKeychain,
    configureCapacitorConfigContent,
    verifyCapacitorConfigContent,
    applyKeychainPlugin,
    configureContent,
    configureStringsContent,
    configurePodfileContent,
    configureProjectContent,
    configureMarketingVersionContent,
    verifyMarketingVersionContent,
    verifyStringsContent,
    verifyContent,
    verifyPodfileContent,
    verifyProjectContent,
    applyLocalizedDisplayName,
    applyMinimumOS,
    compareVersions,
    findValueEnd,
    dedupeKey,
    normalizeXml,
    entryXml,
    main
};
