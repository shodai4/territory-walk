# TERRITORY WALK - iOS Capacitor Native Guide & Info.plist Memo

## 📱 Capacitor Configuration (`capacitor.config.json`)
- **appId**: `com.oekaki.territorywalk`
- **appName**: `TerritoryWalk`
- **webDir**: `.`
- **bundledWebRuntime**: `false`

---

## 🔒 iOS Info.plist Permissions Memo
When building for iOS via Capacitor (`npx cap open ios`), add the following permission descriptions to your Xcode project's `Info.plist` file:

```xml
<!-- 位置情報（使用中） -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>歩行したエリアを白黒の陣地に塗り替えるために位置情報を使用します。</string>

<!-- 位置情報（常に許可 / バックグラウンド対応時） -->
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>バックグラウンド歩行時にも自動で陣地を広げるために位置情報を使用します。</string>
```

---

## 🚀 iOS Native Build Commands
```bash
# Initialize npm dependencies (if not already done)
npm install

# Add Capacitor iOS platform (if not already added)
npx cap add ios

# Copy web assets to iOS project
npx cap copy

# Open Xcode for building and running on iOS Simulator or Device
npx cap open ios
```
