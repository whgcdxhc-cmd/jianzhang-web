from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 1200, 630
canvas = Image.new("RGB", (WIDTH, HEIGHT), "#12151b")
pixels = canvas.load()
for y in range(HEIGHT):
    for x in range(WIDTH):
        glow = max(0, 1 - (((x - 930) / 720) ** 2 + ((y - 100) / 620) ** 2))
        pixels[x, y] = (
            int(18 + 20 * glow),
            int(21 + 25 * glow),
            int(27 + 36 * glow),
        )

icon = Image.open(ROOT / "public" / "icons" / "icon-512.png").convert("RGB")
icon = icon.resize((280, 280), Image.Resampling.LANCZOS)
canvas.paste(icon, (770, 175))

font_path = Path("C:/Windows/Fonts/msyh.ttc")
font_bold_path = Path("C:/Windows/Fonts/msyhbd.ttc")
title_font = ImageFont.truetype(str(font_bold_path if font_bold_path.exists() else font_path), 112)
subtitle_font = ImageFont.truetype(str(font_path), 38)
caption_font = ImageFont.truetype(str(font_path), 26)
draw = ImageDraw.Draw(canvas)
draw.text((100, 150), "简账", font=title_font, fill="#ffffff")
draw.rounded_rectangle((104, 292, 198, 302), radius=5, fill="#e84e55")
draw.text((100, 337), "极速记录 · 自动记账", font=subtitle_font, fill="#e7e9ed")
draw.text((100, 410), "生活时间轴 · 搜索分析", font=subtitle_font, fill="#b7bec9")
draw.text((103, 526), "轻量、可编辑、离线可用", font=caption_font, fill="#858e9b")
canvas.save(ROOT / "public" / "og.png", optimize=True)
