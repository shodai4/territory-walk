#!/usr/bin/env node
/**
 * TERRITORY WALK - setup-ios-assets.js
 * Automatically copies AppIcon.appiconset into the iOS Xcode project assets.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_ICONSET = path.join(ROOT_DIR, 'resources', 'AppIcon.appiconset');
const DEST_ICONSET = path.join(ROOT_DIR, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');

if (!fs.existsSync(DEST_ICONSET)) {
    console.log('[iOS Assets] iOS AppIcon directory not yet created. It will be copied once iOS project is added.');
    process.exit(0);
}

try {
    const files = fs.readdirSync(SRC_ICONSET);
    for (const file of files) {
        const srcFile = path.join(SRC_ICONSET, file);
        const destFile = path.join(DEST_ICONSET, file);
        fs.copyFileSync(srcFile, destFile);
    }
    console.log(`[iOS Assets] Successfully synced ${files.length} icon assets to iOS Assets.xcassets!`);
} catch (err) {
    console.error('[iOS Assets] Error syncing icon assets:', err);
}
