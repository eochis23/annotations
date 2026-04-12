#!/usr/bin/env python3
"""Generate prev.raw / cur.raw with known shift for native/anno-motion."""
import os
import random
import subprocess
import sys

W, H = 64, 48
TRUE_DX, TRUE_DY = 5, -2


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    exe = os.path.join(root, "build", "anno-motion")
    if not os.path.isfile(exe):
        print("run: meson setup build && meson compile -C build", file=sys.stderr)
        sys.exit(1)

    rng = random.Random(42)
    prev = bytes(rng.randint(0, 255) for _ in range(W * H))
    cur = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            xs, ys = x - TRUE_DX, y - TRUE_DY
            if 0 <= xs < W and 0 <= ys < H:
                cur[y * W + x] = prev[ys * W + xs]
            else:
                cur[y * W + x] = prev[y * W + x]

    td = os.path.join(root, "build", "motion-test-tmp")
    os.makedirs(td, exist_ok=True)
    pp = os.path.join(td, "prev.raw")
    cp = os.path.join(td, "cur.raw")
    with open(pp, "wb") as f:
        f.write(prev)
    with open(cp, "wb") as f:
        f.write(cur)

    out = subprocess.check_output([exe, str(W), str(H), pp, cp], text=True).strip()
    print(out)
    import json

    j = json.loads(out)
    if abs(j["dx"] - TRUE_DX) > 1 or abs(j["dy"] - TRUE_DY) > 1:
        sys.exit(f"shift mismatch: got {j} expected dx={TRUE_DX} dy={TRUE_DY}")
    print("ok")


if __name__ == "__main__":
    main()
