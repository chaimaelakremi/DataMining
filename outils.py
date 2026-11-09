"""
Outils interactifs des pages Modèles (« Banc d'essai »), Patients et Limites.

Tous les calculs longs passent par des tâches de fond (identifiant + suivi + annulation),
mises en cache selon leurs paramètres dans .cache/outils/ : un second lancement identique
est immédiat. Aucune fuite : un enregistrement annoté est toujours évalué par un modèle
entraîné sans lui (GroupKFold par enregistrement, ou un enregistrement laissé de côté).
La détection reprend les règles de eeg_pipeline (inchangé) : lissage médian, fusion, durée
minimale, puis confrontation aux annotations (match_events).
"""
import hashlib
import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from scipy.signal import medfilt

import eeg_pipeline as P

log = logging.getLogger("outils")
router = APIRouter(prefix="/api/tools")
A = None                                 # module app (renseigné par bind)
LAB = None                               # module laboratoire
OUT_DIR = None
VERSION = 1

SVM_MAX_TRAIN = 6000                     # SVM : ~50 s par entraînement sur tout le jeu ; sous-échantillon tiré au hasard
GROUPS = {
    "Taille du signal": ["Mean", "Std", "Variance", "Min", "Max", "Amplitude", "RMS", "Energy",
                         "P_Delta", "P_Theta", "P_Alpha", "P_Beta"],
    "Rythme": ["Rel_Delta", "Rel_Theta", "Rel_Alpha", "Rel_Beta", "Peak_Freq"],
}
# « Sans amplitude » retire aussi les puissances absolues par bande : elles croissent comme le carré de l'amplitude
AMPLITUDE = ["Std", "Variance", "Min", "Max", "Amplitude", "RMS", "Energy", "P_Delta", "P_Theta", "P_Alpha", "P_Beta"]
FREQUENCY = ["Rel_Delta", "Rel_Theta", "Rel_Alpha", "Rel_Beta", "Peak_Freq"]
MODELS = {
    "rf": "Random Forest", "et": "Extra Trees", "dt": "Arbre de décision", "knn": "KNN",
    "svm": "SVM", "logreg": "Régression logistique", "xgb": "XGBoost", "lgbm": "LightGBM",
}
REFERENCE = {"model": "rf", "hp": {"n_trees": 300, "max_depth": 0}, "win": 2, "features": list(P.FEATURES)}


def bind(app_module, lab_module):
    global A, LAB, OUT_DIR
    A, LAB = app_module, lab_module
    OUT_DIR = A.CACHE_DIR / "outils"
    OUT_DIR.mkdir(parents=True, exist_ok=True)


# ==========================================================================
# Tâches de fond : file d'attente, suivi, annulation, cache par paramètres
# ==========================================================================
class Cancelled(Exception):
    pass


JOBS = {}
EXEC = ThreadPoolExecutor(max_workers=1, thread_name_prefix="outils")   # un calcul lourd à la fois


def _key(kind, params):
    from sklearn import __version__ as skv
    blob = json.dumps({"kind": kind, "params": params, "v": VERSION, "sk": skv,
                       "data": A._file_key(A.RES_DIR / "features_windows.csv")}, sort_keys=True)
    return f"{kind}__{hashlib.sha1(blob.encode()).hexdigest()[:14]}"


class Job:
    def __init__(self, kind, params):
        self.id = uuid.uuid4().hex[:12]
        self.kind, self.params = kind, params
        self.state = {"id": self.id, "kind": kind, "status": "queued", "done": 0, "total": 1, "label": "En attente…",
                      "elapsed_s": 0.0, "error": None, "cached": False}
        self.cancel = threading.Event()
        self.t0 = None

    def progress(self, done, total, label=""):
        if self.cancel.is_set():
            raise Cancelled()
        self.state.update(done=done, total=total, label=label, elapsed_s=round(time.time() - self.t0, 1))


def submit(kind, params):
    if kind not in RUNNERS:
        raise HTTPException(400, f"Tâche inconnue : {kind}")
    params = RUNNERS[kind][1](params)                 # validation et valeurs par défaut
    job = Job(kind, params)
    path = OUT_DIR / f"{_key(kind, params)}.json"
    JOBS[job.id] = job
    if path.exists():
        job.state.update(status="done", cached=True, result=json.loads(path.read_text()), done=1, total=1, label="Relu dans le cache")
        return job

    def run():
        if job.cancel.is_set():
            job.state.update(status="cancelled", label="Annulé")
            return
        job.t0 = time.time()
        job.state.update(status="running", label="Démarrage…")
        try:
            res = RUNNERS[kind][0](job.params, job)
            res["computed_in_s"] = round(time.time() - job.t0, 1)
            path.write_text(json.dumps(res))
            job.state.update(status="done", result=res, elapsed_s=res["computed_in_s"], label="Terminé")
        except Cancelled:
            job.state.update(status="cancelled", label="Annulé")
        except HTTPException as e:
            job.state.update(status="error", error=e.detail)
        except Exception as e:
            log.exception("Échec de la tâche %s", kind)
            job.state.update(status="error", error=str(e))
    EXEC.submit(run)
    return job


class JobIn(BaseModel):
    kind: str
    params: dict = {}


@router.post("/jobs")
def jobs_create(q: JobIn):
    job = submit(q.kind, q.params)
    return {"job": job.id, "cached": job.state["cached"]}


@router.get("/jobs/{job_id}")
def jobs_get(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche inconnue")
    return job.state


@router.post("/jobs/{job_id}/cancel")
def jobs_cancel(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche inconnue")
    job.cancel.set()
    if job.state["status"] == "queued":
        job.state.update(status="cancelled", label="Annulé")
    return {"ok": True}


# ==========================================================================
# Données, modèles, évaluation
# ==========================================================================
def dataset(win):
    win = float(win)
    if win == P.WIN_S:
        return A.DATASET
    if win not in A.analysis_windows():
        raise HTTPException(400, f"Fenêtres de {win:g} s indisponibles : exécutez le notebook pour produire leur jeu.")
    return A._dataset_win(win)


def hours_of(rid):
    r = A.CATALOG.get(rid)
    return (r["duration"] * r["fs"] - 1) / r["fs"] / 3600       # comme l'application : (n − 1) / fs / 3600


def check_cfg(c):
    c = dict(c or {})
    c.setdefault("model", "rf")
    if c["model"] not in MODELS:
        raise HTTPException(400, f"Modèle inconnu : {c['model']}")
    hp = dict(c.get("hp") or {})
    c["hp"] = {k: float(v) for k, v in hp.items() if v is not None}
    c["win"] = float(c.get("win", 2))
    feats = [f for f in (c.get("features") or P.FEATURES) if f in P.FEATURES]
    if not feats:
        raise HTTPException(400, "Choisissez au moins une caractéristique.")
    c["features"] = [f for f in P.FEATURES if f in feats]            # ordre canonique (clé de cache stable)
    return c


def make_model(c, y_train=None):
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    hp, m = c["hp"], c["model"]
    depth = int(hp.get("max_depth", 0)) or None
    if m in ("rf", "et"):
        from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
        cls = RandomForestClassifier if m == "rf" else ExtraTreesClassifier
        est = cls(n_estimators=int(hp.get("n_trees", 300)), max_depth=depth, min_samples_leaf=2,
                  class_weight="balanced_subsample", n_jobs=-1, random_state=42)
    elif m == "dt":
        from sklearn.tree import DecisionTreeClassifier
        est = DecisionTreeClassifier(max_depth=int(hp.get("max_depth", 10)) or None, min_samples_leaf=5,
                                     class_weight="balanced", random_state=42)
    elif m == "knn":
        from sklearn.neighbors import KNeighborsClassifier
        est = KNeighborsClassifier(n_neighbors=int(hp.get("k", 7)), weights="distance")
    elif m == "svm":
        from sklearn.svm import SVC
        est = SVC(kernel="rbf", C=float(hp.get("C", 10)), gamma="scale", class_weight="balanced")
    elif m == "logreg":
        from sklearn.linear_model import LogisticRegression
        est = LogisticRegression(C=float(hp.get("C", 1)), max_iter=2000, class_weight="balanced", random_state=42)
    elif m == "xgb":
        from xgboost import XGBClassifier
        w = float((y_train == 0).sum() / max(1, (y_train == 1).sum())) if y_train is not None else 1.0
        est = XGBClassifier(n_estimators=int(hp.get("n_trees", 300)), max_depth=int(hp.get("max_depth", 6)) or 6,
                            learning_rate=0.1, scale_pos_weight=w, tree_method="hist", n_jobs=-1, random_state=42)
    else:
        from lightgbm import LGBMClassifier
        est = LGBMClassifier(n_estimators=int(hp.get("n_trees", 300)), max_depth=int(hp.get("max_depth", 0)) or -1,
                             learning_rate=0.1, class_weight="balanced", n_jobs=-1, random_state=42, verbose=-1)
    return make_pipeline(StandardScaler(), est)


def fit_score(c, train, test):
    """Entraîne sur `train`, renvoie la probabilité « crise » sur `test`.
    Sans predict_proba (SVM), sigmoïde de la fonction de décision : 0,5 ↔ frontière de predict."""
    X, y = train[c["features"]].values, train["Class"].values
    if c["model"] == "svm" and len(X) > SVM_MAX_TRAIN:
        idx = np.random.default_rng(42).choice(len(X), SVM_MAX_TRAIN, replace=False)
        X, y = X[idx], y[idx]
    model = make_model(c, y).fit(X, y)
    Xt = test[c["features"]].values
    if hasattr(model, "predict_proba"):
        return model.predict_proba(Xt)[:, 1]
    return 1 / (1 + np.exp(-model.decision_function(Xt)))


def window_scores(y, pred):
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum()); tn = int(((pred == 0) & (y == 0)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "accuracy": (tp + tn) / max(1, tp + fp + fn + tn),
            "precision": prec, "recall": rec, "f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0}


def detect_rec(rows, proba, thr=0.5):
    """Règles de detect() sur une série de fenêtres : seuil, lissage médian, intervalles."""
    order = np.argsort(rows["t_start"].values)
    ts, te = rows["t_start"].values[order], rows["t_end"].values[order]
    p = np.asarray(proba)[order]
    raw = (p > thr).astype(int)
    sm = medfilt(raw, P.SMOOTH).astype(int) if P.SMOOTH > 1 else raw
    return ts, te, p, raw, sm, P.windows_to_intervals(ts, te, sm)


def events_of(rid, ev):
    truth = A.truth_intervals(rid)
    m = P.match_events(truth, ev)
    det = m[m["Résultat"] == "Détectée"]
    return {"id": rid, "n_true": len(truth), "detected": int(len(det)),
            "missed": int((m["Résultat"] == "Manquée").sum()),
            "false_alarms": int((m["Résultat"] == "Fausse alarme").sum()), "hours": hours_of(rid),
            "delays": [float(v) for v in det["Retard début (s)"]] if len(det) else []}   # colonne absente sans détection


def summarize(data, proba):
    """Scores par fenêtre (décision brute au seuil 0,5) et par événement (après les règles de detect())."""
    y = data["Class"].values
    pred = (np.asarray(proba) > 0.5).astype(int)
    per = []
    for rid, idx in data.groupby("Recording").indices.items():
        _, _, _, _, _, ev = detect_rec(data.iloc[idx], np.asarray(proba)[idx])
        per.append(events_of(rid, ev))
    per.sort(key=lambda e: e["id"])
    tot = {k: sum(e[k] for e in per) for k in ("n_true", "detected", "missed", "false_alarms", "hours")}
    delays = [d for e in per for d in e["delays"]]
    tot.update(sensitivity=tot["detected"] / tot["n_true"] if tot["n_true"] else None,
               fa_per_hour=tot["false_alarms"] / tot["hours"] if tot["hours"] else None,
               mean_delay=float(np.mean(delays)) if delays else None)
    for e in per:
        e["mean_delay"] = float(np.mean(e["delays"])) if e["delays"] else None
        del e["delays"]
    return {"windows": window_scores(y, pred), "events": tot, "per_recording": per, "n_windows": int(len(y))}


def annotated(data):
    return sorted(set(data["Recording"]))


# ---- banc d'essai : évaluation complète
def _bench_params(p):
    p = dict(p)
    c = check_cfg(p.get("cfg"))
    ev = p.get("eval", "gkf")
    if ev not in ("gkf", "loro", "random"):
        raise HTTPException(400, "Évaluation : gkf, loro ou random.")
    return {"cfg": c, "eval": ev}


def run_bench(p, job):
    from sklearn.model_selection import GroupKFold, train_test_split
    c, ev = p["cfg"], p["eval"]
    data = dataset(c["win"]).reset_index(drop=True)
    proba = np.full(len(data), np.nan)
    if ev == "random":
        # découpage aléatoire stratifié 80/20 (comme la première comparaison du notebook)
        job.progress(0, 1, f"{MODELS[c['model']]} : découpage aléatoire 80/20")
        tr, te = train_test_split(np.arange(len(data)), test_size=0.2, stratify=data["Class"].values, random_state=42)
        proba_te = fit_score(c, data.iloc[tr], data.iloc[te])
        y = data["Class"].values[te]
        # recouvrement : part des fenêtres de test dont une voisine immédiate est dans l'entraînement
        key = data["Recording"] + "#" + data["Window"].astype(str)
        in_train = set(key.values[tr])
        nb = sum(1 for i in te if f"{data.at[i, 'Recording']}#{data.at[i, 'Window'] - 1}" in in_train
                 or f"{data.at[i, 'Recording']}#{data.at[i, 'Window'] + 1}" in in_train)
        return {"cfg": c, "eval": ev, "windows": window_scores(y, (proba_te > 0.5).astype(int)),
                "n_test": int(len(te)), "overlap_share": nb / len(te), "events": None}
    recs = annotated(data)
    if ev == "gkf":
        splits = list(GroupKFold(n_splits=5).split(data, data["Class"], data["Recording"]))
    else:
        splits = [(np.where(data["Recording"] != r)[0], np.where(data["Recording"] == r)[0]) for r in recs]
    for k, (tr, te) in enumerate(splits):
        what = f"pli {k + 1} sur {len(splits)}" if ev == "gkf" else f"sans {data.at[te[0], 'Recording']} ({k + 1} sur {len(splits)})"
        job.progress(k, len(splits), f"{MODELS[c['model']]} : {what}")
        proba[te] = fit_score(c, data.iloc[tr], data.iloc[te])
    out = summarize(data, proba)
    out.update(cfg=c, eval=ev, n_fits=len(splits))
    return out


# ---- un patient : modèle entraîné sans lui
def _patient_params(p):
    rid = p.get("rid")
    A.CATALOG.get(rid)
    return {"cfg": check_cfg(p.get("cfg")), "rid": rid}


def patient_result(c, rid, job, k0=0, total=1):
    data = dataset(c["win"])
    train, test = data[data["Recording"] != rid], data[data["Recording"] == rid]
    if not len(test):
        raise HTTPException(400, f"{rid} ne fait pas partie du jeu annoté.")
    job.progress(k0, total, f"{MODELS[c['model']]} entraîné sans {rid}")
    proba = fit_score(c, train, test)
    ts, te, p, raw, sm, ev = detect_rec(test, proba)
    truth = A.truth_intervals(rid)
    m = P.match_events(truth, ev)
    rows = [{k: (None if (isinstance(v, float) and np.isnan(v)) else v) for k, v in r.items()} for r in m.to_dict("records")]
    e = events_of(rid, ev)
    return {"cfg": c, "rid": rid, "t_start": ts.round(3).tolist(), "t_end": te.round(3).tolist(),
            "proba": np.round(p, 4).tolist(), "smoothed": sm.tolist(), "events": [[float(a), float(b)] for a, b in ev],
            "truth": [[a, b] for a, b in truth], "match": rows, "duration": A.CATALOG.get(rid)["duration"],
            "totals": {**{k: e[k] for k in ("n_true", "detected", "missed", "false_alarms")},
                       "fa_per_hour": e["false_alarms"] / e["hours"],
                       "mean_delay": float(np.mean(e["delays"])) if e["delays"] else None},
            "trained_on": int(train["Recording"].nunique())}


def run_patient(p, job):
    return patient_result(p["cfg"], p["rid"], job)


def _duel_params(p):
    rid = p.get("rid")
    A.CATALOG.get(rid)
    return {"a": check_cfg(p.get("a")), "b": check_cfg(p.get("b")), "rid": rid}


def run_duel(p, job):
    a = patient_result(p["a"], p["rid"], job, 0, 2)
    b = patient_result(p["b"], p["rid"], job, 1, 2)
    hit = lambda ev, s, e: any(x < e and y > s for x, y in ev)
    diffs = []
    for k, (s, e) in enumerate(a["truth"], 1):
        ha, hb = hit(a["events"], s, e), hit(b["events"], s, e)
        if ha != hb:
            diffs.append({"type": "crise", "n": k, "start": s, "end": e, "by": "A" if ha else "B"})
    for who, me, other in (("A", a, b), ("B", b, a)):
        for s, e in me["events"]:
            if not hit(me["truth"], s, e) and not hit(other["events"], s, e):
                diffs.append({"type": "fausse_alarme", "start": s, "end": e, "by": who})
    diffs.sort(key=lambda d: d["start"])
    return {"rid": p["rid"], "a": a, "b": b, "disagreements": diffs}


# ---- relance sur une sélection de patients (modèles « sans l'enregistrement », seuil choisi)
def _rerun_params(p):
    rids = sorted(set(p.get("rids") or []))
    ok = set(LAB.annotated_ids())
    rids = [r for r in rids if r in ok]
    if not rids:
        raise HTTPException(400, "Cochez au moins un enregistrement annoté.")
    model = p.get("model", "rf")
    if model not in ("rf", "et"):
        raise HTTPException(400, "Modèle : rf ou et.")
    thr = round(float(p.get("threshold", 0.5)), 2)
    if not 0.05 <= thr <= 0.95:
        raise HTTPException(400, "Seuil entre 0,05 et 0,95.")
    return {"rids": rids, "model": model, "threshold": thr}


def run_rerun(p, job):
    from sklearn.base import clone
    out = []
    for k, rid in enumerate(p["rids"]):
        job.progress(k, len(p["rids"]), f"{rid} : modèle {'Random Forest' if p['model'] == 'rf' else 'Extra Trees'} sans lui")
        rec = A.STORE.get(rid)
        feats, _ = A.compute_features(rid, rec)
        if p["model"] == "rf":
            model, _, _ = A.MODELS.leave_one_out(rid)
        else:
            others = A.DATASET[A.DATASET["Recording"] != rid]
            model = clone(LAB.make_extra_trees()).fit(others[A.MODELS.features].values, others["Class"].values)
        proba, _ = LAB.predict(model, feats)
        *_, ev = detect_rec(feats, proba, p["threshold"])
        e = events_of(rid, ev)
        e["mean_delay"] = float(np.mean(e["delays"])) if e["delays"] else None
        del e["delays"]
        out.append(e)
    return {**p, "recordings": out}


# ---- courbe d'apprentissage : N enregistrements d'entraînement, 4 laissés de côté, 5 tirages
def _learning_params(p):
    n = int(p.get("n_train", 8))
    if not 3 <= n <= 15:
        raise HTTPException(400, "Entre 3 et 15 enregistrements d'entraînement.")
    return {"n_train": n, "held_out": 4, "repeats": int(p.get("repeats", 5)), "cfg": check_cfg(p.get("cfg") or REFERENCE)}


def run_learning(p, job):
    data = A.DATASET
    recs = annotated(data)
    reps = []
    for r in range(p["repeats"]):
        job.progress(r, p["repeats"], f"tirage {r + 1} sur {p['repeats']} : {p['n_train']} enregistrements d'entraînement")
        rng = np.random.default_rng(1000 + r)
        test = list(rng.choice(recs, p["held_out"], replace=False))
        rest = [x for x in recs if x not in test]
        train = list(rng.choice(rest, p["n_train"], replace=False))
        tr, te = data[data["Recording"].isin(train)], data[data["Recording"].isin(test)].reset_index(drop=True)
        s = summarize(te, fit_score(p["cfg"], tr, te))
        reps.append({"train": train, "test": test, "f1": s["windows"]["f1"], "sensitivity": s["events"]["sensitivity"],
                     "fa_per_hour": s["events"]["fa_per_hour"]})
    agg = lambda k: {"mean": float(np.mean([x[k] for x in reps])), "sd": float(np.std([x[k] for x in reps], ddof=1)),
                     "min": float(min(x[k] for x in reps)), "max": float(max(x[k] for x in reps))}
    return {**p, "repeats_detail": reps, "f1": agg("f1"), "sensitivity": agg("sensitivity"), "fa_per_hour": agg("fa_per_hour")}


RUNNERS = {
    "bench": (run_bench, _bench_params),
    "patient": (run_patient, _patient_params),
    "duel": (run_duel, _duel_params),
    "rerun": (run_rerun, _rerun_params),
    "learning": (run_learning, _learning_params),
}


@router.get("/config")
def config():
    """Ce que le banc d'essai propose : modèles, fenêtres disponibles, groupes de caractéristiques, référence."""
    return {"models": MODELS, "windows": A.analysis_windows(), "features": list(P.FEATURES), "groups": GROUPS,
            "amplitude": AMPLITUDE, "frequency": FREQUENCY, "reference": REFERENCE, "svm_max_train": SVM_MAX_TRAIN,
            "annotated": LAB.annotated_ids()}


# ==========================================================================
# Patients : carte (ACP), K-means, voisins
# ==========================================================================
def age_group(a):
    if a is None or (isinstance(a, float) and np.isnan(a)):
        return None
    return "< 8 ans" if a < 8 else ("8–11 ans" if a < 12 else "≥ 12 ans")


def _patient_matrix(scope):
    d = A.DATASET
    sel = d[d["Class"] == (1 if scope == "seizure" else 0)]
    M = sel.groupby("Recording")[list(P.FEATURES)].mean().sort_index()
    Z = (M - M.mean()) / M.std(ddof=0).replace(0, 1)
    return M, Z


@router.get("/patients/map")
def patients_map(scope: str = "seizure"):
    if scope not in ("seizure", "normal"):
        raise HTTPException(400, "scope : seizure ou normal")
    M, Z = _patient_matrix(scope)
    U, S, Vt = np.linalg.svd(Z.values, full_matrices=False)
    pcs = U[:, :2] * S[:2]
    var = (S ** 2) / (S ** 2).sum()
    loadings = {f: [round(float(Vt[0, j]), 3), round(float(Vt[1, j]), 3)] for j, f in enumerate(P.FEATURES)}
    pts = []
    for i, rid in enumerate(Z.index):
        m = A._meta(rid)
        e = None
        try:
            e = A._cohort_entry_for(rid)
        except Exception:
            pass
        T = e["totals"] if e else None
        pts.append({"id": rid, "x": float(pcs[i, 0]), "y": float(pcs[i, 1]), "z": [round(float(v), 4) for v in Z.values[i]],
                    "age": m["age"], "age_group": age_group(m["age"]), "sex": m["sex"],
                    "type": "atypique" if m["type_abs"] else "typique", "n_seizures": m["n_seizures"],
                    "sensitivity": T["detected"] / T["n_true"] if T else None,
                    "fa_per_hour": T["fa_per_hour"] if T else None,
                    "false_alarms": T["false_alarms"] if T else None, "detected": T["detected"] if T else None,
                    "peak_freq": float(M.loc[rid, "Peak_Freq"]), "amplitude": float(M.loc[rid, "Amplitude"])})
    top = lambda k: sorted(loadings, key=lambda f: -abs(loadings[f][k]))[:3]
    return {"scope": scope, "features": list(P.FEATURES), "variance": [float(var[0]), float(var[1])],
            "top_pc1": top(0), "top_pc2": top(1), "points": pts}


@router.get("/patients/kmeans")
def patients_kmeans(k: int = 3, scope: str = "seizure"):
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    if not 2 <= k <= 5:
        raise HTTPException(400, "k entre 2 et 5")
    _, Z = _patient_matrix(scope)
    sil = {}
    labels = None
    for kk in range(2, 6):
        km = KMeans(n_clusters=kk, random_state=42, n_init=10).fit(Z.values)
        sil[kk] = float(silhouette_score(Z.values, km.labels_))
        if kk == k:
            labels = km.labels_
    return {"k": k, "scope": scope, "silhouette": sil,
            "labels": {rid: int(c) for rid, c in zip(Z.index, labels)}}


# ==========================================================================
# Limites : le patient adulte
# ==========================================================================
@router.get("/adult")
def adult(rid: str = "191113A-D"):
    """Les crises manquées de l'enregistrement, la probabilité du modèle « sans lui » et ses
    caractéristiques pendant les crises, comparées au reste de la cohorte."""
    job = LAB.probas("rf")
    if job["status"] != "done":
        return {"status": job["status"], "done": job.get("done"), "total": job.get("total"), "current": job.get("current")}
    e = next(x for x in job["data"]["recordings"] if x["id"] == rid)
    ts, te, p = np.array(e["t_start"]), np.array(e["t_end"]), np.array(e["proba"])
    raw = (p > 0.5).astype(int)
    sm = medfilt(raw, P.SMOOTH).astype(int)
    ev = P.windows_to_intervals(ts, te, sm)
    m = P.match_events([tuple(t) for t in e["truth"]], ev)
    missed = m[m["Résultat"] == "Manquée"]
    seizures = []
    for _, r in m[m["Résultat"] != "Fausse alarme"].iterrows():
        s, f = float(r["Début réel"]), float(r["Fin réelle"])
        sel = (ts >= s - 30) & (te <= f + 30)
        inside = (ts < f) & (te > s)
        seizures.append({"n": int(r["Crise réelle"]), "start": s, "end": f, "result": r["Résultat"],
                         "max_proba": float(p[inside].max()) if inside.any() else None,
                         "t_start": ts[sel].tolist(), "t_end": te[sel].tolist(), "proba": np.round(p[sel], 4).tolist()})
    d = A.DATASET[A.DATASET["Class"] == 1]
    me, rest = d[d["Recording"] == rid], d[d["Recording"] != rid]
    per = rest.groupby("Recording")
    # irrégularité : variation de la fréquence du pic d'une fenêtre à l'autre pendant les crises
    irr = lambda g: float(g["Peak_Freq"].std(ddof=0))
    feats = {}
    for f in ("Amplitude", "RMS", "Peak_Freq", "Rel_Delta", "Rel_Theta"):
        feats[f] = {"patient": float(me[f].mean()), "cohort": float(per[f].mean().mean()),
                    "ratio": float(me[f].mean() / per[f].mean().mean())}
    meta = A._meta(rid)
    return {"status": "done", "rid": rid, "age": meta["age"], "sex": meta["sex"], "seizures": seizures,
            "n_missed": int(len(missed)), "features": feats,
            "irregularity": {"patient": irr(me), "cohort": float(np.mean([irr(g) for _, g in per])),
                             "cohort_max": float(max(irr(g) for _, g in per))},
            "cohort_ages": sorted(a for a in (A._meta(r)["age"] for r in LAB.annotated_ids()) if a is not None)}


# ==========================================================================
# Anticipation : part des crises annoncées par groupe d'âge (meilleur modèle)
# ==========================================================================
@router.get("/anticipation-age")
def anticipation_age():
    base = A.LOCAL_DIR / "anticipation"
    if not (base / "resume.csv").exists() or not (base / "alarmes.csv").exists():
        return {"available": False}
    res = pd.read_csv(base / "resume.csv")
    al = pd.read_csv(base / "alarmes.csv")
    ref = pd.read_csv(base / "crises_reference.csv")
    cand = res[res["Modèle"] != "M0"].sort_values(["Crises annoncées", "AUC"], ascending=False)
    best = cand.iloc[0]
    mod, hz = best["Modèle"], int(best["Horizon (s)"])
    # même règle que le notebook : une crise est annoncée si une alarme tombe dans (début − H, début] ;
    # « t (s) » est le temps relatif au début de la crise
    al = al[(al["Modèle"] == mod) & (al["Horizon (s)"] == hz) & (al["t (s)"] > -hz) & (al["t (s)"] <= 0)]
    hit = al[["ID", "Crise"]].drop_duplicates()
    hitset = set(map(tuple, hit.values))
    ref = ref.assign(annonce=[(i, c) in hitset for i, c in zip(ref["ID"], ref["Crise"])],
                     groupe=[age_group(A._meta(i)["age"]) if i in A.CATALOG.recs else None for i in ref["ID"]])
    rows = []
    for g in ("< 8 ans", "8–11 ans", "≥ 12 ans"):
        sub = ref[ref["groupe"] == g]
        rows.append({"group": g, "patients": int(sub["ID"].nunique()), "seizures": int(len(sub)),
                     "anticipated": int(sub["annonce"].sum()),
                     "share": float(sub["annonce"].mean()) if len(sub) else None})
    return {"available": True, "model": mod, "description": str(best["Description"]), "horizon_s": hz,
            "auc": float(best["AUC"]), "anticipated": int(best["Crises annoncées"]),
            "reference": int(best["Crises de référence"]), "check_total": int(ref["annonce"].sum()),
            "rows": rows, "source": "resultats_local/anticipation/ (resume.csv, alarmes.csv, crises_reference.csv)"}
