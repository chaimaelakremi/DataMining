"""
Augmentation de données (Laboratoire · Augmentation) : fabriquer de nouvelles fenêtres d'entraînement
en modifiant légèrement les vraies, puis ré-entraîner le Random Forest « sans l'enregistrement ».

Les augmentations sont faites directement sur les caractéristiques, de façon exacte :
  - amplitude × a : le filtre est linéaire, donc Mean, Std, Min, Max, Amplitude, RMS sont multipliés par a,
    Variance, Energy et les puissances P_* par a², les parts Rel_* et Peak_Freq ne changent pas ;
  - polarité inversée : Mean devient −Mean, Min et Max s'échangent (en changeant de signe) ;
  - voie retirée ou corrompue : à partir des caractéristiques par voie de l'étude « électrodes »
    (.cache/electrodes/), la voie est ôtée de la moyenne ou remplacée par sa version en panne.
Règle d'or : seules les fenêtres des enregistrements d'ENTRAÎNEMENT sont augmentées ; l'enregistrement
testé reste intact. eeg_pipeline n'est pas modifié ; rien n'est écrit hors de .cache/.
"""
import hashlib
import json
import time

import joblib
import numpy as np
from fastapi import APIRouter, Body, HTTPException

import eeg_pipeline as P
import etude_electrodes as EL

router = APIRouter(prefix="/api/augment")
A = TOOLS = ETUDES = LAB = None
DIR = None
VERSION = 1
FEATS = list(P.FEATURES)
LIN = [FEATS.index(f) for f in ("Mean", "Std", "Min", "Max", "Amplitude", "RMS")]
QUAD = [FEATS.index(f) for f in ("Variance", "Energy", "P_Delta", "P_Theta", "P_Alpha", "P_Beta")]
I_MEAN, I_MIN, I_MAX = FEATS.index("Mean"), FEATS.index("Min"), FEATS.index("Max")
KINDS = list(EL.CORRUPTIONS)
DEFAULT = {"a_min": 0.4, "copies": 2, "polarite": True, "retrait_max": 1, "part_corrompue": 0.25, "part_normales": 0.30}
SCENARIOS = [("intact", {}), ("Fp1 déconnectée", {"corrupt": {"Fp1": "deconnexion"}}),
             ("O2 déconnectée", {"corrupt": {"O2": "deconnexion"}}), ("T3 et T4 bruitées", {"corrupt": {"T3": "bruit", "T4": "bruit"}}),
             ("3 électrodes retirées", {"removed": ["F3", "C4", "O1"]})]
ADULT = "191113A-D"
_MODELS = {}


def bind(app_module, tools_module, etudes_module, lab_module):
    global A, TOOLS, ETUDES, LAB, DIR
    A, TOOLS, ETUDES, LAB = app_module, tools_module, etudes_module, lab_module
    DIR = A.CACHE_DIR / "augmentation"
    (DIR / "models").mkdir(parents=True, exist_ok=True)
    TOOLS.RUNNERS["augment"] = (run_augment, check_config)
    LAB.EXTRA_MODEL = lambda rid: model_of(latest())(rid)        # modèle « augmenté » pour le stress test


# ==========================================================================
# Configuration et opérations sur les caractéristiques
# ==========================================================================
def check_config(p):
    c = {k: p.get(k, v) for k, v in DEFAULT.items()}
    c = {"a_min": round(float(np.clip(c["a_min"], 0.2, 1.0)), 2), "copies": int(np.clip(c["copies"], 1, 4)),
         "polarite": bool(c["polarite"]), "retrait_max": int(np.clip(c["retrait_max"], 0, 3)),
         "part_corrompue": round(float(np.clip(c["part_corrompue"], 0, 0.5)), 2),
         "part_normales": round(float(np.clip(c["part_normales"], 0, 0.3)), 2)}
    c["v"] = VERSION
    return c


def tag(c):
    return hashlib.sha1(json.dumps(c, sort_keys=True).encode()).hexdigest()[:12]


def scale(F, a):
    """Amplitude × a appliquée à des caractéristiques moyennées (F : n × 17, a : n)."""
    F = F.copy()
    F[:, LIN] *= a[:, None]
    F[:, QUAD] *= (a ** 2)[:, None]
    return F


def flip(F, mask):
    F = F.copy()
    mn, mx = F[mask, I_MIN].copy(), F[mask, I_MAX].copy()
    F[mask, I_MEAN] *= -1
    F[mask, I_MIN], F[mask, I_MAX] = -mx, -mn
    return F


def channel_ops(d, idx, rng, c):
    """Caractéristiques moyennées des fenêtres idx, avec voies retirées et une voie corrompue au hasard."""
    W = d["base"][idx].astype(np.float64)                     # (m, 19, 17)
    m, nch = len(idx), W.shape[1]
    corr = rng.random(m) < c["part_corrompue"]
    for i in np.where(corr)[0]:
        j, kind = rng.integers(nch), KINDS[rng.integers(len(KINDS))]
        W[i, j] = d[f"c_{kind}"][idx[i], j]
    keep = np.ones((m, nch), bool)
    if c["retrait_max"]:
        k = rng.integers(0, c["retrait_max"] + 1, m)
        for i in np.where(k > 0)[0]:
            keep[i, rng.choice(nch, k[i], replace=False)] = False
    return (W * keep[..., None]).sum(1) / keep.sum(1)[:, None]


def augment_recording(d, c, rng):
    """Copies augmentées d'un enregistrement d'entraînement : chaque fenêtre de crise, et une part des fenêtres normales."""
    cls = d["cls"]
    idx = np.concatenate([np.repeat(np.where(cls == 1)[0], c["copies"]),
                          np.where(cls == 0)[0][rng.random(int((cls == 0).sum())) < c["part_normales"]]])
    if not len(idx):
        return np.empty((0, len(FEATS))), np.empty(0, int)
    F = channel_ops(d, idx, rng, c)
    F = scale(F, rng.uniform(c["a_min"], 1.0, len(idx)))
    if c["polarite"]:
        F = flip(F, rng.random(len(idx)) < 0.5)
    return F, cls[idx].astype(int)


def intact_features(d):
    return d["base"].astype(np.float64).mean(axis=1)          # = caractéristiques du projet (moyenne des voies)


# ==========================================================================
# Entraînement « sans l'enregistrement » avec augmentation, et comparaison
# ==========================================================================
def model_of(h):
    if not h:
        raise HTTPException(400, "Aucun modèle augmenté : lancez d'abord l'entraînement dans Laboratoire · Augmentation.")

    def get(rid):
        key = (h, rid)
        if key not in _MODELS:
            path = DIR / "models" / h / f"sans_{rid}.joblib"
            if not path.exists():
                raise HTTPException(400, "Modèle augmenté introuvable : relancez l'entraînement dans Laboratoire · Augmentation.")
            _MODELS[key] = joblib.load(path)
            while len(_MODELS) > 40:
                _MODELS.pop(next(iter(_MODELS)))
        return _MODELS[key]
    return get


def latest():
    path = DIR / "dernier.json"
    if not path.exists():
        return None
    h = json.loads(path.read_text()).get("tag")
    return h if h and (DIR / "models" / h).exists() else None


def run_augment(c, job):
    t0 = time.time()
    st = ETUDES.study(job)
    h = tag(c)
    mdir = DIR / "models" / h
    mdir.mkdir(parents=True, exist_ok=True)
    ids = st.ids
    n_aug = 0
    for k, rid in enumerate(ids):
        path = mdir / f"sans_{rid}.joblib"
        if path.exists():
            continue
        job.progress(k, len(ids) + 2, f"Random Forest augmenté, sans {rid} ({k + 1} sur {len(ids)})")
        rng = np.random.default_rng(42 + k)
        X, y = [], []
        for r in ids:
            if r == rid:
                continue                                      # l'enregistrement testé n'est jamais augmenté ni vu
            d = st.data[r]
            X.append(intact_features(d)); y.append(d["cls"].astype(int))
            Fa, ya = augment_recording(d, c, rng)
            X.append(Fa); y.append(ya); n_aug += len(ya)
        model = P.make_models()["Random Forest"].fit(np.vstack(X), np.concatenate(y))
        joblib.dump(model, path, compress=3)
    old = DIR / "dernier.json"
    known = json.loads(old.read_text()).get("known", {}) if old.exists() else {}
    known[h] = c
    (DIR / "dernier.json").write_text(json.dumps({"tag": h, "config": c, "known": known}))
    job.progress(len(ids), len(ids) + 2, "comparaison avec le modèle du projet")
    get = model_of(h)
    # scénarios : intact et pannes d'électrodes, modèle du projet contre modèle augmenté
    proj = st.evaluate([sc for _, sc in SCENARIOS])
    intact_ev = {r["id"]: [tuple(e) for e in r["events"]] for r in proj[0]["recordings"]}
    aug = st.evaluate([sc for _, sc in SCENARIOS], model_of=get, reference=intact_ev)
    strip = lambda d: {k: v for k, v in d.items() if k != "recordings"}
    rows = []
    for a, b in zip(proj[0]["recordings"], aug[0]["recordings"]):
        rows.append({"id": a["id"], "n_true": a["n_true"], "detected": b["detected"], "detected_projet": a["detected"],
                     "false_alarms": b["false_alarms"], "false_alarms_projet": a["false_alarms"]})
    # focus : la patiente adulte, probabilité autour de ses crises
    d = st.data[ADULT]
    X = intact_features(d)
    p_proj, p_aug = st.model(ADULT).predict_proba(X)[:, 1], get(ADULT).predict_proba(X)[:, 1]
    ts, te = d["t_start"], d["t_end"]
    adult = []
    for s, e in st.truth[ADULT]:
        sel = (ts >= s - 30) & (te <= e + 30)
        ins = (ts < e) & (te > s)
        adult.append({"start": s, "end": e, "t": ((ts[sel] + te[sel]) / 2).round(2).tolist(),
                      "projet": p_proj[sel].round(4).tolist(), "augmente": p_aug[sel].round(4).tolist(),
                      "max_projet": float(p_proj[ins].max()), "max_augmente": float(p_aug[ins].max())})
    return {"config": c, "tag": h, "n_fits": len(ids), "n_copies_par_pli": int(n_aug / max(1, len(ids))),
            "scenarios": [{"name": n, "projet": strip(p), "augmente": strip(q)} for (n, _), p, q in zip(SCENARIOS, proj, aug)],
            "recordings": rows, "adulte": {"id": ADULT, "seizures": adult}, "elapsed_s": round(time.time() - t0, 1)}


@router.post("/use")
def use(tag: str, cfg: dict | None = Body(None)):
    """Choisit le jeu de modèles augmentés utilisé par les onglets Électrodes et Stress test
    (nécessaire quand le résultat de l'entraînement est relu dans le cache)."""
    mdir = DIR / "models" / tag
    if not mdir.exists() or len(list(mdir.glob("sans_*.joblib"))) < 19:
        raise HTTPException(409, "Modèles de cette configuration absents : relancez l'entraînement.")
    old = DIR / "dernier.json"
    known = json.loads(old.read_text()).get("known", {}) if old.exists() else {}
    if cfg is not None:
        known[tag] = cfg
    (DIR / "dernier.json").write_text(json.dumps({"tag": tag, "config": known.get(tag), "known": known}))
    return {"tag": tag}


# ==========================================================================
# Aperçu : une vraie crise et sa version augmentée
# ==========================================================================
SHOW = ["Fp1", "F3", "C3", "P3", "O1", "F4"]


@router.get("/preview")
def preview(rid: str = "230102B-F", n: int = 1, a: float = 0.5, polarite: bool = False,
            retirer: str = "", corrompre: str = "", type: str = "deconnexion"):
    st = ETUDES.study()
    if rid not in st.data:
        raise HTTPException(400, "Choisissez un enregistrement annoté.")
    truth = st.truth[rid]
    n = max(1, min(n, len(truth)))
    s, e = truth[n - 1]
    d = st.data[rid]
    mid = (s + e) / 2
    k = int(np.argmin(np.abs((d["t_start"] + d["t_end"]) / 2 - mid)))           # fenêtre au centre de la crise
    a = float(np.clip(a, 0.2, 1.0))
    if type not in EL.CORRUPTIONS:
        raise HTTPException(400, "Type de panne inconnu.")
    rem = retirer if retirer in EL.ELECTRODES else ""
    cor = corrompre if corrompre in EL.ELECTRODES and corrompre != rem else ""
    # caractéristiques de la fenêtre : mêmes opérations que l'entraînement
    W = d["base"][k].astype(np.float64)
    if cor:
        W[EL.ELECTRODES.index(cor)] = d[f"c_{type}"][k, EL.ELECTRODES.index(cor)]
    keep = np.array([el != rem for el in EL.ELECTRODES])
    F_aug = scale(W[keep].mean(0)[None, :], np.array([a]))
    if polarite:
        F_aug = flip(F_aug, np.array([True]))
    F_orig = d["base"][k].astype(np.float64).mean(0)
    # tracé : filtré comme pour la détection, la même modification appliquée au signal
    rec = A.STORE.get(rid)
    chans = ["EEG" + x for x in SHOW + [c for c in (rem, cor) if c and c not in SHOW]]
    t0 = max(0.0, mid - 4)
    i0, i1 = int(t0 * rec.fs), int((t0 + 8) * rec.fs)
    X = rec.columns(chans, True, i0, i1).astype(np.float64)
    Y = X.copy()
    if cor:
        Y[:, chans.index("EEG" + cor)] = ETUDES.corrupted_channel(rid, "EEG" + cor, type)[i0:i1]
    Y *= a * (-1 if polarite else 1)
    pack = lambda M: {c.replace("EEG", ""): np.round(M[::2, j], 1).tolist() for j, c in enumerate(chans)}
    return {"id": rid, "n": n, "n_seizures": len(truth), "seizure": [s, e], "t0": i0 / rec.fs, "dt": 2 / rec.fs,
            "channels": [c.replace("EEG", "") for c in chans], "removed": rem or None, "corrupted": cor or None,
            "window": [float(d["t_start"][k]), float(d["t_end"][k])],
            "original": pack(X), "augmented": pack(Y),
            "features": {f: [float(F_orig[i]), float(F_aug[0, i])] for i, f in enumerate(FEATS)},
            "params": {"a": a, "polarite": polarite, "type": type}}


@router.get("/status")
def status():
    h = latest()
    cfg = None
    if h:
        cfg = json.loads((DIR / "dernier.json").read_text()).get("config")
        cfg = cfg if cfg and tag(cfg) == h else None      # sinon : on repart des réglages par défaut
    return {"tag": h, "config": cfg, "default": DEFAULT, "electrodes": EL.ELECTRODES, "corruptions": EL.CORRUPTIONS,
            "ids": sorted(set(A.DATASET["Recording"]))}
