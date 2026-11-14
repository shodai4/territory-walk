#!/usr/bin/env python3
import os
import shutil

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WWW_DIR = os.path.join(ROOT_DIR, "www")

ASSETS_TO_COPY = [
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
]

os.makedirs(WWW_DIR, exist_ok=True)
count = 0
for f in ASSETS_TO_COPY:
    src = os.path.join(ROOT_DIR, f)
    dst = os.path.join(WWW_DIR, f)
    if os.path.exists(src):
        shutil.copy2(src, dst)
        count += 1
print(f"[Build Py] Successfully synced {count} files to www/")
