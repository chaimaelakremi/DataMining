"""
Pipeline de détection des crises d'absence, extrait du notebook
`EEG_Absence_Detection.ipynb` (mêmes fonctions, mêmes paramètres).

Seules adaptations par rapport au notebook :
- `display(...)` (propre à Jupyter) remplacé par un message de log ;
- le filtrage des crises hors enregistrement et la définition des modèles,
  écrits en ligne dans le notebook, sont regroupés dans des fonctions ;
- `detect_with_model` reprend la logique de `detect()` du notebook
  (predict → filtre médian sur 3 fenêtres → intervalles) mais reçoit le
  modèle et les caractéristiques en argument.
"""
import io
import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy.io import loadmat
from scipy.io.matlab._mio5 import MatFile5Reader
from scipy.signal import butter, sosfiltfilt, medfilt

log = logging.getLogger("eeg_pipeline")

# --------------------------------------------------------------------------
# Constantes (identiques au notebook)
# --------------------------------------------------------------------------
MAX_SEIZURE_S = 120
WIN_S, OVERLAP = 2.0, 0.5
BANDS = {"Delta": (0.5, 4), "Theta": (4, 8), "Alpha": (8, 13), "Beta": (13, 30)}
MIN_EVENT_S = 2.0   # on ignore les détections plus courtes
MERGE_GAP_S = 1.0   # on fusionne deux détections séparées de moins de 1 s
SMOOTH = 3          # filtre médian sur 3 fenêtres

FEATURES = ["Mean", "Std", "Variance", "Min", "Max", "Amplitude", "RMS", "Energy",
            "P_Delta", "Rel_Delta", "P_Theta", "Rel_Theta", "P_Alpha", "Rel_Alpha",
            "P_Beta", "Rel_Beta", "Peak_Freq"]


# --------------------------------------------------------------------------
# 1. Chargement des fichiers .mat
# --------------------------------------------------------------------------
def _read_timetable(path):
    # Décode l'objet timetable MATLAB stocké dans le sous-système du fichier .mat
    m = loadmat(path)
    fw = m["__function_workspace__"].tobytes()
    header = b"MATLAB 5.0 MAT-file".ljust(116, b" ") + b"\x00" * 8 + fw[:4]
    stream = io.BytesIO(header + fw[8:])
    reader = MatFile5Reader(stream, struct_as_record=False, squeeze_me=True)
    reader.initialize_read()
    stream.seek(128)
    hdr, _ = reader.read_var_header()
    subsystem = reader.read_var_array(hdr, process=True)
    opaque = np.atleast_1d(subsystem.MCOS)[0]
    # Le tableau des objets est le DERNIER champ de l'objet opaque :
    # 'arr' (anciennes versions de scipy, ex. Colab) ou '_ObjectMetadata' (versions récentes)
    objects = opaque[opaque.dtype.names[-1]] if opaque.dtype.names else opaque
    objects = np.atleast_1d(objects).ravel()
    tt = next((o for o in objects if hasattr(o, "_fieldnames") and "varNames" in o._fieldnames), None)
    if tt is None:
        raise ValueError(f"Timetable introuvable dans {Path(path).name}")
    n_rows = int(tt.numRows)
    # temps des lignes (en ms) : tableau float de longueur numRows
    row_times = next((np.asarray(o, float) for o in objects
                      if isinstance(o, np.ndarray) and o.dtype == float and o.size == n_rows), None)
    return tt, row_times


def load_eeg(path):
    # Retourne (DataFrame [Time + canaux], fréquence d'échantillonnage)
    tt, row_times = _read_timetable(path)
    names = [str(n) for n in np.atleast_1d(tt.varNames)]
    columns = {}
    for name, cells_ in zip(names, np.atleast_1d(tt.data)):
        columns[name] = np.concatenate([np.atleast_1d(c).astype(np.float32) for c in np.atleast_1d(cells_)])
    samples_per_row = np.atleast_1d(np.atleast_1d(tt.data)[0][0]).size
    row_dt = np.median(np.diff(row_times)) / 1000.0 if row_times is not None and row_times.size > 1 else 1.0
    fs = samples_per_row / row_dt
    df = pd.DataFrame(columns)
    df.insert(0, "Time", np.arange(len(df)) / fs)
    return df, fs


def recording_id(path):
    # '210914B_A_0000d.mat' -> '210914B-A' (format des annotations)
    parts = Path(path).stem.split("_")
    return f"{parts[0]}-{parts[1]}"


def eeg_channels(df):
    # 19 électrodes (on exclut SLI et ECG)
    return [c for c in df.columns if c.startswith("EEG")]


# --------------------------------------------------------------------------
# 2. Annotations
# --------------------------------------------------------------------------
def load_annotations(xlsx):
    a = pd.read_excel(xlsx)
    a = a.rename(columns={a.columns[0]: "ID"})
    a = a[a["ID"].notna() & a["DebutTrace"].notna()].copy()
    a["ID"] = a["ID"].astype(str).str.strip()
    dup = a[a["ID"].duplicated()]["ID"].tolist()
    if dup:
        log.info("Annotations dupliquées (1re ligne conservée) : %s", dup)
    a = a.drop_duplicates("ID", keep="first")

    start_cols = {int(re.search(r"(\d+)$", c).group(1)): c for c in a.columns if re.match(r"^Deb\w*CE\d+$", c)}
    end_cols = {int(re.search(r"(\d+)$", c).group(1)): c for c in a.columns if re.match(r"^FinCE\d+$", c)}
    rows = []
    for _, r in a.iterrows():
        t0 = r["DebutTrace"]
        for k in sorted(start_cols):
            s, e = r[start_cols[k]], r.get(end_cols.get(k))
            if pd.isna(s) or pd.isna(e):
                continue
            start = round((s - t0) * 86400, 2)
            end = round((e - t0) * 86400, 2)
            if start < 0:
                start, end = start + 86400, end + 86400   # passage de minuit
            rows.append({"ID": r["ID"], "Crise": k, "Début (s)": start, "Fin (s)": end,
                         "Durée (s)": round(end - start, 2)})
    seiz = pd.DataFrame(rows)
    bad = seiz[(seiz["Durée (s)"] <= 0) | (seiz["Durée (s)"] > MAX_SEIZURE_S)]
    if len(bad):
        log.info("Crises écartées (durée aberrante) :\n%s", bad.to_string())
    seiz = seiz.drop(bad.index).reset_index(drop=True)
    meta = a[["ID", "Sexe", "Age", "NombreCE", "TypeAbs"]].reset_index(drop=True)
    return seiz, meta


def drop_outside(seizures, durations):
    # On garde uniquement les crises qui tombent dans l'enregistrement
    # (durations : {ID: nombre de lignes de la timetable, 1 ligne = 1 s})
    dur = seizures["ID"].map(durations)
    outside = seizures[dur.notna() & (seizures["Début (s)"] >= dur)]
    if len(outside):
        log.info("Crises hors de l'enregistrement (écartées) :\n%s", outside.to_string())
    return seizures.drop(outside.index).reset_index(drop=True)


def seizure_table(seizures, rec):
    t = seizures[seizures["ID"] == rec].sort_values("Début (s)").reset_index(drop=True)
    t["Crise"] = np.arange(1, len(t) + 1)
    return t[["Crise", "Début (s)", "Fin (s)", "Durée (s)"]]


def add_class(df, seizures, rec):
    t = df["Time"].values
    cls = np.zeros(len(df), dtype=np.int8)
    for s, e in seizures.loc[seizures["ID"] == rec, ["Début (s)", "Fin (s)"]].values:
        cls[(t >= s) & (t <= e)] = 1
    df["Class"] = cls
    return df


# --------------------------------------------------------------------------
# 3. Prétraitement et segmentation
# --------------------------------------------------------------------------
def bandpass(x, fs, lo=0.5, hi=40, order=4):
    sos = butter(order, [lo, hi], btype="band", fs=fs, output="sos")
    return sosfiltfilt(sos, x, axis=0)


def segment(df, fs, win_s=WIN_S, overlap=OVERLAP):
    # Retourne les indices de début de fenêtre, la taille, et la classe de chaque fenêtre
    n_win_samp = int(round(win_s * fs))
    step = int(round(n_win_samp * (1 - overlap)))
    n = len(df)
    starts = np.arange(0, n - n_win_samp + 1, step)
    cum = np.concatenate([[0], np.cumsum(df["Class"].values)])
    frac = (cum[starts + n_win_samp] - cum[starts]) / n_win_samp
    return starts, n_win_samp, (frac >= 0.5).astype(int), frac


# --------------------------------------------------------------------------
# 4. Caractéristiques
# --------------------------------------------------------------------------
def extract_features(df, fs, channels, rec):
    starts, n_win_samp, win_class, win_frac = segment(df, fs)
    step = starts[1] - starts[0]
    X = df[channels].values.astype(np.float64)
    X = bandpass(X - np.median(X, axis=0), fs)                        # (n_samples, n_ch), offset retiré puis filtré
    hann = np.hanning(n_win_samp)
    freqs = np.fft.rfftfreq(n_win_samp, 1 / fs)
    df_hz = freqs[1] - freqs[0]
    band_idx = {b: (freqs >= lo) & (freqs < hi) for b, (lo, hi) in BANDS.items()}
    total_idx = (freqs >= 0.5) & (freqs < 30)

    acc = {}
    for j in range(X.shape[1]):                                        # canal par canal (mémoire)
        w = sliding_window_view(X[:, j], n_win_samp)[::step][:len(starts)]   # (n_win, n_win_samp)
        feats = {
            "Mean": w.mean(1), "Std": w.std(1), "Variance": w.var(1),
            "Min": w.min(1), "Max": w.max(1),
        }
        feats["Amplitude"] = feats["Max"] - feats["Min"]
        feats["RMS"] = np.sqrt((w ** 2).mean(1))
        feats["Energy"] = (w ** 2).sum(1)
        psd = np.abs(np.fft.rfft((w - w.mean(1, keepdims=True)) * hann, axis=1)) ** 2 / (fs * (hann ** 2).sum())
        total = psd[:, total_idx].sum(1) * df_hz
        for b, idx in band_idx.items():
            feats[f"P_{b}"] = psd[:, idx].sum(1) * df_hz
            feats[f"Rel_{b}"] = feats[f"P_{b}"] / (total + 1e-12)
        feats["Peak_Freq"] = freqs[total_idx][psd[:, total_idx].argmax(1)]
        for k, v in feats.items():
            acc.setdefault(k, []).append(v)

    out = pd.DataFrame({k: np.mean(v, axis=0) for k, v in acc.items()})
    out.insert(0, "t_end", (starts + n_win_samp) / fs)
    out.insert(0, "t_start", starts / fs)
    out.insert(0, "Window", np.arange(1, len(starts) + 1))
    out.insert(0, "Recording", rec)
    out["Seizure_frac"] = win_frac
    out["Class"] = win_class
    return out


# --------------------------------------------------------------------------
# 5. Modèles (mêmes hyperparamètres que le notebook)
# --------------------------------------------------------------------------
def make_models():
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.neighbors import KNeighborsClassifier
    from sklearn.svm import SVC
    return {
        "Decision Tree": make_pipeline(StandardScaler(), DecisionTreeClassifier(max_depth=10, min_samples_leaf=5,
                                                                                class_weight="balanced", random_state=42)),
        "Random Forest": make_pipeline(StandardScaler(), RandomForestClassifier(n_estimators=300, min_samples_leaf=2,
                                                                                class_weight="balanced_subsample",
                                                                                n_jobs=-1, random_state=42)),
        "KNN": make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=7, weights="distance")),
        "SVM": make_pipeline(StandardScaler(), SVC(kernel="rbf", C=10, gamma="scale", class_weight="balanced")),
    }


# --------------------------------------------------------------------------
# 6. Détection temporelle
# --------------------------------------------------------------------------
def windows_to_intervals(t_start, t_end, pred, min_len=MIN_EVENT_S, gap=MERGE_GAP_S):
    events, cur = [], None
    for s, e, p in zip(t_start, t_end, pred):
        if p:
            cur = [s, e] if cur is None else [cur[0], e]
        elif cur is not None:
            events.append(cur); cur = None
    if cur is not None:
        events.append(cur)
    merged = []
    for ev in events:
        if merged and ev[0] - merged[-1][1] <= gap:
            merged[-1][1] = max(merged[-1][1], ev[1])
        else:
            merged.append(ev)
    return [(s, e) for s, e in merged if e - s >= min_len]


def detect_with_model(feats, model, features=FEATURES, smooth=SMOOTH):
    # Même logique que detect() du notebook : prédiction par fenêtre,
    # lissage médian, puis fusion en intervalles.
    d_rec = feats.sort_values("t_start")
    Xr = d_rec[features].values
    raw = model.predict(Xr)
    sm = medfilt(raw, smooth).astype(int) if smooth > 1 else raw
    ev = windows_to_intervals(d_rec["t_start"].values, d_rec["t_end"].values, sm)
    proba = model.predict_proba(Xr)[:, 1] if hasattr(model, "predict_proba") else raw.astype(float)
    return d_rec, raw, sm, ev, proba


def match_events(true_iv, pred_iv):
    rows, used = [], set()
    for k, (ts, te) in enumerate(true_iv, 1):
        hit = [j for j, (ps, pe) in enumerate(pred_iv) if ps < te and pe > ts]
        if hit:
            used.update(hit)
            ps, pe = pred_iv[hit[0]][0], pred_iv[hit[-1]][1]
            rows.append({"Crise réelle": k, "Début réel": ts, "Fin réelle": te, "Début détecté": ps,
                         "Fin détectée": pe, "Retard début (s)": round(ps - ts, 1), "Écart fin (s)": round(pe - te, 1),
                         "Résultat": "Détectée"})
        else:
            rows.append({"Crise réelle": k, "Début réel": ts, "Fin réelle": te, "Résultat": "Manquée"})
    for j, (ps, pe) in enumerate(pred_iv):
        if j not in used:
            rows.append({"Début détecté": ps, "Fin détectée": pe, "Résultat": "Fausse alarme"})
    return pd.DataFrame(rows)
