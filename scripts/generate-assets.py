#!/usr/bin/env python3
"""
TERRITORY WALK - generate-assets.py
Generates Apple HIG compliant App Store icons (1024x1024, no alpha),
splash screen (2732x2732), web favicons, and iOS AppIcon.appiconset.
"""

import os
import json
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESOURCES_DIR = os.path.join(ROOT_DIR, "resources")
IOS_ASSETS_DIR = os.path.join(ROOT_DIR, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset")
WWW_DIR = os.path.join(ROOT_DIR, "www")

os.makedirs(RESOURCES_DIR, exist_ok=True)
os.makedirs(WWW_DIR, exist_ok=True)

def create_app_icon(size=1024):
    """
    Creates a 1024x1024 square icon with NO ALPHA channel (required by App Store).
    Dark obsidian theme (#09090b) with subtle territory grid lines,
    a contrasting Black/White territory core, and an amber GPS pulse circle.
    """
    img = Image.new("RGB", (size, size), color=(9, 9, 11)) # #09090b
    draw = ImageDraw.Draw(img)

    # 1. Subtle orthogonal territory grid lines (100m chess grid feel)
    grid_color = (24, 24, 27) # #18181b
    step = size // 8
    for i in range(step, size, step):
        draw.line([(i, 0), (i, size)], fill=grid_color, width=2)
        draw.line([(0, i), (size, i)], fill=grid_color, width=2)

    # 2. Outer golden/amber GPS range ring
    center = size // 2
    ring_radius = int(size * 0.38)
    amber_ring = (245, 158, 11) # #f59e0b
    draw.ellipse(
        [center - ring_radius, center - ring_radius, center + ring_radius, center + ring_radius],
        outline=amber_ring,
        width=int(size * 0.015)
    )

    # 3. Outer subtle cyan territory radar sweep
    inner_ring = int(size * 0.31)
    cyan_dim = (6, 78, 59) # dark emerald/cyan
    draw.ellipse(
        [center - inner_ring, center - inner_ring, center + inner_ring, center + inner_ring],
        outline=cyan_dim,
        width=int(size * 0.008)
    )

    # 4. Central Black/White split disc (The essence of Territory Walk)
    core_radius = int(size * 0.24)
    # Right half: White territory (#fafafa)
    draw.pieslice(
        [center - core_radius, center - core_radius, center + core_radius, center + core_radius],
        start=270, end=90,
        fill=(250, 250, 250)
    )
    # Left half: Black territory (#18181b) with crisp border
    draw.pieslice(
        [center - core_radius, center - core_radius, center + core_radius, center + core_radius],
        start=90, end=270,
        fill=(18, 18, 20)
    )

    # Outer border for the disc
    draw.ellipse(
        [center - core_radius, center - core_radius, center + core_radius, center + core_radius],
        outline=(212, 212, 216),
        width=int(size * 0.01)
    )

    # Dividing central vertical line
    draw.line([(center, center - core_radius), (center, center + core_radius)], fill=(245, 158, 11), width=int(size * 0.012))

    # Center GPS marker pin dot (Solid Amber)
    dot_radius = int(size * 0.04)
    draw.ellipse(
        [center - dot_radius, center - dot_radius, center + dot_radius, center + dot_radius],
        fill=(245, 158, 11),
        outline=(255, 255, 255),
        width=int(size * 0.006)
    )

    return img

def create_splash_screen(size=2732):
    """
    Creates a 2732x2732 launch splash screen.
    Minimalist dark background with central app emblem and brand styling.
    """
    splash = Image.new("RGB", (size, size), color=(9, 9, 11))
    draw = ImageDraw.Draw(splash)

    # Center icon stamp
    icon_stamp = create_app_icon(size=512)
    offset = (size - 512) // 2
    splash.paste(icon_stamp, (offset, offset - 100))

    return splash

def main():
    print("[Assets] Generating App Store icon (1024x1024 RGB)...")
    icon1024 = create_app_icon(1024)
    icon_path = os.path.join(RESOURCES_DIR, "icon.png")
    icon1024.save(icon_path, "PNG")
    print(f"[Assets] Saved base icon: {icon_path}")

    # Web favicons
    icon1024.resize((192, 192), Image.Resampling.LANCZOS).save(os.path.join(ROOT_DIR, "icon-192.png"), "PNG")
    icon1024.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(ROOT_DIR, "icon-512.png"), "PNG")
    icon1024.resize((180, 180), Image.Resampling.LANCZOS).save(os.path.join(ROOT_DIR, "apple-touch-icon.png"), "PNG")
    icon1024.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(ROOT_DIR, "favicon.png"), "PNG")

    # Sync web icons to www/
    for fname in ["icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.png"]:
        src = os.path.join(ROOT_DIR, fname)
        dst = os.path.join(WWW_DIR, fname)
        if os.path.exists(src):
            Image.open(src).save(dst)

    print("[Assets] Generating Splash Screen (2732x2732 RGB)...")
    splash2732 = create_splash_screen(2732)
    splash_path = os.path.join(RESOURCES_DIR, "splash.png")
    splash2732.save(splash_path, "PNG")
    print(f"[Assets] Saved splash screen: {splash_path}")

    # Generate iOS AppIcon.appiconset if ios/ directory exists or create template in resources
    ios_set_dir = os.path.join(RESOURCES_DIR, "AppIcon.appiconset")
    os.makedirs(ios_set_dir, exist_ok=True)

    # iOS icon sizes map (filename, size in px)
    ios_sizes = [
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
        ("AppIcon-512@2x.png", 1024),
    ]

    for fname, px in ios_sizes:
        resized = icon1024.resize((px, px), Image.Resampling.LANCZOS)
        resized.save(os.path.join(ios_set_dir, fname), "PNG")

    # Contents.json for Xcode asset catalog
    contents_data = {
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
            {"size": "1024x1024", "idiom": "ios-marketing", "filename": "AppIcon-512@2x.png", "scale": "1x"}
        ],
        "info": {"version": 1, "author": "xcode"}
    }

    with open(os.path.join(ios_set_dir, "Contents.json"), "w", encoding="utf-8") as f:
        json.dump(contents_data, f, indent=2)

    print(f"[Assets] Generated complete iOS AppIcon.appiconset in: {ios_set_dir}")

if __name__ == "__main__":
    main()
