/* ==========================================================================
   Absences — deux études du notebook sur le site :
     · page Découverte : autoencodeur entraîné sur l'EEG normal, candidats à relire, avis du médecin ;
     · Lecture : courbe d'anomalie sous le tracé, configuration d'électrodes (?voies=…) ;
     · Laboratoire · Électrodes : pannes de voies recalculées à la demande.
   ========================================================================== */
"use strict";

const LABELS_AE = { "décharge possible": "décharge possible", "artefact probable": "artefact probable", "anomalie autre": "anomalie autre" };
const VOTE_LIST = ["Crise probable", "Artefact", "Normal", "Incertain"];

/* ==========================================================================
   DÉCOUVERTE
   ========================================================================== */
const Decouverte = {
  D: null, thumbs: {}, filt: { label: "décharge possible", rid: "", sort: "score" }, shown: 24,
  async enter() {
    const body = $("#dec-body");
    if (!this.D) stateLine(body, "loading", "Chargement des résultats de l’autoencodeur…");
    try { this.D = await api("/api/decouverte"); }
    catch (e) { stateLine(body, "error", "Résultats indisponibles", `${capital(e.message)}. ${serverHint}`); return; }
    if (!this.D.available) {
      stateLine(body, "empty", "L’étude n’a pas encore été exécutée", "Exécutez la section « Des crises que personne n’a annotées ? » du notebook : elle écrit ses résultats dans resultats_local/autoencodeur/.");
      return;
    }
    this.render();
    this.loadThumbs();
  },
  render() {
    const D = this.D, R = D.resume, ids = [...new Set(D.candidats.map(c => c.Recording))].sort();
    const et = R.etiquettes || {};
    $("#dec-body").innerHTML = `
      <div class="dec-top">
        <figure class="lab-card dec-diagram">${aeDiagram()}<figcaption class="caption">L’autoencodeur apprend à reconstruire l’EEG normal. Ce qu’il reconstruit mal est inhabituel : l’erreur de reconstruction devient le score d’anomalie, sans aucune étiquette de crise.</figcaption></figure>
        <div class="kpis dec-kpis">
          <div class="kpi kpi-lav"><p class="kpi-v">${nf(R.auc, 3)}</p><p class="kpi-l">AUC sur les crises connues (IC95 ${nf(R.auc_ic95[0], 2)}–${nf(R.auc_ic95[1], 2)}) · Random Forest supervisé : ${nf(R.auc_rf, 3)}</p></div>
          <div class="kpi kpi-mint"><p class="kpi-v">${R.crises.autoencodeur}<span class="kpi-of">/${R.crises.n}</span></p><p class="kpi-l">crises connues au-dessus du seuil, sans en avoir jamais vu une</p></div>
          <div class="kpi kpi-rose"><p class="kpi-v">${et["décharge possible"] || 0}</p><p class="kpi-l">« décharges possibles » hors des crises annotées, sur ${R.candidats} événements anormaux</p></div>
          <div class="kpi kpi-peach"><p class="kpi-v">${R.fa_decharges}<span class="kpi-of">/${R.fausses_alarmes_rf}</span></p><p class="kpi-l">fausses alarmes du Random Forest qui ressemblent à une décharge (${R.fa_vues} signalées aussi par l’autoencodeur)</p></div>
        </div></div>
      ${R.faible ? `<p class="ant-banner" role="note">Le score reste trop proche du hasard sur les crises connues : les candidats ci-dessous ne sont pas interprétables comme des crises.</p>` : ""}
      ${R.reduit ? `<p class="ant-banner" role="note">Résultats d’une exécution réduite du notebook (mise au point) : relancez la section complète.</p>` : ""}
      <details class="r-details dec-figs"><summary><span class="r-details-btn">Figures du notebook</span><span class="r-details-t">courbes ROC, répartition des scores, galerie des candidats</span></summary>
        <div class="dec-figgrid">${D.figures.map(f => `<a href="/api/decouverte/figure/${f}" target="_blank" rel="noopener"><img src="/api/decouverte/figure/${f}" alt="${esc(f.replace(/_/g, " ").replace(".png", ""))}" loading="lazy"></a>`).join("")}</div></details>
      <section class="dec-sec"><h2 class="h2">Candidats à relire</h2>
        <div class="filters lab-controls" role="group" aria-label="Filtres des candidats">
          <label class="field"><span class="tool-label">Étiquette</span><select id="dec-label"><option value="">toutes</option>${Object.keys(LABELS_AE).map(l => `<option value="${l}" ${l === this.filt.label ? "selected" : ""}>${l} (${et[l] || 0})</option>`).join("")}<option value="fa">fausses alarmes du RF</option></select></label>
          <label class="field"><span class="tool-label">Enregistrement</span><select id="dec-rid"><option value="">tous</option>${ids.map(r => `<option>${r}</option>`).join("")}</select></label>
          <label class="field"><span class="tool-label">Tri</span><select id="dec-sort"><option value="score">score combiné</option><option value="anomalie">anomalie</option><option value="temps">enregistrement, temps</option></select></label>
          <span class="filters-end mono" id="dec-count"></span></div>
        <div class="dec-votes" id="dec-votes"></div>
        ${jobBox("dec-thumb-job")}
        <div class="dec-list" id="dec-list"></div>
        <div class="lab-row dec-more"><button type="button" class="btn btn-quiet" id="dec-more" hidden>Afficher plus</button></div></section>`;
    $("#dec-label").addEventListener("change", e => { this.filt.label = e.target.value; this.shown = 24; this.list(); });
    $("#dec-rid").addEventListener("change", e => { this.filt.rid = e.target.value; this.shown = 24; this.list(); });
    $("#dec-sort").addEventListener("change", e => { this.filt.sort = e.target.value; this.list(); });
    $("#dec-more").addEventListener("click", () => { this.shown += 24; this.list(); });
    $("#dec-list").addEventListener("click", e => this.onClick(e));
    onResize($("#dec-list"), () => this.drawThumbs());
    this.list(); this.votes();
  },
  items() {
    const D = this.D, F = this.filt;
    let L;
    if (F.label === "fa") {
      L = D.fausses_alarmes.map(f => ({ ...f, id: f.candidat_id || `${f.Recording}@${f.debut}`, fa: true }));
    } else {
      const faIds = new Set(D.fausses_alarmes.map(f => f.candidat_id).filter(Boolean));
      L = D.candidats.filter(c => !F.label || c.etiquette === F.label).map(c => ({ ...c, fa: faIds.has(c.id) }));
    }
    if (F.rid) L = L.filter(c => c.Recording === F.rid);
    const key = { score: c => -(c.score_combine || 0), anomalie: c => -(c.score_rel || 0), temps: c => 0 }[F.sort];
    return L.sort((a, b) => key(a) - key(b) || a.Recording.localeCompare(b.Recording) || a.debut - b.debut);
  },
  list() {
    const L = this.items(), V = this.D.votes.latest;
    $("#dec-count").textContent = plural(L.length, "événement", "événements");
    $("#dec-list").innerHTML = L.slice(0, this.shown).map(c => `
      <article class="dec-item" data-label="${esc(c.etiquette)}" data-id="${esc(c.id)}">
        <a class="dec-fig" href="${lectureHref(c.Recording, Math.max(0, c.debut - 3))}" aria-label="Ouvrir ${esc(c.Recording)} à ${clock(c.debut)} dans Lecture"><canvas class="dec-thumb" data-id="${esc(c.id)}"></canvas></a>
        <div class="dec-txt"><p class="dec-head"><a class="mono rid-link" href="${lectureHref(c.Recording, Math.max(0, c.debut - 3))}">${esc(c.Recording)}</a> · ${clock(c.debut, 1)}–${clock(c.fin, 1)} <span class="dec-tag dec-tag-${c.etiquette === "décharge possible" ? "d" : c.etiquette === "artefact probable" ? "a" : "o"}">${esc(c.etiquette)}</span>${c.fa ? `<span class="dec-tag dec-tag-fa">fausse alarme du RF</span>` : ""}${c.vue_autoencodeur === false ? `<span class="dec-tag">non signalée par l’autoencodeur</span>` : ""}</p>
          <p class="dec-facts">anomalie ${mono(`× ${nf(c.score_rel, 1)}`)} le seuil · fréquence ${mono(nf(c.freq_dominante, 2) + " Hz")} · 2,5–4 Hz ${mono(pct(c.part_2_5_4_hz, 0))} · voies ${mono(pct(c.part_voies, 0))} · RF ${c.proba_rf_max == null ? "—" : mono(nf(c.proba_rf_max, 2))}${c.notes_journal ? ` · journal : « ${esc(c.notes_journal)} »` : ""}</p>
          <div class="dec-vote" role="group" aria-label="Avis sur cet événement">${VOTE_LIST.map(v => `<button type="button" data-vote="${v}" aria-pressed="${V[c.id] === v}">${v}</button>`).join("")}</div></div>
      </article>`).join("") || `<p class="body">Aucun événement pour ces filtres.</p>`;
    $("#dec-more").hidden = L.length <= this.shown;
    this.drawThumbs();
  },
  votes() {
    const S = this.D.votes;
    $("#dec-votes").innerHTML = `<span class="tool-label">Avis enregistrés</span> ${VOTE_LIST.map(v => `<span class="dec-vc"><b>${S.counts[v] || 0}</b> ${v.toLowerCase()}</span>`).join("")}<span class="lab-dim lab-small">${S.n_candidates_reviewed} événements relus · fichier <span class="mono">resultats_local/autoencodeur/avis_medecin.csv</span></span>`;
  },
  async onClick(e) {
    const b = e.target.closest("[data-vote]"); if (!b) return;
    const id = b.closest(".dec-item").dataset.id;
    try {
      this.D.votes = await postJSON("/api/decouverte/vote", { id, avis: b.dataset.vote });
      $$(`.dec-item[data-id="${CSS.escape(id)}"] [data-vote]`).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      this.votes();
    } catch (err) { b.title = err.message; }
  },
  async loadThumbs() {
    try { const r = await Jobs.run("dec_thumbs", { key: this.D.thumbs_key }, $("#dec-thumb-job")); this.thumbs = r.thumbs; $("#dec-thumb-job").hidden = true; this.drawThumbs(); }
    catch (_) { /* la liste reste lisible sans miniatures */ }
  },
  drawThumbs() {
    $$(".dec-thumb").forEach(cv => {
      const T = this.thumbs[cv.dataset.id]; if (!T) return;
      const c = this.D.candidats.find(x => x.id === cv.dataset.id) || this.D.fausses_alarmes.find(x => x.candidat_id === cv.dataset.id);
      const data = {}; T.channels.forEach((ch, j) => { data[ch] = T.mode === "raw" ? T.data[j] : { min: T.min[j], max: T.max[j] }; });
      drawExcerpt(cv, { start: T.t0, end: T.t1, t0: T.t0, dt: T.dt, mode: T.mode, channels: T.channels, data },
        { bands: c ? [{ start: c.debut, end: c.fin, fill: "rgba(163, 62, 97, 0.12)", edge: "#A33E61" }] : [], labelOf: x => x, padLeft: 28, axis: false, lineWidth: 0.8 });
    });
  },
};

function aeDiagram() {
  const box = (x, w, h, cls, t1, t2) => `<rect x="${x}" y="${70 - h / 2}" width="${w}" height="${h}" rx="8" class="${cls}"/><text x="${x + w / 2}" y="${70 + h / 2 + 16}" class="dg-t" text-anchor="middle">${t1}</text>${t2 ? `<text x="${x + w / 2}" y="${70 + h / 2 + 30}" class="dg-s" text-anchor="middle">${t2}</text>` : ""}`;
  const wave = (x, y, amp, cls) => { let d = ""; for (let i = 0; i <= 60; i++) d += `${i ? "L" : "M"}${x + i} ${(y + Math.sin(i / 4.5) * amp + Math.sin(i / 1.7) * amp * 0.25).toFixed(1)}`; return `<path d="${d}" class="${cls}"/>`; };
  const arrow = (x1, x2) => `<line x1="${x1}" x2="${x2 - 6}" y1="70" y2="70" class="dg-a"/><path d="M${x2 - 8} 65 L${x2} 70 L${x2 - 8} 75 Z" class="dg-ah"/>`;
  return `<svg viewBox="0 0 760 150" role="img" aria-label="Schéma : EEG normal, encodeur, goulot, décodeur, reconstruction ; l’écart est le score d’anomalie">
    ${box(10, 90, 70, "dg-in", "EEG normal", "19 voies × 2 s")}${wave(25, 62, 10, "dg-w")}${wave(25, 80, 7, "dg-w")}
    ${arrow(104, 136)}<path d="M140 32 L230 52 L230 88 L140 108 Z" class="dg-enc"/><text x="185" y="124" class="dg-t" text-anchor="middle">encodeur</text>
    ${arrow(232, 262)}${box(264, 44, 32, "dg-bot", "goulot", "8 × 32")}
    ${arrow(310, 338)}<path d="M340 52 L430 32 L430 108 L340 88 Z" class="dg-dec"/><text x="385" y="124" class="dg-t" text-anchor="middle">décodeur</text>
    ${arrow(432, 462)}${box(464, 90, 70, "dg-in", "reconstruction")}${wave(479, 62, 10, "dg-w")}${wave(479, 80, 7, "dg-w")}
    ${arrow(558, 590)}${box(592, 156, 70, "dg-err", "erreur = anomalie", "mal reconstruit → inhabituel")}<text x="670" y="76" class="dg-big" text-anchor="middle">‖ x − x̂ ‖²</text></svg>`;
}

/* ==========================================================================
   LECTURE : courbe d'anomalie sous le tracé
   ========================================================================== */
const Anom = {
  on: false, data: {}, rid: null,
  async toggle(on) {
    this.on = on;
    $("#anom-wrap").hidden = !on;
    $("#layer-anom").setAttribute("aria-pressed", String(on));
    if (on) await this.load(S.rid);
    this.draw();
  },
  async load(rid) {
    if (!rid || this.data[rid]) return;
    try { this.data[rid] = await api(`/api/decouverte/scores?rid=${encodeURIComponent(rid)}`); }
    catch (_) { this.data[rid] = { available: false }; }
  },
  draw() {
    if (!this.on) return;
    const cv = $("#anom-canvas"); if (!cv || !S.meta) return;
    const d = this.data[S.rid];
    if (!d) { this.load(S.rid).then(() => this.draw()); return; }
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const x0 = GEOM.left, x1 = w - GEOM.right, y0 = 8, y1 = h - 16, pw = x1 - x0;
    const t2x = t => x0 + (t - S.start) / S.win * pw;
    ctx.font = `500 9.5px ${C.sans}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText("ANOMALIE", x0 - 10, (y0 + y1) / 2);
    if (!d.available) { ctx.textAlign = "left"; ctx.fillText("Pas de score d’anomalie pour cet enregistrement (section autoencodeur du notebook).", x0 + 8, (y0 + y1) / 2); return; }
    const tEnd = S.start + S.win;
    const vis = []; for (let i = 0; i < d.t.length; i++) if (d.t[i] >= S.start - 1 && d.t[i] <= tEnd + 1) vis.push(i);
    const top = Math.max(d.threshold * 2.5, ...vis.map(i => d.score[i]));
    const Y = v => y1 - Math.min(1, v / top) * (y1 - y0);
    for (const c of d.candidates) {
      const a = Math.max(x0, t2x(c.start)), b = Math.min(x1, t2x(c.end)); if (b <= a) continue;
      ctx.fillStyle = c.label === "décharge possible" ? "rgba(163, 62, 97, 0.18)" : "rgba(74, 103, 140, 0.12)"; ctx.fillRect(a, y0, b - a, y1 - y0);
    }
    ctx.strokeStyle = C["coral-edge"]; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x0, crisp(Y(d.threshold))); ctx.lineTo(x1, crisp(Y(d.threshold))); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C["coral-ink"]; ctx.textAlign = "left"; ctx.font = `10px ${C.mono}`; ctx.fillText("seuil", x1 + 6, Y(d.threshold));
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, pw, y1 - y0 + 4); ctx.clip();
    ctx.strokeStyle = "#A33E61"; ctx.lineWidth = 1.6; ctx.beginPath();
    vis.forEach((i, k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, t2x(d.t[i]), Y(d.score[i])));
    ctx.stroke(); ctx.restore();
    ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(x0, crisp(y1)); ctx.lineTo(x1, crisp(y1)); ctx.stroke();
    ctx.fillStyle = C["ink-3"]; ctx.textAlign = "left"; ctx.font = `10px ${C.sans}`;
    ctx.fillText("en rose : « décharge possible » ; en bleu : autre événement anormal", x0, h - 6);
  },
};

/* ==========================================================================
   LECTURE : configuration d'électrodes venue du Laboratoire (?voies=Fp1:retiree,T3:bruit)
   ========================================================================== */
const Voies = {
  map: {},
  parse(q) {
    this.map = {};
    for (const part of (q.get("voies") || "").split(",").filter(Boolean)) {
      const [e, kind] = part.split(":");
      if (e && kind) this.map["EEG" + e] = kind;
    }
    const el = $("#voies-banner"); if (!el) return;
    const keys = Object.keys(this.map);
    el.hidden = !keys.length;
    if (keys.length) {
      const desc = keys.map(c => `${label(c)} ${this.map[c] === "retiree" ? "retirée" : `corrompue (${esc(this.map[c])})`}`).join(", ");
      el.innerHTML = `Configuration d’électrodes du Laboratoire : ${desc}. <a class="link" href="#/lecture/${encodeURIComponent(S.rid || "")}">revenir au tracé intact</a>`;
    }
  },
  query() { return Object.entries(this.map).map(([c, k]) => `${label(c)}:${k}`).join(","); },
  corruptParam(chans) { return Object.entries(this.map).filter(([c, k]) => k !== "retiree" && chans.includes(c)).map(([c, k]) => `${label(c)}:${k}`).join(","); },
  state(ch) { return this.map[ch] || null; },
};

/* ==========================================================================
   LABORATOIRE · Électrodes
   ========================================================================== */
const Elec = {
  cfg: null, state: {}, kind: "deconnexion", ref: "originale", robust: false, last: null,
  async init() {
    const box = $("#el-body");
    try { this.cfg = await api("/api/electrodes/config"); }
    catch (e) { stateLine(box, "error", "Onglet indisponible", e.message); return; }
    const C_ = this.cfg;
    C_.electrodes.forEach(e => { this.state[e] = "ok"; });
    box.innerHTML = `
      <div class="el-grid">
        <div class="lab-card el-headcard"><svg id="el-head" viewBox="-1.25 -1.3 2.5 2.55" role="group" aria-label="Électrodes du système 10-20 : cliquer pour retirer puis corrompre"></svg>
          <p class="lab-legend"><span><i class="el-k el-ok"></i>intacte</span><span><i class="el-k el-off"></i>retirée</span><span><i class="el-k el-bad"></i>corrompue</span></p>
          <p class="lab-small lab-dim">Un clic : intacte → retirée → corrompue → intacte.</p></div>
        <div class="el-side">
          <div class="lab-card el-controls">
            <label class="field"><span class="tool-label">Type de panne</span><select id="el-kind">${Object.entries(C_.corruptions).map(([k, l]) => `<option value="${k}" ${k === this.kind ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
            <div class="field lab-field-col"><span class="tool-label">Retirer une région</span><span class="el-regions">${Object.keys(C_.regions).map(g => `<button type="button" class="pill-link" data-region="${g}">${g}</button>`).join("")}<button type="button" class="pill-link" data-region="">tout rétablir</button></span></div>
            <label class="field"><span class="tool-label">Référence</span><select id="el-ref">${Object.entries(C_.references).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
            <label class="field check"><input type="checkbox" id="el-robust"> variante robuste (médiane des voies)</label>
            <label class="field check"><input type="checkbox" id="el-aug"> modèle augmenté (dernier entraînement de l’onglet Augmentation)</label>
            <div class="field lab-field-col"><span class="tool-label">Scénarios de démonstration</span><span class="el-presets">${Object.entries(C_.presets).map(([k, p]) => `<button type="button" class="pill-link" data-preset="${k}">${esc(p.label)}</button>`).join("")}</span></div>
            <div class="lab-row"><button type="button" class="btn" id="el-run">Lancer</button><span class="lab-small lab-dim" id="el-sum"></span></div>
            ${jobBox("el-job")}</div>
          <div id="el-out"></div></div></div>
      ${C_.study ? `<p class="lab-small lab-dim el-study">Étude complète du notebook (${C_.study.n_scenarios} scénarios) : électrode la plus critique en retrait ${esc(C_.study.electrode_retrait_critique)}, pire panne « ${esc(C_.corruptions[C_.study.pire_panne.type] || C_.study.pire_panne.type)} » sur ${esc(C_.study.pire_panne.electrode)}. Figures dans <span class="mono">resultats_local/electrodes/figures/</span>.</p>` : ""}`;
    $("#el-kind").addEventListener("change", e => { this.kind = e.target.value; for (const k in this.state) if (this.state[k] !== "ok" && this.state[k] !== "off") this.state[k] = this.kind; this.head(); });
    $("#el-ref").addEventListener("change", e => { this.ref = e.target.value; this.head(); });
    $("#el-robust").addEventListener("change", e => { this.robust = e.target.checked; if (e.target.checked) { this.aug = false; $("#el-aug").checked = false; } this.head(); });
    $("#el-aug").addEventListener("change", e => { this.aug = e.target.checked; if (e.target.checked) { this.robust = false; $("#el-robust").checked = false; } this.head(); });
    $(".el-regions").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      if (!b.dataset.region) { for (const k in this.state) this.state[k] = "ok"; }
      else for (const el of C_.regions[b.dataset.region]) this.state[el] = "off";
      this.head();
    });
    $(".el-presets").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      const p = C_.presets[b.dataset.preset];
      for (const k in this.state) this.state[k] = "ok";
      (p.removed || []).forEach(x => { this.state[x] = "off"; });
      Object.entries(p.corrupt || {}).forEach(([x, k]) => { this.state[x] = k; this.kind = k; $("#el-kind").value = k; });
      this.ref = p.ref || "originale"; $("#el-ref").value = this.ref;
      this.head(); this.run();
    });
    $("#el-run").addEventListener("click", () => this.run());
    this.head();
  },
  scenario() {
    const removed = [], corrupt = {};
    for (const [e, s] of Object.entries(this.state)) { if (s === "off") removed.push(e); else if (s !== "ok") corrupt[e] = s; }
    return { removed, corrupt, ref: this.ref, robust: this.robust, augment: !!this.aug };
  },
  head() {
    const C_ = this.cfg, svg = $("#el-head");
    let s = `<circle cx="0" cy="0" r="1.08" class="el-skull"/><path d="M-0.13 -1.07 L0 -1.22 L0.13 -1.07" class="el-skull"/>` +
      `<path d="M-1.08 -0.15 Q-1.2 0 -1.08 0.15" class="el-skull"/><path d="M1.08 -0.15 Q1.2 0 1.08 0.15" class="el-skull"/>`;
    for (const e of C_.electrodes) {
      const [x, y] = C_.positions[e], st = this.state[e], cls = st === "ok" ? "el-ok" : st === "off" ? "el-off" : "el-bad";
      const isRef = this.ref === "cz" && e === "Cz";
      s += `<g class="el-e ${cls}${isRef ? " el-ref" : ""}" data-e="${e}" tabindex="0" role="button" aria-label="${e} : ${st === "ok" ? "intacte" : st === "off" ? "retirée" : `corrompue (${C_.corruptions[st]})`}">` +
        `<circle cx="${x}" cy="${-y}" r="0.13"/><text x="${x}" y="${-y + 0.035}" text-anchor="middle">${e}</text>${st !== "ok" && st !== "off" ? `<text x="${x}" y="${-y + 0.22}" text-anchor="middle" class="el-kt">${st}</text>` : ""}</g>`;
    }
    svg.innerHTML = s;
    $$(".el-e", svg).forEach(g => {
      const cycle = () => { const e = g.dataset.e, st = this.state[e]; this.state[e] = st === "ok" ? "off" : st === "off" ? this.kind : "ok"; this.head(); };
      g.addEventListener("click", cycle);
      g.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); cycle(); } });
    });
    const sc = this.scenario();
    $("#el-sum").textContent = `${sc.removed.length} retirée${sc.removed.length > 1 ? "s" : ""}, ${Object.keys(sc.corrupt).length} corrompue${Object.keys(sc.corrupt).length > 1 ? "s" : ""}, référence ${{ originale: "d’origine", moyenne: "moyenne commune", cz: "Cz" }[sc.ref]}${sc.robust ? ", variante médiane" : ""}${sc.augment ? ", modèle augmenté" : ""}`;
  },
  async run() {
    const btn = $("#el-run"); btn.disabled = true;
    try { this.last = await Jobs.run("electrodes", this.scenario(), $("#el-job")); this.render(); }
    catch (e) { if (e.name !== "Cancelled") stateLine($("#el-out"), "error", "Calcul impossible", e.message); }
    finally { btn.disabled = false; }
  },
  render() {
    const R = this.last, r = R.result, b = R.project, sc = R.scenario;
    const tile = (cls, v, l, d, higher, fmt) => {
      const good = d == null || Math.abs(d) < 1e-9 ? "" : (d > 0) === higher ? "is-better" : "is-worse";
      return `<div class="kpi ${cls}"><p class="kpi-v">${v}</p><p class="kpi-l">${l}<br><span class="${good}">${d == null ? "" : Math.abs(d) < 1e-9 ? "= intact" : `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} vs intact`}</span></p></div>`;
    };
    const voies = Object.entries(this.state).filter(([, s]) => s !== "ok").map(([e, s]) => `${e}:${s === "off" ? "retiree" : s}`).join(",");
    $("#el-out").innerHTML = `<div class="kpis lab-kpis el-kpis">
        ${tile("kpi-mint", `${r.detected}<span class="kpi-of">/${r.n_true}</span>`, "crises détectées", r.detected - b.detected, true, v => nf(v))}
        ${tile("kpi-peach", nf(r.fa_per_hour, 2), `fausses alarmes / h (${r.false_alarms})`, r.fa_per_hour - b.fa_per_hour, false, v => nf(v, 2))}
        ${tile("kpi-lav", r.mean_delay == null ? "—" : fmtS(r.mean_delay), "retard moyen au début", r.mean_delay == null || b.mean_delay == null ? null : r.mean_delay - b.mean_delay, false, v => `${nf(v, 2)} s`)}
        ${tile("kpi-blue", pct(r.stability, 0), "stabilité : détections d’origine retrouvées", r.stability - 1, true, v => pct(v, 0))}</div>
      <p class="lab-small lab-dim">Intact (projet) : ${b.detected}/${b.n_true} crises, ${b.false_alarms} fausses alarmes (${nf(b.fa_per_hour, 2)} / h)${sc.robust || sc.augment ? ` · ${sc.augment ? "modèle augmenté" : "variante médiane"} sans panne : ${R.intact.detected}/${R.intact.n_true}, ${R.intact.false_alarms} fausses alarmes` : ""} · F1 par fenêtre ${nf(r.f1, 3)} · calculé en ${nf(R.elapsed_s, 1)} s.</p>
      <h3 class="h3">Enregistrements les plus touchés <span class="h3-note">cliquer pour voir le tracé avec cette configuration</span></h3>
      <table class="tbl lab-tbl"><thead><tr><th>Enregistrement</th><th class="num">Crises</th><th class="num">Détectées</th><th class="num">Fausses alarmes</th><th class="num">Stabilité</th></tr></thead><tbody>
      ${R.recordings.slice(0, 6).map(x => `<tr class="clickable" data-href="#/lecture/${encodeURIComponent(x.id)}${voies ? `?voies=${voies}` : ""}"><td><a class="mono rid-link" href="#/lecture/${encodeURIComponent(x.id)}${voies ? `?voies=${voies}` : ""}">${esc(x.id)}</a></td>` +
        `<td class="num">${x.n_true}</td><td class="num ${x.detected < x.detected_intact ? "is-worse" : ""}">${x.detected}<span class="lab-was"> (${x.detected_intact})</span></td>` +
        `<td class="num ${x.false_alarms > x.false_alarms_intact ? "is-worse" : x.false_alarms < x.false_alarms_intact ? "is-better" : ""}">${x.false_alarms}<span class="lab-was"> (${x.false_alarms_intact})</span></td><td class="num">${pct(x.stability, 0)}</td></tr>`).join("")}</tbody></table>
      <p class="tbl-foot">Entre parenthèses : sans panne${sc.augment ? " (modèle augmenté)" : sc.robust ? " (variante médiane)" : ""}. Les modèles sont les Random Forest « sans l’enregistrement » du projet, entraînés sur des données intactes : la panne survient au moment du test.</p>`;
    $$("#el-out tr.clickable").forEach(tr => tr.addEventListener("click", e => { if (!e.target.closest("a")) go(tr.dataset.href); }));
  },
};

document.addEventListener("DOMContentLoaded", () => {
  const b = $("#layer-anom");
  if (b) b.addEventListener("click", () => Anom.toggle(!Anom.on));
  onResize($("#anom-wrap"), () => Anom.draw());
});
