/* ==========================================================================
   Absences — pages de résultats : Patients, Erreurs, Modèles
   Les résultats par enregistrement viennent de /api/cohort : la même détection
   que l'écran Lecture, avec pour chaque tracé un modèle qui ne l'a jamais vu.
   ========================================================================== */
"use strict";

const Cohort = {
  data: null,
  async get(onProgress, isActive) {
    if (!this.data) this.data = await waitDone("/api/cohort", onProgress, isActive);
    return this.data;
  },
};
const sexLabel = s => (s === "F" ? "F" : s === "M" ? "M" : "—");

// ==========================================================================
// 5. Patients
// ==========================================================================
const PAT_COLS = [
  { k: "id", l: "Enregistrement", num: false },
  { k: "sex", l: "Sexe", num: false },
  { k: "age", l: "Âge", num: true },
  { k: "duration", l: "Durée", num: true },
  { k: "n_true", l: "Crises", num: true },
  { k: "mean_seizure_s", l: "Durée moy.", num: true },
  { k: "detected", l: "Détectées", num: true },
  { k: "missed", l: "Manquées", num: true },
  { k: "false_alarms", l: "Fausses alarmes", num: true },
];

const Patients = {
  sort: { k: "id", dir: 1 },
  async enter(r) {
    const body = $("#pat-body");
    const sk = r.q.get("tri");
    if (sk && PAT_COLS.find(c => c.k === sk)) this.sort = { k: sk, dir: r.q.get("ordre") === "desc" ? -1 : 1 };
    if (!Cohort.data) stateLine(body, "loading", "Chargement de la cohorte…");
    let D;
    try {
      D = await Cohort.get(d => stateLine(body, "loading", progressText(d),
        "Premier lancement : chaque enregistrement est analysé par un modèle ré-entraîné sans lui. Le résultat est ensuite gardé en cache."), isPage("patients"));
    } catch (e) { if (e.name !== "AbortError") stateLine(body, "error", "Cohorte indisponible", `${capital(e.message)}. ${serverHint}`); return; }
    this.render(D);
    PatTools.enter(D).then(() => this.render(D));     // outils de la cohorte (carte, K-means, filtres, relance)
  },
  rows(D) {
    return D.recordings.map(r => ({
      ...r, n_true: r.totals ? r.totals.n_true : null, detected: r.totals ? r.totals.detected : null,
      missed: r.totals ? r.totals.missed : null, false_alarms: r.totals ? r.totals.false_alarms : null,
    }));
  },
  facts(D) {
    const ann = D.recordings.filter(r => r.annotated);
    const ages = ann.map(r => r.age).filter(a => a != null);
    const sx = s => ann.filter(r => r.sex === s).length;
    const durs = ann.flatMap(r => r.truth.map(([a, b]) => b - a));
    const most = [...ann].sort((a, b) => b.truth.length - a.truth.length)[0];
    const E = D.evaluation.events;
    const out = [];
    if (ages.length) out.push(`${mono(ann.length)} enregistrements annotés, chez des patients de ${mono(nf(Math.min(...ages)))} à ${mono(nf(Math.max(...ages)))} ans (âge médian ${mono(nf(median(ages)))} ans) : ${mono(sx("F"))} de sexe féminin, ${mono(sx("M"))} de sexe masculin.`);
    if (durs.length) out.push(`Ils comptent ${mono(durs.length)} crises annotées, de ${mono(nf(Math.min(...durs)))} à ${mono(nf(Math.max(...durs)))} s (durée médiane ${mono(nf(median(durs), 1))} s) ; ${esc(most.id)} en a le plus, ${mono(most.truth.length)}.`);
    out.push(`Analysés chacun par un modèle qui ne les a jamais vus, ${mono(E.zero_fa)} enregistrements sur ${mono(ann.length)} n’ont aucune fausse alarme` +
      (E.with_missed.length ? ` et ${E.with_missed.length === 1 ? "un seul a" : `${mono(E.with_missed.length)} ont`} des crises manquées (${E.with_missed.map(esc).join(", ")}).` : ", et aucune crise n’est manquée."));
    return out.map(t => `<p>${t}</p>`).join("");
  },
  render(D) {
    $("#pat-facts").innerHTML = this.facts(D);
    const rows = this.rows(D);
    const maxDur = Math.max(...rows.map(r => r.duration));
    // filtres des outils de la cohorte (tous les enregistrements tant que la carte n'est pas chargée)
    const T = PatTools.ready && PatTools.map ? PatTools : null;
    const ann = rows.filter(r => r.annotated && (!T || T.keep(r))), other = rows.filter(r => !r.annotated && (!T || T.keep(r)));
    const { k, dir } = this.sort;
    ann.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir || a.id.localeCompare(b.id);
    });
    const th = PAT_COLS.map(c => {
      const on = c.k === k;
      return `<th class="${c.num ? "num" : ""}" aria-sort="${on ? (dir > 0 ? "ascending" : "descending") : "none"}">` +
        `<button type="button" class="sort" data-k="${c.k}">${c.l}<span class="sort-mark" aria-hidden="true">${on ? (dir > 0 ? "↑" : "↓") : ""}</span></button></th>`;
    }).join("") + `<th class="tl-head">Chronologie <span class="h3-note">même échelle pour tous</span></th>`;
    const thSel = `<th class="pt-selh"><span class="visually-hidden">Sélection</span></th>`;
    const nn = r => (r.annotated ? `<td class="pt-nncell"><button type="button" class="link-btn pt-nnb" data-id="${esc(r.id)}" title="Les 3 patients les plus proches">proches</button></td>` : "<td></td>");
    // relance : nouvelle valeur surlignée, valeur du projet entre parenthèses
    const rr = (r, k, cls = "") => {
      const n = T && T.rerun[r.id];
      if (!n || n[k] === r[k]) return `<td class="num ${cls}">${r[k]}</td>`;
      return `<td class="num pt-changed" title="valeur du projet : ${r[k]}">${n[k]}<span class="lab-was"> (${r[k]})</span></td>`;
    };
    const dot = r => (T && T.km && T.km.labels[r.id] != null ? `<i class="pt-dot" style="background:${CAT[T.km.labels[r.id] % CAT.length]}" title="groupe K-means ${T.km.labels[r.id] + 1}"></i>` : "");
    const line = (r, unann) => {
      const c = v => (v == null ? '<td class="num dim">—</td>' : `<td class="num">${v}</td>`);
      return `<tr class="clickable${T && T.hi && T.hi.includes(r.id) ? " is-current" : ""}" tabindex="0" data-id="${esc(r.id)}">` +
        (T ? `<td class="pt-sel">${unann ? "" : `<input type="checkbox" data-id="${esc(r.id)}" aria-label="Sélectionner ${esc(r.id)}" ${T.selected.has(r.id) ? "checked" : ""}>`}</td>` : "") +
        `<td>${dot(r)}<a class="mono rid-link" href="${lectureHref(r.id)}">${esc(r.id)}</a>${r.type_abs ? ` <span class="tag">${esc(r.type_abs)}</span>` : ""}${r.n_channels < 19 && unann ? ` <span class="tag">${r.n_channels} voies</span>` : ""}</td>` +
        `<td>${sexLabel(r.sex)}</td>` + c(r.age != null ? nf(r.age) : null) + c(clock(r.duration)) +
        (unann
          ? `<td class="num dim" colspan="2">non annoté</td><td class="num dim" title="Intervalles proposés par le modèle complet, sans vérité terrain">${r.n_detections}*</td><td class="num dim">—</td><td class="num dim">—</td>`
          : c(r.n_true) + c(r.mean_seizure_s != null ? nf(r.mean_seizure_s, 1) + " s" : null) + rr(r, "detected") +
            rr(r, "missed", r.missed ? "miss" : "zero") + rr(r, "false_alarms", r.false_alarms ? "" : "zero")) +
        `<td class="tl-cell">${miniTimeline(r, maxDur)}</td>${T ? nn(r) : ""}</tr>`;
    };
    $("#pat-body").innerHTML = `
      <table class="tbl tbl-cohort" id="pat-table">
        <thead><tr>${T ? thSel : ""}${th}${T ? "<th></th>" : ""}</tr></thead>
        <tbody>${ann.map(r => line(r, false)).join("")}</tbody>
        ${other.length ? `<tbody class="grp-other"><tr class="grp"><td colspan="${PAT_COLS.length + 1 + (T ? 2 : 0)}">Non annotés</td></tr>${other.map(r => line(r, true)).join("")}</tbody>` : ""}
      </table>
      <p class="tbl-foot">Chronologie : <span class="sw sw-annot"></span> crises annotées (en haut) · <span class="sw sw-det"></span> intervalles détectés (en bas). ` +
      `${other.length ? "* Pour les tracés non annotés, nombre d’intervalles proposés par le modèle complet ; sans annotation, impossible de dire s’il s’agit de vraies crises. " : ""}` +
      `Cliquer une ligne ouvre l’enregistrement.</p>`;
    $$("#pat-table .sort").forEach(b => b.addEventListener("click", () => {
      this.sort = b.dataset.k === this.sort.k ? { k: b.dataset.k, dir: -this.sort.dir } : { k: b.dataset.k, dir: 1 };
      replaceHash(`#/patients?tri=${this.sort.k}${this.sort.dir < 0 ? "&ordre=desc" : ""}`);
      this.render(D);
      const nb = $(`#pat-table .sort[data-k="${this.sort.k}"]`); if (nb) nb.focus();
    }));
    $$("#pat-table tbody tr.clickable").forEach(tr => {
      const goRow = e => { if (e.target.closest("a, input, button, .pt-sel")) return; go(lectureHref(tr.dataset.id)); };
      tr.addEventListener("click", goRow);
      tr.addEventListener("keydown", e => { if (e.target !== tr) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(lectureHref(tr.dataset.id)); } });
    });
    if (T) {
      $$("#pat-table .pt-sel input").forEach(i => i.addEventListener("change", () => {
        if (i.checked) T.selected.add(i.dataset.id); else T.selected.delete(i.dataset.id);
        $("#pt-rr-n").textContent = `${T.selected.size} coché${T.selected.size > 1 ? "s" : ""}`;
      }));
      $$("#pat-table .pt-nnb").forEach(b => b.addEventListener("click", () => T.nearest(b.dataset.id)));
    }
  },
};

function miniTimeline(r, maxDur) {
  const W = 200, H = 18, w = W * r.duration / maxDur;
  const x = t => t / maxDur * W;
  let s = `<svg class="mini-tl" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(r.id)} : ${r.truth.length} crises annotées, ${r.detections.length} intervalles détectés">`;
  s += svgEl("line", { x1: 0, x2: w, y1: H / 2 + 0.5, y2: H / 2 + 0.5, class: "tl-base" });
  s += svgEl("line", { x1: w - 0.5, x2: w - 0.5, y1: 3, y2: H - 3, class: "tl-end" });
  for (const [a, b] of r.truth) s += svgEl("rect", { x: x(a), y: 2, width: Math.max(1.5, x(b) - x(a)), height: 7, class: "tl-truth" }, `<title>crise annotée ${clock(a)}–${clock(b)}</title>`);
  for (const [a, b, hit] of r.detections) s += svgEl("rect", { x: x(a), y: 9.5, width: Math.max(1.5, x(b) - x(a)), height: 7, class: hit ? "tl-det" : "tl-det fa" }, `<title>détection ${clock(a)}–${clock(b)}${r.annotated ? (hit ? " (crise annotée)" : " (fausse alarme)") : ""}</title>`);
  return s + "</svg>";
}

// ==========================================================================
// 6. Erreurs
// ==========================================================================
const Erreurs = {
  data: null, f: { rec: "", type: "tout", sat: false },
  async enter(r) {
    const body = $("#err-body");
    this.f = { rec: r.q.get("rec") || "", type: ["manquee", "fausse_alarme"].includes(r.q.get("type")) ? r.q.get("type") : "tout", sat: r.q.get("sat") === "1" };
    if (!this.data) {
      stateLine(body, "loading", "Chargement des erreurs…");
      try {
        this.data = await waitDone("/api/errors", d => stateLine(body, "loading", progressText(d),
          "Les erreurs sont tirées de la détection sur toute la cohorte, calculée une seule fois."), isPage("erreurs"));
      } catch (e) { if (e.name !== "AbortError") stateLine(body, "error", "Liste indisponible", `${capital(e.message)}. ${serverHint}`); return; }
      this.bind();
    }
    this.renderIntro(); this.syncFilters(); this.render();
  },
  renderIntro() {
    const it = this.data.items, fa = it.filter(i => i.type === "fausse_alarme"), mi = it.filter(i => i.type === "manquee");
    const recs = new Set(it.map(i => i.recording));
    const sw = fa.filter(i => i.dominant_hz != null && i.dominant_hz >= 2.5 && i.dominant_hz <= 4);
    const noted = fa.filter(i => i.journal && i.journal.notes && i.journal.notes.some(n => /abs|crise/i.test(n)));
    $("#err-intro").innerHTML = `Le modèle manque ${mono(mi.length)} ${mi.length > 1 ? "crises annotées" : "crise annotée"} et en signale ${mono(fa.length)} qui n’en sont pas, réparties sur ${mono(recs.size)} enregistrements. ` +
      `Toutes ne sont pas forcément de vraies erreurs : ${mono(sw.length)} fausses alarmes ont une fréquence dominante entre 2,5 et 4 Hz, celle d’une pointe-onde, ` +
      `et ${mono(noted.length)} tombent près d’une remarque du technicien qui évoque une absence. Ce sont peut-être de courtes décharges que personne n’a annotées ; elles méritent un second regard.`;
    this.renderKpis(mi.length, fa.length, recs.size);
  },
  /* Cartes de synthèse : les mêmes nombres que la phrase ci-dessus, plus les enregistrements sans erreur */
  async renderKpis(nMiss, nFa, nRecs) {
    const box = $("#err-kpis");
    const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    const IC = {
      miss: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1" stroke-linecap="round"/>'),
      bell: icon('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" stroke-linejoin="round"/>'),
      rec: icon('<path d="M3 12h3.5l2-5 3.5 10 2.5-7 1.5 2H21" stroke-linecap="round" stroke-linejoin="round"/>'),
      ok: icon('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.7L16 9.5" stroke-linecap="round" stroke-linejoin="round"/>'),
    };
    const card = (cls, v, l, ic) => `<div class="kpi kpi-${cls}"><span class="kpi-v">${nf(v)}</span>${ic}<span class="kpi-l">${l}</span></div>`;
    const cards = [card("rose", nMiss, nMiss > 1 ? "crises manquées" : "crise manquée", IC.miss),
                   card("peach", nFa, nFa > 1 ? "fausses alertes" : "fausse alerte", IC.bell),
                   card("lav", nRecs, nRecs > 1 ? "enregistrements concernés" : "enregistrement concerné", IC.rec)];
    box.innerHTML = cards.join(""); box.hidden = false;
    try {
      const S = await api("/api/summary");
      if (S && S.annotated != null && S.annotated >= nRecs) {
        const clean = S.annotated - nRecs;
        box.innerHTML = cards.join("") + card("mint", clean, clean > 1 ? "enregistrements sans erreur" : "enregistrement sans erreur", IC.ok);
      }
    } catch (_) { /* sans le résumé, on garde trois cartes */ }
  },
  bind() {
    const recs = [...new Set(this.data.items.map(i => i.recording))].sort();
    $("#err-rec").innerHTML = `<option value="">tous (${recs.length})</option>` + recs.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
    $("#err-rec").addEventListener("change", e => { this.f.rec = e.target.value; this.update(); });
    $$("#err-type button").forEach(b => b.addEventListener("click", () => { this.f.type = b.dataset.v; this.update(); }));
    $("#err-sat").addEventListener("change", e => { this.f.sat = e.target.checked; this.update(); });
    $("#err-export").addEventListener("click", () => this.exportCSV());
    $("#err-filters").hidden = false;
  },
  syncFilters() {
    $("#err-rec").value = this.f.rec;
    $$("#err-type button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === this.f.type)));
    $("#err-sat").checked = this.f.sat;
  },
  update() {
    const q = new URLSearchParams();
    if (this.f.rec) q.set("rec", this.f.rec);
    if (this.f.type !== "tout") q.set("type", this.f.type);
    if (this.f.sat) q.set("sat", "1");
    replaceHash(`#/erreurs${q.toString() ? "?" + q : ""}`);
    this.syncFilters(); this.render();
  },
  filtered() {
    return this.data.items.filter(i => (!this.f.rec || i.recording === this.f.rec) &&
      (this.f.type === "tout" || i.type === this.f.type) &&
      (!this.f.sat || (i.journal && i.journal.saturation.length)));
  },
  render() {
    const items = this.filtered();
    $("#err-count").textContent = `${items.length} élément${items.length > 1 ? "s" : ""}`;
    $("#err-export").disabled = !items.length;
    const body = $("#err-body");
    if (!items.length) {
      body.innerHTML = `<div class="state state-empty"><p class="state-title">Aucune erreur ne correspond à ces filtres.</p>` +
        `<p class="state-hint">${this.f.sat ? "Peu d’erreurs tombent près d’une saturation consignée ; essayez sans ce filtre." : "Élargissez la sélection."}</p></div>`;
      return;
    }
    const tol = this.data.tolerance_s;
    const group = (type, title, note) => {
      const L = items.filter(i => i.type === type);
      if (!L.length) return "";
      return `<section class="err-group"><h2 class="h2">${title} <span class="count mono">${L.length}</span></h2><p class="err-note">${note}</p>` +
        `<div class="err-list">${L.map((i, k) => this.item(i, `${type}-${k}`, tol)).join("")}</div></section>`;
    };
    body.innerHTML =
      group("manquee", "Crises manquées", "Crises annotées qu’aucun intervalle détecté ne recouvre.") +
      group("fausse_alarme", "Fausses alarmes", "Intervalles détectés qui ne recouvrent aucune crise annotée.");
    $$(".err-thumb", body).forEach(cv => this.thumb(cv));
    if (!body.dataset.bound) { onResize(body, () => $$(".err-thumb", body).forEach(cv => this.thumb(cv))); body.dataset.bound = "1"; }
  },
  item(i, key, tol) {
    const J = i.journal;
    const tags = [];
    if (!i.has_journal) tags.push(`<span class="jtag none">pas de journal d’examen</span>`);
    else {
      if (J.saturation.length) tags.push(`<span class="jtag sat">saturation à moins de ${nf(tol)} s : ${esc(J.saturation.join(", "))}</span>`);
      if (J.hpn) tags.push(`<span class="jtag ev">pendant l’hyperpnée</span>`);
      if (J.sli) tags.push(`<span class="jtag ev">pendant la SLI</span>`);
      for (const n of J.notes || []) tags.push(`<span class="jtag tnote">note du technicien : « ${esc(n)} »</span>`);
      if (!tags.length) tags.push(`<span class="jtag none">aucun événement du journal à proximité</span>`);
    }
    const href = lectureHref(i.recording, Math.max(0, i.start - 3));
    const what = i.type === "manquee" ? `crise annotée A${i.n}` : `détection D${i.n}`;
    return `<article class="err-item" data-type="${i.type}">
      <a class="err-fig" href="${href}" aria-label="Ouvrir ${esc(i.recording)} à ${clock(i.start)}"><canvas class="err-thumb" data-key="${key}" data-type="${i.type}"></canvas></a>
      <div class="err-text">
        <p class="err-title"><a class="mono rid-link" href="${lectureHref(i.recording)}">${esc(i.recording)}</a> <span class="err-what">${what}</span></p>
        <p class="err-time mono">${clock(i.start, 1)} → ${clock(i.end, 1)} · ${nf(i.duration, 1)} s</p>
        <p class="err-facts">fréquence dominante ${i.dominant_hz != null ? mono(nf(i.dominant_hz, 1) + " Hz") : "—"} · amplitude moyenne ${i.rms_uv != null ? mono(nf(i.rms_uv) + " µV") : "—"}</p>
        <p class="err-tags">${tags.join("")}</p>
        <a class="err-open" href="${href}">Ouvrir dans la lecture →</a>
      </div>
    </article>`;
  },
  thumb(cv) {
    const [type, k] = cv.dataset.key.split(/-(?=\d+$)/);
    const i = this.filtered().filter(x => x.type === type)[+k];
    if (!i) return;
    const T = i.thumb, chans = T.channels;
    const data = {};
    chans.forEach((c, j) => { data[c] = T.mode === "raw" ? T.data[j] : { min: T.min[j], max: T.max[j] }; });
    const ex = { start: T.t0, end: T.t1, t0: T.t0, dt: T.dt, mode: T.mode, channels: chans, data };
    const band = type === "manquee" ? { start: i.start, end: i.end, fill: C.sage, edge: C["sage-edge"] } : { start: i.start, end: i.end, fill: C.coral, edge: C["coral-edge"], hatch: true };
    drawExcerpt(cv, ex, { bands: [band], labelOf: c => c, padLeft: 28, axis: false, grid: true, lineWidth: 0.8 });
  },
  exportCSV() {
    const rows = [["enregistrement", "type", "numero", "debut_s", "fin_s", "duree_s", "frequence_dominante_hz", "amplitude_rms_uv",
                   "saturation_voies", "hyperpnee", "sli", "notes_technicien", "lien", "commentaire"]];
    const base = location.href.split("#")[0];
    for (const i of this.filtered()) {
      const J = i.journal;
      rows.push([i.recording, i.type === "manquee" ? "crise manquée" : "fausse alarme", i.n, i.start, i.end, i.duration,
                 i.dominant_hz, i.rms_uv, J ? J.saturation.join(" ") : "", J ? (J.hpn ? "oui" : "non") : "", J ? (J.sli ? "oui" : "non") : "",
                 J ? (J.notes || []).join(" | ") : "", base + lectureHref(i.recording, Math.max(0, i.start - 3)), ""]);
    }
    downloadCSV("erreurs_detection.csv", rows);
  },
};

// ==========================================================================
// 7. Modèles
// ==========================================================================
const Modeles = {
  models: null,
  async enter(params) {
    if (!this.models) {
      try { this.models = await api("/api/models"); }
      catch (e) {
        $("#models-body").hidden = true; $("#models-msg").hidden = false;
        $("#models-msg-text").textContent = `${capital(e.message)}. Les fichiers du dossier resultats/ n’ont pas pu être lus. ${serverHint}`;
        return;
      }
      this.renderBase();
    }
    this.renderPerRec();
    this.loadGkf(); this.loadSmooth();
    ModelesPlus.load(params);
  },
  renderBase() {
    const M = this.models;
    $("#models-msg").hidden = true; $("#models-body").hidden = false;
    const cols = [["Accuracy", "Accuracy"], ["Precision", "Précision"], ["Recall", "Rappel"], ["F1-score", "F1"]];
    const best = Object.fromEntries(cols.map(([k]) => [k, Math.max(...M.models.map(r => r[k]))]));
    $("#models-table thead").innerHTML = `<tr><th>Modèle</th>${cols.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr>`;
    $("#models-table tbody").innerHTML = M.models.map(r =>
      `<tr><td>${esc(r["Modèle"])}${r["Modèle"] === M.best ? '<span class="retenu">retenu</span>' : ""}</td>` +
      cols.map(([k]) => `<td class="num"><span class="${r[k] === best[k] ? "best" : ""}">${nf(r[k], 3)}</span></td>`).join("") + "</tr>").join("");
    drawChart(M.models, M.best);
  },
  renderPerRec() {
    const D = this.models.detection;
    const sum = k => D.reduce((a, r) => a + r[k], 0);
    const tot = { real: sum("Crises réelles"), det: sum("Détectées"), miss: sum("Manquées"), fa: sum("Fausses alarmes") };
    $("#per-rec-summary").innerHTML =
      `<span class="bit"><span class="mono">${tot.det}</span> crises détectées sur <span class="mono">${tot.real}</span> (${nf(100 * tot.det / tot.real, 1)} %)</span> ` +
      `<span class="bit"><span class="mono">${tot.miss}</span> manquées</span> ` +
      `<span class="bit"><span class="mono">${tot.fa}</span> fausses alarmes, sur ${D.length} enregistrements annotés</span>`;
    const tb = $("#perrec-table tbody");
    tb.innerHTML = "";
    for (const r of D) {
      const tr = document.createElement("tr");
      tr.className = "clickable"; tr.tabIndex = 0;
      tr.title = `Ouvrir ${r["Enregistrement"]} dans la lecture`;
      tr.innerHTML = `<td>${esc(r["Enregistrement"])}</td><td class="num">${r["Crises réelles"]}</td><td class="num">${r["Détectées"]}</td>` +
        `<td class="num ${r["Manquées"] ? "miss" : "zero"}">${r["Manquées"]}</td><td class="num ${r["Fausses alarmes"] ? "" : "zero"}">${r["Fausses alarmes"]}</td>` +
        `<td class="num">${nf(100 * r["Détectées"] / r["Crises réelles"], 0)} %</td>`;
      const goRow = () => go(lectureHref(r["Enregistrement"]));
      tr.addEventListener("click", goRow);
      tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goRow(); } });
      tb.appendChild(tr);
    }
    $("#perrec-table tfoot").innerHTML = `<tr><td>Total</td><td class="num">${tot.real}</td><td class="num">${tot.det}</td><td class="num">${tot.miss}</td>` +
      `<td class="num">${tot.fa}</td><td class="num">${nf(100 * tot.det / tot.real, 1)} %</td></tr>`;
  },
  async loadGkf() {
    const box = $("#gkf-body");
    if (!box.dataset.ready) stateLine(box, "loading", "Chargement…");
    let G;
    try { G = await waitDone("/api/groupkfold", d => stateLine(box, "loading", progressText(d)), isPage("modeles")); }
    catch (e) { if (e.name !== "AbortError") stateLine(box, "error", "Calcul indisponible", e.message); return; }
    const S0 = await Summary.get().catch(() => null);
    const overlap = S0 ? `, qui se recouvrent à ${mono(nf(S0.params.overlap * 100))} %,` : "";
    const cols = [["Accuracy", "Accuracy"], ["Precision", "Précision"], ["Recall", "Rappel"], ["F1-score", "F1"]];
    const row = (name, note, sc) => `<tr><td>${name}<span class="row-note">${note}</span></td>${cols.map(([k]) => `<td class="num">${nf(sc[k], 3)}</td>`).join("")}</tr>`;
    const nb = G.notebook && G.notebook.groupkfold;
    const delta = nb ? Math.abs(nb["F1-score"] - G.groupkfold["F1-score"]) : null;
    box.innerHTML = `
      <div class="gkf-grid">
        <div class="gkf-text">
          <p>Avec un découpage aléatoire, deux fenêtres voisines${overlap} peuvent tomber l’une dans l’entraînement et l’autre dans le test : le modèle a alors presque déjà vu la réponse. ` +
          `En regroupant les fenêtres par enregistrement (GroupKFold, ${mono(G.n_splits)} plis), le test ne porte que sur des tracés que le modèle n’a jamais vus, comme ce serait le cas pour un nouveau patient. C’est le score le plus honnête.</p>
          <p>Pour le ${esc(G.model)}, le F1 passe de ${mono(nf(G.random["F1-score"], 3))} à ${mono(nf(G.groupkfold["F1-score"], 3))}, et le rappel de ${mono(nf(G.random.Recall, 3))} à ${mono(nf(G.groupkfold.Recall, 3))}.</p>
        </div>
        <div>
          <table class="tbl tbl-gkf">
            <thead><tr><th>${esc(G.model)}</th>${cols.map(([, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead>
            <tbody>${row("Découpage aléatoire", "fenêtres mélangées · resultats_modeles.csv", G.random)}${row("Par enregistrement", `GroupKFold, ${G.n_splits} plis · ${G.n_recordings} enregistrements · recalculé`, G.groupkfold)}</tbody>
          </table>
          <p class="tbl-foot">Recalculé par le serveur sur ${mono(nf(G.n_windows))} fenêtres de <span class="mono">features_windows.csv</span>.` +
          (nb ? ` Le notebook obtenait un F1 de ${mono(nf(nb["F1-score"], 4))} ; l’écart (${mono(nf(delta, 4))}) vient probablement de la version de scikit-learn utilisée.` : "") + `</p>
        </div>
      </div>`;
    box.dataset.ready = "1";
  },
  async loadSmooth() {
    const box = $("#smooth-body");
    if (!box.dataset.ready) stateLine(box, "loading", "Chargement…");
    let D;
    try { D = await Cohort.get(d => stateLine(box, "loading", progressText(d)), isPage("modeles")); }
    catch (e) { if (e.name !== "AbortError") stateLine(box, "error", "Calcul indisponible", e.message); return; }
    const E = D.evaluation, A = E.windows_raw, B = E.windows_smoothed;
    const cols = [["Precision", "Précision"], ["Recall", "Rappel"], ["F1-score", "F1"]];
    const row = (name, sc) => `<tr><td>${name}</td>${cols.map(([k]) => `<td class="num">${nf(sc[k], 3)}</td>`).join("")}<td class="num">${nf(sc.fp)}</td><td class="num">${nf(sc.fn)}</td></tr>`;
    box.innerHTML = `
      <div class="gkf-grid">
        <div class="gkf-text">
          <p>Le filtre médian corrige une fenêtre d’après ses voisines. Mesuré sur un découpage aléatoire, son effet serait faussé : les voisines d’une fenêtre de test ont souvent servi à l’entraînement. Nous ne l’affichons donc pas.</p>
          <p>Ici, chaque enregistrement est prédit par un modèle qui ne l’a jamais vu (${mono(E.n_recordings)} enregistrements, ${mono(nf(E.n_windows))} fenêtres). Le lissage fait passer le F1 par fenêtre de ${mono(nf(A["F1-score"], 3))} à ${mono(nf(B["F1-score"], 3))}, ` +
          `surtout en supprimant des fausses détections isolées (${mono(nf(A.fp))} → ${mono(nf(B.fp))}).</p>
        </div>
        <div>
          <table class="tbl tbl-gkf">
            <thead><tr><th>Par fenêtre, sans l’enregistrement</th>${cols.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th class="num">Faux positifs</th><th class="num">Faux négatifs</th></tr></thead>
            <tbody>${row("Prédiction brute", A)}${row("Après lissage médian", B)}</tbody>
          </table>
          <p class="tbl-foot">Par événement, après fusion des fenêtres en intervalles : ${mono(E.events.detected)} crises retrouvées sur ${mono(E.events.n_true)}, ${mono(E.events.false_alarms)} fausses alarmes (${mono(nf(E.events.fa_per_hour, 1))} par heure).</p>
        </div>
      </div>`;
    box.dataset.ready = "1";
    const K = D.csv_check;
    $("#csv-check").innerHTML = K.diff.length
      ? `Recalcul par l’application : ${mono(K.same)} enregistrements sur ${mono(K.n)} identiques au notebook ; différences pour ${K.diff.map(d => esc(d.id)).join(", ")}.`
      : `Valeurs lues dans <span class="mono">detection_par_enregistrement.csv</span>. Recalculées par l’application, elles sont identiques pour les ${mono(K.n)} enregistrements.`;
  },
};

/* Diagramme en points (fait main) : F1 et rappel de chaque modèle sur une même échelle 0–1. */
function drawChart(models, bestName) {
  const rows = [...models].sort((a, b) => b["F1-score"] - a["F1-score"]);
  const W = 440, LX = 132, RX = W - 44, rowH = 52, top = 16;
  const H = top + rows.length * rowH + 20;
  const x = v => LX + v * (RX - LX);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="F1 et rappel par modèle, sur une échelle de 0 à 1">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    s += `<line class="${v === 0 ? "grid0" : "grid"}" x1="${x(v)}" x2="${x(v)}" y1="${top - 8}" y2="${H - 18}"/>`;
    s += `<text x="${x(v)}" y="${H - 4}" text-anchor="middle">${nf(v, v % 0.5 ? 2 : v ? 1 : 0)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2 - 6;
    const f = r["F1-score"], rc = r.Recall;
    const lo = Math.min(f, rc), hi = Math.max(f, rc);
    s += `<g class="row${r["Modèle"] === bestName ? " row-best" : ""}">`;
    s += `<title>${esc(r["Modèle"])} : F1 ${nf(f, 3)}, rappel ${nf(rc, 3)}, précision ${nf(r.Precision, 3)}</title>`;
    s += `<text class="lbl" x="0" y="${y + 5}">${esc(r["Modèle"])}</text>`;
    s += `<line class="track" x1="${x(0)}" x2="${x(1)}" y1="${y}" y2="${y}"/>`;
    s += `<line class="span" x1="${x(lo)}" x2="${x(hi)}" y1="${y}" y2="${y}"/>`;
    const lab = (v, cls, side) => `<text class="${cls}" x="${x(v) + (side < 0 ? -11 : 11)}" y="${y + 4}" text-anchor="${side < 0 ? "end" : "start"}">${nf(v, 3)}</text>`;
    s += lab(f, "v-f1", f <= rc ? -1 : 1) + lab(rc, "v-rec", rc < f ? -1 : 1);
    s += `<circle class="d-rec" cx="${x(rc)}" cy="${y}" r="6"/>`;
    s += `<circle class="d-f1" cx="${x(f)}" cy="${y}" r="6"/>`;
    s += `</g>`;
  });
  $("#chart").innerHTML = s + "</svg>";
}
