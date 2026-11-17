/**
 * distribute-testflight.mjs の単体テスト（ネットワーク・実キー不要）
 *
 *   1) .p8 の整形（改行が潰れた Secrets でも PEM として復元できる）
 *   2) ES256 JWT（ヘッダ・ペイロード・Apple の 20 分制限・署名検証）
 *   3) ビルド検索（ビルド番号の一致・期限切れ除外・新しいものを優先）
 *   4) 処理完了待ちポーリング（PROCESSING → VALID / FAILED / タイムアウト）
 *   5) usesNonExemptEncryption が null のときだけ PATCH する
 *   6) 内部グループの選択（「開発テスト」優先・外部グループは選ばない）
 *   7) グループ割り当て（204 / 409 を成功、その他は失敗）
 *   8) 通しの配信（モック fetch）と GitHub 出力（GITHUB_OUTPUT / Job Summary）
 *
 * 実行: npm test（node --test tests/）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';

import {
  base64UrlEncode,
  normalizePrivateKey,
  createJwt,
  createAscClient,
  describeApiError,
  pickBuild,
  fetchBuildList,
  fetchBuildByNumber,
  waitForBuildValid,
  ensureEncryptionCompliance,
  pickInternalGroup,
  fetchBetaGroups,
  assignBuildToGroup,
  verifyBuildInGroup,
  distributeBuild,
  main,
  DEFAULT_BETA_GROUP_NAME,
} from '../scripts/distribute-testflight.mjs';

/* ------------------------------------------------------------------ *
 * テスト用の鍵とモック
 * ------------------------------------------------------------------ */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_KEY = publicKey;
const KEY_ID = 'ABCD1234EF';
const ISSUER_ID = '69a6de70-1234-47e3-e053-5b8c7c11a4d1';
const APP_ID = '6835244770';

const b64urlDecode = (value) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function jsonResponse(status, body) {
  // 204 / 205 は本文を持てない（new Response('', {status:204}) は例外になる）
  if (status === 204 || status === 205) return new Response(null, { status });
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * ルート表からモック fetch を作る。
 * routes: [{ match: 'GET /v1/apps/x/builds' | RegExp | (key)=>bool, respond: (ctx)=>body | [status, body] }]
 * respond が配列なら「[status, body]」、数値を返すとその status のみ。
 */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    calls.push({
      method,
      pathname: url.pathname,
      search: url.search,
      body: init.body ? JSON.parse(init.body) : null,
      authorization: init.headers?.Authorization,
    });
    for (const route of routes) {
      const hit =
        route.match === key ||
        (route.match instanceof RegExp && route.match.test(key)) ||
        (typeof route.match === 'function' && route.match(key, url));
      if (!hit) continue;
      const out = typeof route.respond === 'function' ? route.respond({ url, method, calls }) : route.respond;
      if (out instanceof Response) return out;
      if (Array.isArray(out)) return jsonResponse(out[0], out[1]);
      if (typeof out === 'number') return jsonResponse(out);
      return jsonResponse(200, out);
    }
    throw new Error(`モックにないリクエスト: ${key}`);
  };
  return { fetchImpl, calls };
}

function buildPayload({ id = 'BUILD-1', version = '42', state = 'VALID', encryption = false, expired = false, uploadedDate = '2026-11-17T03:30:00.000Z' } = {}) {
  return {
    type: 'builds',
    id,
    attributes: {
      version: String(version),
      processingState: state,
      usesNonExemptEncryption: encryption,
      expired,
      uploadedDate,
    },
  };
}

function groupPayload({ id = 'GROUP-1', name = DEFAULT_BETA_GROUP_NAME, isInternal = true } = {}) {
  return { type: 'betaGroups', id, attributes: { name, isInternalGroup: isInternal } };
}

/* ------------------------------------------------------------------ *
 * 1) .p8 の整形
 * ------------------------------------------------------------------ */

test('normalizePrivateKey: 改行が潰れた「\\n」表記でも PEM に戻せる', () => {
  const flattened = PRIVATE_PEM.trim().replace(/\r?\n/g, '\\n');
  const normalized = normalizePrivateKey(flattened);
  assert.ok(normalized.startsWith('-----BEGIN PRIVATE KEY-----\n'));
  assert.ok(normalized.includes('\n-----END PRIVATE KEY-----\n'));
  assert.doesNotThrow(() => createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: normalized }));
});

test('normalizePrivateKey: 1行に潰れてヘッダ・フッタだけ残っていても組み直せる', () => {
  const oneLine = PRIVATE_PEM.trim().replace(/\r?\n/g, '');
  const normalized = normalizePrivateKey(oneLine);
  assert.ok(normalized.includes('\n'));
  assert.doesNotThrow(() => createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: normalized }));
});

test('normalizePrivateKey: 空・PEM でない値ははっきり失敗する', () => {
  assert.throws(() => normalizePrivateKey(''), /ASC_PRIVATE_KEY/);
  assert.throws(() => normalizePrivateKey(undefined), /ASC_PRIVATE_KEY/);
  assert.throws(() => normalizePrivateKey('not-a-key'), /PEM/);
});

/* ------------------------------------------------------------------ *
 * 2) ES256 JWT
 * ------------------------------------------------------------------ */

test('createJwt: ヘッダは ES256 / kid / JWT、ペイロードは iss・aud・iat・exp', () => {
  const now = 1_700_000_000_000;
  const jwt = createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM, now });
  const [header, payload, signature] = jwt.split('.');
  assert.equal(signature.split('').length > 0, true);

  const decodedHeader = JSON.parse(b64urlDecode(header).toString('utf8'));
  const decodedPayload = JSON.parse(b64urlDecode(payload).toString('utf8'));

  assert.deepEqual(decodedHeader, { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  assert.equal(decodedPayload.iss, ISSUER_ID);
  assert.equal(decodedPayload.aud, 'appstoreconnect-v1');
  assert.equal(decodedPayload.iat, Math.floor(now / 1000));
  assert.ok(decodedPayload.exp > decodedPayload.iat);
  assert.ok(decodedPayload.exp - decodedPayload.iat <= 20 * 60, 'Apple の上限（20分）を超えない');
});

test('createJwt: 署名は ES256（ieee-p1363 の 64 バイト）で公開鍵検証が通る', () => {
  const jwt = createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM });
  const [header, payload, signature] = jwt.split('.');
  const signatureBytes = b64urlDecode(signature);
  assert.equal(signatureBytes.length, 64, 'P-256 の R||S は 64 バイト');
  const ok = verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    { key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' },
    signatureBytes,
  );
  assert.equal(ok, true);
});

test('createJwt: 20 分を超える指定は 20 分に丸める', () => {
  const now = 1_700_000_000_000;
  const jwt = createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM, now, lifetimeSeconds: 4000 });
  const payload = JSON.parse(b64urlDecode(jwt.split('.')[1]).toString('utf8'));
  assert.equal(payload.exp - payload.iat, 20 * 60);
});

test('createJwt: Key ID / Issuer ID の欠落、EC でない鍵ははっきり失敗する', () => {
  assert.throws(() => createJwt({ keyId: '', issuerId: ISSUER_ID, privateKey: PRIVATE_PEM }), /ASC_KEY_ID/);
  assert.throws(() => createJwt({ keyId: KEY_ID, issuerId: '', privateKey: PRIVATE_PEM }), /ASC_ISSUER_ID/);

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: rsa }), /EC/);
});

test('base64UrlEncode: パディングなし・URL 安全な文字だけ', () => {
  const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe]));
  assert.equal(/[+/=]/.test(encoded), false);
});

/* ------------------------------------------------------------------ *
 * 3) ビルド検索
 * ------------------------------------------------------------------ */

test('pickBuild: ビルド番号が一致するものを選び、期限切れ・古いものは避ける', () => {
  const builds = [
    buildPayload({ id: 'A', version: '41', uploadedDate: '2026-11-16T00:00:00Z' }),
    buildPayload({ id: 'B', version: '42', uploadedDate: '2026-11-17T00:00:00Z' }),
    buildPayload({ id: 'C', version: '42', uploadedDate: '2026-11-17T02:00:00Z', expired: true }),
    buildPayload({ id: 'D', version: '42', uploadedDate: '2026-11-17T01:00:00Z' }),
  ];
  assert.equal(pickBuild(builds, '42').id, 'D');
  assert.equal(pickBuild(builds, 42).id, 'D');
  assert.equal(pickBuild(builds, '99'), null);
  assert.equal(pickBuild(undefined, '42'), null);
});

test('fetchBuildByNumber: アプリ配下のビルド一覧を引き、一致しなければ null', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'X' })] } },
  ]);
  const client = createAscClient({
    jwtFactory: () => createJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM }),
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal((await fetchBuildByNumber(client, { appId: APP_ID, buildNumber: '42' })).id, 'X');
  assert.equal(await fetchBuildByNumber(client, { appId: APP_ID, buildNumber: '43' }), null);
  assert.equal(calls[0].pathname, `/v1/apps/${APP_ID}/builds`);
  assert.ok(calls[0].authorization.startsWith('Bearer '));
});

test('fetchBuildByNumber: 404 は ASC_APP_ID を疑うヒント付きで失敗する', async () => {
  const { fetchImpl } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: [404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'Not Found', detail: 'no app' }] }] },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  await assert.rejects(
    () => fetchBuildByNumber(client, { appId: APP_ID, buildNumber: '42' }),
    /ASC_APP_ID/,
  );
});

/* ------------------------------------------------------------------ *
 * 4) 処理完了待ち
 * ------------------------------------------------------------------ */

test('waitForBuildValid: 一覧に現れない → PROCESSING → VALID を順に待つ', async () => {
  const states = [
    { data: [] },
    { data: [buildPayload({ id: 'B', state: 'PROCESSING' })] },
    { data: [buildPayload({ id: 'B', state: 'VALID' })] },
  ];
  const { fetchImpl, calls } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: () => states.shift() ?? { data: [] } },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const logs = [];

  const build = await waitForBuildValid(client, {
    appId: APP_ID,
    buildNumber: '42',
    sleep: async () => {},
    log: (line) => logs.push(line),
  });

  assert.equal(build.id, 'B');
  assert.equal(build.attributes.processingState, 'VALID');
  assert.equal(calls.length, 3);
  assert.ok(logs.some((line) => line.includes('まだ一覧に現れません')));
  assert.ok(logs.some((line) => line.includes('処理中')));
});

test('waitForBuildValid: processingState が FAILED なら即失敗する', async () => {
  const { fetchImpl } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'B', state: 'FAILED' })] } },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  await assert.rejects(
    () => waitForBuildValid(client, { appId: APP_ID, buildNumber: '42', sleep: async () => {} }),
    /FAILED/,
  );
});

test('waitForBuildValid: 15分待っても VALID にならなければタイムアウトする', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'B', state: 'PROCESSING' })] } },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });

  let clock = 1_700_000_000_000;
  await assert.rejects(
    () =>
      waitForBuildValid(client, {
        appId: APP_ID,
        buildNumber: '42',
        timeoutMs: 60_000,
        intervalMs: 20_000,
        sleep: async () => {
          clock += 20_000;
        },
        now: () => clock,
      }),
    /60分以内|1分以内|VALID になりませんでした/,
  );
  // 20秒おきに 4 回程度（0秒・20秒・40秒・60秒の手前で打ち切り）
  assert.ok(calls.length >= 3 && calls.length <= 5, `呼び出し回数: ${calls.length}`);
});

test('waitForBuildValid: タイムアウト時は直近のビルド番号を添えて知らせる', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: `GET /v1/apps/${APP_ID}/builds`,
      respond: { data: [buildPayload({ id: 'B', version: '77', state: 'PROCESSING' })] },
    },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  let clock = 1_700_000_000_000;

  await assert.rejects(
    () =>
      waitForBuildValid(client, {
        appId: APP_ID,
        buildNumber: '42',
        timeoutMs: 40_000,
        intervalMs: 20_000,
        sleep: async () => {
          clock += 20_000;
        },
        now: () => clock,
      }),
    /直近のビルド: 77\(PROCESSING\)/,
  );
});

test('fetchBuildList: アプリ配下のビルド一覧をそのまま返す', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'A' }), buildPayload({ id: 'B', version: '43' })] } },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const builds = await fetchBuildList(client, { appId: APP_ID });
  assert.equal(builds.length, 2);
  assert.equal(calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * 5) 輸出コンプライアンス
 * ------------------------------------------------------------------ */

test('ensureEncryptionCompliance: null のときだけ false を PATCH する', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: 'PATCH /v1/builds/B-1', respond: 200 },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });

  const nullBuild = buildPayload({ id: 'B-1', encryption: null });
  assert.equal(await ensureEncryptionCompliance(client, nullBuild), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, {
    data: { type: 'builds', id: 'B-1', attributes: { usesNonExemptEncryption: false } },
  });
  assert.equal(nullBuild.attributes.usesNonExemptEncryption, false);
});

test('ensureEncryptionCompliance: すでに false / true のときは書き換えない', async () => {
  const { fetchImpl, calls } = makeFetch([]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });

  assert.equal(await ensureEncryptionCompliance(client, buildPayload({ encryption: false })), false);
  assert.equal(await ensureEncryptionCompliance(client, buildPayload({ encryption: true })), false);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 6) 内部グループの選択
 * ------------------------------------------------------------------ */

test('pickInternalGroup: 「開発テスト」を優先し、外部グループは選ばない', () => {
  const groups = [
    groupPayload({ id: 'EXT', name: '外部テスト', isInternal: false }),
    groupPayload({ id: 'G2', name: '社内テスト', isInternal: true }),
    groupPayload({ id: 'G1', name: '開発テスト', isInternal: true }),
  ];
  const picked = pickInternalGroup(groups, DEFAULT_BETA_GROUP_NAME);
  assert.equal(picked.id, 'G1');
  assert.equal(picked.name, '開発テスト');
});

test('pickInternalGroup: 名前に「開発テスト」を含むグループも拾う', () => {
  const groups = [
    groupPayload({ id: 'G2', name: '社内', isInternal: true }),
    groupPayload({ id: 'G3', name: 'iOS 開発テスト用', isInternal: true }),
  ];
  assert.equal(pickInternalGroup(groups, DEFAULT_BETA_GROUP_NAME).id, 'G3');
});

test('pickInternalGroup: 該当名が無ければ最初の内部グループ、内部が無ければ null', () => {
  const groups = [
    groupPayload({ id: 'EXT', name: '外部', isInternal: false }),
    groupPayload({ id: 'G1', name: '内部A', isInternal: true }),
    groupPayload({ id: 'G2', name: '内部B', isInternal: true }),
  ];
  assert.equal(pickInternalGroup(groups, DEFAULT_BETA_GROUP_NAME).id, 'G1');
  assert.equal(pickInternalGroup([groupPayload({ id: 'EXT', isInternal: false })], DEFAULT_BETA_GROUP_NAME), null);
  assert.equal(pickInternalGroup(undefined, DEFAULT_BETA_GROUP_NAME), null);
});

test('fetchBetaGroups: アプリ配下のグループ一覧を取る', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/betaGroups`, respond: { data: [groupPayload()] } },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const groups = await fetchBetaGroups(client, APP_ID);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].attributes.name, DEFAULT_BETA_GROUP_NAME);
  assert.equal(calls[0].pathname, `/v1/apps/${APP_ID}/betaGroups`);
});

/* ------------------------------------------------------------------ *
 * 7) グループ割り当て
 * ------------------------------------------------------------------ */

test('assignBuildToGroup: 204 は追加成功、409 は追加済みとして成功扱い', async () => {
  const ok = makeFetch([{ match: 'POST /v1/betaGroups/G1/relationships/builds', respond: 204 }]);
  const clientOk = createAscClient({ jwtFactory: 'token', fetchImpl: ok.fetchImpl, sleep: async () => {}, maxRetries: 0 });
  assert.deepEqual(await assignBuildToGroup(clientOk, { groupId: 'G1', buildId: 'B-1' }), {
    ok: true,
    mode: 'added',
  });
  assert.deepEqual(ok.calls[0].body, { data: [{ type: 'builds', id: 'B-1' }] });

  const conflict = makeFetch([{ match: 'POST /v1/betaGroups/G1/relationships/builds', respond: 409 }]);
  const clientConflict = createAscClient({ jwtFactory: 'token', fetchImpl: conflict.fetchImpl, sleep: async () => {}, maxRetries: 0 });
  assert.deepEqual(await assignBuildToGroup(clientConflict, { groupId: 'G1', buildId: 'B-1' }), {
    ok: true,
    mode: 'already_present',
  });
});

// 実際のワークフローで観測した応答（開発テスト = 内部グループ・自動配信オン）
const INTERNAL_GROUP_422 = [
  422,
  {
    errors: [
      {
        status: '422',
        code: 'ENTITY_UNPROCESSABLE',
        title: 'Builds cannot be assigned to this internal group.',
        detail: 'Cannot add internal group to a build.',
      },
    ],
  },
];

test('assignBuildToGroup: 内部グループの 422 では逆向きの関連付けを試す', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: 'POST /v1/betaGroups/G1/relationships/builds', respond: INTERNAL_GROUP_422 },
    { match: 'POST /v1/builds/B-1/relationships/betaGroups', respond: 204 },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });

  assert.deepEqual(await assignBuildToGroup(client, { groupId: 'G1', buildId: 'B-1' }), { ok: true, mode: 'added' });
  assert.deepEqual(calls[1].body, { data: [{ type: 'betaGroups', id: 'G1' }] });
});

test('assignBuildToGroup: 両方向が 422 なら「自動配信に任せる」として成功扱い', async () => {
  const { fetchImpl } = makeFetch([
    { match: 'POST /v1/betaGroups/G1/relationships/builds', respond: INTERNAL_GROUP_422 },
    { match: 'POST /v1/builds/B-1/relationships/betaGroups', respond: INTERNAL_GROUP_422 },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  const result = await assignBuildToGroup(client, { groupId: 'G1', buildId: 'B-1' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'internal_auto');
});

test('assignBuildToGroup: 権限不足などは理由付きで失敗する', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: 'POST /v1/betaGroups/G1/relationships/builds',
      respond: [403, { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', title: 'Forbidden', detail: 'no access' }] }],
    },
  ]);
  const client = createAscClient({ jwtFactory: 'token', fetchImpl, sleep: async () => {}, maxRetries: 0 });
  await assert.rejects(() => assignBuildToGroup(client, { groupId: 'G1', buildId: 'B-1' }), /FORBIDDEN_ERROR/);
});

test('verifyBuildInGroup: グループのビルド一覧に居れば true、居なければ false', async () => {
  const present = makeFetch([
    { match: 'GET /v1/betaGroups/G1/builds', respond: { data: [buildPayload({ id: 'B-1' })] } },
  ]);
  const clientPresent = createAscClient({ jwtFactory: 'token', fetchImpl: present.fetchImpl, sleep: async () => {}, maxRetries: 0 });
  assert.equal((await verifyBuildInGroup(clientPresent, { groupId: 'G1', buildId: 'B-1' })).verified, true);

  const absent = makeFetch([{ match: 'GET /v1/betaGroups/G1/builds', respond: { data: [buildPayload({ id: 'B-9' })] } }]);
  const clientAbsent = createAscClient({ jwtFactory: 'token', fetchImpl: absent.fetchImpl, sleep: async () => {}, maxRetries: 0 });
  assert.equal((await verifyBuildInGroup(clientAbsent, { groupId: 'G1', buildId: 'B-1' })).verified, false);
});

test('describeApiError: Apple のエラー配列を 1 行にする', () => {
  const line = describeApiError({
    status: 409,
    data: { errors: [{ status: '409', code: 'ENTITY_ERROR', title: 'Conflict', detail: 'already exists' }] },
  });
  assert.match(line, /ENTITY_ERROR/);
  assert.match(line, /already exists/);
});

/* ------------------------------------------------------------------ *
 * 8) 通しの配信
 * ------------------------------------------------------------------ */

function happyRoutes({ buildStates = ['VALID'], groupList } = {}) {
  const states = [...buildStates];
  return [
    {
      match: `GET /v1/apps/${APP_ID}/builds`,
      respond: () => {
        const state = states.length > 1 ? states.shift() : states[0];
        return { data: [buildPayload({ id: 'B-42', version: '42', state, encryption: null })] };
      },
    },
    { match: 'PATCH /v1/builds/B-42', respond: 200 },
    {
      match: `GET /v1/apps/${APP_ID}/betaGroups`,
      respond: { data: groupList ?? [groupPayload({ id: 'G1', name: '開発テスト' })] },
    },
    { match: 'POST /v1/betaGroups/G1/relationships/builds', respond: 204 },
    { match: 'GET /v1/betaGroups/G1/builds', respond: { data: [buildPayload({ id: 'B-42' })] } },
  ];
}

test('distributeBuild: 処理完了 → 暗号化申告 → グループ追加 → 反映確認まで通る', async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes({ buildStates: ['PROCESSING', 'VALID'] }));
  const logs = [];

  const result = await distributeBuild({
    appId: APP_ID,
    buildNumber: '42',
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey: PRIVATE_PEM,
    fetchImpl,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });

  assert.equal(result.build.id, 'B-42');
  assert.equal(result.group.name, '開発テスト');
  assert.equal(result.compliancePatched, true);
  assert.equal(result.alreadyPresent, false);
  assert.equal(result.verified, true);

  const order = calls.map((call) => `${call.method} ${call.pathname}`);
  assert.equal(order[0], `GET /v1/apps/${APP_ID}/builds`);
  assert.ok(order.indexOf('PATCH /v1/builds/B-42') > order.lastIndexOf(`GET /v1/apps/${APP_ID}/builds`));
  assert.ok(order.includes('POST /v1/betaGroups/G1/relationships/builds'));
  assert.ok(logs.some((line) => line.includes('追加しました')));
  assert.ok(logs.some((line) => line.includes('確認OK')));
});

test('distributeBuild: すでにグループに入っていれば 409 でも成功（変更なし）', async () => {
  const routes = happyRoutes({ groupList: [groupPayload({ id: 'G1', name: '開発テスト' })] });
  routes[3] = { match: 'POST /v1/betaGroups/G1/relationships/builds', respond: 409 };
  const { fetchImpl } = makeFetch(routes);

  const result = await distributeBuild({
    appId: APP_ID,
    buildNumber: '42',
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey: PRIVATE_PEM,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.alreadyPresent, true);
});

test('distributeBuild: 内部グループの自動配信でも成功し、buildBetaDetail で配信を確認する', async () => {
  // グループ側のビルド一覧は空（自動配信では一覧に現れないことがある）→ internalBuildState で判定
  const routes = [
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'B-42', version: '42' })] } },
    { match: `GET /v1/apps/${APP_ID}/betaGroups`, respond: { data: [groupPayload({ id: 'G1', name: '開発テスト' })] } },
    { match: 'POST /v1/betaGroups/G1/relationships/builds', respond: INTERNAL_GROUP_422 },
    { match: 'POST /v1/builds/B-42/relationships/betaGroups', respond: INTERNAL_GROUP_422 },
    { match: 'GET /v1/betaGroups/G1/builds', respond: { data: [] } },
    {
      match: 'GET /v1/builds/B-42/buildBetaDetail',
      respond: { data: { type: 'buildBetaDetails', id: 'BD', attributes: { internalBuildState: 'IN_BETA_TESTING' } } },
    },
  ];
  const { fetchImpl } = makeFetch(routes);
  const logs = [];

  const result = await distributeBuild({
    appId: APP_ID,
    buildNumber: '42',
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey: PRIVATE_PEM,
    fetchImpl,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });

  assert.equal(result.assignmentMode, 'internal_auto');
  assert.equal(result.verified, true);
  assert.ok(logs.some((line) => line.includes('自動配信')));
  assert.ok(logs.some((line) => line.includes('IN_BETA_TESTING')));
});

test('distributeBuild: 内部グループが無ければ作成を促して失敗する', async () => {
  const { fetchImpl } = makeFetch(
    happyRoutes({ groupList: [groupPayload({ id: 'EXT', name: '外部テスト', isInternal: false })] }),
  );
  await assert.rejects(
    () =>
      distributeBuild({
        appId: APP_ID,
        buildNumber: '42',
        keyId: KEY_ID,
        issuerId: ISSUER_ID,
        privateKey: PRIVATE_PEM,
        fetchImpl,
        sleep: async () => {},
      }),
    /内部テストグループ/,
  );
});

test('distributeBuild: appId / buildNumber の欠落はその場で失敗する', async () => {
  await assert.rejects(
    () => distributeBuild({ appId: '', buildNumber: '42', keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM }),
    /ASC_APP_ID/,
  );
  await assert.rejects(
    () => distributeBuild({ appId: APP_ID, buildNumber: '', keyId: KEY_ID, issuerId: ISSUER_ID, privateKey: PRIVATE_PEM }),
    /ASC_BUILD_NUMBER/,
  );
});

test('distributeBuild: DRY RUN では PATCH も POST もしない', async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes());
  const result = await distributeBuild({
    appId: APP_ID,
    buildNumber: '42',
    keyId: KEY_ID,
    issuerId: ISSUER_ID,
    privateKey: PRIVATE_PEM,
    fetchImpl,
    sleep: async () => {},
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.verified, null);
  assert.equal(calls.some((call) => call.method === 'PATCH' || call.method === 'POST'), false);
});

/* ------------------------------------------------------------------ *
 * 9) CLI（環境変数 → GITHUB_OUTPUT / Job Summary）
 * ------------------------------------------------------------------ */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asc-distribute-'));
}

test('main: 環境変数から配信し、GITHUB_OUTPUT と Job Summary に結果を書く', async () => {
  const dir = tempDir();
  const outputPath = path.join(dir, 'output');
  const summaryPath = path.join(dir, 'summary');
  fs.writeFileSync(outputPath, '');
  fs.writeFileSync(summaryPath, '');

  const env = {
    ASC_KEY_ID: KEY_ID,
    ASC_ISSUER_ID: ISSUER_ID,
    ASC_PRIVATE_KEY: PRIVATE_PEM.replace(/\n/g, '\\n'),
    ASC_APP_ID: APP_ID,
    ASC_BUILD_NUMBER: '42',
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  };

  // main() は globalThis.fetch を使うため、テスト中だけ差し替える。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(happyRoutes()).fetchImpl;
  try {
    const result = await main([], { env });
    assert.equal(result.build.attributes.version, '42');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const output = fs.readFileSync(outputPath, 'utf8');
  assert.match(output, /^distribute_status=added$/m);
  assert.match(output, /^beta_group_name=開発テスト$/m);
  assert.match(output, /^build_version=42$/m);
  assert.match(output, /^distribute_verified=true$/m);

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /TestFlight 自動配信/);
  assert.match(summary, /開発テスト/);
});

test('main: 既存の APP_STORE_CONNECT_* 名の Secrets でも動く（名前ゆらぎ対応）', async () => {
  const env = {
    APP_STORE_CONNECT_KEY_ID: KEY_ID,
    APP_STORE_CONNECT_ISSUER_ID: ISSUER_ID,
    APP_STORE_CONNECT_API_KEY_P8: PRIVATE_PEM,
    ASC_APP_ID: APP_ID,
    ASC_BUILD_NUMBER: '42',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(happyRoutes()).fetchImpl;
  try {
    const result = await main([], { env });
    assert.equal(result.verified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('main: 設定不足はどの変数が足りないかを示して失敗する', async () => {
  await assert.rejects(() => main([], { env: {} }), /ASC_KEY_ID.*ASC_ISSUER_ID.*ASC_PRIVATE_KEY.*ASC_APP_ID/);
});

test('main: 失敗時は Job Summary に理由を残す', async () => {
  const dir = tempDir();
  const summaryPath = path.join(dir, 'summary');
  fs.writeFileSync(summaryPath, '');
  const env = {
    ASC_KEY_ID: KEY_ID,
    ASC_ISSUER_ID: ISSUER_ID,
    ASC_PRIVATE_KEY: PRIVATE_PEM,
    ASC_APP_ID: APP_ID,
    ASC_BUILD_NUMBER: '42',
    GITHUB_STEP_SUMMARY: summaryPath,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch([
    { match: `GET /v1/apps/${APP_ID}/builds`, respond: { data: [buildPayload({ id: 'B-42', state: 'INVALID' })] } },
  ]).fetchImpl;
  try {
    await assert.rejects(() => main([], { env }), /INVALID/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /失敗/);
});
