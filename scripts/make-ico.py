"""把一张 PNG 转成多尺寸 Windows ICO（纯标准库，无 Pillow）。

## 为什么自己写而不装 Pillow

只为构建期转一次图标引入一个几十 MB 的图像库不值得；PNG 的解码/编码
用 zlib + struct 就能做，尺寸也只有图标需要的几种。这个脚本只服务
`apps/desktop/resources/icon.ico` 的生成，跑一次就完事。

## ICO 结构

ICONDIR(6B) + N × ICONDIRENTRY(16B) + N × 图像数据。
Vista 起每个条目可以直接内嵌 **PNG**（无需展开成 BMP 像素），
所以我们只需：解码源 PNG → 最近邻缩放到各尺寸 → 重新编码 PNG → 拼容器。

用法：
    python make-ico.py <源.png> <输出.ico>
"""

from __future__ import annotations

import struct
import sys
import zlib

SIZES = (256, 128, 64, 48, 32, 16)


# ---------------------------------------------------------------------------
# PNG 解码（够用即可：8bit、RGB/RGBA、非交错）
# ---------------------------------------------------------------------------


def read_png(data: bytes) -> tuple[int, int, list[list[tuple[int, int, int, int]]]]:
    """返回 (width, height, 像素二维数组 RGBA)。只支持 8bit RGB/RGBA 非交错。"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG 文件")

    pos = 8
    width = height = 0
    bit_depth = color_type = interlace = 0
    idat = b""
    palette: list[tuple[int, int, int]] = []
    trns = b""

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length

        if ctype == b"IHDR":
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif ctype == b"PLTE":
            palette = [tuple(chunk[i : i + 3]) for i in range(0, len(chunk), 3)]
        elif ctype == b"tRNS":
            trns = chunk
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break

    if bit_depth != 8 or interlace != 0:
        raise ValueError(f"不支持的 PNG：bit_depth={bit_depth} interlace={interlace}")
    if color_type not in (2, 6, 3):
        raise ValueError(f"不支持的色彩类型：{color_type}（要 RGB/RGBA/调色板）")

    channels = {2: 3, 6: 4, 3: 1}[color_type]
    raw = zlib.decompress(idat)
    stride = width * channels

    # 逐行解滤波（PNG 的 5 种滤波，见 RFC 2083）
    rows: list[bytearray] = []
    prev = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset : offset + stride])
        offset += stride
        if filter_type == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x: int, y: int) -> tuple[int, int, int, int]:
        # rows[y] 已经是第 y 行的数据，行内偏移只需乘 x
        o = x * channels
        if color_type == 6:
            return (rows[y][o], rows[y][o + 1], rows[y][o + 2], rows[y][o + 3])
        if color_type == 2:
            return (rows[y][o], rows[y][o + 1], rows[y][o + 2], 255)
        idx = rows[y][o]
        alpha = trns[idx] if idx < len(trns) else 255
        return (*palette[idx], alpha)

    pixels = [[px(x, y) for x in range(width)] for y in range(height)]
    return width, height, pixels


# ---------------------------------------------------------------------------
# 缩放（最近邻 —— 图标这种高对比扁平图，最近邻与双线性肉眼几乎无差）
# ---------------------------------------------------------------------------


def resize(
    pixels: list[list[tuple[int, int, int, int]]], w: int, h: int, size: int
) -> list[list[tuple[int, int, int, int]]]:
    return [
        [pixels[int(y * h / size)][int(x * w / size)] for x in range(size)]
        for y in range(size)
    ]


# ---------------------------------------------------------------------------
# PNG 编码（RGBA 8bit）
# ---------------------------------------------------------------------------


def write_png(pixels: list[list[tuple[int, int, int, int]]], size: int) -> bytes:
    stride = size * 4
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: None
        for x in range(size):
            r, g, b, a = pixels[y][x]
            raw += bytes((r, g, b, a))

    def chunk(ctype: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------------------
# ICO 容器
# ---------------------------------------------------------------------------


def build_ico(pngs: list[tuple[int, bytes]]) -> bytes:
    # ICONDIRENTRY：width/height 256 用 0 表示
    entries = b""
    offset = 6 + 16 * len(pngs)
    for size, png in pngs:
        b_or_zero = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", b_or_zero, b_or_zero, 0, 0, 1, 32, len(png), offset
        )
        offset += len(png)
    header = struct.pack("<HHH", 0, 1, len(pngs))
    return header + entries + b"".join(png for _, png in pngs)


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("用法: python make-ico.py <源.png> <输出.ico>\n")
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        data = f.read()
    width, height, pixels = read_png(data)
    pngs = [(size, write_png(resize(pixels, width, height, size), size)) for size in SIZES]
    with open(dst, "wb") as f:
        f.write(build_ico(pngs))
    print(f"已生成 {dst}（{len(SIZES)} 个尺寸，源 {width}x{height}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
