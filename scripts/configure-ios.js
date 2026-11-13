/**
 * TERRITORY WALK - configure-ios.js
 * Automatically configures iOS Info.plist for background GPS tracking,
 * location permissions, dark status bar, and app settings for Capacitor.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PLIST_PATH = path.join(ROOT_DIR, 'ios', 'App', 'App', 'Info.plist');

console.log('[iOS Config] Checking iOS project configuration...');

if (!fs.existsSync(PLIST_PATH)) {
    console.log('[iOS Config] Note: ios/App/App/Info.plist not found.');
    console.log('[iOS Config] If you haven\'t added iOS yet, run:');
    console.log('[iOS Config]   npx cap add ios');
    console.log('[iOS Config] Or simply:');
    console.log('[iOS Config]   npm run ios:setup');
    process.exit(0);
}

try {
    let content = fs.readFileSync(PLIST_PATH, 'utf8');
    let modified = false;

    // Keys and values to ensure in Info.plist
    const CONFIG_ENTRIES = [
        {
            key: 'NSLocationWhenInUseUsageDescription',
            xml: '	<key>NSLocationWhenInUseUsageDescription</key>\n	<string>歩行オセロ陣取りゲームの現在地追跡とマス開拓のため、位置情報を利用します。</string>'
        },
        {
            key: 'NSLocationAlwaysAndWhenInUseUsageDescription',
            xml: '	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>\n	<string>アプリをバックグラウンドに置いた状態や画面消灯時でも歩行距離・マス開拓を継続するため、位置情報を常に利用します。</string>'
        },
        {
            key: 'NSLocationAlwaysUsageDescription',
            xml: '	<key>NSLocationAlwaysUsageDescription</key>\n	<string>バックグラウンドでの歩行オセロ陣地開拓のため、位置情報を常に利用します。</string>'
        },
        {
            key: 'UIBackgroundModes',
            xml: '	<key>UIBackgroundModes</key>\n	<array>\n		<string>location</string>\n	</array>'
        },
        {
            key: 'UIViewControllerBasedStatusBarAppearance',
            xml: '	<key>UIViewControllerBasedStatusBarAppearance</key>\n	<false/>'
        },
        {
            key: 'UIStatusBarStyle',
            xml: '	<key>UIStatusBarStyle</key>\n	<string>UIStatusBarStyleLightContent</string>'
        }
    ];

    for (const entry of CONFIG_ENTRIES) {
        if (!content.includes(`<key>${entry.key}</key>`)) {
            // Find closing </dict>
            const lastDictIndex = content.lastIndexOf('</dict>');
            if (lastDictIndex !== -1) {
                content = content.slice(0, lastDictIndex) + entry.xml + '\n' + content.slice(lastDictIndex);
                console.log(`[iOS Config] Injected permission/config: <key>${entry.key}</key>`);
                modified = true;
            }
        } else {
            console.log(`[iOS Config] Verified: <key>${entry.key}</key> already present.`);
        }
    }

    if (modified) {
        fs.writeFileSync(PLIST_PATH, content, 'utf8');
        console.log('[iOS Config] Successfully updated Info.plist with GPS permissions and background modes!');
    } else {
        console.log('[iOS Config] Info.plist is already fully configured.');
    }

} catch (err) {
    console.error('[iOS Config] Error modifying Info.plist:', err);
}
