#!/usr/bin/env python3
"""Compose and synthesize the NATION Swarm loop: 8 bars at 120 BPM in D minor.

Every sound is generated here (no samples), so the track is original and
royalty-free. Three cycles are rendered and the middle one is kept: the reverb
and delay tails from the end of the loop are already ringing at its start, so
the audio loops without a seam.

    python3 compose_track.py out/music_loop.wav
"""
import sys
import wave

import numpy as np
from scipy import signal

SR = 48000
BPM = 120.0
BEAT = 60.0 / BPM
STEP = BEAT / 4  # sixteenth note
BARS = 8
LOOP_S = BARS * 4 * BEAT
LOOP = int(round(LOOP_S * SR))
CYCLES = 3
N = LOOP * CYCLES


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


# Two bars per chord. Pad voicings are rootless and move by step; the bass has the root.
CHORDS = [
    # name, pad notes (MIDI), bass root, pluck chord tones (ascending)
    ("Dm9", [53, 57, 60, 64], 38, [69, 72, 74, 76, 77]),
    ("Bbmaj9", [53, 57, 60, 62], 34, [65, 69, 72, 74, 77]),
    ("Gm9", [53, 57, 58, 62], 31, [65, 69, 70, 74, 79]),
    ("A7sus4", [55, 57, 62, 64], 33, [64, 67, 69, 74, 76]),
]

# ---------------------------------------------------------------- buffers
drums = np.zeros((2, N))  # kick, hats, clap: never ducked
music = np.zeros((2, N))  # bass, pluck, pad: ducked by the kick
rev_send = np.zeros((2, N))
dly_send = np.zeros(N)
kick_times = []


def place(buf, t, sig, pan=0.0, gain=1.0):
    """Add a mono signal to a stereo buffer at time t with constant-power pan."""
    i = int(round(t * SR))
    if i >= buf.shape[-1]:
        return
    sig = sig[: buf.shape[-1] - i] * gain
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    if buf.ndim == 1:
        buf[i : i + len(sig)] += sig
    else:
        buf[0, i : i + len(sig)] += sig * left * np.sqrt(2)
        buf[1, i : i + len(sig)] += sig * right * np.sqrt(2)


def fade(sig, ms_in=1.0, ms_out=8.0):
    a, b = int(SR * ms_in / 1000), int(SR * ms_out / 1000)
    if a:
        sig[:a] *= np.linspace(0, 1, a)
    if b:
        sig[-b:] *= np.linspace(1, 0, b)
    return sig


def bandpass(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x)


def highpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype="high", fs=SR, output="sos"), x)


def lowpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype="low", fs=SR, output="sos"), x)


# ---------------------------------------------------------------- voices
def kick(rng, vel=1.0):
    t = np.arange(int(0.42 * SR)) / SR
    f0, f1, tp = 150.0, 47.0, 0.032
    phase = 2 * np.pi * (f1 * t + (f0 - f1) * tp * (1 - np.exp(-t / tp)))
    body = np.sin(phase) * np.exp(-t / 0.19)
    body = np.tanh(1.6 * body) / np.tanh(1.6)
    click = bandpass(rng.standard_normal(len(t)), 1800, 5200) * np.exp(-t / 0.0022) * 0.3
    return fade(body + click, 0.5, 30) * vel


def hat(rng, vel=1.0, open_=False):
    dur = 0.32 if open_ else 0.07
    t = np.arange(int(dur * SR)) / SR
    noise = highpass(rng.standard_normal(len(t)), 7200, 3)
    metal = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (205.3, 304.4, 369.6, 522.7, 540.0, 800.0))
    metal = bandpass(metal, 7000, 11500, 2) * 0.35
    env = np.exp(-t / (0.11 if open_ else 0.018))
    return fade(lowpass((noise * 0.8 + metal) * env * 0.6, 14500, 2), 0.3, 6) * vel


def clap(rng, vel=1.0):
    t = np.arange(int(0.5 * SR)) / SR
    n = bandpass(rng.standard_normal(len(t)), 900, 3400, 2)
    env = np.zeros(len(t))
    for k, off in enumerate((0.0, 0.009, 0.019)):
        m = t >= off
        env[m] += np.exp(-(t[m] - off) / 0.006) * (0.8 if k < 2 else 1.0)
    m = t >= 0.019
    env[m] += 0.55 * np.exp(-(t[m] - 0.019) / 0.075)
    return fade(n * env * 0.55, 0.2, 20) * vel


def bass(note, length, vel=1.0):
    f = hz(note)
    t = np.arange(int((length + 0.05) * SR)) / SR
    env = np.minimum(t / 0.004, 1.0) * np.exp(-t / 0.5)
    env *= np.clip((length + 0.03 - t) / 0.03, 0, 1)
    x = np.sin(2 * np.pi * f * t) + 0.45 * np.sin(2 * np.pi * 2 * f * t + 0.4) + 0.16 * np.sin(2 * np.pi * 3 * f * t)
    x = np.tanh(1.8 * x * env) / np.tanh(1.8)
    return lowpass(x, 1300, 2) * vel


def pluck(note, vel=1.0):
    """Glassy FM pluck: a bright attack that settles into a pure tone."""
    f = hz(note)
    t = np.arange(int(1.1 * SR)) / SR
    index = 2.6 * np.exp(-t / 0.08) + 0.35
    a = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * 2 * f * t))
    b = 0.28 * np.sin(2 * np.pi * f * 1.004 * t + 0.6 * np.exp(-t / 0.05) * np.sin(2 * np.pi * 3.5 * f * t))
    env = np.minimum(t / 0.002, 1) * np.exp(-t / 0.28)
    return fade(highpass((a + b) * env, 260, 2) * 0.5, 0.2, 40) * vel


def pad_chord(rng, notes, t0, t1, cutoff_fn):
    """Detuned additive saws with a time-varying low-pass, faded in and out."""
    attack, release = 0.35, 0.65
    s0, s1 = int(t0 * SR), min(N, int((t1 + release) * SR))
    t = np.arange(s1 - s0) / SR + t0
    local = t - t0
    env = np.minimum(local / attack, 1.0) * np.clip(1 - (t - t1) / release, 0, 1)
    fc = cutoff_fn(t)
    out = np.zeros((2, len(t)))
    for note in notes:
        for detune, pan in ((-0.09, -0.65), (0.0, 0.0), (0.085, 0.65)):
            f = hz(note) * 2 ** (detune / 12)
            voice = np.zeros(len(t))
            ph0 = rng.uniform(0, 2 * np.pi)
            for h in range(1, 24):
                if f * h > 7000:
                    break
                amp = (1.0 / h) / np.sqrt(1 + (f * h / fc) ** 4)
                voice += amp * np.sin(2 * np.pi * f * h * local + ph0 * h)
            left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            out[0] += voice * left
            out[1] += voice * right
    return s0, out * env * 0.13


def pad_cutoff(t):
    """Cutoff dips while the workspace closes and reopens (beats 25-26, 12.0-13.0 s)."""
    tl = np.mod(t, LOOP_S)
    base = 2300.0 + 350.0 * np.sin(2 * np.pi * tl / LOOP_S)
    dip = np.exp(-(((tl - 12.45) / 0.34) ** 2))
    return base * (1 - 0.72 * dip)


# ---------------------------------------------------------------- arrangement
MOTIF = [(0, 1, 0.9), (3, 2, 0.62), (6, 4, 0.8), (10, 3, 0.58),
         (16, 2, 0.85), (22, 1, 0.66), (26, 0, 0.6), (30, 2, 0.48)]
HAT_GHOSTS = {3: 0.22, 7: 0.3, 11: 0.22, 13: 0.18, 15: 0.34}

def ev(*key):
    """An RNG that depends only on where the event sits in the loop, never on the cycle."""
    return np.random.default_rng([20260925, *key])


for c in range(CYCLES):
    base = c * LOOP_S
    for bar in range(BARS):
        name, pad, root, tones = CHORDS[bar // 2]
        tb = base + bar * 4 * BEAT
        last_beat_breath = bar == BARS - 1  # beat 32: the groove breathes before the loop lands
        for step in range(16):
            ts = tb + step * STEP
            if step % 4 == 0 and not (last_beat_breath and step == 12):
                place(drums, ts, kick(ev(1, bar, step), 1.0 if step == 0 else 0.93))
                kick_times.append(ts)
            if step % 4 == 2:
                place(drums, ts, hat(ev(2, bar, step), 0.62 if step != 14 else 0.7), pan=0.18)
                if not (last_beat_breath and step == 14):
                    place(music, ts, bass(root, 0.17, 0.6))
            if step in HAT_GHOSTS:
                place(drums, ts, hat(ev(3, bar, step), HAT_GHOSTS[step]), pan=-0.22)
            if step in (4, 12):
                cl = clap(ev(4, bar, step), 0.85)
                place(drums, ts, cl)
                place(rev_send, ts, cl, gain=0.5)
        if bar in (3, 7):
            place(drums, tb + 14 * STEP, hat(ev(5, bar), 0.42, open_=True), pan=0.25)
        if bar % 2 == 0:
            for step, idx, vel in MOTIF:
                p = pluck(tones[idx], vel)
                ts = tb + step * STEP
                place(music, ts, p, gain=1.45)
                place(dly_send, ts, p, gain=1.1)
                place(rev_send, ts, p, gain=0.5)
    # pads: one per chord, two bars each, overlapping releases
    for k, (name, pad, root, tones) in enumerate(CHORDS):
        t0 = base + k * 8 * BEAT
        s0, out = pad_chord(ev(6, k), pad, t0, t0 + 8 * BEAT - 0.05, pad_cutoff)
        music[:, s0 : s0 + out.shape[1]] += out
        rev_send[:, s0 : s0 + out.shape[1]] += out * 0.35

# Beat 32 swell: a quiet band of noise rises into the downbeat.
for c in range(1, CYCLES):
    t = np.arange(int(0.5 * SR)) / SR
    swell = bandpass(ev(7).standard_normal(len(t)), 2500, 9000, 2) * (t / 0.5) ** 3 * 0.05
    place(drums, c * LOOP_S - 0.5, fade(swell, 1, 3), pan=0.0)
    place(rev_send, c * LOOP_S - 0.5, swell, gain=0.5)

# ---------------------------------------------------------------- sidechain
duck = np.ones(N)
tt = np.arange(N) / SR
for tk in kick_times:
    i = int(tk * SR)
    seg = tt[i : i + int(0.45 * SR)] - tk
    duck[i : i + len(seg)] = np.minimum(duck[i : i + len(seg)], 1 - 0.38 * np.exp(-seg / 0.13) * np.minimum(seg / 0.003, 1))

# ---------------------------------------------------------------- effects
def reverb_ir(seconds=2.4, seed=7):
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    bands = [(20, 250, 2.1), (250, 1000, 2.3), (1000, 3000, 1.8), (3000, 7000, 1.2), (7000, 20000, 0.7)]
    irs = []
    for ch in range(2):
        noise = r.standard_normal(n)
        spec = np.fft.rfft(noise)
        freqs = np.fft.rfftfreq(n, 1 / SR)
        ir = np.zeros(n)
        for lo, hi, rt60 in bands:
            mask = (freqs >= lo) & (freqs < hi)
            band = np.fft.irfft(spec * mask, n)
            ir += band * np.exp(-6.91 * t / rt60)
        pre = int(0.022 * SR)
        ir = np.concatenate([np.zeros(pre), ir])[:n]
        ir *= np.minimum(t / 0.012, 1)
        irs.append(ir / np.sqrt(np.sum(ir ** 2)))
    return irs


irs = reverb_ir()
wet = np.stack([signal.fftconvolve(rev_send[ch], irs[ch])[:N] for ch in range(2)]) * 0.75

# Ping-pong dotted-eighth delay on the pluck, darker on each repeat.
delay = np.zeros((2, N))
d = int(round(3 * STEP * SR))
echo = dly_send.copy()
for k in range(1, 7):
    echo = lowpass(np.concatenate([np.zeros(d), echo[:-d]]), 5200 - 500 * k, 1) * 0.42
    delay[(k + 1) % 2] += echo
wet += np.stack([signal.fftconvolve(delay[ch], irs[ch])[:N] for ch in range(2)]) * 0.18

mix = drums + music * duck + delay * 0.8 * duck + wet * (0.6 + 0.4 * duck)

# ---------------------------------------------------------------- master
mix = np.stack([highpass(ch, 24, 2) for ch in mix])


def high_shelf(x, f0=7000.0, gain_db=2.5, q=0.7):
    """RBJ cookbook high shelf: a little air on top of the whole mix."""
    a_ = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b = [a_ * ((a_ + 1) + (a_ - 1) * cw + 2 * np.sqrt(a_) * alpha), -2 * a_ * ((a_ - 1) + (a_ + 1) * cw), a_ * ((a_ + 1) + (a_ - 1) * cw - 2 * np.sqrt(a_) * alpha)]
    a = [(a_ + 1) - (a_ - 1) * cw + 2 * np.sqrt(a_) * alpha, 2 * ((a_ - 1) - (a_ + 1) * cw), (a_ + 1) - (a_ - 1) * cw - 2 * np.sqrt(a_) * alpha]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x)


mix = np.stack([high_shelf(ch) for ch in mix])


def glue(x, thr_db=-14.0, ratio=2.0, tc=0.06):
    mono = 0.5 * (x[0] + x[1])
    a = np.exp(-1 / (0.03 * SR))
    ms = signal.lfilter([1 - a], [1, -a], mono ** 2)
    lvl = 10 * np.log10(ms + 1e-12)
    gr = -(1 - 1 / ratio) * np.maximum(0.0, lvl - thr_db)
    b = np.exp(-1 / (tc * SR))
    gr = signal.lfilter([1 - b], [1, -b], gr)
    return x * 10 ** (gr / 20)


def k_weighted_lufs(x):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    y = np.stack([signal.lfilter(b2, a2, signal.lfilter(b1, a1, ch)) for ch in x])
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(y[:, i : i + blk] ** 2, axis=1).sum() for i in range(0, y.shape[1] - blk, hop)])
    lk = -0.691 + 10 * np.log10(z + 1e-15)
    z = z[lk > -70]
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    z = z[(-0.691 + 10 * np.log10(z)) > rel]
    return -0.691 + 10 * np.log10(z.mean())


def limit(x, ceiling_db=-1.2, look_ms=3.0):
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    ceil = 10 ** (ceiling_db / 20)
    peak = np.max(np.abs(x), axis=0)
    need = np.minimum(1.0, ceil / np.maximum(peak, 1e-9))
    w = int(SR * look_ms / 1000)
    g = minimum_filter1d(need, 2 * w + 1)
    g = uniform_filter1d(g, w)
    g = np.minimum(g, need * 1.0005)
    return x * g


mix = glue(mix)
mid = mix[:, LOOP : 2 * LOOP]
gain_db = -14.0 - k_weighted_lufs(mid)
mix *= 10 ** (gain_db / 20)
mix = limit(mix)
loop = mix[:, LOOP : 2 * LOOP]
tp = np.max(np.abs(signal.resample_poly(loop, 4, 1, axis=1)))
print(f"loop {LOOP / SR:.3f}s  {LOOP} samples  loudness {k_weighted_lufs(loop):.2f} LUFS  true peak {20 * np.log10(tp):.2f} dBTP")
# The sample after the loop's last one, in the continuous render, is where playback wraps to.
wrap_err = np.max(np.abs(mix[:, 2 * LOOP] - loop[:, 0]))
cycle_err = np.max(np.abs(mix[:, 2 * LOOP : 3 * LOOP] - loop))
print(f"periodicity: next-cycle vs loop max diff {cycle_err:.2e}, wrap sample diff {wrap_err:.2e}")

out = sys.argv[1] if len(sys.argv) > 1 else "music_loop.wav"
pcm = np.clip(loop.T, -1, 1)
ints = (pcm * (2 ** 23 - 1)).astype(np.int32)
raw = np.zeros((ints.shape[0], 2, 3), np.uint8)
for ch in range(2):
    v = ints[:, ch].astype(np.int64) & 0xFFFFFF
    raw[:, ch, 0], raw[:, ch, 1], raw[:, ch, 2] = v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(3)
    w.setframerate(SR)
    w.writeframes(raw.tobytes())
print("wrote", out)
