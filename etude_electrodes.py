"""
Étude « Et si une électrode lâche ? » : robustesse du détecteur quand des voies manquent,
sont corrompues, ou quand la référence change. Module partagé par le notebook (section finale)
et par le site (onglet Laboratoire · Électrodes).

Principe (rapide) : les 17 caractéristiques du projet sont des MOYENNES sur les voies. On calcule
une fois, par fenêtre, les 17 caractéristiques DE CHAQUE VOIE ; retirer une voie revient alors à
moyenner les autres, et corrompre une voie ne demande que de recalculer cette voie.
La panne survient au moment du test : on utilise les Random Forest « sans l'enregistrement »
existants, entraînés sur des données intactes (.cache/models/). eeg_pipeline n'est pas modifié.
"""
import json
import logging
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import medfilt

import eeg_pipeline as P

log = logging.getLogger("electrodes")
VERSION = 1

# 19 électrodes du système 10-20, dans l'ordre de lecture habituel
ELECTRODES = ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8", "T3", "C3", "Cz", "C4", "T4",
              "T5", "P3", "Pz", "P4", "T6", "O1", "O2"]
CHANNELS = ["EEG" + e for e in ELECTRODES]
REGIONS = {"frontale": ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8"], "centrale": ["C3", "Cz", "C4"],
           "temporale": ["T3", "T4", "T5", "T6"], "pariétale": ["P3", "Pz", "P4"], "occipitale": ["O1", "O2"]}
# position sur la tête (vue de dessus, nez en haut), pour les cartes
POS = {"Fp1": (-0.30, 0.86), "Fp2": (0.30, 0.86), "F7": (-0.72, 0.52), "F3": (-0.38, 0.47), "Fz": (0, 0.45),
       "F4": (0.38, 0.47), "F8": (0.72, 0.52), "T3": (-0.88, 0), "C3": (-0.44, 0), "Cz": (0, 0), "C4": (0.44, 0),
       "T4": (0.88, 0), "T5": (-0.72, -0.52), "P3": (-0.38, -0.47), "Pz": (0, -0.45), "P4": (0.38, -0.47),
       "T6": (0.72, -0.52), "O1": (-0.30, -0.86), "O2": (0.30, -0.86)}
CORRUPTIONS = {
    "plat": "ligne plate (électrode muette)",
    "bruit": "fort bruit blanc",
    "secteur": "parasite secteur à 50 Hz",
    "derive": "décalage continu et lente dérive",
    "sauts": "« pops » intermittents (sauts avec décroissance)",
    "deconnexion": "déconnexion simulée (bruit de très forte amplitude)",
}
REFERENCES = {"originale": "référence d'origine de l'enregistrement", "moyenne": "moyenne commune (CAR)",
              "cz": "référence Cz (Cz devient nulle et sort de la moyenne)"}


# ==========================================================================
# 1. Caractéristiques par voie (même calcul que P.extract_features, sans la moyenne finale)
# ==========================================================================
def per_channel_features(X, fs):
    """X : signal brut (n_échantillons, n_voies). Renvoie (n_fenêtres, n_voies, 17) dans l'ordre P.FEATURES.
    Chaque voie est traitée indépendamment : médiane retirée, passe-bande, fenêtres de 2 s à 50 %."""
    n_win_samp = int(round(P.WIN_S * fs))
    step = int(round(n_win_samp * (1 - P.OVERLAP)))
    starts = np.arange(0, len(X) - n_win_samp + 1, step)
    X = P.bandpass(X - np.median(X, axis=0), fs)
    hann = np.hanning(n_win_samp)
    freqs = np.fft.rfftfreq(n_win_samp, 1 / fs)
    df_hz = freqs[1] - freqs[0]
    band_idx = {b: (freqs >= lo) & (freqs < hi) for b, (lo, hi) in P.BANDS.items()}
    total_idx = (freqs >= 0.5) & (freqs < 30)
    out = np.empty((len(starts), X.shape[1], len(P.FEATURES)), dtype=np.float64)
    for j in range(X.shape[1]):
        w = sliding_window_view(X[:, j], n_win_samp)[::step][:len(starts)]
        f = {"Mean": w.mean(1), "Std": w.std(1), "Variance": w.var(1), "Min": w.min(1), "Max": w.max(1)}
        f["Amplitude"] = f["Max"] - f["Min"]
        f["RMS"] = np.sqrt((w ** 2).mean(1))
        f["Energy"] = (w ** 2).sum(1)
        psd = np.abs(np.fft.rfft((w - w.mean(1, keepdims=True)) * hann, axis=1)) ** 2 / (fs * (hann ** 2).sum())
        total = psd[:, total_idx].sum(1) * df_hz
        for b, idx in band_idx.items():
            f[f"P_{b}"] = psd[:, idx].sum(1) * df_hz
            f[f"Rel_{b}"] = f[f"P_{b}"] / (total + 1e-12)
        f["Peak_Freq"] = freqs[total_idx][psd[:, total_idx].argmax(1)]
        for k, name in enumerate(P.FEATURES):
            out[:, j, k] = f[name]
    return out, starts, n_win_samp


# ---- pannes simulées, appliquées au signal brut d'UNE voie (graine fixe par voie et par type)
def corrupt(x, fs, kind, seed):
    rng = np.random.default_rng(seed)
    x = np.asarray(x, np.float64)
    t = np.arange(len(x)) / fs
    sigma = 1.4826 * np.median(np.abs(x - np.median(x))) + 1e-6          # amplitude typique (robuste)
    if kind == "plat":
        return np.full_like(x, np.median(x))
    if kind == "bruit":
        return x + rng.normal(0, 4 * sigma, len(x))
    if kind == "secteur":
        return x + 150.0 * np.sin(2 * np.pi * 50 * t + rng.uniform(0, 2 * np.pi))
    if kind == "derive":
        return x + 400.0 + 300.0 * np.sin(2 * np.pi * 0.02 * t) + 0.5 * t
    if kind == "sauts":
        y = x.copy()
        tk = rng.exponential(15.0)
        while tk < t[-1]:
            amp = rng.choice([-1, 1]) * rng.uniform(400, 900)
            i0, i1 = int(tk * fs), min(len(y), int((tk + 10.0) * fs))      # au-delà de 10 s, la décroissance est négligeable
            y[i0:i1] += amp * np.exp(-(t[i0:i1] - tk) / 1.0)
            tk += rng.exponential(15.0)
        return y
    if kind == "deconnexion":
        return x + rng.normal(0, 30 * sigma, len(x)) + 300.0 * np.sin(2 * np.pi * 50 * t)
    raise ValueError(kind)


def seed_of(rid, ch, kind):
    return (sum(ord(c) * (i + 1) for i, c in enumerate(f"{rid}|{ch}|{kind}")) * 2654435761) % (2 ** 32)


# ==========================================================================
# 2. Contexte : enregistrements, annotations, modèles « sans l'enregistrement »
# ==========================================================================
def recordings(data_dir):
    """{rid: chemin} des enregistrements locaux (même motif que le notebook et l'application)."""
    return {P.recording_id(f): f for f in sorted(Path(data_dir).glob("*_0000d.mat"))}


def load_truth(data_dir, recs_rows):
    """Annotations traitées comme dans le notebook : doublons, durées aberrantes, crises hors tracé."""
    xlsx = next(iter(sorted(Path(data_dir).glob("*nnotation*.xlsx"))))
    seiz, meta = P.load_annotations(xlsx)
    seiz = P.drop_outside(seiz, recs_rows)
    return seiz, meta


def cache_path(cache_dir, rid, path):
    st = Path(path).stat()
    return Path(cache_dir) / f"voies__{rid}__{st.st_size}-{int(st.st_mtime)}__v{VERSION}.npz"


def build_cache(rid, path, cache_dir, seizures, progress=None):
    """Caractéristiques par voie de l'enregistrement : intactes, deux re-références, et chaque panne
    sur chaque voie. Calculé une fois, gardé dans .cache/electrodes/."""
    out = cache_path(cache_dir, rid, path)
    if out.exists():
        return out
    df, fs = P.load_eeg(path)
    missing = [c for c in CHANNELS if c not in df.columns]
    if missing:
        raise ValueError(f"{rid} : voies absentes {missing}")
    X = df[CHANNELS].values.astype(np.float64)
    df = P.add_class(df[["Time"]].copy(), seizures, rid)
    starts, n_w, cls, frac = P.segment(df, fs)
    base, st, _ = per_channel_features(X, fs)
    assert np.array_equal(st, starts)
    arrays = {"base": base.astype(np.float32), "t_start": starts / fs, "t_end": (starts + n_w) / fs,
              "cls": cls.astype(np.int8), "fs": np.array(fs), "hours": np.array((len(X) - 1) / fs / 3600)}
    car = X - X.mean(axis=1, keepdims=True)
    arrays["moyenne"] = per_channel_features(car, fs)[0].astype(np.float32)
    cz = X - X[:, [CHANNELS.index("EEGCz")]]
    arrays["cz"] = per_channel_features(cz, fs)[0].astype(np.float32)
    for kind in CORRUPTIONS:
        if progress:
            progress(f"{rid} : panne « {kind} » sur chaque voie")
        Y = np.column_stack([corrupt(X[:, j], fs, kind, seed_of(rid, CHANNELS[j], kind)) for j in range(len(CHANNELS))])
        arrays[f"c_{kind}"] = per_channel_features(Y, fs)[0].astype(np.float32)
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    np.savez(out, **arrays)
    return out


class Study:
    """Charge les caches par voie et les modèles ; évalue des scénarios de panne."""

    def __init__(self, data_dir, cache_dir, models_dir, dataset_csv, progress=None):
        self.data_dir, self.cache_dir, self.models_dir = Path(data_dir), Path(cache_dir), Path(models_dir)
        self.dataset = pd.read_csv(dataset_csv)
        self.ids = sorted(set(self.dataset["Recording"]))
        paths = recordings(data_dir)
        self.paths = {r: paths[r] for r in self.ids}
        rows = {}
        for rid, pth in paths.items():
            tt, _ = P._read_timetable(pth)
            rows[rid] = int(tt.numRows)
        self.seizures, self.meta = load_truth(data_dir, rows)
        self.truth = {r: [(float(a), float(b)) for a, b in P.seizure_table(self.seizures, r)[["Début (s)", "Fin (s)"]].values]
                      for r in self.ids}
        self.data = {}
        for k, rid in enumerate(self.ids):
            if progress:
                progress(k, len(self.ids), f"caractéristiques par voie : {rid}")
            f = build_cache(rid, self.paths[rid], self.cache_dir, self.seizures,
                            (lambda m: progress(k, len(self.ids), m)) if progress else None)
            z = np.load(f)
            self.data[rid] = {k2: z[k2] for k2 in z.files}
        self.models = {}
        self.models_med = {}

    # ---- modèles
    def model(self, rid):
        if rid not in self.models:
            from sklearn import __version__ as skv
            path = self.models_dir / f"sans_{rid}__sklearn{skv}.joblib"
            if not path.exists():
                raise FileNotFoundError(f"Modèle « sans {rid} » absent ({path.name}) : lancez une fois l'application.")
            self.models[rid] = joblib.load(path)
        return self.models[rid]

    def model_median(self, rid, cache_dir=None):
        """Variante robuste : même Random Forest, entraîné « sans l'enregistrement » sur la MÉDIANE des voies."""
        if rid in self.models_med:
            return self.models_med[rid]
        from sklearn import __version__ as skv
        d = Path(cache_dir or self.cache_dir) / "modeles_mediane"
        d.mkdir(parents=True, exist_ok=True)
        train_ids = [r for r in self.ids if r != rid]
        import hashlib
        tag = hashlib.sha1(" ".join(train_ids).encode()).hexdigest()[:10]     # le jeu d'entraînement fait partie de la clé
        path = d / f"sans_{rid}__{len(train_ids)}enr-{tag}__sklearn{skv}__v{VERSION}.joblib"
        if path.exists():
            self.models_med[rid] = joblib.load(path)
            return self.models_med[rid]
        Xs = [np.median(self.data[r]["base"], axis=1) for r in self.ids if r != rid]
        ys = [self.data[r]["cls"] for r in self.ids if r != rid]
        model = P.make_models()["Random Forest"].fit(np.vstack(Xs), np.concatenate(ys))
        joblib.dump(model, path, compress=3)
        self.models_med[rid] = model
        return model

    # ---- scénarios
    def features(self, rid, sc):
        """Matrice (fenêtres × 17) d'un scénario : {removed: [...], corrupt: {électrode: type}, ref, robust}."""
        d = self.data[rid]
        ref = sc.get("ref", "originale")
        F = (d["base"] if ref == "originale" else d["moyenne"] if ref == "moyenne" else d["cz"]).copy()
        for e, kind in (sc.get("corrupt") or {}).items():
            j = ELECTRODES.index(e)
            F[:, j, :] = d[f"c_{kind}"][:, j, :]       # panne simulée sur la référence d'origine de la voie
        keep = np.array([e not in set(sc.get("removed") or []) for e in ELECTRODES])
        if ref == "cz":
            keep[ELECTRODES.index("Cz")] = False
        if not keep.any():
            raise ValueError("Toutes les électrodes sont retirées.")
        F = F[:, keep, :].astype(np.float64)
        return np.median(F, axis=1) if sc.get("robust") else F.mean(axis=1)

    def detect(self, rid, proba):
        d = self.data[rid]
        raw = (proba > 0.5).astype(int)
        sm = medfilt(raw, P.SMOOTH).astype(int) if P.SMOOTH > 1 else raw
        return raw, P.windows_to_intervals(d["t_start"], d["t_end"], sm)

    def evaluate(self, scenarios, progress=None, reference=None, model_of=None):
        """Évalue une liste de scénarios ; renvoie un résumé par scénario et par enregistrement.
        Pour chaque enregistrement, toutes les fenêtres de tous les scénarios passent en un seul appel au modèle."""
        per = {i: {} for i in range(len(scenarios))}
        for k, rid in enumerate(self.ids):
            if progress:
                progress(k, len(self.ids), f"détection sur {rid}")
            groups = {False: [], True: []}
            for i, sc in enumerate(scenarios):
                groups[bool(sc.get("robust"))].append(i)
            for robust, idx in groups.items():
                if not idx:
                    continue
                # model_of : autre jeu de modèles « sans l'enregistrement » (par exemple augmentés)
                model = model_of(rid) if model_of else (self.model_median(rid) if robust else self.model(rid))
                mats = [self.features(rid, scenarios[i]) for i in idx]
                proba = model.predict_proba(np.vstack(mats))[:, 1]
                n = len(mats[0])
                for q, i in enumerate(idx):
                    p = proba[q * n:(q + 1) * n]
                    raw, ev = self.detect(rid, p)
                    per[i][rid] = {"raw": raw, "events": ev}
        intact = reference or {rid: per[0][rid]["events"] for rid in self.ids}
        return [self.summarize(per[i], intact) for i in range(len(scenarios))]

    def summarize(self, res, intact):
        tot = {"n_true": 0, "detected": 0, "false_alarms": 0, "hours": 0.0, "tp": 0, "fp": 0, "fn": 0, "kept": 0, "orig": 0}
        delays, recs = [], []
        for rid in self.ids:
            d, r = self.data[rid], res[rid]
            m = P.match_events(self.truth[rid], r["events"])
            det = m[m["Résultat"] == "Détectée"]
            fa = int((m["Résultat"] == "Fausse alarme").sum())
            y, raw = d["cls"], r["raw"]
            tot["tp"] += int(((raw == 1) & (y == 1)).sum()); tot["fp"] += int(((raw == 1) & (y == 0)).sum())
            tot["fn"] += int(((raw == 0) & (y == 1)).sum())
            kept = sum(1 for a, b in intact[rid] if any(a < f and b > e for e, f in r["events"]))
            tot["kept"] += kept; tot["orig"] += len(intact[rid])
            tot["n_true"] += len(self.truth[rid]); tot["detected"] += int(len(det)); tot["false_alarms"] += fa
            tot["hours"] += float(d["hours"])
            dl = [float(v) for v in det["Retard début (s)"]] if len(det) else []
            delays += dl
            recs.append({"id": rid, "n_true": len(self.truth[rid]), "detected": int(len(det)), "false_alarms": fa,
                         "stability": kept / len(intact[rid]) if intact[rid] else 1.0,
                         "events": [[float(a), float(b)] for a, b in r["events"]]})
        prec = tot["tp"] / (tot["tp"] + tot["fp"]) if tot["tp"] + tot["fp"] else 0.0
        rec = tot["tp"] / (tot["tp"] + tot["fn"]) if tot["tp"] + tot["fn"] else 0.0
        return {"detected": tot["detected"], "n_true": tot["n_true"], "false_alarms": tot["false_alarms"],
                "sensitivity": tot["detected"] / tot["n_true"], "fa_per_hour": tot["false_alarms"] / tot["hours"],
                "mean_delay": float(np.mean(delays)) if delays else None,
                "f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0,
                "stability": tot["kept"] / tot["orig"] if tot["orig"] else 1.0, "recordings": recs}


# ==========================================================================
# 3. Liste des scénarios de l'étude
# ==========================================================================
def study_scenarios(seed=42, reps=10, ks=(1, 2, 4, 6, 8, 10)):
    rng = np.random.default_rng(seed)
    S = [{"name": "intact", "family": "intact"}]
    S += [{"name": f"sans {e}", "family": "retrait_une", "electrode": e, "removed": [e]} for e in ELECTRODES]
    for k in ks:
        for r in range(reps):
            rem = sorted(rng.choice(ELECTRODES, k, replace=False).tolist(), key=ELECTRODES.index)
            S.append({"name": f"{k} retirées (tirage {r + 1})", "family": "retrait_k", "k": k, "rep": r + 1, "removed": rem})
    S += [{"name": f"sans la région {g}", "family": "retrait_region", "region": g, "removed": es} for g, es in REGIONS.items()]
    S += [{"name": f"{kind} sur {e}", "family": "panne", "kind": kind, "electrode": e, "corrupt": {e: kind}}
          for kind in CORRUPTIONS for e in ELECTRODES]
    S += [{"name": f"référence {r}", "family": "reference", "ref": r} for r in ("moyenne", "cz")]
    robust = [{"name": "intact (médiane)", "family": "robuste_intact", "robust": True}]
    robust += [{"name": f"{kind} sur {e} (médiane)", "family": "robuste_panne", "kind": kind, "electrode": e,
                "corrupt": {e: kind}, "robust": True} for kind in CORRUPTIONS for e in ELECTRODES]
    return S + robust
