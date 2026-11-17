/**
 * TERRITORY WALK - Node tests
 * v1.1 プロサポーターコード:
 *   ・アプリに有効コードを埋め込まない（旧 TW-SUPPORTER-2026 / SHODAI-PRO は撤去）
 *   ・照合は Supabase RPC `verify_pro_code(input_code)` だけで行い、返るのは true/false
 *   ・成功したときだけ Pro 状態を立てる（既存の localStorage 状態は維持）
 *   ・通信失敗・タイムアウト・空入力では Pro にしない
 *   ・SQL は「常に1行だけ」を保ち、テーブルに公開 SELECT ポリシーを付けない
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_SOURCE = fs.readFileSync(path.join(ROOT, 'pro.js'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'weekly_maintenance.sql'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 最小の DOM / localStorage / Supabase クライアントで ProManager を動かす */
function createHarness(options = {}) {
    const storage = Object.assign({}, options.storage);
    const alerts = [];
    const documentListeners = {};
    const elements = new Map();

    const makeElement = (id) => ({
        id,
        value: '',
        textContent: options.labels && options.labels[id] ? options.labels[id] : '',
        disabled: false,
        innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener(type, cb) {
            documentListeners[`${id}:${type}`] = cb;
        }
    });

    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };

    document.getElementById('input-pro-code'); // 事前に生成しておく（テストから値を入れる）
    const calls = [];
    const rpcImpl = options.rpc || (() => Promise.resolve({ data: false, error: null }));

    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        document,
        localStorage: {
            getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        window: options.window || {},
        setTimeout,
        clearTimeout,
        alert: (message) => alerts.push(message)
    });

    vm.runInContext(PRO_SOURCE, context, { filename: 'pro.js' });
    const ProManager = vm.runInContext('ProManager', context);
    const manager = new ProManager();

    if (options.client !== null) {
        manager.client = options.client || {
            rpc(name, params) {
                calls.push({ name, params });
                return rpcImpl(name, params);
            }
        };
    }

    return { manager, storage, calls, alerts, elements, documentListeners, context };
}

/* ------------------------------------------------------------------ *
 * 1. 固定コードの撤去
 * ------------------------------------------------------------------ */

test('プロコード: アプリに有効コードを埋め込んでいない（旧コードも撤去）', () => {
    assert.doesNotMatch(PRO_SOURCE, /VALID_CODES/, '固定コードの配列を残さない');
    assert.doesNotMatch(PRO_SOURCE, /TW-SUPPORTER-2026/, '旧コード1を残さない');
    assert.doesNotMatch(PRO_SOURCE, /SHODAI-PRO/, '旧コード2を残さない');
    assert.doesNotMatch(INDEX, /TW-SUPPORTER-2026|SHODAI-PRO/, '画面にも旧コードを出さない');
});

test('プロコード: 照合は RPC verify_pro_code だけを使う', () => {
    assert.match(PRO_SOURCE, /this\.RPC_NAME = 'verify_pro_code'/);
    assert.match(PRO_SOURCE, /client\.rpc\(this\.RPC_NAME, \{ input_code: input \}\)/,
        '入力を input_code として RPC に渡す');
});

/* ------------------------------------------------------------------ *
 * 2. 照合の挙動
 * ------------------------------------------------------------------ */

test('プロコード: RPC が true を返したときだけ Pro を有効化する', async () => {
    const h = createHarness({ rpc: () => Promise.resolve({ data: true, error: null }) });

    const ok = await h.manager.activateCode(' TW-ABCD-2345 ');

    assert.equal(ok, true);
    assert.equal(h.storage.territory_pro_unlocked, 'true');
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),
        [{ name: 'verify_pro_code', params: { input_code: 'TW-ABCD-2345' } }],
        '前後の空白を落として送る');
});

test('プロコード: false が返ったら Pro にしない（保存もしない）', async () => {
    const h = createHarness({ rpc: () => Promise.resolve({ data: false, error: null }) });

    const ok = await h.manager.activateCode('TW-XXXX-XXXX');

    assert.equal(ok, false);
    assert.equal(h.storage.territory_pro_unlocked, undefined);
});

test('プロコード: 通信エラー・タイムアウトでは Pro にしない', async () => {
    const failing = createHarness({ rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
    assert.equal(await failing.manager.activateCode('TW-AAAA-2222'), false);
    assert.equal(failing.storage.territory_pro_unlocked, undefined);

    const rejecting = createHarness({ rpc: () => Promise.reject(new Error('offline')) });
    assert.equal(await rejecting.manager.activateCode('TW-AAAA-2222'), false);
    assert.equal(rejecting.storage.territory_pro_unlocked, undefined);
});

test('プロコード: 空入力は RPC を呼ばない', async () => {
    const h = createHarness({ rpc: () => Promise.resolve({ data: true, error: null }) });

    assert.equal(await h.manager.activateCode('   '), false);
    assert.equal(await h.manager.activateCode(null), false);
    assert.equal(h.calls.length, 0);
});

test('プロコード: Supabase クライアントが無い環境では Pro にしない（オフラインで誤解させない）', async () => {
    const h = createHarness({ client: null });
    assert.equal(h.manager.getClient(), null);
    assert.equal(await h.manager.activateCode('TW-ABCD-2345'), false);
    assert.equal(h.storage.territory_pro_unlocked, undefined);
});

test('プロコード: 既存の Pro 状態（localStorage）はそのまま維持される', () => {
    const h = createHarness({ storage: { territory_pro_unlocked: 'true' } });
    assert.equal(h.manager.isPro(), true, '照合方法を変えても既存ユーザーの権利は消さない');

    const fresh = createHarness();
    assert.equal(fresh.manager.isPro(), false);
});

test('プロコード: 画面のボタンは確認中に無効化し、終わったら戻る', async () => {
    let resolveRpc;
    const h = createHarness({
        rpc: () => new Promise((resolve) => { resolveRpc = resolve; }),
        labels: { 'btn-activate-pro': 'コードを有効化' }
    });

    h.manager.initModal({ renderTeamBadge() {}, updateStatsDisplay() {} });
    h.elements.get('input-pro-code').value = 'TW-ABCD-2345';

    const click = h.documentListeners['btn-activate-pro:click'];
    const pending = click();

    const button = h.elements.get('btn-activate-pro');
    assert.equal(button.disabled, true, '通信中は押せない');
    assert.equal(button.textContent, '確認中…');

    resolveRpc({ data: true, error: null });
    await pending;

    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'コードを有効化', '元の文言に戻す');
    assert.equal(h.storage.territory_pro_unlocked, 'true');
});

/* ------------------------------------------------------------------ *
 * 3. SQL（DB側）の設計
 * ------------------------------------------------------------------ */

test('プロSQL: コードは常に1行だけ（check 制約）', () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS public\.pro_access_codes/);
    assert.match(SQL, /CONSTRAINT pro_access_codes_single_row CHECK \(id = 1\)/);
    assert.match(SQL, /ON CONFLICT \(id\) DO UPDATE/, '上書き更新（履歴を残さない）');
});

test('プロSQL: テーブルに公開SELECTポリシーを付けない', () => {
    assert.match(SQL, /ALTER TABLE public\.pro_access_codes ENABLE ROW LEVEL SECURITY/);
    assert.match(SQL, /REVOKE ALL ON TABLE public\.pro_access_codes FROM anon, authenticated/);
    const policies = SQL.match(/CREATE POLICY[^;]*/gi) || [];
    assert.deepEqual(policies, [], 'SELECT を含む公開ポリシーを作らない');
});

test('プロSQL: verify_pro_code は boolean だけを返し、コードを外に出さない', () => {
    const body = SQL.match(/CREATE OR REPLACE FUNCTION public\.verify_pro_code[\s\S]*?\$\$;/);
    assert.ok(body, 'verify_pro_code がある');
    assert.match(body[0], /RETURNS BOOLEAN/);
    assert.match(body[0], /SELECT EXISTS/);
    assert.doesNotMatch(body[0], /RETURNS TABLE|SETOF|returns text/i, 'コード本体は返さない');
    assert.match(SQL, /GRANT EXECUTE ON FUNCTION public\.verify_pro_code\(TEXT\) TO anon, authenticated/);
});

test('プロSQL: 週次（毎週月曜 09:00 JST）に1本へ上書きする', () => {
    assert.match(SQL, /CREATE EXTENSION IF NOT EXISTS pg_cron/);
    assert.match(SQL, /cron\.schedule\(/);
    assert.match(SQL, /'0 0 \* \* 1'/, '月曜 00:00 UTC = 月曜 09:00 JST');
    assert.match(SQL, /public\.rotate_pro_code\(\)/);
});

test('プロSQL: 生成コードは TW-XXXX-XXXX 形式', () => {
    assert.match(SQL, /result\s+TEXT := 'TW-'/);
    assert.match(SQL, /alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/,
        '紛らわしい文字（I/O/0/1）を除く');
});

test('プロSQL: 配布物に同期されている（www には置かない）', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'supabase', 'weekly_maintenance.sql')));
    assert.ok(!fs.existsSync(path.join(ROOT, 'www', 'supabase', 'weekly_maintenance.sql')),
        'SQL はアプリ配布物に含めない');
});
