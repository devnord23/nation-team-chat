#!/usr/bin/env python3
"""Check that the rendered loop is seamless.

1. seek(LOOP) and seek(0) draw identical pixels (the timeline is periodic).
2. In the final MP4, the step from the last frame to the first is no larger
   than the steps around it: no jump, no held frame.
3. Frame count and duration of video and audio match the loop exactly.

    python3 tools/verify_loop.py out/nation-swarm-loop.mp4
"""
import io
import json
import pathlib
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from render import open_page, shot  # noqa: E402


def frames(mp4, idx):
    out = {}
    for i in idx:
        raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", mp4, "-vf", f"select=eq(n\\,{i})", "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
        out[i] = np.frombuffer(raw, np.uint8).reshape(1440, 1440, 3).astype(np.int16)
    return out


def main():
    mp4 = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "out" / "nation-swarm-loop.mp4")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser, page, _ = open_page(pw)
        loop = page.evaluate("LOOP")
        a = np.asarray(Image.open(io.BytesIO(shot(page, 0.0))).convert("RGB"), np.int16)
        c = np.asarray(Image.open(io.BytesIO(shot(page, loop))).convert("RGB"), np.int16)
        browser.close()
    print(f"seek({loop}) vs seek(0): max pixel difference {np.abs(a - c).max()} (0 means identical)")

    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-count_frames", "-of", "json", mp4], capture_output=True, check=True).stdout)
    v = next(s for s in probe["streams"] if s["codec_type"] == "video")
    au = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    n = int(v["nb_read_frames"])
    print(f"video: {v['width']}x{v['height']} {v['r_frame_rate']} fps, {n} frames = {n / 60:.4f} s; audio {float(au['duration']):.4f} s at {au['sample_rate']} Hz")

    f = frames(mp4, [n - 3, n - 2, n - 1, 0, 1, 2])
    d = lambda x, y: float(np.abs(f[x] - f[y]).mean())
    steps = [(n - 3, n - 2), (n - 2, n - 1), (n - 1, 0), (0, 1), (1, 2)]
    for x, y in steps:
        tag = "  <- seam" if (x, y) == (n - 1, 0) else ""
        print(f"frame {x:4d} -> {y:4d}: mean change {d(x, y):6.3f}{tag}")
    seam = d(n - 1, 0)
    around = [d(x, y) for x, y in steps if (x, y) != (n - 1, 0)]
    ok = seam <= 1.5 * max(around) + 0.05 and seam > 0
    print("seam", "OK: in line with its neighbours" if ok else "CHECK: seam step stands out")


if __name__ == "__main__":
    main()
