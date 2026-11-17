#!/usr/bin/env node
/**
 * distribute-testflight.mjs
 * ============================================================================
 * TestFlight へアップロードしたビルドを、App Store Connect API で
 * 内部テストグループ（既定: 「開発テスト」）へ自動配信する。
 *
 * これまで: IPA を altool でアップロードしたあと、App Store Connect の画面を
 *           開いて「ビルドをグループに追加」を手で押す必要があった。
 * これから: ワークフローの最後にこのスクリプトが走り、処理完了（VALID）を
 *           待ってから自動でグループへ追加する。
 *
 * 処理の流れ
 *   1. ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY（.p8）から ES256 の JWT を作る
 *      → https://api.appstoreconnect.apple.com/v1 へ認証
 *   2. `GET /v1/apps/{appId}/builds` を 20 秒おきにポーリング（最大 15 分）し、
 *      version（= ビルド番号 = github.run_number）が一致するビルドの
 *      processingState が VALID になるまで待つ
 *   3. usesNonExemptEncryption が null なら `PATCH /v1/builds/{id}` で false を入れる
 *      （Info.plist の ITSAppUsesNonExemptEncryption=false で通常は既に false）
 *   4. `GET /v1/apps/{appId}/betaGroups` から内部グループ（isInternalGroup）を取得し、
 *      名前に「開発テスト」を含むもの → 無ければ最初の内部グループを選ぶ
 *   5. `POST /v1/betaGroups/{groupId}/relationships/builds` でビルドを追加
 *      （204 / 200 = 追加成功、409 = すでに追加済み も成功として扱う）
 *   6. グループ名・ビルド番号・ステータスを出力（GitHub の Job Summary にも書く）
 *
 * 必要な環境変数（GitHub Secrets から渡す）
 *   ASC_KEY_ID      … App Store Connect API キーの Key ID
 *   ASC_ISSUER_ID   … Issuer ID
 *   ASC_PRIVATE_KEY … AuthKey_XXXX.p8 の中身（BEGIN PRIVATE KEY 行を含む）
 *   ASC_APP_ID      … App Store Connect の Apple ID（例: 6835244770）
 *   ASC_BUILD_NUMBER… 配信するビルド番号（= github.run_number）
 * 任意
 *   ASC_BETA_GROUP_NAME … 優先する内部グループ名（既定: 開発テスト）
 *   ASC_POLL_TIMEOUT_SECONDS / ASC_POLL_INTERVAL_SECONDS … 待ち時間の調整
 *   ASC_DRY_RUN=1 … 認証・ビルド検索・グループ検索までで止める（書き込みなし）
 *
 * 依存パッケージなし（Node 18+ / JWT 署名は node:crypto の ES256）。
 * 単体テスト: tests/distribute-testflight.test.js（npm test）
 * ============================================================================
 */

import { createPrivateKey, createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ASC_DEFAULT_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';
export const DEFAULT_BETA_GROUP_NAME = '開発テスト';
export const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15分
export const DEFAULT_POLL_INTERVAL_MS = 20 * 1000; // 20秒

/* ------------------------------------------------------------------ *
 * 1) JWT（ES256）
 * ------------------------------------------------------------------ */

/** Buffer/文字列 → base64url（JWT 用のパディングなし表現） */
export function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * .p8 の中身を PEM として整える。
 * GitHub Secrets 経由だと改行が「\n」の2文字に潰れていることがあるので、
 * その場合だけ実改行に戻す。1行に潰れてヘッダ・フッタだけ残っている場合も組み直す。
 */
export function normalizePrivateKey(raw) {
  if (raw == null) throw new Error('ASC_PRIVATE_KEY（.p8 の中身）が空です');
  let key = String(raw).trim();
  if (!key) throw new Error('ASC_PRIVATE_KEY（.p8 の中身）が空です');

  if (key.includes('\\n')) key = key.replace(/\\r/g, '').replace(/\\n/g, '\n');
  key = key.trim();

  if (!key.includes('\n')) {
    const match = /-----BEGIN ([^-]+)-----(.+)-----END \1-----/.exec(key);
    if (match) {
      const body = match[2].replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
      key = `-----BEGIN ${match[1]}-----\n${body}\n-----END ${match[1]}-----`;
    }
  }

  if (!key.includes('-----BEGIN') || !key.includes('PRIVATE KEY-----')) {
    throw new Error('ASC_PRIVATE_KEY が PEM（-----BEGIN PRIVATE KEY-----）形式ではありません');
  }
  return `${key}\n`;
}

/**
 * App Store Connect API 用の JWT を作る。
 * ヘッダ: { alg: ES256, kid: Key ID, typ: JWT }
 * ペイロード: { iss: Issuer ID, iat, exp（最大20分）, aud: appstoreconnect-v1 }
 */
export function createJwt({ keyId, issuerId, privateKey, now = Date.now(), lifetimeSeconds = 900 }) {
  if (!keyId) throw new Error('ASC_KEY_ID（Key ID）が空です');
  if (!issuerId) throw new Error('ASC_ISSUER_ID（Issuer ID）が空です');

  // Apple の JWT は 20 分以内。既定は 15 分にして余裕を持たせる。
  const lifetime = Math.min(Math.max(Number(lifetimeSeconds) || 900, 60), 1200);
  const issuedAt = Math.floor(now / 1000);

  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + lifetime,
    aud: 'appstoreconnect-v1',
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;

  const keyObject = createPrivateKey(normalizePrivateKey(privateKey));
  if (keyObject.asymmetricKeyType !== 'ec') {
    throw new Error(`App Store Connect のキーは EC（P-256）である必要があります（実際: ${keyObject.asymmetricKeyType}）`);
  }
  if (keyObject.asymmetricKeyDetails?.namedCurve && keyObject.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
    throw new Error(`ES256 には P-256 のキーが必要です（実際: ${keyObject.asymmetricKeyDetails.namedCurve}）`);
  }

  // JWT の ES256 署名は DER ではなく「R||S の 64 バイト固定長」なので ieee-p1363 を指定する。
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: keyObject, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/* ------------------------------------------------------------------ *
 * 2) App Store Connect API クライアント（薄いラッパー）
 * ------------------------------------------------------------------ */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAscClient({
  jwtFactory,
  baseUrl = ASC_DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  log = () => {},
  maxRetries = 3,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch が使えません（Node 18 以上で実行してください）');
  }
  let token = typeof jwtFactory === 'function' ? jwtFactory() : String(jwtFactory || '');
  const refresh = () => {
    if (typeof jwtFactory === 'function') token = jwtFactory();
  };

  async function request(method, path, { query, body } = {}) {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === maxRetries) throw new Error(`${method} ${path} に接続できません: ${error.message}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      // 401: トークン期限切れ。作り直してやり直す。
      if (response.status === 401 && attempt < maxRetries) {
        refresh();
        await sleep(1000);
        continue;
      }
      // 429 / 5xx: 少し待ってやり直す（Retry-After があれば従う）。
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
        log(`[ASC] ${method} ${path} → ${response.status}。${Math.round(waitMs / 1000)}秒待って再試行します`);
        await sleep(waitMs);
        continue;
      }

      return { status: response.status, ok: response.ok, data, text };
    }

    throw new Error(`${method} ${path} が ${maxRetries + 1} 回失敗しました`);
  }

  return { request, refreshToken: refresh };
}

/** API のエラーレスポンスを読みやすい 1 行にする */
export function describeApiError(result) {
  const errors = result?.data?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((error) => `${error.status || result.status} ${error.code || ''} ${error.title || ''}: ${error.detail || ''}`.trim())
      .join(' / ');
  }
  const raw = result?.data?.raw || result?.text;
  return `${result?.status ?? '?'} ${String(raw || '').slice(0, 300)}`.trim();
}

/* ------------------------------------------------------------------ *
 * 3) ビルドの検索と処理完了待ち
 * ------------------------------------------------------------------ */

const BUILD_FIELDS = 'version,processingState,usesNonExemptEncryption,uploadedDate,expired';

function uploadedTime(build) {
  const value = Date.parse(build?.attributes?.uploadedDate || '');
  return Number.isFinite(value) ? value : 0;
}

/** 同じビルド番号が複数返っても、期限切れでなく一番新しいものを選ぶ */
export function pickBuild(builds, buildNumber) {
  const wanted = String(buildNumber);
  const matched = (builds || []).filter((build) => String(build?.attributes?.version) === wanted);
  if (!matched.length) return null;
  const alive = matched.filter((build) => build?.attributes?.expired !== true);
  const pool = alive.length ? alive : matched;
  return pool.sort((a, b) => uploadedTime(b) - uploadedTime(a))[0];
}

/**
 * GET /v1/apps/{appId}/builds からビルド番号が一致するビルドを取る。
 * フィルタの対応状況に依存しないよう、一覧を取ってから手元で照合する。
 */
export async function fetchBuildByNumber(client, { appId, buildNumber }) {
  const result = await client.request('GET', `/apps/${encodeURIComponent(appId)}/builds`, {
    query: { limit: 100, 'fields[builds]': BUILD_FIELDS },
  });
  if (!result.ok) {
    const hint = result.status === 404
      ? `（Apple ID ${appId} のアプリが見つかりません。ASC_APP_ID を確認してください）`
      : '';
    throw new Error(`ビルド一覧の取得に失敗: ${describeApiError(result)}${hint}`);
  }
  return pickBuild(result.data?.data, buildNumber);
}

/**
 * ビルドが処理完了（VALID）になるまでポーリングする。
 * アップロード直後はまだ API に現れないことがあるので、見つからない間も待つ。
 */
export async function waitForBuildValid(
  client,
  {
    appId,
    buildNumber,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    sleep = defaultSleep,
    log = () => {},
    now = () => Date.now(),
  } = {},
) {
  const started = now();
  const deadline = started + timeoutMs;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const elapsed = now() - started;
    const build = await fetchBuildByNumber(client, { appId, buildNumber });

    if (build) {
      const state = build.attributes?.processingState;
      if (state === 'VALID') {
        log(`[ASC] ビルド ${buildNumber}（${build.id}）が VALID になりました（${Math.round(elapsed / 1000)}秒）`);
        return build;
      }
      if (state === 'FAILED' || state === 'INVALID') {
        throw new Error(`ビルド ${buildNumber} の処理に失敗しました（processingState=${state}）`);
      }
      log(`[ASC] ビルド ${buildNumber} は処理中（${state}）— ${Math.round(elapsed / 1000)}秒経過`);
    } else {
      log(`[ASC] ビルド ${buildNumber} がまだ一覧に現れません — ${Math.round(elapsed / 1000)}秒経過`);
    }

    if (now() + intervalMs > deadline) {
      throw new Error(
        `ビルド ${buildNumber} が ${Math.round(timeoutMs / 60000)}分以内に VALID になりませんでした。` +
          'App Store Connect の TestFlight 画面で処理状況を確認してください。',
      );
    }
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * 4) 輸出コンプライアンス（usesNonExemptEncryption）
 * ------------------------------------------------------------------ */

export async function ensureEncryptionCompliance(client, build, { log = () => {} } = {}) {
  const value = build?.attributes?.usesNonExemptEncryption;
  if (value === false) {
    log('[ASC] usesNonExemptEncryption はすでに false です');
    return false;
  }

  if (value !== null && value !== undefined) {
    // true の場合は設定の誤りなので、勝手に書き換えずに知らせる。
    log(`[ASC] 注意: usesNonExemptEncryption が ${value} になっています（暗号化の申告を確認してください）`);
    return false;
  }

  const result = await client.request('PATCH', `/builds/${encodeURIComponent(build.id)}`, {
    body: {
      data: {
        type: 'builds',
        id: build.id,
        attributes: { usesNonExemptEncryption: false },
      },
    },
  });
  if (!result.ok) {
    throw new Error(`usesNonExemptEncryption の設定に失敗: ${describeApiError(result)}`);
  }
  log('[ASC] usesNonExemptEncryption が null だったので false を設定しました');
  build.attributes = { ...(build.attributes || {}), usesNonExemptEncryption: false };
  return true;
}

/* ------------------------------------------------------------------ *
 * 5) 内部テストグループの選択と割り当て
 * ------------------------------------------------------------------ */

/** isInternalGroup のグループから「開発テスト」優先で 1 つ選ぶ */
export function pickInternalGroup(groups, preferredName = DEFAULT_BETA_GROUP_NAME) {
  const list = (groups || []).map((group) => ({
    id: group.id,
    name: group.attributes?.name ?? '',
    isInternal: group.attributes?.isInternalGroup === true,
  }));
  const internal = list.filter((group) => group.isInternal);
  if (!internal.length) return null;

  const preferred = String(preferredName || '').trim();
  if (preferred) {
    const exact = internal.find((group) => group.name === preferred);
    if (exact) return exact;
    const partial = internal.find((group) => group.name.includes(preferred));
    if (partial) return partial;
  }
  return internal[0];
}

export async function fetchBetaGroups(client, appId) {
  const result = await client.request('GET', `/apps/${encodeURIComponent(appId)}/betaGroups`, {
    query: { limit: 200, 'fields[betaGroups]': 'name,isInternalGroup,createdDate' },
  });
  if (!result.ok) throw new Error(`ベータグループ一覧の取得に失敗: ${describeApiError(result)}`);
  return result.data?.data || [];
}

/**
 * POST /v1/betaGroups/{groupId}/relationships/builds
 * 204 / 200 = 追加した、409 = すでに入っている（成功扱い）。
 */
export async function assignBuildToGroup(client, { groupId, buildId }) {
  const result = await client.request('POST', `/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
    body: { data: [{ type: 'builds', id: buildId }] },
  });
  if (result.status === 409) return { ok: true, alreadyPresent: true };
  if (result.ok) return { ok: true, alreadyPresent: false };
  throw new Error(`グループへのビルド追加に失敗: ${describeApiError(result)}`);
}

/** 追加後にグループのビルド一覧を見て、本当に入っているか確認する（失敗しても致命にしない） */
export async function verifyBuildInGroup(client, { groupId, buildId, maxPages = 3 }) {
  let path = `/betaGroups/${encodeURIComponent(groupId)}/builds`;
  let query = { limit: 200, 'fields[builds]': 'version,processingState' };

  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.request('GET', path, { query });
    if (!result.ok) return { verified: false, reason: describeApiError(result) };
    const found = (result.data?.data || []).some((build) => build.id === buildId);
    if (found) return { verified: true };

    const next = result.data?.links?.next;
    if (!next) return { verified: false, reason: 'グループのビルド一覧に該当ビルドが見つかりません' };
    const nextUrl = new URL(next);
    path = nextUrl.pathname.replace(/^\/v1/, '');
    query = Object.fromEntries(nextUrl.searchParams.entries());
  }
  return { verified: false, reason: 'グループのビルド一覧をたどり切れませんでした' };
}

/* ------------------------------------------------------------------ *
 * 6) まとめ役
 * ------------------------------------------------------------------ */

/**
 * 一連の自動配信を実行する。
 * @returns {{build: object, group: {id: string, name: string}, compliancePatched: boolean,
 *            alreadyPresent: boolean, verified: boolean|null}}
 */
export async function distributeBuild({
  appId,
  buildNumber,
  keyId,
  issuerId,
  privateKey,
  baseUrl = ASC_DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  betaGroupName = DEFAULT_BETA_GROUP_NAME,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  dryRun = false,
  sleep = defaultSleep,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (!appId) throw new Error('ASC_APP_ID（App Store Connect の Apple ID）が未設定です');
  if (!buildNumber) throw new Error('ASC_BUILD_NUMBER（配信するビルド番号）が未設定です');

  const client = createAscClient({
    jwtFactory: () => createJwt({ keyId, issuerId, privateKey, now: now() }),
    baseUrl,
    fetchImpl,
    sleep,
    log,
  });

  log(`[ASC] アプリ ${appId} / ビルド ${buildNumber} の配信を開始します（グループ優先名: ${betaGroupName}）`);

  // (1) 処理完了待ち
  const build = await waitForBuildValid(client, {
    appId,
    buildNumber,
    timeoutMs: pollTimeoutMs,
    intervalMs: pollIntervalMs,
    sleep,
    log,
    now,
  });
  log(`[ASC] ビルド情報: id=${build.id} version=${build.attributes?.version} state=${build.attributes?.processingState}`);

  // (2) 輸出コンプライアンス
  const compliancePatched = dryRun ? false : await ensureEncryptionCompliance(client, build, { log });

  // (3) 内部グループの選択
  const groups = await fetchBetaGroups(client, appId);
  const group = pickInternalGroup(groups, betaGroupName);
  if (!group) {
    const names = groups.map((g) => g.attributes?.name).filter(Boolean).join(', ') || '（グループなし）';
    throw new Error(
      `内部テストグループ（isInternalGroup=true）が見つかりません。App Store Connect の TestFlight > 内部テストで「${betaGroupName}」を作成してください。既存グループ: ${names}`,
    );
  }
  log(`[ASC] 配信先グループ: ${group.name}（id=${group.id}）`);

  if (dryRun) {
    log('[ASC] DRY RUN のため、ビルドの追加は行っていません');
    return { build, group, compliancePatched, alreadyPresent: false, verified: null, dryRun: true };
  }

  // (4) グループへ追加
  const assigned = await assignBuildToGroup(client, { groupId: group.id, buildId: build.id });
  log(
    assigned.alreadyPresent
      ? `[ASC] ビルド ${buildNumber} はすでに「${group.name}」に入っていました（409 / 変更なし）`
      : `[ASC] ビルド ${buildNumber} を「${group.name}」に追加しました`,
  );

  // (5) 反映確認（取れなくても異常とは限らないので警告どまり）
  const check = await verifyBuildInGroup(client, { groupId: group.id, buildId: build.id });
  if (check.verified) {
    log(`[ASC] 確認OK: 「${group.name}」のビルド一覧に ${buildNumber} が入っています`);
  } else {
    log(`[ASC] 注意: 反映確認が取れませんでした（${check.reason}）。グループへの追加自体は成功しています`);
  }

  return {
    build,
    group,
    compliancePatched,
    alreadyPresent: assigned.alreadyPresent,
    verified: check.verified,
  };
}

/* ------------------------------------------------------------------ *
 * 7) CLI
 * ------------------------------------------------------------------ */

function readFirstEnv(names, fallback = '', env = process.env) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return fallback;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = value;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function appendLine(filePath, text) {
  if (!filePath) return;
  try {
    appendFileSync(filePath, text);
  } catch {
    /* 書き込めなくても配信結果には影響させない */
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const args = parseArgs(argv);
  const read = (names, fallback = '') => readFirstEnv(names, fallback, env);

  const keyId = args['key-id'] || read(['ASC_KEY_ID', 'APP_STORE_CONNECT_KEY_ID']);
  const issuerId = args['issuer-id'] || read(['ASC_ISSUER_ID', 'APP_STORE_CONNECT_ISSUER_ID']);
  const privateKey =
    args['private-key'] ||
    read(['ASC_PRIVATE_KEY', 'APP_STORE_CONNECT_PRIVATE_KEY', 'APP_STORE_CONNECT_API_KEY_P8']);
  const appId = args['app-id'] || read(['ASC_APP_ID']);
  const buildNumber = args['build-number'] || read(['ASC_BUILD_NUMBER', 'GITHUB_RUN_NUMBER']);
  const groupName = args.group || read(['ASC_BETA_GROUP_NAME'], DEFAULT_BETA_GROUP_NAME);
  const dryRun = args.dryRun === true || read(['ASC_DRY_RUN']) === '1';
  const pollTimeoutMs = Number(read(['ASC_POLL_TIMEOUT_SECONDS'], '900')) * 1000;
  const pollIntervalMs = Number(read(['ASC_POLL_INTERVAL_SECONDS'], '20')) * 1000;

  const missing = [];
  if (!keyId) missing.push('ASC_KEY_ID');
  if (!issuerId) missing.push('ASC_ISSUER_ID');
  if (!privateKey) missing.push('ASC_PRIVATE_KEY');
  if (!appId) missing.push('ASC_APP_ID');
  if (!buildNumber) missing.push('ASC_BUILD_NUMBER');
  if (missing.length) {
    throw new Error(`必要な設定が足りません: ${missing.join(', ')}`);
  }

  const log = (message) => console.log(message);

  try {
    const result = await distributeBuild({
      appId,
      buildNumber,
      keyId,
      issuerId,
      privateKey,
      betaGroupName: groupName,
      pollTimeoutMs,
      pollIntervalMs,
      dryRun,
      log,
    });

    const statusLine = result.dryRun
      ? 'DRY RUN（追加はしていません）'
      : result.alreadyPresent
        ? '追加済み（変更なし）'
        : '追加完了';
    console.log('');
    console.log('===== TestFlight 自動配信の結果 =====');
    console.log(`ビルド番号 : ${result.build.attributes?.version}（build id: ${result.build.id}）`);
    console.log(`処理状態   : ${result.build.attributes?.processingState}`);
    console.log(`グループ   : ${result.group.name}（${result.group.id}）`);
    console.log(`結果       : ${statusLine}`);
    console.log(`反映確認   : ${result.verified === true ? 'OK' : result.verified === false ? '未確認' : 'スキップ（DRY RUN）'}`);
    console.log(`暗号化申告 : ${result.compliancePatched ? 'null → false を設定' : '変更なし'}`);
    console.log('=====================================');

    appendLine(env.GITHUB_STEP_SUMMARY, [
      '',
      '#### TestFlight 自動配信（内部テスト）',
      '',
      '| 項目 | 値 |',
      '| --- | --- |',
      `| ビルド番号 | ${result.build.attributes?.version} |`,
      `| 処理状態 | ${result.build.attributes?.processingState} |`,
      `| 配信先グループ | ${result.group.name} |`,
      `| 結果 | ${statusLine} |`,
      `| 反映確認 | ${result.verified === true ? 'OK' : result.verified === false ? '未確認' : 'スキップ（DRY RUN）'} |`,
      '',
    ].join('\n'));

    appendLine(env.GITHUB_OUTPUT, [
      `distribute_status=${result.dryRun ? 'dry_run' : result.alreadyPresent ? 'already_present' : 'added'}`,
      `beta_group_name=${result.group.name}`,
      `beta_group_id=${result.group.id}`,
      `build_id=${result.build.id}`,
      `build_version=${result.build.attributes?.version}`,
      `distribute_verified=${result.verified === true ? 'true' : 'false'}`,
      '',
    ].join('\n'));

    return result;
  } catch (error) {
    console.error('');
    console.error(`[ASC] TestFlight 自動配信に失敗しました: ${error.message}`);
    console.error('ヒント: App Store Connect の TestFlight 画面でビルドの処理状況と内部グループ名を確認してください。');
    appendLine(env.GITHUB_STEP_SUMMARY, `\n#### TestFlight 自動配信（内部テスト）\n\n**失敗**: ${error.message}\n`);
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then(() => {
      // process.exit() を直接呼ぶとパイプの標準出力が切れることがあるので exitCode で終わる
      process.exitCode = 0;
    })
    .catch((error) => {
      console.log(`::error::TestFlight 自動配信に失敗: ${error.message}`);
      process.exitCode = 1;
    });
}
