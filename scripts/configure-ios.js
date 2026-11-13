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
            val: '街を歩いて白黒の陣地を塗り替えるために位置情報を使用します。',
            xml: '	<key>NSLocationWhenInUseUsageDescription</key>\n	<string>街を歩いて白黒の陣地を塗り替えるために位置情報を使用します。</string>'
        },
        {
            key: 'NSLocationAlwaysAndWhenInUseUsageDescription',
            val: '画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。',
            xml: '	<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>\n	<string>画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。</string>'
        },
        {
            key: 'NSLocationAlwaysUsageDescription',
            val: '画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。',
            xml: '	<key>NSLocationAlwaysUsageDescription</key>\n	<string>画面を消灯してポケットに入れたままでも歩行陣取りを継続するためにバックグラウンド位置情報を使用します。</string>'
        },
        {
            key: 'UIBackgroundModes',
            val: '<string>location</string>',
            xml: '	<key>UIBackgroundModes</key>\n	<array>\n		<string>location</string>\n	</array>'
        },
        {
            key: 'UIViewControllerBasedStatusBarAppearance',
            val: '<false/>',
            xml: '	<key>UIViewControllerBasedStatusBarAppearance</key>\n	<false/>'
        },
        {
            key: 'UIStatusBarStyle',
            val: 'UIStatusBarStyleLightContent',
            xml: '	<key>UIStatusBarStyle</key>\n	<string>UIStatusBarStyleLightContent</string>'
        },
        {
            key: 'GADApplicationIdentifier',
            val: 'ca-app-pub-3940256099942544~1458102511',
            xml: '	<key>GADApplicationIdentifier</key>\n	<string>ca-app-pub-3940256099942544~1458102511</string>'
        },
        {
            key: 'NSUserTrackingUsageDescription',
            val: '最適な広告を表示するためにトラッキングの許可をお願いいたします。',
            xml: '	<key>NSUserTrackingUsageDescription</key>\n	<string>最適な広告を表示するためにトラッキングの許可をお願いいたします。</string>'
        },
        {
            key: 'SKAdNetworkItems',
            val: 'cstr6suwn9.skadnetwork',
            xml: '	<key>SKAdNetworkItems</key>\n	<array>\n		<dict>\n			<key>SKAdNetworkIdentifier</key>\n			<string>cstr6suwn9.skadnetwork</string>\n		</dict>\n	</array>'
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
            // Key exists - verify and update string if needed
            if (entry.val && entry.key.startsWith('NSLocation')) {
                const regex = new RegExp(`<key>${entry.key}<\\/key>\\s*<string>([^<]*)<\\/string>`, 'm');
                const match = content.match(regex);
                if (match && match[1] !== entry.val) {
                    content = content.replace(regex, `<key>${entry.key}</key>\n\t<string>${entry.val}</string>`);
                    console.log(`[iOS Config] Updated description for <key>${entry.key}</key> to: "${entry.val}"`);
                    modified = true;
                } else {
                    console.log(`[iOS Config] Verified: <key>${entry.key}</key> is up to date.`);
                }
            } else {
                console.log(`[iOS Config] Verified: <key>${entry.key}</key> already present.`);
            }
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
