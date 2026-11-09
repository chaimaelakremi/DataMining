"""
Journal d'examen : lecture des fichiers `<ID>_0000h.mat`.

Chaque fichier contient une timetable MATLAB (`output_h`) avec deux variables,
« Annotations » (tableau de chaînes MATLAB) et « Duration ». Elle consigne le
déroulé de l'examen : yeux ouverts / fermés (YO, YF), hyperpnée (HPN),
stimulation lumineuse intermittente (SLI=…Hz), saturations d'amplificateur, etc.

Décodage : même approche que `_read_timetable` (eeg_pipeline.py), en prenant le
DERNIER champ de l'objet opaque MCOS.
- temps des lignes : tableau float de longueur numRows, en millisecondes ;
- chaînes : tableau uint64 [version, ndims, dims…, une longueur par chaîne,
  puis les caractères en unités UTF-16 regroupées par 4 dans des uint64].

Ce module est en lecture seule et n'intervient pas dans la détection.
"""
import io
import re
from pathlib import Path

import numpy as np
from scipy.io import loadmat
from scipy.io.matlab._mio5 import MatFile5Reader

# Les fichiers ont été exportés avec les lettres accentuées déjà perdues : chaque « é »
# (2 octets en UTF-8) y est stocké comme deux caractères U+FFFD. On les rétablit à partir
# des mots effectivement rencontrés dans les 22 journaux ; tout autre cas devient « ? ».
_LOST = "\ufffd\ufffd"
_REPAIRS = {
    f"D{_LOST}but": "Début",
    f"d{_LOST}but": "début",
    f"vid{_LOST}o": "vidéo",
    f"pr{_LOST}parer": "préparer",
    f"palp{_LOST}brales": "palpébrales",
    f"r{_LOST}pond": "répond",
}

GROUP_GAP_S = 60.0       # deux lignes HPN (ou SLI) séparées de moins de 60 s : même épreuve
NEAR_SATURATION_S = 5.0  # « proche d'une saturation » : à moins de 5 s d'une détection


def _subsystem_objects(path):
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
    objects = opaque[opaque.dtype.names[-1]] if opaque.dtype.names else opaque
    return np.atleast_1d(objects).ravel()


def _decode_string_array(a):
    a = np.asarray(a, dtype=np.uint64)
    nd = int(a[1])
    n = int(np.prod(a[2:2 + nd]))
    lengths = a[2 + nd:2 + nd + n].astype(int)
    units = a[2 + nd + n:].view(np.uint16)
    if lengths.sum() > units.size:
        raise ValueError("tableau de chaînes tronqué")
    out, p = [], 0
    for k in lengths:
        out.append(units[p:p + k].tobytes().decode("utf-16-le", errors="replace"))
        p += k
    return out


def _repair(label):
    for bad, good in _REPAIRS.items():
        label = label.replace(bad, good)
    label = label.replace(f" {_LOST} ", " à ")
    return label.replace(_LOST, "?").replace("\ufffd", "?").strip()


def read_journal_rows(path):
    """[(temps en s, libellé)] dans l'ordre du fichier."""
    objects = _subsystem_objects(path)
    tt = next((o for o in objects if hasattr(o, "_fieldnames") and "varNames" in o._fieldnames), None)
    if tt is None:
        raise ValueError(f"Timetable introuvable dans {Path(path).name}")
    n = int(tt.numRows)
    times = next((np.asarray(o, float) for o in objects
                  if isinstance(o, np.ndarray) and o.dtype == float and o.size == n
                  and np.isfinite(o).all()), None)
    labels = None
    for o in objects:
        if isinstance(o, np.ndarray) and o.dtype == np.uint64 and o.size > 3 and int(o[0]) == 1:
            try:
                s = _decode_string_array(o)
            except ValueError:
                continue
            if len(s) == n:
                labels = s
                break
    if times is None or labels is None:
        raise ValueError(f"Annotations illisibles dans {Path(path).name}")
    return [(round(float(t) / 1000.0, 3), _repair(s)) for t, s in zip(times, labels)]


# --------------------------------------------------------------------------
# Classement et regroupement
# --------------------------------------------------------------------------
_RE_SLI = re.compile(r"^SLI\s*=\s*(\d+(?:[.,]\d+)?)\s*Hz", re.I)
_RE_HPN = re.compile(r"^HPN\b", re.I)
_RE_HPN_START = re.compile(r"^HPN\s*(\d+)\s*mn", re.I)
_RE_HPN_STEP = re.compile(r"^HPN\s*-\s*(\d\d:\d\d:\d\d)", re.I)
_RE_STOP = re.compile(r"^Stop\s*:\s*(\d\d:\d\d:\d\d)", re.I)
_RE_SAT = re.compile(r"^SATURATION\b", re.I)
_EYES = {"YO": "Yeux ouverts", "YF": "Yeux fermés"}


def classify(label):
    if label.upper() in _EYES:
        return "yeux"
    if _RE_HPN.match(label):
        return "hpn"
    if _RE_SLI.match(label):
        return "sli"
    if _RE_SAT.match(label):
        return "saturation"
    return "autre"


def _saturation_channels(label):
    _, _, rest = label.partition(":")
    chans = rest.split()
    return chans if chans else ["toutes les voies"]


def build_journal(rows):
    """
    Regroupe les lignes en événements :
    - hpn / sli : un intervalle par épreuve (time_s → end_s), étapes conservées dans `steps` ;
    - saturation : événement ponctuel avec la liste `channels` ;
    - yeux : YO / YF ; autre : tout le reste (artefact, mouvement, remarque du technicien…).
    """
    events, open_group = [], None

    def close():
        nonlocal open_group
        if open_group is not None:
            g = open_group
            g["end_s"] = g["steps"][-1]["time_s"]
            if g["type"] == "hpn":
                m = _RE_HPN_START.match(g["steps"][0]["label"])
                g["label"] = f"Hyperpnée {m.group(1)} min" if m else "Hyperpnée"
            else:
                freqs = [s["freq_hz"] for s in g["steps"] if s.get("freq_hz") is not None]
                lo, hi = (min(freqs), max(freqs)) if freqs else (None, None)
                g["label"] = ("SLI" if lo is None else f"SLI {_fmt_hz(lo)} Hz" if lo == hi
                              else f"SLI {_fmt_hz(lo)}–{_fmt_hz(hi)} Hz")
            events.append(g)
            open_group = None

    for t, label in rows:
        kind = classify(label)
        is_stop = bool(_RE_STOP.match(label))
        # « Stop : 00:05:14 » juste après des lignes HPN : fin anticipée de l'hyperpnée
        if is_stop and open_group and open_group["type"] == "hpn" and t - open_group["steps"][-1]["time_s"] <= GROUP_GAP_S:
            open_group["steps"].append({"time_s": t, "label": label})
            continue
        if kind in ("hpn", "sli"):
            if open_group and (open_group["type"] != kind or t - open_group["steps"][-1]["time_s"] > GROUP_GAP_S):
                close()
            step = {"time_s": t, "label": label}
            if kind == "sli":
                step["freq_hz"] = float(_RE_SLI.match(label).group(1).replace(",", "."))
            if open_group is None:
                open_group = {"type": kind, "time_s": t, "steps": []}
            open_group["steps"].append(step)
            if kind == "hpn" and re.search(r"\bfin\b", label, re.I):
                close()
            continue
        ev = {"type": kind, "time_s": t, "label": label}
        if kind == "saturation":
            ev["channels"] = _saturation_channels(label)
        elif kind == "yeux":
            ev["label"] = label.upper()
            ev["detail"] = _EYES[label.upper()]
        events.append(ev)
    close()
    events.sort(key=lambda e: e["time_s"])
    return events


def _fmt_hz(v):
    return f"{v:g}"


def load_journal(path):
    return build_journal(read_journal_rows(path))


# --------------------------------------------------------------------------
# Mise en relation avec les crises (pour le résumé de l'analyse)
# --------------------------------------------------------------------------
def context_lines(journal, truth, detections):
    """
    Faits calculés à partir du journal :
    - nombre de crises annotées (ou de détections, sans annotation) pendant chaque épreuve HPN / SLI ;
    - détections situées à moins de NEAR_SATURATION_S d'une saturation, avec les voies concernées.
    `truth` et `detections` : listes de (début, fin) en secondes.
    """
    out = {"epreuves": [], "saturation": None}
    ref, what = (truth, "crises annotées") if truth else (detections, "détections")
    for g in (e for e in journal if e["type"] in ("hpn", "sli")):
        k = sum(1 for s, e in ref if s < g["end_s"] and e > g["time_s"])
        out["epreuves"].append({"type": g["type"], "label": g["label"], "start": g["time_s"], "end": g["end_s"],
                                "count": k, "total": len(ref), "of": what})
    sats = [e for e in journal if e["type"] == "saturation"]
    near, chans = 0, []
    for s, e in detections:
        close_sats = [x for x in sats if s - NEAR_SATURATION_S <= x["time_s"] <= e + NEAR_SATURATION_S]
        if close_sats:
            near += 1
            for x in close_sats:
                chans += [c for c in x["channels"] if c not in chans]
    if detections:
        out["saturation"] = {"count": near, "total": len(detections), "channels": chans,
                             "tolerance_s": NEAR_SATURATION_S}
    return out
