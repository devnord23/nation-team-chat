#!/usr/bin/env python3
"""Render nation-swarm.html with Playwright.

  stills  python3 tools/render.py stills 0 0.5 1.25 --out out/stills
  sheet   python3 tools/render.py sheet --out out/review-sheet.png     one still per beat, 8 bars x 4 beats
  video   python3 tools/render.py video --out out/frames.mkv           60 fps, 4 temporal subframes per frame
  final   python3 tools/render.py final                                 mux with out/audio_loop.wav into the MP4

Every frame is drawn by the page's seek(t): nothing depends on wall-clock time.
Video mode renders subframes at 240 fps (centred on each output frame) and
lets ffmpeg's tmix average each group of four, then keeps one frame in four.
Workers render contiguous chunks in parallel and the chunks are concatenated.
"""
import argparse
import io
import json
import math
import os
import pathlib
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "nation-swarm.html"
SIZE = 1440
CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


def open_page(pw):
    kw = {"args": ["--disable-gpu", "--font-render-hinting=none", "--disable-lcd-text"]}
    if os.path.exists(CHROME):
        kw["executable_path"] = CHROME
    browser = pw.chromium.launch(**kw)
    page = browser.new_page(viewport={"width": SIZE, "height": SIZE}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(HTML.as_uri() + "?render")
    page.wait_for_function("window.ready !== undefined")
    page.evaluate("window.ready")
    if errors:
        raise SystemExit("page error: " + errors[0])
    return browser, page, errors


def shot(page, t):
    page.evaluate(f"seek({t!r})")
    return page.screenshot(type="png", clip={"x": 0, "y": 0, "width": SIZE, "height": SIZE}, animations="disabled")


def cmd_stills(a):
    from playwright.sync_api import sync_playwright

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser, page, errors = open_page(pw)
        for t in a.times:
            path = out / f"t{float(t):07.3f}.png"
            path.write_bytes(shot(page, float(t)))
            print(path)
        if errors:
            print("page errors:", errors, file=sys.stderr)
        browser.close()


def cmd_sheet(a):
    from PIL import Image, ImageDraw, ImageFont
    from playwright.sync_api import sync_playwright

    grid = json.loads((ROOT / "out" / "beats.json").read_text())["grid"] if (ROOT / "out" / "beats.json").exists() else {"period": 0.5, "offset": 0, "beats": 32}
    beats = grid["beats"]
    cols, rows, cell, pad, head = 4, beats // 4, a.cell, 18, 44
    sheet = Image.new("RGB", (cols * cell + (cols + 1) * pad, rows * (cell + head) + (rows + 1) * pad), (228, 226, 220))
    draw = ImageDraw.Draw(sheet)
    fdir = "/usr/share/fonts/truetype/dejavu/"
    font = ImageFont.truetype(fdir + "DejaVuSans.ttf", 22)
    bold = ImageFont.truetype(fdir + "DejaVuSans-Bold.ttf", 22)
    labels = a.labels.split("|") if a.labels else [""] * beats
    stills_dir = ROOT / "out" / "beats"
    stills_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser, page, errors = open_page(pw)
        for k in range(beats):
            t = grid["offset"] + k * grid["period"] + a.at * grid["period"]
            png = shot(page, t)
            (stills_dir / f"beat{k + 1:02d}.png").write_bytes(png)
            im = Image.open(io.BytesIO(png)).convert("RGB").resize((cell, cell), Image.LANCZOS)
            r, c = divmod(k, cols)
            x, y = pad + c * (cell + pad), pad + r * (cell + head + pad)
            draw.text((x, y + 10), f"{k + 1}", font=bold, fill=(10, 12, 10))
            draw.text((x + 44, y + 10), f"{t:5.2f}s  {labels[k] if k < len(labels) else ''}", font=font, fill=(60, 62, 58))
            sheet.paste(im, (x, y + head))
        browser.close()
    sheet.save(a.out)
    print("wrote", a.out, sheet.size)


def render_chunk(args):
    """Render output frames [f0, f1) as 4 subframes each and encode with tmix."""
    f0, f1, fps, sub, part, loop = args
    from PIL import Image
    from playwright.sync_api import sync_playwright

    shutter = 0.75  # fraction of the frame interval the subframes span (a 270 degree shutter)
    enc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{SIZE}x{SIZE}", "-r", str(fps * sub), "-i", "-",
         "-vf", f"tmix=frames={sub}:weights=" + "'" + " ".join(["1"] * sub) + "'" + f",select='not(mod(n+1\\,{sub}))',setpts=N/({fps}*TB)",
         "-r", str(fps), "-c:v", "libx264", "-preset", "medium", "-qp", "0", "-pix_fmt", "yuv444p", str(part)],
        stdin=subprocess.PIPE,
    )
    with sync_playwright() as pw:
        browser, page, errors = open_page(pw)
        for f in range(f0, f1):
            if (f - f0) % 60 == 0:
                print(f"{part.name}: frame {f - f0}/{f1 - f0}", flush=True)
            for s in range(sub):
                t = (f + ((s + 0.5) / sub - 0.5) * shutter) / fps
                png = shot(page, t % loop)
                enc.stdin.write(Image.open(io.BytesIO(png)).convert("RGB").tobytes())
        browser.close()
    enc.stdin.close()
    if enc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed for {part}")
    return str(part)


def cmd_video(a):
    loop = a.loop
    frames = round(loop * a.fps)
    workers = a.workers
    step = math.ceil(frames / workers)
    tmp = ROOT / "out" / "parts"
    tmp.mkdir(parents=True, exist_ok=True)
    jobs = [(i, min(i + step, frames), a.fps, a.sub, tmp / f"part{k:02d}.mkv", loop) for k, i in enumerate(range(0, frames, step))]
    with ProcessPoolExecutor(workers) as ex:
        parts = list(ex.map(render_chunk, jobs))
    lst = tmp / "parts.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", a.out], check=True)
    print("wrote", a.out, frames, "frames")


def cmd_final(a):
    """Encode the delivery file: H.264 High 4:2:0 at 60 fps with the mixed loop audio."""
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", a.video, "-i", a.audio,
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", str(a.crf), "-profile:v", "high",
        "-pix_fmt", "yuv420p", "-r", "60", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-shortest", "-movflags", "+faststart", a.out,
    ], check=True)
    print("wrote", a.out)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("stills")
    s.add_argument("times", nargs="+")
    s.add_argument("--out", default=str(ROOT / "out" / "stills"))
    h = sp.add_parser("sheet")
    h.add_argument("--out", default=str(ROOT / "out" / "review-sheet.png"))
    h.add_argument("--at", type=float, default=0.8, help="where in each beat to sample, as a fraction of the beat")
    h.add_argument("--cell", type=int, default=440)
    h.add_argument("--labels", default="")
    v = sp.add_parser("video")
    v.add_argument("--out", default=str(ROOT / "out" / "frames.mkv"))
    v.add_argument("--fps", type=int, default=60)
    v.add_argument("--sub", type=int, default=4)
    v.add_argument("--loop", type=float, default=16.0)
    v.add_argument("--workers", type=int, default=4)
    f = sp.add_parser("final")
    f.add_argument("--video", default=str(ROOT / "out" / "frames.mkv"))
    f.add_argument("--audio", default=str(ROOT / "out" / "audio_loop.wav"))
    f.add_argument("--crf", type=int, default=14)
    f.add_argument("--out", default=str(ROOT / "out" / "nation-swarm-loop.mp4"))
    a = ap.parse_args()
    {"stills": cmd_stills, "sheet": cmd_sheet, "video": cmd_video, "final": cmd_final}[a.cmd](a)


if __name__ == "__main__":
    main()
