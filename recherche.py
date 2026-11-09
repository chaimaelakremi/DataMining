"""Résultats des analyses du notebook (dossier resultats_local/), en lecture seule.

L'application n'y calcule rien : elle relit les tableaux CSV et les figures PNG que
le notebook a enregistrés. Tout ce qui manque est simplement absent de la réponse
(la page n'affiche alors pas le bloc correspondant). Rien n'est écrit dans
resultats_local/ ; les deux figures extraites du notebook vont dans .cache/.
"""
import base64
import html
import json
import math
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
LOCAL_DIR = ROOT / "resultats_local"
SYN_DIR = LOCAL_DIR / "syndrome"
NOTEBOOK = ROOT / "EEG_Absence_Detection.ipynb"
CACHE_DIR = ROOT / ".cache" / "recherche"

# clé -> fichier PNG enregistré par le notebook
FIGURES = {
    "frequence_evolution": LOCAL_DIR / "figures" / "frequence_evolution_moyenne.png",
    "frequence_patients": LOCAL_DIR / "figures" / "frequence_patients_atypique_adulte.png",
    "typologie_silhouette": LOCAL_DIR / "figures" / "typologie_silhouette.png",
    "typologie_dendrogramme": LOCAL_DIR / "figures" / "typologie_dendrogramme.png",
    "typologie_acp": LOCAL_DIR / "figures" / "typologie_acp.png",
    "shap_global": LOCAL_DIR / "figures" / "shap_global_beeswarm.png",
    "shap_vp_fp": LOCAL_DIR / "figures" / "shap_vraies_detections_vs_fausses_alertes.png",
    "shap_cas_1": LOCAL_DIR / "figures" / "shap_cas_1_crise_detectee.png",
    "shap_cas_2": LOCAL_DIR / "figures" / "shap_cas_2_fausse_alarme.png",
    "shap_cas_3": LOCAL_DIR / "figures" / "shap_cas_3_debut_de_crise_manque.png",
    "shap_cas_4": LOCAL_DIR / "figures" / "shap_cas_4_patient_atypique.png",
    "tests_ic95": LOCAL_DIR / "figures" / "tests_modeles_ic95.png",
    "apprentissage": LOCAL_DIR / "figures" / "courbe_apprentissage.png",
    "syn_age_frequence": SYN_DIR / "figures" / "age_frequence_des_decharges.png",
    "syn_groupes": SYN_DIR / "figures" / "morphologie_par_groupe_d_age.png",
    "syn_detection": SYN_DIR / "figures" / "detection_et_morphologie.png",
    "syn_extraits": SYN_DIR / "figures" / "extraits_eeg_selon_l_age.png",
    "syn_synthese": SYN_DIR / "figures" / "synthese_age_morphologie_detection.png",
}
# clé -> texte qui identifie la cellule du notebook dont on reprend la figure (non enregistrée en PNG)
NOTEBOOK_FIGURES = {
    "fenetres": 'courbes = [("F1-score", "F1-score (niveau fenêtre, GroupKFold)"',
    "modeles_f1": "# Une figure : F1 sur la séparation aléatoire et F1 par enregistrement",
}
FENETRES_MARK = "comparaison = stats_fenetres"


def _clean(v):
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if hasattr(v, "item"):
        v = v.item()
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
    return v


def _csv(path, **kw):
    try:
        return pd.read_csv(path, **kw) if path.exists() else None
    except Exception:
        return None


def _table(df, spec):
    """spec : liste de (colonne, libellé, décimales) ; décimales None = texte, "p" = valeur p."""
    if df is None:
        return None
    spec = [s for s in spec if s[0] in df.columns]
    return {"cols": [{"label": lab, "num": dec is not None, "dec": dec} for _, lab, dec in spec],
            "rows": [[_clean(r[c]) for c, _, _ in spec] for _, r in df.iterrows()]}


# ---- Notebook : tableau et figures qui n'existent que dans ses sorties ----
_NB = {"mtime": None, "cells": None}


def _notebook_cells():
    if not NOTEBOOK.exists():
        return []
    mt = NOTEBOOK.stat().st_mtime_ns
    if _NB["mtime"] != mt:
        with open(NOTEBOOK, encoding="utf-8") as fh:
            _NB["cells"] = json.load(fh).get("cells", [])
        _NB["mtime"] = mt
    return _NB["cells"]


def _cell_with(mark):
    for c in _notebook_cells():
        if c.get("cell_type") == "code" and mark in "".join(c.get("source", [])):
            return c
    return None


def _notebook_figure(key):
    """PNG d'une cellule du notebook, copié une fois dans .cache/recherche/."""
    cell = _cell_with(NOTEBOOK_FIGURES[key])
    if cell is None:
        return None
    for o in cell.get("outputs", []):
        png = o.get("data", {}).get("image/png")
        if png:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            out = CACHE_DIR / f"{key}__{_NB['mtime']}.png"
            if not out.exists():
                for old in CACHE_DIR.glob(f"{key}__*.png"):
                    old.unlink()
                out.write_bytes(base64.b64decode("".join(png) if isinstance(png, list) else png))
            return out
    return None


def figure_path(key):
    if key in FIGURES:
        return FIGURES[key] if FIGURES[key].exists() else None
    if key in NOTEBOOK_FIGURES:
        return _notebook_figure(key)
    return None


def _fenetres_table():
    """Tableau comparatif 2 s / 5 s / 10 s, relu dans la sortie HTML de la cellule du notebook."""
    cell = _cell_with(FENETRES_MARK)
    if cell is None:
        return None
    for o in cell.get("outputs", []):
        h = o.get("data", {}).get("text/html")
        if not h:
            continue
        h = "".join(h) if isinstance(h, list) else h
        text = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s)).strip()
        head = re.search(r"<thead>(.*?)</thead>", h, re.S)
        body = re.search(r"<tbody>(.*?)</tbody>", h, re.S)
        if not head or not body:
            continue
        names = [text(x) for x in re.findall(r"<th[^>]*>(.*?)</th>", re.findall(r"<tr[^>]*>(.*?)</tr>", head.group(1), re.S)[0], re.S)][1:]
        rows = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body.group(1), re.S):
            cells = [text(x) for x in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)]
            rows.append(dict(zip(["Fenêtre"] + names, cells)))
        if not rows:
            continue
        df = pd.DataFrame(rows)
        for c in df.columns:
            if c not in ("Fenêtre", "Crises détectées"):
                df[c] = pd.to_numeric(df[c], errors="coerce")
        return df
    return None


# ---- Sections ------------------------------------------------------------
def _modeles():
    out = {}
    m = _csv(LOCAL_DIR / "comparaison_etendue_modeles.csv")
    if m is not None:
        m = m.rename(columns={m.columns[0]: "Modèle"})
        out["table"] = _table(m, [("Modèle", "Modèle", None), ("Accuracy", "Accuracy", 3), ("Precision", "Précision", 3),
                                  ("Recall", "Rappel", 3), ("F1-score", "F1", 3), ("F1 (patients)", "F1 par enregistrement", 3),
                                  ("Precision (patients)", "Précision par enr.", 3), ("Recall (patients)", "Rappel par enr.", 3),
                                  ("Écart F1 (aléatoire − patients)", "Écart de F1", 3)])
        vrais = m[m["F1 (patients)"] > 0].sort_values("F1 (patients)", ascending=False)
        rf = m[m["Modèle"] == "Random Forest"]
        if len(vrais) and len(rf):
            out["facts"] = {"n": int(len(m)), "best": vrais.iloc[0]["Modèle"], "best_f1": _clean(vrais.iloc[0]["F1 (patients)"]),
                            "rf_f1": _clean(rf.iloc[0]["F1 (patients)"]), "rf_f1_random": _clean(rf.iloc[0]["F1-score"]),
                            "best_random": m.sort_values("F1-score", ascending=False).iloc[0]["Modèle"],
                            "gap_min": _clean(vrais["Écart F1 (aléatoire − patients)"].min()),
                            "gap_max": _clean(vrais["Écart F1 (aléatoire − patients)"].max())}
    d = _csv(LOCAL_DIR / "comparaison_etendue_detection.csv")
    out["detection"] = _table(d, [("Modèle", "Modèle", None), ("Crises réelles", "Crises", 0), ("Crises détectées", "Détectées", 0),
                                  ("Crises manquées", "Manquées", 0), ("Fausses alarmes", "Fausses alarmes", 0),
                                  ("Fausses alarmes / h", "Fausses alarmes / h", 2)])
    t = _csv(LOCAL_DIR / "tests_wilcoxon_holm.csv")
    if t is not None:
        out["tests"] = _table(t, [("Métrique", "Mesure", None), ("Modèle (contre Random Forest)", "Modèle comparé", None),
                                  ("Médiane des différences", "Différence médiane", 3),
                                  ("Enregistrements où sa valeur est plus élevée", "Plus élevé", 0), ("Égalités", "Égal", 0),
                                  ("Enregistrements où sa valeur est plus basse", "Plus bas", 0),
                                  ("p (Wilcoxon)", "p", "p"), ("p ajustée (Holm)", "p corrigée (Holm)", "p")])
        et = t[t["Modèle (contre Random Forest)"] == "Extra Trees"]
        out["extra_trees"] = [{"metrique": r["Métrique"], "p": _clean(r["p (Wilcoxon)"]), "p_holm": _clean(r["p ajustée (Holm)"])}
                              for _, r in et.iterrows()]
    ic = _csv(LOCAL_DIR / "tests_bootstrap_ic95.csv")
    out["ic"] = _table(ic, [("Modèle", "Modèle", None), ("Métrique", "Mesure", None), ("Estimation", "Estimation", 3),
                            ("IC95 bas", "IC 95 % bas", 3), ("IC95 haut", "IC 95 % haut", 3)])
    df_ = _csv(LOCAL_DIR / "tests_bootstrap_extra_trees_vs_random_forest.csv")
    if df_ is not None:
        df_ = df_.rename(columns={df_.columns[0]: "Mesure"})
        out["diff"] = _table(df_, [("Mesure", "Mesure", None), ("Différence Extra Trees − Random Forest", "Extra Trees − Random Forest", 3),
                                   ("IC95 bas", "IC 95 % bas", 3), ("IC95 haut", "IC 95 % haut", 3)])
    return out if any(out.values()) else None


def _fenetres():
    df = _fenetres_table()
    if df is None:
        return None
    out = {"table": _table(df, [("Fenêtre", "Fenêtre", None), ("Nb fenêtres", "Fenêtres", 0), ("% fenêtres en crise", "% en crise", 2),
                                ("Crises avec ≥ 1 fenêtre", "Crises avec ≥ 1 fenêtre", 0), ("F1-score", "F1 par enregistrement", 3),
                                ("Crises détectées", "Crises détectées", None),
                                ("Crises manquées", "Manquées", 0), ("Fausses alarmes / h", "Fausses alarmes / h", 2),
                                ("Retard début moyen |s|", "Écart moyen au début (s)", 2)])}
    if {"Crises manquées", "Fausses alarmes / h"} <= set(df.columns):
        a, b = df.loc[df["Crises manquées"].idxmin()], df.loc[df["Fausses alarmes / h"].idxmin()]
        out["facts"] = {"moins_manquees": a["Fenêtre"], "manquees": _clean(a["Crises manquées"]), "detectees": a.get("Crises détectées"),
                        "moins_fa": b["Fenêtre"], "fa_h": _clean(b["Fausses alarmes / h"]), "fa_h_ref": _clean(a["Fausses alarmes / h"]),
                        "manquees_moins_fa": _clean(b["Crises manquées"])}
    return out


def _frequence():
    c, t, p = (_csv(LOCAL_DIR / f"frequence_{n}.csv") for n in ("par_crise", "tests", "par_patient"))
    if c is None:
        return None
    out = {"facts": {"n": int(len(c)), "patients": int(c["ID"].nunique()),
                     "debut": _clean(c["Fréquence début (Hz)"].median()), "fin": _clean(c["Fréquence fin (Hz)"].median()),
                     "pente": _clean(c["Pente (Hz/s)"].median()), "n_neg": int((c["Pente (Hz/s)"] < 0).sum())}}
    if p is not None:
        out["facts"].update({"pat_neg": int((p["Pente_mediane"] < 0).sum()), "pat": int(len(p))})
        out["patients"] = _table(p, [("ID", "Enregistrement", None), ("Age", "Âge", 0), ("Crises", "Crises ≥ 4 s", 0),
                                     ("Frequence_debut_mediane", "Début (Hz)", 2), ("Frequence_fin_mediane", "Fin (Hz)", 2),
                                     ("Pente_mediane", "Pente (Hz/s)", 3)])
    out["tests"] = _table(t, [("Test", "Test (Wilcoxon unilatéral)", None), ("n", "n", 0), ("Médiane", "Médiane", 3),
                              ("p (Wilcoxon unilatéral)", "p", "p")])
    if t is not None and len(t):
        out["facts"]["p"] = _clean(t.iloc[0]["p (Wilcoxon unilatéral)"])
    return out


def _typologie():
    s, c, d = (_csv(LOCAL_DIR / f"typologie_{n}.csv") for n in ("silhouette_par_k", "centroides", "cluster_x_detection"))
    if c is None:
        return None
    out = {"centroides": _table(c, [("Cluster", "Cluster", None), ("Crises", "Crises", 0), ("Patients", "Patients", 0),
                                    ("Durée (s)", "Durée (s)", 1), ("Fréquence moyenne (Hz)", "Fréquence (Hz)", 2),
                                    ("Pente (Hz/s)", "Pente (Hz/s)", 3), ("Rapport d'amplitude", "Rapport d’amplitude", 2),
                                    ("Puissance relative 2,5–4 Hz", "Puissance rel. 2,5–4 Hz", 2), ("Synchronie (PLV)", "Synchronie", 2),
                                    ("Rapport frontal/postérieur", "Frontal / postérieur", 2)]),
           "detection": _table(d, [("Cluster", "Cluster", None), ("Crises", "Crises", 0), ("Détectées", "Détectées", 0),
                                   ("Manquées", "Manquées", 0), ("Retard_moyen_abs_s", "Écart moyen au début (s)", 2),
                                   ("Détectées_avec_plus_de_2s_de_retard", "Détectées avec plus de 2 s de retard", 0)]),
           "silhouette": _table(s, [("k", "Nombre de groupes", 0), ("Silhouette", "Silhouette", 3)])}
    tc = _csv(LOCAL_DIR / "typologie_crises.csv")
    if tc is not None and "Cluster" in tc.columns:
        tc = tc.assign(Groupe="Groupe " + tc["Cluster"].astype(str))
        out["explorer"] = _points(tc, [("Durée (s)", "Durée (s)"), ("Fréquence moyenne (Hz)", "Fréquence (Hz)"), ("Pente (Hz/s)", "Pente (Hz/s)"),
                                       ("Rapport d'amplitude", "Rapport d’amplitude"), ("Puissance relative 2,5–4 Hz", "Puissance relative 2,5–4 Hz"),
                                       ("Synchronie (PLV)", "Synchronie"), ("Rapport frontal/postérieur", "Frontal / postérieur"),
                                       ("Retard début (s)", "Retard de détection (s)")], "Groupe", "Résultat")
    if s is not None and len(s):
        best = s.loc[s["Silhouette"].idxmax()]
        out["facts"] = {"k": int(best["k"]), "silhouette": _clean(best["Silhouette"]),
                        "n": int(c.loc[c["Cluster"].astype(str) == "Toutes", "Crises"].iloc[0]) if (c["Cluster"].astype(str) == "Toutes").any() else None}
    return out


def _shap():
    imp, cas, vf = (_csv(LOCAL_DIR / f"shap_{n}.csv") for n in ("importance_globale", "cas_locaux", "vraies_detections_vs_fausses_alertes"))
    if imp is None:
        return None
    imp = imp.rename(columns={imp.columns[0]: "Caractéristique"})
    tot = imp["Moyenne |SHAP|"].sum()
    out = {"importance": _table(imp, [("Caractéristique", "Caractéristique", None), ("Moyenne |SHAP|", "Effet moyen (toutes les fenêtres)", 3),
                                      ("Moyenne |SHAP| (fenêtres en crise)", "Effet moyen (fenêtres en crise)", 3)]),
           "facts": {"top": list(imp["Caractéristique"].head(5)), "part_top": _clean(imp["Moyenne |SHAP|"].head(5).sum() / tot) if tot else None}}
    out["cas"] = _table(cas, [("Cas", "Cas", None), ("Enregistrement", "Enregistrement", None), ("t_start", "Début (s)", 0),
                              ("t_end", "Fin (s)", 0), ("Probabilité de crise", "Probabilité de crise", 2)])
    if vf is not None:
        vf = vf.rename(columns={vf.columns[0]: "Caractéristique"})
        out["vp_fp"] = _table(vf, [("Caractéristique", "Caractéristique", None),
                                   ("SHAP moyen — vraies détections", "Effet — vraies détections", 3),
                                   ("SHAP moyen — fausses alertes", "Effet — fausses alertes", 3),
                                   ("Valeur médiane — vraies détections", "Valeur — vraies détections", 2),
                                   ("Valeur médiane — fausses alertes", "Valeur — fausses alertes", 2),
                                   ("Valeur médiane — fenêtres normales", "Valeur — fenêtres normales", 2)])
    return out


def _apprentissage():
    r = _csv(LOCAL_DIR / "courbe_apprentissage_repetitions.csv")
    if r is None:
        return None
    g = r.groupby("n")
    df = pd.DataFrame({"n": list(g.groups), "F1 test": g["F1 test"].mean().values, "F1 test sd": g["F1 test"].std().values,
                       "F1 train": g["F1 entraînement"].mean().values, "Sens": g["Sensibilité crises"].mean().values,
                       "Sens sd": g["Sensibilité crises"].std().values, "FA": g["Fausses alarmes / h"].mean().values})
    out = {"table": _table(df, [("n", "Enregistrements d’entraînement", 0), ("F1 test", "F1 test", 3), ("F1 test sd", "écart-type", 3),
                                ("F1 train", "F1 entraînement", 3), ("Sens", "Sensibilité par crise", 3), ("Sens sd", "écart-type", 3),
                                ("FA", "Fausses alarmes / h", 2)]),
           "facts": {"repetitions": int(r["Répétition"].nunique()), "n_min": int(df["n"].min()), "n_max": int(df["n"].max()),
                     "f1_min": _clean(df["F1 test"].iloc[0]), "f1_max": _clean(df["F1 test"].iloc[-1]),
                     "f1_train": _clean(df["F1 train"].iloc[-1])}}
    if len(df) >= 2:
        large = r.pivot(index="Répétition", columns="n", values="F1 test")
        a, b = df["n"].iloc[-2], df["n"].iloc[-1]
        out["facts"].update({"avant": int(a), "gain_fin": _clean((large[b] - large[a]).mean()),
                             "mieux": int((large[b] > large[a]).sum())})
    return out


def _syndrome():
    grp, sa, sc, kw = (_csv(SYN_DIR / f"{n}.csv") for n in ("detection_par_groupe_d_age", "age_spearman_fronto_central",
                                                           "detection_spearman_couverture", "age_kruskal_groupes"))
    if grp is None and sa is None:
        return None
    court = lambda df: None if df is None else df.assign(Mesure=df["Mesure"].str.replace(" — FC", "", regex=False))
    sp = [("Mesure", "Mesure", None), ("n", "n", 0), ("rho", "rho", 2), ("IC95 bas", "IC 95 % bas", 2), ("IC95 haut", "IC 95 % haut", 2),
          ("p", "p", "p"), ("p ajustée (Holm)", "p corrigée (Holm)", "p")]
    out = {"groupes": _table(grp, [("Groupe d'âge", "Groupe d’âge", None), ("Patients", "Patients", 0), ("Crises", "Crises", 0),
                                   ("Bien_détectées", "Bien détectées", 0), ("Tardives", "Tardives (> 2 s)", 0), ("Manquées", "Manquées", 0),
                                   ("Couverture_médiane", "Couverture médiane", 2), ("Retard_moyen_s", "Retard moyen (s)", 2)]),
           "age": _table(court(sa), sp), "couverture": _table(court(sc), sp),
           "medianes": _table(court(kw), [("Mesure", "Mesure", None), ("Médiane < 8 ans", "< 8 ans", 2), ("Médiane 8–11 ans", "8–11 ans", 2),
                                          ("Médiane ≥ 12 ans", "≥ 12 ans", 2), ("p (Kruskal-Wallis)", "p (Kruskal-Wallis)", "p"),
                                          ("p ajustée (Holm)", "p corrigée (Holm)", "p")])}
    mc = _csv(SYN_DIR / "morphologie_par_crise.csv")
    if mc is not None:
        fc = [c for c in mc.columns if c.endswith(" — FC")]
        out["explorer"] = _points(mc, [("Âge", "Âge (ans)"), ("Durée (s)", "Durée (s)")] + [(c, c.replace(" — FC", "")) for c in fc]
                                  + [("Couverture", "Couverture par le détecteur"), ("Retard début (s)", "Retard de détection (s)")],
                                  "Groupe d'âge", "Détection")
    facts = {}
    if sa is not None:
        facts.update({"n": int(sa["n"].max()), "p_holm_min": _clean(sa["p ajustée (Holm)"].min()),
                      "n_signif": int((sa["p ajustée (Holm)"] < 0.05).sum()), "n_mesures": int(len(sa))})
    if sc is not None:
        s_ = sc[sc["p ajustée (Holm)"] < 0.05]
        facts["couverture_signif"] = [{"mesure": r["Mesure"].replace(" — FC", ""), "rho": _clean(r["rho"]), "p_holm": _clean(r["p ajustée (Holm)"])}
                                      for _, r in s_.iterrows()]
    if grp is not None and len(grp):
        facts["groupes"] = [{"groupe": r["Groupe d'âge"], "crises": int(r["Crises"]), "bien": int(r["Bien_détectées"]),
                             "tardives": int(r["Tardives"]), "manquees": int(r["Manquées"]), "couverture": _clean(r["Couverture_médiane"])}
                            for _, r in grp.iterrows()]
    out["facts"] = facts
    return out


def _points(df, variables, group_col, det_col):
    """Une entrée par crise pour les graphiques interactifs : variables numériques, groupe, résultat de la détection."""
    if df is None:
        return None
    variables = [(c, lab) for c, lab in variables if c in df.columns]
    pts = [{"id": r["ID"], "n": int(r["Crise"]), "start": _clean(r["Début (s)"]), "group": str(r[group_col]),
            "det": None if det_col not in df.columns or pd.isna(r[det_col]) else str(r[det_col]),
            "v": [_clean(r[c]) for c, _ in variables]} for _, r in df.iterrows()]
    return {"vars": [lab for _, lab in variables], "points": pts, "groups": sorted({p["group"] for p in pts}, key=lambda g: (0 if g.startswith("<") else 2 if g.startswith("≥") else 1, g))}


def bundle():
    """Tout ce que les pages Modèles et Recherche affichent, relu à chaque appel (les fichiers sont petits)."""
    figs = {k: int(p.stat().st_mtime) for k in list(FIGURES) + list(NOTEBOOK_FIGURES) if (p := figure_path(k)) is not None}
    sections = {"modeles": _modeles(), "fenetres": _fenetres(), "frequence": _frequence(), "typologie": _typologie(),
                "shap": _shap(), "apprentissage": _apprentissage(), "syndrome": _syndrome()}
    return {"available": LOCAL_DIR.exists() and any(v is not None for v in sections.values()),
            "figures": figs, **sections}
