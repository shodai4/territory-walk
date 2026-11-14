/**
 * TERRITORY WALK - build.js
 * Synchronizes web distribution assets into www/ for Capacitor iOS build
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const WWW_DIR = path.join(ROOT_DIR, 'www');

const ASSETS_TO_COPY = [
    'index.html',
    'privacy.html',
    'terms.html',
    'support.html',
    'style.css',
    'app.js',
    'admob.js',
    'iap.js',
    'coins.js',
    'grid.js',
    'outbox.js',
    'poster.js',
    'pro.js',
    'search.js',
    'stats.js',
    'supabase.js',
    'favicon.png',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png'
];

console.log('[Build] Preparing www/ directory for Capacitor iOS...');

if (!fs.existsSync(WWW_DIR)) {
    fs.mkdirSync(WWW_DIR, { recursive: true });
    console.log('[Build] Created www/ directory.');
}

let copiedCount = 0;
for (const file of ASSETS_TO_COPY) {
    const srcPath = path.join(ROOT_DIR, file);
    const destPath = path.join(WWW_DIR, file);

    if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`[Build] Synced: ${file} -> www/${file}`);
        copiedCount++;
    } else {
        console.warn(`[Build] Warning: Source file ${file} not found.`);
    }
}

console.log(`[Build] Complete! Successfully synced ${copiedCount} files into www/`);
