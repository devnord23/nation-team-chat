#!/usr/bin/env python3
"""Assemble the single-file animation: nation-swarm.html.

Inlines Geist and Geist Mono (base64), the beat grid measured from the track
(out/beats.json, falling back to 120 BPM), and the traced capital of the
NATION column (assets/nation-column-mark.svg).

    python3 tools/build.py
"""
import base64
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = (ROOT / "src" / "swarm.html").read_text()

for name in ("Geist-Variable.woff2", "GeistMono-Variable.woff2"):
    data = base64.b64encode((ROOT / "assets" / "fonts" / name).read_bytes()).decode()
    src = src.replace(f'url("../assets/fonts/{name}")', f'url("data:font/woff2;base64,{data}")')

grid = {"period": 0.5, "offset": 0.0, "beats": 32}
beats = ROOT / "out" / "beats.json"
if beats.exists():
    grid = json.loads(beats.read_text()).get("grid", grid)
src = re.sub(r"/\*GRID\*/.*?/\*END\*/", "/*GRID*/" + json.dumps(grid) + "/*END*/", src, flags=re.S)

mark = (ROOT / "assets" / "nation-column-mark.svg").read_text()
capital = re.search(r'id="capital" d="([^"]+)"', mark).group(1)
src = src.replace('"/*CAPITAL*/"', json.dumps(capital))

# The mixed loop, for the live preview (Opus in Ogg: small, and decoders honour its pre-skip,
# so Web Audio can loop it without a gap).
audio = ROOT / "out" / "audio_loop.wav"
if audio.exists():
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        ogg = pathlib.Path(d) / "loop.ogg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(audio), "-c:a", "libopus", "-b:a", "160k", str(ogg)], check=True)
        src = src.replace('"/*AUDIO*/"', json.dumps("data:audio/ogg;base64," + base64.b64encode(ogg.read_bytes()).decode()))

import sys

out = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "nation-swarm.html"
out.write_text(src)
print(f"wrote {out} ({len(src) / 1024:.0f} KB), grid {grid}")
