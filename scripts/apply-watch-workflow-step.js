/**
 * TERRITORY WALK - apply-watch-workflow-step.js
 *
 * `.github/workflows/ios-build.yml` に、Watch ターゲットを組み込むステップを挿入する。
 * 何度実行しても結果は同じ（冪等）。`ci/ios-build.yml`（正本の写し）も同時に更新する。
 *
 * なぜスクリプトで挿すか:
 *   Pickle の GitHub 連携（GitHub App）は `.github/workflows/` の書き換え権限を持たず、
 *   ワークフローの変更だけは push できない。中身を用意して、ユーザー側の push で反映する。
 *
 * 使い方:
 *   node scripts/apply-watch-workflow-step.js          # 挿入（または最新に更新）
 *   node scripts/apply-watch-workflow-step.js --check  # 挿入済みかだけ確認
 *
 * 反映後:
 *   git add .github/workflows/ios-build.yml ci/ios-build.yml
 *   git commit -m "ci: Watchターゲット組み込みステップを追加"
 *   git push
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ios-build.yml');
const MIRROR = path.join(ROOT, 'ci', 'ios-build.yml');
const STEP_FILE = path.join(ROOT, 'ci', 'watch-step.yml');

const MARKER = 'Add watchOS companion target (optional, vars.ENABLE_WATCH_TARGET=true)';
const ANCHOR = '      - name: "Compile & Verify iOS Build (Clean Build)"';

function readStepBlock() {
    const raw = fs.readFileSync(STEP_FILE, 'utf8');
    // 先頭のコメント（# ...）を落として YAML のステップ部分だけを取り出す
    const lines = raw.split('\n');
    const start = lines.findIndex((line) => line.trimStart().startsWith('- name:'));
    if (start < 0) throw new Error(`${path.relative(ROOT, STEP_FILE)} にステップが無い`);
    return `${lines.slice(start).join('\n').replace(/\s+$/, '')}\n`;
}

/** 既存の挿入済みブロックを取り除く（重複防止） */
function stripExisting(source) {
    const lines = source.split('\n');
    const start = lines.findIndex((line) => line.includes(MARKER));
    if (start < 0) return source;
    // ブロックの終わり = 次の「      - name:」行
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith('      - name:')) {
            end = i;
            break;
        }
    }
    return lines.slice(0, start).concat(lines.slice(end)).join('\n');
}

function applyTo(targetPath) {
    const source = fs.readFileSync(targetPath, 'utf8');
    const cleaned = stripExisting(source);
    const anchorIndex = cleaned.indexOf(ANCHOR);
    if (anchorIndex < 0) {
        throw new Error(`${path.relative(ROOT, targetPath)} に挿入位置（${ANCHOR.trim()}）が見つからない`);
    }
    const block = readStepBlock();
    const next = `${cleaned.slice(0, anchorIndex)}${block}\n${cleaned.slice(anchorIndex)}`;
    fs.writeFileSync(targetPath, next);
    return next !== source;
}

function main() {
    const checkOnly = process.argv.includes('--check');
    const targets = [WORKFLOW, MIRROR].filter((file) => fs.existsSync(file));

    if (checkOnly) {
        const applied = targets.every((file) => fs.readFileSync(file, 'utf8').includes(MARKER));
        console.log(applied ? '[watch] ステップは挿入済み' : '[watch] ステップは未挿入（node scripts/apply-watch-workflow-step.js）');
        return applied ? 0 : 1;
    }

    targets.forEach((file) => {
        const changed = applyTo(file);
        console.log(`[watch] ${changed ? '挿入/更新' : '変更なし'}: ${path.relative(ROOT, file)}`);
    });
    console.log('[watch] 反映: git add .github/workflows/ios-build.yml ci/ios-build.yml && git commit && git push');
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch (error) {
        console.error(`[watch] ${error.message}`);
        process.exit(1);
    }
}

module.exports = { applyTo, stripExisting, readStepBlock, MARKER };
