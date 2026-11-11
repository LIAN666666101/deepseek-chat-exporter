#!/usr/bin/env python3
"""生成扩展图标（纯标准库实现，不依赖 Pillow / 网络）。

画法：4 倍超采样 + 降采样抗锯齿。
图案：DeepSeek 蓝底圆角方块 + 白色「导出/下载」箭头 + 底部文档基线。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SS = 4  # 超采样倍数

BG_TOP = (77, 107, 254)    # #4D6BFE
BG_BOTTOM = (108, 92, 255)  # #6C5CFF
FG = (255, 255, 255)


def rounded_rect_alpha(x, y, w, h, r, px, py):
    """点 (px, py) 是否落在圆角矩形内（像素中心采样）。"""
    if px < x or px > x + w or py < y or py > y + h:
        return False
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy <= r * r


def triangle_alpha(x0, x1, ytop, ybottom, px, py):
    if py < ytop or py > ybottom:
        return False
    t = (py - ytop) / max(1e-6, (ybottom - ytop))
    half = (x1 - x0) / 2.0 * (1.0 - t)
    cx = (x0 + x1) / 2.0
    return abs(px - cx) <= half


def render(size):
    n = size * SS
    buf = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]

    radius = n * 0.23
    # 箭头几何
    stem_w = n * 0.115
    stem_x0 = (n - stem_w) / 2.0
    stem_x1 = stem_x0 + stem_w
    stem_y0 = n * 0.24
    stem_y1 = n * 0.60
    head_y0 = n * 0.545
    head_y1 = n * 0.775
    head_x0 = n * 0.295
    head_x1 = n * 0.705
    # 底部基线（代表「文档」）
    bar_y0 = n * 0.845
    bar_y1 = n * 0.912
    bar_x0 = n * 0.27
    bar_x1 = n * 0.73

    for py in range(n):
        for px in range(n):
            cx = px + 0.5
            cy = py + 0.5
            if not rounded_rect_alpha(0, 0, n, n, radius, cx, cy):
                continue
            t = cy / n
            r = int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
            g = int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
            b = int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
            buf[py][px] = (r, g, b, 255)

    for py in range(n):
        for px in range(n):
            cx = px + 0.5
            cy = py + 0.5
            hit = False
            if stem_x0 <= cx <= stem_x1 and stem_y0 <= cy <= stem_y1:
                hit = True
            if triangle_alpha(head_x0, head_x1, head_y0, head_y1, cx, cy):
                hit = True
            if rounded_rect_alpha(bar_x0, bar_y0, bar_x1 - bar_x0, bar_y1 - bar_y0,
                                  (bar_y1 - bar_y0) / 2.0, cx, cy):
                hit = True
            if hit:
                buf[py][px] = (FG[0], FG[1], FG[2], 255)

    # 降采样
    out = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    p = buf[y * SS + dy][x * SS + dx]
                    # 预乘 alpha 再平均，避免边缘发灰
                    a = p[3] / 255.0
                    acc[0] += p[0] * a
                    acc[1] += p[1] * a
                    acc[2] += p[2] * a
                    acc[3] += p[3]
            cnt = SS * SS
            a = acc[3] / cnt
            if a <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                sa = a / 255.0
                row += bytes((
                    min(255, int(round(acc[0] / cnt / sa))),
                    min(255, int(round(acc[1] / cnt / sa))),
                    min(255, int(round(acc[2] / cnt / sa))),
                    int(round(a)),
                ))
        out.append(bytes(row))
    return out


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        rows = render(size)
        out = os.path.join(OUT_DIR, "icon%d.png" % size)
        write_png(out, size, rows)
        print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
