"""
Endpoints du site pour les deux études du notebook :
  - page Découverte  (/api/decouverte/…) : relit resultats_local/autoencodeur/ (produit par le notebook),
    miniatures (tâche de fond), avis du médecin (resultats_local/autoencodeur/avis_medecin.csv) ;
  - onglet Laboratoire · Électrodes (/api/electrodes/…) : scénarios de panne recalculés à la demande sur
    les caractéristiques par voie mises en cache (tâche « electrodes » des outils), et signal corrompu pour Lecture.
Rien n'est écrit dans data/ ni dans resultats/.
"""
import csv
import json
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import eeg_pipeline as P
import etude_electrodes as EL

router = APIRouter(prefix="/api")
A = TOOLS = AUG = None
AE_DIR = EL_DIR = None
VOTES = ["Crise probable", "Artefact", "Normal", "Incertain"]
_VOTE_LOCK = threading.Lock()


def bind(app_module, tools_module):
    global A, TOOLS, AE_DIR, EL_DIR
    A, TOOLS = app_module, tools_module
    AE_DIR, EL_DIR = A.LOCAL_DIR / "autoencodeur", A.LOCAL_DIR / "electrodes"
    TOOLS.RUNNERS["dec_thumbs"] = (run_thumbs, lambda p: {"key": str(p.get("key", ""))})
    TOOLS.RUNNERS["electrodes"] = (run_electrodes, check_scenario)


# ==========================================================================
# Découverte (autoencodeur)
# ==========================================================================
_CACHE = {}


def _read(name, **kw):
    path = AE_DIR / name
    if not path.exists():
        return None
    key = (name, A._file_key(path))
    if key not in _CACHE:
        _CACHE.clear() if len(_CACHE) > 12 else None
        _CACHE[key] = pd.read_csv(path, **kw) if name.endswith(".csv") else json.loads(path.read_text(encoding="utf-8"))
    return _CACHE[key]


def cand_id(r, a):
    return f"{r}@{float(a):g}"


def _clean(v):
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def votes_table():
    path = AE_DIR / "avis_medecin.csv"
    if not path.exists():
        return pd.DataFrame(columns=["horodatage", "candidat", "enregistrement", "debut", "fin", "avis"])
    return pd.read_csv(path)


def votes_summary():
    v = votes_table()
    last = v.drop_duplicates("candidat", keep="last") if len(v) else v
    return {"latest": {r["candidat"]: r["avis"] for _, r in last.iterrows()},
            "counts": {k: int((last["avis"] == k).sum()) for k in VOTES} if len(last) else {k: 0 for k in VOTES},
            "n_votes": int(len(v)), "n_candidates_reviewed": int(len(last))}


@router.get("/decouverte")
def decouverte():
    res, C, F = _read("resume.json"), _read("candidats.csv"), _read("fausses_alarmes_rf.csv")
    if res is None or C is None:
        return {"available": False}
    cands = []
    for _, r in C.iterrows():
        d = {k: _clean(v) for k, v in r.items()}
        d["id"] = cand_id(r["Recording"], r["debut"])
        cands.append(d)
    fas = [{k: _clean(v) for k, v in r.items()} for _, r in F.iterrows()] if F is not None else []
    for f in fas:
        f["candidat_id"] = cands[int(f["candidat_associe"])]["id"] if f.get("candidat_associe") is not None else None
    return {"available": True, "resume": res, "candidats": cands, "fausses_alarmes": fas, "votes": votes_summary(),
            "thumbs_key": A._file_key(AE_DIR / "candidats.csv"),
            "figures": [p.name for p in sorted((AE_DIR / "figures").glob("*.png"))] if (AE_DIR / "figures").exists() else []}


@router.get("/decouverte/figure/{name}")
def decouverte_figure(name: str):
    from fastapi.responses import FileResponse
    path = AE_DIR / "figures" / Path(name).name
    if not path.exists():
        raise HTTPException(404, "Figure introuvable")
    return FileResponse(path, media_type="image/png")


@router.get("/decouverte/scores")
def decouverte_scores(rid: str):
    W = _read("scores_fenetres.csv")
    if W is None:
        return {"available": False}
    g = W[W["Recording"] == rid].sort_values("t_start")
    if not len(g):
        return {"available": False}
    C = _read("candidats.csv")
    c = C[C["Recording"] == rid] if C is not None else []
    return {"available": True, "rid": rid, "t": (g["t_start"] + P.WIN_S / 2).round(2).tolist(), "score": g["score"].round(4).tolist(),
            "threshold": float(g["seuil"].iloc[0]),
            "candidates": [{"start": float(r["debut"]), "end": float(r["fin"]), "label": r["etiquette"]} for _, r in c.iterrows()] if len(c) else []}


def run_thumbs(p, job):
    """Miniature EEG (5 voies, ± 5 s) de chaque candidat, regroupée par enregistrement pour ne charger chacun qu'une fois."""
    C = _read("candidats.csv")
    out = {}
    groups = list(C.groupby("Recording"))
    for k, (rid, g) in enumerate(groups):
        job.progress(k, len(groups), f"miniatures : {rid}")
        rec = A.STORE.get(rid)
        for _, r in g.iterrows():
            out[cand_id(rid, r["debut"])] = A._thumbnail(rec, float(r["debut"]), float(r["fin"]), pad=3.0, width=200)
    return {"thumbs": out}


class VoteIn(BaseModel):
    id: str
    avis: str


@router.post("/decouverte/vote")
def decouverte_vote(q: VoteIn):
    if q.avis not in VOTES:
        raise HTTPException(400, f"Avis attendu : {', '.join(VOTES)}")
    C = _read("candidats.csv")
    if C is None:
        raise HTTPException(400, "Aucun candidat : exécutez la section « autoencodeur » du notebook.")
    row = C[[cand_id(r, a) == q.id for r, a in zip(C["Recording"], C["debut"])]]
    if not len(row):
        raise HTTPException(404, "Candidat inconnu")
    r = row.iloc[0]
    path = AE_DIR / "avis_medecin.csv"
    with _VOTE_LOCK:
        new = not path.exists()
        with path.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["horodatage", "candidat", "enregistrement", "debut", "fin", "avis"])
            w.writerow([time.strftime("%Y-%m-%d %H:%M:%S"), q.id, r["Recording"], r["debut"], r["fin"], q.avis])
    return votes_summary()


# ==========================================================================
# Électrodes
# ==========================================================================
STUDY = {"obj": None, "intact": {}}
_STUDY_LOCK = threading.Lock()
PRESETS = {
    "frontal": {"label": "Électrode décollée en frontal", "corrupt": {"Fp1": "deconnexion"}},
    "temporal": {"label": "Bruit musculaire temporal", "corrupt": {"T3": "bruit", "T4": "bruit"}},
    "trois": {"label": "3 électrodes perdues", "removed": ["F3", "C4", "O1"]},
    "car": {"label": "Référence moyenne", "ref": "moyenne"},
}


def study(job=None):
    with _STUDY_LOCK:
        if STUDY["obj"] is None:
            prog = (lambda k, n, m: job.progress(k, n, m)) if job else None
            STUDY["obj"] = EL.Study(A.DATA_DIR, A.CACHE_DIR / "electrodes", A.CACHE_DIR / "models",
                                    A.RES_DIR / "features_windows.csv", progress=prog)
        return STUDY["obj"]


def check_scenario(p):
    removed = sorted({e for e in (p.get("removed") or []) if e in EL.ELECTRODES}, key=EL.ELECTRODES.index)
    corrupt = {e: k for e, k in (p.get("corrupt") or {}).items() if e in EL.ELECTRODES and k in EL.CORRUPTIONS and e not in removed}
    ref = p.get("ref", "originale")
    if ref not in EL.REFERENCES:
        raise HTTPException(400, "Référence : originale, moyenne ou cz.")
    if len(removed) >= len(EL.ELECTRODES):
        raise HTTPException(400, "Gardez au moins une électrode.")
    # « v » entre dans la clé du cache des tâches : à changer si les modèles de l'étude changent
    aug = AUG.latest() if p.get("augment") and AUG else None
    if p.get("augment") and not aug:
        raise HTTPException(400, "Aucun modèle augmenté : lancez d'abord l'entraînement dans Laboratoire · Augmentation.")
    return {"removed": removed, "corrupt": dict(sorted(corrupt.items())), "ref": ref,
            "robust": bool(p.get("robust")) and not aug, "augment": aug, "v": 2}


def run_electrodes(p, job):
    t0 = time.time()
    st = study(job)
    rob, aug = p["robust"], p.get("augment")
    model_of = AUG.model_of(aug) if aug else None                    # modèles augmentés (Laboratoire · Augmentation)
    key = ("aug", aug) if aug else rob
    if key not in STUDY["intact"]:
        def prog(k, n, m):
            job.progress(k, 2 * n, ("modèles augmentés : " if aug else "modèles « médiane » : " if rob else "référence intacte : ") + m)
        STUDY["intact"][key] = st.evaluate([{"robust": rob}], progress=prog, model_of=model_of)[0]
    base = STUDY["intact"][key]
    intact_ev = {r["id"]: [tuple(e) for e in r["events"]] for r in base["recordings"]}
    res = st.evaluate([p], progress=lambda k, n, m: job.progress(n + k, 2 * n, m), reference=intact_ev, model_of=model_of)[0]
    # le projet (moyenne, intacte) sert toujours de point de comparaison principal
    if False not in STUDY["intact"]:
        STUDY["intact"][False] = st.evaluate([{}])[0]
    proj = STUDY["intact"][False]
    rows = []
    for r, b in zip(res["recordings"], base["recordings"]):
        rows.append({"id": r["id"], "n_true": r["n_true"], "detected": r["detected"], "detected_intact": b["detected"],
                     "false_alarms": r["false_alarms"], "false_alarms_intact": b["false_alarms"], "stability": r["stability"],
                     "impact": abs(r["detected"] - b["detected"]) * 3 + abs(r["false_alarms"] - b["false_alarms"]) + (1 - r["stability"]) * 2})
    rows.sort(key=lambda x: -x["impact"])
    strip = lambda d: {k: v for k, v in d.items() if k != "recordings"}
    return {"scenario": p, "result": strip(res), "intact": strip(base), "project": strip(proj), "recordings": rows,
            "elapsed_s": round(time.time() - t0, 2)}


@router.get("/electrodes/config")
def electrodes_config():
    res = None
    path = EL_DIR / "resume.json"
    if path.exists():
        res = json.loads(path.read_text(encoding="utf-8"))
    return {"electrodes": EL.ELECTRODES, "positions": EL.POS, "regions": EL.REGIONS, "corruptions": EL.CORRUPTIONS,
            "references": EL.REFERENCES, "presets": PRESETS, "study": res,
            "cached": all(EL.cache_path(A.CACHE_DIR / "electrodes", r, A.CATALOG.get(r)["path"]).exists() for r in sorted(set(A.DATASET["Recording"])))}


_CORR = OrderedDict()


def corrupted_channel(rid, ch, kind):
    """Voie corrompue (même panne, même graine que l'étude), filtrée comme pour l'affichage."""
    key = (rid, ch, kind)
    if key not in _CORR:
        rec = A.STORE.get(rid)
        x = rec.df[ch].values.astype(np.float64)
        y = EL.corrupt(x, rec.fs, kind, EL.seed_of(rid, ch, kind))
        _CORR[key] = P.bandpass(y - np.median(y), rec.fs).astype(np.float32)
        while len(_CORR) > 8:
            _CORR.popitem(last=False)
    return _CORR[key]


@router.get("/electrodes/signal")
def electrodes_signal(rid: str, start: float = 0.0, end: float = 10.0, channels: str | None = None,
                      width: int = Query(1200, ge=16, le=8000), corrupt: str = ""):
    """Comme /api/recordings/{rid}/signal, avec certaines voies corrompues (« T3:bruit,Fp1:plat »)."""
    A.CATALOG.get(rid)
    out = A.excerpt(rid, start, end, channels.split(",") if channels else None, width, True)
    rec = A.STORE.get(rid)
    i0, i1 = max(0, int(np.floor(start * rec.fs))), min(rec.n, int(np.ceil(end * rec.fs)))
    for part in filter(None, corrupt.split(",")):
        e, _, kind = part.partition(":")
        ch = "EEG" + e
        if ch not in out["channels"] or kind not in EL.CORRUPTIONS or i1 - i0 < 2:
            continue
        seg = corrupted_channel(rid, ch, kind)[i0:i1]
        if out["mode"] == "raw":
            out["data"][ch] = np.round(seg, 2).tolist()
        else:
            n = i1 - i0
            edges = np.linspace(0, n, width + 1).astype(int)
            edges = edges[:-1][np.diff(edges) > 0]
            out["data"][ch] = {"min": np.round(np.minimum.reduceat(seg, edges), 2).tolist(),
                               "max": np.round(np.maximum.reduceat(seg, edges), 2).tolist()}
    return out
