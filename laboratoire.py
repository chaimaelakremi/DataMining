"""
Laboratoire : trois démonstrations calculées en direct (page « Laboratoire »).

  1. Temps réel : l'enregistrement est rejoué seconde par seconde ; chaque nouvelle
     fenêtre passe par la vraie chaîne (P.extract_features : médiane retirée,
     passe-bande, fenêtres de 2 s, 17 caractéristiques), puis par le modèle
     « sans cet enregistrement », puis par les règles de detect() (lissage médian,
     fusion, durée minimale).
  2. Réglages : probabilités par fenêtre des modèles « sans l'enregistrement »
     (Random Forest et Extra Trees), calculées une fois et gardées dans .cache/lab/ ;
     le navigateur refait la détection à chaque mouvement de curseur.
  3. Stress test : artefacts et décharges pointe-onde synthétiques injectés dans une
     COPIE en mémoire d'un extrait ; le fichier d'origine n'est jamais modifié.

Aucune nouvelle règle de détection : tout passe par eeg_pipeline (inchangé) et par les
modèles de app.py. Rien n'est écrit ailleurs que dans .cache/lab/.
"""
import json
import logging
import threading
import time
import uuid
from collections import OrderedDict

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from scipy.signal import medfilt

import eeg_pipeline as P

log = logging.getLogger("laboratoire")
router = APIRouter(prefix="/api/lab")
A = None                     # module app (renseigné par bind)
LAB_DIR = None
LAB_VERSION = 1
EXTRA_MODEL = None           # modèle « augmenté » (augmentation.py), choisi dans le stress test

LOOKAHEAD_S = 2.0            # le passe-bande (aller-retour) a besoin de signal après la fenêtre
PAD_S = 10                   # secondes de signal avant la fenêtre, pour stabiliser le filtre
DISP_DECIM = 2               # tracé du moniteur : 256 Hz → 128 Hz (signal déjà limité à 40 Hz)
CONTEXT_S = 20               # stress test : contexte de part et d'autre de l'extrait
ORDER = ["Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8", "T3", "C3", "Cz", "C4", "T4",
         "T5", "P3", "Pz", "P4", "T6", "O1", "O2"]


def bind(app_module):
    global A, LAB_DIR
    A = app_module
    LAB_DIR = A.CACHE_DIR / "lab"
    LAB_DIR.mkdir(parents=True, exist_ok=True)


def display_channels(rec):
    """Voies EEG dans l'ordre habituel de lecture (avant → arrière)."""
    known = [c for c in ("EEG" + o for o in ORDER) if c in rec.channels]
    return known + [c for c in rec.channels if c not in known]


# ==========================================================================
# Modèles : mêmes règles que detect_recording (aucune fuite)
# ==========================================================================
_MODEL_CACHE = OrderedDict()
_MODEL_LOCK = threading.Lock()


def model_for(rid):
    """Enregistrement du jeu d'entraînement → modèle ré-entraîné sans lui ; sinon modèle complet."""
    r = A.CATALOG.get(rid)
    loro = r["source"] == "local" and rid in set(A.DATASET["Recording"])
    key = ("loro", rid) if loro else ("full",)
    with _MODEL_LOCK:
        if key in _MODEL_CACHE:
            _MODEL_CACHE.move_to_end(key)
            return _MODEL_CACHE[key]
    if loro:
        model, info, _ = A.MODELS.leave_one_out(rid)
        lab = f"{A.MODELS.model_name()} ré-entraîné sans {rid}"
    else:
        model, info = A.MODELS.full()
        lab = f"{A.MODELS.model_name()} complet"
    out = (model, {"label": lab, "trained_on": info["trained_on"], "excluded": info["excluded"]})
    with _MODEL_LOCK:
        _MODEL_CACHE[key] = out
        while len(_MODEL_CACHE) > 4:
            _MODEL_CACHE.popitem(last=False)
    return out


def features_of(df_raw, fs, channels, rid):
    """La vraie chaîne sur un extrait : P.extract_features (filtrage, fenêtres, caractéristiques).
    Verrou de app.py : une autre page peut changer temporairement la taille des fenêtres."""
    with A._SEGMENT_LOCK:
        return P.extract_features(df_raw, fs, channels, rid)


def frame(X, fs, channels, t0):
    df = pd.DataFrame(X, columns=channels)
    df.insert(0, "Time", t0 + np.arange(len(df)) / fs)
    df["Class"] = np.int8(0)
    return df


def predict(model, feats):
    """Probabilité « crise » et décision par fenêtre. La décision est celle de model.predict :
    pour une forêt, predict renvoie la classe de plus forte probabilité (même calcul, un seul passage)."""
    if not len(feats):
        return np.zeros(0), np.zeros(0, int)
    proba = model.predict_proba(feats[A.MODELS.features].values)
    raw = model.classes_[proba.argmax(1)].astype(int)
    return proba[:, 1], raw


def smooth_and_merge(t_start, t_end, raw):
    """Règles de detect_with_model : lissage médian sur P.SMOOTH fenêtres puis intervalles."""
    raw = np.asarray(raw, int)
    if not len(raw):
        return raw, []
    sm = medfilt(raw, P.SMOOTH).astype(int) if P.SMOOTH > 1 else raw
    return sm, P.windows_to_intervals(np.asarray(t_start), np.asarray(t_end), sm)


def _r(v, d=3):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), d)


# ==========================================================================
# 1. Temps réel
# ==========================================================================
class LiveSession:
    def __init__(self, rid, t0):
        self.rid = rid
        self.rec = A.STORE.get(rid)
        self.fs = self.rec.fs
        self.nw = int(round(P.WIN_S * self.fs))
        self.step = int(round(self.nw * (1 - P.OVERLAP)))
        self.n = self.rec.n
        self.duration = self.n / self.fs
        self.channels = self.rec.channels
        self.X = self.rec.df[self.channels].to_numpy()          # une seule copie (lecture seule) par session
        self.disp = display_channels(self.rec)
        self.disp_idx = [self.channels.index(c) for c in self.disp]
        self.model, self.minfo = model_for(rid)
        self.truth = A.truth_intervals(rid)
        self.offline = self._offline()
        self.done = {"revealed": [], "fa": 0}                    # segments déjà joués (avant un saut)
        self.conc = [0, 0, 0.0]                                  # fenêtres comparées, même décision, Σ|Δp|
        self.lock = threading.Lock()
        self.start_segment(t0)

    def _offline(self):
        """Probabilités de l'analyse complète (même modèle), pour mesurer la concordance seulement."""
        try:
            feats, _ = A.compute_features(self.rid, self.rec)
            feats = feats.sort_values("t_start")
            p, _ = predict(self.model, feats)
            return dict(zip(np.round(feats["t_start"].values, 3), p))
        except Exception as e:                                   # la démonstration fonctionne sans
            log.warning("Concordance indisponible (%s) : %s", self.rid, e)
            return None

    def start_segment(self, t0):
        k0 = int(np.floor(max(0.0, min(t0, self.duration - 5)) * self.fs / self.step))
        self.i0 = k0 * self.step                                 # début aligné sur la grille des fenêtres
        self.t0 = self.i0 / self.fs
        self.arrived = self.i0                                   # échantillons « reçus »
        self.disp_end = self.i0                                  # échantillons déjà envoyés au tracé
        self.k_next = k0                                         # prochaine fenêtre à traiter
        self.ts, self.te, self.p, self.raw = [], [], [], []
        self.t_proc = self.t0

    # ---- un pas : dt secondes de signal arrivent ; on traite les fenêtres devenues complètes
    def advance(self, dt):
        new_arrived = min(self.n, self.arrived + int(round(float(dt) * self.fs)))
        ended = new_arrived >= self.n
        usable = new_arrived - (0 if ended else int(round(LOOKAHEAD_S * self.fs)))   # filtre stabilisé
        new_windows = []
        k_last = (usable - self.nw) // self.step                 # dernière fenêtre complète et sûre
        if k_last >= self.k_next:
            a = max(self.i0, self.k_next * self.step - int(PAD_S * self.fs))
            feats = features_of(frame(self.X[a:new_arrived].astype(np.float64), self.fs, self.channels, a / self.fs),
                                self.fs, self.channels, self.rid)
            feats["t_start"] += a / self.fs
            feats["t_end"] += a / self.fs
            ks = np.round(feats["t_start"].values * self.fs / self.step).astype(int)
            feats = feats[(ks >= self.k_next) & (ks <= k_last)]
            proba, raw = predict(self.model, feats)
            for s, e, pp, rr in zip(feats["t_start"].values, feats["t_end"].values, proba, raw):
                s, e, pp = float(s), float(e), float(pp)
                self.ts.append(s); self.te.append(e); self.p.append(pp); self.raw.append(int(rr))
                new_windows.append([round(s, 3), round(e, 3), round(pp, 4), int(rr)])
                ref = self.offline.get(round(s, 3)) if self.offline else None
                if ref is not None:
                    self.conc[0] += 1; self.conc[1] += int((pp > 0.5) == (ref > 0.5)); self.conc[2] += abs(pp - ref)
            self.k_next = k_last + 1
        # tracé : même filtrage que la détection (médiane retirée, passe-bande), jusqu'à la partie sûre
        disp = None
        if usable > self.disp_end:
            a = max(self.i0, self.disp_end - int(PAD_S * self.fs))
            seg = self.X[a:new_arrived].astype(np.float64)
            f = P.bandpass(seg - np.median(seg, axis=0), self.fs)
            part = f[self.disp_end - a: usable - a: DISP_DECIM][:, self.disp_idx]
            disp = {"t0": round(self.disp_end / self.fs, 5), "dt": DISP_DECIM / self.fs,
                    "data": np.round(part.T, 1).tolist()}
            self.disp_end += len(part) * DISP_DECIM
        self.arrived = new_arrived
        self.t_proc = self.disp_end / self.fs
        return self.snapshot(new_windows, disp, ended)

    def _state(self, ended):
        """Détection (règles de detect()) sur les fenêtres définitives : le lissage médian
        attend la fenêtre suivante. Puis crises annotées déjà passées et fausses alarmes closes."""
        n_final = len(self.raw) if ended else max(0, len(self.raw) - P.SMOOTH // 2)
        if not n_final:
            return [], None, [], 0
        sm, _ = smooth_and_merge(self.ts, self.te, self.raw)
        ev = P.windows_to_intervals(np.array(self.ts[:n_final]), np.array(self.te[:n_final]), sm[:n_final])
        last = self.te[n_final - 1]
        revealed = [(s, e) for s, e in self.truth if s >= self.t0 and e <= last]
        rows = []
        if revealed:
            m = P.match_events(revealed, ev)
            for _, r in m[m["Résultat"] != "Fausse alarme"].iterrows():
                det = r["Résultat"] == "Détectée"
                rows.append({"start": float(r["Début réel"]), "end": float(r["Fin réelle"]), "detected": bool(det),
                             "delay": _r(r["Retard début (s)"], 1) if det else None})
        events, fa = [], 0
        for s, e in ev:
            open_ = (not ended) and e >= last - P.MERGE_GAP_S         # peut encore s'allonger ou fusionner
            any_truth = any(s < te and e > ts for ts, te in self.truth)
            if open_:
                status = "open"
            elif not any_truth:
                status = "fa"; fa += 1
            elif any(s < te and e > ts for ts, te in revealed):
                status = "hit"
            else:
                status = "pending"                                       # la crise annotée n'est pas finie
            events.append({"start": float(s), "end": float(e), "status": status})
        return events, last, rows, fa

    def snapshot(self, new_windows, disp, ended):
        events, last, rows, fa = self._state(ended)
        alarm = None
        if events and last is not None and events[-1]["end"] >= last - 1e-6:
            alarm = {"start": events[-1]["start"], "end": events[-1]["end"]}
        rev = self.done["revealed"] + rows
        det = [r for r in rev if r["detected"]]
        n, same, sabs = self.conc
        return {
            "t_proc": round(self.t_proc, 4), "t0": self.t0, "ended": bool(ended),
            "windows": new_windows, "disp": disp, "events": events, "alarm": alarm, "revealed": rows,
            "counters": {"annotated": len(rev), "detected": len(det), "false_alarms": self.done["fa"] + fa,
                         "mean_delay": _r(np.mean([r["delay"] for r in det]), 2) if det else None},
            "concordance": {"n": n, "same": same, "mean_abs": _r(sabs / n, 4) if n else None} if self.offline else None,
        }

    def seek(self, t):
        """Saut dans l'enregistrement : le segment joué compte toujours dans les compteurs.
        Une détection coupée par le saut et qui ne touche aucune crise annotée compte comme fausse alarme."""
        events, last, rows, fa = self._state(False)
        fa += sum(1 for ev in events if ev["status"] == "open"
                  and not any(ev["start"] < te and ev["end"] > ts for ts, te in self.truth))
        self.done["revealed"] += rows
        self.done["fa"] += fa
        self.start_segment(t)


SESSIONS = OrderedDict()
_SESS_LOCK = threading.Lock()
MAX_SESSIONS = 3


def _session(sid) -> LiveSession:
    with _SESS_LOCK:
        s = SESSIONS.get(sid)
    if s is None:
        raise HTTPException(404, "Session terminée : relancez la lecture.")
    return s


@router.post("/live/start")
def live_start(rid: str = "230102B-F", t: float = 0.0):
    r = A.CATALOG.get(rid)
    if r["source"] != "local":
        raise HTTPException(400, "Le temps réel porte sur les enregistrements du projet.")
    s = LiveSession(rid, t)
    sid = uuid.uuid4().hex[:12]
    with _SESS_LOCK:
        SESSIONS[sid] = s
        while len(SESSIONS) > MAX_SESSIONS:
            SESSIONS.popitem(last=False)
    return {"sid": sid, "id": rid, "t0": s.t0, "duration": s.duration, "fs": s.fs,
            "disp_fs": s.fs / DISP_DECIM, "channels": s.disp, "lookahead_s": LOOKAHEAD_S,
            "annotated": bool(s.truth), "n_seizures": len(s.truth), "model": s.minfo,
            "params": {"win_s": P.WIN_S, "overlap": P.OVERLAP, "smooth": P.SMOOTH,
                       "merge_gap_s": P.MERGE_GAP_S, "min_event_s": P.MIN_EVENT_S}}


@router.get("/live/{sid}/next")
def live_next(sid: str, dt: float = Query(1.0, ge=0, le=12)):
    s = _session(sid)
    with s.lock:
        return s.advance(dt)


@router.post("/live/{sid}/seek")
def live_seek(sid: str, t: float):
    s = _session(sid)
    with s.lock:
        s.seek(t)
        return {"t0": s.t0}


@router.get("/live/{sid}/next-seizure")
def live_next_seizure(sid: str):
    """Instant de saut : 15 s avant la prochaine crise annotée qui n'a pas encore commencé."""
    s = _session(sid)
    nxt = [a for a, b in s.truth if a - 15 > s.t_proc + 0.5]
    return {"t": max(0.0, nxt[0] - 15) if nxt else None, "remaining": len(nxt)}


@router.post("/live/{sid}/stop")
def live_stop(sid: str):
    with _SESS_LOCK:
        SESSIONS.pop(sid, None)
    return {"ok": True}


# ==========================================================================
# 2. Réglages : probabilités « sans l'enregistrement » de RF et Extra Trees
# ==========================================================================
LAB_MODELS = {"rf": "Random Forest", "et": "Extra Trees"}
PROBA_JOBS = {}
_PROBA_LOCK = threading.Lock()


def make_extra_trees():
    # mêmes hyperparamètres que la cellule « comparaison étendue » du notebook
    from sklearn.ensemble import ExtraTreesClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    return make_pipeline(StandardScaler(), ExtraTreesClassifier(n_estimators=300, min_samples_leaf=2,
                                                                class_weight="balanced_subsample",
                                                                n_jobs=-1, random_state=42))


def _proba_path(key):
    from sklearn import __version__ as skv
    return LAB_DIR / f"probas__{key}__v{LAB_VERSION}-sklearn{skv}-{A._file_key(A.RES_DIR / 'features_windows.csv')}.json"


def annotated_ids():
    return [rid for rid, r in A.CATALOG.recs.items() if r["source"] == "local" and rid in set(A.DATASET["Recording"])]


def _reference_csv(key):
    """Résultat au réglage du projet tel qu'écrit par le notebook (lecture seule)."""
    try:
        if key == "rf":
            d = A.DETECT_CSV
            return {"source": "resultats/detection_par_enregistrement.csv", "n_true": int(d["Crises réelles"].sum()),
                    "detected": int(d["Détectées"].sum()), "false_alarms": int(d["Fausses alarmes"].sum())}
        path = A.LOCAL_DIR / "comparaison_etendue_detection.csv"
        d = pd.read_csv(path).set_index("Modèle").loc["Extra Trees"]
        return {"source": "resultats_local/comparaison_etendue_detection.csv", "n_true": int(d["Crises réelles"]),
                "detected": int(d["Crises détectées"]), "false_alarms": int(d["Fausses alarmes"])}
    except Exception as e:
        log.warning("Référence %s illisible : %s", key, e)
        return None


def _compute_probas(key, job):
    from sklearn.base import clone
    ids = annotated_ids()
    job.update(total=len(ids), done=0)
    t0 = time.time()
    recs = []
    for k, rid in enumerate(ids):
        job.update(current=rid, done=k, elapsed_s=round(time.time() - t0, 1))
        rec = A.STORE.get(rid)
        feats, _ = A.compute_features(rid, rec)
        feats = feats.sort_values("t_start")
        if key == "rf":
            model, _, _ = A.MODELS.leave_one_out(rid)
        else:
            others = A.DATASET[A.DATASET["Recording"] != rid]
            model = clone(make_extra_trees()).fit(others[A.MODELS.features].values, others["Class"].values)
        proba, raw = predict(model, feats)
        recs.append({"id": rid, "hours": (rec.n - 1) / rec.fs / 3600,
                     "t_start": feats["t_start"].round(3).tolist(), "t_end": feats["t_end"].round(3).tolist(),
                     "proba": [float(v) for v in proba], "cls": [int(c) for c in feats["Class"]],
                     "raw": [int(v) for v in raw],
                     "truth": [[s, e] for s, e in A.truth_intervals(rid)]})
    # contrôle côté serveur, avec les fonctions d'eeg_pipeline, au réglage du projet
    tot = {"n_true": 0, "detected": 0, "false_alarms": 0}
    for e in recs:
        _, ev = smooth_and_merge(e["t_start"], e["t_end"], e["raw"])
        m = P.match_events([tuple(t) for t in e["truth"]], ev)
        tot["n_true"] += len(e["truth"])
        tot["detected"] += int((m["Résultat"] == "Détectée").sum())
        tot["false_alarms"] += int((m["Résultat"] == "Fausse alarme").sum())
        del e["raw"]
    return {"model": LAB_MODELS[key], "key": key, "recordings": recs, "server_check": tot,
            "reference": _reference_csv(key), "computed_in_s": round(time.time() - t0, 1),
            "defaults": {"threshold": 0.5, "smooth": P.SMOOTH, "merge_gap_s": P.MERGE_GAP_S,
                         "min_event_s": P.MIN_EVENT_S},
            "rule": "décision = probabilité > seuil (au seuil 0,5, identique à model.predict)"}


def _run_probas(key):
    job = PROBA_JOBS[key]
    try:
        data = _compute_probas(key, job)
        _proba_path(key).write_text(json.dumps(data))
        job.update(status="done", data=data)
        log.info("Probabilités %s calculées en %.0f s", key, data["computed_in_s"])
    except Exception as e:
        log.exception("Échec du calcul des probabilités %s", key)
        job.update(status="error", error=str(e))


def probas(key):
    path = _proba_path(key)
    with _PROBA_LOCK:
        job = PROBA_JOBS.get(key)
        if job and job["status"] == "done":
            return job
        if job is None or job["status"] == "error":
            if path.exists():
                PROBA_JOBS[key] = {"status": "done", "data": json.loads(path.read_text())}
                return PROBA_JOBS[key]
            PROBA_JOBS[key] = job = {"status": "running", "done": 0, "total": 0, "current": None,
                                     "elapsed_s": 0.0, "error": None}
            threading.Thread(target=_run_probas, args=(key,), daemon=True, name=f"lab-{key}").start()
        return job


@router.get("/reglages")
def reglages(model: str = "rf"):
    if model not in LAB_MODELS:
        raise HTTPException(400, "Modèle inconnu : rf ou et.")
    job = probas(model)
    if job["status"] != "done":
        return {k: job.get(k) for k in ("status", "done", "total", "current", "elapsed_s", "error")}
    return {"status": "done", **job["data"]}


# ==========================================================================
# 3. Stress test
# ==========================================================================
def _offline_proba(rid):
    """Probabilités par fenêtre de l'enregistrement complet (cache Réglages s'il existe)."""
    job = PROBA_JOBS.get("rf")
    if job and job["status"] == "done":
        e = next((e for e in job["data"]["recordings"] if e["id"] == rid), None)
        if e:
            return np.array(e["t_start"]), np.array(e["proba"])
    rec = A.STORE.get(rid)
    feats, _ = A.compute_features(rid, rec)
    feats = feats.sort_values("t_start")
    model, _ = model_for(rid)
    p, _ = predict(model, feats)
    return feats["t_start"].values, p


_CALM = {}


@router.get("/stress/calm")
def stress_calm(rid: str = "230102B-F", length: float = 10.0):
    """Extrait « calme » choisi par calcul : loin des crises annotées (≥ 30 s), contexte complet,
    probabilité du modèle la plus basse, puis amplitude la plus proche de la médiane."""
    A.CATALOG.get(rid)
    key = (rid, length)
    if key in _CALM:
        return _CALM[key]
    rec = A.STORE.get(rid)
    ts, p = _offline_proba(rid)
    truth = A.truth_intervals(rid)
    dur = (rec.n - 1) / rec.fs
    X = rec.ensure_filtered()
    fs = int(round(rec.fs))
    span = 15.0                                   # le stress test peut injecter jusqu'à 15 s
    cands = []
    for a in np.arange(CONTEXT_S + 5, dur - span - CONTEXT_S - 5, 1.0):
        lo, hi = a - CONTEXT_S, a + span + CONTEXT_S
        if any(lo - 30 < e and hi + 30 > s for s, e in truth):
            continue
        sel = (ts >= lo) & (ts + P.WIN_S <= hi)
        if not sel.any():
            continue
        seg = X[int(a * fs): int((a + length) * fs)].astype(np.float64)
        rms = float(np.sqrt((seg ** 2).mean(axis=0)).mean())
        cands.append((float(p[sel].max()), rms, float(a)))
    if not cands:
        raise HTTPException(400, "Aucun extrait calme assez long dans cet enregistrement.")
    pm = np.array([c[0] for c in cands])
    low = [c for c in cands if c[0] <= np.quantile(pm, 0.1)]       # les 10 % les plus calmes pour le modèle
    med = float(np.median([c[1] for c in low]))
    best = min(low, key=lambda c: abs(c[1] - med))
    out = {"id": rid, "start": best[2], "end": best[2] + length, "max_proba": _r(best[0], 4),
           "rms_uv": _r(best[1], 1), "n_candidates": len(cands), "duration": dur}
    _CALM[key] = out
    return out


class Chunk:
    """Copie en mémoire d'un extrait brut [a − contexte, b + contexte]."""

    def __init__(self, rid, start, span):
        self.rid = rid
        self.rec = A.STORE.get(rid)
        self.fs = self.rec.fs
        dur = self.rec.n / self.fs
        truth = A.truth_intervals(rid)
        if start < 0 or start + span > dur:
            raise HTTPException(400, "Extrait hors de l'enregistrement.")
        if any(start < e + 5 and start + span > s - 5 for s, e in truth):
            raise HTTPException(400, "Cet extrait touche une crise annotée : choisissez un segment normal.")
        self.start, self.span = float(start), float(span)
        step = int(round(P.WIN_S * self.fs * (1 - P.OVERLAP)))
        i0 = max(0, int(np.floor((start - CONTEXT_S) * self.fs / step)) * step)   # grille des fenêtres conservée
        i1 = min(self.rec.n, int(np.ceil((start + span + CONTEXT_S) * self.fs)))
        self.i0, self.t0 = i0, i0 / self.fs
        self.channels = self.rec.channels
        self.disp = display_channels(self.rec)
        self.disp_idx = [self.channels.index(c) for c in self.disp]
        # .copy() : les injections ne touchent jamais rec.df (ni, a fortiori, le fichier)
        self.X = self.rec.df[self.channels].iloc[i0:i1].to_numpy(dtype=np.float64, copy=True)

    def t(self):
        return self.t0 + np.arange(len(self.X)) / self.fs

    def run(self, X, which="projet"):
        """Chaîne complète sur la copie : filtrage, fenêtres, caractéristiques, modèle, détection."""
        model, minfo = model_for(self.rid)
        if which == "augmente":
            if EXTRA_MODEL is None:
                raise HTTPException(400, "Modèle augmenté indisponible.")
            model = EXTRA_MODEL(self.rid)
            minfo = {**minfo, "label": minfo["label"].replace("ré-entraîné", "augmenté, ré-entraîné")}
        feats = features_of(frame(X, self.fs, self.channels, self.t0), self.fs, self.channels, self.rid)
        feats["t_start"] += self.t0
        feats["t_end"] += self.t0
        d_rec, raw, sm, ev, proba = P.detect_with_model(feats, model, A.MODELS.features)
        return {"t_start": d_rec["t_start"].round(3).tolist(), "t_end": d_rec["t_end"].round(3).tolist(),
                "proba": np.round(proba, 4).tolist(), "raw": [int(v) for v in raw], "smoothed": [int(v) for v in sm],
                "amplitude": d_rec["Amplitude"].round(1).tolist(), "peak_freq": d_rec["Peak_Freq"].round(2).tolist(),
                "events": [[float(s), float(e)] for s, e in ev]}, minfo

    def view(self, X, a, b, raw_too=True):
        """Extrait à afficher : filtré (ce que voit le modèle) et brut (médiane retirée)."""
        i0, i1 = int((a - self.t0) * self.fs), int((b - self.t0) * self.fs)
        f = P.bandpass(X - np.median(X, axis=0), self.fs)
        out = {"t0": i0 / self.fs + self.t0, "channels": [c.replace("EEG", "") for c in self.disp],
               "filtered": {"dt": 2 / self.fs, "data": np.round(f[i0:i1:2][:, self.disp_idx].T, 1).tolist()}}
        if raw_too:
            r = X - np.median(X, axis=0)
            out["raw"] = {"dt": 1 / self.fs, "data": np.round(r[i0:i1][:, self.disp_idx].T, 1).tolist()}
        return out


_BEFORE = {}


def _before(chunk):
    key = (chunk.rid, chunk.start, chunk.span)
    if key not in _BEFORE:
        _BEFORE[key] = chunk.run(chunk.X)[0]
        while len(_BEFORE) > 16:
            _BEFORE.pop(next(iter(_BEFORE)))
    return _BEFORE[key]


def _ch_idx(chunk, names):
    return [chunk.channels.index("EEG" + n) for n in names if "EEG" + n in chunk.channels]


ARTIFACTS = {
    "mouvement": "pic de mouvement : grande déflexion brève sur quelques voies",
    "muscle": "bruit musculaire : bouffée de hautes fréquences (20 à 100 Hz)",
    "secteur": "parasite secteur à 50 Hz sur toutes les voies",
    "electrode": "décollement d'électrode : saut brusque puis lente décroissance sur une voie",
    "clignement": "clignement des yeux : grande onde lente frontale (Fp1, Fp2)",
}


def inject_artifact(chunk, kind, X):
    fs, t = chunk.fs, chunk.t()
    a = chunk.start
    rng = np.random.default_rng(11)
    touched = []
    if kind == "mouvement":
        idx = _ch_idx(chunk, ["T3", "T5", "C3", "F7"])
        for tc, amp in ((a + 3.2, 650.0), (a + 6.7, -480.0)):
            u = (t - tc) / 0.12                              # demi-largeur ~ 120 ms
            shape = np.exp(-0.5 * u ** 2) * (1 - 0.6 * u)    # montée raide, retour un peu plus lent
            for k, j in enumerate(idx):
                X[:, j] += amp * (1 - 0.15 * k) * shape
        touched = idx
    elif kind == "muscle":
        from scipy.signal import butter, sosfiltfilt
        idx = _ch_idx(chunk, ["T3", "T4", "F7", "F8", "T5", "T6"])
        sos = butter(4, [20, 100], btype="band", fs=fs, output="sos")
        env = np.clip(np.minimum((t - (a + 2.0)) / 0.3, ((a + 7.0) - t) / 0.3), 0, 1)
        for j in idx:
            noise = sosfiltfilt(sos, rng.standard_normal(len(t)))
            X[:, j] += 45.0 * noise / noise.std() * env
        touched = idx
    elif kind == "secteur":
        idx = list(range(len(chunk.channels)))
        env = ((t >= a) & (t < a + 10)).astype(float)
        for j in idx:
            X[:, j] += 120.0 * np.sin(2 * np.pi * 50 * t + rng.uniform(0, 2 * np.pi)) * env
        touched = idx
    elif kind == "electrode":
        idx = _ch_idx(chunk, ["C3"]) or [0]
        t1 = a + 2.5
        X[:, idx[0]] += np.where(t >= t1, 900.0 * np.exp(-(t - t1) / 1.2), 0.0)
        touched = idx
    elif kind == "clignement":
        for tc in (a + 1.8, a + 4.9, a + 8.1):
            u = (t - tc) / 0.40                                # onde lente de ~ 400 ms
            shape = np.where(np.abs(u) < 0.5, np.cos(np.pi * u) ** 2, 0.0)
            for names, g in ((["Fp1", "Fp2"], 1.0), (["F7", "F3", "Fz", "F4", "F8"], 0.35)):
                for j in _ch_idx(chunk, names):
                    X[:, j] += -220.0 * g * shape
        touched = _ch_idx(chunk, ["Fp1", "Fp2"])
    else:
        raise HTTPException(400, f"Artefact inconnu : {kind}")
    return [chunk.channels[j].replace("EEG", "") for j in touched]


# ---- décharge pointe-onde synthétique
GAINS = {"Fp1": 1.0, "Fp2": 1.0, "F3": 0.95, "F4": 0.95, "Fz": 0.95, "F7": 0.8, "F8": 0.8,
         "C3": 0.75, "C4": 0.75, "Cz": 0.8, "T3": 0.55, "T4": 0.55, "P3": 0.55, "P4": 0.55, "Pz": 0.6,
         "T5": 0.45, "T6": 0.45, "O1": 0.4, "O2": 0.4}


SPIKE, BUMP, WAVE, WAVE_FRAC = 0.7, 0.35, 1.0, 0.9   # pointe / brève positivité / onde lente (cf. LANCER.md)


def _cycle(u, period, ak=1.0):
    """Un cycle pointe-onde : pointe aiguë (~70 ms à la base), brève positivité, puis onde lente
    sur 90 % du reste du cycle. Avec ces proportions, le pic du spectre tombe sur la fréquence
    de la décharge, comme sur les absences réelles (et non sur une harmonique de la pointe)."""
    spike = -SPIKE * np.exp(-0.5 * ((u - 0.035) / 0.011) ** 2)
    bump = BUMP * np.exp(-0.5 * ((u - 0.075) / 0.020) ** 2)
    w0 = 0.10
    v = (u - w0) / (WAVE_FRAC * max(0.02, period - w0))
    wave = np.where((v >= 0) & (v <= 1), -WAVE * np.sin(np.pi * v), 0.0)
    return ak * (spike + bump + wave)


def spike_wave(t_rel, freq, regularity, rng):
    """Train de pointes-ondes d'amplitude crête à crête 1 (cycle régulier), répété à `freq` Hz ;
    regularity = 1 : parfaitement régulier ; 0 : intervalles et amplitudes variables (±30 %)."""
    out = np.zeros_like(t_rel)
    T = 1.0 / freq
    jit = 1.0 - regularity
    tk, dur = 0.0, (t_rel[-1] if len(t_rel) else 0.0)
    while tk < dur:
        Tk = T * float(np.clip(1 + 0.30 * jit * rng.standard_normal(), 0.6, 1.4))
        ak = float(np.clip(1 + 0.30 * jit * rng.standard_normal(), 0.4, 1.6))
        out += _cycle(t_rel - tk, Tk, ak)
        tk += Tk
    ref = _cycle(np.arange(0, T, 1 / 1024), T)
    return out / (ref.max() - ref.min())


def inject_synth(chunk, X, freq, amp, dur, regularity, onset):
    fs = chunk.fs
    t = chunk.t()
    rng = np.random.default_rng(int(round(freq * 100)) * 7919 + int(round(regularity * 100)))
    i0 = int(round((onset - chunk.t0) * fs))
    n = int(round(dur * fs))
    t_rel = np.arange(n) / fs
    base = spike_wave(t_rel, freq, regularity, rng)
    taper = np.clip(np.minimum(t_rel / 0.05, (dur - t_rel) / 0.05), 0, 1)       # pas de marche aux bords
    ch_rng = np.random.default_rng(2024)
    for j, c in enumerate(chunk.channels):
        g = GAINS.get(c.replace("EEG", ""), 0.6) * (1 + 0.08 * ch_rng.standard_normal())
        lag = int(round(ch_rng.uniform(-0.004, 0.004) * fs))
        sig = np.roll(base, lag) * taper
        X[i0:i0 + n, j] += amp * g * sig[: len(X) - i0]
    return t[i0], t[i0] + n / fs


def template_preview(freq, regularity):
    """Deux cycles du gabarit (Fp1), pour le dessin."""
    rng = np.random.default_rng(1)
    t_rel = np.arange(0, 2 / freq, 1 / 256)
    return {"dt": 1 / 256, "y": np.round(spike_wave(t_rel, freq, 1.0, rng), 4).tolist()}


class ArtifactIn(BaseModel):
    rid: str = "230102B-F"
    start: float
    kind: str


@router.post("/stress/artifact")
def stress_artifact(q: ArtifactIn):
    t0 = time.time()
    chunk = Chunk(q.rid, q.start, 10.0)
    before = _before(chunk)
    X = chunk.X.copy()
    touched = inject_artifact(chunk, q.kind, X)
    after, minfo = chunk.run(X)
    a, b = chunk.start, chunk.start + 10
    hit_after = [e for e in after["events"] if e[0] < b and e[1] > a]
    hit_before = [e for e in before["events"] if e[0] < b and e[1] > a]
    return {"kind": q.kind, "label": ARTIFACTS.get(q.kind), "start": a, "end": b, "channels_touched": touched,
            "before": before, "after": after, "model": minfo,
            "verdict": "Fausse alarme" if hit_after else "Pas d'alarme",
            "events_in_segment": hit_after, "events_before": hit_before,
            "view_before": chunk.view(chunk.X, a - 1, b + 1), "view_after": chunk.view(X, a - 1, b + 1),
            "elapsed_s": round(time.time() - t0, 2)}


class SynthIn(BaseModel):
    rid: str = "230102B-F"
    start: float
    freq: float = 3.0
    amp: float = 150.0
    dur: float = 6.0
    regularity: float = 0.8
    model: str = "projet"


def _check_synth(q):
    if not (2 <= q.freq <= 5 and 20 <= q.amp <= 400 and 2 <= q.dur <= 15 and 0 <= q.regularity <= 1):
        raise HTTPException(400, "Paramètres hors bornes.")


def run_synth(chunk, freq, amp, dur, regularity, which="projet"):
    X = chunk.X.copy()
    onset = chunk.start + 0.5
    s, e = inject_synth(chunk, X, freq, amp, dur, regularity, onset)
    after, minfo = chunk.run(X, which)
    m = P.match_events([(s, e)], [tuple(v) for v in after["events"]])
    row = m.iloc[0]
    det = row["Résultat"] == "Détectée"
    ts, te, p = np.array(after["t_start"]), np.array(after["t_end"]), np.array(after["proba"])
    inside = (ts >= s) & (te <= e)
    return X, (s, e), after, minfo, {
        "detected": bool(det), "delay": _r(row["Retard début (s)"], 1) if det else None,
        "mean_proba": _r(p[inside].mean(), 4) if inside.any() else None,
        "max_proba": _r(p[(ts < e) & (te > s)].max(), 4) if ((ts < e) & (te > s)).any() else None,
        "fa_outside": sum(1 for v in after["events"] if not (v[0] < e and v[1] > s)),
        # ce que la chaîne mesure sur la décharge injectée (médiane des fenêtres entièrement dedans)
        "measured_amplitude": _r(np.median(np.array(after["amplitude"])[inside]), 1) if inside.any() else None,
        "measured_peak_freq": _r(np.median(np.array(after["peak_freq"])[inside]), 2) if inside.any() else None}


@router.post("/stress/synth")
def stress_synth(q: SynthIn):
    _check_synth(q)
    t0 = time.time()
    chunk = Chunk(q.rid, q.start, max(10.0, q.dur + 0.5))
    X, (s, e), after, minfo, res = run_synth(chunk, q.freq, q.amp, q.dur, q.regularity, q.model)
    return {"start": chunk.start, "onset": s, "end": e, "params": q.model_dump(), "after": after,
            "before": _before(chunk), "model": minfo, **res,
            "verdict": "Détectée" if res["detected"] else "Non détectée",
            "view": chunk.view(X, max(chunk.t0, s - 2), min(e + 3, chunk.t0 + len(X) / chunk.fs), raw_too=False),
            "template": template_preview(q.freq, q.regularity), "elapsed_s": round(time.time() - t0, 2)}


# ---- cartographie fréquence × amplitude (tâche de fond, mise en cache)
MAP_FREQS = [round(2 + 0.25 * k, 2) for k in range(13)]          # 2 à 5 Hz, pas de 0,25
MAP_AMPS = [round(20 + 38 * k) for k in range(11)]               # 20 à 400 µV
MAP_JOBS = {}
_MAP_LOCK = threading.Lock()


class MapIn(BaseModel):
    rid: str = "230102B-F"
    start: float
    dur: float = 6.0
    regularity: float = 0.8
    model: str = "projet"


def _map_path(q):
    from sklearn import __version__ as skv
    r = A.CATALOG.get(q.rid)
    import augmentation as AUGM
    mtag = f"__aug-{AUGM.latest()}" if q.model == "augmente" else ""
    return LAB_DIR / (f"carte__{q.rid}__{q.start:g}__{q.dur:g}__{q.regularity:g}{mtag}__v{LAB_VERSION}"
                      f"-sklearn{skv}-{A._file_key(r['path'])}.json")


def _shap_groups():
    """Importance SHAP globale (notebook, resultats_local/) regroupée : amplitude ou fréquence."""
    path = A.LOCAL_DIR / "shap_importance_globale.csv"
    if not path.exists():
        return None
    d = pd.read_csv(path, index_col=0).iloc[:, 0]
    amp = ["Std", "Variance", "Min", "Max", "Amplitude", "RMS", "Energy"]
    freq = ["Rel_Delta", "Rel_Theta", "Rel_Alpha", "Rel_Beta", "Peak_Freq"]
    tot = float(d.sum())
    return {"source": "resultats_local/shap_importance_globale.csv", "top": str(d.idxmax()),
            "amplitude_share": float(d[d.index.isin(amp)].sum() / tot),
            "frequency_share": float(d[d.index.isin(freq)].sum() / tot),
            "amplitude_features": amp, "frequency_features": freq}


def _map_summary(grid_p, grid_det):
    """Part de la variation de la probabilité due à l'amplitude et à la fréquence (effets principaux)."""
    G = np.array(grid_p, float)                                   # [amplitude, fréquence]
    tot = float(((G - G.mean()) ** 2).mean())
    by_amp = float(((G.mean(axis=1) - G.mean()) ** 2).mean())
    by_freq = float(((G.mean(axis=0) - G.mean()) ** 2).mean())
    det = np.array(grid_det, bool)
    first_amp = []
    for j in range(det.shape[1]):
        k = np.argmax(det[:, j]) if det[:, j].any() else None
        first_amp.append(MAP_AMPS[k] if k is not None else None)
    return {"var_amplitude": by_amp / tot if tot else 0.0, "var_frequency": by_freq / tot if tot else 0.0,
            "detected_cells": int(det.sum()), "cells": int(det.size), "first_detected_amp": first_amp}


def _run_map(job_id, q):
    job = MAP_JOBS[job_id]
    try:
        with _MAP_LOCK:
            t0 = time.time()
            chunk = Chunk(q.rid, q.start, max(10.0, q.dur + 0.5))
            n = len(MAP_FREQS) * len(MAP_AMPS)
            grid_p = [[None] * len(MAP_FREQS) for _ in MAP_AMPS]
            grid_d = [[False] * len(MAP_FREQS) for _ in MAP_AMPS]
            grid_delay = [[None] * len(MAP_FREQS) for _ in MAP_AMPS]
            k = 0
            for j, f in enumerate(MAP_FREQS):
                for i, a in enumerate(MAP_AMPS):
                    job.update(done=k, total=n, current=f"{f:g} Hz, {a} µV", elapsed_s=round(time.time() - t0, 1))
                    _, _, _, _, res = run_synth(chunk, f, a, q.dur, q.regularity, q.model)
                    grid_p[i][j], grid_d[i][j], grid_delay[i][j] = res["mean_proba"], res["detected"], res["delay"]
                    k += 1
            data = {"params": q.model_dump(), "freqs": MAP_FREQS, "amps": MAP_AMPS, "proba": grid_p,
                    "detected": grid_d, "delay": grid_delay, "summary": _map_summary(grid_p, grid_d),
                    "shap": _shap_groups(), "computed_in_s": round(time.time() - t0, 1)}
            _map_path(q).write_text(json.dumps(data))
            job.update(status="done", done=n, data=data)
    except HTTPException as e:
        job.update(status="error", error=e.detail)
    except Exception as e:
        log.exception("Échec de la cartographie")
        job.update(status="error", error=str(e))


@router.post("/stress/map")
def stress_map(q: MapIn):
    _check_synth(SynthIn(rid=q.rid, start=q.start, dur=q.dur, regularity=q.regularity))
    if q.model == "augmente":
        import augmentation as AUGM
        if not AUGM.latest():
            raise HTTPException(400, "Aucun modèle augmenté : lancez d'abord l'entraînement dans Laboratoire · Augmentation.")
    path = _map_path(q)
    job_id = uuid.uuid4().hex[:12]
    if path.exists():
        MAP_JOBS[job_id] = {"status": "done", "data": json.loads(path.read_text()), "cached": True}
    else:
        MAP_JOBS[job_id] = {"status": "running", "done": 0, "total": len(MAP_FREQS) * len(MAP_AMPS),
                            "current": None, "elapsed_s": 0.0, "error": None}
        threading.Thread(target=_run_map, args=(job_id, q), daemon=True, name="lab-carte").start()
    return {"job": job_id}


@router.get("/stress/map/{job_id}")
def stress_map_status(job_id: str):
    job = MAP_JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche inconnue")
    if job["status"] != "done":
        return {k: job.get(k) for k in ("status", "done", "total", "current", "elapsed_s", "error")}
    return {"status": "done", "cached": job.get("cached", False), **job["data"]}


@router.get("/stress/info")
def stress_info():
    """Artefacts proposés et repères calculés sur le jeu d'entraînement (features_windows.csv)."""
    d = A.DATASET
    med = lambda col, k: _r(d.loc[d["Class"] == k, col].median(), 2)
    return {"artifacts": ARTIFACTS, "freqs": MAP_FREQS, "amps": MAP_AMPS,
            "dataset": {"seizure_amplitude": med("Amplitude", 1), "normal_amplitude": med("Amplitude", 0),
                        "seizure_peak_freq": med("Peak_Freq", 1), "n_windows": int(len(d))},
            "recordings": [rid for rid, r in A.CATALOG.recs.items() if r["source"] == "local"]}
