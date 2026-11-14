#!/usr/bin/env python3
"""
TERRITORY WALK - generate-assets.py
Builds every icon asset from ONE master image:

    resources/icon-source.png   <- 確定アプリアイコン「案A」 (1024x1024, RGB, no alpha)

Outputs (all derived from the master, so CI can never fall back to an older design):
  * resources/icon.png                        1024x1024 (byte-identical copy of the master)
  * resources/AppIcon.appiconset/*.png        every iOS size + Contents.json
  * favicon.png / favicon.ico                 32x32 / multi-size browser favicon
  * icon-192.png / icon-512.png               PWA icons
  * apple-touch-icon.png                      180x180
  * www/<same web icons>                      when www/ exists
  * resources/splash.png                      2732x2732 splash centred on the master

The old procedurally-drawn placeholder icon (dark grid + amber ring) is gone on purpose:
it used to overwrite the real artwork on every CI run.
"""

import hashlib
import json
import os
import shutil

from PIL import Image

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESOURCES_DIR = os.path.join(ROOT_DIR, "resources")
WWW_DIR = os.path.join(ROOT_DIR, "www")

MASTER_ICON = os.path.join(RESOURCES_DIR, "icon-source.png")
ICON_SIZE = 1024
IOS_MARKETING_ICON = "AppIcon-512@2x.png"

# (filename, pixels) - kept in sync with Contents.json below and with tests/app-icon.test.js
IOS_SIZES = [
    ("AppIcon-20x20@2x.png", 40),
    ("AppIcon-20x20@3x.png", 60),
    ("AppIcon-29x29@2x.png", 58),
    ("AppIcon-29x29@3x.png", 87),
    ("AppIcon-40x40@2x.png", 80),
    ("AppIcon-40x40@3x.png", 120),
    ("AppIcon-60x60@2x.png", 120),
    ("AppIcon-60x60@3x.png", 180),
    ("AppIcon-76x76@2x.png", 152),
    ("AppIcon-83.5x83.5@2x.png", 167),
    (IOS_MARKETING_ICON, 1024),
]

# (filename, pixels) - web / PWA icons read from the repository root
WEB_PNGS = [
    ("favicon.png", 32),
    ("icon-192.png", 192),
    ("icon-512.png", 512),
    ("apple-touch-icon.png", 180),
]

FAVICON_ICO_SIZES = [(16, 16), (32, 32), (48, 48)]

CONTENTS_JSON = {
    "images": [
        {"size": "20x20", "idiom": "iphone", "filename": "AppIcon-20x20@2x.png", "scale": "2x"},
        {"size": "20x20", "idiom": "iphone", "filename": "AppIcon-20x20@3x.png", "scale": "3x"},
        {"size": "29x29", "idiom": "iphone", "filename": "AppIcon-29x29@2x.png", "scale": "2x"},
        {"size": "29x29", "idiom": "iphone", "filename": "AppIcon-29x29@3x.png", "scale": "3x"},
        {"size": "40x40", "idiom": "iphone", "filename": "AppIcon-40x40@2x.png", "scale": "2x"},
        {"size": "40x40", "idiom": "iphone", "filename": "AppIcon-40x40@3x.png", "scale": "3x"},
        {"size": "60x60", "idiom": "iphone", "filename": "AppIcon-60x60@2x.png", "scale": "2x"},
        {"size": "60x60", "idiom": "iphone", "filename": "AppIcon-60x60@3x.png", "scale": "3x"},
        {"size": "20x20", "idiom": "ipad", "filename": "AppIcon-20x20@2x.png", "scale": "2x"},
        {"size": "29x29", "idiom": "ipad", "filename": "AppIcon-29x29@2x.png", "scale": "2x"},
        {"size": "40x40", "idiom": "ipad", "filename": "AppIcon-40x40@2x.png", "scale": "2x"},
        {"size": "76x76", "idiom": "ipad", "filename": "AppIcon-76x76@2x.png", "scale": "2x"},
        {"size": "83.5x83.5", "idiom": "ipad", "filename": "AppIcon-83.5x83.5@2x.png", "scale": "2x"},
        {"size": "1024x1024", "idiom": "ios-marketing", "filename": IOS_MARKETING_ICON, "scale": "1x"},
    ],
    "info": {"version": 1, "author": "xcode"},
}


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_master():
    """Loads the confirmed app icon and refuses anything App Store would reject."""
    if not os.path.exists(MASTER_ICON):
        raise SystemExit(
            f"[Assets] FATAL: master icon not found: {MASTER_ICON}\n"
            "[Assets] Place the confirmed 1024x1024 RGB PNG there and re-run."
        )

    img = Image.open(MASTER_ICON)
    if img.size != (ICON_SIZE, ICON_SIZE):
        raise SystemExit(f"[Assets] FATAL: {MASTER_ICON} is {img.size}, expected ({ICON_SIZE}, {ICON_SIZE}).")
    if img.mode != "RGB" or "A" in img.getbands():
        raise SystemExit(
            f"[Assets] FATAL: {MASTER_ICON} is mode {img.mode}; App Store icons must be RGB with no alpha channel."
        )
    return img


def resized(img, px):
    return img.resize((px, px), Image.Resampling.LANCZOS)


def main():
    master = load_master()
    os.makedirs(RESOURCES_DIR, exist_ok=True)

    # 1. 1024x1024 base icon: exact byte copy so the confirmed artwork is never re-encoded.
    base_icon_path = os.path.join(RESOURCES_DIR, "icon.png")
    shutil.copyfile(MASTER_ICON, base_icon_path)
    print(f"[Assets] Master icon  : {MASTER_ICON} sha256={sha256(MASTER_ICON)}")
    print(f"[Assets] Base icon    : {base_icon_path} sha256={sha256(base_icon_path)}")

    # 2. iOS AppIcon.appiconset (1024 marketing icon is also a byte-identical copy)
    ios_set_dir = os.path.join(RESOURCES_DIR, "AppIcon.appiconset")
    os.makedirs(ios_set_dir, exist_ok=True)
    for fname, px in IOS_SIZES:
        out = os.path.join(ios_set_dir, fname)
        if px == ICON_SIZE:
            shutil.copyfile(MASTER_ICON, out)
        else:
            resized(master, px).save(out, "PNG")
        print(f"[Assets] iOS icon     : {fname} ({px}x{px})")

    with open(os.path.join(ios_set_dir, "Contents.json"), "w", encoding="utf-8") as f:
        json.dump(CONTENTS_JSON, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # 3. Web / PWA icons
    web_targets = []
    for fname, px in WEB_PNGS:
        out = os.path.join(ROOT_DIR, fname)
        resized(master, px).save(out, "PNG")
        web_targets.append(fname)
        print(f"[Assets] Web icon     : {fname} ({px}x{px})")

    # Browser favicon in .ico form (multi-size), served from the Pages root.
    ico_path = os.path.join(ROOT_DIR, "favicon.ico")
    master.save(ico_path, format="ICO", sizes=FAVICON_ICO_SIZES)
    web_targets.append("favicon.ico")
    print(f"[Assets] Web favicon  : favicon.ico {FAVICON_ICO_SIZES}")

    # 4. Splash screen: master icon centred on the app's obsidian background.
    splash_size = 2732
    splash = Image.new("RGB", (splash_size, splash_size), color=(9, 9, 11))
    stamp = resized(master, 512)
    offset = (splash_size - 512) // 2
    splash.paste(stamp, (offset, offset - 100))
    splash_path = os.path.join(RESOURCES_DIR, "splash.png")
    splash.save(splash_path, "PNG")
    print(f"[Assets] Splash       : {splash_path} ({splash_size}x{splash_size})")

    # 5. Mirror web icons into www/ when the Capacitor web dir already exists.
    if os.path.isdir(WWW_DIR):
        for fname in web_targets:
            shutil.copyfile(os.path.join(ROOT_DIR, fname), os.path.join(WWW_DIR, fname))
            print(f"[Assets] www sync     : {fname}")
    else:
        print("[Assets] www/ not present yet - npm run build copies the web icons later.")

    # 6. Self-check so a broken run can never reach the App Store step silently.
    problems = []
    if sha256(base_icon_path) != sha256(MASTER_ICON):
        problems.append("resources/icon.png differs from resources/icon-source.png")
    for fname, px in IOS_SIZES:
        with Image.open(os.path.join(ios_set_dir, fname)) as im:
            if im.size != (px, px):
                problems.append(f"{fname} is {im.size}, expected ({px}, {px})")
            if im.mode != "RGB":
                problems.append(f"{fname} is mode {im.mode}, expected RGB")
    if problems:
        raise SystemExit("[Assets] FATAL: verification failed -> " + "; ".join(problems))

    print(f"[Assets] Done. {len(IOS_SIZES)} iOS icon(s) + {len(web_targets)} web asset(s) generated from the master icon.")


if __name__ == "__main__":
    main()
