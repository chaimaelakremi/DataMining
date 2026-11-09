"""
Application de démonstration : visualisation EEG et détection automatique
des crises d'absence. Backend FastAPI.

Lancer :  uvicorn app:app --port 8000
"""
import json
import logging
import re
import threading
import time
import uuid
import warnings
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import eeg_pipeline as P
import exam_journal as JOURNAL
import analyses as AN
import recherche as RECH
import anticipation as ANT

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"            # lecture seule
RES_DIR = ROOT / "resultats"        # lecture seule
CACHE_DIR = ROOT / ".cache"
STATIC_DIR = ROOT / "static"
NOTEBOOK = ROOT / "EEG_Absence_Detection.ipynb"

for sub in ("features", "models", "overview", "uploads"):
    (CACHE_DIR / sub).mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("app")
P.log.setLevel(logging.INFO)

STEPS = ["Chargement", "Filtrage", "Fenêtrage", "Caractéristiques", "Classification", "Reconstruction"]


def _file_key(path: Path) -> str:
    st = path.stat()
    return f"{st.st_size}-{int(st.st_mtime)}"


# ==========================================================================
# Catalogue des enregistrements (local + importés)
# ==========================================================================
class Catalog:
    def __init__(self):
        self.recs = OrderedDict()   # id -> dict(path, duration, fs, channels, source)
        self.lock = threading.Lock()

    def _probe(self, path: Path):
        tt, row_times = P._read_timetable(path)
        names = [str(n) for n in np.atleast_1d(tt.varNames)]
        samples_per_row = np.atleast_1d(np.atleast_1d(tt.data)[0][0]).size
        row_dt = np.median(np.diff(row_times)) / 1000.0 if row_times is not None and row_times.size > 1 else 1.0
        return {"rows": int(tt.numRows), "fs": float(samples_per_row / row_dt), "names": names,
                "n_samples": int(tt.numRows) * int(samples_per_row)}

    def scan(self):
        index_file = CACHE_DIR / "index.json"
        index = json.loads(index_file.read_text()) if index_file.exists() else {}
        # même motif que le notebook : '*_0000d.mat' (ignore les copies du type '..._0000d(1).mat')
        for f in sorted(DATA_DIR.glob("*_0000d.mat")):
            key = f"{f.name}:{_file_key(f)}"
            if key not in index:
                log.info("Lecture de l'en-tête de %s", f.name)
                index[key] = self._probe(f)
            self._add(P.recording_id(f), f, index[key], "local")
        for f in sorted((CACHE_DIR / "uploads").glob("*.mat")):
            key = f"upload/{f.name}:{_file_key(f)}"
            try:
                if key not in index:
                    index[key] = self._probe(f)
                self._add(f.stem.split("__", 1)[0], f, index[key], "upload")
            except Exception as e:      # fichier importé illisible : ignoré
                log.warning("Import ignoré (%s) : %s", f.name, e)
        index_file.write_text(json.dumps(index))

    def _add(self, rid, path, probe, source):
        eeg = [n for n in probe["names"] if n.startswith("EEG")]
        self.recs[rid] = {"id": rid, "path": path, "rows": probe["rows"], "fs": probe["fs"],
                          "duration": probe["n_samples"] / probe["fs"], "all_channels": probe["names"],
                          "channels": eeg, "source": source}

    def reference_channels(self, ids):
        # électrodes communes aux enregistrements `ids` (ceux qui ont servi à l'entraînement)
        local = [r["channels"] for rid, r in self.recs.items() if r["source"] == "local" and rid in ids]
        return [c for c in local[0] if all(c in ch for ch in local[1:])] if local else []

    def get(self, rid):
        r = self.recs.get(rid)
        if r is None:
            raise HTTPException(404, f"Enregistrement inconnu : {rid}")
        return r


CATALOG = Catalog()
CATALOG.scan()

# ---- Annotations (même traitement que le notebook) ----------------------
ANNOT_FILE = next(iter(sorted(DATA_DIR.glob("*nnotation*.xlsx"))), None)
SEIZURES, META = P.load_annotations(ANNOT_FILE)
SEIZURES = P.drop_outside(SEIZURES, {rid: r["rows"] for rid, r in CATALOG.recs.items() if r["source"] == "local"})
ANNOTATED = set(SEIZURES["ID"])
META = META.set_index("ID")

# ---- Jeu de caractéristiques du notebook -------------------------------
DATASET = pd.read_csv(RES_DIR / "features_windows.csv")
MODELS_CSV = pd.read_csv(RES_DIR / "resultats_modeles.csv")
DETECT_CSV = pd.read_csv(RES_DIR / "detection_par_enregistrement.csv")


# ---- Journal d'examen (fichiers _0000h.mat, lecture seule) ---------------
_JOURNALS = {}
_JOURNAL_LOCK = threading.Lock()


def journal_path(rid):
    r = CATALOG.get(rid)
    if r["source"] != "local":
        return None
    h = r["path"].with_name(r["path"].name.replace("_0000d.mat", "_0000h.mat"))
    return h if h.exists() else None


def journal_events(rid):
    """Événements du journal (mis en mémoire). [] si le fichier _0000h est absent ou illisible."""
    path = journal_path(rid)
    if path is None:
        return []
    key = f"{path.name}:{_file_key(path)}"
    with _JOURNAL_LOCK:
        if key not in _JOURNALS:
            try:
                _JOURNALS[key] = JOURNAL.load_journal(path)
            except Exception as e:
                log.warning("Journal illisible (%s) : %s", path.name, e)
                _JOURNALS[key] = []
        return _JOURNALS[key]


def truth_intervals(rid):
    if rid not in ANNOTATED or CATALOG.get(rid)["source"] != "local":
        return []
    t = P.seizure_table(SEIZURES, rid)
    return [(float(s), float(e)) for s, e in zip(t["Début (s)"], t["Fin (s)"])]


# ==========================================================================
# Modèles
# ==========================================================================
class ModelStore:
    """Modèle complet (best_model.joblib) + modèles « sans l'enregistrement X »."""

    def __init__(self):
        self.lock = threading.Lock()
        self._full = None
        self._full_source = None
        self._template = None
        self.features = P.FEATURES
        self.best_name = str(MODELS_CSV.loc[MODELS_CSV["F1-score"].idxmax(), MODELS_CSV.columns[0]])

    def _load_saved(self):
        if self._template is not None:
            return
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                saved = joblib.load(RES_DIR / "best_model.joblib")
            versions = {str(w.message).split("from version ")[-1].split(" when")[0]
                        for w in caught if "InconsistentVersionWarning" in type(w.message).__name__}
            if versions:
                from sklearn import __version__ as skv
                log.warning("best_model.joblib a été sauvegardé avec scikit-learn %s (local : %s) ; "
                            "chargé quand même, vérification de prédiction ci-dessous", ", ".join(versions), skv)
            model = saved["model"]
            # vérification minimale : le modèle doit pouvoir prédire
            model.predict_proba(DATASET[saved["features"]].values[:2])
            self.features = list(saved["features"])
            self._full, self._full_source = model, "best_model.joblib"
            self._template = model
            log.info("best_model.joblib chargé : %s", type(model[-1]).__name__ if hasattr(model, "__getitem__") else model)
        except Exception as e:
            log.warning("best_model.joblib illisible (%s) : ré-entraînement du pipeline '%s' depuis "
                        "features_windows.csv", e, self.best_name)
            self._template = P.make_models()[self.best_name]
            self._full = None
            self._full_source = "ré-entraîné (features_windows.csv)"

    def model_name(self):
        self._load_saved()
        est = self._template[-1] if hasattr(self._template, "__getitem__") else self._template
        names = {"RandomForestClassifier": "Random Forest", "DecisionTreeClassifier": "Decision Tree",
                 "KNeighborsClassifier": "KNN", "SVC": "SVM"}
        return names.get(type(est).__name__, type(est).__name__)

    def full(self):
        """Modèle entraîné sur tous les enregistrements annotés (pour les fichiers importés)."""
        from sklearn.base import clone
        with self.lock:
            self._load_saved()
            if self._full is None:
                path = CACHE_DIR / "models" / "full.joblib"
                if path.exists():
                    self._full = joblib.load(path)
                else:
                    self._full = clone(self._template).fit(DATASET[self.features].values, DATASET["Class"].values)
                    joblib.dump(self._full, path, compress=3)
            n = DATASET["Recording"].nunique()
            return self._full, {"source": self._full_source, "trained_on": int(n),
                                "n_windows": int(len(DATASET)), "excluded": None}

    def leave_one_out(self, rid):
        """Même type de modèle, ré-entraîné sans l'enregistrement `rid` (aucune fuite)."""
        from sklearn import __version__ as skv
        from sklearn.base import clone
        with self.lock:
            self._load_saved()
            others = DATASET[DATASET["Recording"] != rid]
            info = {"source": "clone(best_model) ré-entraîné sans cet enregistrement",
                    "trained_on": int(others["Recording"].nunique()),
                    "n_windows": int(len(others)), "excluded": rid}
            path = CACHE_DIR / "models" / f"sans_{rid}__sklearn{skv}.joblib"
            if path.exists():
                return joblib.load(path), info, True
            model = clone(self._template).fit(others[self.features].values, others["Class"].values)
            joblib.dump(model, path, compress=3)
            return model, info, False


MODELS = ModelStore()


# ==========================================================================
# Enregistrements chargés en mémoire (LRU, 2 maximum)
# ==========================================================================
class Loaded:
    def __init__(self, rid):
        r = CATALOG.get(rid)
        df, fs = P.load_eeg(r["path"])
        self.df, self.fs = df, fs
        self.channels = P.eeg_channels(df)
        self.n = len(df)
        self.all_channels = [c for c in df.columns if c != "Time"]
        self.filtered = None
        self.extra = {}
        self.lock = threading.Lock()

    def ensure_filtered(self):
        # même prétraitement que extract_features : médiane retirée puis passe-bande 0,5–40 Hz
        with self.lock:
            if self.filtered is None:
                X = self.df[self.channels].values.astype(np.float64)
                self.filtered = P.bandpass(X - np.median(X, axis=0), self.fs).astype(np.float32)
        return self.filtered

    def columns(self, chans, filtered=True, i0=0, i1=None):
        """Segment (n, k) des voies `chans` : filtrées (même traitement que l'EEG) ou brutes.
        Les voies non EEG (ECG, SLI) sont filtrées à la demande, une seule fois."""
        i1 = self.n if i1 is None else i1
        out = np.empty((i1 - i0, len(chans)), dtype=np.float32)
        for k, c in enumerate(chans):
            if not filtered:
                out[:, k] = self.df[c].values[i0:i1]
            elif c in self.channels:
                out[:, k] = self.ensure_filtered()[i0:i1, self.channels.index(c)]
            else:
                with self.lock:
                    if c not in self.extra:
                        x = self.df[c].values.astype(np.float64)
                        self.extra[c] = P.bandpass(x - np.median(x), self.fs).astype(np.float32)
                out[:, k] = self.extra[c][i0:i1]
        return out


class LRU:
    def __init__(self, size=2):
        self.size, self.items, self.lock = size, OrderedDict(), threading.Lock()
        self.pending = {}

    def get(self, rid) -> Loaded:
        with self.lock:
            if rid in self.items:
                self.items.move_to_end(rid)
                return self.items[rid]
            ev = self.pending.get(rid)
            owner = ev is None
            if owner:
                ev = self.pending[rid] = threading.Event()
        if not owner:
            ev.wait()
            return self.get(rid)
        try:
            obj = Loaded(rid)
            with self.lock:
                self.items[rid] = obj
                while len(self.items) > self.size:
                    old, _ = self.items.popitem(last=False)
                    log.info("Libération mémoire : %s", old)
            return obj
        finally:
            with self.lock:
                self.pending.pop(rid, None)
            ev.set()


STORE = LRU(2)


# ==========================================================================
# Caractéristiques (cache disque)
# ==========================================================================
def features_cache_path(rid):
    r = CATALOG.get(rid)
    return CACHE_DIR / "features" / f"{rid}__{_file_key(r['path'])}.csv"


_SEGMENT_LOCK = threading.Lock()


def compute_features(rid, rec: Loaded):
    path = features_cache_path(rid)
    if path.exists():
        return pd.read_csv(path), True
    df = rec.df.copy()
    df = P.add_class(df, SEIZURES, rid) if CATALOG.get(rid)["source"] == "local" else df.assign(Class=np.int8(0))
    with _SEGMENT_LOCK:
        feats = P.extract_features(df, rec.fs, rec.channels, rid)
    feats.to_csv(path, index=False)
    return feats, False


# ---- Autres tailles de fenêtre (5 s, 10 s…) : mêmes fonctions, jeux d'entraînement du notebook ----
# La chaîne à 2 s ci-dessus n'est pas modifiée. Pour une autre taille, on réutilise
# P.extract_features en lui faisant appeler P.segment avec cette taille (comme dans le notebook),
# et on entraîne le même type de modèle sur resultats_local/features_windows_{N}s.csv.
LOCAL_DIR = ROOT / "resultats_local"
_WIN_DATASETS = {}


def _win_csv(win_s):
    return LOCAL_DIR / f"features_windows_{win_s:g}s.csv"


def analysis_windows():
    """Tailles de fenêtre proposées : celle du notebook, plus celles dont le jeu d'entraînement existe."""
    extra = []
    for path in sorted(LOCAL_DIR.glob("features_windows_*s.csv")):
        m = re.fullmatch(r"features_windows_(\d+(?:\.\d+)?)s\.csv", path.name)
        if m and float(m.group(1)) != P.WIN_S:
            extra.append(float(m.group(1)))
    return [P.WIN_S] + sorted(extra)


def _dataset_win(win_s):
    path = _win_csv(win_s)
    key = _file_key(path)
    if _WIN_DATASETS.get(win_s, (None,))[0] != key:
        _WIN_DATASETS[win_s] = (key, pd.read_csv(path))
    return _WIN_DATASETS[win_s][1]


def compute_features_win(rid, rec: Loaded, win_s):
    r = CATALOG.get(rid)
    path = CACHE_DIR / "features" / f"{rid}__{_file_key(r['path'])}__w{win_s:g}.csv"
    if path.exists():
        return pd.read_csv(path), True
    df = rec.df.copy()
    df = P.add_class(df, SEIZURES, rid) if r["source"] == "local" else df.assign(Class=np.int8(0))
    with _SEGMENT_LOCK:
        original = P.segment
        P.segment = lambda d, f: original(d, f, win_s=win_s, overlap=P.OVERLAP)
        try:
            feats = P.extract_features(df, rec.fs, rec.channels, rid)
        finally:
            P.segment = original
    feats.to_csv(path, index=False)
    return feats, False


def model_win(rid, win_s):
    """Même type de modèle que la chaîne à 2 s, entraîné sur les fenêtres de `win_s` secondes,
    sans l'enregistrement `rid` s'il fait partie du jeu d'entraînement."""
    from sklearn import __version__ as skv
    from sklearn.base import clone
    data = _dataset_win(win_s)
    inside = rid in set(data["Recording"])
    train = data[data["Recording"] != rid] if inside else data
    info = {"source": f"même modèle, entraîné sur les fenêtres de {win_s:g} s du notebook"
                      + (" sans cet enregistrement" if inside else ""),
            "trained_on": int(train["Recording"].nunique()), "n_windows": int(len(train)),
            "excluded": rid if inside else None}
    name = f"sans_{rid}" if inside else "full"
    path = CACHE_DIR / "models" / f"{name}__w{win_s:g}__{_file_key(_win_csv(win_s))}__sklearn{skv}.joblib"
    with MODELS.lock:
        MODELS._load_saved()
        if path.exists():
            return joblib.load(path), info, True
        model = clone(MODELS._template).fit(train[MODELS.features].values, train["Class"].values)
        joblib.dump(model, path, compress=3)
        return model, info, False


# ==========================================================================
# Tâches de détection (exécutées en arrière-plan, suivies par polling)
# ==========================================================================
JOBS = {}
EXECUTOR = ThreadPoolExecutor(max_workers=1)


def _clean(v):
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else round(float(v), 3)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


def detect_recording(rid, step=lambda i, detail="": None, win_s=None):
    """Chaîne complète sur un enregistrement (celle de l'écran Analyse).
    Enregistrement annoté du jeu d'entraînement → modèle ré-entraîné sans lui ; sinon modèle complet."""
    t0 = time.time()
    r = CATALOG.get(rid)
    step(0, r["path"].name)
    rec = STORE.get(rid)
    step(1, "médiane retirée, passe-bande 0,5–40 Hz")
    rec.ensure_filtered()
    win = P.WIN_S if win_s is None else float(win_s)
    alt = win != P.WIN_S                          # autre taille que celle du notebook
    step(2, f"fenêtres de {win:g} s, recouvrement {int(P.OVERLAP * 100)} %")
    starts, n_win_samp, _, _ = P.segment(rec.df.assign(Class=0), rec.fs, win_s=win)
    step(3, f"{len(starts)} fenêtres × {len(rec.channels)} voies")
    feats, cached = compute_features_win(rid, rec, win) if alt else compute_features(rid, rec)

    if alt:
        step(4, f"{MODELS.model_name()} entraîné sur les fenêtres de {win:g} s")
        model, minfo, mcached = model_win(rid, win)
    elif r["source"] == "local" and rid in set(DATASET["Recording"]):
        step(4, f"{MODELS.model_name()} ré-entraîné sans {rid}")
        model, minfo, mcached = MODELS.leave_one_out(rid)
    else:
        step(4, f"{MODELS.model_name()} complet")
        model, minfo = MODELS.full()
        mcached = True
    minfo["name"] = MODELS.model_name()
    minfo["cached"] = mcached

    step(5, f"lissage médian sur {P.SMOOTH} fenêtres, fusion < {P.MERGE_GAP_S:g} s, min {P.MIN_EVENT_S:g} s")
    d_rec, raw, sm, events, proba = P.detect_with_model(feats, model, MODELS.features)
    truth = truth_intervals(rid)

    result = {
        "id": rid,
        "model": minfo,
        "params": {"win_s": win, "overlap": P.OVERLAP, "smooth": P.SMOOTH,
                   "min_event_s": P.MIN_EVENT_S, "merge_gap_s": P.MERGE_GAP_S},
        "windows": {
            "t_start": d_rec["t_start"].round(3).tolist(),
            "t_end": d_rec["t_end"].round(3).tolist(),
            "proba": np.round(proba, 4).tolist(),
            "pred": [int(x) for x in raw],
            "smoothed": [int(x) for x in sm],
        },
        "intervals": [{"n": k, "start": float(s), "end": float(e), "duration": round(float(e - s), 2)}
                      for k, (s, e) in enumerate(events, 1)],
        "n_channels": len(rec.channels),
        "train_channels": len(CATALOG.reference_channels(set(DATASET["Recording"]))),
        "annotated": bool(truth),
        "truth": [{"n": k, "start": s, "end": e, "duration": round(e - s, 2)} for k, (s, e) in enumerate(truth, 1)],
    }
    if truth:
        m = P.match_events(truth, events)
        rows = [{k: _clean(v) for k, v in row.items()} for row in m.to_dict("records")]
        det = m[m["Résultat"] == "Détectée"]
        n_fa = int((m["Résultat"] == "Fausse alarme").sum())
        hours = (rec.n - 1) / rec.fs / 3600          # comme le notebook : eeg["Time"].iloc[-1] / 3600
        result["match"] = rows
        result["totals"] = {
            "n_true": len(truth), "detected": int(len(det)),
            "missed": int((m["Résultat"] == "Manquée").sum()), "false_alarms": n_fa,
            "fa_per_hour": round(n_fa / hours, 2),
            "mean_start_delay": _clean(det["Retard début (s)"].mean()) if len(det) else None,
            "mean_abs_start_delay": _clean(det["Retard début (s)"].abs().mean()) if len(det) else None,
            "mean_end_gap": _clean(det["Écart fin (s)"].mean()) if len(det) else None,
        }
        # statut de chaque intervalle détecté (vraie détection / fausse alarme)
        for iv in result["intervals"]:
            iv["hit"] = any(iv["start"] < te and iv["end"] > ts for ts, te in truth)
    # contexte de l'examen (journal _0000h) : n'intervient pas dans la détection
    result["context"] = JOURNAL.context_lines(journal_events(rid), truth, events) if journal_events(rid) else None
    result["elapsed_s"] = round(time.time() - t0, 2)
    return result


def run_detection(job_id, rid, win_s=None):
    job = JOBS[job_id]

    def step(i, detail=""):
        job.update(step=i, step_name=STEPS[i], detail=detail)
        log.info("[%s] %s %s", rid, STEPS[i], detail)

    try:
        result = detect_recording(rid, step, win_s)
        job.update(status="done", step=len(STEPS), step_name="Terminé", result=result)
    except Exception as e:
        log.exception("Échec de la détection pour %s", rid)
        job.update(status="error", error=str(e))


# ==========================================================================
# API
# ==========================================================================
app = FastAPI(title="Détection des crises d'absence")


def _meta(rid):
    r = CATALOG.get(rid)
    m = META.loc[rid] if (r["source"] == "local" and rid in META.index) else None
    sexe = None if m is None or pd.isna(m["Sexe"]) else str(m["Sexe"]).strip()
    age = None if m is None or pd.isna(m["Age"]) else float(m["Age"])
    type_abs = None if m is None or pd.isna(m["TypeAbs"]) else str(m["TypeAbs"])
    truth = truth_intervals(rid)
    return {"id": rid, "source": r["source"], "duration": round(r["duration"], 3), "fs": r["fs"],
            "n_eeg": len(r["channels"]), "annotated": bool(truth), "n_seizures": len(truth),
            "sex": sexe, "age": age, "type_abs": type_abs,
            "has_journal": journal_path(rid) is not None,
            "in_training_set": bool(r["source"] == "local" and rid in set(DATASET["Recording"]))}


@app.get("/api/recordings")
def list_recordings():
    return [_meta(rid) for rid in CATALOG.recs]


@app.get("/api/recordings/{rid}")
def recording(rid: str):
    r = CATALOG.get(rid)
    out = _meta(rid)
    out.update(channels=r["channels"], all_channels=r["all_channels"],
               seizures=[{"n": k, "start": s, "end": e, "duration": round(e - s, 2)}
                         for k, (s, e) in enumerate(truth_intervals(rid), 1)])
    return out


def excerpt(rid, start, end, chans=None, width=1200, filtered=True):
    """Extrait [start, end] des voies demandées, décimé en min/max au-delà de 2 × width points."""
    rec = STORE.get(rid)
    chans = rec.channels if not chans else [c for c in chans if c in rec.all_channels]
    i0 = max(0, int(np.floor(start * rec.fs)))
    i1 = min(rec.n, int(np.ceil(end * rec.fs)))
    base = {"start": start, "end": end, "t0": i0 / rec.fs, "channels": chans, "filtered": filtered}
    if i1 - i0 < 2:
        return {**base, "mode": "raw", "dt": 1 / rec.fs, "data": {c: [] for c in chans}}
    seg = rec.columns(chans, filtered, i0, i1)
    n = i1 - i0
    if n <= 2 * width:
        data = {c: np.round(seg[:, k], 2).tolist() for k, c in enumerate(chans)}
        return {**base, "mode": "raw", "dt": 1 / rec.fs, "data": data}
    # décimation min/max : ~width colonnes, un minimum et un maximum par colonne
    edges = np.linspace(0, n, width + 1).astype(int)
    edges = edges[:-1][np.diff(edges) > 0]
    mn = np.minimum.reduceat(seg, edges, axis=0)
    mx = np.maximum.reduceat(seg, edges, axis=0)
    data = {c: {"min": np.round(mn[:, k], 2).tolist(), "max": np.round(mx[:, k], 2).tolist()}
            for k, c in enumerate(chans)}
    return {**base, "mode": "minmax", "dt": (n / len(edges)) / rec.fs, "data": data}


def _check_range(start, end):
    if not (np.isfinite(start) and np.isfinite(end)) or end <= start:
        raise HTTPException(400, "Intervalle invalide : il faut start < end.")
    if end - start > 3600:
        raise HTTPException(400, "Intervalle trop long (1 h maximum par requête).")


@app.get("/api/recordings/{rid}/signal")
def signal(rid: str, start: float = 0.0, end: float = 10.0, channels: str | None = None,
           width: int = Query(1200, ge=16, le=8000), filtered: bool = True):
    """Fenêtre visible du signal. Par défaut : voies EEG filtrées (médiane retirée, 0,5–40 Hz).
    `channels` peut aussi nommer une voie non EEG (ECG) ; `filtered=false` renvoie le signal brut."""
    CATALOG.get(rid)
    _check_range(start, end)
    return excerpt(rid, start, end, channels.split(",") if channels else None, width, filtered)


@app.get("/api/recordings/{rid}/journal")
def journal(rid: str):
    """[{time_s, label, type, …}] ; type ∈ {yeux, hpn, sli, saturation, autre}.
    HPN et SLI regroupés en intervalles (end_s, steps). [] sans fichier _0000h."""
    CATALOG.get(rid)
    return journal_events(rid)


@app.get("/api/recordings/{rid}/overview")
def overview(rid: str):
    r = CATALOG.get(rid)
    path = CACHE_DIR / "overview" / f"{rid}__{_file_key(r['path'])}.json"
    if path.exists():
        return JSONResponse(json.loads(path.read_text()))
    rec = STORE.get(rid)
    X = rec.ensure_filtered()
    fs = int(round(rec.fs))
    n_sec = rec.n // fs
    sq = (X[: n_sec * fs].astype(np.float64) ** 2).reshape(n_sec, fs, X.shape[1])
    rms = np.sqrt(sq.mean(axis=1)).mean(axis=1)            # RMS par seconde, moyenné sur les voies EEG
    # amplitude typique (écart-type robuste médian sur les voies) → échelle par défaut du tracé
    mad = np.median(np.abs(X - np.median(X, axis=0)), axis=0) * 1.4826
    out = {"id": rid, "step_s": 1.0, "rms": np.round(rms, 2).tolist(),
           "typical_uv": round(float(np.median(mad)), 2)}
    path.write_text(json.dumps(out))
    return out


@app.get("/api/analysis-windows")
def analysis_windows_api():
    return {"default": P.WIN_S, "windows": analysis_windows()}


@app.post("/api/recordings/{rid}/detect")
def detect(rid: str, win: float | None = None):
    CATALOG.get(rid)
    if win is not None and win not in analysis_windows():
        raise HTTPException(400, f"Taille de fenêtre indisponible : {win:g} s. Exécutez le notebook pour produire son jeu d'entraînement.")
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"id": job_id, "recording": rid, "status": "running", "step": 0,
                    "step_name": STEPS[0], "detail": "", "steps": STEPS}
    EXECUTOR.submit(run_detection, job_id, rid, win)
    return {"job": job_id, "steps": STEPS}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche inconnue")
    return job


MAX_UPLOAD = 600 * 1024 * 1024     # un enregistrement de 80 min pèse ~ 150 Mo


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    # `def` (et non `async def`) : la lecture du .mat s'exécute dans un thread, sans bloquer le serveur
    name = Path(file.filename or "").name
    m = re.match(r"^([A-Za-z0-9]+)_([A-Za-z0-9]+)_0000d(?:\s*\(\d+\))?\.mat$", name)
    if not m:
        raise HTTPException(400, "Nom de fichier attendu : <ID>_<lettre>_0000d.mat "
                                 "(fichier de données, pas l’en-tête _0000h).")
    base = f"{m.group(1)}-{m.group(2)}"
    rid = f"import-{base}"
    k = 2
    while rid in CATALOG.recs:
        rid, k = f"import-{base}-{k}", k + 1
    dest = CACHE_DIR / "uploads" / f"{rid}__{uuid.uuid4().hex[:6]}.mat"
    size = 0
    try:
        with dest.open("wb") as out:
            while chunk := file.file.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, f"Fichier trop volumineux (> {MAX_UPLOAD >> 20} Mo).")
                out.write(chunk)
        if size < 128 or not dest.read_bytes()[:19] == b"MATLAB 5.0 MAT-file":
            raise HTTPException(400, "Ce n’est pas un fichier MATLAB .mat (version 5) valide.")
        try:
            probe = CATALOG._probe(dest)
        except Exception as e:
            raise HTTPException(400, f"Timetable MATLAB illisible : {e}")
        eeg = [n for n in probe["names"] if n.startswith("EEG")]
        missing = [c for c in CATALOG.reference_channels(set(DATASET["Recording"])) if c not in eeg]
        if missing:
            raise HTTPException(400, f"Voies EEG manquantes par rapport aux enregistrements du projet : "
                                     f"{', '.join(missing)}")
        if not 100 <= probe["fs"] <= 2000:
            raise HTTPException(400, f"Fréquence d’échantillonnage inattendue : {probe['fs']:.1f} Hz.")
        if probe["n_samples"] / probe["fs"] < 10:
            raise HTTPException(400, "Enregistrement trop court (moins de 10 s).")
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as e:
        dest.unlink(missing_ok=True)
        log.exception("Import échoué")
        raise HTTPException(500, f"Import impossible : {e}")
    CATALOG._add(rid, dest, probe, "upload")
    log.info("Import : %s (%s, %.0f s) → %s", name, rid, probe["n_samples"] / probe["fs"], dest.name)
    return _meta(rid)


def _notebook_groupkfold():
    """Lit, dans les sorties du notebook, la comparaison découpage aléatoire / GroupKFold."""
    try:
        nb = json.loads(NOTEBOOK.read_text())
        for cell in nb["cells"]:
            for o in cell.get("outputs", []):
                txt = "".join(o.get("data", {}).get("text/plain", o.get("text", "")))
                if "(par enregistrement)" not in txt:
                    continue
                rows = {}
                for line in txt.splitlines():
                    mm = re.match(r"^(.*?)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*$", line)
                    if mm:
                        rows[mm.group(1).strip()] = dict(zip(["Accuracy", "Precision", "Recall", "F1-score"],
                                                             map(float, mm.groups()[1:])))
                rnd = next((v for k, v in rows.items() if "(par enregistrement)" not in k), None)
                grp = next((v for k, v in rows.items() if "(par enregistrement)" in k), None)
                name = next((k for k in rows if "(par enregistrement)" not in k), None)
                if rnd and grp:
                    return {"model": name, "random": rnd, "groupkfold": grp,
                            "source": f"{NOTEBOOK.name} (sortie de la validation GroupKFold)"}
    except Exception as e:
        log.warning("Lecture du notebook impossible : %s", e)
    return None


@app.get("/api/models")
def models():
    mc = MODELS_CSV.rename(columns={MODELS_CSV.columns[0]: "Modèle"})
    return {"models": mc.to_dict("records"),
            "detection": DETECT_CSV.to_dict("records"),
            "groupkfold": _notebook_groupkfold(),
            "best": MODELS.best_name}



# ==========================================================================
# Analyses du notebook (resultats_local/) : tableaux et figures, en lecture seule
# ==========================================================================
@app.get("/api/recherche")
def recherche():
    return RECH.bundle()


@app.get("/api/anticipation")
def anticipation():
    return ANT.bundle()


@app.get("/api/recherche/figure/{key}")
def recherche_figure(key: str):
    path = RECH.figure_path(key)
    if path is None:
        raise HTTPException(404, "Figure introuvable : relancez le notebook pour la produire.")
    return FileResponse(path, media_type="image/png")


# ==========================================================================
# Cohorte : détection « sans l'enregistrement » sur tous les tracés, puis
# validation GroupKFold. Calculées une fois en arrière-plan, mises en cache.
# ==========================================================================
COHORT_VERSION = 2
THUMB_CHANNELS = ["EEGFp1", "EEGF3", "EEGC3", "EEGP3", "EEGO1"]
NEAR_S = JOURNAL.NEAR_SATURATION_S
COHORT = {"status": "idle", "done": 0, "total": 0, "current": None, "elapsed_s": 0.0, "data": None, "error": None}
GKF = {"status": "idle", "fold": 0, "n_splits": 0, "elapsed_s": 0.0, "data": None, "error": None}
_WORKER_LOCK = threading.Lock()


def _cache_key():
    from sklearn import __version__ as skv
    return f"v{COHORT_VERSION}-sklearn{skv}-{_file_key(RES_DIR / 'features_windows.csv')}"


def _cohort_ids():
    annotated = [rid for rid, r in CATALOG.recs.items() if r["source"] == "local" and rid in set(DATASET["Recording"])]
    others = [rid for rid, r in CATALOG.recs.items() if r["source"] == "local" and rid not in annotated]
    # 230102B-F d'abord : c'est l'enregistrement des pages Comprendre et Méthode
    annotated.sort(key=lambda r: (r != "230102B-F", r))
    return annotated, others


def _journal_overlap(journal, start, end):
    sats = [e for e in journal if e["type"] == "saturation" and start - NEAR_S <= e["time_s"] <= end + NEAR_S]
    chans = []
    for e in sats:
        chans += [c for c in e["channels"] if c not in chans]
    groups = [e for e in journal if e["type"] in ("hpn", "sli") and e["time_s"] < end and e["end_s"] > start]
    # remarques libres du technicien à proximité (« absence », « BOUGE », « ARTEFACT »…)
    notes = [e["label"] for e in journal if e["type"] == "autre" and e["time_s"] > 1
             and start - NEAR_S <= e["time_s"] <= end + NEAR_S]
    return {"saturation": chans, "saturation_n": len(sats), "notes": notes,
            "hpn": any(g["type"] == "hpn" for g in groups), "sli": any(g["type"] == "sli" for g in groups)}


def _thumbnail(rec, start, end, pad=5.0, width=220):
    t0, t1 = max(0.0, start - pad), min((rec.n - 1) / rec.fs, end + pad)
    chans = [c for c in THUMB_CHANNELS if c in rec.channels] or rec.channels[:5]
    i0, i1 = int(t0 * rec.fs), int(t1 * rec.fs)
    mode, data, factor = AN.decimate_minmax(rec.columns(chans, True, i0, i1), width)
    return {"t0": i0 / rec.fs, "t1": i1 / rec.fs, "dt": factor / rec.fs, "mode": mode,
            "channels": [c.replace("EEG", "") for c in chans], **data}


def _error_items(rid, res, rec):
    journal = journal_events(rid)
    items = []
    missed = [(r["Début réel"], r["Fin réelle"], r["Crise réelle"]) for r in res.get("match", []) if r["Résultat"] == "Manquée"]
    fas = [(iv["start"], iv["end"], iv["n"]) for iv in res["intervals"] if not iv.get("hit")]
    for kind, lst in (("manquee", missed), ("fausse_alarme", fas)):
        for s, e, n in lst:
            X = rec.columns(rec.channels, True, int(s * rec.fs), int(e * rec.fs))
            items.append({"recording": rid, "type": kind, "n": int(n), "start": float(s), "end": float(e),
                          "duration": round(float(e) - float(s), 2), **AN.segment_stats(X, rec.fs),
                          "journal": _journal_overlap(journal, s, e) if journal else None,
                          "has_journal": bool(journal), "thumb": _thumbnail(rec, s, e)})
    return items


def _cohort_entry(rid, res, rec):
    feats, _ = compute_features(rid, rec)
    feats = feats.sort_values("t_start")
    m = _meta(rid)
    truth = res["truth"]
    return {
        "id": rid, "sex": m["sex"], "age": m["age"], "type_abs": m["type_abs"], "duration": m["duration"],
        "hours": (rec.n - 1) / rec.fs / 3600, "n_channels": len(rec.channels), "annotated": bool(truth),
        "truth": [[t["start"], t["end"]] for t in truth],
        "detections": [[iv["start"], iv["end"], bool(iv.get("hit", False))] for iv in res["intervals"]],
        "totals": res.get("totals"),
        "model": res["model"],
        "windows": {"t_start": res["windows"]["t_start"], "pred": res["windows"]["pred"],
                    "smoothed": res["windows"]["smoothed"], "class": [int(c) for c in feats["Class"]]},
        "errors": _error_items(rid, res, rec) if truth else [],
    }


def _run_cohort():
    path = CACHE_DIR / f"cohort__{_cache_key()}.json"
    if path.exists():
        COHORT.update(status="done", data=json.loads(path.read_text()))
        return
    annotated, others = _cohort_ids()
    ids = annotated + others
    COHORT.update(status="running", total=len(ids), done=0, error=None)
    t0 = time.time()
    entries = []
    for k, rid in enumerate(ids):
        COHORT.update(current=rid, done=k, elapsed_s=round(time.time() - t0, 1))
        log.info("Cohorte %d/%d : %s", k + 1, len(ids), rid)
        res = detect_recording(rid)
        entries.append(_cohort_entry(rid, res, STORE.get(rid)))
    data = {"key": _cache_key(), "computed_in_s": round(time.time() - t0, 1), "recordings": entries}
    path.write_text(json.dumps(data))
    COHORT.update(status="done", done=len(ids), current=None, elapsed_s=data["computed_in_s"], data=data)
    log.info("Cohorte calculée en %.0f s", data["computed_in_s"])


def _run_groupkfold():
    """Même procédure que la cellule GroupKFold du notebook, sur features_windows.csv."""
    from sklearn.base import clone
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
    from sklearn.model_selection import GroupKFold
    path = CACHE_DIR / f"groupkfold__{_cache_key()}.json"
    if path.exists():
        GKF.update(status="done", data=json.loads(path.read_text()))
        return
    MODELS._load_saved()
    X = DATASET[MODELS.features].values
    y = DATASET["Class"].values
    groups = DATASET["Recording"].values
    n_splits = min(5, len(np.unique(groups)))
    GKF.update(status="running", fold=0, n_splits=n_splits, error=None)
    t0 = time.time()
    y_pred = np.zeros_like(y)
    folds = []
    for k, (tr, te) in enumerate(GroupKFold(n_splits=n_splits).split(X, y, groups), 1):
        GKF.update(fold=k, elapsed_s=round(time.time() - t0, 1))
        log.info("GroupKFold : pli %d/%d", k, n_splits)
        model = clone(MODELS._template).fit(X[tr], y[tr])
        y_pred[te] = model.predict(X[te])
        folds.append(sorted(set(groups[te])))
    sc = {"Accuracy": accuracy_score(y, y_pred), "Precision": precision_score(y, y_pred, zero_division=0),
          "Recall": recall_score(y, y_pred, zero_division=0), "F1-score": f1_score(y, y_pred, zero_division=0)}
    best = MODELS_CSV.rename(columns={MODELS_CSV.columns[0]: "Modèle"}).set_index("Modèle").loc[MODELS.best_name]
    data = {"model": MODELS.model_name(), "n_splits": n_splits, "folds": folds,
            "n_windows": int(len(y)), "n_recordings": int(len(np.unique(groups))),
            "groupkfold": {k: round(float(v), 4) for k, v in sc.items()},
            "random": {k: round(float(best[k]), 4) for k in ("Accuracy", "Precision", "Recall", "F1-score")},
            "notebook": _notebook_groupkfold(), "computed_in_s": round(time.time() - t0, 1)}
    path.write_text(json.dumps(data))
    GKF.update(status="done", elapsed_s=data["computed_in_s"], data=data)


def _background_worker():
    with _WORKER_LOCK:
        for name, fn, state in (("cohorte", _run_cohort, COHORT), ("GroupKFold", _run_groupkfold, GKF)):
            try:
                fn()
            except Exception as e:
                log.exception("Échec du calcul %s", name)
                state.update(status="error", error=str(e))


def start_background():
    if COHORT["status"] in ("idle", "error") or GKF["status"] in ("idle", "error"):
        threading.Thread(target=_background_worker, daemon=True, name="cohorte").start()


def _progress(state, extra=()):
    return {k: state.get(k) for k in ("status", "done", "total", "current", "fold", "n_splits", "elapsed_s", "error") + tuple(extra)
            if k in state}


def _require(state):
    if state["status"] != "done":
        if state["status"] in ("idle", "error"):
            start_background()
        return _progress(state)
    return None


# ==========================================================================
# Endpoints des pages (lecture seule)
# ==========================================================================
def _csv_check(entries):
    """Compare la détection recalculée par l'application avec detection_par_enregistrement.csv."""
    csv = DETECT_CSV.set_index("Enregistrement")
    same, diff = [], []
    for e in entries:
        if not e["annotated"] or e["id"] not in csv.index:
            continue
        T, c = e["totals"], csv.loc[e["id"]]
        app_v = {"Crises réelles": T["n_true"], "Détectées": T["detected"], "Manquées": T["missed"],
                 "Fausses alarmes": T["false_alarms"]}
        csv_v = {k: int(c[k]) for k in app_v}
        (same if app_v == csv_v else diff).append({"id": e["id"], "app": app_v, "csv": csv_v})
    return {"same": len(same), "diff": diff, "n": len(same) + len(diff)}


def _evaluation(entries):
    """Évaluation « sans l'enregistrement » : par fenêtre (brut / lissé) et par événement."""
    ann = [e for e in entries if e["annotated"]]
    if not ann:
        return None
    y = np.concatenate([e["windows"]["class"] for e in ann])
    raw = np.concatenate([e["windows"]["pred"] for e in ann])
    sm = np.concatenate([e["windows"]["smoothed"] for e in ann])
    tot = {k: sum(e["totals"][k] for e in ann) for k in ("n_true", "detected", "missed", "false_alarms")}
    hours = sum(e["hours"] for e in ann)
    return {"windows_raw": AN.window_scores(y, raw), "windows_smoothed": AN.window_scores(y, sm),
            "n_windows": int(len(y)), "events": {**tot, "hours": round(hours, 3),
                                                 "sensitivity": tot["detected"] / tot["n_true"] if tot["n_true"] else None,
                                                 "fa_per_hour": tot["false_alarms"] / hours if hours else None,
                                                 "zero_fa": sum(1 for e in ann if e["totals"]["false_alarms"] == 0),
                                                 "with_missed": [e["id"] for e in ann if e["totals"]["missed"]]},
            "n_recordings": len(ann)}


@app.get("/api/cohort")
def cohort():
    wait = _require(COHORT)
    if wait:
        return wait
    entries = COHORT["data"]["recordings"]
    recs = []
    for e in entries:
        durs = [b - a for a, b in e["truth"]]
        recs.append({k: e[k] for k in ("id", "sex", "age", "type_abs", "duration", "hours", "n_channels",
                                        "annotated", "truth", "detections", "totals")}
                    | {"mean_seizure_s": round(float(np.mean(durs)), 2) if durs else None,
                       "n_detections": len(e["detections"]), "model": e["model"]["source"]})
    return {"status": "done", "computed_in_s": COHORT["data"]["computed_in_s"], "recordings": recs,
            "evaluation": _evaluation(entries), "csv_check": _csv_check(entries)}


@app.get("/api/errors")
def errors():
    wait = _require(COHORT)
    if wait:
        return wait
    items = [it for e in COHORT["data"]["recordings"] for it in e["errors"]]
    items.sort(key=lambda it: (it["type"] != "manquee", it["recording"], it["start"]))
    return {"status": "done", "tolerance_s": NEAR_S, "items": items}


@app.get("/api/groupkfold")
def groupkfold():
    wait = _require(GKF)
    if wait:
        return wait
    return {"status": "done", **GKF["data"]}


_JOURNAL_STATS = {}


def _journal_stats():
    """Sur les enregistrements annotés munis d'un journal : crises pendant l'hyperpnée / la SLI."""
    if _JOURNAL_STATS:
        return _JOURNAL_STATS
    out = {"recordings": 0, "seizures": 0, "seconds": 0.0}
    for kind in ("hpn", "sli"):
        out[kind] = {"seizures": 0, "seconds": 0.0, "recordings": 0}
    for rid, r in CATALOG.recs.items():
        truth = truth_intervals(rid) if r["source"] == "local" else []
        journal = journal_events(rid) if truth else []
        if not journal:
            continue
        out["recordings"] += 1
        out["seizures"] += len(truth)
        out["seconds"] += r["duration"]
        for kind in ("hpn", "sli"):
            groups = [g for g in journal if g["type"] == kind]
            if groups:
                out[kind]["recordings"] += 1
            out[kind]["seconds"] += sum(g["end_s"] - g["time_s"] for g in groups)
            out[kind]["seizures"] += sum(1 for s, e in truth if any(s < g["end_s"] and e > g["time_s"] for g in groups))
    _JOURNAL_STATS.update(out)
    return out


@app.get("/api/summary")
def summary():
    """Chiffres de la page d'accueil et de la page Limites, tous calculés à partir des données."""
    local = [rid for rid, r in CATALOG.recs.items() if r["source"] == "local"]
    ann = [rid for rid in local if truth_intervals(rid)]
    durs = [e - s for rid in ann for s, e in truth_intervals(rid)]
    ages = [_meta(r)["age"] for r in ann if _meta(r)["age"] is not None]
    sexes = [_meta(r)["sex"] for r in ann if _meta(r)["sex"]]
    types = [_meta(r)["type_abs"] for r in ann if _meta(r)["type_abs"]]
    MODELS._load_saved()
    est = MODELS._template[-1] if hasattr(MODELS._template, "__getitem__") else MODELS._template
    params = {k: v for k, v in est.get_params().items()
              if k in ("n_estimators", "min_samples_leaf", "class_weight", "max_depth", "n_neighbors", "C", "kernel")}
    best = MODELS_CSV.rename(columns={MODELS_CSV.columns[0]: "Modèle"}).set_index("Modèle").loc[MODELS.best_name]
    out = {
        "patients": None,          # aucun identifiant patient dans les données : non calculable
        "recordings": len(local), "annotated": len(ann), "unannotated": len(local) - len(ann),
        "seizures": len(durs),
        "seizure_s": {"min": min(durs), "median": float(np.median(durs)), "max": max(durs)} if durs else None,
        "hours_total": sum(CATALOG.recs[r]["duration"] for r in local) / 3600,
        "recording_min": {"min": min(CATALOG.recs[r]["duration"] for r in local) / 60,
                          "max": max(CATALOG.recs[r]["duration"] for r in local) / 60},
        "ages": {"min": min(ages), "median": float(np.median(ages)), "max": max(ages),
                 "adults": sum(1 for a in ages if a >= 18), "n": len(ages)} if ages else None,
        "sex": {s: sexes.count(s) for s in sorted(set(sexes))},
        "type_abs": {t: types.count(t) for t in sorted(set(types))},
        "windows": int(len(DATASET)), "seizure_windows": int(DATASET["Class"].sum()),
        "eeg_channels": len(CATALOG.reference_channels(set(DATASET["Recording"]))),
        "params": {"win_s": P.WIN_S, "overlap": P.OVERLAP, "smooth": P.SMOOTH, "min_event_s": P.MIN_EVENT_S,
                   "merge_gap_s": P.MERGE_GAP_S, "features": len(MODELS.features)},
        "best_model": {"name": MODELS.best_name, "f1_random": float(best["F1-score"]),
                       "recall_random": float(best["Recall"]), "params": params,
                       "n_models": int(len(MODELS_CSV))},
        "journal": _journal_stats(),
        "cohort": _progress(COHORT), "groupkfold": _progress(GKF),
    }
    if COHORT["status"] == "done":
        out["evaluation"] = _evaluation(COHORT["data"]["recordings"])
        errs = [it for e in COHORT["data"]["recordings"] for it in e["errors"]]
        fa = [it for it in errs if it["type"] == "fausse_alarme"]
        out["errors"] = {"false_alarms": len(fa), "missed": len(errs) - len(fa), "tolerance_s": NEAR_S,
                         "fa_near_saturation": sum(1 for it in fa if it["journal"] and it["journal"]["saturation"]),
                         "fa_with_journal": sum(1 for it in fa if it["journal"] is not None)}
    if GKF["status"] == "done":
        out["groupkfold_scores"] = GKF["data"]["groupkfold"]
    else:
        _require(GKF)
    return out


def _cohort_entry_for(rid):
    if COHORT["status"] != "done":
        return None
    return next((e for e in COHORT["data"]["recordings"] if e["id"] == rid), None)


@app.get("/api/comprendre")
def comprendre(rid: str = "230102B-F"):
    """Extraits réels choisis par calcul : une crise bien rythmée, un fond normal, une saturation, l'ECG."""
    r = CATALOG.get(rid)
    rec = STORE.get(rid)
    fs, dur = rec.fs, (rec.n - 1) / rec.fs
    truth = truth_intervals(rid)
    journal = journal_events(rid)
    show = [c for c in ["EEGFp1", "EEGFp2", "EEGF3", "EEGF4", "EEGC3", "EEGC4", "EEGO1", "EEGO2"] if c in rec.channels]
    L = 8.0
    seg = lambda a: rec.columns(rec.channels, True, int(a * fs), int((a + L) * fs))
    out = {"id": rid, "length_s": L, "channels": show, "n_eeg": len(rec.channels)}

    # --- crise : parmi les crises d'au moins 8 s, la plus rythmée (pic net entre 2 et 5 Hz)
    cands = [(s, e) for s, e in truth if e - s >= L + 0.5] or sorted(truth, key=lambda t: t[0] - t[1])[:1]
    if cands:
        scored = []
        for s, e in cands:
            a = max(s, (s + e) / 2 - L / 2)
            ratio, _ = AN.rhythmicity(seg(a), fs)
            scored.append((ratio, a, s, e))
        ratio, a, s, e = max(scored)
        X = seg(a)
        f, res = AN.dominant_frequency(X, fs)
        Xs = rec.columns(show, True, int(a * fs), int((a + L) * fs))
        out["seizure"] = {"start": a, "end": a + L, "seizure": [s, e], "dominant_hz": round(f, 2),
                          "resolution_hz": round(res, 3), "rhythmicity": round(ratio, 3),
                          "spike_wave": AN.spike_and_wave(Xs, fs, f, a),
                          "n_candidates": len(cands),
                          "excerpt": excerpt(rid, a, a + L, show, 1100)}

    # --- fond normal : loin des crises (≥ 20 s), hors HPN / SLI, sans événement du journal à moins de 10 s ;
    #     on garde l'extrait dont le RMS est le plus proche de la médiane (un fond typique)
    groups = [g for g in journal if g["type"] in ("hpn", "sli")]
    points = [e["time_s"] for e in journal if e["type"] in ("saturation", "autre") and e["time_s"] > 1]
    normal = []
    for a in np.arange(10.0, dur - L - 10, 2.0):
        b = a + L
        if any(a < e + 20 and b > s - 20 for s, e in truth):
            continue
        if any(a < g["end_s"] and b > g["time_s"] for g in groups) or any(a - 10 < t < b + 10 for t in points):
            continue
        X = seg(a)
        normal.append((float(np.sqrt((X.astype(np.float64) ** 2).mean(axis=0)).mean()), float(a)))
    if normal:
        med = float(np.median([n for n, _ in normal]))
        rms, a = min(normal, key=lambda t: abs(t[0] - med))
        f, res = AN.dominant_frequency(seg(a), fs)
        out["normal"] = {"start": a, "end": a + L, "dominant_hz": round(f, 2), "rms_uv": round(rms, 1),
                         "n_candidates": len(normal), "excerpt": excerpt(rid, a, a + L, show, 1100)}
        if "seizure" in out:
            Xs = seg(out["seizure"]["start"]).astype(np.float64)
            out["seizure"]["rms_uv"] = round(float(np.sqrt((Xs ** 2).mean(axis=0)).mean()), 1)

    # --- saturation tirée du journal : touche au moins une voie EEG, à plus de 15 s d'une crise annotée
    sats = [e for e in journal if e["type"] == "saturation"
            and any("EEG" + c in rec.channels for c in e["channels"]) and e["time_s"] >= 10
            and not any(e["time_s"] > s - 15 and e["time_s"] < t + 15 for s, t in truth)]
    if sats:
        ev = sats[0]
        sat_ch = ["EEG" + c for c in ev["channels"] if "EEG" + c in rec.channels]
        neigh = [c for c in ["EEGF3", "EEGCz", "EEGF4", "EEGC3"] if c in rec.channels and c not in sat_ch][:3]
        a, b = max(0.0, ev["time_s"] - 8), min(dur, ev["time_s"] + 2)
        entry = _cohort_entry_for(rid)
        near = [d for d in (entry["detections"] if entry else []) if d[0] - NEAR_S <= ev["time_s"] <= d[1] + NEAR_S]
        out["saturation"] = {"time_s": ev["time_s"], "label": ev["label"], "channels": ev["channels"], "tolerance_s": NEAR_S,
                             "eeg_channels": sat_ch, "start": a, "end": b,
                             "n_events": sum(1 for e in journal if e["type"] == "saturation"),
                             "near_detection": [{"n": k + 1, "start": d[0], "end": d[1], "hit": d[2]}
                                                for k, d in enumerate(entry["detections"]) if d in near] if entry else None,
                             "excerpt": excerpt(rid, a, b, sat_ch + neigh, 1100)}

    # --- ECG : pendant le fond normal, rythme cardiaque mesuré
    if "ECG" in rec.all_channels and "normal" in out:
        a = out["normal"]["start"]
        ecg = rec.columns(["ECG"], True, int(a * fs), int((a + L) * fs))[:, 0]
        bpm, peaks, cv = AN.heart_rate(ecg, fs)
        out["ecg"] = {"start": a, "end": a + L, "bpm": round(bpm, 0) if bpm else None,
                      "beats": len(peaks), "rr_cv": round(cv, 3) if cv is not None else None,
                      "peaks": [round(a + t, 3) for t in peaks],
                      "excerpt": excerpt(rid, a, a + L, ["ECG", "EEGT3", "EEGT4"], 1100)}

    # --- protocole de l'examen
    out["protocol"] = {"duration": dur, "truth": [[s, e] for s, e in truth],
                       "events": [{k: v for k, v in e.items() if k != "steps"} | ({"steps": len(e["steps"])} if "steps" in e else {})
                                  for e in journal if e["type"] in ("yeux", "hpn", "sli")],
                       "cohort": _journal_stats()}
    return out


def _mains_share(rec, a, b):
    """Part de la puissance du signal brut (voies EEG, moyenne retirée) au-dessus de la bande utile et autour du pic secteur."""
    X = rec.columns(rec.channels, False, int(a * rec.fs), int(b * rec.fs)).astype(np.float64)
    f, psd = AN.mean_psd(X, rec.fs)
    tot = psd[f > 0.5].sum()
    hi = f > _bandpass_params()["hi"]
    peak = float(f[hi][np.argmax(psd[hi])]) if hi.any() else None
    near = (f >= peak - 1) & (f <= peak + 1) if peak else np.zeros_like(f, bool)
    return {"above_band_pct": round(float(psd[hi].sum() / tot * 100), 1), "peak_hz": round(peak, 2) if peak else None,
            "peak_pct": round(float(psd[near].sum() / tot * 100), 1)}


def _bandpass_params():
    import inspect
    d = {k: v.default for k, v in inspect.signature(P.bandpass).parameters.items() if v.default is not inspect._empty}
    return {"lo": d.get("lo"), "hi": d.get("hi"), "order": d.get("order")}


@app.get("/api/methode")
def methode(rid: str = "230102B-F"):
    """Étapes de la chaîne illustrées sur un enregistrement, autour de sa première crise annotée."""
    CATALOG.get(rid)
    truth = truth_intervals(rid)
    if not truth:
        raise HTTPException(400, "Enregistrement non annoté : choisissez un tracé avec au moins une crise annotée.")
    rec = STORE.get(rid)
    fs = rec.fs
    s0, e0 = truth[0]
    a, b = float(max(0, np.floor(s0 - 8))), float(min((rec.n - 1) / fs, np.ceil(e0 + 5)))
    chans = [c for c in ["EEGFp1", "EEGF3", "EEGC3", "EEGO1"] if c in rec.channels]
    feats, _ = compute_features(rid, rec)
    feats = feats.sort_values("t_start")
    win = feats[(feats["t_start"] >= a) & (feats["t_end"] <= b)]
    normal = win[(win["Seizure_frac"] == 0) & (win["t_end"] <= s0 - 2)]
    sz = win[win["Seizure_frac"] == 1]
    pick_n = normal.iloc[-1] if len(normal) else None
    pick_s = sz.iloc[(sz["t_start"] + 1 - (s0 + e0) / 2).abs().argsort().iloc[0]] if len(sz) else None

    def window_info(row):
        if row is None:
            return None
        i0 = int(round(row["t_start"] * fs)); i1 = i0 + int(round(P.WIN_S * fs))
        return {"window": int(row["Window"]), "t_start": float(row["t_start"]), "t_end": float(row["t_end"]),
                "frac": float(row["Seizure_frac"]), "features": {f: float(row[f]) for f in P.FEATURES},
                "spectrum": AN.window_spectrum(rec.columns(rec.channels, True, i0, i1), fs)}

    MODELS._load_saved()
    est = MODELS._template[-1] if hasattr(MODELS._template, "__getitem__") else MODELS._template
    others = DATASET[DATASET["Recording"] != rid]
    out = {
        "id": rid, "start": a, "end": b, "seizure": [s0, e0], "fs": fs, "channels": chans,
        "n_eeg": len(rec.channels),
        "raw": excerpt(rid, a, b, chans, 1100, filtered=False),
        "raw_power": _mains_share(rec, a, b),
        "filtered": excerpt(rid, a, b, chans, 1100),
        "windows": [{"n": int(r["Window"]), "t_start": float(r["t_start"]), "t_end": float(r["t_end"]),
                     "frac": round(float(r["Seizure_frac"]), 3), "cls": int(r["Class"])} for _, r in win.iterrows()],
        "params": {"win_s": P.WIN_S, "overlap": P.OVERLAP, "smooth": P.SMOOTH,
                   "min_event_s": P.MIN_EVENT_S, "merge_gap_s": P.MERGE_GAP_S,
                   "filter": _bandpass_params(), "features": len(P.FEATURES)},
        "normal": window_info(pick_n), "crise": window_info(pick_s),
        "model": {"name": MODELS.model_name(), "type": type(est).__name__,
                  "params": {k: v for k, v in est.get_params().items()
                             if k in ("n_estimators", "min_samples_leaf", "class_weight", "max_depth")},
                  "trained_on": int(others["Recording"].nunique()), "n_windows": int(len(others)),
                  "seizure_windows": int(others["Class"].sum())},
        "cohort": _progress(COHORT),
    }
    entry = _cohort_entry_for(rid)
    if entry is None:
        _require(COHORT)
    else:
        w = entry["windows"]
        out["detection"] = {"duration": entry["duration"], "t_start": w["t_start"], "pred": w["pred"],
                            "smoothed": w["smoothed"], "cls": w["class"],
                            "detections": entry["detections"], "truth": entry["truth"], "totals": entry["totals"]}
    return out


# ==========================================================================
# Laboratoire : démonstrations calculées en direct (endpoints /api/lab/…)
# ==========================================================================
import sys
import laboratoire as LAB

LAB.bind(sys.modules[__name__])
app.include_router(LAB.router)

# ---- Outils interactifs des pages Modèles, Patients, Limites (endpoints /api/tools/…)
import outils as TOOLS

TOOLS.bind(sys.modules[__name__], LAB)
app.include_router(TOOLS.router)

# ---- Études du notebook sur le site : Découverte (autoencodeur) et Laboratoire · Électrodes
import etudes_site as ETUDES

ETUDES.bind(sys.modules[__name__], TOOLS)
app.include_router(ETUDES.router)

# ---- Méthode : visite guidée de la chaîne (/api/methode/tour)
import methode_tour as TOUR

TOUR.bind(sys.modules[__name__])
app.include_router(TOUR.router)

# ---- Augmentation de données (Laboratoire · Augmentation, /api/augment/…)
import augmentation as AUGMENT

AUGMENT.bind(sys.modules[__name__], TOOLS, ETUDES, LAB)
ETUDES.AUG = AUGMENT
app.include_router(AUGMENT.router)


@app.on_event("startup")
def _startup():
    start_background()


@app.get("/")
def index():
    # jamais de copie en cache : le navigateur redemande toujours la page (sinon il peut garder une ancienne version)
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
