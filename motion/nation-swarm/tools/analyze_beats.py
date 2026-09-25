#!/usr/bin/env python3
"""Find the beat grid and a strong downbeat in a track, with numpy only.

Onsets come from log-magnitude spectral flux. Tempo is the autocorrelation
peak of that onset curve (with a broad prior around 120 BPM), beats are tracked
by dynamic programming, and the grid is refined by a least-squares fit of the
tracked beats. The downbeat is the beat phase (mod 4) where bars actually
start: low-end weight, harmonic change and the strongest onsets. The phrase
start is the bar whose downbeat has the largest harmonic change after a quiet
beat, which is where an 8-bar section turns over.

    python3 analyze_beats.py out/music_loop.wav --loop --bars 8 --json out/beats.json
"""
import argparse
import json
import wave

import numpy as np


def load(path):
    with wave.open(path, "rb") as w:
        sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = np.frombuffer(w.readframes(n), np.uint8)
    if width == 3:
        b = raw.reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v) / float(2 ** 23)
    elif width == 2:
        v = np.frombuffer(raw.tobytes(), np.int16) / 32768.0
    else:
        raise SystemExit(f"unsupported sample width {width}")
    return sr, v.reshape(-1, ch).mean(axis=1)


def stft_mag(x, n_fft, hop):
    win = np.hanning(n_fft)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (n_fft // 2, n_fft // 2)), n_fft)[::hop]
    return np.abs(np.fft.rfft(frames * win, axis=1))


def chroma(mag, sr, n_fft):
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    ok = (freqs > 55) & (freqs < 2000)
    pc = np.round(12 * np.log2(freqs[ok] / 440.0)).astype(int) % 12
    c = np.zeros((mag.shape[0], 12))
    for k in range(12):
        c[:, k] = (mag[:, ok][:, pc == k] ** 2).sum(axis=1)
    return c / (np.linalg.norm(c, axis=1, keepdims=True) + 1e-9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--loop", action="store_true", help="the file is a loop: analyse it tiled so edges do not bias the result")
    ap.add_argument("--bars", type=int, default=8)
    ap.add_argument("--json")
    a = ap.parse_args()

    sr, x = load(a.wav)
    length = len(x) / sr
    tiles = 3 if a.loop else 1
    xt = np.tile(x, tiles)
    hop, n_fft = int(sr * 0.005), 2048
    fps = sr / hop
    mag = stft_mag(xt, n_fft, hop)
    # Flux over log-spaced bands so a kick counts as much as a broadband hat.
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    edges = np.geomspace(30, min(16000, sr / 2 - 1), 41)
    bands = np.stack([mag[:, (freqs >= lo) & (freqs < hi)].sum(axis=1) for lo, hi in zip(edges[:-1], edges[1:])], axis=1)
    logb = np.log1p(100 * bands)
    dflux = np.maximum(0, np.diff(logb, axis=0, prepend=logb[:1]))
    flux = dflux.sum(axis=1)
    low = dflux[:, edges[1:] <= 160].sum(axis=1)
    k = int(fps * 0.3)
    onset = flux - np.convolve(flux, np.ones(k) / k, mode="same")
    onset = np.maximum(onset, 0)
    onset /= onset.std() + 1e-9

    # Tempo: autocorrelation with a log-normal prior centred on 120 BPM.
    ac = np.correlate(onset, onset, mode="full")[len(onset) - 1 :]
    lags = np.arange(len(ac))
    bpm_of = lambda lag: 60 * fps / lag
    valid = (lags > fps * 60 / 200) & (lags < fps * 60 / 60)
    prior = np.exp(-0.5 * (np.log2(bpm_of(np.maximum(lags, 1)) / 120.0) / 0.9) ** 2)
    score = np.where(valid, ac * prior, 0)
    lag = int(np.argmax(score))
    y0, y1, y2 = score[lag - 1], score[lag], score[lag + 1]
    lag_f = lag + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    period = lag_f / fps

    # Dynamic-programming beat tracker (Ellis 2007).
    n = len(onset)
    p = period * fps
    best = onset.copy()
    back = np.full(n, -1)
    tight = 120.0
    for i in range(n):
        lo, hi = int(i - 2 * p), int(i - p / 2)
        if hi <= 0:
            continue
        lo = max(lo, 0)
        cand = np.arange(lo, hi)
        pen = -tight * np.log((i - cand) / p) ** 2
        j = np.argmax(best[cand] + pen)
        best[i] = onset[i] + best[cand[j]] + pen[j]
        back[i] = cand[j]
    i = int(np.argmax(best[-int(p * 2) :])) + n - int(p * 2)
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    beats = np.array(beats[::-1]) / fps

    # Least-squares grid through the tracked beats (middle tile only when looping).
    lo_t, hi_t = (length, 2 * length) if a.loop else (0, length)
    sel = beats[(beats >= lo_t - period * 0.5) & (beats < hi_t + period * 0.5)]
    idx = np.round((sel - sel[0]) / period)
    slope, icpt = np.polyfit(idx, sel, 1)
    period = slope
    resid = sel - (icpt + idx * period)

    # On-beat or off-beat? In a four-on-the-floor groove the kick owns the beat.
    def low_at(ts):
        return np.mean([low[max(int(round(t * fps)) - 3, 0) : int(round(t * fps)) + 6].max() for t in ts])
    probe = icpt + np.arange(0, int((hi_t - icpt) / period)) * period
    probe = probe[(probe > lo_t) & (probe < hi_t - period)]
    if low_at(probe + period / 2) > 1.15 * low_at(probe):
        icpt += period / 2

    # Sample-accurate phase: measure each kick's attack in the waveform itself.
    # Low band (causal 250 Hz low-pass, under a millisecond of delay there),
    # causal peak-hold envelope; from each hit's peak walk back to where the
    # rise began. Beats without a kick (breaks) give outliers, so the grid is refit
    # only through onsets that agree with the median offset.
    from scipy import signal as sps
    lowsig = sps.sosfilt(sps.butter(2, 250, fs=sr, output="sos"), xt)
    from scipy.ndimage import maximum_filter1d
    hold = int(sr * 0.015)  # causal 15 ms peak hold: smooth, and it never rises before the hit
    env = maximum_filter1d(np.abs(lowsig), hold, origin=(hold - 1) // 2)
    from scipy.ndimage import minimum_filter1d
    look = int(sr * 0.010)
    recent_min = minimum_filter1d(env, look, origin=(look - 1) // 2)
    jump = env - recent_min
    found = []
    for t in probe:
        n_i = round((t - icpt) / period)
        t0 = icpt + n_i * period
        a0, a1 = int((t0 - 0.05) * sr), int((t0 + 0.05) * sr)
        if a0 <= 0 or a1 >= len(env):
            continue
        # A sustained bass can be as loud as the kick, so look for the biggest
        # sudden jump (level now versus the quietest point of the last 10 ms).
        pk = a0 + int(np.argmax(jump[a0:a1]))
        floor, top = recent_min[pk], env[pk]
        k = pk
        while k > a0 and env[k - 1] > floor + 0.3 * (top - floor):
            k -= 1
        found.append((n_i, k / sr))
    found = np.array(found)
    if len(found) >= 4:
        off = found[:, 1] - (icpt + found[:, 0] * period)
        inl = np.abs(off - np.median(off)) < 0.008

        period, icpt = np.polyfit(found[inl, 0], found[inl, 1], 1)
        resid = found[inl, 1] - (icpt + found[inl, 0] * period)
        print(f"kick onsets: {inl.sum()} of {len(found)} agree with the grid")

    # Downbeat phase: which beat of four starts the bars?
    ch = chroma(mag, sr, n_fft)
    def at(t):
        return int(round(t * fps))
    grid = icpt + np.arange(-8, int((hi_t - icpt) / period) + 8) * period
    grid = grid[(grid >= lo_t - 1e-6) & (grid < hi_t - 1e-6)]
    phase_score = np.zeros(4)
    novelty = []
    for g in grid:
        f = at(g)
        before, after = ch[max(f - int(fps * 0.45), 0) : f - int(fps * 0.05)].mean(0), ch[f + int(fps * 0.05) : f + int(fps * 0.45)].mean(0)
        nov = 1 - float(np.dot(before, after) / (np.linalg.norm(before) * np.linalg.norm(after) + 1e-9))
        win = slice(max(f - 4, 0), f + 12)
        novelty.append((g, nov, low[win].max(), onset[win].max()))
    for bi, (g, nov, lw, on) in enumerate(novelty):
        phase_score[bi % 4] += 3.0 * nov + 0.02 * lw + 0.05 * on
    ph = int(np.argmax(phase_score))
    downbeats = [nv for bi, nv in enumerate(novelty) if bi % 4 == ph]

    # Phrase start: the downbeat with the largest harmonic change, preferring one after a quiet beat.
    quiet = []
    for g, nov, lw, on in downbeats:
        f = at(g)
        prev = onset[max(f - int(fps * period * 0.9), 0) : f - int(fps * 0.03)]
        quiet.append(-prev.mean())
    quiet = np.array(quiet)
    quiet = (quiet - quiet.min()) / (np.ptp(quiet) + 1e-9)
    strength = np.array([nov for _, nov, _, _ in downbeats])
    strength = strength / (strength.max() + 1e-9) + 0.5 * quiet
    start = downbeats[int(np.argmax(strength))][0]
    start_in_file = (start - lo_t) % length if a.loop else start

    bpm = 60.0 / period
    beat_times = [start_in_file + k * period for k in range(a.bars * 4)]
    beat_times = [((t % length) if a.loop else t) for t in beat_times]
    out = {
        "file": a.wav,
        "duration": round(length, 6),
        "bpm": round(bpm, 4),
        "beat_period": round(period, 6),
        "downbeat_phase_scores": [round(float(s), 3) for s in phase_score],
        "phrase_start": round(float(start_in_file), 4),
        "grid_fit_residual_ms": round(float(np.abs(resid).max() * 1000), 2),
        "beats": [round(float(t), 4) for t in beat_times],
    }
    if a.loop:
        # A loop's length is exact, so the grid the animation uses is length / beats,
        # anchored at the measured phrase start rounded to the millisecond.
        out["grid"] = {"period": length / (a.bars * 4), "offset": round(float(start_in_file), 3) % length, "beats": a.bars * 4}
    print(json.dumps({k: v for k, v in out.items() if k != "beats"}, indent=2))
    print("first beats:", out["beats"][:6], "...")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
