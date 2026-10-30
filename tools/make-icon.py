#!/usr/bin/env python3
"""生成 MinePilot 应用图标（深色底板 + 等距草方块 + 蓝色启动面）。"""

from PIL import Image, ImageChops, ImageDraw, ImageFilter
import io
import math
import os
import random
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")

DARK = (6, 13, 27, 255)
GREEN_TOP = (126, 224, 91, 255)
GREEN_TOP_DARK = (62, 166, 59, 255)
GREEN_STRIP = (83, 185, 66, 255)
DIRT_TOP = (157, 104, 60, 255)
DIRT_BOTTOM = (105, 65, 35, 255)
BLUE_TOP = (83, 151, 255, 255)
BLUE_BOTTOM = (28, 72, 188, 255)
WHITE = (245, 251, 255, 255)

# 1024 设计坐标
TOP = [(512, 248), (842, 413), (512, 578), (182, 413)]
LEFT = [(182, 413), (512, 578), (512, 864), (182, 699)]
RIGHT = [(512, 578), (842, 413), (842, 699), (512, 864)]
PLAY = [(552, 582), (552, 804), (758, 693)]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(4))


def vertical_gradient(size, top, bottom):
    img = Image.new("RGBA", (1, size))
    px = img.load()
    for y in range(size):
        px[0, y] = lerp(top, bottom, y / max(1, size - 1))
    return img.resize((size, size))


def polygon_mask(size, points):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def fill_polygon(img, points, top, bottom):
    mask = polygon_mask(img.width, points)
    img.paste(vertical_gradient(img.width, top, bottom), (0, 0), mask)


def add_texture(img, mask, count, color, alpha, min_size, max_size, rng, detail=True):
    if not detail:
        return
    over = Image.new("RGBA", (img.width, img.height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(over)
    for _ in range(count):
        x = rng.randrange(0, img.width)
        y = rng.randrange(0, img.height)
        if mask.getpixel((x, y)) < 200:
            continue
        w = rng.randrange(min_size, max_size + 1)
        h = rng.randrange(min_size, max_size + 1)
        c = (color[0], color[1], color[2], alpha)
        draw.rectangle([x, y, x + w, y + h], fill=c)
    a = ImageChops.multiply(over.getchannel("A"), mask)
    over.putalpha(a)
    img.alpha_composite(over)


def draw_block(img, detail, u):
    w = img.width
    d = ImageDraw.Draw(img)
    rng = random.Random(20261029)

    def scaled(points):
        return [(x * u, y * u) for x, y in points]

    top = scaled(TOP)
    left = scaled(LEFT)
    right = scaled(RIGHT)

    # 方块落影
    shadow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        [int(190 * u), int(810 * u), int(834 * u), int(930 * u)],
        fill=(0, 0, 0, 165),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, 34 * u)))
    img.alpha_composite(shadow)

    # 三个面
    fill_polygon(img, top, (151, 240, 107, 255), GREEN_TOP_DARK)
    fill_polygon(img, left, DIRT_TOP, DIRT_BOTTOM)
    fill_polygon(img, right, BLUE_TOP, BLUE_BOTTOM)

    top_mask = polygon_mask(w, top)
    left_mask = polygon_mask(w, left)
    right_mask = polygon_mask(w, right)

    # 草方块顶面的像素草色
    add_texture(img, top_mask, 150, (54, 145, 50), 70,
                max(1, int(6 * u)), max(2, int(24 * u)), rng, detail)
    add_texture(img, top_mask, 100, (190, 255, 148), 60,
                max(1, int(4 * u)), max(2, int(16 * u)), rng, detail)
    # 泥土面的颗粒
    add_texture(img, left_mask, 130, (60, 36, 18), 80,
                max(1, int(5 * u)), max(2, int(19 * u)), rng, detail)
    add_texture(img, left_mask, 90, (210, 158, 104), 55,
                max(1, int(3 * u)), max(2, int(12 * u)), rng, detail)
    # 蓝色启动面的一点点高光，保持干净
    if detail:
        sheen = Image.new("RGBA", (w, w), (0, 0, 0, 0))
        ImageDraw.Draw(sheen).polygon(
            [(int(512 * u), int(578 * u)), (int(842 * u), int(413 * u)),
             (int(742 * u), int(478 * u)), (int(512 * u), int(640 * u))],
            fill=(190, 225, 255, 28),
        )
        img.alpha_composite(sheen)

    # 草皮侧面：顶边下方的一圈绿色，带一点锯齿
    strips = [
        # (方向, 顶边起点, 顶边终点, 底边起点, 底边终点, 底部 x 范围)
        ("left", (182, 413), (512, 578), (512, 608), (182, 443), (512, 182)),
        ("right", (512, 578), (842, 413), (842, 443), (512, 608), (842, 512)),
    ]
    for _side, top_start, top_end, bottom_start, bottom_end, x_range in strips:
        x_high, x_low = x_range
        pts = [top_start, top_end]
        step = max(8, int(22 * u))
        for x in range(x_high, x_low, -step):
            t = (x - x_high) / (x_low - x_high)
            y = bottom_start[1] + (bottom_end[1] - bottom_start[1]) * t
            jag = (0 if not detail else rng.randrange(0, 18)) * u
            pts.append((x, y + jag / u))
        pts = scaled(pts)
        strip = Image.new("L", (w, w), 0)
        ImageDraw.Draw(strip).polygon(pts, fill=255)
        strip = ImageChops.multiply(strip, left_mask if _side == "left" else right_mask)
        strip_color = Image.new("RGBA", (w, w), (74, 174, 56, 255))
        img.paste(strip_color, (0, 0), strip)
        if detail:
            add_texture(img, strip, 55, (37, 121, 37), 80,
                        max(1, int(4 * u)), max(2, int(14 * u)), rng, detail)

    # 描边和轮廓高光
    lw = max(2, round(13 * u))
    for poly in (top, left, right):
        d.polygon(poly, outline=DARK, width=lw)
    d.line([(182 * u, 413 * u), (512 * u, 248 * u), (842 * u, 413 * u)],
           fill=(218, 255, 190, 170), width=max(1, round(4 * u)), joint="curve")
    d.line([(182 * u, 413 * u), (512 * u, 578 * u)],
           fill=(218, 255, 190, 110), width=max(1, round(3 * u)))

    # 启动面：白色播放三角
    play = [(x * u, y * u) for x, y in PLAY]
    if detail:
        glow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
        ImageDraw.Draw(glow).polygon(play, fill=(96, 190, 255, 95))
        glow = glow.filter(ImageFilter.GaussianBlur(max(2, 18 * u)))
        img.alpha_composite(glow)
    offset = (10 * u, 12 * u)
    d.polygon([(x + offset[0], y + offset[1]) for x, y in play], fill=(5, 20, 54, 210))
    d.polygon(play, fill=WHITE, outline=(205, 235, 255, 255),
              width=max(1, round(3 * u)))
    # 三角底部一层很浅的蓝，增加一点体积
    if detail:
        d.polygon(
            [(552 * u, 754 * u), (552 * u, 804 * u), (758 * u, 693 * u)],
            fill=(218, 236, 255, 255),
        )


def render(size, detail=True):
    scale = 4 if size <= 256 else 2
    w = size * scale
    u = w / 1024.0

    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    # 圆角底板外阴影
    shadow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [int(48 * u), int(60 * u), int(976 * u), int(988 * u)],
        radius=int(210 * u), fill=(0, 0, 0, 170),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, 36 * u)))
    img.alpha_composite(shadow)

    # 底板渐变
    plate = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    plate_mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(plate_mask).rounded_rectangle(
        [int(48 * u), int(48 * u), int(976 * u), int(976 * u)],
        radius=int(210 * u), fill=255,
    )
    plate.paste(vertical_gradient(w, (32, 50, 82, 255), (7, 12, 23, 255)), (0, 0), plate_mask)

    # 底板内的蓝色光晕
    glow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [int(150 * u), int(130 * u), int(874 * u), int(854 * u)],
        fill=(47, 119, 235, 52),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(max(2, 130 * u)))
    plate.alpha_composite(glow)

    # 内边框
    ImageDraw.Draw(plate).rounded_rectangle(
        [int(52 * u), int(52 * u), int(972 * u), int(972 * u)],
        radius=int(206 * u), outline=(128, 174, 255, 58), width=max(1, round(3 * u)),
    )
    ImageDraw.Draw(plate).rounded_rectangle(
        [int(62 * u), int(62 * u), int(962 * u), int(962 * u)],
        radius=int(198 * u), outline=(255, 255, 255, 12), width=max(1, round(2 * u)),
    )

    img.alpha_composite(plate)
    draw_block(img, detail, u)
    return img.resize((size, size), Image.LANCZOS)


def save_ico(path, sizes):
    frames = []
    for size in sizes:
        img = render(size, detail=size >= 48)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        frames.append((size, buf.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(frames))
    entries = b""
    offset = 6 + 16 * len(frames)
    for size, data in frames:
        width = 0 if size >= 256 else size
        height = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(header + entries + b"".join(data for _, data in frames))


def main():
    os.makedirs(ASSETS, exist_ok=True)
    master = render(1024, detail=True)
    master.save(os.path.join(ASSETS, "icon.png"), "PNG", optimize=True)
    save_ico(os.path.join(ASSETS, "MinePilot.ico"), [16, 24, 32, 48, 64, 128, 256])

    # 供网页 favicon 使用
    favicon = render(64, detail=True)
    favicon.save(os.path.join(ASSETS, "favicon.png"), "PNG", optimize=True)

    print("icon.png", master.size)
    print("MinePilot.ico", "16/24/32/48/64/128/256")
    print("favicon.png", favicon.size)


if __name__ == "__main__":
    main()