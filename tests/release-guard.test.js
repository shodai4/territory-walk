/**
 * TERRITORY WALK - Node tests
 * App Store 提出前の「審査で落ちる地雷」総点検（リリースガード）。
 *
 *   1) 画面に出る文言に「準備中」「TODO」「ダミー」「未実装」等が残っていない
 *      （コメントは審査員に見えないので除外し、実際に表示される文字だけを見る）
 *   2) 法務3ページ（privacy / terms / support）が存在し、相互リンクと
 *      アプリ内リンクが生きている
 *   3) プライバシーポリシーが現行仕様（位置情報・バックグラウンド測位・
 *      Supabase・AdMobのバナー/リワード・App内課金・OpenStreetMap）を網羅している
 *   4) サポート窓口（メール・GitHub Issues）と対応OSの記載がある
 *   5) 地図の著作権表示（OpenStreetMap）が画面に出ている
 *   6) app-ads.txt が AdMob のパブリッシャーIDで用意されている
 *   7) App Store 用ドキュメントの商品ID・Bundle ID が実装と一致している
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const HTML_FILES = ['index.html', 'privacy.html', 'terms.html', 'support.html'];
const JS_FILES = ['app.js', 'iap.js', 'admob.js', 'coins.js', 'stats.js', 'pro.js', 'poster.js', 'search.js', 'grid.js', 'outbox.js', 'supabase.js', 'permission.js', 'startup-gate.js', 'debug-tools.js'];

/** HTMLコメント・JSコメントを落として「実際に画面へ出る文字」だけにする */
function stripComments(source, isHtml) {
    if (isHtml) return source.replace(/<!--[\s\S]*?-->/g, '');
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ------------------------------------------------------------------ *
 * 1. 仮文言・未実装の残存
 * ------------------------------------------------------------------ */
test('文言: 画面に出る文字に「準備中」「TODO」「ダミー」「未実装」等が残っていない', () => {
    const forbidden = ['準備中', 'TODO', 'FIXME', 'ダミー', 'テスト用', '未実装', 'coming soon', 'Coming Soon', 'lorem ipsum'];
    const offenders = [];

    HTML_FILES.forEach((file) => {
        const text = stripComments(read(file), true);
        forbidden.forEach((word) => {
            if (text.includes(word)) offenders.push(`${file}: ${word}`);
        });
    });
    JS_FILES.forEach((file) => {
        const text = stripComments(read(file), false);
        forbidden.forEach((word) => {
            if (text.includes(word)) offenders.push(`${file}: ${word}`);
        });
    });

    assert.deepEqual(offenders, [], `審査で問題になる文言が残っています: ${offenders.join(', ')}`);
});

test('文言: 動かない外部決済ボタン（Stripe等）を残していない', () => {
    const html = read('index.html');
    assert.doesNotMatch(html, /Stripe/i, 'App Store ではデジタル商品を外部決済で販売できない（3.1.1）');
});

test('文言: サポーターコードの実例を画面に出していない', () => {
    const html = read('index.html');
    const proSource = read('pro.js');
    const codes = [...proSource.matchAll(/VALID_CODES\s*=\s*\[([^\]]*)\]/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')))
        .filter(Boolean);
    codes.forEach((code) => {
        assert.ok(!html.includes(code), `有効なコード「${code}」が index.html に出ている`);
    });
});

/* ------------------------------------------------------------------ *
 * 2. 法務ページとリンク
 * ------------------------------------------------------------------ */
test('法務: privacy / terms / support の3ページが存在し、www/ にも同期されている', () => {
    ['privacy.html', 'terms.html', 'support.html'].forEach((file) => {
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} がある`);
        assert.equal(read(path.join('www', file)), read(file), `www/${file} が同期されている`);
    });
});

test('法務: 3ページが相互にリンクし、アプリ本体からも辿れる', () => {
    const pages = {
        'privacy.html': ['terms.html', 'support.html'],
        'terms.html': ['privacy.html', 'support.html'],
        'support.html': ['privacy.html', 'terms.html']
    };
    Object.entries(pages).forEach(([file, links]) => {
        const html = read(file);
        links.forEach((link) => {
            assert.ok(html.includes(`href="${link}"`), `${file} から ${link} へリンクしている`);
            assert.ok(fs.existsSync(path.join(ROOT, link)), `${link} が実在する`);
        });
    });

    // アプリ内（MENU・ショップのフッター）
    ['index.html', 'coins.js'].forEach((file) => {
        const text = read(file);
        ['terms.html', 'privacy.html', 'support.html'].forEach((link) => {
            assert.ok(text.includes(link), `${file} から ${link} へリンクしている`);
        });
    });
});

test('法務: 連絡先（メール）と不具合受付が記載されている', () => {
    const support = read('support.html');
    const privacy = read('privacy.html');

    [support, privacy].forEach((html, index) => {
        const name = index === 0 ? 'support.html' : 'privacy.html';
        assert.match(html, /mailto:[^"']+@[^"']+/, `${name} にメール窓口がある`);
        assert.match(html, /github\.com\/shodai4\/territory-walk\/issues/, `${name} にGitHub Issues の窓口がある`);
        assert.match(html, /お絵描き楽しも委員会/, `${name} に運営者名がある`);
    });
});

/* ------------------------------------------------------------------ *
 * 3. プライバシーポリシーと実装の一致
 * ------------------------------------------------------------------ */
test('プライバシー: 位置情報・バックグラウンド・Supabase・AdMob・課金・地図を明記している', () => {
    const privacy = read('privacy.html');
    const required = [
        ['位置情報', /位置情報/],
        ['バックグラウンド測位', /バックグラウンド/],
        ['Supabase', /Supabase/],
        ['AdMob（バナー）', /バナー広告/],
        ['AdMob（リワード）', /動画リワード/],
        ['ATT（トラッキング）', /App Tracking Transparency|ATT/],
        ['App内課金（Apple）', /StoreKit|App Store/],
        ['地図（OpenStreetMap）', /OpenStreetMap/],
        ['データ削除の窓口', /削除/]
    ];
    required.forEach(([label, pattern]) => {
        assert.match(privacy, pattern, `プライバシーポリシーに ${label} の記載がない`);
    });
});

test('プライバシー: 実装で使っている外部サービスと一致している', () => {
    const privacy = read('privacy.html');
    const supabase = read('supabase.js');
    const admob = read('admob.js');
    const search = read('search.js');

    if (supabase.includes('supabase.co')) assert.match(privacy, /Supabase/);
    if (admob.includes('ca-app-pub-')) assert.match(privacy, /AdMob/);
    if (search.includes('nominatim.openstreetmap.org')) assert.match(privacy, /Nominatim/);
});

test('プライバシー: ATT で拒否しても全機能が使えることを書いている', () => {
    const privacy = read('privacy.html');
    assert.match(privacy, /許可しない場合でも[^。]*すべての機能/);
});

/* ------------------------------------------------------------------ *
 * 4. サポート内容とアプリ仕様の一致
 * ------------------------------------------------------------------ */
test('サポート: 対応OS・復元・マーキング停止・データ削除のFAQがある', () => {
    const support = read('support.html');
    assert.match(support, /iOS 15\.0以降/, '対応OS');
    assert.match(support, /購入の復元/, '購入の復元');
    assert.match(support, /マーキング/, 'マーキング停止');
    assert.match(support, /削除/, 'データ削除');
});

test('サポート: 記載の価格がアプリの商品カタログと一致している', () => {
    const support = read('support.html');
    const iap = read('iap.js');
    const prices = [...new Set([...iap.matchAll(/yen:\s*(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    prices.forEach((yen) => {
        const label = yen.toLocaleString('ja-JP');
        assert.ok(
            support.includes(`¥${label}`) || support.includes(`${yen}円`),
            `カタログ価格 ¥${label} がサポートページに無い`
        );
    });
});

/* ------------------------------------------------------------------ *
 * 5. 地図の著作権表示
 * ------------------------------------------------------------------ */
test('地図: OpenStreetMap の帰属表示が画面に出ている（タイル利用ポリシー）', () => {
    const html = read('index.html');
    assert.match(html, /id="map-attribution"/, '帰属表示の要素がある');
    assert.match(html, /openstreetmap\.org\/copyright/, '著作権ページへリンクしている');
    assert.match(html, /© OpenStreetMap contributors/, '表記は「© OpenStreetMap contributors」');
});

/* ------------------------------------------------------------------ *
 * 6. app-ads.txt（AdMob の収益化に必要）
 * ------------------------------------------------------------------ */
test('app-ads.txt: AdMob のパブリッシャーIDで用意され、www/ にも同期されている', () => {
    const admob = read('admob.js');
    const appId = /ca-app-pub-(\d+)~\d+/.exec(admob);
    assert.ok(appId, 'admob.js にアプリIDがある');
    const publisher = `pub-${appId[1]}`;

    ['app-ads.txt', path.join('www', 'app-ads.txt')].forEach((file) => {
        assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} がある`);
        const text = read(file).trim();
        assert.match(text, new RegExp(`^google\\.com, ${publisher}, DIRECT, f08c47fec0942fa0$`, 'm'));
    });
});

/* ------------------------------------------------------------------ *
 * 7. App Store 申請資料と実装の一致
 * ------------------------------------------------------------------ */
test('申請資料: Bundle ID と商品IDが実装と一致している', () => {
    const config = JSON.parse(read('capacitor.config.json'));
    const iap = read('iap.js');
    const metadata = read(path.join('docs', 'app-store-metadata.md'));

    assert.equal(config.appId, 'com.oekaki.territorywalk');
    assert.ok(metadata.includes(config.appId), 'メタデータに Bundle ID がある');

    const productIds = [...new Set([...iap.matchAll(/id:\s*'(com\.shodai\.territorywalk\.[a-z0-9]+)'/g)].map((m) => m[1]))];
    assert.equal(productIds.length, 5, '5商品そろっている');
    productIds.forEach((id) => {
        assert.ok(metadata.includes(id), `メタデータに ${id} が無い（App Store Connect 登録と一致させる）`);
    });
});

test('申請資料: 年齢制限の記載が本文全体で矛盾していない', () => {
    const metadata = read(path.join('docs', 'app-store-metadata.md'));
    assert.doesNotMatch(metadata, /12歳以上推奨/, '「12歳以上推奨」と「すべて いいえ（4+）」が併記されていた');
});

test('申請資料: 実装していない特典を説明文に書いていない', () => {
    const metadata = read(path.join('docs', 'app-store-metadata.md'));
    const guide = read(path.join('docs', 'app-store-release-guide.md'));
    const code = read('stats.js') + read('app.js') + read('coins.js');

    // シーズン勝利のコインボーナスは未実装（実装されたらこのガードを外す）
    if (!/シーズン勝利ボーナス|winnerBonus/.test(code)) {
        assert.doesNotMatch(metadata, /シーズン勝利ボーナス/, '説明文が未実装のボーナスを約束している');
        assert.doesNotMatch(guide, /勝利陣営にはボーナスコインが付与/, '説明文が未実装のボーナスを約束している');
    }
});

test('申請資料: 最低対応OS（iOS 15.0）が申請資料とサポートページで一致している', () => {
    const { MINIMUM_IOS_VERSION } = require(path.join(ROOT, 'scripts', 'configure-ios.js'));
    const support = read('support.html');
    const metadata = read(path.join('docs', 'app-store-metadata.md'));

    assert.equal(MINIMUM_IOS_VERSION, '15.0');
    assert.match(support, new RegExp(`iOS ${MINIMUM_IOS_VERSION}以降`));
    assert.match(metadata, new RegExp(`iOS ${MINIMUM_IOS_VERSION}`));
});
