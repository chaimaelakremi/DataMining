"""
Étude « Des crises que personne n'a annotées ? » : un autoencodeur entraîné UNIQUEMENT sur de
l'EEG normal. Ce qu'il reconstruit mal est inhabituel ; on vérifie d'abord qu'il reconnaît les 82
crises connues, puis on cherche, hors des crises annotées, des décharges qui ressemblent à des
absences. Module partagé par le notebook (section finale) et par le site (page Découverte).

Aucune fuite : validation croisée par enregistrement (GroupKFold, 5 plis) ; chaque enregistrement
est noté par un autoencodeur qui ne l'a jamais vu, et le seuil vient des enregistrements d'entraînement.
Les fenêtres de crise ne servent jamais à l'entraînement. eeg_pipeline n'est pas modifié.
"""
import json
import logging
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import medfilt, welch

import eeg_pipeline as P
import etude_electrodes as E

log = logging.getLogger("autoencodeur")
VERSION = 2
FS_AE = 128.0                     # signal ramené à 128 Hz (déjà limité à 40 Hz par le passe-bande)
WIN = int(P.WIN_S * FS_AE)        # 256 échantillons par fenêtre de 2 s
STEP = int(WIN * (1 - P.OVERLAP)) # 1 s
CHANNELS, ELECTRODES = E.CHANNELS, E.ELECTRODES
FRONTO_CENTRAL = ["Fp1", "Fp2", "F3", "Fz", "F4", "C3", "Cz", "C4"]
GAP_NORMAL_S = 30.0               # fenêtres « normales » : à au moins 30 s de toute crise annotée
SAT_MARGIN_S = 5.0                # … et à plus de 5 s d'une saturation du journal
NOTE_MARGIN_S = 10.0
EDGE_S = 5.0                      # premières et dernières secondes : transitoire du filtre aller-retour, exclues
ARTEFACT_NOTE = re.compile(r"artef|bouge|mouv|agit|pleur|parle|tousse|machon|mâchon", re.I)


# ==========================================================================
# 1. Données : même prétraitement que le projet, puis 128 Hz et normalisation robuste
# ==========================================================================
def prepare(rid, path, truth, journal, cache_dir):
    """Signal filtré (médiane retirée, passe-bande 0,5–40 Hz aller-retour), ramené à 128 Hz, et
    normalisé voie par voie par la médiane et l'écart interquartile de SES fenêtres normales."""
    st = Path(path).stat()
    out = Path(cache_dir) / f"signal__{rid}__{st.st_size}-{int(st.st_mtime)}__v{VERSION}.npz"
    if out.exists():
        z = np.load(out)
        return {k: z[k] for k in z.files}
    df, fs = P.load_eeg(path)
    X = df[CHANNELS].values.astype(np.float64)
    X = P.bandpass(X - np.median(X, axis=0), fs)
    q = int(round(fs / FS_AE))
    Xd = X[::q].astype(np.float32)                      # 256 → 128 Hz : rien au-dessus de 40 Hz après le filtre
    n_win = (len(Xd) - WIN) // STEP + 1
    ts = np.arange(n_win) * STEP / FS_AE
    te = ts + P.WIN_S
    # fenêtres normales : loin des crises, loin des saturations, sans amplitude extrême
    far = np.ones(n_win, bool)
    for a, b in truth:
        far &= (te <= a - GAP_NORMAL_S) | (ts >= b + GAP_NORMAL_S)
    sats = np.array([e["time_s"] for e in journal if e["type"] == "saturation"])
    nosat = np.ones(n_win, bool)
    for s in sats:
        nosat &= (te < s - SAT_MARGIN_S) | (ts > s + SAT_MARGIN_S)
    idx = np.arange(WIN)[None, :] + (np.arange(n_win) * STEP)[:, None]
    ptp = np.median(Xd[idx].max(axis=1) - Xd[idx].min(axis=1), axis=1)   # crête à crête, médiane sur les voies
    med, mad = np.median(ptp[far & nosat]), np.median(np.abs(ptp[far & nosat] - np.median(ptp[far & nosat])))
    calm = ptp <= med + 8 * 1.4826 * mad                                    # seuil robuste « extrême »
    inner = (ts >= EDGE_S) & (te <= len(Xd) / FS_AE - EDGE_S)
    normal = far & nosat & calm & inner
    # normalisation : statistiques des échantillons des fenêtres normales de CET enregistrement
    keep = np.zeros(len(Xd), bool)
    for k in np.where(normal)[0]:
        keep[k * STEP:k * STEP + WIN] = True
    m = np.median(Xd[keep], axis=0)
    iqr = np.subtract(*np.percentile(Xd[keep], [75, 25], axis=0))
    iqr[iqr <= 1e-6] = 1.0
    Z = np.clip((Xd - m) / iqr, -20, 20).astype(np.float32)
    res = {"Z": Z, "filtered": Xd, "t_start": ts, "t_end": te, "normal": normal, "far": far, "nosat": nosat,
           "calm": calm, "inner": inner, "median": m, "iqr": iqr}
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    np.savez(out, **res)
    return res


def windows(Z, k):
    """Fenêtres numéro k (tableau d'indices) : (len(k), 19, 256)."""
    idx = np.asarray(k)[:, None] * STEP + np.arange(WIN)[None, :]
    return np.transpose(Z[idx], (0, 2, 1))


# ==========================================================================
# 2. Modèle : autoencodeur convolutif 1D (PyTorch, CPU)
# ==========================================================================
def make_model():
    import torch.nn as nn
    # 19 × 256 → 32 × 128 → 32 × 64 → 16 × 32 → goulot 8 × 32 (256 valeurs, 19 fois moins que l'entrée)
    enc = nn.Sequential(nn.Conv1d(19, 32, 7, stride=2, padding=3), nn.GELU(),
                        nn.Conv1d(32, 32, 5, stride=2, padding=2), nn.GELU(),
                        nn.Conv1d(32, 16, 5, stride=2, padding=2), nn.GELU(),
                        nn.Conv1d(16, 8, 3, padding=1))
    dec = nn.Sequential(nn.Conv1d(8, 16, 3, padding=1), nn.GELU(),
                        nn.ConvTranspose1d(16, 32, 4, stride=2, padding=1), nn.GELU(),
                        nn.ConvTranspose1d(32, 32, 4, stride=2, padding=1), nn.GELU(),
                        nn.ConvTranspose1d(32, 19, 4, stride=2, padding=1))
    return nn.Sequential(enc, dec)


def train_fold(prep, train_ids, epochs=30, patience=4, max_windows=16000, batch=256, seed=42, progress=None):
    """Entraîne sur les fenêtres normales des enregistrements d'entraînement ; arrêt précoce sur
    10 % de ces fenêtres tenues à part."""
    import torch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    pool = np.array([(i, k) for i, r in enumerate(train_ids) for k in np.where(prep[r]["normal"])[0]])
    pick = pool[rng.choice(len(pool), min(max_windows, len(pool)), replace=False)]
    Xw = np.concatenate([windows(prep[r]["Z"], pick[pick[:, 0] == i, 1]) for i, r in enumerate(train_ids)
                         if (pick[:, 0] == i).any()])
    Xw = torch.from_numpy(Xw[rng.permutation(len(Xw))])
    n_val = max(1, len(Xw) // 10)
    val, tr = Xw[:n_val], Xw[n_val:]
    model = make_model()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    best, best_state, wait, hist = np.inf, None, 0, []
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(len(tr))
        tot = 0.0
        for i in range(0, len(tr), batch):
            xb = tr[perm[i:i + batch]]
            opt.zero_grad()
            loss = torch.mean((model(xb) - xb) ** 2)
            loss.backward(); opt.step()
            tot += loss.item() * len(xb)
        model.eval()
        with torch.no_grad():
            v = sum(float(torch.sum((model(val[i:i + 1024]) - val[i:i + 1024]) ** 2)) for i in range(0, len(val), 1024)) / val.numel()
        hist.append({"epoch": ep + 1, "train_mse": tot / len(tr), "val_mse": v})
        if progress:
            progress(f"époque {ep + 1} : erreur d'entraînement {tot / len(tr):.4f}, de validation {v:.4f}")
        if v < best - 1e-5:
            best, wait = v, 0
            best_state = {k: t.clone() for k, t in model.state_dict().items()}
        else:
            wait += 1
            if wait >= patience:
                break
    model.load_state_dict(best_state)
    return model, hist, int(len(tr)), int(n_val)


def score(model, Z, k=None, batch=1024):
    """Erreur de reconstruction par fenêtre et par voie (moyenne sur les échantillons) : (n, 19)."""
    import torch
    n_win = (len(Z) - WIN) // STEP + 1
    k = np.arange(n_win) if k is None else np.asarray(k)
    out = np.empty((len(k), len(CHANNELS)), np.float32)
    model.eval()
    with torch.no_grad():
        for i in range(0, len(k), batch):
            xb = torch.from_numpy(windows(Z, k[i:i + batch]))
            out[i:i + batch] = torch.mean((model(xb) - xb) ** 2, dim=2).numpy()
    return out


# ==========================================================================
# 3. Validation croisée par enregistrement
# ==========================================================================
def cross_validate(prep, ids, n_splits=5, epochs=30, max_windows=16000, seed=42, progress=None):
    """Chaque enregistrement est noté par l'autoencodeur du pli qui ne l'a pas vu. Seuil du pli :
    99e centile du score des fenêtres normales des enregistrements d'ENTRAÎNEMENT."""
    import torch
    from sklearn.model_selection import GroupKFold
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    ids = list(ids)
    folds = list(GroupKFold(n_splits=n_splits).split(ids, groups=ids))
    per_ch, fold_of, thr, thr_ch, train_log = {}, {}, {}, {}, []
    for f, (tr, te) in enumerate(folds, 1):
        tr_ids, te_ids = [ids[i] for i in tr], [ids[i] for i in te]
        t0 = time.time()
        model, hist, n_tr, n_val = train_fold(prep, tr_ids, epochs=epochs, max_windows=max_windows, seed=seed,
                                              progress=(lambda m: progress(f, n_splits, f"pli {f} sur {n_splits}, {m}")) if progress else None)
        # seuils fixés sur les enregistrements d'entraînement uniquement
        e_tr = np.vstack([score(model, prep[r]["Z"], np.where(prep[r]["normal"])[0]) for r in tr_ids])
        s_tr = np.median(e_tr, axis=1)
        th, th_ch = float(np.percentile(s_tr, 99)), np.percentile(e_tr, 99, axis=0)
        for r in te_ids:
            per_ch[r] = score(model, prep[r]["Z"])
            fold_of[r], thr[r], thr_ch[r] = f, th, th_ch
        train_log.append({"pli": f, "enregistrements_test": " ".join(te_ids), "fenetres_entrainement": n_tr,
                          "fenetres_validation": n_val, "epoques": len(hist), "mse_entrainement": hist[-1]["train_mse"],
                          "mse_validation": min(h["val_mse"] for h in hist), "seuil_99": th,
                          "duree_s": round(time.time() - t0, 1), "historique": json.dumps(hist)})
    return per_ch, fold_of, thr, thr_ch, pd.DataFrame(train_log)


def window_table(prep, ids, per_ch, fold_of, thr, dataset, rf):
    """Une ligne par fenêtre : score d'anomalie (médiane des voies), seuil du pli, classe, probabilité RF."""
    rows = []
    for r in ids:
        p = prep[r]
        n = len(per_ch[r])
        rows.append(pd.DataFrame({"Recording": r, "Window": np.arange(1, n + 1), "t_start": p["t_start"][:n],
                                  "t_end": p["t_end"][:n], "pli": fold_of[r], "score": np.median(per_ch[r], axis=1),
                                  "seuil": thr[r], "normale": p["normal"][:n].astype(int)}))
    W = pd.concat(rows, ignore_index=True)
    W = W.merge(dataset[["Recording", "t_start", "Class", "Seizure_frac"]], on=["Recording", "t_start"], how="left")
    W = W.merge(rf, on=["Recording", "t_start"], how="left")
    return W


def bootstrap_auc(W, col, n_boot=1000, seed=42):
    from sklearn.metrics import roc_auc_score
    rng = np.random.default_rng(seed)
    ids = W["Recording"].unique()
    groups = {r: g for r, g in W.groupby("Recording")}
    vals = []
    for _ in range(n_boot):
        s = pd.concat([groups[r] for r in rng.choice(ids, len(ids))])
        if s["Class"].nunique() == 2:
            vals.append(roc_auc_score(s["Class"], s[col]))
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def validate(W, truth, n_boot=1000):
    from sklearn.metrics import average_precision_score, roc_auc_score
    V = W.dropna(subset=["Class"])
    out = {}
    for name, col in (("autoencodeur", "score"), ("random_forest", "proba_rf")):
        lo, hi = bootstrap_auc(V, col, n_boot)
        out[name] = {"auc": float(roc_auc_score(V["Class"], V[col])), "auc_ic95": [lo, hi],
                     "pr_auc": float(average_precision_score(V["Class"], V[col]))}
    # niveau crise : score maximal sur la crise au-dessus du seuil du pli (RF : probabilité > 0,5)
    ev = []
    for r, g in V.groupby("Recording"):
        for k, (a, b) in enumerate(truth[r], 1):
            m = (g["t_start"] < b) & (g["t_end"] > a)
            ev.append({"Recording": r, "Crise": k, "debut": a, "fin": b, "score_max": float(g.loc[m, "score"].max()),
                       "seuil": float(g["seuil"].iloc[0]), "proba_rf_max": float(g.loc[m, "proba_rf"].max())})
    ev = pd.DataFrame(ev)
    ev["vue_autoencodeur"] = ev["score_max"] > ev["seuil"]
    ev["vue_rf"] = ev["proba_rf_max"] > 0.5
    out["evenements"] = {"n": int(len(ev)), "autoencodeur": int(ev["vue_autoencodeur"].sum()), "random_forest": int(ev["vue_rf"].sum())}
    out["n_fenetres"] = int(len(V)); out["n_fenetres_crise"] = int(V["Class"].sum())
    out["faible"] = out["autoencodeur"]["auc"] < 0.6        # score trop proche du hasard : pas de « découverte »
    return out, ev


# ==========================================================================
# 4. Découverte : événements anormaux hors des crises annotées
# ==========================================================================
def spectral(prep_r, a, b):
    """Fréquence dominante et part de la puissance entre 2,5 et 4 Hz, moyenne fronto-centrale."""
    i0, i1 = int(a * FS_AE), int(b * FS_AE)
    sel = [CHANNELS.index("EEG" + e) for e in FRONTO_CENTRAL]
    x = prep_r["filtered"][i0:i1, sel].astype(np.float64)
    f, p = welch(x, fs=FS_AE, nperseg=min(len(x), 256), nfft=2048, axis=0)   # bins de 0,0625 Hz
    p = p.mean(axis=1)
    band = (f >= 1) & (f <= 20)
    fdom = float(f[band][np.argmax(p[band])])
    tot = p[(f >= 0.5) & (f < 30)].sum()
    return fdom, float(p[(f >= 2.5) & (f <= 4)].sum() / tot) if tot > 0 else 0.0


def journal_near(journal, a, b, margin):
    return [e for e in journal if a - margin <= e["time_s"] <= b + margin]


def describe(r, a, b, W_r, per_ch_r, thr_ch_r, prep_r, journal):
    """Mesures d'un intervalle : anomalie, fréquence dominante, voies concernées, journal ; puis étiquette."""
    m = (W_r["t_start"].values < b) & (W_r["t_end"].values > a)
    s = W_r["score"].values[m]
    share = float((per_ch_r[m] > thr_ch_r[None, :]).mean(axis=1).max()) if m.any() else 0.0
    fdom, ratio = spectral(prep_r, a, b)
    near = journal_near(journal, a, b, SAT_MARGIN_S)
    sat = any(e["type"] == "saturation" for e in near)
    art_note = any(e["type"] == "autre" and ARTEFACT_NOTE.search(e.get("label", "")) for e in near)
    notes = [e["label"] for e in journal_near(journal, a, b, NOTE_MARGIN_S) if e["type"] == "autre" and e["time_s"] > 1]
    if sat or art_note:
        lab = "artefact probable"
    elif 2.5 <= fdom <= 4 and share >= 0.5:
        lab = "décharge possible"
    elif share < 0.25:
        lab = "artefact probable"          # une ou deux voies seulement : plutôt une électrode
    else:
        lab = "anomalie autre"
    thr = float(W_r["seuil"].iloc[0])
    return {"Recording": r, "debut": float(a), "fin": float(b), "duree": float(b - a),
            "score_max": float(s.max()) if len(s) else None, "score_rel": float(s.max() / thr) if len(s) else None,
            "freq_dominante": fdom, "part_2_5_4_hz": ratio, "part_voies": share,
            "proba_rf_max": float(W_r["proba_rf"].values[m].max()) if m.any() else None,
            "saturation_proche": sat, "note_artefact": art_note, "etiquette": lab,
            "notes_journal": " | ".join(notes),
            "score_combine": float(s.max() / thr * ratio) if len(s) else 0.0}


def discover(W, ids, truth, per_ch, thr_ch, prep, journals, margin_s=2.0):
    """Fenêtres au-dessus du seuil hors des crises annotées (marge de 2 s), regroupées avec les règles
    de detect() : lissage médian, fusion à 1 s, durée minimale 2 s."""
    out = []
    for r in ids:
        g = W[W["Recording"] == r].sort_values("t_start")
        ts, te = g["t_start"].values, g["t_end"].values
        inside = np.zeros(len(g), bool)
        for a, b in truth[r]:
            inside |= (ts < b + margin_s) & (te > a - margin_s)
        edge = (ts < EDGE_S) | (te > prep[r]["t_end"][-1] - EDGE_S)            # bords de l'enregistrement exclus
        hot = ((g["score"].values > g["seuil"].values) & ~inside & ~edge).astype(int)
        sm = medfilt(hot, P.SMOOTH).astype(int) if P.SMOOTH > 1 else hot
        for a, b in P.windows_to_intervals(ts, te, sm):
            out.append(describe(r, a, b, g, per_ch[r], thr_ch[r], prep[r], journals.get(r, [])))
    C = pd.DataFrame(out)
    if len(C):
        C = C.sort_values(["etiquette", "score_combine"], ascending=[True, False]).reset_index(drop=True)
        rank = C[C["etiquette"] == "décharge possible"].sort_values("score_combine", ascending=False).index
        C["rang"] = None
        C.loc[rank, "rang"] = np.arange(1, len(rank) + 1)
    return C


def rf_false_alarms(rf, truth):
    """Fausses alarmes du Random Forest « sans l'enregistrement » (mêmes règles que detect())."""
    out = []
    for r, g in rf.groupby("Recording"):
        g = g.sort_values("t_start")
        raw = (g["proba_rf"].values > 0.5).astype(int)
        sm = medfilt(raw, P.SMOOTH).astype(int)
        te = g["t_start"].values + P.WIN_S
        ev = P.windows_to_intervals(g["t_start"].values, te, sm)
        m = P.match_events(truth[r], ev)
        for _, x in m[m["Résultat"] == "Fausse alarme"].iterrows():
            out.append((r, float(x["Début détecté"]), float(x["Fin détectée"])))
    return out


def cross_check(fas, W, per_ch, thr_ch, prep, journals, C):
    rows = []
    for r, a, b in fas:
        g = W[W["Recording"] == r].sort_values("t_start")
        d = describe(r, a, b, g, per_ch[r], thr_ch[r], prep[r], journals.get(r, []))
        m = (g["t_start"] < b) & (g["t_end"] > a)
        d["vue_autoencodeur"] = bool((g.loc[m, "score"] > g.loc[m, "seuil"]).any())
        cand = C[(C["Recording"] == r) & (C["debut"] < b) & (C["fin"] > a)] if len(C) else C
        d["candidat_associe"] = int(cand.index[0]) if len(cand) else None
        d["discharge_possible"] = d["vue_autoencodeur"] and d["etiquette"] == "décharge possible"
        rows.append(d)
    return pd.DataFrame(rows)
