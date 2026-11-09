"""
Page Méthode, visite guidée : toutes les données d'un segment de 20 s centré sur une crise annotée,
calculées avec les fonctions d'eeg_pipeline (inchangé) et le Random Forest « sans l'enregistrement ».
Mis en cache dans .cache/methode/.
"""
import json

import numpy as np
from fastapi import APIRouter, HTTPException
from scipy.signal import medfilt, welch

import eeg_pipeline as P

router = APIRouter(prefix="/api/methode")
A = None
SHOW = ["EEGFz", "EEGCz", "EEGF3", "EEGF4", "EEGO1", "EEGO2"]
SEG_S = 20.0
VERSION = 1


def bind(app_module):
    global A
    A = app_module
    (A.CACHE_DIR / "methode").mkdir(parents=True, exist_ok=True)


def _psd(X, fs):
    f, p = welch(X, fs=fs, nperseg=int(4 * fs), axis=0)
    keep = f <= 60
    return f[keep].round(3).tolist(), np.log10(p[keep].mean(axis=1) + 1e-6).round(4).tolist()


@router.get("/tour")
def tour(rid: str = "230102B-F", n: int = 1):
    r = A.CATALOG.get(rid)
    truth = A.truth_intervals(rid)
    if not truth or rid not in set(A.DATASET["Recording"]):
        raise HTTPException(400, "Choisissez un enregistrement annoté.")
    n = max(1, min(n, len(truth)))
    path = A.CACHE_DIR / "methode" / f"tour__{rid}__{n}__{A._file_key(r['path'])}__v{VERSION}.json"
    if path.exists():
        return json.loads(path.read_text())
    rec = A.STORE.get(rid)
    fs, dur = rec.fs, (rec.n - 1) / rec.fs
    s0, e0 = truth[n - 1]
    a = float(max(0.0, min(dur - SEG_S, round((s0 + e0) / 2 - SEG_S / 2))))
    b = a + SEG_S
    i0, i1 = int(a * fs), int(b * fs)
    chans = [c for c in SHOW if c in rec.channels]
    raw = rec.df[chans].values[i0:i1].astype(np.float64)
    filt = rec.columns(chans, True, i0, i1).astype(np.float64)       # médiane retirée puis passe-bande, comme la chaîne
    dec = 2
    # ---- fenêtres et caractéristiques de l'enregistrement entier (cache des caractéristiques)
    feats, _ = A.compute_features(rid, rec)
    feats = feats.sort_values("t_start").reset_index(drop=True)
    model, _, _ = A.MODELS.leave_one_out(rid)
    X = feats[A.MODELS.features].values
    proba = model.predict_proba(X)[:, 1]
    raw_pred = model.predict(X)
    sm = medfilt(raw_pred, P.SMOOTH).astype(int)
    ts, te = feats["t_start"].values, feats["t_end"].values
    runs = P.windows_to_intervals(ts, te, sm, min_len=0, gap=-1e9)        # fenêtres consécutives seulement
    merged = P.windows_to_intervals(ts, te, sm, min_len=0)                 # + fusion des écarts ≤ 1 s
    final = P.windows_to_intervals(ts, te, sm)                             # + durée minimale 2 s
    m = P.match_events(truth, final)
    row = m[(m["Crise réelle"] == n)].iloc[0] if "Crise réelle" in m else None
    sel = np.where((ts >= a - 1e-6) & (te <= b + 1e-6))[0]
    # votes des arbres (forêt du pipeline : normalisation puis arbres)
    scaler, forest = model[:-1], model[-1]
    Xs = scaler.transform(X[sel])
    votes = np.array([t.predict_proba(Xs)[:, 1] for t in forest.estimators_])          # (arbres, fenêtres)
    # spectre de chaque fenêtre (toutes les voies, même calcul que les caractéristiques)
    nw = int(round(P.WIN_S * fs))
    hann = np.hanning(nw)
    freqs = np.fft.rfftfreq(nw, 1 / fs)
    fk = freqs <= 30
    Xall = rec.ensure_filtered()
    wspec = []
    for k in sel:
        w = Xall[int(round(ts[k] * fs)): int(round(ts[k] * fs)) + nw].astype(np.float64)
        p = np.abs(np.fft.rfft((w - w.mean(0)) * hann[:, None], axis=0)) ** 2 / (fs * (hann ** 2).sum())
        wspec.append(np.log10(p[fk].mean(1) + 1e-6).round(3).tolist())
    D = A.DATASET
    q = lambda k, qq: D.loc[D["Class"] == k, A.MODELS.features].quantile(qq)
    cohort = {f: {"normal": float(q(0, .5)[f]), "crise": float(q(1, .5)[f]), "lo": float(D[f].quantile(.02)), "hi": float(D[f].quantile(.98))}
              for f in A.MODELS.features}
    iv = lambda L: [[float(x), float(y)] for x, y in L if x < b + 5 and y > a - 5]
    out = {
        "id": rid, "n": n, "n_seizures": len(truth), "seizure": [s0, e0], "start": a, "end": b, "fs": fs,
        "channels": [c.replace("EEG", "") for c in chans], "dt": dec / fs,
        "raw": np.round(raw[::dec].T, 1).tolist(), "filtered": np.round(filt[::dec].T, 1).tolist(),
        "offset": np.round(np.median(raw, axis=0), 1).tolist(),
        "spectrum_raw": _psd(raw - raw.mean(0), fs), "spectrum_filt": _psd(filt, fs),
        "windows": {"t_start": ts[sel].tolist(), "t_end": te[sel].tolist(), "frac": feats["Seizure_frac"].values[sel].round(3).tolist(),
                    "cls": feats["Class"].values[sel].astype(int).tolist(),
                    "features": {f: feats[f].values[sel].round(5).tolist() for f in A.MODELS.features},
                    "proba": proba[sel].round(4).tolist(), "raw": raw_pred[sel].astype(int).tolist(), "smoothed": sm[sel].astype(int).tolist(),
                    "votes": (votes > 0.5).astype(int).T.tolist(), "spectra": wspec},
        "spec_freqs": freqs[fk].round(3).tolist(), "bands": P.BANDS, "cohort": cohort,
        "stages": {"runs": iv(runs), "merged": iv(merged), "final": iv(final)},
        "error": {"start": float(row["Retard début (s)"]), "end": float(row["Écart fin (s)"])} if row is not None and row["Résultat"] == "Détectée" else None,
        "params": {"lo": A._bandpass_params()["lo"], "hi": A._bandpass_params()["hi"], "win_s": P.WIN_S, "overlap": P.OVERLAP,
                   "features": len(A.MODELS.features), "trees": len(forest.estimators_), "smooth": P.SMOOTH,
                   "merge_gap_s": P.MERGE_GAP_S, "min_event_s": P.MIN_EVENT_S, "model": A.MODELS.model_name(), "trained_on": int(D[D["Recording"] != rid]["Recording"].nunique())},
    }
    path.write_text(json.dumps(out))
    return out
