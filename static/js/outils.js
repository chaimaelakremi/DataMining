/* ==========================================================================
   Absences — outils interactifs des pages Modèles (Banc d'essai), Patients,
   Limites et Anticipation. Les calculs longs sont des tâches de fond du serveur
   (/api/tools/jobs) : barre de progression, bouton Annuler, cache par paramètres.
   ========================================================================== */
"use strict";

/* ---------------------------------------------------------------- tâches de fond */
const Jobs = {
  /* Lance une tâche et suit sa progression dans `box` (créé par jobBox). Renvoie le résultat. */
  async run(kind, params, box) {
    const bar = $(".job-bar span", box), lab = $(".job-label", box), cancel = $(".job-cancel", box);
    box.hidden = false; bar.style.width = "0%"; lab.textContent = "Envoi…"; cancel.disabled = false;
    const t0 = performance.now();
    const { job } = await api("/api/tools/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, params }) });
    let stop = false;
    cancel.onclick = async () => { cancel.disabled = true; lab.textContent = "Annulation…"; stop = true; await api(`/api/tools/jobs/${job}/cancel`, { method: "POST" }).catch(() => {}); };
    for (;;) {
      const s = await api(`/api/tools/jobs/${job}`);
      if (s.status === "done") {
        bar.style.width = "100%";
        lab.textContent = s.cached ? `Relu dans le cache (calculé en ${nf(s.result.computed_in_s, 1)} s).` : `Calculé en ${nf(s.result.computed_in_s, 1)} s.`;
        cancel.disabled = true;
        return Object.assign(s.result, { _cached: s.cached, _wall: (performance.now() - t0) / 1000 });
      }
      if (s.status === "error") { cancel.disabled = true; throw new Error(s.error || "le calcul a échoué"); }
      if (s.status === "cancelled") { cancel.disabled = true; lab.textContent = "Calcul annulé."; throw Object.assign(new Error("annulé"), { name: "Cancelled" }); }
      bar.style.width = `${100 * s.done / Math.max(1, s.total)}%`;
      lab.textContent = s.status === "queued" ? "En attente d’un autre calcul…" : `${s.label} · ${nf(s.elapsed_s, 0)} s`;
      await new Promise(r => setTimeout(r, stop ? 300 : 500));
    }
  },
};
const jobBox = id => `<div class="job" id="${id}" hidden><div class="job-bar progress"><span></span></div><div class="job-row"><span class="job-label lab-small lab-dim"></span><button type="button" class="link-btn job-cancel">Annuler</button></div></div>`;
const postJSON = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ToolCfg = { data: null, async get() { return this.data || (this.data = await api("/api/tools/config")); } };
const CAT = ["#A33E61", "#4A678C", "#2F7A5F", "#8F6E14", "#655E8A"];          // couleurs de groupe, toujours dans cet ordre
const SEQ = ["#FFF4F7", "#F9D3DF", "#EDA3BA", "#D46F93", "#A33E61", "#6A1E39"]; // rampe séquentielle (une teinte)
function seqColor(v) {
  const x = Math.max(0, Math.min(1, v)) * (SEQ.length - 1), i = Math.min(SEQ.length - 2, Math.floor(x)), f = x - i;
  const c = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)), a = c(SEQ[i]), b = c(SEQ[i + 1]);
  return `rgb(${a.map((v0, k) => Math.round(v0 + (b[k] - v0) * f)).join(",")})`;
}

/* ---------------------------------------------------------------- formulaire de configuration d'un modèle */
const HP = {
  rf: [["n_trees", "Nombre d’arbres", 50, 500, 50, 300], ["max_depth", "Profondeur max. (0 = illimitée)", 0, 30, 1, 0]],
  et: [["n_trees", "Nombre d’arbres", 50, 500, 50, 200], ["max_depth", "Profondeur max. (0 = illimitée)", 0, 30, 1, 0]],
  dt: [["max_depth", "Profondeur max.", 1, 30, 1, 10]],
  knn: [["k", "Nombre de voisins k", 1, 25, 1, 7]],
  svm: [["C", "C (régularisation)", 0, 3, 1, 2, [0.1, 1, 10, 100]]],
  logreg: [["C", "C (régularisation)", 0, 3, 1, 2, [0.01, 0.1, 1, 10]]],
  xgb: [["n_trees", "Nombre d’arbres", 50, 500, 50, 300], ["max_depth", "Profondeur max.", 1, 12, 1, 6]],
  lgbm: [["n_trees", "Nombre d’arbres", 50, 500, 50, 300]],
};
const FEAT_FR = { Mean: "moyenne", Std: "écart-type", Variance: "variance", Min: "minimum", Max: "maximum", Amplitude: "amplitude", RMS: "valeur efficace", Energy: "énergie",
  P_Delta: "puissance delta", P_Theta: "puissance thêta", P_Alpha: "puissance alpha", P_Beta: "puissance bêta",
  Rel_Delta: "part delta", Rel_Theta: "part thêta", Rel_Alpha: "part alpha", Rel_Beta: "part bêta", Peak_Freq: "fréquence du pic" };

function cfgForm(px, cfg, opts = {}) {
  const models = Object.entries(cfg.models).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  const wins = cfg.windows.map(w => `<button type="button" data-v="${w}" aria-pressed="${w === 2}">${nf(w)} s</button>`).join("");
  const groups = Object.entries(cfg.groups).map(([g, fs]) => `<fieldset class="cf-group"><legend class="tool-label">${esc(g)}</legend>${fs.map(f =>
    `<label class="cf-feat" title="${esc(FEAT_FR[f] || f)}"><input type="checkbox" data-f="${f}" checked> <span class="mono">${f}</span></label>`).join("")}</fieldset>`).join("");
  return `<div class="cf" id="${px}">
    <div class="cf-row"><label class="field"><span class="tool-label">Modèle</span><select class="cf-model">${models}</select></label>
      <span class="field"><span class="tool-label">Fenêtres</span><span class="seg cf-win">${wins}</span></span></div>
    <div class="cf-hp"></div>
    <details class="cf-feats" ${opts.open ? "open" : ""}><summary><span class="tool-label">Caractéristiques</span> <span class="cf-count lab-small"></span></summary>
      <div class="cf-short"><button type="button" class="pill-link" data-s="noamp">Sans amplitude</button><button type="button" class="pill-link" data-s="nofreq">Sans fréquences</button><button type="button" class="pill-link" data-s="all">Tout</button></div>
      <div class="cf-groups">${groups}</div></details></div>`;
}
function cfgWire(px, cfg, onChange = () => {}) {
  const root = $("#" + px);
  const hpBox = $(".cf-hp", root), sel = $(".cf-model", root);
  const drawHp = () => {
    hpBox.innerHTML = HP[sel.value].map(([k, l, a, b, s, d, list]) =>
      `<label class="lab-slider"><span class="tool-label">${l}</span><input type="range" data-k="${k}" min="${a}" max="${b}" step="${s}" value="${d}" ${list ? `data-list="${list.join(",")}"` : ""}><output></output></label>`).join("") +
      (sel.value === "svm" ? `<p class="lab-small lab-dim">Entraîné sur ${nf(cfg.svm_max_train)} fenêtres tirées au hasard : sur tout le jeu, un seul entraînement prend environ 50 s.</p>` : "");
    $$("input", hpBox).forEach(i => { const o = i.nextElementSibling, sync = () => { o.textContent = hpVal(i, true); }; i.addEventListener("input", () => { sync(); onChange(); }); sync(); });
    onChange();
  };
  sel.addEventListener("change", drawHp);
  bindSeg($(".cf-win", root), onChange);
  const count = () => { const n = $$(".cf-groups input:checked", root).length; $(".cf-count", root).textContent = n === 17 ? "les 17" : `${n} sur 17`; onChange(); };
  $$(".cf-groups input", root).forEach(i => i.addEventListener("change", count));
  $(".cf-short", root).addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const off = b.dataset.s === "noamp" ? cfg.amplitude : b.dataset.s === "nofreq" ? cfg.frequency : [];
    $$(".cf-groups input", root).forEach(i => { i.checked = !off.includes(i.dataset.f); });
    count();
  });
  drawHp(); count();
}
function hpVal(i, text) {
  const v = +i.value;
  if (i.dataset.list) { const x = +i.dataset.list.split(",")[v]; return text ? nf(x, x < 1 ? 2 : 0) : x; }
  if (text && i.dataset.k === "max_depth" && v === 0) return "illimitée";
  return text ? nf(v) : v;
}
function cfgRead(px) {
  const root = $("#" + px);
  const hp = {}; $$(".cf-hp input", root).forEach(i => { hp[i.dataset.k] = hpVal(i, false); });
  return { model: $(".cf-model", root).value, hp, win: +$(".cf-win [aria-pressed='true']", root).dataset.v,
           features: $$(".cf-groups input:checked", root).map(i => i.dataset.f) };
}
function cfgLabel(c, cfg) {
  const hp = Object.entries(c.hp).map(([k, v]) => k === "n_trees" ? `${v} arbres` : k === "max_depth" ? (v ? `prof. ${v}` : "prof. illimitée") : k === "k" ? `k = ${v}` : `C = ${nf(v, v < 1 ? 2 : 0)}`).join(", ");
  const nfeat = (c.features || []).length;
  const fl = nfeat === 17 ? "17 caract." : !c.features.some(f => cfg.amplitude.includes(f)) && nfeat === 17 - cfg.amplitude.length ? "sans amplitude"
    : !c.features.some(f => cfg.frequency.includes(f)) && nfeat === 17 - cfg.frequency.length ? "sans fréquences" : `${nfeat} caract.`;
  return `${cfg.models[c.model]}${hp ? ` (${hp})` : ""} · ${nf(c.win)} s · ${fl}`;
}

/* ---------------------------------------------------------------- frise d'un enregistrement (SVG) */
function timelineSVG(rows, dur, W, opts = {}) {
  // rows : [{label, items:[[a,b,cls,title]], curve?:{t,p}}] ; une seule échelle de temps pour toutes les rangées
  const m = { l: 92, r: 12 }, rowH = 22, curveH = opts.curveH || 70;
  let y = 6, s = "";
  const X = t => m.l + t / dur * (W - m.l - m.r);
  for (const r of rows) {
    if (r.curve) {
      const Y = p => y + curveH - p * curveH;
      s += `<text x="${m.l - 8}" y="${y + 12}" class="lab-tick" text-anchor="end">${esc(r.label)}</text>`;
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0.5)}" y2="${Y(0.5)}" class="lab-thr"/><line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" class="lab-grid"/>`;
      s += `<text x="${m.l - 8}" y="${Y(0.5) + 4}" class="lab-tick" text-anchor="end">0,5</text>`;
      const step = Math.max(1, Math.floor(r.curve.t.length / 1400));
      let d = ""; for (let i = 0; i < r.curve.t.length; i += step) d += `${d ? "L" : "M"}${X(r.curve.t[i]).toFixed(1)} ${Y(r.curve.p[i]).toFixed(1)}`;
      s += `<path d="${d}" class="tl-curve"/>`;
      y += curveH + 10;
    } else {
      s += `<text x="${m.l - 8}" y="${y + 14}" class="lab-tick" text-anchor="end">${esc(r.label)}</text>`;
      s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y + rowH / 2}" y2="${y + rowH / 2}" class="lab-grid"/>`;
      for (const [a, b, cls, title] of r.items) s += `<rect x="${X(a)}" y="${y + 3}" width="${Math.max(2, X(b) - X(a))}" height="${rowH - 6}" rx="2" class="${cls}"><title>${esc(title)}</title></rect>`;
      y += rowH + 4;
    }
  }
  for (let t = 0; t <= dur; t += dur > 2400 ? 600 : 300) s += `<text x="${X(t)}" y="${y + 12}" class="lab-tick" text-anchor="middle">${clock(t)}</text>`;
  return `<svg viewBox="0 0 ${W} ${y + 18}" width="${W}" height="${y + 18}" class="lab-svg tl-svg" role="img" aria-label="${esc(opts.aria || "Frise de l’enregistrement")}">${s}</svg>`;
}
const truthItems = r => r.truth.map(([a, b], k) => [a, b, "tl-truth", `crise annotée ${k + 1} : ${clock(a)}–${clock(b)}`]);
const detItems = (r, ev = r.events, truth = r.truth) => ev.map(([a, b]) => {
  const hit = truth.some(([s, e]) => a < e && b > s);
  return [a, b, hit ? "tl-det" : "tl-det fa", `${hit ? "détection" : "fausse alarme"} : ${clock(a)}–${clock(b)}`];
});

/* ==========================================================================
   MODÈLES · Banc d'essai
   ========================================================================== */
const Banc = {
  ready: false, history: [], last: null,
  async enter() {
    if (this.ready) return;
    this.ready = true;
    const box = $("#banc-body");
    let cfg;
    try { cfg = this.cfg = await ToolCfg.get(); }
    catch (e) { stateLine(box, "error", "Banc d’essai indisponible", e.message); this.ready = false; return; }
    const recs = cfg.annotated.map(r => `<option value="${r}">${r}</option>`).join("");
    box.innerHTML = `
      <p class="lab-banner" role="note"><b>Banc d’essai.</b> Choisissez un modèle, ses réglages, la taille des fenêtres et les caractéristiques, puis lancez : l’entraînement et l’évaluation se font maintenant, sur le serveur.<br>L’évaluation se fait toujours sur des enregistrements que le modèle n’a pas vus, et chaque résultat est comparé au Random Forest de référence du projet.</p>
      <section class="lab-sec banc-sec"><h2 class="h2 lab-h2"><span class="lab-letter">a</span>Entraîner un modèle</h2>
        <div class="banc-grid">
          <div class="lab-card">${cfgForm("bc-a", cfg, { open: true })}
            <div class="cf-row"><span class="field"><span class="tool-label">Évaluation</span><span class="seg" id="bc-eval"><button type="button" data-v="gkf" aria-pressed="true">Par enregistrement (GroupKFold, 5 plis)</button><button type="button" data-v="loro" aria-pressed="false">Un enregistrement laissé de côté</button></span></span></div>
            <div class="lab-row"><button type="button" class="btn" id="bc-run">Lancer</button><span class="lab-small lab-dim" id="bc-hint"></span></div>
            ${jobBox("bc-job")}</div>
          <div id="bc-out"><p class="body lab-dim">Le résultat s’affichera ici, à côté de celui du Random Forest de référence évalué de la même façon.</p></div>
        </div>
        <h3 class="h3 banc-h3">Derniers essais <span class="h3-note">les 5 plus récents</span></h3>
        <div class="tbl-scroll"><table class="tbl lab-tbl" id="bc-hist"><thead><tr><th>Configuration</th><th>Évaluation</th><th class="num">F1</th><th class="num">Précision</th><th class="num">Rappel</th><th class="num">Crises</th><th class="num">F. alarmes / h</th><th class="num">Retard</th><th class="num">Durée</th></tr></thead><tbody><tr><td colspan="9" class="empty-row">Aucun essai pour l’instant.</td></tr></tbody></table></div>
      </section>
      <section class="lab-sec banc-sec"><h2 class="h2 lab-h2"><span class="lab-letter">b</span>Tester sur un patient</h2>
        <p class="body lab-body">Le modèle configuré ci-dessus est entraîné sur tous les autres enregistrements, puis appliqué à celui-ci.</p>
        <div class="filters lab-controls"><label class="field"><span class="tool-label">Enregistrement</span><select id="bp-rec">${recs}</select></label><button type="button" class="btn" id="bp-run">Lancer</button></div>
        ${jobBox("bp-job")}<div id="bp-out"></div>
      </section>
      <section class="lab-sec banc-sec"><h2 class="h2 lab-h2"><span class="lab-letter">c</span>Duel</h2>
        <p class="body lab-body">Configuration A : celle du formulaire ci-dessus. Configuration B : ci-dessous. Les deux sont entraînées sans l’enregistrement choisi.</p>
        <div class="banc-grid banc-duel"><div class="lab-card"><p class="tool-label">Configuration B</p>${cfgForm("bc-b", cfg)}</div>
          <div><div class="filters lab-controls"><label class="field"><span class="tool-label">Enregistrement</span><select id="bd-rec">${recs}</select></label><button type="button" class="btn" id="bd-run">Lancer le duel</button></div>${jobBox("bd-job")}</div></div>
        <div id="bd-out"></div>
      </section>`;
    cfgWire("bc-a", cfg, () => this.hint());
    cfgWire("bc-b", cfg);
    $("#bc-b .cf-model").value = "knn"; $("#bc-b .cf-model").dispatchEvent(new Event("change"));
    bindSeg($("#bc-eval"), () => this.hint());
    $("#bp-rec").value = "230102B-F"; $("#bd-rec").value = "210504B-C";
    $("#bc-run").addEventListener("click", () => this.train());
    $("#bp-run").addEventListener("click", () => this.patient());
    $("#bd-run").addEventListener("click", () => this.duel());
  },
  evalMode() { return $("#bc-eval [aria-pressed='true']").dataset.v; },
  hint() {
    const c = cfgRead("bc-a"), ev = this.evalMode();
    const n = ev === "gkf" ? 5 : 19;
    const slow = { rf: 2.5, et: 2.5, svm: 3, xgb: 3, lgbm: 2.5 }[c.model] || 0.5;
    const trees = c.hp.n_trees ? c.hp.n_trees / 300 : 1;
    const est = Math.max(1, Math.round(n * slow * trees));
    $("#bc-hint").textContent = `${n} entraînements, environ ${nf(est)} s la première fois${est > 60 ? " (souvent davantage sur cette machine : préférer GroupKFold pour la démonstration)" : ""} ; immédiat ensuite (cache).`;
  },
  async train() {
    const cfg = this.cfg, c = cfgRead("bc-a"), ev = this.evalMode(), btn = $("#bc-run"), box = $("#bc-job");
    btn.disabled = true;
    try {
      const ref = await Jobs.run("bench", { cfg: cfg.reference, eval: ev }, box);
      const r = await Jobs.run("bench", { cfg: c, eval: ev }, box);
      this.render(r, ref);
      this.history.unshift({ r, label: cfgLabel(r.cfg, cfg), ev });
      this.history = this.history.slice(0, 5);
      this.renderHistory();
    } catch (e) { if (e.name !== "Cancelled") stateLine($("#bc-out"), "error", "Entraînement impossible", e.message); }
    finally { btn.disabled = false; }
  },
  render(r, ref) {
    const W = r.windows, E = r.events, RW = ref.windows, RE = ref.events;
    // écart coloré : meilleur ou moins bon que la référence (plus haut = mieux, sauf fausses alarmes et retard)
    const row = (l, v, rv, fmt, higher = true) => {
      const d = v == null || rv == null ? null : v - rv;
      const cls = d == null || Math.abs(d) < 1e-9 ? "" : (d > 0) === higher ? "is-better" : "is-worse";
      return `<tr><td>${l}</td><td class="num">${v == null ? "—" : fmt(v)}</td><td class="num">${rv == null ? "—" : fmt(rv)}</td><td class="num ${cls}">${d == null ? "—" : Math.abs(d) < 1e-9 ? "=" : (d > 0 ? "+" : "−") + fmt(Math.abs(d))}</td></tr>`;
    };
    const f3 = v => nf(v, 3), pc = v => pct(v, 1);
    $("#bc-out").innerHTML = `<div class="banc-res">
      <div class="lab-card"><p class="tool-label">${esc(cfgLabel(r.cfg, this.cfg))}</p>
        <table class="tbl lab-tbl banc-cmp"><thead><tr><th>Mesure</th><th class="num">Ce modèle</th><th class="num">Référence RF</th><th class="num">Écart</th></tr></thead><tbody>
          <tr class="grp"><td colspan="4">Par fenêtre (${nf(r.n_windows)} fenêtres)</td></tr>
          ${row("Exactitude", W.accuracy, RW.accuracy, f3)}${row("Précision", W.precision, RW.precision, f3)}${row("Rappel", W.recall, RW.recall, f3)}${row("F1", W.f1, RW.f1, f3)}
          <tr class="grp"><td colspan="4">Par crise (règles de détection du projet)</td></tr>
          ${row(`Crises détectées / ${E.n_true}`, E.detected, RE.detected, v => nf(v))}${row("Sensibilité", E.sensitivity, RE.sensitivity, pc)}
          ${row("Fausses alarmes", E.false_alarms, RE.false_alarms, v => nf(v), false)}${row("Fausses alarmes / h", E.fa_per_hour, RE.fa_per_hour, v => nf(v, 2), false)}
          ${row("Retard moyen au début (s)", E.mean_delay, RE.mean_delay, v => nf(v, 2), false)}
        </tbody></table>
        <p class="tbl-foot">${r.eval === "gkf" ? "GroupKFold par enregistrement, 5 plis" : "19 entraînements, chacun sans l’enregistrement évalué"} · référence : Random Forest du projet (300 arbres, 17 caractéristiques, fenêtres de 2 s), évaluée de la même façon. <span class="is-better">vert</span> : mieux que la référence, <span class="is-worse">rose</span> : moins bien. Par fenêtre : décision brute au seuil 0,5.</p></div>
      <div class="lab-card banc-cm"><p class="tool-label">Matrice de confusion (fenêtres)</p>${confusion(W)}</div></div>`;
  },
  renderHistory() {
    const tb = $("#bc-hist tbody"), cfg = this.cfg;
    tb.innerHTML = this.history.map(({ r, label, ev }) => `<tr><td>${esc(label)}</td><td>${ev === "gkf" ? "GroupKFold" : "un laissé de côté"}</td>` +
      `<td class="num">${nf(r.windows.f1, 3)}</td><td class="num">${nf(r.windows.precision, 3)}</td><td class="num">${nf(r.windows.recall, 3)}</td>` +
      `<td class="num">${r.events.detected}/${r.events.n_true}</td><td class="num">${nf(r.events.fa_per_hour, 2)}</td><td class="num">${r.events.mean_delay == null ? "—" : fmtS(r.events.mean_delay, 2)}</td><td class="num">${nf(r.computed_in_s, 0)} s</td></tr>`).join("");
  },
  async patient() {
    const c = cfgRead("bc-a"), rid = $("#bp-rec").value, btn = $("#bp-run");
    btn.disabled = true;
    try { this.renderPatient(await Jobs.run("patient", { cfg: c, rid }, $("#bp-job"))); }
    catch (e) { if (e.name !== "Cancelled") stateLine($("#bp-out"), "error", "Test impossible", e.message); }
    finally { btn.disabled = false; }
  },
  renderPatient(r) {
    const out = $("#bp-out"), T = r.totals;
    out.innerHTML = `<div class="lab-card"><div class="lab-card-head"><span class="h3">${esc(r.rid)} <span class="h3-note">${esc(cfgLabel(r.cfg, this.cfg))}, entraîné sur ${r.trained_on} enregistrements</span></span>
        <a class="pill-link" href="${lectureHref(r.rid)}">Ouvrir dans Lecture</a></div><div class="bp-tl"></div>
        <p class="lab-legend"><span><span class="sw sw-annot"></span>crise annotée</span><span><span class="sw sw-det"></span>détection</span><span><i class="lab-k" style="background:var(--coral-edge)"></i>fausse alarme</span><span><i class="lab-k lab-k-t"></i>seuil 0,5</span></p></div>
      <div class="kpis lab-kpis bp-kpis">
        <div class="kpi kpi-mint"><p class="kpi-v">${T.detected}<span class="kpi-of">/${T.n_true}</span></p><p class="kpi-l">crises détectées</p></div>
        <div class="kpi kpi-rose"><p class="kpi-v">${T.missed}</p><p class="kpi-l">crises manquées</p></div>
        <div class="kpi kpi-peach"><p class="kpi-v">${T.false_alarms}</p><p class="kpi-l">fausses alarmes · ${nf(T.fa_per_hour, 2)} / h</p></div>
        <div class="kpi kpi-lav"><p class="kpi-v">${T.mean_delay == null ? "—" : fmtS(T.mean_delay)}</p><p class="kpi-l">retard moyen au début</p></div></div>
      <div class="tbl-scroll"><table class="tbl lab-tbl"><thead><tr><th>Résultat</th><th class="num">Début réel</th><th class="num">Fin réelle</th><th class="num">Début détecté</th><th class="num">Fin détectée</th><th class="num">Retard</th><th></th></tr></thead><tbody>
        ${r.match.map(m => `<tr><td class="${m["Résultat"] === "Détectée" ? "status-hit" : m["Résultat"] === "Manquée" ? "status-miss" : "status-fa"}">${esc(m["Résultat"])}</td>` +
          `<td class="num">${m["Début réel"] == null ? "—" : clock(m["Début réel"], 1)}</td><td class="num">${m["Fin réelle"] == null ? "—" : clock(m["Fin réelle"], 1)}</td>` +
          `<td class="num">${m["Début détecté"] == null ? "—" : clock(m["Début détecté"], 1)}</td><td class="num">${m["Fin détectée"] == null ? "—" : clock(m["Fin détectée"], 1)}</td>` +
          `<td class="num">${m["Retard début (s)"] == null ? "—" : fmtS(m["Retard début (s)"])}</td>` +
          `<td><a class="link" href="${lectureHref(r.rid)}?t=${Math.max(0, Math.floor((m["Début réel"] ?? m["Début détecté"]) - 5))}">voir</a></td></tr>`).join("")}</tbody></table></div>`;
    const draw = () => { const el = $(".bp-tl", out); if (el) el.innerHTML = timelineSVG([
      { label: "annotées", items: truthItems(r) }, { label: "détectées", items: detItems(r) },
      { label: "probabilité", curve: { t: r.t_start.map((t, i) => (t + r.t_end[i]) / 2), p: r.proba } }], r.duration, Math.max(480, el.clientWidth)); };
    draw(); onResize($(".bp-tl", out), draw);
  },
  async duel() {
    const a = cfgRead("bc-a"), b = cfgRead("bc-b"), rid = $("#bd-rec").value, btn = $("#bd-run");
    btn.disabled = true;
    try { this.renderDuel(await Jobs.run("duel", { a, b, rid }, $("#bd-job"))); }
    catch (e) { if (e.name !== "Cancelled") stateLine($("#bd-out"), "error", "Duel impossible", e.message); }
    finally { btn.disabled = false; }
  },
  renderDuel(d) {
    const out = $("#bd-out"), A = d.a, B = d.b, cfg = this.cfg;
    const kpi = (r, who) => `<div class="lab-card duel-card"><p class="tool-label">${who} · ${esc(cfgLabel(r.cfg, cfg))}</p><p class="duel-v">${r.totals.detected}/${r.totals.n_true} crises · ${r.totals.false_alarms} fausses alarmes</p></div>`;
    out.innerHTML = `<div class="duel-kpis">${kpi(A, "A")}${kpi(B, "B")}</div>
      <div class="lab-card"><div class="lab-card-head"><span class="h3">${esc(d.rid)}</span><a class="pill-link" href="${lectureHref(d.rid)}">Ouvrir dans Lecture</a></div><div class="bd-tl"></div></div>
      <h3 class="h3 banc-h3">Désaccords <span class="h3-note">${d.disagreements.length ? `${d.disagreements.length} au total` : ""}</span></h3>
      ${d.disagreements.length ? `<ul class="duel-list">${d.disagreements.map(x => `<li><span class="duel-by duel-${x.by}">${x.by}</span>` +
        (x.type === "crise" ? `crise annotée ${x.n} (${clock(x.start, 1)}–${clock(x.end, 1)}) : repérée par ${x.by} seulement`
          : `fausse alarme de ${x.by} seulement, ${clock(x.start, 1)}–${clock(x.end, 1)}`) +
        ` · <a class="link" href="${lectureHref(d.rid)}?t=${Math.max(0, Math.floor(x.start - 5))}">voir</a></li>`).join("")}</ul>`
        : `<p class="body">Les deux configurations trouvent exactement les mêmes crises et les mêmes fausses alarmes sur cet enregistrement.</p>`}`;
    const draw = () => { const el = $(".bd-tl", out); if (el) el.innerHTML = timelineSVG([
      { label: "annotées", items: truthItems(A) }, { label: "A", items: detItems(A) }, { label: "B", items: detItems(B) },
      { label: "probabilité A", curve: { t: A.t_start, p: A.proba } }, { label: "probabilité B", curve: { t: B.t_start, p: B.proba } }], A.duration, Math.max(480, el.clientWidth), { curveH: 46 }); };
    draw(); onResize($(".bd-tl", out), draw);
  },
};
function confusion(W) {
  const tot = W.tp + W.fp + W.fn + W.tn, cell = (v, l, cls) => `<div class="cm-cell ${cls}"><span class="cm-v">${nf(v)}</span><span class="cm-l">${l} · ${pct(v / tot, 1)}</span></div>`;
  return `<div class="cm"><span></span><span class="cm-h">prédit : crise</span><span class="cm-h">prédit : normal</span>
    <span class="cm-h cm-r">réel : crise</span>${cell(W.tp, "vrais positifs", "cm-ok")}${cell(W.fn, "faux négatifs", "cm-bad")}
    <span class="cm-h cm-r">réel : normal</span>${cell(W.fp, "faux positifs", "cm-bad")}${cell(W.tn, "vrais négatifs", "cm-ok")}</div>`;
}

/* ==========================================================================
   PATIENTS · carte, K-means, filtres, relance, voisins
   ========================================================================== */
const PatTools = {
  ready: false, map: null, km: null, colorBy: "age_group", scope: "seizure", rerun: {}, selected: new Set(),
  filt: { age: "", sex: "", type: "", fa: "", min: 0 }, filtB: { age: "", sex: "", type: "", fa: "", min: 0 }, compare: false, hi: null,
  async enter(D) {
    this.D = D;
    if (!this.ready) { this.ready = true; this.build(); }
    await this.loadMap();
    this.totals();
  },
  build() {
    $("#pat-tools").innerHTML = `
      <nav class="r-toc pt-tabs" role="tablist" aria-label="Outils de la cohorte">
        <button type="button" role="tab" data-t="carte" aria-selected="true">Carte des patients</button>
        <button type="button" role="tab" data-t="kmeans" aria-selected="false">K-means</button>
        <button type="button" role="tab" data-t="filtres" aria-selected="false">Filtres et comparaison</button>
        <button type="button" role="tab" data-t="relance" aria-selected="false">Relancer sur une sélection</button></nav>
      <div class="pt-layout">
        <div class="lab-card pt-mapcard"><div class="lab-card-head"><span class="h3">Carte des patients <span class="h3-note" id="pt-var"></span></span></div>
          <div class="cf-row"><label class="field"><span class="tool-label">Couleur</span><select id="pt-color">
            <option value="age">âge</option><option value="age_group" selected>groupe d’âge</option><option value="sex">sexe</option><option value="n_seizures">nombre de crises</option>
            <option value="sensitivity">sensibilité de détection</option><option value="fa_per_hour">fausses alarmes / h</option><option value="type">typique / atypique</option><option value="cluster">groupe K-means</option></select></label>
            <label class="field check"><input type="checkbox" id="pt-scope"> utiliser les fenêtres hors crise</label></div>
          <div id="pt-map" class="pt-map"></div><div class="tip lab-tip" id="pt-tip" hidden></div><p class="lab-legend" id="pt-legend"></p>
          <p class="lab-small lab-dim" id="pt-mapnote"></p></div>
        <div class="pt-panels">
          <div class="pt-panel" data-t="carte"><p class="body lab-body">Chaque point est un patient : la moyenne de ses 17 caractéristiques sur ses fenêtres de crise, centrée-réduite sur la cohorte, puis projetée sur les deux axes principaux (ACP). Deux points proches ont des crises qui se ressemblent pour le modèle. Cliquer un point ouvre l’enregistrement ; le bouton « proches » du tableau donne les trois patients les plus semblables.</p><div id="pt-nn"></div></div>
          <div class="pt-panel" data-t="kmeans" hidden>
            <div class="lab-row"><label class="lab-slider pt-k"><span class="tool-label">Nombre de groupes k</span><input type="range" id="pt-k" min="2" max="5" step="1" value="3"><output id="pt-k-v">3</output></label><button type="button" class="btn" id="pt-km">Regrouper</button></div>
            <div id="pt-km-out"></div></div>
          <div class="pt-panel" data-t="filtres" hidden><div id="pt-filters"></div></div>
          <div class="pt-panel" data-t="relance" hidden>
            <p class="body lab-body">Cochez des lignes du tableau, choisissez le modèle et le seuil, puis lancez : chaque patient coché est réanalysé par un modèle entraîné sans lui. Les cases modifiées sont surlignées.</p>
            <div class="lab-row"><span class="seg" id="pt-rr-model"><button type="button" data-v="rf" aria-pressed="true">Random Forest</button><button type="button" data-v="et" aria-pressed="false">Extra Trees</button></span></div>
            <label class="lab-slider"><span class="tool-label">Seuil de décision</span><input type="range" id="pt-rr-thr" min="0.05" max="0.95" step="0.05" value="0.5"><output id="pt-rr-thr-v">0,50</output></label>
            <div class="lab-row"><button type="button" class="btn" id="pt-rr-run">Lancer</button><button type="button" class="link-btn" id="pt-rr-all">tout cocher</button><button type="button" class="link-btn" id="pt-rr-none">tout décocher</button><span class="lab-small lab-dim" id="pt-rr-n"></span><button type="button" class="link-btn" id="pt-rr-clear" hidden>effacer la relance</button></div>
            ${jobBox("pt-rr-job")}<div id="pt-rr-out"></div></div>
        </div></div>
      <div class="pt-totals" id="pt-totals"></div>`;
    $(".pt-tabs").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      $$(".pt-tabs button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      $$(".pt-panel").forEach(p => { p.hidden = p.dataset.t !== b.dataset.t; });
    });
    $("#pt-color").addEventListener("change", e => { this.colorBy = e.target.value; this.drawMap(); });
    $("#pt-scope").addEventListener("change", async e => { this.scope = e.target.checked ? "normal" : "seizure"; this.map = null; this.km = null; $("#pt-km-out").innerHTML = ""; await this.loadMap(); });
    $("#pt-k").addEventListener("input", e => { $("#pt-k-v").textContent = e.target.value; });
    $("#pt-km").addEventListener("click", () => this.kmeans());
    bindSeg($("#pt-rr-model"), () => {});
    $("#pt-rr-thr").addEventListener("input", e => { $("#pt-rr-thr-v").textContent = nf(+e.target.value, 2); });
    $("#pt-rr-run").addEventListener("click", () => this.runRerun());
    $("#pt-rr-all").addEventListener("click", () => { this.visible().forEach(r => this.selected.add(r.id)); this.refresh(); });
    $("#pt-rr-none").addEventListener("click", () => { this.selected.clear(); this.refresh(); });
    $("#pt-rr-clear").addEventListener("click", () => { this.rerun = {}; $("#pt-rr-clear").hidden = true; $("#pt-rr-out").innerHTML = ""; this.refresh(); });
    $("#pt-map").addEventListener("mousemove", e => this.hover(e));
    $("#pt-map").addEventListener("mouseleave", () => { $("#pt-tip").hidden = true; });
    $("#pt-map").addEventListener("click", e => { const g = e.target.closest("[data-id]"); if (g) go(lectureHref(g.dataset.id)); });
    onResize($("#pt-map"), () => this.map && this.drawMap());
    this.buildFilters();
  },
  async loadMap() {
    if (this.map && this.map.scope === this.scope) return this.drawMap();
    try { this.map = await api(`/api/tools/patients/map?scope=${this.scope}`); }
    catch (e) { stateLine($("#pt-map"), "error", "Carte indisponible", e.message); return; }
    this.drawMap();
  },
  value(p) {
    if (this.colorBy === "cluster") return this.km ? this.km.labels[p.id] : null;
    return p[this.colorBy];
  },
  drawMap() {
    const M = this.map, el = $("#pt-map"); if (!M) return;
    const W = Math.max(320, el.clientWidth), H = Math.min(420, Math.max(300, W * 0.62)), m = 34;
    const xs = M.points.map(p => p.x), ys = M.points.map(p => p.y);
    const pad = (a, b) => [a - (b - a) * 0.08, b + (b - a) * 0.08];
    const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    const X = v => m + (v - x0) / (x1 - x0) * (W - 2 * m), Y = v => H - m - (v - y0) / (y1 - y0) * (H - 2 * m);
    this.geom = { X, Y, W, H };
    const cat = ["age_group", "sex", "type", "cluster"].includes(this.colorBy);
    const vals = M.points.map(p => this.value(p));
    const levels = cat ? [...new Set(vals.filter(v => v != null))].sort() : null;
    const nums = vals.filter(v => v != null);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const color = v => v == null ? "#C9BFC4" : cat ? CAT[levels.indexOf(v) % CAT.length] : seqColor(hi > lo ? 0.15 + 0.85 * (v - lo) / (hi - lo) : 0.6);
    const vis = new Set(this.visible().map(r => r.id));
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="lab-svg" role="img" aria-label="Carte des patients : analyse en composantes principales">`;
    s += `<line x1="${m}" x2="${W - m}" y1="${Y(0)}" y2="${Y(0)}" class="lab-grid"/><line x1="${X(0)}" x2="${X(0)}" y1="${m}" y2="${H - m}" class="lab-grid"/>`;
    s += `<text x="${W - m}" y="${H - 8}" class="lab-axis" text-anchor="end">axe 1 · ${pct(M.variance[0], 0)} de la variance</text>`;
    s += `<text x="12" y="${m - 12}" class="lab-axis">axe 2 · ${pct(M.variance[1], 0)}</text>`;
    for (const p of M.points) {
      const on = vis.has(p.id), hl = this.hi && this.hi.includes(p.id);
      s += `<g class="pt-pt${on ? "" : " is-off"}${hl ? " is-hl" : ""}" data-id="${esc(p.id)}" tabindex="0"><circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${hl ? 10 : 7.5}" fill="${color(this.value(p))}"/>` +
        `<text x="${X(p.x) + 11}" y="${Y(p.y) + 4}" class="pt-lab">${esc(p.id.slice(0, 7))}</text></g>`;
    }
    el.innerHTML = s + "</svg>";
    $("#pt-var").textContent = `ACP sur ${M.scope === "seizure" ? "les fenêtres de crise" : "les fenêtres hors crise"}, ${M.points.length} patients`;
    $("#pt-mapnote").textContent = `Axe 1 surtout porté par ${M.top_pc1.join(", ")} ; axe 2 par ${M.top_pc2.join(", ")}.`;
    const nameOf = { age: "âge (ans)", n_seizures: "nombre de crises", sensitivity: "sensibilité", fa_per_hour: "fausses alarmes / h" }[this.colorBy];
    $("#pt-legend").innerHTML = cat ? levels.map(v => `<span><i class="lab-k" style="background:${color(v)}"></i>${esc(this.colorBy === "cluster" ? `groupe ${v + 1}` : this.colorBy === "sex" ? (v === "F" ? "féminin" : "masculin") : v)}</span>`).join("") + (vals.some(v => v == null) ? `<span><i class="lab-k" style="background:#C9BFC4"></i>${this.colorBy === "cluster" ? "lancer K-means" : "inconnu"}</span>` : "")
      : `<span>${nameOf} : </span><span><i class="lab-k" style="background:${seqColor(0.15)}"></i>${nf(lo, hi < 2 ? 2 : 0)}</span><span><i class="lab-k" style="background:${seqColor(1)}"></i>${nf(hi, hi < 2 ? 2 : 0)}</span>`;
  },
  hover(e) {
    const g = e.target.closest("[data-id]"), tip = $("#pt-tip");
    if (!g) { tip.hidden = true; return; }
    const p = this.map.points.find(x => x.id === g.dataset.id);
    const cl = this.km ? ` · groupe ${this.km.labels[p.id] + 1}` : "";
    tip.innerHTML = `<b>${esc(p.id)}</b>${cl}<br>${p.sex === "F" ? "féminin" : p.sex === "M" ? "masculin" : "—"}, ${p.age == null ? "âge inconnu" : `${nf(p.age)} ans`} · ${p.type}<br>` +
      `${p.n_seizures} crises · détectées ${p.detected ?? "—"} · ${p.false_alarms ?? "—"} fausses alarmes (${p.fa_per_hour == null ? "—" : nf(p.fa_per_hour, 2)} / h)<br>fréquence du pic ${nf(p.peak_freq, 2)} Hz · amplitude ${nf(p.amplitude, 0)} µV`;
    tip.hidden = false;
    const box = $(".pt-mapcard").getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - 290)}px`; tip.style.top = `${e.clientY - box.top + 14}px`;
  },
  async kmeans() {
    const k = +$("#pt-k").value, btn = $("#pt-km");
    btn.disabled = true;
    try { this.km = await api(`/api/tools/patients/kmeans?k=${k}&scope=${this.scope}`); }
    catch (e) { stateLine($("#pt-km-out"), "error", "Regroupement impossible", e.message); return; }
    finally { btn.disabled = false; }
    this.colorBy = "cluster"; $("#pt-color").value = "cluster";
    this.drawMap(); this.renderKm(); this.refresh();
  },
  renderKm() {
    const K = this.km, M = this.map, rows = this.rowsById();
    const sil = Object.entries(K.silhouette).map(([k, v]) => [+k, v]), best = sil.reduce((a, b) => (b[1] > a[1] ? b : a));
    const W = 300, H = 120, bw = 46;
    const bars = sil.map(([k, v], i) => `<g><rect x="${30 + i * (bw + 18)}" y="${H - 24 - Math.max(0, v) * 160}" width="${bw}" height="${Math.max(1, Math.max(0, v) * 160)}" rx="3" class="${k === K.k ? "km-bar is-on" : "km-bar"}"><title>k = ${k} : silhouette ${nf(v, 3)}</title></rect>` +
      `<text x="${30 + i * (bw + 18) + bw / 2}" y="${H - 28 - Math.max(0, v) * 160}" class="lab-tick" text-anchor="middle">${nf(v, 2)}</text><text x="${30 + i * (bw + 18) + bw / 2}" y="${H - 8}" class="lab-tick" text-anchor="middle">k = ${k}</text></g>`).join("");
    const groups = [...Array(K.k).keys()].map(c => {
      const ids = Object.keys(K.labels).filter(id => K.labels[id] === c), pts = M.points.filter(p => ids.includes(p.id));
      const R = ids.map(id => rows[id]).filter(Boolean);
      const det = R.reduce((a, r) => a + (r.totals ? r.totals.detected : 0), 0), tot = R.reduce((a, r) => a + (r.totals ? r.totals.n_true : 0), 0);
      const fa = R.reduce((a, r) => a + (r.totals ? r.totals.false_alarms : 0), 0), h = R.reduce((a, r) => a + r.hours, 0);
      const ages = pts.map(p => p.age).filter(a => a != null);
      const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
      return `<div class="km-card" style="border-top-color:${CAT[c]}"><p class="tool-label" style="color:${CAT[c]}">Groupe ${c + 1}</p>
        <dl><div><dt>Patients</dt><dd>${ids.length}</dd></div><div><dt>Âge moyen</dt><dd>${ages.length ? `${nf(mean(ages), 1)} ans` : "—"}</dd></div>
        <div><dt>Fréquence dominante</dt><dd>${nf(mean(pts.map(p => p.peak_freq)), 2)} Hz</dd></div><div><dt>Amplitude moyenne</dt><dd>${nf(mean(pts.map(p => p.amplitude)), 0)} µV</dd></div>
        <div><dt>Crises détectées</dt><dd>${det}/${tot}</dd></div><div><dt>Fausses alarmes / h</dt><dd>${h ? nf(fa / h, 2) : "—"}</dd></div></dl>
        <p class="lab-small lab-dim">${ids.map(esc).join(", ")}</p></div>`;
    }).join("");
    $("#pt-km-out").innerHTML = `<p class="body lab-body">K-means (random_state 42) sur les mêmes caractéristiques centrées-réduites : silhouette ${mono(nf(K.silhouette[K.k], 3))} pour k = ${K.k}. La meilleure silhouette est obtenue pour k = ${best[0]} (${nf(best[1], 3)}) ; ${best[1] < 0.25 ? "elle reste faible : les groupes se recouvrent largement." : best[1] < 0.5 ? "une structure modérée." : "des groupes bien séparés."}</p>
      <figure class="km-sil"><figcaption class="tool-label">Silhouette selon k</figcaption><svg viewBox="0 0 ${W} ${H}" class="lab-svg" role="img" aria-label="Score de silhouette pour k de 2 à 5">${bars}</svg></figure>
      <div class="km-cards">${groups}</div>`;
  },
  /* ---- filtres */
  buildFilters() {
    const f = (id, lab, opts) => `<label class="field"><span class="tool-label">${lab}</span><select data-k="${id}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
    const set = g => `<div class="pt-fset" data-g="${g}">${g === "B" ? '<p class="tool-label pt-gl">Groupe B</p>' : '<p class="tool-label pt-gl" hidden>Groupe A</p>'}
      ${f("age", "Âge", [["", "tous"], ["< 8 ans", "< 8 ans"], ["8–11 ans", "8–11 ans"], ["≥ 12 ans", "≥ 12 ans"]])}
      ${f("sex", "Sexe", [["", "tous"], ["F", "féminin"], ["M", "masculin"]])}
      ${f("type", "Type", [["", "tous"], ["typique", "typique"], ["atypique", "atypique"]])}
      ${f("fa", "Fausses alarmes", [["", "toutes"], ["avec", "avec"], ["sans", "sans"]])}
      <label class="field"><span class="tool-label">Crises min.</span><input type="number" class="lab-num" data-k="min" min="0" max="20" value="0"></label></div>`;
    $("#pt-filters").innerHTML = `${set("A")}<label class="field check"><input type="checkbox" id="pt-cmp"> comparer deux groupes</label><div id="pt-fB" hidden>${set("B")}</div>
      <p class="lab-small lab-dim">Le tableau, la carte et les totaux suivent les filtres (groupe A), sans recalcul côté serveur.</p>`;
    $("#pt-filters").addEventListener("input", e => {
      const k = e.target.dataset.k; if (!k) return;
      const g = e.target.closest(".pt-fset").dataset.g;
      (g === "A" ? this.filt : this.filtB)[k] = k === "min" ? +e.target.value || 0 : e.target.value;
      this.refresh();
    });
    $("#pt-cmp").addEventListener("change", e => { this.compare = e.target.checked; $("#pt-fB").hidden = !this.compare; $(".pt-fset[data-g='A'] .pt-gl").hidden = !this.compare; this.totals(); });
  },
  rowsById() { return Object.fromEntries(this.D.recordings.map(r => [r.id, r])); },
  meta(id) { return this.map ? this.map.points.find(p => p.id === id) : null; },
  match(r, F) {
    if (!r.annotated) return !F.age && !F.sex && !F.type && !F.fa && !F.min;
    const p = this.meta(r.id), T = r.totals;
    const g = r.age == null ? null : r.age < 8 ? "< 8 ans" : r.age < 12 ? "8–11 ans" : "≥ 12 ans";
    if (F.age && g !== F.age) return false;
    if (F.sex && r.sex !== F.sex) return false;
    if (F.type && (r.type_abs ? "atypique" : "typique") !== F.type) return false;
    if (F.fa === "avec" && !(T && T.false_alarms > 0)) return false;
    if (F.fa === "sans" && !(T && T.false_alarms === 0)) return false;
    if (F.min && !(T && T.n_true >= F.min)) return false;
    return p !== undefined;
  },
  keep(r) { return this.match(r, this.filt); },
  visible() { return this.D ? this.D.recordings.filter(r => r.annotated && this.keep(r)) : []; },
  group(F) {
    const R = this.D.recordings.filter(r => r.annotated && this.match(r, F));
    const val = (r, k) => (this.rerun[r.id] ? this.rerun[r.id][k] : r.totals[k]);
    const n = R.reduce((a, r) => a + r.totals.n_true, 0), det = R.reduce((a, r) => a + val(r, "detected"), 0);
    const fa = R.reduce((a, r) => a + val(r, "false_alarms"), 0), h = R.reduce((a, r) => a + r.hours, 0);
    return { patients: R.length, n, det, fa, sens: n ? det / n : null, faH: h ? fa / h : null };
  },
  totals() {
    if (!this.D) return;
    const box = (G, title) => `<div class="pt-tot">${title ? `<p class="tool-label">${title}</p>` : ""}<dl>
      <div><dt>Patients</dt><dd>${G.patients}</dd></div><div><dt>Crises</dt><dd>${G.n}</dd></div><div><dt>Détectées</dt><dd>${G.det}</dd></div>
      <div><dt>Sensibilité</dt><dd>${G.sens == null ? "—" : pct(G.sens, 1)}</dd></div><div><dt>Fausses alarmes / h</dt><dd>${G.faH == null ? "—" : nf(G.faH, 2)}</dd></div></dl></div>`;
    const A_ = this.group(this.filt);
    $("#pt-totals").innerHTML = this.compare ? `<div class="pt-cmp">${box(A_, "Groupe A")}${box(this.group(this.filtB), "Groupe B")}</div>`
      : box(A_, Object.keys(this.rerun).length ? "Sélection affichée (avec la relance)" : "Sélection affichée");
  },
  refresh() {
    if (!this.D) return;
    Patients.render(this.D);
    this.drawMap(); this.totals();
    $("#pt-rr-n").textContent = `${this.selected.size} coché${this.selected.size > 1 ? "s" : ""}`;
  },
  /* ---- relance */
  async runRerun() {
    const rids = [...this.selected], btn = $("#pt-rr-run");
    if (!rids.length) { $("#pt-rr-out").innerHTML = `<p class="lab-small">Cochez d’abord des lignes du tableau.</p>`; return; }
    const model = $("#pt-rr-model [aria-pressed='true']").dataset.v, threshold = +$("#pt-rr-thr").value;
    btn.disabled = true;
    try {
      const r = await Jobs.run("rerun", { rids, model, threshold }, $("#pt-rr-job"));
      this.rerun = Object.fromEntries(r.recordings.map(e => [e.id, e]));
      $("#pt-rr-clear").hidden = false;
      const ch = r.recordings.filter(e => { const o = this.rowsById()[e.id].totals; return o.detected !== e.detected || o.false_alarms !== e.false_alarms; }).length;
      $("#pt-rr-out").innerHTML = `<p class="lab-small">${esc(model === "rf" ? "Random Forest" : "Extra Trees")}, seuil ${nf(threshold, 2)} : ${plural(r.recordings.length, "patient réanalysé", "patients réanalysés")}, ${plural(ch, "ligne modifiée", "lignes modifiées")} (surlignées, valeur du projet entre parenthèses).</p>`;
      this.refresh();
    } catch (e) { if (e.name !== "Cancelled") stateLine($("#pt-rr-out"), "error", "Relance impossible", e.message); }
    finally { btn.disabled = false; }
  },
  /* ---- voisins */
  nearest(id) {
    const P = this.map.points, me = P.find(p => p.id === id);
    if (!me) return;
    const d = P.filter(p => p.id !== id).map(p => [p, Math.sqrt(p.z.reduce((a, v, i) => a + (v - me.z[i]) ** 2, 0))]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    this.hi = [id, ...d.map(x => x[0].id)];
    $(".pt-tabs button[data-t='carte']").click();
    $("#pt-nn").innerHTML = `<div class="lab-card pt-nn"><p class="tool-label">Les 3 patients les plus proches de ${esc(id)}</p><ol>${d.map(([p, dist]) =>
      `<li><button type="button" class="link-btn" data-hl="${esc(p.id)}">${esc(p.id)}</button> · distance ${nf(dist, 2)} · ${p.age == null ? "—" : `${nf(p.age)} ans`}, ${p.n_seizures} crises</li>`).join("")}</ol>
      <p class="lab-small lab-dim">Distance euclidienne sur les 17 caractéristiques centrées-réduites (${this.map.scope === "seizure" ? "fenêtres de crise" : "fenêtres hors crise"}).</p></div>`;
    $$("#pt-nn [data-hl]").forEach(b => b.addEventListener("click", () => { this.hi = [id, b.dataset.hl]; this.drawMap(); }));
    this.drawMap();
    $(".pt-mapcard").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  },
};

/* ==========================================================================
   LIMITES · démonstrations sous chaque limite
   ========================================================================== */
const LimDemo = {
  state: {}, learn: [],
  mount() {
    $$("#lim-body .lim-demo").forEach(b => {
      const k = b.dataset.demo, out = b.nextElementSibling;
      b.onclick = () => { out.hidden = !out.hidden; b.setAttribute("aria-expanded", String(!out.hidden)); if (!out.hidden && !out.dataset.built) this.build(k, out); };
      if (this.state[k] && this.state[k].open) { out.hidden = false; this.build(k, out); b.setAttribute("aria-expanded", "true"); }
    });
  },
  build(k, out) {
    out.dataset.built = "1";
    (this.state[k] = this.state[k] || {}).open = true;
    this[k](out);
  },
  /* a) peu de données */
  donnees(out) {
    out.innerHTML = `<div class="lab-card lim-card"><label class="lab-slider"><span class="tool-label">Nombre d’enregistrements d’entraînement</span><input type="range" id="ld-n" min="3" max="15" step="1" value="8"><output id="ld-n-v">8</output></label>
      <div class="lab-row"><button type="button" class="btn" id="ld-run">Lancer</button><span class="lab-small lab-dim">Random Forest du projet ; 4 enregistrements de test tirés au hasard, 5 tirages.</span></div>${jobBox("ld-job")}
      <div id="ld-out"></div><div id="ld-curve"></div></div>`;
    $("#ld-n").addEventListener("input", e => { $("#ld-n-v").textContent = e.target.value; });
    $("#ld-run").addEventListener("click", async () => {
      const btn = $("#ld-run"); btn.disabled = true;
      try {
        const r = await Jobs.run("learning", { n_train: +$("#ld-n").value }, $("#ld-job"));
        this.learn = this.learn.filter(x => x.n_train !== r.n_train).concat([r]).sort((a, b) => a.n_train - b.n_train);
        this.renderLearn(r);
      } catch (e) { if (e.name !== "Cancelled") stateLine($("#ld-out"), "error", "Calcul impossible", e.message); }
      finally { btn.disabled = false; }
    });
    if (this.learn.length) this.renderLearn(this.learn[this.learn.length - 1]);
  },
  async renderLearn(r) {
    const S = await Summary.get(), E = S.evaluation ? S.evaluation.events : null, Wf = S.evaluation ? S.evaluation.windows_raw["F1-score"] : null;
    const ms = (o, f) => `${f(o.mean)} <span class="lab-dim">± ${f(o.sd)}</span>`;
    $("#ld-out").innerHTML = `<div class="lim-res"><div><p class="tool-label">F1 par fenêtre</p><p class="lim-v">${ms(r.f1, v => nf(v, 3))}</p></div>
      <div><p class="tool-label">Sensibilité (crises)</p><p class="lim-v">${ms(r.sensitivity, v => pct(v, 0))}</p></div>
      <div><p class="tool-label">Fausses alarmes / h</p><p class="lim-v">${ms(r.fa_per_hour, v => nf(v, 2))}</p></div></div>
      <p class="lab-small">${r.n_train} enregistrements d’entraînement, moyenne ± écart-type sur 5 tirages (min.–max. du F1 : ${nf(r.f1.min, 3)}–${nf(r.f1.max, 3)}).` +
      (E ? ` Avec toutes les données (18 enregistrements d’entraînement, chacun laissé de côté à son tour) : F1 ${nf(Wf, 3)}, sensibilité ${pct(E.sensitivity, 1)}, ${nf(E.fa_per_hour, 2)} fausses alarmes / h.` : "") + `</p>`;
    // courbe d'apprentissage : chaque essai devient un point (moyenne et étendue)
    const pts = this.learn, W = Math.max(320, $("#ld-curve").clientWidth || 600), H = 220, m = { l: 46, r: 16, t: 14, b: 36 };
    const X = n => m.l + (n - 3) / 15 * (W - m.l - m.r), lo = Math.min(0.3, ...pts.map(p => p.f1.min)) , Y = v => H - m.b - (v - lo) / (1 - lo) * (H - m.t - m.b);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg" role="img" aria-label="Courbe d’apprentissage : F1 selon le nombre d’enregistrements d’entraînement">`;
    for (let v = Math.ceil(lo * 10) / 10; v <= 1.0001; v += 0.1) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="lab-grid"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="lab-tick" text-anchor="end">${nf(v, 1)}</text>`;
    for (let n = 3; n <= 18; n += 3) s += `<text x="${X(n)}" y="${H - 18}" class="lab-tick" text-anchor="middle">${n}</text>`;
    s += `<text x="${(W + m.l) / 2}" y="${H - 3}" class="lab-axis" text-anchor="middle">enregistrements d’entraînement</text>`;
    if (Wf != null) s += `<line x1="${X(18)}" x2="${X(18)}" y1="${Y(Wf) - 8}" y2="${Y(Wf) + 8}" class="lab-proj-l"/><circle cx="${X(18)}" cy="${Y(Wf)}" r="6" class="lim-full"><title>toutes les données : F1 ${nf(Wf, 3)}</title></circle><text x="${X(18) - 10}" y="${Y(Wf) - 12}" class="lab-tick" text-anchor="end">toutes les données</text>`;
    if (pts.length > 1) s += `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p.n_train)} ${Y(p.f1.mean)}`).join("")}" class="lab-line"/>`;
    for (const p of pts) s += `<line x1="${X(p.n_train)}" x2="${X(p.n_train)}" y1="${Y(p.f1.min)}" y2="${Y(p.f1.max)}" class="lim-range"/><circle cx="${X(p.n_train)}" cy="${Y(p.f1.mean)}" r="5" class="lab-pt is-high"><title>${p.n_train} enregistrements : F1 ${nf(p.f1.mean, 3)} (${nf(p.f1.min, 3)}–${nf(p.f1.max, 3)})</title></circle>`;
    $("#ld-curve").innerHTML = s + `</svg><p class="lab-small lab-dim">Chaque lancement ajoute un point : moyenne et étendue des 5 tirages. Le point « toutes les données » vient de l’évaluation « un enregistrement laissé de côté » du site (18 enregistrements d’entraînement).</p>`;
  },
  /* b) évaluation optimiste */
  optimiste(out) {
    out.innerHTML = `<div class="lab-card lim-card"><div class="lab-row"><button type="button" class="btn" data-m="random">Découpage aléatoire 80/20</button><button type="button" class="btn" data-m="gkf">Par enregistrement</button><span class="lab-small lab-dim">Même modèle : le Random Forest du projet.</span></div>${jobBox("lo-job")}<div id="lo-out"></div></div>`;
    const S = this.state.optimiste;
    const show = () => {
      const R = S.random, G = S.gkf;
      $("#lo-out").innerHTML = `<div class="lim-res"><div><p class="tool-label">Découpage aléatoire</p><p class="lim-v">${R ? `F1 ${nf(R.windows.f1, 3)}` : "—"}</p></div>
        <div><p class="tool-label">Par enregistrement</p><p class="lim-v">${G ? `F1 ${nf(G.windows.f1, 3)}` : "—"}</p></div>
        <div><p class="tool-label">Écart</p><p class="lim-v">${R && G ? signed(R.windows.f1 - G.windows.f1, 3) : "—"}</p></div></div>` +
        (R ? `<p class="lab-small">Les fenêtres se recouvrent de moitié : avec un découpage aléatoire, ${mono(pct(R.overlap_share, 0))} des fenêtres de test ont une voisine immédiate, presque identique, dans l’entraînement. Le modèle a déjà vu ce qu’on lui demande de reconnaître : le score est flatté.</p>` : "");
    };
    $$("button[data-m]", out).forEach(b => b.addEventListener("click", async () => {
      $$("button[data-m]", out).forEach(x => { x.disabled = true; });
      try { S[b.dataset.m] = await Jobs.run("bench", { cfg: (await ToolCfg.get()).reference, eval: b.dataset.m }, $("#lo-job")); show(); }
      catch (e) { if (e.name !== "Cancelled") stateLine($("#lo-out"), "error", "Calcul impossible", e.message); }
      finally { $$("button[data-m]", out).forEach(x => { x.disabled = false; }); }
    }));
    if (S.random || S.gkf) show();
  },
  /* c) artefacts : mêmes calculs que le stress test du Laboratoire */
  async artefacts(out) {
    const ART = { mouvement: "Pic de mouvement", muscle: "Bruit musculaire", secteur: "Parasite 50 Hz", electrode: "Décollement d’électrode", clignement: "Clignement des yeux" };
    out.innerHTML = `<div class="lab-card lim-card"><p class="lab-small" id="la-seg">Recherche d’un extrait calme de 230102B-F…</p>
      <div class="lab-art-btns">${Object.entries(ART).map(([k, l]) => `<button type="button" class="btn btn-quiet" data-k="${k}" disabled>${l}</button>`).join("")}</div><div id="la-out"></div>
      <p class="lab-small lab-dim">Injection dans une copie de l’extrait en mémoire ; les fichiers ne sont jamais modifiés. Version complète : <a class="link" href="#/laboratoire/stress">Laboratoire, stress test</a>.</p></div>`;
    let calm;
    try { calm = await api("/api/lab/stress/calm?rid=230102B-F"); }
    catch (e) { $("#la-seg").textContent = e.message; return; }
    $("#la-seg").textContent = `Extrait calme choisi par calcul : 230102B-F, ${clock(calm.start)}–${clock(calm.end)} (probabilité maximale ${nf(calm.max_proba, 3)}).`;
    $$("button[data-k]", out).forEach(b => { b.disabled = false; b.addEventListener("click", async () => {
      stateLine($("#la-out"), "loading", `${ART[b.dataset.k]} : injection et analyse…`);
      try {
        const d = await postJSON("/api/lab/stress/artifact", { rid: "230102B-F", start: calm.start, kind: b.dataset.k });
        const fa = d.verdict === "Fausse alarme";
        const inSeg = arr => d[arr].t_start.map((s, i) => [s, d[arr].t_end[i], d[arr].proba[i]]).filter(([s, e]) => s < d.end && e > d.start).map(x => x[2]);
        $("#la-out").innerHTML = `<div class="lim-art"><div class="lab-verdict ${fa ? "is-bad" : "is-good"}"><p class="tool-label">Verdict</p><p class="lab-verdict-v">${fa ? "Fausse alarme" : "Pas d’alarme"}</p>
          <p class="lab-small">Probabilité maximale : ${mono(nf(Math.max(...inSeg("before")), 3))} avant, ${mono(nf(Math.max(...inSeg("after")), 3))} après.</p></div>
          <figure><figcaption class="tool-label">Avant</figcaption><canvas class="lim-ex" id="la-b"></canvas></figure><figure><figcaption class="tool-label">Après</figcaption><canvas class="lim-ex" id="la-a"></canvas></figure></div>`;
        const ex = v => { const data = {}; v.channels.forEach((c, k) => { data[c] = v.filtered.data[k]; }); return { start: d.start - 1, end: d.end + 1, t0: v.t0, dt: v.filtered.dt, mode: "raw", channels: v.channels, data }; };
        const eb = ex(d.view_before), lane = ($("#la-b").clientHeight - 30) / eb.channels.length, uv = (3 * robustUv(eb)) / (0.42 * lane);
        const bands = [{ start: d.start, end: d.end, fill: C["window-fill"] }];
        drawExcerpt($("#la-b"), eb, { uvPerPx: uv, bands, padLeft: 30, relative: true, clipLanes: 1.1 });
        drawExcerpt($("#la-a"), ex(d.view_after), { uvPerPx: uv, bands: bands.concat(d.events_in_segment.map(([s, e]) => ({ start: s, end: e, fill: "rgba(248,220,196,0.6)", hatch: true, edge: C["coral-edge"] }))), padLeft: 30, relative: true, clipLanes: 1.1 });
      } catch (e) { stateLine($("#la-out"), "error", "Analyse impossible", e.message); }
    }); });
  },
  /* d) le patient adulte */
  async adulte(out) {
    stateLine(out, "loading", "Calcul des probabilités du modèle « sans l’enregistrement »…");
    let d;
    try { d = await waitDone("/api/tools/adult", p => stateLine(out, "loading", progressText(p, "les probabilités sans chaque enregistrement"))); }
    catch (e) { stateLine(out, "error", "Démonstration indisponible", e.message); return; }
    const F = d.features, ag = d.cohort_ages, rank = ag.filter(a => a >= d.age).length;
    const missed = d.seizures.filter(s => s.result === "Manquée");
    out.innerHTML = `<div class="lab-card lim-card"><p class="body lab-body">${esc(d.rid)} : patiente de ${nf(d.age)} ans, ${rank === 1 ? "la plus âgée" : `parmi les ${rank} plus âgés`} de la cohorte (âges de ${nf(ag[0])} à ${nf(ag[ag.length - 1])} ans). ${plural(d.n_missed, "crise manquée", "crises manquées")} sur ${d.seizures.length}, évaluée${d.n_missed > 1 ? "s" : ""} par le modèle entraîné sans elle.</p>
      <div class="lim-adult">${missed.map(s => `<figure class="lim-sz"><figcaption class="h3">Crise ${s.n} · ${clock(s.start, 1)}–${clock(s.end, 1)} <span class="h3-note">probabilité max. ${nf(s.max_proba, 3)}</span></figcaption>
        <div class="lim-pc" data-n="${s.n}"></div><canvas class="lim-ex lim-ex-sm" data-n="${s.n}"></canvas><a class="pill-link" href="${lectureHref(d.rid)}?t=${Math.max(0, Math.floor(s.start - 5))}">Ouvrir dans Lecture</a></figure>`).join("")}</div>
      <table class="tbl lab-tbl lim-ftbl"><thead><tr><th>Pendant les crises</th><th class="num">${esc(d.rid)}</th><th class="num">Reste de la cohorte</th><th class="num">Rapport</th></tr></thead><tbody>
        ${[["Amplitude", "Amplitude (µV)", 0], ["RMS", "Valeur efficace (µV)", 1], ["Peak_Freq", "Fréquence du pic (Hz)", 2], ["Rel_Delta", "Part delta", 2]].map(([k, l, dd]) =>
          `<tr><td>${l}</td><td class="num">${nf(F[k].patient, dd)}</td><td class="num">${nf(F[k].cohort, dd)}</td><td class="num">× ${nf(F[k].ratio, 2)}</td></tr>`).join("")}
        <tr><td>Irrégularité : écart-type de la fréquence du pic (Hz)</td><td class="num">${nf(d.irregularity.patient, 2)}</td><td class="num">${nf(d.irregularity.cohort, 2)}</td><td class="num">× ${nf(d.irregularity.patient / d.irregularity.cohort, 2)}</td></tr></tbody></table>
      <p class="lab-small">Ses crises ont une amplitude ${F.Amplitude.ratio < 1 ? `${nf(1 / F.Amplitude.ratio, 1)} fois plus faible` : `${nf(F.Amplitude.ratio, 1)} fois plus forte`} que la moyenne des autres patients${d.irregularity.patient > d.irregularity.cohort ? ", et un rythme plus irrégulier" : ""} : or le modèle s’appuie d’abord sur l’amplitude. Avec un seul adulte dans la cohorte, il n’a jamais appris ce profil.</p></div>`;
    for (const s of missed) {
      const el = $(`.lim-pc[data-n="${s.n}"]`, out), W = Math.max(300, el.clientWidth || 420), H = 110, m = { l: 30, r: 8, t: 6, b: 20 };
      const a = s.t_start[0], b = s.t_end[s.t_end.length - 1], X = t => m.l + (t - a) / (b - a) * (W - m.l - m.r), Y = p => H - m.b - p * (H - m.t - m.b);
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg"><rect x="${X(s.start)}" y="${m.t}" width="${X(s.end) - X(s.start)}" height="${H - m.t - m.b}" class="lim-szband"/>` +
        `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0.5)}" y2="${Y(0.5)}" class="lab-thr"/><text x="${m.l - 4}" y="${Y(0.5) + 4}" class="lab-tick" text-anchor="end">0,5</text>` +
        `<path d="${s.t_start.map((t, i) => `${i ? "L" : "M"}${X((t + s.t_end[i]) / 2).toFixed(1)} ${Y(s.proba[i]).toFixed(1)}`).join("")}" class="lab-line"/>` +
        `<text x="${X(a)}" y="${H - 4}" class="lab-tick">${clock(a)}</text><text x="${X(b)}" y="${H - 4}" class="lab-tick" text-anchor="end">${clock(b)}</text></svg>`;
      api(`/api/recordings/${d.rid}/signal?start=${s.start - 3}&end=${s.end + 3}&channels=EEGFp1,EEGF3,EEGC3,EEGO1&width=900`).then(ex => {
        const cv = $(`canvas.lim-ex[data-n="${s.n}"]`, out);
        if (cv) drawExcerpt(cv, ex, { bands: [{ start: s.start, end: s.end, fill: C.sage, edge: C["sage-edge"] }], padLeft: 30, scaleBar: true });
      }).catch(() => {});
    }
  },
  /* e) seuil : mêmes probabilités et mêmes règles que l'onglet Réglages du Laboratoire */
  async seuil(out) {
    stateLine(out, "loading", "Chargement des probabilités par fenêtre…");
    let D;
    try { D = await waitDone("/api/lab/reglages?model=rf", p => stateLine(out, "loading", progressText(p, "les probabilités sans chaque enregistrement"))); }
    catch (e) { stateLine(out, "error", "Démonstration indisponible", e.message); return; }
    const base = { thr: D.defaults.threshold, smooth: D.defaults.smooth, gap: D.defaults.merge_gap_s, min: D.defaults.min_event_s };
    const curve = []; for (let k = 5; k <= 95; k += 5) curve.push({ thr: k / 100, ...Tune.evaluate(D, { ...base, thr: k / 100 }, false) });
    const proj = Tune.evaluate(D, base, false);
    out.innerHTML = `<div class="lab-card lim-card"><label class="lab-slider"><span class="tool-label">Seuil de décision</span><input type="range" id="ls-thr" min="0.05" max="0.95" step="0.05" value="0.5"><output id="ls-thr-v"></output></label>
      <div class="lim-res" id="ls-res"></div><div id="ls-chart"></div><p class="lab-small lab-dim">19 enregistrements, modèle « sans l’enregistrement », lissage, fusion et durée minimale du projet. Réglages plus fins : <a class="link" href="#/laboratoire/reglages">Laboratoire, réglages</a>.</p></div>`;
    const draw = () => {
      const thr = +$("#ls-thr").value, r = Tune.evaluate(D, { ...base, thr }, false);
      $("#ls-thr-v").textContent = nf(thr, 2);
      $("#ls-res").innerHTML = `<div><p class="tool-label">Crises détectées</p><p class="lim-v">${r.det}/${r.nTrue}</p></div><div><p class="tool-label">Fausses alarmes</p><p class="lim-v">${r.fa} <span class="lab-dim">· ${nf(r.faH, 2)} / h</span></p></div><div><p class="tool-label">Réglage du projet (0,5)</p><p class="lim-v">${proj.det}/${proj.nTrue} · ${proj.fa}</p></div>`;
      const el = $("#ls-chart"), W = Math.max(320, el.clientWidth || 600), H = 200, m = { l: 46, r: 16, t: 14, b: 34 };
      const xM = Math.max(...curve.map(q => q.faH)) * 1.05, yL = Math.floor(Math.min(...curve.map(q => q.sens)) * 10) / 10;
      const X = v => m.l + v / xM * (W - m.l - m.r), Y = v => H - m.b - (v - yL) / (1 - yL) * (H - m.t - m.b);
      let s = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg" role="img" aria-label="Crises détectées contre fausses alarmes par heure selon le seuil">`;
      for (let v = yL; v <= 1.0001; v += 0.1) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="lab-grid"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="lab-tick" text-anchor="end">${nf(100 * v, 0)} %</text>`;
      s += `<text x="${(W + m.l) / 2}" y="${H - 4}" class="lab-axis" text-anchor="middle">fausses alarmes par heure</text>`;
      s += `<path d="${curve.map((q, i) => `${i ? "L" : "M"}${X(q.faH)} ${Y(q.sens)}`).join("")}" class="lab-line"/>`;
      s += `<g class="lab-proj"><circle cx="${X(proj.faH)}" cy="${Y(proj.sens)}" r="7"/><text x="${X(proj.faH) + 10}" y="${Y(proj.sens) + 16}">réglage du projet</text></g>`;
      s += `<g class="lab-cur"><circle cx="${X(r.faH)}" cy="${Y(r.sens)}" r="6"/><text x="${X(r.faH) + 10}" y="${Y(r.sens) - 9}">seuil ${nf(thr, 2)}</text></g>`;
      el.innerHTML = s + "</svg>";
    };
    $("#ls-thr").addEventListener("input", draw); draw();
  },
};

/* ==========================================================================
   ANTICIPATION · part des crises annoncées par groupe d'âge
   ========================================================================== */
const AntAge = {
  async load() {
    const box = $("#ant-age"); if (!box || box.dataset.done) return;
    let d;
    try { d = await api("/api/tools/anticipation-age"); } catch (_) { return; }
    if (!d.available) return;
    box.dataset.done = "1";
    box.innerHTML = `<section class="ant-sec"><h2 class="h2">Selon l’âge</h2>
      <p class="body">Meilleur modèle d’anticipation : ${mono(esc(d.model))} (${esc(d.description)}), horizon ${mono(d.horizon_s + " s")}, ${mono(d.anticipated)} crises annoncées sur ${mono(d.reference)}. Répartition par groupe d’âge :</p>
      <table class="tbl lab-tbl ant-age"><thead><tr><th>Groupe d’âge</th><th class="num">Patients</th><th class="num">Crises de référence</th><th class="num">Annoncées</th><th class="num">Part</th></tr></thead><tbody>
      ${d.rows.map(r => `<tr><td>${esc(r.group)}</td><td class="num">${r.patients}</td><td class="num">${r.seizures}</td><td class="num">${r.anticipated}</td><td class="num">${r.share == null ? "—" : pct(r.share, 0)}</td></tr>`).join("")}</tbody></table>
      <p class="ant-banner" role="note">Tendance, pas preuve : le groupe des 12 ans et plus ne compte que ${d.rows[2].patients} patients et ${d.rows[2].seizures} crises de référence. Une ou deux crises de plus ou de moins changent complètement sa part.</p>
      <p class="tbl-foot">Calculé à partir de ${esc(d.source)} et de l’âge des annotations ; contrôle : ${d.check_total} crises annoncées retrouvées.</p></section>`;
  },
};
