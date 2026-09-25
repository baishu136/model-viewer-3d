"""生成应用图标：白色背景 + 蓝色 3D 立方体 + 网格线。"""
from PIL import Image, ImageDraw


def make_icon(size):
    img = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    s = size
    # 背景圆角方块
    m = int(s * 0.05)
    d.rounded_rectangle([m, m, s - m, s - m], radius=int(s * 0.2), fill=(255, 255, 255, 255))
    # 立方体三个面
    cx, cy = s * 0.5, s * 0.5
    hw = s * 0.28  # 半宽
    hh = s * 0.16  # 半高偏移
    # 顶面（浅蓝）
    d.polygon(
        [(cx - hw, cy - hh), (cx, cy - hw * 0.75), (cx + hw, cy - hh), (cx, cy + hh * 0.7)],
        fill=(59, 130, 246, 255),
    )
    # 左面（中蓝）
    d.polygon(
        [(cx - hw, cy - hh), (cx, cy + hh * 0.7), (cx, cy + hh * 0.7 + hw * 0.8), (cx - hw, cy + hw * 0.85)],
        fill=(37, 99, 235, 255),
    )
    # 右面（深蓝）
    d.polygon(
        [(cx + hw, cy - hh), (cx, cy + hh * 0.7), (cx, cy + hh * 0.7 + hw * 0.8), (cx + hw, cy + hw * 0.85)],
        fill=(29, 78, 216, 255),
    )
    return img


def main():
    import os

    out = os.path.join(os.path.dirname(__file__), "..", "resources", "icon.ico")
    # electron-builder 要求 ICO 主图为 256x256；保存为多尺寸 ICO，主图 256
    img256 = make_icon(256)
    img256.save(out, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    # 同时生成 png 供 electron-builder 使用
    png = os.path.join(os.path.dirname(__file__), "..", "resources", "icon.png")
    make_icon(512).save(png, format="PNG")
    print(f"图标已生成: {out}, {png}")


if __name__ == "__main__":
    main()
