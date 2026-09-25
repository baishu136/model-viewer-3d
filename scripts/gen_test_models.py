"""生成测试模型：立方体 STL/OBJ，用于功能验证。"""
import struct
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "testdata")
os.makedirs(OUT, exist_ok=True)


def cube_verts(size=10.0):
    """返回一个 10mm 立方体的 12 个三角形（36 顶点），尺寸 xyz = [10,20,30] 故意不对称以验证尺寸显示。"""
    sx, sy, sz = 10.0, 20.0, 30.0
    x, y, z = sx / 2, sy / 2, sz / 2
    # 8 个角点
    v = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    # 6 个面，每个 2 三角形（CCW 朝外）
    faces = [
        (0, 1, 2), (0, 2, 3),  # back  (-z)
        (5, 4, 7), (5, 7, 6),  # front (+z)
        (1, 5, 6), (1, 6, 2),  # right (+x)
        (4, 0, 3), (4, 3, 7),  # left  (-x)
        (3, 2, 6), (3, 6, 7),  # top   (+y)
        (4, 5, 1), (4, 1, 0),  # bottom(-y)
    ]
    tris = []
    for f in faces:
        tris.append([v[f[0]], v[f[1]], v[f[2]]])
    return tris


def write_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"binary cube model" + b"\x00" * (80 - 17))
        f.write(struct.pack("<I", len(tris)))
        for tri in tris:
            # 计算法线（简化）
            f.write(struct.pack("<fff", 0.0, 0.0, 1.0))
            for v in tri:
                f.write(struct.pack("<fff", *v))
            f.write(struct.pack("<H", 0))
    print(f"STL written: {path} ({len(tris)} tris)")


def write_obj(path, tris):
    lines = ["# test cube OBJ"]
    verts = []
    for tri in tris:
        for v in tri:
            lines.append(f"v {v[0]} {v[1]} {v[2]}")
    for i in range(0, len(tris) * 3, 3):
        lines.append(f"f {i+1} {i+2} {i+3}")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"OBJ written: {path}")


if __name__ == "__main__":
    tris = cube_verts()
    write_stl(os.path.join(OUT, "cube.stl"), tris)
    write_obj(os.path.join(OUT, "cube.obj"), tris)
