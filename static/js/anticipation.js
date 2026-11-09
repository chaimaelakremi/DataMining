/* ==========================================================================
   Absences — page « Anticipation » (section exploratoire du notebook)
   Tous les chiffres viennent de /api/anticipation, qui relit resultats_local/anticipation/.
   Courbe et frise sont des SVG construits à la main.
   ========================================================================== */
"use strict";

const ANT_COLORS = ["#6B7280", "#0072B2", "#009E73", "#D55E00"];   // un modèle = une couleur, toujours la même
const ALPHA = 0.05;

const Anticipation = {
  A: null, S: null, H: null, model: null,
  async enter() {
    AntAge.load();
    const box = $("#ant-body");
    if (!this.A) {
      stateLine(box, "loading", "Chargement…");
      try { this.A = await api("/api/anticipation"); }
      catch (e) { stateLine(box, "error", capital(e.message), serverHint); return; }
      try { this.S = await api("/api/summary"); } catch (_) { this.S = null; }
    }
    const A = this.A;
    if (!A.available) {
      stateLine(box, "empty", "Analyse non encore exécutée : lancer la section Anticipation du notebook.",
        "Les résultats seront lus dans le dossier resultats_local/anticipation/ dès qu’il existera.");
      return;
    }
    if (this.H == null) { this.H = A.horizons[0]; this.model = this.best(this.H).model; }
    this.render();
  },
  row(m, h) { return this.A.resume.find(r => r.model === m && r.horizon === h); },
  rows(h) { return this.A.resume.filter(r => r.horizon === h); },
  /* modèle mis en avant : celui qui annonce le plus de crises (puis la meilleure AUC) */
  best(h) { return [...this.rows(h)].sort((a, b) => b.announced - a.announced || b.auc - a.auc)[0]; },
  color(m) { return ANT_COLORS[this.A.models.findIndex(x => x.id === m) % ANT_COLORS.length]; },
  better(r) { return r.p != null && r.p < ALPHA && r.announced > r.chance_mean; },

  render() {
    const A = this.A, H = this.H, r = this.row(this.model, H), box = $("#ant-body");
    const pills = (items, cur, attr) => items.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join("");
    box.innerHTML = `
      <div class="filters ant-controls" role="group" aria-label="Réglages">
        <span class="field"><span class="tool-label">Horizon</span><span class="seg" id="ant-h">${pills(A.horizons.map(h => [h, `${nf(h)} s`]), H, "h")}</span></span>
        <span class="field"><span class="tool-label">Modèle affiché</span><span class="seg" id="ant-m">${pills(A.models.map(m => [m.id, m.id]), this.model, "m")}</span></span>
      </div>
      ${this.kpis(r)}
      <section class="rsec ant-sec"><h2 class="h2">Le modèle voit-il venir la crise ?</h2>
        <p class="body">Score moyen de chaque modèle autour du début annoté des crises de référence. S’il montait nettement dans la zone orangée, avant le trait vertical, la crise serait annoncée.</p>
        <figure class="rfig">${this.chart()}<figcaption>${this.legend()}</figcaption></figure></section>
      <section class="rsec ant-sec"><h2 class="h2">Les quatre modèles, horizon de ${nf(H)} s</h2>${this.table()}</section>
      <section class="rsec ant-sec"><h2 class="h2">Crise par crise</h2>
        <p class="body">Une ligne par crise de référence, pour le modèle ${esc(this.model)}. Chaque trait est une alarme, placée par rapport au début de la crise. Cliquer une ligne ouvre l’enregistrement dans la lecture, vingt secondes avant la crise.</p>
        <figure class="rfig ant-raster">${this.raster()}</figure></section>
      <section class="rsec ant-sec"><h2 class="h2">Ce qu’il faut retenir</h2>${this.retenir()}</section>`;
    $$("#ant-h button", box).forEach(b => b.addEventListener("click", () => { this.H = +b.dataset.h; this.render(); }));
    $$("#ant-m button", box).forEach(b => b.addEventListener("click", () => { this.model = b.dataset.m; this.render(); }));
  },

  kpis(r) {
    const ok = this.better(r);
    const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
    const card = (cls, v, l, ic) => `<div class="kpi kpi-${cls}"><span class="kpi-v">${v}</span>${ic}<span class="kpi-l">${l}</span></div>`;
    return `<div class="kpis ant-kpis">
      ${card("lav", `${nf(r.announced)}<span class="kpi-of"> / ${nf(r.n_ref)}</span>`, "crises annoncées sur les crises de référence", icon('<path d="M3 12h3.5l2-5 3.5 10 2.5-7 1.5 2H21" stroke-linecap="round" stroke-linejoin="round"/>'))}
      ${card("blue", r.median_lead_s != null ? `${nf(r.median_lead_s, 1)} s` : "—", "délai médian entre l’alarme et le début", icon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5" stroke-linecap="round"/>'))}
      ${card("peach", nf(r.false_per_hour, 1), "fausses annonces par heure", icon('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" stroke-linejoin="round"/>'))}
      ${card(ok ? "mint" : "rose", ok ? "Mieux que le hasard" : "Pas mieux que le hasard",
        `p ${r.p != null && r.p < 0.001 ? "< 0,001" : "= " + fmtP(r.p)} · le hasard en annoncerait ${nf(r.chance_mean, 1)} en moyenne`,
        icon(ok ? '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.7L16 9.5" stroke-linecap="round" stroke-linejoin="round"/>' : '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7" stroke-linecap="round"/>'))}
    </div>`;
  },

  chart() {
    const A = this.A, H = this.H, W = 1000, Hh = 340, L = 56, R = 16, T = 14, B = 44;
    const series = A.models.map(m => ({ id: m.id, c: A.courbe[`${m.id}|${H}`] })).filter(s => s.c);
    const t0 = Math.min(...series.map(s => s.c.t[0])), t1 = Math.max(...series.map(s => s.c.t[s.c.t.length - 1]));
    const ymax = Math.max(0.05, ...series.flatMap(s => s.c.hi.filter((v, i) => v != null && s.c.t[i] <= 0))) * 1.25;
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R), y = v => T + (1 - Math.max(0, Math.min(v, ymax * 3)) / ymax) * (Hh - T - B);
    const path = (ts, vs) => ts.map((t, i) => vs[i] == null ? "" : `${i && vs[i - 1] != null ? "L" : "M"}${x(t).toFixed(1)},${y(vs[i]).toFixed(1)}`).join("");
    let g = `<clipPath id="ant-clip"><rect x="${L}" y="${T}" width="${W - L - R}" height="${Hh - T - B}"/></clipPath><rect x="${x(-H)}" y="${T}" width="${x(0) - x(-H)}" height="${Hh - T - B}" class="ant-hz"/>`;
    for (let k = 0; k <= 4; k++) { const v = ymax * k / 4; g += `<line class="ant-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ant-tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${nf(v, 2)}</text>`; }
    for (let t = Math.ceil(t0 / 10) * 10; t <= t1; t += 10) g += `<text class="ant-tick" x="${x(t)}" y="${Hh - B + 18}" text-anchor="middle">${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(t)}</text>`;
    const sel = series.find(s => s.id === this.model);
    if (sel) { const ok = sel.c.t.map((t, i) => i).filter(i => sel.c.lo[i] != null);
      g += `<path d="${ok.map((i, k) => `${k ? "L" : "M"}${x(sel.c.t[i]).toFixed(1)},${y(sel.c.hi[i]).toFixed(1)}`).join("")}${ok.reverse().map(i => `L${x(sel.c.t[i]).toFixed(1)},${y(sel.c.lo[i]).toFixed(1)}`).join("")}Z" fill="${this.color(sel.id)}" opacity="0.14"/>`; }
    for (const s of series) g += `<path clip-path="url(#ant-clip)" d="${path(s.c.t, s.c.mean)}" fill="none" stroke="${this.color(s.id)}" stroke-width="${s.id === this.model ? 3 : 1.6}" stroke-linejoin="round" opacity="${s.id === this.model ? 1 : 0.75}"/>`;
    g += `<line class="ant-onset" x1="${x(0)}" x2="${x(0)}" y1="${T}" y2="${Hh - B}"/><text class="ant-lab" x="${x(0) + 6}" y="${T + 12}">début annoté</text>`;
    g += `<text class="ant-lab" x="${(x(-H) + x(0)) / 2}" y="${Hh - B - 8}" text-anchor="middle">horizon</text>`;
    g += `<text class="ant-axis" x="${(L + W - R) / 2}" y="${Hh - 6}" text-anchor="middle">Temps par rapport au début de la crise (s)</text>`;
    g += `<text class="ant-axis" transform="translate(14 ${(T + Hh - B) / 2}) rotate(-90)" text-anchor="middle">Score moyen du modèle</text>`;
    return `<svg class="ant-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Score moyen de chaque modèle de ${Math.abs(t0)} secondes avant à ${t1} secondes après le début des crises">${g}</svg>`;
  },
  legend() {
    return `<span class="ant-legend">${this.A.models.map(m => `<span><i style="background:${this.color(m.id)}"></i><strong>${esc(m.id)}</strong> ${esc(m.description)}</span>`).join("")}</span>` +
      ` La bande colorée est l’intervalle de confiance à 95 % du modèle affiché (${esc(this.model)}). L’échelle est calée sur la période qui précède le début : après le trait, la courbe du détecteur sort du cadre, parce qu’il reconnaît alors la crise.`;
  },

  table() {
    const rows = this.rows(this.H);
    return `<div class="tbl-scroll"><table class="tbl tbl-r"><thead><tr><th>Modèle</th><th>Ce qu’il regarde</th><th class="num">AUC</th><th class="num">Crises annoncées</th>
      <th class="num">Délai médian (s)</th><th class="num">Fausses annonces / h</th><th class="num">Annoncées par hasard</th><th class="num">p</th><th>Verdict</th></tr></thead><tbody>${
      rows.map(r => `<tr class="${r.model === this.model ? "is-current" : ""}"><td><i class="ant-dot" style="background:${this.color(r.model)}"></i>${esc(r.model)}</td>
        <td>${esc((this.A.models.find(m => m.id === r.model) || {}).description || "")}</td><td class="num">${nf(r.auc, 3)}</td>
        <td class="num">${nf(r.announced)} / ${nf(r.n_ref)}</td><td class="num">${r.median_lead_s != null ? nf(r.median_lead_s, 1) : "—"}</td>
        <td class="num">${nf(r.false_per_hour, 2)}</td><td class="num">${nf(r.chance_mean, 1)}</td><td class="num">${fmtP(r.p)}</td>
        <td>${this.better(r) ? "Mieux que le hasard" : "Pas mieux que le hasard"}</td></tr>`).join("")}</tbody></table></div>
      <p class="tbl-foot">AUC : capacité à distinguer une fenêtre pré-critique d’une fenêtre inter-critique (0,5 = hasard, 1 = parfait). « Annoncées par hasard » : moyenne sur ${this.A.draws != null ? nf(this.A.draws) : "les"} tirages de faux débuts placés au hasard.</p>`;
  },

  raster() {
    const A = this.A, H = this.H, al = A.alarmes[`${this.model}|${H}`] || {};
    const c0 = A.courbe[`${this.model}|${H}`], t0 = c0 ? c0.t[0] : -60, t1 = c0 ? c0.t[c0.t.length - 1] : 5;
    const W = 1000, L = 150, R = 16, rh = 15, T = 26, Hh = T + A.crises.length * rh + 30;
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R), col = this.color(this.model);
    let g = `<rect x="${x(-H)}" y="${T}" width="${x(0) - x(-H)}" height="${A.crises.length * rh}" class="ant-hz"/>`;
    for (let t = Math.ceil(t0 / 10) * 10; t <= t1; t += 10) g += `<text class="ant-tick" x="${x(t)}" y="${T - 8}" text-anchor="middle">${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(t)} s</text>`;
    A.crises.forEach((c, i) => {
      const ts = al[`${c.id}|${c.n}`] || [], yy = T + i * rh, hit = ts.some(t => t > -H && t <= 0);
      g += `<a href="#/lecture/${encodeURIComponent(c.id)}?t=${Math.max(0, Math.round(c.start - 20))}" class="ant-row${hit ? " is-hit" : ""}"><title>${esc(c.id)}, crise ${c.n} : ${hit ? "annoncée" : "non annoncée"}</title>
        <rect x="0" y="${yy}" width="${W}" height="${rh}" class="ant-row-bg"/><text x="${L - 10}" y="${yy + 11}" text-anchor="end" class="ant-rid">${esc(c.id)} · ${c.n}</text>
        ${ts.map(t => `<rect x="${(x(t) - 1.5).toFixed(1)}" y="${yy + 2}" width="3" height="${rh - 4}" fill="${col}" opacity="${t > -H && t <= 0 ? 1 : 0.45}"/>`).join("")}</a>`;
    });
    g += `<line class="ant-onset" x1="${x(0)}" x2="${x(0)}" y1="${T - 4}" y2="${T + A.crises.length * rh}"/>`;
    g += `<text class="ant-axis" x="${(L + W - R) / 2}" y="${Hh - 8}" text-anchor="middle">Temps par rapport au début de la crise · traits pleins : alarme dans l’horizon</text>`;
    return `<svg class="ant-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Alarmes du modèle ${esc(this.model)} autour de chaque crise de référence">${g}</svg>`;
  },

  retenir() {
    const A = this.A, all = A.resume, good = all.filter(r => this.better(r)), top = this.best(this.H), S = this.S;
    const part = top.n_ref ? top.announced / top.n_ref : 0;
    // correction de Holm sur l'ensemble des essais : combien restent significatifs ?
    const tri = [...all].filter(r => r.p != null).sort((a, b) => a.p - b.p);
    let holm = 0; for (let i = 0; i < tri.length; i++) { if (tri[i].p * (tri.length - i) < ALPHA && this.better(tri[i])) holm++; else break; }
    const items = [
      good.length === 0
        ? `Aucun des ${mono(nf(all.length))} essais (modèle et horizon) ne fait mieux que le hasard : sur ces données, rien n’indique qu’une absence puisse être annoncée.`
        : `${mono(nf(good.length))} des ${mono(nf(all.length))} essais (modèle et horizon) font mieux que le hasard : ${good.map(r => `${esc(r.model)} à ${nf(r.horizon)} s`).join(", ")}. Après correction pour ces ${mono(nf(all.length))} comparaisons (Holm), il en reste ${mono(nf(holm))}.`,
      `À l’horizon de ${mono(nf(this.H) + " s")}, le modèle qui annonce le plus de crises est ${mono(esc(top.model))} : ${mono(nf(top.announced))} sur ${mono(nf(top.n_ref))}, soit ${mono(pct(part, 0))}` +
        `${top.median_lead_s != null ? `, avec un délai médian de ${mono(nf(top.median_lead_s, 1) + " s")}` : ""}, et ${mono(nf(top.false_per_hour, 1))} fausses annonces par heure.`,
      good.length ? `Même pour le meilleur modèle, ${mono(nf(top.n_ref - top.announced))} crises sur ${mono(nf(top.n_ref))} arrivent sans aucune alerte : c’est un signal statistique, pas un outil utilisable.` : "",
      (() => { const m0 = this.row(A.models[0].id, this.H); return m0 ? `Le détecteur existant (${esc(m0.model)}) annonce ${mono(nf(m0.announced))} crise${m0.announced > 1 ? "s" : ""} : il reconnaît la crise, il ne la devance pas.` : ""; })(),
    ];
    const lim = [S && S.seizures != null ? `${nf(S.seizures)} crises annotées en tout, dont ${nf(top.n_ref)} crises de référence` : `${nf(top.n_ref)} crises de référence`,
      S && S.ages && S.ages.adults != null ? `${nf(S.ages.adults)} patient adulte` : "",
      S && S.type_abs ? Object.entries(S.type_abs).map(([k, v]) => `${nf(v)} patient aux absences ${esc(k)}`).join(", ") : ""].filter(Boolean).join(" ; ");
    return facts(items) + limits(`${lim}. Le début des crises est annoté à la seconde près : une alarme quelques secondes « avant » peut aussi signaler un début réel un peu antérieur à l’annotation. Analyse exploratoire, à confirmer sur d’autres patients.`);
  },
};
