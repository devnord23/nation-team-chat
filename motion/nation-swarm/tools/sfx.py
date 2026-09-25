#!/usr/bin/env python3
"""UI sounds for the loop, mixed under the music.

Cue times come from the animation itself (window.SOUNDS in nation-swarm.html),
so picture and sound share one timeline. Every sound is synthesized here and
kept in the track's key (D minor). Tails that run past the end of the loop are
wrapped onto its start, so the mix loops as cleanly as the music.

    python3 tools/sfx.py out/music_loop.wav out/audio_loop.wav
"""
import pathlib
import sys
import wave

import numpy as np
from scipy import signal

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from analyze_beats import load  # noqa: E402

SR = 48000


def cues():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        p = b.new_page()
        p.goto((ROOT / "nation-swarm.html").as_uri() + "?render")
        p.wait_for_function("window.SOUNDS !== undefined")
        out = p.evaluate("window.SOUNDS"), p.evaluate("window.LOOP")
        b.close()
    return out


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a=0.001, d=0.05):
    t = np.arange(n) / SR
    return np.minimum(t / max(a, 1e-4), 1.0) * np.exp(-t / d)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos"), x)


rng = np.random.default_rng(7)


def noise(n):
    return rng.standard_normal(n)


def tone(f, dur, a=0.002, d=0.08, fm=0.0, ratio=2.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    idx = fm * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * ratio * t)) * env(n, a, d)


def glide(f0, f1, dur, d=0.08):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f0 * (f1 / f0) ** np.clip(t / (dur * 0.6), 0, 1)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * env(n, 0.003, d)


def click(v=1.0):
    n = int(0.03 * SR)
    x = bp(noise(n), 2200, 7000) * env(n, 0.0004, 0.0035) * 0.9
    x[: int(0.012 * SR)] += tone(2100, 0.012, 0.0005, 0.004)
    return x * 0.5 * v


def sound(kind, e):
    D = {  # D minor tones
        "D5": hz(74), "E5": hz(76), "F5": hz(77), "G5": hz(79), "A5": hz(81), "Bb5": hz(82), "D6": hz(86), "F6": hz(89), "G6": hz(91), "A6": hz(93),
    }
    if kind == "click":
        return click(1.0), 0.0
    if kind == "grab":
        x = click(0.7)
        x = np.pad(x, (0, int(0.04 * SR)))
        x[: int(0.05 * SR)] += 0.25 * tone(620, 0.05, 0.002, 0.02)
        return x, 0.0
    if kind == "drop":
        n = int(0.16 * SR)
        t = np.arange(n) / SR
        thud = np.sin(2 * np.pi * (150 * t - 30 * t * t / 0.12)) * env(n, 0.002, 0.045)
        x = 0.8 * thud
        x[: int(0.03 * SR)] += click(0.8)[: int(0.03 * SR)]
        return x * 1.1, 0.0
    if kind == "spawn":
        return 0.45 * glide(D["D5"], D["F5"], 0.16, 0.06), 0.0
    if kind == "split":
        a = 0.26 * tone(D["A5"], 0.14, 0.002, 0.05, fm=0.8)
        b = np.pad(0.22 * tone(D["D6"], 0.14, 0.002, 0.05, fm=0.8), (int(0.05 * SR), 0))
        n = max(len(a), len(b))
        return np.pad(a, (0, n - len(a))) + np.pad(b, (0, n - len(b))), 0.0
    if kind == "handoff":
        n = int(0.14 * SR)
        t = np.arange(n) / SR
        sw = bp(noise(n), 1400, 5200) * np.sin(np.pi * np.clip(t / 0.12, 0, 1)) ** 2
        return 0.2 * sw, e.get("pan", 0.0)
    if kind == "catch":
        return 0.3 * tone(D["D6"], 0.05, 0.001, 0.012, fm=1.2), e.get("pan", 0.0)
    if kind == "pcOn":
        n = int(0.5 * SR)
        t = np.arange(n) / SR
        f = hz(46) * (1 + 0.5 * (1 - np.exp(-t / 0.08)))
        low = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(t / 0.03, 1) * np.exp(-t / 0.16)
        shimmer = tone(D["F6"], 0.3, 0.02, 0.1, fm=0.5) * 0.18
        x = 0.7 * low
        x[: len(shimmer)] += shimmer
        return x * 1.0, 0.0
    if kind == "key":
        v = e.get("v", 1.0)
        n = int(0.02 * SR)
        x = bp(noise(n), 3000, 8500) * env(n, 0.0003, 0.0022) * 0.6
        x += 0.18 * tone(210, 0.02, 0.0005, 0.006)
        return x * 0.8 * v, (e["t"] * 7 % 1 - 0.5) * 0.2
    if kind == "approve":
        a = 0.26 * tone(D["G5"], 0.22, 0.002, 0.07, fm=1.0, ratio=3.0)
        b = np.pad(0.24 * tone(D["D6"], 0.26, 0.002, 0.09, fm=1.0, ratio=3.0), (int(0.07 * SR), 0))
        n = max(len(a), len(b))
        return np.pad(a, (0, n - len(a))) + np.pad(b, (0, n - len(b))), 0.1
    if kind == "ready":
        x = 0.24 * glide(D["Bb5"], D["D6"], 0.24, 0.1)
        x[: int(0.03 * SR)] += click(0.6)[: int(0.03 * SR)]
        return x, 0.0
    if kind == "mem":
        f = [D["G5"], D["A5"], D["D6"]][e.get("n", 0)]
        return 0.2 * tone(f, 0.1, 0.001, 0.03, fm=0.9), 0.0
    if kind == "fold":
        return 0.3 * glide(D["A5"], D["D5"], 0.14, 0.05), 0.0
    if kind == "unfold":
        return 0.3 * glide(D["D5"], D["A5"], 0.14, 0.05), 0.0
    if kind == "deliver":
        parts = [(hz(81), 0.0), (hz(86), 0.03), (hz(88), 0.06)]  # A5 D6 E6 over A7sus4
        n = int(0.5 * SR)
        x = np.zeros(n)
        for f, dl in parts:
            s = 0.16 * tone(f, 0.4, 0.002, 0.14, fm=0.9, ratio=3.0)
            i = int(dl * SR)
            x[i : i + len(s)] += s[: n - i]
        return x, 0.0
    raise SystemExit(f"unknown sound {kind}")


def read(path):
    with wave.open(str(path), "rb") as w:
        sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = np.frombuffer(w.readframes(n), np.uint8)
    b = raw.reshape(-1, ch, 3).astype(np.int32)
    v = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
    v = np.where(v & 0x800000, v - 0x1000000, v) / float(2 ** 23)
    assert sr == SR
    return v.T.copy()


def write(path, x):
    pcm = np.clip(x.T, -1, 1)
    ints = (pcm * (2 ** 23 - 1)).astype(np.int32).astype(np.int64) & 0xFFFFFF
    raw = np.stack([ints & 0xFF, (ints >> 8) & 0xFF, (ints >> 16) & 0xFF], axis=-1).astype(np.uint8)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(raw.tobytes())


def main():
    music_path, out_path = sys.argv[1], sys.argv[2]
    music = read(music_path)
    n = music.shape[1]
    events, loop = cues()
    assert abs(n / SR - loop) < 1e-6, (n / SR, loop)
    ui = np.zeros((2, n))
    for e in sorted(events, key=lambda e: e["t"]):
        x, pan = sound(e["k"], e)
        i = int(round(e["t"] * SR))
        idx = (i + np.arange(len(x))) % n  # tails past the end wrap onto the start
        l, r = np.cos((pan + 1) * np.pi / 4) * np.sqrt(2), np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
        np.add.at(ui[0], idx, x * l)
        np.add.at(ui[1], idx, x * r)
    # A short, darker room so the sounds sit in the same space as the music.
    t = np.arange(int(0.6 * SR)) / SR
    irs = [bp(np.random.default_rng(s).standard_normal(len(t)), 300, 6000) * np.exp(-t / 0.12) for s in (1, 2)]
    irs = [ir / np.sqrt(np.sum(ir ** 2)) for ir in irs]
    wet = np.stack([np.real(np.fft.ifft(np.fft.fft(ui[c]) * np.fft.fft(irs[c], n))) for c in range(2)])  # circular: wraps too
    ui = ui + 0.22 * wet
    gain = 10 ** (-8.0 / 20)  # the music stays the rhythm; UI sits well under it
    mix = music + ui * gain
    rms = lambda x: np.sqrt(np.mean(x ** 2))
    print(f"UI bus {20 * np.log10(rms(ui * gain) / rms(music)):.1f} dB relative to the music (RMS); {len(events)} cues")
    peak = np.max(np.abs(signal.resample_poly(mix, 4, 1, axis=1)))
    ceiling = 10 ** (-1.0 / 20)
    if peak > ceiling:
        mix *= ceiling / peak
        print(f"trimmed {20 * np.log10(peak / ceiling):.2f} dB to keep true peak at -1 dBTP")
    write(out_path, mix)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
