"""
Calculs complémentaires pour les pages explicatives (Comprendre, Méthode, Erreurs).

Lecture seule : ces fonctions mesurent des extraits de signal déjà filtrés
(même filtrage que eeg_pipeline.extract_features) ; elles n'interviennent pas
dans la détection.
"""
import numpy as np
from scipy.signal import find_peaks

import eeg_pipeline as P


# --------------------------------------------------------------------------
# Spectre et fréquence dominante
# --------------------------------------------------------------------------
def mean_psd(X, fs):
    """Densité spectrale moyenne sur les voies, calculée comme dans extract_features
    (fenêtre de Hann, moyenne retirée), pour un segment X (n_échantillons, n_voies)."""
    X = np.asarray(X, dtype=np.float64)
    if X.ndim == 1:
        X = X[:, None]
    n = X.shape[0]
    hann = np.hanning(n)
    freqs = np.fft.rfftfreq(n, 1 / fs)
    seg = (X - X.mean(axis=0, keepdims=True)) * hann[:, None]
    psd = np.abs(np.fft.rfft(seg, axis=0)) ** 2 / (fs * (hann ** 2).sum())
    return freqs, psd.mean(axis=1)


def dominant_frequency(X, fs, fmin=0.5, fmax=30.0):
    """Fréquence du maximum de la densité spectrale moyenne entre fmin et fmax (même bande que Peak_Freq)."""
    freqs, psd = mean_psd(X, fs)
    sel = (freqs >= fmin) & (freqs < fmax)
    k = int(np.argmax(psd[sel]))
    return float(freqs[sel][k]), float(freqs[1] - freqs[0])


def rhythmicity(X, fs, lo=2.0, hi=5.0):
    """Part de la puissance 0,5–30 Hz concentrée autour du pic situé entre lo et hi Hz (± 0,5 Hz)."""
    freqs, psd = mean_psd(X, fs)
    band = (freqs >= 0.5) & (freqs < 30)
    sel = (freqs >= lo) & (freqs <= hi)
    if not sel.any():
        return 0.0, None
    f0 = float(freqs[sel][np.argmax(psd[sel])])
    near = (freqs >= f0 - 0.5) & (freqs <= f0 + 0.5)
    return float(psd[near].sum() / (psd[band].sum() + 1e-12)), f0


# --------------------------------------------------------------------------
# Pointe et onde (pour les annotations de la page « Comprendre »)
# --------------------------------------------------------------------------
def spike_and_wave(X, fs, f0, t0):
    """
    Repère, sur la moyenne des voies affichées, un complexe pointe-onde bien formé :
    - la pointe = l'extremum le plus abrupt (pente maximale avant le sommet) ;
    - l'onde = l'extremum de signe opposé le plus ample dans la demi-période qui suit.
    Renvoie les instants (s) et la polarité ; None si rien de net n'est trouvé.
    """
    m = np.asarray(X, dtype=np.float64).mean(axis=1)
    if f0 is None or f0 <= 0 or len(m) < fs:
        return None
    period = int(round(fs / f0))
    margin = max(period, len(m) // 4)          # au milieu de l'extrait, pour que les annotations restent lisibles
    best = None
    for sign in (1, -1):
        y = sign * m
        peaks, _ = find_peaks(y, distance=max(1, int(0.6 * period)))
        for p in peaks:
            if p < margin or p > len(y) - margin:
                continue
            k = max(1, int(0.04 * fs))                       # pente sur 40 ms avant le sommet
            slope = (y[p] - y[p - k]) / (k / fs)
            if best is None or slope > best[0]:
                best = (slope, p, sign)
    if best is None:
        return None
    _, p, sign = best
    lo, hi = p + int(0.05 * fs), min(len(m) - 1, p + int(0.75 * period))
    if hi <= lo:
        return None
    w = lo + int(np.argmax(-sign * m[lo:hi]))
    return {"spike_t": round(t0 + p / fs, 3), "wave_t": round(t0 + w / fs, 3), "polarity": int(sign)}


# --------------------------------------------------------------------------
# ECG : rythme cardiaque
# --------------------------------------------------------------------------
def heart_rate(ecg, fs):
    """Détection simple des ondes R (pics les plus saillants, ≥ 0,33 s d'écart).
    Renvoie (battements par minute, instants des pics en s, régularité = écart-type RR / moyenne RR)."""
    x = np.asarray(ecg, dtype=np.float64)
    x = x - np.median(x)
    sign = 1 if np.percentile(x, 99.5) >= -np.percentile(x, 0.5) else -1   # orientation des ondes R
    y = sign * x
    peaks, _ = find_peaks(y, distance=int(0.33 * fs), height=np.percentile(y, 97) * 0.5,
                          prominence=np.percentile(y, 97) * 0.4)
    if len(peaks) < 3:
        return None, [], None
    rr = np.diff(peaks) / fs
    return float(60.0 / np.median(rr)), (peaks / fs).tolist(), float(np.std(rr) / np.mean(rr))


# --------------------------------------------------------------------------
# Description d'un segment (page « Erreurs »)
# --------------------------------------------------------------------------
def segment_stats(X, fs):
    """Fréquence dominante (0,5–30 Hz) et amplitude moyenne (RMS moyenné sur les voies, µV)."""
    X = np.asarray(X, dtype=np.float64)
    if X.shape[0] < int(fs):
        return {"dominant_hz": None, "rms_uv": None}
    f, _ = dominant_frequency(X, fs)
    rms = float(np.sqrt((X ** 2).mean(axis=0)).mean())
    return {"dominant_hz": round(f, 2), "rms_uv": round(rms, 1)}


def decimate_minmax(seg, width):
    """Même décimation min/max que l'endpoint /signal : ~width colonnes."""
    n = seg.shape[0]
    if n <= 2 * width:
        return "raw", {"data": np.round(seg, 1).T.tolist()}, 1.0
    edges = np.linspace(0, n, width + 1).astype(int)
    edges = edges[:-1][np.diff(edges) > 0]
    mn = np.minimum.reduceat(seg, edges, axis=0)
    mx = np.maximum.reduceat(seg, edges, axis=0)
    return "minmax", {"min": np.round(mn, 1).T.tolist(), "max": np.round(mx, 1).T.tolist()}, n / len(edges)


# --------------------------------------------------------------------------
# Spectre d'une fenêtre de 2 s (page « Méthode »)
# --------------------------------------------------------------------------
def window_spectrum(X, fs, fmax=40.0):
    freqs, psd = mean_psd(X, fs)
    sel = freqs <= fmax
    return {"freqs": np.round(freqs[sel], 3).tolist(), "psd": [float(f"{v:.4g}") for v in psd[sel]],
            "bands": {b: list(r) for b, r in P.BANDS.items()}}


# --------------------------------------------------------------------------
# Scores par fenêtre
# --------------------------------------------------------------------------
def window_scores(y, pred):
    y, pred = np.asarray(y, int), np.asarray(pred, int)
    tp = int(((y == 1) & (pred == 1)).sum()); fp = int(((y == 0) & (pred == 1)).sum())
    fn = int(((y == 1) & (pred == 0)).sum()); tn = int(((y == 0) & (pred == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"Accuracy": (tp + tn) / max(1, len(y)), "Precision": prec, "Recall": rec, "F1-score": f1,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn}
