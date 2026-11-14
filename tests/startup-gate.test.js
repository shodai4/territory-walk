/**
 * TERRITORY WALK - Node tests
 * 初回起動ゲート（startup-gate.js）:
 *   1) 初回起動は「ルール説明 → チーム決定画面 → ゲーム開始」の順で、最後のタップまで
 *      位置情報・AdMob(ATT) を開始しない
 *   2) 2回目以降の起動では画面を挟まず、起動直後に一度だけ開始する
 *   3) 開始は一度だけ（ルール説明を開き直しても二重に走らない）
 *
 * 実行: npm test （node --test tests/）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { StartupGate, RULES_SEEN_KEY } = require(path.join(ROOT, 'startup-gate.js'));

/* ------------------------------------------------------------------ *
 * localStorage の最小スタブ
 * ------------------------------------------------------------------ */
function createStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; }
    };
}

/** 開始契機を記録するゲートを作る */
function createGate(initial = {}) {
    const storage = createStorage(initial);
    const started = [];
    const gate = new StartupGate({
        storage,
        onStart: (trigger) => started.push(trigger)
    });
    return { gate, storage, started };
}

/* ------------------------------------------------------------------ *
 * 1. 初回起動：ルール説明ではまだ何も開始しない
 * ------------------------------------------------------------------ */
test('初回起動: 起動直後は位置情報もATTも開始しない（ルール説明のみ）', () => {
    const { gate, storage, started } = createGate();

    assert.equal(gate.hasSeenRules(), false, 'ルール説明は未読');
    assert.equal(gate.begin(), false, 'この場では開始しない');
    assert.deepEqual(started, [], 'onStart は呼ばれない');
    assert.equal(gate.started, false);
    assert.equal(storage.getItem(RULES_SEEN_KEY), null, '既読はまだ記録しない');
});

test('初回起動: 「ゲームをはじめる」後はチーム決定画面を出す（まだ開始しない）', () => {
    const { gate, storage, started} = createGate();
    gate.begin();

    assert.equal(gate.needsTeamDecision(), true, 'チーム決定画面を挟む');
    assert.equal(gate.started, false, 'ここでは開始しない');
    assert.deepEqual(started, [], '許可要求も出さない');
    assert.equal(storage.getItem(RULES_SEEN_KEY), null, '「ゲーム開始」まで既読にしない');
});

test('初回起動: チーム決定画面の「ゲーム開始」で一度だけ開始し、既読を確定する', () => {
    const { gate, storage, started } = createGate();
    gate.begin();

    assert.equal(gate.confirmTeamSelection('white'), true, 'ここで開始する');
    assert.deepEqual(started, ['team-decision'], '開始の契機が1回だけ届く');
    assert.equal(gate.startedBy, 'team-decision');
    assert.equal(gate.selectedTeam, 'white', '決定した陣営を覚える');
    assert.equal(storage.getItem(RULES_SEEN_KEY), 'true', '次回からは起動直後に開始できる');
    assert.equal(gate.needsTeamDecision(), false, '開始後は画面を挟まない');
});

test('初回起動: チーム決定後にもう一度押しても、開始は二重に走らない', () => {
    const { gate, started } = createGate();
    gate.begin();
    gate.confirmTeamSelection('black');

    assert.equal(gate.confirmTeamSelection('black'), false, '2回目以降は開始しない');
    assert.equal(gate.start('manual'), false, '手動の再開始も無視する');
    assert.deepEqual(started, ['team-decision'], 'onStart は通算1回だけ');
});

/* ------------------------------------------------------------------ *
 * 2. 2回目以降の起動：画面を挟まず起動直後に開始
 * ------------------------------------------------------------------ */
test('2回目以降の起動: 既読なら画面を挟まず起動直後に1回だけ開始する', () => {
    const { gate, started } = createGate({ [RULES_SEEN_KEY]: 'true' });

    assert.equal(gate.begin(), true, 'その場で開始する');
    assert.deepEqual(started, ['repeat-launch']);
    assert.equal(gate.startedBy, 'repeat-launch');
    assert.equal(gate.needsTeamDecision(), false, 'チーム決定画面は出さない');

    // ルール説明をメニューから開いて閉じても、もう走らない
    assert.equal(gate.confirmTeamSelection('black'), false);
    assert.deepEqual(started, ['repeat-launch']);
});

/* ------------------------------------------------------------------ *
 * 3. 壊れた保存領域でも安全に動く
 * ------------------------------------------------------------------ */
test('storage が使えない環境でも落ちず、チーム決定から開始できる', () => {
    const started = [];
    const broken = {
        getItem() { throw new Error('SecurityError'); },
        setItem() { throw new Error('QuotaExceededError'); }
    };
    const gate = new StartupGate({ storage: broken, onStart: (t) => started.push(t) });

    assert.equal(gate.hasSeenRules(), false);
    assert.equal(gate.begin(), false, '判定できないときは待機側に倒す');
    assert.equal(gate.markRulesSeen(), false, '保存できなくても落ちない');
    assert.equal(gate.needsTeamDecision(), true);
    assert.equal(gate.confirmTeamSelection('black'), true, 'それでも開始はする');
    assert.deepEqual(started, ['team-decision']);
});

test('onStart が例外を投げてもゲートは開始済みとして扱う', () => {
    const gate = new StartupGate({
        storage: createStorage(),
        onStart: () => { throw new Error('boom'); }
    });

    assert.equal(gate.start('manual'), true);
    assert.equal(gate.start('manual'), false);
    assert.equal(gate.startedBy, 'manual');
});

/* ------------------------------------------------------------------ *
 * 4. 配線の回帰チェック（app.js / admob.js / index.html / build.js / www）
 * ------------------------------------------------------------------ */
test('配線: app.js は位置情報とAdMobを起動ゲート経由で開始する', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    // コンストラクタはゲートを立てる。位置情報の直接開始は startDeferredServices の中だけ。
    assert.match(app, /this\.initStartupGate\(\);/, 'コンストラクタでゲートを立てる');
    const geoCalls = app.match(/this\.initGeolocation\(\)/g) || [];
    assert.equal(geoCalls.length, 1, 'initGeolocation の呼び出しは startDeferredServices の1か所だけ');

    assert.match(
        app,
        /startDeferredServices\(trigger = 'manual'\) \{\s*if \(this\.servicesStarted\) return false;[\s\S]*?this\.initGeolocation\(\);[\s\S]*?this\.adMobManager\.init\(\);/,
        '開始処理は位置情報→AdMobの順に一度だけ走る'
    );
    assert.match(app, /new StartupGate\(\{[\s\S]*?onStart: \(trigger\) => this\.startDeferredServices\(trigger\)/, 'ゲートの開始契機を開始処理へ繋ぐ');
});

test('配線: ルール説明 → チーム決定画面 → ゲーム開始の順に繋がっている', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    assert.match(app, /this\.btnCloseRules\.addEventListener\('click', \(\) => this\.dismissRulesModal\(\)\);/, '「ゲームをはじめる」ボタンが dismissRulesModal を呼ぶ');
    assert.match(
        app,
        /dismissRulesModal\(\) \{[\s\S]*?const needsTeamDecision = this\.startupGate \? this\.startupGate\.needsTeamDecision\(\) : false;[\s\S]*?if \(needsTeamDecision\) \{\s*this\.showTeamDecisionModal\(\);[\s\S]*?return;/,
        '初回はルール説明を閉じた直後にチーム決定画面へ進む'
    );
    assert.match(app, /this\.btnStartGame\.addEventListener\('click', \(\) => this\.confirmTeamDecision\(\)\);/, '「ゲーム開始」ボタンが confirmTeamDecision を呼ぶ');
    assert.match(
        app,
        /confirmTeamDecision\(\) \{[\s\S]*?this\.startupGate\.confirmTeamSelection\(this\.currentTeam\);[\s\S]*?\n    \}/,
        '「ゲーム開始」で既読確定と許可要求の開始を行う'
    );
});

test('チーム決定画面: 陣営（Black / White）に合わせて表示を作り分ける', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(app, /showTeamDecisionModal\(\) \{[\s\S]*?const isWhite = this\.currentTeam === 'white';/, 'currentTeam で出し分ける');
    assert.match(app, /this\.teamDecisionSymbol\.textContent = isWhite \? 'WHITE' : 'BLACK';/);
    assert.match(app, /this\.teamDecisionName\.textContent = isWhite \? 'WHITE（白）陣営' : 'BLACK（黒）陣営';/);

    ['team-decision-modal', 'team-decision-badge', 'team-decision-symbol', 'team-decision-name', 'team-decision-description', 'btn-start-game']
        .forEach((id) => {
            assert.match(html, new RegExp(`id="${id}"`), `${id} が存在する`);
        });
    assert.match(html, /あなたの陣営が決定しました！/, '見出し文言');
    assert.match(html, /ゲーム開始/, '開始ボタン');
    assert.ok(
        html.indexOf('id="team-decision-modal"') > html.indexOf('id="rules-modal"'),
        'チーム決定画面はルール説明より後ろに置く'
    );
});

test('配線: AdMobは deferInit で生成され、init() は二重に初期化しない', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const admob = fs.readFileSync(path.join(ROOT, 'admob.js'), 'utf8');

    assert.match(app, /new AdMobManager\(this, \{ deferInit: true \}\)/, 'ATT許可要求はルール説明より後に回す');
    assert.match(admob, /constructor\(appInstance, options = \{\}\)/, 'deferInit を受け取る');
    assert.match(admob, /if \(!options\.deferInit\) this\.init\(\);/, 'deferInit 指定時は自動初期化しない');
    assert.match(admob, /async init\(\) \{\s*\/\/[^\n]*\n\s*if \(this\.initStarted\) return;/, 'init() は冪等');
});

test('配線: チーム決定画面はトーストやモーダル監視の対象に入れる', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

    const isAnyModalOpen = app.slice(app.indexOf('isAnyModalOpen() {'), app.indexOf('setupModalObservers() {'));
    assert.match(isAnyModalOpen, /'team-decision-modal'/, 'トーストの割り込み対象に入れる');
    const observers = app.slice(app.indexOf('setupModalObservers() {'));
    assert.match(observers, /'team-decision-modal'/, 'モーダル開閉の監視対象に入れる');
});

test('UI配線: index.html が startup-gate.js を app.js より先に読み込む', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    assert.match(html, /<script src="startup-gate\.js\?v=\d{8}v\d+"><\/script>/);
    assert.ok(
        html.indexOf('startup-gate.js') < html.indexOf('src="app.js'),
        'startup-gate.js は app.js より先に読み込む'
    );
    assert.match(html, /id="btn-close-rules"[\s\S]*?ゲームをはじめる/, '初回の開始ボタンが存在する');
});

test('ビルド: www/ にも startup-gate.js が同期されている（iOS側も同じ内容）', () => {
    const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build.js'), 'utf8');
    assert.match(build, /'startup-gate\.js'/, 'ASSETS_TO_COPY に含める');

    const rootFile = fs.readFileSync(path.join(ROOT, 'startup-gate.js'), 'utf8');
    const wwwFile = path.join(ROOT, 'www', 'startup-gate.js');
    assert.ok(fs.existsSync(wwwFile), 'www/startup-gate.js が存在する');
    assert.equal(fs.readFileSync(wwwFile, 'utf8'), rootFile, 'www側と同一内容');
});
