#!/usr/bin/env python3
"""
TERRITORY WALK - generate-watch-assets.py

Watchアプリ用のアセットを CI（macOSランナー）で生成する。
  - watch/TerritoryWatch/Assets.xcassets/AppIcon.appiconset/ … 全サイズのアイコン（アルファ無しRGB）
  - ios/App/App/silent.wav … 無音通知用の 0.5 秒の無音（sound=nil だと Watch が振動しないため）

Watchアイコンは「黒背景だと円形に見えない」として Guideline 4.0 で指摘される実例があるため、
明るい背景（#F4F4F5）に既存アイコンを配置する。デザインを差し替えるときは
resources/icon-source.png を置き換えてこのスクリプトを再実行するだけでよい。

使い方:
    python3 scripts/generate-watch-assets.py
"""

import json
import math
import os
import struct
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SOURCE_CANDIDATES = [
    os.path.join(ROOT, "resources", "icon.png"),
    os.path.join(ROOT, "resources", "icon-source.png"),
    os.path.join(ROOT, "icon-512.png"),
]
WATCH_ASSETS_DIR = os.path.join(ROOT, "watch", "TerritoryWatch", "Assets.xcassets")
APP_ICONSET_DIR = os.path.join(WATCH_ASSETS_DIR, "AppIcon.appiconset")
SILENT_WAV = os.path.join(ROOT, "watch", "ios", "silent.wav")

BACKGROUND = (244, 244, 245)   # #F4F4F5（明るい背景）
ICON_INSET_RATIO = 0.74        # 円形マスクで欠けないように少し小さめに置く

# Apple の Watch AppIcon（Xcode テンプレート相当）。scale/subtype は公式の組み合わせ。
WATCH_ICON_SLOTS = [
    {"size": "24x24", "px": 48, "role": "notificationCenter", "subtype": "38mm", "scale": "2x"},
    {"size": "27.5x27.5", "px": 55, "role": "notificationCenter", "subtype": "42mm", "scale": "2x"},
    {"size": "29x29", "px": 58, "role": "companionSettings", "scale": "2x"},
    {"size": "29x29", "px": 87, "role": "companionSettings", "scale": "3x"},
    {"size": "40x40", "px": 80, "role": "appLauncher", "subtype": "38mm", "scale": "2x"},
    {"size": "44x44", "px": 88, "role": "appLauncher", "subtype": "40mm", "scale": "2x"},
    {"size": "50x50", "px": 100, "role": "appLauncher", "subtype": "44mm", "scale": "2x"},
    {"size": "44x44", "px": 88, "role": "longLook", "subtype": "42mm", "scale": "2x"},
    {"size": "50x50", "px": 100, "role": "longLook", "subtype": "44mm", "scale": "2x"},
    {"size": "86x86", "px": 172, "role": "quickLook", "subtype": "38mm", "scale": "2x"},
    {"size": "98x98", "px": 196, "role": "quickLook", "subtype": "42mm", "scale": "2x"},
    {"size": "108x108", "px": 216, "role": "quickLook", "subtype": "44mm", "scale": "2x"},
]


def find_source():
    for path in SOURCE_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def render_icon(source, pixels):
    """明るい背景に元アイコンを中央配置した RGB（アルファ無し）画像を作る。"""
    canvas = Image.new("RGB", (pixels, pixels), BACKGROUND)
    side = max(8, int(round(pixels * ICON_INSET_RATIO)))
    icon = source.convert("RGBA").resize((side, side), Image.LANCZOS)
    # 角丸のマスクで「アプリらしい」見た目にする（Watchが円形に切るため角は残ってよい）
    mask = Image.new("L", (side, side), 0)
    draw_radius = max(2, int(side * 0.22))
    from PIL import ImageDraw
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], radius=draw_radius, fill=255)
    offset = ((pixels - side) // 2, (pixels - side) // 2)
    canvas.paste(icon, offset, mask)
    return canvas


def write_contents_json():
    images = []
    for index, slot in enumerate(WATCH_ICON_SLOTS):
        filename = f"AppIcon-watch-{index}-{slot['px']}.png"
        entry = {
            "filename": filename,
            "idiom": "watch",
            "role": slot["role"],
            "scale": slot["scale"],
            "size": slot["size"],
        }
        if slot.get("subtype"):
            entry["subtype"] = slot["subtype"]
        images.append(entry)
    images.append({
        "filename": "AppIcon-watch-marketing-1024.png",
        "idiom": "watch-marketing",
        "scale": "1x",
        "size": "1024x1024",
    })
    contents = {
        "images": images,
        "info": {"author": "xcode", "version": 1},
    }
    with open(os.path.join(APP_ICONSET_DIR, "Contents.json"), "w", encoding="utf-8") as handle:
        json.dump(contents, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def write_silent_wav():
    """0.5秒の無音 WAV（44.1kHz / 16bit / モノラル）。通知音として有効な最小構成。"""
    sample_rate = 44100
    seconds = 0.5
    frames = int(sample_rate * seconds)
    data = b"\x00\x00" * frames
    byte_rate = sample_rate * 2
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, byte_rate, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    os.makedirs(os.path.dirname(SILENT_WAV), exist_ok=True)
    with open(SILENT_WAV, "wb") as handle:
        handle.write(header + data)


def main():
    source_path = find_source()
    if not source_path:
        print("[watch] icon source not found (resources/icon.png)", file=sys.stderr)
        return 1

    source = Image.open(source_path)
    os.makedirs(APP_ICONSET_DIR, exist_ok=True)

    for index, slot in enumerate(WATCH_ICON_SLOTS):
        pixels = slot["px"]
        icon = render_icon(source, pixels)
        filename = f"AppIcon-watch-{index}-{pixels}.png"
        icon.save(os.path.join(APP_ICONSET_DIR, filename), format="PNG")
    render_icon(source, 1024).save(os.path.join(APP_ICONSET_DIR, "AppIcon-watch-marketing-1024.png"), format="PNG")
    write_contents_json()

    # Assets.xcassets のトップにも Contents.json が要る
    with open(os.path.join(WATCH_ASSETS_DIR, "Contents.json"), "w", encoding="utf-8") as handle:
        json.dump({"info": {"author": "xcode", "version": 1}}, handle, indent=2)
        handle.write("\n")

    write_silent_wav()

    marketing = os.path.join(APP_ICONSET_DIR, "AppIcon-watch-marketing-1024.png")
    size_bytes = math.floor(os.path.getsize(marketing) / 1024)
    print(f"[watch] icons: {len(WATCH_ICON_SLOTS)} slots + marketing ({size_bytes} KiB)")
    print(f"[watch] silent sound: {os.path.relpath(SILENT_WAV, ROOT)}")
    print(f"[watch] source icon: {os.path.relpath(source_path, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
