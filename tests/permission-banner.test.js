/**
 * TERRITORY WALK - Node tests
 * 1) 位置情報拒否バナー（常設表示・許可時の自動非表示）の制御
 * 2) 陣営決定画面の説明文（明示改行で単語途中の折り返しを防ぐ）
 * 3) 既存品質基準の回帰チェック（構文・バナー設置・禁止表記・SEASON RESULT のマス数移設）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { LocationPermissionBanner } = require(path.join(ROOT, 'permission.js'));

/* ------------------------------------------------------------------ *
 * 最小限のDOMスタブ（jsdomを使わずにバナー制御だけを検証する）
 * ------------------------------------------------------------------ */
function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        contains: (name) => set.has(name),
        values: () => [...set]
    };
}

function createStubElement(id, { top = 0, height = 0, hidden = false } = {}) {
    const listeners = {};
    return {
        id,
        classList: createClassList(hidden ? ['hidden'] : []),
        style: {},
        listeners,
        addEventListener(type, handler) {
            (listeners[type] = listeners[type] || []).push(handler);
        },
        dispatch(type) {
            (listeners[type] || []).forEach((handler) => handler({ type, preventDefault() {} }));
        },
        getBoundingClientRect() {
            return { top, bottom: top + height, height, left: 0, right: 375, width: 375 };
        }
    };
}

function createStubDocument({ headerHeight = 150 } = {}) {
    const elements = {
        'location-permission-banner': createStubElement('location-permission-banner', { hidden: true }),
        'btn-location-banner-retry': createStubElement('btn-location-banner-retry')
    };
    const header = createStubElement('header', { top: 0, height: headerHeight });
    return {
        elements,
        getElementById: (id) => elements[id] || null,
        querySelector: (selector) => (selector === 'header' ? header : null)
    };
}

function createBanner(options = {}) {
    const doc = createStubDocument(options);
    const changes = [];
    const banner = new LocationPermissionBanner(doc, {
        retryHandler: options.retryHandler,
        onChange: (visible) => changes.push(visible)
    });
    return { doc, banner, changes };
}

/* ------------------------------------------------------------------ *
 * 1. 権限拒否エラーの判定（Web / Capacitor 双方）
 * ------------------------------------------------------------------ */
test('PERMISSION_DENIED 判定: Web Geolocation(code=1) と Capacitor の拒否文言を拾う', () => {
    const denied = [
        { code: 1, message: 'User denied Geolocation' },
        { code: '1' },
        { code: 'PERMISSION_DENIED' },
        { message: 'User denied Geolocation' },
        { message: 'Location permission was denied' },
        { message: 'Location services are disabled' },
        { message: '位置情報の利用が許可されていません' },
        'Location permission was denied'
    ];
    denied.forEach((error) => {
        assert.equal(LocationPermissionBanner.isPermissionDeniedError(error), true, JSON.stringify(error));
    });

    const notDenied = [
        null,
        undefined,
        { code: 2, message: 'Position unavailable' },
        { code: 3, message: 'Timeout expired' },
        { code: 'OS-PLUG-GLOC-0001', message: 'Location services are not enabled' },
        { message: 'Current location is unavailable' }
    ];
    notDenied.forEach((error) => {
        assert.equal(LocationPermissionBanner.isPermissionDeniedError(error), false, JSON.stringify(error));
    });
});

/* ------------------------------------------------------------------ *
 * 2. 常設表示・許可時の自動非表示
 * ------------------------------------------------------------------ */
test('拒否バナー: 拒否で表示され、許可（取得成功）まで消せない', () => {
    const { doc, banner } = createBanner();
    const el = doc.elements['location-permission-banner'];

    assert.equal(banner.isVisible(), false);

    assert.equal(banner.show(), true, '拒否時は表示される');
    assert.equal(banner.isVisible(), true);

    assert.equal(banner.show(), false, '表示中の再通知では二重表示しない');
    assert.equal(banner.isVisible(), true);

    assert.equal(banner.dismiss, undefined, 'ユーザー操作で消す dismiss は持たない');
    assert.equal(banner.isDismissed, undefined, '閉じた状態の管理も持たない');

    // 何度拒否が続いても、表示中のまま消えない
    banner.show();
    banner.show();
    assert.equal(banner.isVisible(), true);
    assert.equal(el.classList.contains('hidden'), false);

    banner.handlePermissionGranted();
    assert.equal(banner.isDenied, false);
    assert.equal(banner.isVisible(), false, '取得成功で自動的に消える');

    assert.equal(banner.show(), true, '許可後に再び拒否されたら再び表示できる');
    assert.equal(banner.isVisible(), true);

    banner.handlePermissionGranted();
    assert.equal(banner.isVisible(), false);
});

test('拒否バナー: 承認後に再度拒否されても、表示は常設のまま復帰する（一時非表示の概念なし）', () => {
    const { banner } = createBanner();

    banner.show();
    assert.equal(banner.hide(), true);
    assert.equal(banner.isVisible(), false);

    assert.equal(banner.show(), true, 'スクリプト側で隠れた後も次の拒否で必ず再表示');
    assert.equal(banner.isVisible(), true);
});

test('拒否バナー: 表示・非表示の変化を onChange で通知する（トースト位置追従用）', () => {
    const { banner, changes } = createBanner();

    banner.show();
    banner.handlePermissionGranted();

    assert.deepEqual(changes, [true, false]);
});

test('拒否バナー: ヘッダー直下（ヘッダー下端+8px）に配置する', () => {
    const { doc, banner } = createBanner({ headerHeight: 150 });
    const el = doc.elements['location-permission-banner'];

    banner.show();

    assert.equal(el.style.top, '158px');
});

test('拒否バナー: 「再確認」で再取得を依頼し、バナーは出たまま', () => {
    let retryCount = 0;
    const { doc, banner } = createBanner({ retryHandler: () => { retryCount += 1; } });

    banner.show();

    doc.elements['btn-location-banner-retry'].dispatch('click');
    assert.equal(retryCount, 1, '再取得ハンドラが呼ばれる');
    assert.equal(banner.isVisible(), true, '「再確認」を押しても常設バナーは消えない');
});

test('拒否バナー: マークアップが無い場合は安全に何もしない', () => {
    const emptyDoc = { getElementById: () => null, querySelector: () => null };
    const banner = new LocationPermissionBanner(emptyDoc);

    assert.equal(banner.show(), false);
    assert.equal(banner.hide(), false);
    assert.equal(banner.isVisible(), false);
    assert.doesNotThrow(() => banner.handlePermissionGranted());
});

/* ------------------------------------------------------------------ *
 * 3. 陣営決定画面の説明文（明示改行・単語途中の折り返し防止）
 * ------------------------------------------------------------------ */
test('陣営説明: index.html の説明文が読点と文末で改行され、説明専用クラスを持つ', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const block = html.match(/<p id="team-decision-description"[^>]*>([\s\S]*?)<\/p>/);
    assert.ok(block, '説明文の段落がある');
    assert.match(block[0], /class="[^"]*team-assignment-copy[^"]*"/, '折り返し制御クラスが付いている');

    const lines = block[1].split(/<br\s*\/?>/).map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.length, 3, '読点・文末の3行に分かれている');
    lines.forEach((line) => {
        assert.ok(line.length <= 24, `1行が375px幅に収まる長さ（${line.length}文字）: ${line}`);
    });
});

test('陣営説明: app.js が白・黒それぞれを改行付きで差し込む（textContent で改行が潰れない）', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(app, /this\.teamDecisionDescription\.innerHTML =/, 'innerHTML で <br> を反映する');
    assert.doesNotMatch(app, /this\.teamDecisionDescription\.textContent/, 'textContent では改行が消える');

    const white = app.match(/'オートバランサーにより、<br>あなたは白陣営に配属されました。<br>街を歩いた場所が白の陣地になります。'/);
    const black = app.match(/'オートバランサーにより、<br>あなたは黒陣営に配属されました。<br>街を歩いた場所が黒の陣地になります。'/);
    assert.ok(white, '白陣営の文言が改行付きで入っている');
    assert.ok(black, '黒陣営の文言が改行付きで入っている');
});

test('陣営説明: style.css が単語途中の折り返しを抑える指定を持つ', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const block = css.match(/\.team-assignment-copy \{[\s\S]*?\}/);
    assert.ok(block, '.team-assignment-copy のCSSブロックがある');
    assert.match(block[0], /line-break:\s*strict/);
    assert.match(block[0], /word-break:\s*normal/);
    assert.match(block[0], /overflow-wrap:\s*normal/);
});

/* ------------------------------------------------------------------ *
 * 4. 既存品質基準の回帰チェック
 * ------------------------------------------------------------------ */
test('構文: 配信対象の全JSが Node でパースできる', () => {
    const files = [
        'app.js', 'permission.js', 'coins.js', 'grid.js', 'search.js', 'stats.js',
        'supabase.js', 'outbox.js', 'poster.js', 'pro.js', 'iap.js', 'admob.js',
        'scripts/build.js'
    ];
    files.forEach((file) => {
        assert.doesNotThrow(() => {
            execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
        }, `${file} の構文エラー`);
    });
});

test('バナー設置: index.html がバナー要素と permission.js を読み込み、キャッシュバスターが付いている', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(html, /id="location-permission-banner"/);
    assert.match(html, /id="btn-location-banner-retry"/);
    assert.match(html, /位置情報がオフになっています/);
    // iOS の設定アプリには CFBundleDisplayName（テリウォーク）で並ぶため、案内文もその名前に合わせる
    assert.match(html, /設定 ＞ テリウォーク ＞ 位置情報/);
    // 常設化: 閉じるボタン（✕）は持たない
    assert.doesNotMatch(html, /btn-location-banner-close/, '✕ボタンを置かない');
    assert.doesNotMatch(html, /案内を閉じる/, '「閉じる」ラベルを置かない');
    assert.match(html, /permission\.js\?v=\d{8}v\d+/);
    assert.match(html, /style\.css\?v=\d{8}v\d+/);
    assert.match(html, /app\.js\?v=\d{8}v\d+/);
});

test('バナー設置: app.js が拒否時に常設バナーを表示し、取得成功時に自動で消す', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(app, /new LocationPermissionBanner\(/);
    assert.match(app, /LocationPermissionBanner\.isPermissionDeniedError\(error\)/);
    assert.match(app, /this\.locationBanner\.show\(\)/);
    assert.match(app, /this\.locationBanner\.handlePermissionGranted\(\)/);
    assert.match(app, /getNativeGeolocation\(/);
    assert.doesNotMatch(app, /locationBanner\.dismiss\(/, '閉じる操作を呼ばない');
});

test('バナー設置: permission.js に閉じる（dismiss）処理・閉じるボタンの配線が残っていない', () => {
    const js = fs.readFileSync(path.join(ROOT, 'permission.js'), 'utf8');

    assert.doesNotMatch(js, /btn-location-banner-close/);
    assert.doesNotMatch(js, /dismiss\(/, 'dismiss を持たない');
    assert.doesNotMatch(js, /isDismissed/, '一時非表示の状態管理を持たない');
    assert.match(js, /this\.retryButtonId = 'btn-location-banner-retry'/);
});

test('バナーCSS: モーダル(2000)・トースト(1500)より背面、コントロール(1000)より前面', () => {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const block = css.match(/#location-permission-banner \{[\s\S]*?\}/);
    assert.ok(block, 'バナーのCSSブロックがある');
    const zIndex = Number(block[0].match(/z-index:\s*(\d+)/)[1]);
    assert.ok(zIndex > 1000, 'コントロールより前面');
    assert.ok(zIndex < 1500, 'トースト・モーダルより背面');
});

test('禁止表記: ソースに「オセロ」「Othello」を使っていない', () => {
    const files = fs.readdirSync(ROOT).filter((file) => /\.(js|html|css)$/.test(file));
    files.forEach((file) => {
        const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.doesNotMatch(text, /オセロ|Othello/i, `${file} に禁止表記`);
    });
});

test('SEASON RESULT: ゲージ上は％のみ、獲得マス数は詳細テーブルに移設', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.doesNotMatch(app, /\(\$\{result\.(black|white)Total\}マス\)/, 'ゲージ上にマス数を残していない');
    assert.match(html, /id="result-black-tiles"/);
    assert.match(html, /id="result-white-tiles"/);
    assert.match(html, /Black 獲得マス:/);
    assert.match(html, /White 獲得マス:/);
    assert.match(app, /result-black-tiles/);
    assert.match(app, /result-white-tiles/);
});
