#!/usr/bin/env python3
"""
TERRITORY WALK - App Store Screenshot Generator (Apple HIG 6.7" Display: 1290 x 2796 px)
Generates high-resolution App Store Connect promotional screenshots ready for submission.
"""

import os
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT_DIR, 'resources', 'screenshots')
os.makedirs(OUT_DIR, exist_ok=True)

WIDTH = 1290
HEIGHT = 2796

# Fonts
FONT_JP = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
FONT_EN = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'

font_tag = ImageFont.truetype(FONT_JP, 32)
font_title = ImageFont.truetype(FONT_JP, 64)
font_subtitle = ImageFont.truetype(FONT_JP, 36)
font_jp_sm = ImageFont.truetype(FONT_JP, 22)
font_jp_md = ImageFont.truetype(FONT_JP, 24)
font_jp_lg = ImageFont.truetype(FONT_JP, 28)

SCREENSHOTS = [
    {
        'file': 'screenshot-1-main-battle.png',
        'tag': 'リアル歩行 × 白黒陣取り',
        'title': '歩いて街を白黒陣取り',
        'sub': '日常の散歩や通勤が、リアルな陣取りバトルに。',
        'theme_color': (245, 158, 11), # amber
        'screen_type': 'main'
    },
    {
        'file': 'screenshot-2-season-result.png',
        'tag': '毎週月曜決着 × 白黒チーム対抗',
        'title': '白黒週間チームバトル',
        'sub': '毎週月曜リセット。チームで街の過半数を奪い取れ。',
        'theme_color': (56, 189, 248), # sky
        'screen_type': 'season'
    },
    {
        'file': 'screenshot-3-shop-titles.png',
        'tag': '集めて飾る × マステーマ＆限定称号',
        'title': '自分だけのスタイルを解放',
        'sub': '歩いて稼いだコインで、スキンや称号をコレクション。',
        'theme_color': (244, 63, 94), # rose
        'screen_type': 'shop'
    },
    {
        'file': 'screenshot-4-pocket-auto.png',
        'tag': '画面消灯OK × ポケット歩行対応',
        'title': 'ポケットに入れて歩くだけ',
        'sub': '画面を消灯したままでも、バックグラウンドで自動開拓。',
        'theme_color': (16, 185, 129), # emerald
        'screen_type': 'pocket'
    }
]

def create_base_canvas():
    img = Image.new('RGB', (WIDTH, HEIGHT), (9, 9, 11))
    draw = ImageDraw.Draw(img)
    
    # Subtle dark background gradient
    for y in range(HEIGHT):
        ratio = y / HEIGHT
        r = int(9 + ratio * 15)
        g = int(9 + ratio * 15)
        b = int(11 + ratio * 20)
        draw.line([(0, y), (WIDTH, y)], fill=(r, g, b))
        
    return img, draw

def draw_header(draw, item):
    tag_text = item['tag']
    title_text = item['title']
    sub_text = item['sub']
    theme_color = item['theme_color']
    
    # Pill Tag
    tag_bbox = draw.textbbox((0, 0), tag_text, font=font_tag)
    tag_w = tag_bbox[2] - tag_bbox[0]
    tag_h = tag_bbox[3] - tag_bbox[1]
    tag_x = (WIDTH - tag_w) // 2
    tag_y = 140
    
    # Pill background
    pad_x = 28
    pad_y = 12
    draw.rounded_rectangle(
        [(tag_x - pad_x, tag_y - pad_y), (tag_x + tag_w + pad_x, tag_y + tag_h + pad_y)],
        radius=24,
        fill=(24, 24, 27),
        outline=theme_color,
        width=2
    )
    draw.text((tag_x, tag_y), tag_text, fill=theme_color, font=font_tag)
    
    # Big Title
    title_bbox = draw.textbbox((0, 0), title_text, font=font_title)
    title_w = title_bbox[2] - title_bbox[0]
    title_x = (WIDTH - title_w) // 2
    draw.text((title_x, 230), title_text, fill=(255, 255, 255), font=font_title)
    
    # Subtitle
    sub_bbox = draw.textbbox((0, 0), sub_text, font=font_subtitle)
    sub_w = sub_bbox[2] - sub_bbox[0]
    sub_x = (WIDTH - sub_w) // 2
    draw.text((sub_x, 325), sub_text, fill=(161, 161, 170), font=font_subtitle)

def draw_phone_frame(img, draw):
    phone_x1 = 90
    phone_y1 = 440
    phone_x2 = WIDTH - 90
    phone_y2 = HEIGHT + 100
    
    # Outer dark bezel
    draw.rounded_rectangle(
        [(phone_x1, phone_y1), (phone_x2, phone_y2)],
        radius=68,
        fill=(18, 18, 22),
        outline=(63, 63, 70),
        width=6
    )
    
    # Screen inner area
    inner_x1 = phone_x1 + 18
    inner_y1 = phone_y1 + 18
    inner_x2 = phone_x2 - 18
    inner_y2 = phone_y2
    
    draw.rounded_rectangle(
        [(inner_x1, inner_y1), (inner_x2, inner_y2)],
        radius=54,
        fill=(0, 0, 0)
    )
    
    # Dynamic Island notch
    island_w = 260
    island_h = 52
    island_x = (WIDTH - island_w) // 2
    island_y = inner_y1 + 22
    draw.rounded_rectangle(
        [(island_x, island_y), (island_x + island_w, island_y + island_h)],
        radius=26,
        fill=(0, 0, 0),
        outline=(39, 39, 42),
        width=2
    )
    
    return (inner_x1, inner_y1, inner_x2, inner_y2)

def compose_main_screen(screen_img, inner_box):
    draw = ImageDraw.Draw(screen_img)
    x1, y1, x2, y2 = inner_box
    sw = x2 - x1
    sh = y2 - y1
    
    # Draw dark map chessboard grid
    grid_size = 110
    start_y = y1 + 120
    for r in range(22):
        for c in range(12):
            gx = x1 + c * grid_size
            gy = start_y + r * grid_size
            if gx + grid_size > x2 or gy + grid_size > y2:
                continue
            fill_color = (20, 22, 28)
            
            # Pattern of claimed tiles
            if (r, c) in [(2, 3), (2, 4), (3, 4), (4, 4), (5, 5), (6, 5), (7, 4), (8, 4), (8, 3)]:
                fill_color = (228, 228, 231) # White claimed
            elif (r, c) in [(3, 2), (4, 2), (4, 3), (5, 3), (5, 4), (6, 4), (7, 3), (6, 3)]:
                fill_color = (10, 10, 12) # Black claimed
                
            draw.rectangle([(gx, gy), (gx + grid_size, gy + grid_size)], fill=fill_color, outline=(38, 42, 52), width=1)
            
    # GPS Current Location pulse at center
    cx = x1 + sw // 2
    cy = y1 + 950
    draw.ellipse([(cx - 40, cy - 40), (cx + 40, cy + 40)], outline=(245, 158, 11), width=4)
    draw.ellipse([(cx - 16, cy - 16), (cx + 16, cy + 16)], fill=(245, 158, 11))
    
    # Header Overlay (UI)
    hw = sw - 48
    hx = x1 + 24
    hy = y1 + 100
    
    # App Title & Coins & Menu
    draw.text((hx + 8, hy + 4), "● TERRITORY WALK", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 32))
    
    # Coins Pill (No emoji, solid text)
    coin_pill_x = x2 - 270
    draw.rounded_rectangle([(coin_pill_x, hy), (coin_pill_x + 130, hy + 42)], radius=12, fill=(24, 24, 27), outline=(63, 63, 70), width=1)
    draw.text((coin_pill_x + 18, hy + 10), "1,250 C", fill=(245, 158, 11), font=ImageFont.truetype(FONT_EN, 22))
    
    # Menu Button
    draw.rounded_rectangle([(x2 - 120, hy), (x2 - 24, hy + 42)], radius=12, fill=(24, 24, 27), outline=(63, 63, 70), width=1)
    draw.text((x2 - 104, hy + 8), "MENU", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 22))
    
    # Battle Bar Header
    bar_y = hy + 60
    draw.text((hx + 8, bar_y), "YOU (黒陣営)", fill=(245, 158, 11), font=font_jp_sm)
    
    # Thick Battle Bar (72% Black vs 28% White)
    bar_bg_y = bar_y + 36
    bar_h = 56
    black_w = int(hw * 0.72)
    white_w = hw - black_w
    
    # Black portion (left)
    draw.rectangle([(hx, bar_bg_y), (hx + black_w, bar_bg_y + bar_h)], fill=(15, 15, 18), outline=(63, 63, 70), width=2)
    draw.text((hx + 24, bar_bg_y + 12), "72%", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 28))
    
    # White portion (right)
    draw.rectangle([(hx + black_w, bar_bg_y), (hx + hw, bar_bg_y + bar_h)], fill=(244, 244, 245), outline=(161, 161, 170), width=2)
    draw.text((hx + hw - 85, bar_bg_y + 12), "28%", fill=(0, 0, 0), font=ImageFont.truetype(FONT_EN, 28))
    
    # Search Bar
    search_y = bar_bg_y + bar_h + 18
    draw.rounded_rectangle([(hx, search_y), (hx + hw, search_y + 54)], radius=16, fill=(18, 18, 22), outline=(39, 39, 42), width=1)
    draw.text((hx + 20, search_y + 14), "地名・駅名で検索...", fill=(113, 113, 122), font=font_jp_sm)

def compose_season_screen(screen_img, inner_box):
    draw = ImageDraw.Draw(screen_img)
    x1, y1, x2, y2 = inner_box
    sw = x2 - x1
    
    mx = x1 + 36
    my = y1 + 180
    mw = sw - 72
    mh = 1450
    
    draw.rounded_rectangle([(mx, my), (mx + mw, my + mh)], radius=32, fill=(18, 18, 22), outline=(63, 63, 70), width=2)
    
    draw.text((mx + 40, my + 45), "SEASON RESULT", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 38))
    draw.text((mx + 40, my + 95), "2026-W46 シーズン終了結果", fill=(161, 161, 170), font=font_jp_md)
    
    # Victory Banner
    vy = my + 160
    draw.rounded_rectangle([(mx + 30, vy), (mx + mw - 30, vy + 120)], radius=20, fill=(34, 197, 94), outline=(74, 222, 128), width=2)
    draw.text((mx + mw//2 - 130, vy + 24), "VICTORY !", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 48))
    draw.text((mx + mw//2 - 120, vy + 78), "所属: 白陣営の勝利！", fill=(240, 253, 244), font=font_jp_sm)
    
    # Season Bar - Use Japanese Font for "マス"
    by = vy + 160
    draw.text((mx + 35, by), "White 76% (356マス)", fill=(244, 244, 245), font=font_jp_md)
    draw.text((mx + mw - 250, by), "(110マス) 24% Black", fill=(161, 161, 170), font=font_jp_md)
    
    bar_y = by + 35
    bar_w = mw - 70
    w_portion = int(bar_w * 0.76)
    draw.rectangle([(mx + 35, bar_y), (mx + 35 + w_portion, bar_y + 44)], fill=(244, 244, 245))
    draw.rectangle([(mx + 35 + w_portion, bar_y), (mx + 35 + bar_w, bar_y + 44)], fill=(24, 24, 27), outline=(63, 63, 70), width=1)
    
    # Stats Summary Rows
    sy = bar_y + 80
    stats = [
        ("今週のあなたの開拓マス", "148 マス"),
        ("逆転奪還マス", "32 マス"),
        ("週間ランキング", "第 4 位"),
        ("シーズン勝利ボーナス", "+1,000 COIN")
    ]
    for label, val in stats:
        draw.rounded_rectangle([(mx + 30, sy), (mx + mw - 30, sy + 70)], radius=14, fill=(24, 24, 27), outline=(39, 39, 42), width=1)
        draw.text((mx + 50, sy + 22), label, fill=(161, 161, 170), font=font_jp_sm)
        draw.text((mx + mw - 210, sy + 20), val, fill=(255, 255, 255), font=font_jp_md)
        sy += 85
        
    # Share Button
    btn_y = sy + 30
    draw.rounded_rectangle([(mx + 30, btn_y), (mx + mw - 30, btn_y + 80)], radius=20, fill=(255, 255, 255))
    draw.text((mx + mw//2 - 110, btn_y + 24), "X で結果を共有", fill=(0, 0, 0), font=font_jp_lg)

def compose_shop_screen(screen_img, inner_box):
    draw = ImageDraw.Draw(screen_img)
    x1, y1, x2, y2 = inner_box
    sw = x2 - x1
    
    mx = x1 + 36
    my = y1 + 180
    mw = sw - 72
    mh = 1450
    
    draw.rounded_rectangle([(mx, my), (mx + mw, my + mh)], radius=32, fill=(18, 18, 22), outline=(63, 63, 70), width=2)
    
    draw.text((mx + 40, my + 45), "SHOP & TITLES", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 38))
    
    # Tab Row
    ty = my + 110
    tabs = ["獲得", "購入", "テーマ", "称号", "機能"]
    tw = (mw - 60) // 5
    for idx, t in enumerate(tabs):
        tx = mx + 30 + idx * tw
        is_active = (idx == 3) # "称号" active
        fill_c = (245, 158, 11) if is_active else (24, 24, 27)
        text_c = (0, 0, 0) if is_active else (161, 161, 170)
        draw.rounded_rectangle([(tx, ty), (tx + tw - 8, ty + 50)], radius=12, fill=fill_c)
        draw.text((tx + tw//2 - 24, ty + 12), t, fill=text_c, font=font_jp_sm)
        
    # Titles Items List
    iy = ty + 80
    titles_data = [
        ("深夜の徘徊者", "深夜帯に街を歩く孤高のプレイヤー", "1,000 C", False),
        ("ストリートファイター", "歩行バトルを繰り返す歴戦の強者", "3,000 C", True),
        ("ナスカの末裔", "地図上に幾何学の絵を描く者", "8,000 C", False),
        ("テラ・コンクエスター", "地球上の領土を制圧する最高位称号", "9,999,999,999 C", False),
        ("2026-W46 TOP10", "週間ランキング上位入賞者限定刻印", "限定獲得", False),
    ]
    
    for name, desc, price, is_equipped in titles_data:
        draw.rounded_rectangle([(mx + 30, iy), (mx + mw - 30, iy + 120)], radius=16, fill=(24, 24, 27), outline=(39, 39, 42), width=1)
        draw.text((mx + 50, iy + 22), name, fill=(255, 255, 255), font=font_jp_md)
        draw.text((mx + 50, iy + 65), desc, fill=(113, 113, 122), font=ImageFont.truetype(FONT_JP, 18))

        # 金額が長い場合はボタン幅を広げ、フォントを自動縮小してはみ出しを防ぐ
        price_font = ImageFont.truetype(FONT_EN, 20) if price.isascii() else ImageFont.truetype(FONT_JP, 18)
        pb = draw.textbbox((0, 0), price, font=price_font)
        pw = pb[2] - pb[0]
        if pw + 40 > 190:
            price_font = ImageFont.truetype(FONT_EN, 15) if price.isascii() else ImageFont.truetype(FONT_JP, 16)
            pb = draw.textbbox((0, 0), price, font=price_font)
            pw = pb[2] - pb[0]
        btn_w = max(140, pw + 40)
        btn_x = mx + mw - 30 - btn_w - 20
        btn_y = iy + 35
        if is_equipped:
            draw.rounded_rectangle([(btn_x, btn_y), (btn_x + btn_w, btn_y + 50)], radius=12, fill=(34, 197, 94))
            draw.text((btn_x + 32, btn_y + 12), "装備中", fill=(255, 255, 255), font=font_jp_sm)
        else:
            draw.rounded_rectangle([(btn_x, btn_y), (btn_x + btn_w, btn_y + 50)], radius=12, fill=(39, 39, 42))
            ph = pb[3] - pb[1]
            draw.text((btn_x + (btn_w - pw) // 2, btn_y + (50 - ph) // 2 - pb[1]), price, fill=(245, 158, 11), font=price_font)
            
        iy += 138

def compose_pocket_screen(screen_img, inner_box):
    draw = ImageDraw.Draw(screen_img)
    x1, y1, x2, y2 = inner_box
    sw = x2 - x1
    
    mx = x1 + 36
    my = y1 + 180
    mw = sw - 72
    mh = 1450
    
    draw.rounded_rectangle([(mx, my), (mx + mw, my + mh)], radius=32, fill=(18, 18, 22), outline=(63, 63, 70), width=2)
    
    draw.text((mx + 40, my + 45), "POCKET & RULES", fill=(255, 255, 255), font=ImageFont.truetype(FONT_EN, 38))
    draw.text((mx + 40, my + 95), "バックグラウンド歩行とゲーム仕様", fill=(161, 161, 170), font=font_jp_md)
    
    features = [
        ("● 画面消灯でも自動開拓", "アプリを閉じてポケットに入れたままでも、約100mマスを自動で測位・自陣色へ塗り替えます。"),
        ("● 完全公正な実力勝負", "課金による移動速度アップや範囲拡大は一切なし。歩いた距離と戦略だけで競い合うストイックルール。"),
        ("● 省電力＆オフライン耐性", "電波が一時的に途切れても歩行ログを端末内に安全保持。復帰時にまとめて陣地へ反映されます。"),
        ("● プライバシー完全保護", "あなたの正確な自宅住所や移動軌跡は非公開。陣地マスのみが白黒で共有されます。")
    ]
    
    fy = my + 160
    for title, desc in features:
        draw.rounded_rectangle([(mx + 30, fy), (mx + mw - 30, fy + 170)], radius=18, fill=(24, 24, 27), outline=(39, 39, 42), width=1)
        draw.text((mx + 50, fy + 24), title, fill=(16, 185, 129), font=font_jp_md)
        
        chars_per_line = 24
        desc_lines = [desc[i:i+chars_per_line] for i in range(0, len(desc), chars_per_line)]
        dy = fy + 70
        for l in desc_lines[:3]:
            draw.text((mx + 50, dy), l, fill=(161, 161, 170), font=ImageFont.truetype(FONT_JP, 20))
            dy += 30
            
        fy += 190

def main():
    print(f"[Screenshot Generator] Target resolution: {WIDTH}x{HEIGHT} (6.7-inch display)")
    for item in SCREENSHOTS:
        print(f"[Screenshot Generator] Generating: {item['file']} ({item['title']})...")
        img, draw = create_base_canvas()
        draw_header(draw, item)
        inner_box = draw_phone_frame(img, draw)
        
        stype = item['screen_type']
        if stype == 'main':
            compose_main_screen(img, inner_box)
        elif stype == 'season':
            compose_season_screen(img, inner_box)
        elif stype == 'shop':
            compose_shop_screen(img, inner_box)
        elif stype == 'pocket':
            compose_pocket_screen(img, inner_box)
            
        out_path = os.path.join(OUT_DIR, item['file'])
        img.save(out_path, format='PNG', optimize=True)
        print(f"[Screenshot Generator] Saved: {out_path}")
        
    print("[Screenshot Generator] All 4 App Store screenshots successfully generated!")

if __name__ == '__main__':
    main()
