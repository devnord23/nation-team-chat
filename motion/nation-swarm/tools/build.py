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

out = ROOT / "nation-swarm.html"
out.write_text(src)
print(f"wrote {out.relative_to(ROOT)} ({len(src) / 1024:.0f} KB), grid {grid}")
