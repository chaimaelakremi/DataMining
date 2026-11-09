/* ==========================================================================
   Absences — Laboratoire · Augmentation de données
     a) voir une augmentation sur une vraie crise (tracé et 17 caractéristiques, avant / après) ;
     b) ré-entraîner le Random Forest « sans l'enregistrement » avec augmentation (tâche de fond) ;
     c) comparer au modèle du projet : cohorte, pannes d'électrodes, patiente adulte.
   ========================================================================== */
"use strict";

const Augment = (() => {
  const A = { st: null, last: null, prev: null };
  const PARAMS = [
    ["a_min", "Amplitude minimale des copies", 0.2, 1, 0.05, v => `× ${nf(v, 2)}`],
    ["copies", "Copies par fenêtre de crise", 1, 4, 1, v => nf(v)],
    ["retrait_max", "Voies retirées au hasard (au plus)", 0, 3, 1, v => nf(v)],
    ["part_corrompue", "Copies avec une voie corrompue", 0, 0.5, 0.05, v => pct(v, 0)],
    ["part_normales", "Fenêtres normales augmentées aussi", 0, 0.3, 0.05, v => pct(v, 0)],
  ];

  async function init(recs) {
    const box = $("#au-body");
    try { A.st = await api("/api/augment/status"); }
    catch (e) { stateLine(box, "error", "Onglet indisponible", e.message); return; }
    const S = A.st, ann = recs.filter(r => S.ids.includes(r.id));
    const opt = list => `<option value="">aucune</option>${list.map(e => `<option>${e}</option>`).join("")}`;
    box.innerHTML = `
      <section class="lab-sec au-sec"><h2 class="h2 lab-h2"><span class="lab-letter">a</span>Voir une augmentation</h2>
        <p class="body lab-body">Une vraie crise, puis la même crise modifiée comme le seront les copies d’entraînement. Elle doit rester une absence : seul son aspect change.</p>
        <div class="filters lab-controls">
          <label class="field"><span class="tool-label">Enregistrement</span><select id="au-rec">${ann.map(r => `<option value="${r.id}">${r.id} · ${plural(r.n_seizures, "crise", "crises")}</option>`).join("")}</select></label>
          <label class="field"><span class="tool-label">Crise</span><select id="au-n"></select></label>
          <label class="lab-slider au-a"><span class="tool-label">Amplitude</span><input type="range" id="au-a" min="0.3" max="1" step="0.05" value="0.5"><output id="au-a-v"></output></label>
          <label class="field check"><input type="checkbox" id="au-pol"> polarité inversée</label>
          <label class="field"><span class="tool-label">Voie retirée</span><select id="au-rem">${opt(S.electrodes)}</select></label>
          <label class="field"><span class="tool-label">Voie corrompue</span><select id="au-cor">${opt(S.electrodes)}</select></label>
          <label class="field"><span class="tool-label">Panne</span><select id="au-type">${Object.entries(S.corruptions).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label></div>
        <div id="au-prev"></div></section>
      <section class="lab-sec au-sec"><h2 class="h2 lab-h2"><span class="lab-letter">b</span>Entraîner avec augmentation</h2>
        <p class="lab-safe" role="note">Seuls les enregistrements d’entraînement sont augmentés ; l’enregistrement testé reste intact (aucune fuite).</p>
        <div class="au-train"><div class="lab-card lab-sliders">${PARAMS.map(([k, l, a, b, s]) => `<label class="lab-slider"><span class="tool-label">${l}</span><input type="range" data-k="${k}" min="${a}" max="${b}" step="${s}" value="${S.default[k]}"><output></output></label>`).join("")}
          <label class="field check"><input type="checkbox" id="au-pol2" ${S.default.polarite ? "checked" : ""}> inverser la polarité d’une copie sur deux</label>
          <div class="lab-row"><button type="button" class="btn" id="au-run">Lancer</button><span class="lab-small lab-dim">19 Random Forest de 300 arbres, chacun sans l’enregistrement testé : environ 3 min la première fois, immédiat ensuite.</span></div>
          ${jobBox("au-job")}</div>
          <div class="lab-small au-notes"><p><b>Augmentations utilisées</b>, calculées exactement sur les caractéristiques :</p><ul>
            <li><b>amplitude</b> : la copie est multipliée par un facteur entre l’amplitude minimale et 1 ; les mesures de taille suivent, le rythme ne change pas ;</li>
            <li><b>polarité</b> : le signal est retourné ; une pointe-onde reste une pointe-onde ;</li>
            <li><b>voies retirées</b> : la moyenne se fait sans elles ;</li>
            <li><b>voie corrompue</b> : une voie est remplacée par sa version en panne (mêmes pannes que l’onglet Électrodes).</li></ul>
            <p class="lab-dim">Pas de décalage dans le temps (les fenêtres avancent déjà de 1 s) ni de bruit léger (il faudrait recalculer tout le signal).</p></div></div></section>
      <section class="lab-sec au-sec"><h2 class="h2 lab-h2"><span class="lab-letter">c</span>Avant / après</h2><div id="au-out">${S.tag ? "" : `<p class="body lab-dim">Lancez un entraînement pour comparer au modèle du projet.</p>`}</div></section>`;
    // a) aperçu
    const syncN = () => { const r = ann.find(x => x.id === $("#au-rec").value); $("#au-n").innerHTML = Array.from({ length: r.n_seizures }, (_, i) => `<option value="${i + 1}">crise ${i + 1}</option>`).join(""); };
    $("#au-rec").value = ann.some(r => r.id === "230102B-F") ? "230102B-F" : ann[0].id; syncN();
    $("#au-rem").value = "O1"; $("#au-cor").value = "Fp1";
    $("#au-rec").addEventListener("change", () => { syncN(); preview(); });
    $("#au-a").addEventListener("input", () => { $("#au-a-v").textContent = `× ${nf(+$("#au-a").value, 2)}`; });
    ["#au-n", "#au-a", "#au-pol", "#au-rem", "#au-cor", "#au-type"].forEach(s => $(s).addEventListener("change", preview));
    $("#au-a-v").textContent = `× ${nf(+$("#au-a").value, 2)}`;
    onResize($("#au-prev"), () => A.prev && drawPrev());
    preview();
    // b) entraînement
    $$(".au-train input[type=range]").forEach(i => { const P = PARAMS.find(p => p[0] === i.dataset.k), o = i.nextElementSibling, sync = () => { o.textContent = P[5](+i.value); }; i.addEventListener("input", sync); sync(); });
    $("#au-run").addEventListener("click", train);
    if (S.tag) {                                     // un entraînement existe : on affiche le dernier (relu dans le cache)
      if (S.config) {
        $$(".au-train input[type=range]").forEach(i => { i.value = S.config[i.dataset.k]; i.dispatchEvent(new Event("input")); });
        $("#au-pol2").checked = S.config.polarite;
      }
      train();
    }
  }

  async function preview() {
    const q = new URLSearchParams({ rid: $("#au-rec").value, n: $("#au-n").value || 1, a: $("#au-a").value, polarite: $("#au-pol").checked,
      retirer: $("#au-rem").value, corrompre: $("#au-cor").value, type: $("#au-type").value });
    if (!A.prev) stateLine($("#au-prev"), "loading", "Chargement des caractéristiques par voie…");
    try { A.prev = await api(`/api/augment/preview?${q}`); } catch (e) { stateLine($("#au-prev"), "error", "Aperçu impossible", e.message); return; }
    drawPrev();
  }
  function drawPrev() {
    const d = A.prev;
    $("#au-prev").innerHTML = `<div class="au-ab"><figure class="lab-card"><figcaption class="h3">Crise réelle <span class="h3-note">${esc(d.id)}, crise ${d.n}</span></figcaption><canvas class="au-ex" id="au-o"></canvas></figure>
      <figure class="lab-card"><figcaption class="h3">Copie augmentée <span class="h3-note">même échelle</span></figcaption><canvas class="au-ex" id="au-g"></canvas></figure></div>
      <figure class="lab-card"><figcaption class="h3">Les 17 caractéristiques de la fenêtre centrale <span class="h3-note">${clock(d.window[0])}–${clock(d.window[1])} · rapport copie / réel</span></figcaption><div class="au-feats" id="au-f"></div></figure>`;
    const ex = (data, skip) => ({ start: d.t0, end: d.t0 + data[d.channels[0]].length * d.dt, t0: d.t0, dt: d.dt, mode: "raw", channels: d.channels,
      data: Object.fromEntries(d.channels.filter(c => c !== skip).map(c => [c, data[c]])) });
    const eo = ex(d.original), lane = ($("#au-o").clientHeight - 30) / d.channels.length, uv = (3 * robustUv(eo)) / (0.42 * lane);
    const band = [{ start: d.seizure[0], end: d.seizure[1], fill: C.sage, edge: C["sage-edge"] }, { start: d.window[0], end: d.window[1], fill: C["window-fill"] }];
    const lab = c => c === d.removed ? `${c} ✕` : c === d.corrupted ? `${c} ⚡` : c;
    drawExcerpt($("#au-o"), eo, { uvPerPx: uv, bands: band, padLeft: 44, scaleBar: true, relative: true, clipLanes: 1.2 });
    drawExcerpt($("#au-g"), ex(d.augmented, d.removed), { uvPerPx: uv, bands: band, padLeft: 44, scaleBar: true, relative: true, clipLanes: 1.2, labelOf: lab });
    $("#au-f").innerHTML = Object.entries(d.features).map(([f, [o, g]]) => {
      const r = Math.abs(o) > 1e-9 ? g / o : 1, w = Math.min(100, 50 * Math.abs(r));
      return `<div class="au-fr"><span class="mono">${f}</span><span class="mono num">${fmtV(o)}</span><span class="mono num">${fmtV(g)}</span><span class="au-fb"><i style="width:${w}%" class="${r < 0.95 ? "is-lo" : r > 1.05 ? "is-hi" : ""}"></i><b style="left:50%"></b></span><span class="mono num">× ${nf(r, 2)}</span></div>`;
    }).join("") + `<p class="lab-small lab-dim">Barre : rapport entre la copie et la crise réelle (repère au milieu : × 1). Les parts par bande et la fréquence du pic ne bougent pas avec l’amplitude : c’est le rythme que le modèle doit apprendre à regarder.</p>`;
  }
  const fmtV = v => (Math.abs(v) >= 1000 ? nf(v, 0) : nf(v, Math.abs(v) < 1 ? 3 : 1));

  async function train() {
    const cfg = { polarite: $("#au-pol2").checked };
    $$(".au-train input[type=range]").forEach(i => { cfg[i.dataset.k] = +i.value; });
    const btn = $("#au-run"); btn.disabled = true;
    try {
      A.last = await Jobs.run("augment", cfg, $("#au-job"));
      await postJSON(`/api/augment/use?tag=${A.last.tag}`, A.last.config);     // ce jeu de modèles devient celui des autres onglets
      render();
    }
    catch (e) { if (e.name !== "Cancelled") stateLine($("#au-out"), "error", "Entraînement impossible", e.message); }
    finally { btn.disabled = false; }
  }

  function render() {
    const R = A.last, S0 = R.scenarios[0], P_ = S0.projet, Q = S0.augmente;
    const tile = (cls, l, p, q, fmt, higher) => {
      const d = q - p, c = Math.abs(d) < 1e-9 ? "" : (d > 0) === higher ? "is-better" : "is-worse";
      return `<div class="kpi ${cls}"><p class="kpi-v">${fmt(q)}</p><p class="kpi-l">${l}<br><span class="lab-was">projet : ${fmt(p)}</span> <span class="${c}">${Math.abs(d) < 1e-9 ? "=" : (d > 0 ? "+" : "−") + fmt(Math.abs(d))}</span></p></div>`;
    };
    const ad = R.adulte;
    $("#au-out").innerHTML = `<p class="lab-small lab-dim">Modèle augmenté ${esc(R.tag)} : environ ${nf(R.n_copies_par_pli)} copies ajoutées par entraînement ; ${R.n_fits} modèles « sans l’enregistrement ».</p>
      <div class="kpis lab-kpis au-kpis">
        ${tile("kpi-mint", `crises détectées sur ${Q.n_true}`, P_.detected, Q.detected, v => nf(v), true)}
        ${tile("kpi-peach", "fausses alarmes", P_.false_alarms, Q.false_alarms, v => nf(v), false)}
        ${tile("kpi-blue", "F1 par fenêtre", P_.f1, Q.f1, v => nf(v, 3), true)}
        ${tile("kpi-lav", "retard moyen au début (s)", P_.mean_delay, Q.mean_delay, v => nf(v, 2), false)}</div>
      <div class="au-two">
        <figure class="lab-card"><figcaption class="h3">La patiente adulte <span class="h3-note">${esc(ad.id)} · ses crises manquées par le modèle du projet</span></figcaption>
          ${ad.seizures.map((z, i) => `<div class="au-adult" data-i="${i}"></div><p class="lab-small">Crise ${i + 1} (${clock(z.start)}–${clock(z.end)}) : probabilité maximale ${mono(nf(z.max_projet, 2))} avec le modèle du projet, ${mono(nf(z.max_augmente, 2))} avec le modèle augmenté${z.max_augmente > 0.5 && z.max_projet <= 0.5 ? " : <b>elle passe au-dessus du seuil</b>." : "."}</p>`).join("")}
          <p class="lab-legend"><span><i class="lab-k" style="background:#B9AEB4"></i>projet</span><span><i class="lab-k" style="background:var(--berry)"></i>augmenté</span><span><i class="lab-k lab-k-t"></i>seuil 0,5</span><span><span class="sw sw-annot"></span>crise annotée</span></p></figure>
        <figure class="lab-card"><figcaption class="h3">Face aux pannes d’électrodes <span class="h3-note">19 enregistrements</span></figcaption>
          <table class="tbl lab-tbl"><thead><tr><th>Scénario</th><th class="num">Crises (projet)</th><th class="num">Crises (augmenté)</th><th class="num">F. alarmes (projet)</th><th class="num">F. alarmes (augmenté)</th></tr></thead><tbody>
          ${R.scenarios.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.projet.detected}</td><td class="num ${s.augmente.detected > s.projet.detected ? "is-better" : s.augmente.detected < s.projet.detected ? "is-worse" : ""}">${s.augmente.detected}</td>` +
            `<td class="num">${s.projet.false_alarms}</td><td class="num ${s.augmente.false_alarms < s.projet.false_alarms ? "is-better" : s.augmente.false_alarms > s.projet.false_alarms ? "is-worse" : ""}">${s.augmente.false_alarms}</td></tr>`).join("")}</tbody></table>
          <p class="tbl-foot">Même modèle (Random Forest, 300 arbres), même évaluation « sans l’enregistrement » ; seule change l’augmentation des données d’entraînement. Le modèle augmenté peut aussi être choisi dans les onglets Stress test et Électrodes.</p></figure></div>
      <h3 class="h3">Par enregistrement <span class="h3-note">en couleur : différent du modèle du projet</span></h3>
      <div class="tbl-scroll"><table class="tbl lab-tbl"><thead><tr><th>Enregistrement</th><th class="num">Crises</th><th class="num">Détectées</th><th class="num">Fausses alarmes</th></tr></thead><tbody>
      ${R.recordings.map(x => `<tr class="${x.detected !== x.detected_projet || x.false_alarms !== x.false_alarms_projet ? "is-off" : ""}"><td><a class="mono rid-link" href="${lectureHref(x.id)}">${esc(x.id)}</a></td><td class="num">${x.n_true}</td>` +
        `<td class="num ${x.detected > x.detected_projet ? "is-better" : x.detected < x.detected_projet ? "is-worse" : ""}">${x.detected}<span class="lab-was"> (${x.detected_projet})</span></td>` +
        `<td class="num ${x.false_alarms < x.false_alarms_projet ? "is-better" : x.false_alarms > x.false_alarms_projet ? "is-worse" : ""}">${x.false_alarms}<span class="lab-was"> (${x.false_alarms_projet})</span></td></tr>`).join("")}</tbody></table></div>
      <p class="r-facts lab-sentence">${verdict(R)}</p>`;
    drawAdult(); onResize($("#au-out"), drawAdult);
  }
  function verdict(R) {
    const P_ = R.scenarios[0].projet, Q = R.scenarios[0].augmente, ad = R.adulte.seizures;
    const gained = ad.filter(z => z.max_augmente > 0.5 && z.max_projet <= 0.5).length;
    const fa = Q.false_alarms - P_.false_alarms;
    return `Avec ces réglages, le modèle augmenté détecte ${Q.detected} crises sur ${Q.n_true} (projet : ${P_.detected})` +
      (gained ? `, dont ${gained} des ${ad.length} crises de la patiente adulte que le modèle du projet manquait` : "") +
      `, ${fa > 0 ? `au prix de ${fa} fausses alarmes de plus` : fa < 0 ? `avec ${-fa} fausses alarmes de moins` : "avec autant de fausses alarmes"} (${Q.false_alarms} contre ${P_.false_alarms}). ` +
      `C’est le compromis de l’augmentation : apprendre que des crises plus faibles existent rend le modèle plus sensible, mais aussi plus prompt à sonner. Il reste une variante proposée, à côté du modèle officiel.`;
  }
  function drawAdult() {
    const R = A.last; if (!R) return;
    $$(".au-adult").forEach(el => {
      const z = R.adulte.seizures[+el.dataset.i], W = Math.max(300, el.clientWidth), H = 130, m = { l: 30, r: 8, t: 8, b: 20 };
      const a = z.t[0], b = z.t[z.t.length - 1], X = t => m.l + (t - a) / (b - a) * (W - m.l - m.r), Y = p => H - m.b - p * (H - m.t - m.b);
      const line = (p, cls) => `<path d="${z.t.map((t, i) => `${i ? "L" : "M"}${X(t).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join("")}" class="${cls}"/>`;
      el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg"><rect x="${X(z.start)}" y="${m.t}" width="${X(z.end) - X(z.start)}" height="${H - m.t - m.b}" fill="var(--sage)" opacity="0.55"/>` +
        `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0.5)}" y2="${Y(0.5)}" class="lab-thr"/><text x="${m.l - 4}" y="${Y(0.5) + 4}" class="lab-tick" text-anchor="end">0,5</text>` +
        line(z.projet, "au-lp") + line(z.augmente, "lab-line") + `<text x="${X(a)}" y="${H - 4}" class="lab-tick">${clock(a)}</text><text x="${X(b)}" y="${H - 4}" class="lab-tick" text-anchor="end">${clock(b)}</text></svg>`;
    });
  }
  return { init };
})();
