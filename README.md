# TERRITORY WALK (白黒歩行陣取りアプリ)

街を歩いてリアルタイムに陣地を広げる、白黒オセロ型リアルGPSウォーキングゲーム。  
完全0円構成（GitHub Pages + Supabase 無料枠）で常時稼働中。

---

## 主な機能と特徴

1. **リアルタイム歩行オセロ陣取り**
   - 日本全国・世界中を約100m四方の正方形メッシュ（緯度0.0009度単位）に分割。
   - 自分が歩いたマスが自陣色（White / Black）に開拓され、相手チームのマスを踏むとオセロのように奪還・塗り替え。
   - 全幅対戦パーセンテージバーで現在の勢力比率をリアルタイム表示。

2. **Supabase オンラインマルチプレイ ＆ Realtime同期**
   - WebSocket（Realtimeチャンネル）で他プレイヤーの開拓を数秒で手元マップに反映。
   - 端末ローカルUUIDによる一意なプレイヤー識別（ログイン不要・完全無料）。
   - 毎週月曜0:00（JST）の自動シーズン切り替え＆勝敗判定、週間ランキング・歴代ランキング。

3. **コイン経済圏 ＆ ショップシステム（Pay to Win 100%排除）**
   - 歩行開拓（+1C／奪還+2C）、デイリーログインボーナス（+20〜50C）、動画リワード広告視聴（+50C）でコイン獲得。
   - 全8色のマステーマ解放、6大限定称号、週間アートポスターPNG書き出しチケット、現在地ピン光彩エフェクト。

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
