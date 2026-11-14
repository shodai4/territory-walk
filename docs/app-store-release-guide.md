# テリトリーウォーク App Store申請・リリース完全手順書（Mac不要・全自動CI/CD版）

作成日：2026年11月14日
対象プロダクト：『テリトリーウォーク』（Territory Walk）
リポジトリ：`shodai4/territory-walk`
アプリID（Bundle ID）：`com.oekaki.territorywalk`

---

## 1. 概要（翔大さんの作業は「契約」と「提出ボタン」のみ）

本リポジトリには、GitHub Actionsの最新Mac環境（macOS 14 Sonoma / Xcode 16）を使った**完全無料の自動ビルドパイプライン（CI/CD）**が組み込まれています。

そのため、**手元のMac（Monterey）でXcodeを開いて手作業でビルドやアーカイブを行う必要は一切ありません。**
翔大さんが行う作業は、ブラウザ（iPhoneでもPCでも可）で完結する以下のステップのみです。Xcodeの画面を開く場面は一度もありません。

なお、CIは「4つのSecretsがすべて登録されている時だけ」自動署名→IPA書き出し→TestFlightアップロードまで走ります。1つでも欠けている間は、これまで通りクリーンビルドの検証だけを行い、ワークフローは緑のまま待機します。

---

## 2. 翔大さんの作業ステップ（初回のみ・所要約15分）

### ステップ1：Apple Developer Programの登録（年額99ドル）
1. iPhoneで「Apple Developer」アプリをインストールして開きます。
2. 「アカウント」タブ →「登録する（Enroll）」をタップ。
3. 画面の案内に従って氏名・住所・本人確認（顔写真付き身分証）を行い、年額99ドル（約1.5万円）をApple Pay / クレジットカードで決済します。
4. 数分〜数時間で登録完了のメールがAppleから届きます。

---

### ステップ2：App Store Connectで「APIキー」を発行する
GitHub Actionsが翔大さんの代わりにApp Store Connectへアプリを自動転送するための鍵を発行します。

1. PCまたはスマホのブラウザで [App Store Connect](https://appstoreconnect.apple.com/) にサインイン。
2. 上部メニューの **「ユーザとアクセス」** → **「統合」**（または「キー」）タブを開きます。
3. **「App Store Connect API」** の横にある **「＋」** ボタンをクリック。
   - 名前：`GitHub Actions CI`
   - アクセス権：`App Manager`（または `Admin`）
4. 発行されたら、画面に表示される以下の3つの情報を控えます：
   - **Issuer ID（イシュアID）**：画面上部に表示されているUUID形式の文字列
   - **Key ID（キーID）**：表の中に表示されている英数字（例: `ABC123XYZ4`）
   - **秘密鍵ファイル（.p8ファイル）**：表の「APIキーをダウンロード」ボタンから1度だけダウンロードできます（例: `AuthKey_ABC123XYZ4.p8`）

---

### ステップ2.5：App Store Connect に「アプリの器」を作る（初回のみ・約3分）

App Store Connect にアプリのレコード（＝Appの入れ物）が無いと、CIの自動署名は
`No profiles for 'com.oekaki.territorywalk' were found` で止まります。キー登録より先に、これを済ませてください。

1. [App Store Connect](https://appstoreconnect.apple.com/) にサインイン → **「マイApp」** → 左上の **「＋」** → **「新規App」**。
2. 入力内容：
   - プラットフォーム：**iOS**
   - 名前：`テリトリーウォーク - 白黒歩行陣取り`（仮名でOK。後から変更できます）
   - プライマリ言語：**日本語**
   - バンドルID：`com.oekaki.territorywalk`
   - SKU：`territory-walk-ios`
3. **「作成」** を押して完了。価格・審査用の情報は後回しで構いません。

※ バンドルIDの一覧に `com.oekaki.territorywalk` が無い場合は、先に [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) → **「Identifiers」** → **「＋」** で App ID として `com.oekaki.territorywalk` を登録してください。

---

### ステップ3：GitHubリポジトリに鍵を登録する（コピペのみ・4つ）

1. GitHubの `shodai4/territory-walk` リポジトリを開きます。
2. **「Settings」** → 左メニューの **「Secrets and variables」** → **「Actions」** を開きます。
3. **「New repository secret」** ボタンを押し、以下の4つを1つずつ登録します。名前は1文字も違わずに完全一致させてください（ワークフローが参照する名前と1対1で対応しています）。

| # | Secret名 | 入力する値 |
|---|---|---|
| 1 | `APP_STORE_CONNECT_ISSUER_ID` | ステップ2で控えた Issuer ID（UUID形式の文字列） |
| 2 | `APP_STORE_CONNECT_KEY_ID` | ステップ2で控えた Key ID（例: `ABC123XYZ4`） |
| 3 | `APP_STORE_CONNECT_API_KEY_P8` | ダウンロードした `.p8` ファイルをメモ帳で開いた全文（`-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで。前後の改行も含めてコピペ） |
| 4 | `APPLE_TEAM_ID` | Apple Developer アカウントの **Team ID**（10桁の英数字。確認方法は下記） |

#### `APPLE_TEAM_ID`（Team ID）の確認方法

- **方法A（Apple Developerサイト／PC・スマホどちらでも）**：[developer.apple.com/account](https://developer.apple.com/account) にサインイン → **「メンバーシップの詳細（Membership details）」** → **「Team ID」** 欄の10桁（例: `A1B2C3D4E5`）。
- **方法B（App Store Connect）**：右上のアカウント名 → **「ユーザとアクセス」** → **「メンバーシップ」** タブ → 組織名の下に表示される **Team ID**。
- **方法C（iPhoneのApple Developerアプリ）**：**「アカウント」** タブ → メンバーシップ情報に Team ID が表示されます。

個人事業（Individual）で登録した場合も Team ID は必ず発行されます。10桁の英数字であれば正解です。

※ 4つのうち1つでも欠けていると、自動署名・IPAエクスポート・TestFlightアップロードは「待機」状態のままになります（ワークフローは失敗せず、クリーンビルド検証だけが実行されます）。4つが揃った瞬間から全自動が有効になります。

---

### ステップ4：ワークフローファイルをGitHub上に1回だけ置く（所要1分）

GitHub Actions は **`.github/workflows/`** 配下のYAMLしかワークフローとして認識しません。
このリポジトリの完成版ワークフローは **`ci/ios-build.yml`** にあり、こちらは既にGitHubへプッシュ済みです（中身は同じものをそのまま使えます）。

ただし、Pickle（私）のGitHub連携アプリには `workflows` 権限が無いため、`.github/workflows/ios-build.yml` の作成だけは自動プッシュできません（2026年11月14日に実際に試し、`refusing to allow a GitHub App to create or update workflow ... without workflows permission` で拒否されています）。
**次のどちらかで、1回だけ置いてください。以降はもう触らなくてOKです。**

#### 【A】GitHubのブラウザ画面で作る（おすすめ・スマホでも可）
1. `shodai4/territory-walk` を開き、上部の **「Add file」** → **「Create new file」**。
2. ファイル名の欄に `.github/workflows/ios-build.yml` と入力（`/` を打つとフォルダが切られます）。
3. 別タブで `ci/ios-build.yml` を開き、右上の **「Raw」** を押して全文をコピーし、2で開いたファイルに貼り付け。
4. 下の **「Commit changes...」** → そのまま **「Commit changes」**。

#### 【B】手元のPC／Macのターミナルから（Xcode不要）
```text
cd territory-walk
mkdir -p .github/workflows
cp ci/ios-build.yml .github/workflows/ios-build.yml
git add .github/workflows/ios-build.yml
git commit -m "ci: place iOS workflow under .github/workflows"
git push
```

置き終わると、リポジトリの **「Actions」** タブに **「iOS Build & App Store CI/CD」** が現れます。最初の1回は **「Run workflow」** ボタンで手動実行すると、その場で結果を確認できます。

---

### ステップ5：あとはプッシュするだけ！

4つのSecretsとワークフローファイルが揃うと、以降はコードをmainへプッシュするたびに、GitHubの最新Macサーバー（macOS 14 / Xcode 16）が以下を全自動で実行します。

1. アイコン・スプラッシュ画像の自動生成
2. Capacitor iOSプロジェクトの完全同期とInfo.plistパーミッション注入
3. クリーンビルド検証（署名なしのコンパイル確認）
4. App Store Connect APIキーによる**クラウド自動署名**（.p12証明書ファイルは不要。秘密鍵は実行中だけ置かれ、終了時に必ず消去）
5. Releaseアーカイブ → IPA書き出し
6. **TestFlightへの自動アップロード**（`altool --upload-app`）

アップロード完了後、App Store Connectの **「TestFlight」** タブに最新ビルドが現れます（Apple側の処理に数分〜数十分かかり、処理完了はメールでも届きます）。iPhoneに **TestFlight** アプリを入れて自分のApple IDでサインインすれば、そのビルドを実機にインストールして触れます。

---

### よくあるつまずき（自動署名・アップロード編）

| 症状（ログの文言） | 原因と対処 |
|---|---|
| `No profiles for 'com.oekaki.territorywalk' were found` | App Store Connect にアプリのレコードが無い／Bundle ID未登録。**ステップ2.5**を実施 |
| `Authentication credentials are missing or invalid`（401） | Key ID と Issuer ID の取り違え、または `.p8` のコピペ欠け。`-----BEGIN PRIVATE KEY-----` 〜 `-----END PRIVATE KEY-----` の全文か確認 |
| `Provisioning profile doesn't include signing certificate` | `APPLE_TEAM_ID` が別チームのIDになっている。ステップ3の確認方法で再確認 |
| `The provided entity includes an attribute with a value that has already been used` | ビルド番号の重複。`manageAppVersionAndBuildNumber=true` により自動採番されるため通常は起きません。起きたら再実行で解決します |
| TestFlightにビルドが出てこない | Apple側の処理待ち（数分〜数十分）。App Store Connectの「アクティビティ」と登録メールを確認 |
| `altool` に関する警告・失敗 | `altool` はApple非推奨のツールです。ワークフローは失敗時に自動で `iTMSTransporter`（Transporter）へ切り替える二段構えにしてあります |

---

## 3. App Store審査提出用のメタデータ（コピペ用完全データ）

App Store Connectでアプリ情報を登録する際、以下の内容をそのまま貼り付けてご利用いただけます。

### 基本情報
- **アプリ名**：`テリトリーウォーク - 白黒歩行陣取り`
- **サブタイトル**：`街を歩いて白黒の陣地を塗り替えるGPSゲーム`
- **カテゴリ**：`ゲーム > アクション`、`ヘルスケア／フィットネス`
- **プライマリ言語**：`日本語`
- **バンドルID**：`com.oekaki.territorywalk`
- **SKU**：`territory-walk-ios`

### プロモーション用URL（審査必須・すでに公開済み）
- **プライバシーポリシーURL**：`https://shodai4.github.io/territory-walk/privacy.html`
- **利用規約URL**：`https://shodai4.github.io/territory-walk/terms.html`
- **サポートURL**：`https://shodai4.github.io/territory-walk/support.html`

### 説明文（Description）
```text
毎日の通勤、通学、お散歩がリアルタイム陣取りゲームに変わる！

『テリトリーウォーク』は、スマートフォンのGPS位置情報を使って、あなたが実際に歩いた街のマス（100m四方の直交グリッド）を自分の陣営の色に塗り替えていく位置情報陣取りゲームです。

【ゲームの特徴】
■ 白 vs 黒！2大陣営のリアルタイム陣取りバトル
プレイヤーは毎週月曜日に「Black（黒陣営）」または「White（白陣営）」に自動配属。街を歩いて自分のマスを広げ、相手のマスに踏み込んで自分の陣営の色に塗り替えよう！

■ 100m直交チェス盤グリッド × ナスカの地上絵モード
地図上には整然とした100m四方のグリッドが展開。ピンチズームで引けば、自分が歩いて制圧した巨大な軌跡が「現代のナスカの地上絵」のように浮かび上がります。

■ 週間シーズン制 ＆ 週間ランキング
毎週月曜日の朝にシーズン結果発表！勝利陣営にはボーナスコインが付与され、週間開拓マス数に応じた限定メモリアル称号を獲得できます。

■ 豊富なマステーマと称号コレクション
集めたコインで「サイバー」「ゴールド」「クリムゾン」「レトロ」など8種類のマステーマスキンや、多彩な称号を獲得可能。完全無料でも歩行ボーナスやログインボーナスで存分に楽しめます。

■ 広告非表示も選べる課金体系
広告完全非表示パス（単体480円）のほか、スタンダードパック（500円）以上のコインパックを購入すると、広告非表示と動画リワードの待ち時間なし特典が自動的に解放されます。課金で陣取りが有利になる要素はありません。

さあ、いつもの街をあなたの足で塗り替えに行こう！

※バックグラウンドでの位置情報取得について
アプリは画面を消灯した状態やポケットに入れたままでも歩行マスを継続して開拓するため、バックグラウンドでの位置情報取得を使用します。バッテリー消費を抑える最適化を施しています。
```

### キーワード（100文字以内）
```text
位置情報,陣取り,歩行,ウォーキング,散歩,白黒,GPS,ゲーム,フィットネス,健康,歩数計,通勤,マップ
```

### 年齢制限指定
- すべて「なし」（4歳以上対象）

### アプリ内課金アイテム設定（StoreKit商品ID一覧）
| 商品名 | 参照名（ID） | タイプ | 価格 | 内容 |
|---|---|---|---|---|
| ビギナーコインパック | `com.shodai.territorywalk.coins1000` | 消費型 | 120円 | 1,000 COIN |
| スタンダードコインパック | `com.shodai.territorywalk.coins4500` | 消費型 | 500円 | 4,500 COIN ＋ 広告完全非表示を自動解放 |
| プレミアムコインパック | `com.shodai.territorywalk.coins14000` | 消費型 | 1,500円 | 14,000 COIN ＋ 広告完全非表示を自動解放 |
| アルティメットコインパック | `com.shodai.territorywalk.coins50000` | 消費型 | 5,000円 | 50,000 COIN ＋ 広告完全非表示を自動解放 |
| 広告完全非表示パス | `com.shodai.territorywalk.adfree` | 非消費型 | 480円 | 広告消去・リワード即時受取 |

※商品IDは `iap.js` のカタログと一致させること（`com.oekaki.territorywalk.pack120` 等の旧IDでは購入できません）。
※スタンダードパック以上は購入時に広告完全非表示（480円相当）が自動的に有効になります。消耗型のコインは復元されませんが、広告非表示の権利は「購入の復元」で購入履歴から再適用されます。

---

## 4. 最後にやること（審査へ提出ボタン）

### App Store 本番リリース前の必須切り替え（デバッグ無効化）
- `app.js` の `CONFIG.ENABLE_DEBUG_TOOLS` を `false` にしてください（TestFlight検証中は `true`）。
  - このフラグ1つで、MENU内の「デバッグモード」欄、仮想十字キー（D-PAD）、結果発表・チームリセットのプレビュー、コイン増減、購入アイテムリセット、チーム強制切替、Pro制限のデバッグバイパスがすべてUI非表示＋処理無効になります。

App Store Connect上でメタデータ入力とビルド選択（自動アップロードされた最新ビルドを選択）が完了したら、右上の **「審査へ提出」** ボタンをポチッと押すだけです！
通常24時間〜48時間以内にAppleのレビューチームから承認通知が届き、App Storeで世界中に配信されます。
