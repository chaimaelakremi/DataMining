"""Page « Anticipation » : résultats de la section « Anticipation des crises (exploratoire) » du notebook.

Lecture seule de resultats_local/anticipation/ (tableaux CSV écrits par le notebook).
Si les tableaux manquent, la réponse indique simplement que l'analyse n'est pas disponible.
"""
import math
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
ANT_DIR = ROOT / "resultats_local" / "anticipation"
FILES = ["resume.csv", "courbe.csv", "alarmes.csv", "hasard.csv", "crises_reference.csv"]


def _num(v):
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return v.item() if hasattr(v, "item") else v


def bundle():
    if not all((ANT_DIR / f).exists() for f in FILES):
        return {"available": False}
    res, cb, al, hz, cr = (pd.read_csv(ANT_DIR / f) for f in FILES)
    key = lambda m, h: f"{m}|{int(h)}"
    models = [{"id": m, "description": d} for m, d in res.drop_duplicates("Modèle")[["Modèle", "Description"]].values]
    resume = [{"model": r["Modèle"], "horizon": int(r["Horizon (s)"]), "auc": _num(r["AUC"]),
               "announced": int(r["Crises annoncées"]), "n_ref": int(r["Crises de référence"]),
               "median_lead_s": _num(r["Délai médian (s)"]), "false_per_hour": _num(r["Fausses annonces / h"]),
               "chance_mean": _num(r["Annoncées par hasard (moyenne)"]), "p": _num(r["p (hasard)"])} for _, r in res.iterrows()]
    courbe = {key(m, h): {"t": g["t (s)"].tolist(), "mean": [_num(v) for v in g["Probabilité moyenne"]],
                          "lo": [_num(v) for v in g["IC95 bas"]], "hi": [_num(v) for v in g["IC95 haut"]]}
              for (m, h), g in cb.groupby(["Modèle", "Horizon (s)"])}
    alarmes = {}
    for (m, h), g in al.groupby(["Modèle", "Horizon (s)"]):
        alarmes[key(m, h)] = {f"{i}|{int(c)}": [_num(v) for v in gg["t (s)"]] for (i, c), gg in g.groupby(["ID", "Crise"])}
    hasard = {key(m, h): [[int(a), int(b)] for a, b in g[["Crises annoncées (tirage)", "Tirages"]].values]
              for (m, h), g in hz.groupby(["Modèle", "Horizon (s)"])}
    crises = [{"id": r["ID"], "n": int(r["Crise"]), "start": _num(r["Début (s)"]), "duration": _num(r["Durée (s)"])} for _, r in cr.iterrows()]
    return {"available": True, "horizons": sorted(int(h) for h in res["Horizon (s)"].unique()), "models": models,
            "resume": resume, "courbe": courbe, "alarmes": alarmes, "hasard": hasard, "crises": crises,
            "draws": int(hz.groupby(["Modèle", "Horizon (s)"])["Tirages"].sum().iloc[0]) if len(hz) else None}
