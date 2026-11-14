# TERRITORY WALK (白黒歩行陣取りアプリ)

街を歩いてリアルタイムに陣地を広げる、白黒陣取り型リアルGPSウォーキングゲーム。  
完全0円構成（GitHub Pages + Supabase 無料枠）で常時稼働中。

---

## 主な機能と特徴

1. **リアルタイム歩行陣取り**
   - 日本全国・世界中を約100m四方の正方形メッシュ（緯度0.0009度単位）に分割。
   - 自分が歩いたマスが自陣色（White / Black）に開拓され、相手チームのマスを踏むとその場で自陣色に奪還・塗り替え。
   - 全幅対戦パーセンテージバーで現在の勢力比率をリアルタイム表示。

2. **Supabase オンラインマルチプレイ ＆ Realtime同期**
   - WebSocket（Realtimeチャンネル）で他プレイヤーの開拓を数秒で手元マップに反映。
   - 端末ローカルUUIDによる一意なプレイヤー識別（ログイン不要・完全無料）。
   - 毎週月曜0:00（JST）の自動シーズン切り替え＆勝敗判定、週間ランキング・歴代ランキング。

3. **コイン経済圏 ＆ ショップシステム（課金で勝敗は変わらない）**
   - 歩行開拓（+1C／奪還+2C）、デイリーログインボーナス（+20〜50C）、動画リワード広告視聴（+50C）でコイン獲得。
   - 全8色のマステーマ解放、6大限定称号、週間アートポスターPNG書き出しチケット、現在地ピン光彩エフェクト。
   - コインパックはスタンダード（500円）以上で広告完全非表示（Ad-Free）を自動付帯。単体パス（480円）との併売。

3.5 **オフライン耐性（Outbox同期）**
   - 電波が弱い場所で開拓したマスは `pending_tile_queue` に一時保存し、オンライン復帰・アプリ起動・フォアグラウンド復帰時にSupabaseへ一括再送。
   - 同一メッシュ×同一週は最新状態で上書きマージ、成功分だけキューから削除。未送信件数はヘッダーに表示。

4. **洗練された黒基調ミニマルUI**
   - Unicode絵文字を全廃し、細線SVGベクターアイコンとシックなタイポグラフィで統一。
   - アコーディオン式の折りたたみメニュー、4大地図カラー切替（ダーク・モノクロ・ストリート・セピア）。

---

## ディレクトリ・ファイル構成

```
.
├── index.html              # メインUI（ヘッダー、マップ、D-Pad、各種モーダル）
├── style.css               # スタイルシート（黒基調ダークテーマ、セーフエリア対応）
├── app.js                  # コアコントローラー（GPS測位、ゲームループ、イベント統合）
├── grid.js                 # 100mメッシュ計算、Leafletポリゴン描画、スキン連動
├── coins.js                # ゲーム内コイン、リワード広告シミュレーション、ショップ
├── stats.js                # 戦績集計、Supabase同期バッファ、称号アンロック、ランキング
├── supabase.js             # Supabase接続、週番号（ISO week）計算、REST/Realtime通信
├── outbox.js               # オフライン陣地の一時保存キュー（pending_tile_queue）と一括再送
├── poster.js               # HTML5 Canvas による週間アートポスターPNG書き出し
├── pro.js                  # Proサポーター管理・アクティベーション
├── schema.sql              # Supabaseテーブル定義・RLSポリシー・リアルタイム設定SQL
├── capacitor.config.json   # Capacitor iOS設定ファイル
├── package.json            # npm依存関係およびiOS自動ビルドスクリプト
├── scripts/
│   ├── build.js            # www/ ディレクトリへのWebアセット自動同期スクリプト
│   └── configure-ios.js    # Info.plist への位置情報権限・バックグラウンド設定自動注入
└── www/                    # Capacitor iOS向け同期済みWebアセット
```

---

## iOS アプリ化手順（Mac環境）

### ワンクリック・自動セットアップ
```bash
# 依存パッケージ導入
npm install

# iOS環境の追加・権限設定・Xcode起動を全自動実行
npm run ios:setup
```

### 個別コマンドで進める場合
```bash
# 1. 依存パッケージ導入
npm install

# 2. iOSネイティブプロジェクト追加
npx cap add ios

# 3. Webアセット同期 ＆ Info.plist 設定自動適用
npm run cap:sync

# 4. Xcodeを開く
npx cap open ios
```

### iOS特有の設定事項（スクリプトで自動設定済み）
`scripts/configure-ios.js` により、`ios/App/App/Info.plist` に以下の必須パーミッションが自動注入されます：
- `NSLocationWhenInUseUsageDescription`（アプリ使用中の位置情報利用）
- `NSLocationAlwaysAndWhenInUseUsageDescription`（バックグラウンド歩行・画面消灯時の追従）
- `UIBackgroundModes: ["location"]`（バックグラウンドGPS位置情報更新）
- `UIViewControllerBasedStatusBarAppearance: false`（ダークテーマステータスバー）

---

## 課金（IAP）の仕組み

iOS の課金は `cordova-plugin-purchase`（CdvPurchase v13+、StoreKit 連携）で実装しています（`iap.js`）。

- 購入フロー: 注文 → `approved` → レシート検証 `verify()` → `verified` で初めて特典を付与 → `finish()`
- ネイティブでは検証済みレシート以外からコイン／特典を付与しません。プラグイン未読込時は購入を中断します（無料付与のフォールバックはありません）
- 消耗型コインパックはトランザクションID単位で付与済み記録（localStorage `tw_iap_processed_tx_v1`）を持ち、二重付与を防ぎます
- ショップの価格表示は App Store から取得したローカライズ価格を優先し、未取得時のみカタログ価格（円）を表示します
- 復元（Restore）対象は非消耗型の広告非表示パスのみです。消耗型コインパックは Apple の仕様上復元できません

### サーバー側レシート検証（任意）

既定ではプラグインが端末側でレシートを検証します。本番でサーバー検証を行う場合は、レシートJSONを POST で受け取り `{ "ok": true }` を返すエンドポイント（Supabase Edge Function 等）を用意し、アプリ読み込み前に以下を設定してください。

```js
window.TW_IAP_VALIDATOR_URL = 'https://<your-project>.supabase.co/functions/v1/verify-iap';
```

設定がある場合のみ `store.validator` に割り当てられます。

## App Store Connect で必要な登録（課金）

コード側の商品IDと **完全一致** する商品を App Store Connect に登録する必要があります。

| 商品ID | 種別 | 価格（目安） | 内容 |
|---|---|---|---|
| `com.shodai.territorywalk.coins1000` | 消耗型 | ¥120 | 1,000 COIN（ビギナーパック） |
| `com.shodai.territorywalk.coins4500` | 消耗型 | ¥500 | 4,500 COIN（スタンダードパック） |
| `com.shodai.territorywalk.coins14000` | 消耗型 | ¥1,500 | 14,000 COIN（プレミアムパック） |
| `com.shodai.territorywalk.coins50000` | 消耗型 | ¥5,000 | 50,000 COIN（アルティメットパック） |
| `com.shodai.territorywalk.adfree` | 非消耗型 | ¥480 | 広告完全非表示パス |

手順の要点:

1. App Store Connect で「有料アプリ」契約（Paid Apps Agreement）と銀行口座・税務情報を有効化する
2. 上記5商品を作成し、表示名・説明・価格を設定する（初回はアプリバージョンと一緒に審査へ提出）
3. Sandbox テスターを作成し、実機（TestFlight 含む）で購入・キャンセル・復元・二重付与防止を検証する
4. 商品IDはアプリID（`com.oekaki.territorywalk`）とは独立した識別子です。未登録の場合は上記のIDで新規登録してください（登録済みの場合はコード側を変更しないこと）
