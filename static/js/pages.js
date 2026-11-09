/* ==========================================================================
   Absences — pages explicatives : Accueil, Comprendre, Méthode, Limites
   Tous les chiffres affichés viennent de l'API (données, resultats/ ou calcul
   du serveur) ; rien n'est inscrit en dur dans le texte.
   ========================================================================== */
"use strict";

const DEMO = "230102B-F";

/* Résumé chiffré partagé (Accueil, Limites) ; rechargé tant que la cohorte n'est pas calculée. */
const Summary = {
  data: null,
  async get(force = false) {
    if (!this.data || force || this.data.cohort.status !== "done" || this.data.groupkfold.status !== "done") {
      this.data = await api("/api/summary");
    }
    return this.data;
  },
};
const isPage = name => () => ROUTE.page === name;

// ==========================================================================
// 1. Accueil
// ==========================================================================
const Accueil = {
  hook: null,
  async enter() {
    const figs = $("#home-figures");
    if (!figs.dataset.ready) stateLine(figs, "loading", "Chargement des chiffres clés…");
    this.trace();
    let S0;
    try { S0 = await Summary.get(); }
    catch (e) { stateLine(figs, "error", "Chiffres indisponibles", `${capital(e.message)}. ${serverHint}`); return; }
    this.render(S0);
    if (S0.cohort.status !== "done" || S0.groupkfold.status !== "done") {
      try {
        await waitDone("/api/cohort", d => this.render(S0, d), isPage("accueil"));
        await waitDone("/api/groupkfold", null, isPage("accueil"));
        this.render(await Summary.get(true));
      } catch (e) { if (e.name !== "AbortError") stateLine(figs, "error", "Calcul interrompu", e.message); }
    }
  },
  render(S0, progress) {
    const P = S0.params;
    $("#home-why").innerHTML = `Ici, un enregistrement dure de ${mono(nf(S0.recording_min.min))} à ${mono(nf(S0.recording_min.max))} minutes et compte ${mono(S0.eeg_channels)} voies EEG. ` +
      `Pour noter le début et la fin de chaque crise, le médecin le parcourt page après page, en surveillant toutes les voies à la fois : c’est long, et l’attention baisse.`;
    $("#home-what").innerHTML = `Cet outil fait un premier passage. Il découpe le signal en fenêtres de ${mono(nf(P.win_s))} s, décrit chacune par ${mono(P.features)} caractéristiques, ` +
      `les classe avec un modèle appris sur des tracés annotés, puis regroupe les fenêtres en intervalles de crise que le médecin peut vérifier un par un.`;
    const E = S0.evaluation, B = S0.best_model, G = S0.groupkfold_scores;
    const wait = progressText(progress || S0.cohort);
    const fig = (n, l, s, cls = "") => `<div class="fig ${cls}"><p class="fig-n">${n}</p><p class="fig-l">${l}</p>${s ? `<p class="fig-s">${s}</p>` : ""}</div>`;
    const figs = [
      fig(nf(S0.recordings), "enregistrements EEG", `dont ${S0.annotated} annotés · ${nf(S0.hours_total, 1)} h de signal`),
      fig(nf(S0.seizures), "crises annotées", S0.seizure_s ? `de ${nf(S0.seizure_s.min)} à ${nf(S0.seizure_s.max)} s chacune` : ""),
      E ? fig(`${E.events.detected}<span class="fig-of">/${E.events.n_true}</span>`, "crises retrouvées", `${pct(E.events.sensitivity)} · chaque tracé analysé par un modèle qui ne l’a jamais vu`)
        : fig("…", "crises retrouvées", wait, "is-pending"),
      E ? fig(nf(E.events.fa_per_hour, 1), "fausses alarmes par heure", `${E.events.false_alarms} au total sur ${nf(E.events.hours, 1)} h annotées`)
        : fig("…", "fausses alarmes par heure", wait, "is-pending"),
      fig(nf(B.f1_random, 3), `F1 du ${esc(B.name)}`, `meilleur des ${B.n_models} modèles, par fenêtre (découpage aléatoire)` +
        (G ? ` ; ${nf(G["F1-score"], 3)} évalué par enregistrement` : "")),
    ];
    const el = $("#home-figures");
    el.innerHTML = figs.join("");
    el.dataset.ready = "1";
    this.modelsFigure(fig, el, B);
  },
  /* Dernière carte : si le notebook a comparé davantage de modèles (resultats_local/), on le dit ici */
  async modelsFigure(fig, el, B) {
    let R;
    try { R = await Research.get(); } catch (_) { return; }
    const M = R && R.modeles, f = M && M.facts;
    if (!f || !el.lastElementChild) return;
    const f1 = (M.extra_trees || []).find(x => /F1/.test(x.metrique));
    const autre = f.best !== B.name
      ? ` ; ${esc(f.best)} fait ${nf(f.best_f1, 3)}` + (f.best === "Extra Trees" && f1 && f1.p_holm != null ? (f1.p_holm < 0.05 ? ", écart significatif" : ", écart non significatif") : "")
      : "";
    el.lastElementChild.outerHTML = fig(nf(f.n), "modèles comparés",
      `${esc(B.name)} retenu : F1 de ${nf(f.rf_f1, 3)} évalué par enregistrement${autre}. <a href="#/modeles">Voir la comparaison</a>`);
  },
  async trace() {
    const cv = $("#home-trace"), cap = $("#home-trace-cap");
    if (!this.hook) {
      try {
        const meta = await api(`/api/recordings/${DEMO}`);
        const sz = meta.seizures[0];
        if (!sz) { cap.textContent = ""; return; }
        const a = Math.max(0, sz.start - 4), b = a + 10;
        const chans = ["EEGFp1", "EEGF3", "EEGC3", "EEGP3", "EEGO1", "EEGF4"].filter(c => meta.channels.includes(c));
        const ex = await api(`/api/recordings/${DEMO}/signal?start=${a}&end=${b}&width=900&channels=${chans.join(",")}`);
        this.hook = { ex, sz, a, b, chans };
      } catch (e) { cap.textContent = "Extrait indisponible : " + e.message; return; }
    }
    const { ex, sz, a, b, chans } = this.hook;
    const draw = () => drawExcerpt(cv, ex, { channels: chans, start: a, end: b, bands: [{ start: sz.start, end: sz.end, fill: C.sage, edge: C["sage-edge"] }], scaleBar: true });
    draw();
    if (!cv.dataset.bound) { onResize(cv, () => this.hook && draw()); cv.dataset.bound = "1"; }
    cap.innerHTML = `${DEMO}, ${chans.length} voies sur 10 s. La crise annotée commence à ${mono(clock(sz.start))} (bande verte) : ` +
      `le rythme change d’un coup sur toutes les voies. <a href="${lectureHref(DEMO, a)}">Ouvrir ce passage dans la lecture</a>`;
  },
};

// ==========================================================================
// 2. Comprendre une absence
// ==========================================================================
const ELECTRODES = {
  Fp1: [-0.29, -0.84], Fp2: [0.29, -0.84],
  F7: [-0.70, -0.50], F3: [-0.36, -0.44], Fz: [0, -0.42], F4: [0.36, -0.44], F8: [0.70, -0.50],
  T3: [-0.86, 0], C3: [-0.43, 0], Cz: [0, 0], C4: [0.43, 0], T4: [0.86, 0],
  T5: [-0.70, 0.50], P3: [-0.36, 0.44], Pz: [0, 0.42], P4: [0.36, 0.44], T6: [0.70, 0.50],
  O1: [-0.29, 0.84], O2: [0.29, 0.84],
};
const REGION = { Fp: "frontale (pôle frontal)", F: "frontale", T: "temporale", C: "centrale", P: "pariétale", O: "occipitale" };
function electrodeInfo(name) {
  const letters = name.match(/^[A-Za-z]+/)[0].replace(/z$/, "");
  const suffix = name.slice(letters.length);
  const side = suffix === "z" ? "ligne médiane" : (+suffix % 2 ? "côté gauche" : "côté droit");
  return { region: REGION[letters] || "", side };
}

const Comprendre = {
  data: null, hover: null,
  async enter() {
    const body = $("#cmp-body");
    if (!this.data) {
      stateLine(body, "loading", "Préparation des extraits…", "Le serveur choisit les passages et mesure leur fréquence dominante.");
      try { this.data = await api(`/api/comprendre?rid=${DEMO}`); }
      catch (e) { stateLine(body, "error", "Extraits indisponibles", `${capital(e.message)}. ${serverHint}`); return; }
      this.render();
    }
    requestAnimationFrame(() => this.drawAll());
  },
  render() {
    const D = this.data, N = D.normal, Z = D.seizure;
    const parts = [];
    // --- fond normal / crise
    if (N && Z) {
      const ratio = Z.rms_uv && N.rms_uv ? Z.rms_uv / N.rms_uv : null;
      parts.push(`<section class="cmp-section">
        <h2 class="h2">Un fond normal, puis une crise</h2>
        <div class="cmp-pair">
          <figure><canvas id="cmp-normal" class="fig-canvas"></canvas>
            <figcaption class="caption"><b>Fond normal</b> · ${mono(`${clock(N.start)}–${clock(N.end)}`)}<br>fréquence dominante ${mono(nf(N.dominant_hz, 1) + " Hz")} · amplitude moyenne ${mono(nf(N.rms_uv) + " µV")}</figcaption></figure>
          <figure><canvas id="cmp-seizure" class="fig-canvas"></canvas>
            <figcaption class="caption"><b>Au milieu d’une crise</b> · ${mono(`${clock(Z.start)}–${clock(Z.end)}`)} (crise annotée de ${mono(clock(Z.seizure[0]))} à ${mono(clock(Z.seizure[1]))})<br>fréquence dominante ${mono(nf(Z.dominant_hz, 1) + " Hz")} · amplitude moyenne ${mono(nf(Z.rms_uv) + " µV")}</figcaption></figure>
        </div>
        <div class="cmp-text">
          <p>Les deux extraits durent ${mono(nf(D.length_s))} s et sont dessinés à la même échelle, si bien que le fond normal paraît presque plat : son activité est irrégulière et de faible amplitude. ` +
          `À droite, le tracé devient régulier : une pointe brève suivie d’une onde lente, répétée environ ${mono(nf(Z.dominant_hz, 1))} fois par seconde, ` +
          `sur toutes les voies en même temps${ratio ? `, avec une amplitude moyenne ${mono(nf(ratio, 1))} fois plus grande` : ""}.</p>
          <p class="note-small">La fréquence est mesurée sur l’extrait (maximum du spectre moyen des ${mono(D.n_eeg)} voies, résolution ${mono(nf(Z.resolution_hz, 3) + " Hz")}). ` +
          `L’extrait de crise est, parmi les ${Z.n_candidates} crises de plus de ${nf(D.length_s)} s de cet enregistrement, celle dont le rythme est le plus net ; ` +
          `le fond normal est un passage typique choisi loin des crises et des événements du journal.</p>
        </div>
      </section>`);
    }
    // --- carte 10-20
    parts.push(`<section class="cmp-section cmp-head">
      <figure class="head-fig">${headMap()}</figure>
      <div class="cmp-text">
        <h2 class="h2">Où sont placées les électrodes</h2>
        <p>Les ${mono(Object.keys(ELECTRODES).length)} électrodes suivent le système international 10-20 : elles sont réparties sur le crâne à des distances proportionnelles à sa taille, le nez en haut du schéma.</p>
        <p>Le nom se lit simplement : la lettre donne la région (Fp, F, C, T, P, O), un chiffre impair désigne le côté gauche, un chiffre pair le côté droit, et « z » la ligne médiane.</p>
        <p class="elec-info" id="cmp-elec-info" aria-live="polite">Survolez ou sélectionnez une électrode.</p>
        <p class="note-small">Les voies présentes dans les extraits ci-dessus sont entourées ; leur ligne s’éclaire quand on survole l’électrode.</p>
      </div>
    </section>`);
    // --- ce qui n'est pas une crise
    const notCrisis = [];
    if (D.saturation) {
      const T = D.saturation;
      const near = (T.near_detection || []).filter(d => !d.hit);
      notCrisis.push(`<div class="cmp-row">
        <figure><canvas id="cmp-sat" class="fig-canvas small"></canvas>
          <figcaption class="caption">${mono(`${clock(T.start)}–${clock(T.end)}`)} · trait jaune : saturation consignée à ${mono(clock(T.time_s, 1))} (${esc(T.channels.join(", "))})</figcaption></figure>
        <div class="cmp-text">
          <h3 class="h3">Une saturation de l’amplificateur</h3>
          <p>Le journal de l’examen signale ${plural(T.n_events, "saturation", "saturations")} sur cet enregistrement. Une saturation est un incident technique : l’amplificateur d’une voie arrive en butée et le signal enregistré n’a plus de sens. ` +
          `Elle touche une ou deux voies (ici ${esc(T.channels.join(" et "))}), alors qu’une absence apparaît sur toutes en même temps.</p>
          ${near.length ? `<p>Le modèle, qui moyenne ses mesures sur toutes les voies, peut pourtant s’y laisser prendre : ${near.map(d => `la fausse alarme D${d.n} (${mono(`${clock(d.start)}–${clock(d.end)}`)})`).join(", ")} tombe à moins de ${mono(nf(T.tolerance_s))} s de cette saturation.</p>` : ""}
        </div>
      </div>`);
    }
    if (D.ecg && D.ecg.bpm) {
      const E = D.ecg;
      notCrisis.push(`<div class="cmp-row">
        <figure><canvas id="cmp-ecg" class="fig-canvas small"></canvas>
          <figcaption class="caption">${mono(`${clock(E.start)}–${clock(E.end)}`)} · voie ECG et deux voies temporales, chacune à sa propre échelle</figcaption></figure>
        <div class="cmp-text">
          <h3 class="h3">Le battement du cœur</h3>
          <p>La voie ECG enregistre le cœur : ${mono(E.beats)} battements repérés en ${mono(nf(D.length_s))} s, soit environ ${mono(nf(E.bpm))} par minute, à intervalles très réguliers (variation ${mono(pct(E.rr_cv, 0))}). ` +
          `Ce rythme régulier n’a rien d’une crise. Le modèle n’utilise que les voies EEG, mais l’activité cardiaque peut s’y retrouver en petit, surtout sur les voies temporales : il doit apprendre à ne pas la confondre avec une décharge.</p>
        </div>
      </div>`);
    }
    if (notCrisis.length) parts.push(`<section class="cmp-section"><h2 class="h2">Ce qui n’est pas une crise</h2>${notCrisis.join("")}</section>`);
    // --- protocole
    const PR = D.protocol, J = PR.cohort;
    const ev = PR.events;
    const hpn = ev.filter(e => e.type === "hpn"), sli = ev.filter(e => e.type === "sli");
    parts.push(`<section class="cmp-section">
      <h2 class="h2">Le déroulé de l’examen</h2>
      <figure class="protocol-fig"><div id="cmp-protocol"></div>
        <figcaption class="caption">${DEMO}, de bout en bout : événements du journal (en bleu) et crises annotées (en vert).</figcaption></figure>
      <div class="cmp-text columns">
        <p><b>Yeux ouverts, yeux fermés.</b> Le technicien demande au patient d’ouvrir puis de fermer les yeux ; le journal le note « YO » et « YF ». Fermer les yeux fait apparaître le rythme alpha à l’arrière du crâne.</p>
        <p><b>Hyperpnée.</b> Le patient respire profondément pendant quelques minutes${hpn.length ? ` (« ${esc(hpn[0].label)} » ici, de ${mono(clock(hpn[0].time_s))} à ${mono(clock(hpn[0].end_s))})` : ""}. C’est une épreuve classique pour déclencher les absences. ` +
        (J && J.seizures ? `Sur les ${J.recordings} enregistrements annotés dont le journal est disponible, ${mono(J.hpn.seizures)} des ${mono(J.seizures)} crises surviennent pendant une hyperpnée, qui ne couvre pourtant que ${mono(pct(J.hpn.seconds / J.seconds, 0))} du temps enregistré.` : "") + `</p>
        <p><b>Stimulation lumineuse intermittente.</b> Une lampe clignote à des fréquences croissantes${sli.length ? ` (« ${esc(sli[0].label)} », de ${mono(clock(sli[0].time_s))} à ${mono(clock(sli[0].end_s))})` : ""}. ` +
        (J && J.seizures ? `Elle regroupe ${mono(J.sli.seizures)} crises pour ${mono(pct(J.sli.seconds / J.seconds, 0))} du temps.` : "") + `</p>
      </div>
    </section>`);
    $("#cmp-body").innerHTML = parts.join("");
    this.bindHead();
    for (const id of ["cmp-normal", "cmp-seizure", "cmp-sat", "cmp-ecg"]) {
      const cv = $("#" + id);
      if (cv) onResize(cv, () => this.drawAll());
    }
    onResize($("#cmp-protocol"), () => this.drawProtocol());
  },
  drawAll() {
    if (!this.data || ROUTE.page !== "comprendre") return;
    const D = this.data;
    if (D.normal && D.seizure) {
      const scaleFrom = D.seizure.excerpt;
      const cvS = $("#cmp-seizure");
      const opts = { highlight: this.hover, scaleBar: true, padTop: 40, relative: true };
      const gS = drawExcerpt(cvS, scaleFrom, { ...opts, bands: [] });
      drawExcerpt($("#cmp-normal"), D.normal.excerpt, { ...opts, uvPerPx: gS.uvPerPx });
      this.callouts(gS, D.seizure);
    }
    if (D.saturation) {
      const T = D.saturation;
      const g = drawExcerpt($("#cmp-sat"), T.excerpt, { scaleBar: true, padTop: 14 });
      const x = g.t2x(T.time_s);
      g.ctx.fillStyle = C.butter; g.ctx.fillRect(x - 2, g.y0 - 10, 4, g.y1 - g.y0 + 10);
      g.ctx.fillStyle = C["butter-edge"]; g.ctx.fillRect(Math.round(x), g.y0 - 10, 1, g.y1 - g.y0 + 10);
    }
    if (D.ecg && D.ecg.bpm) {
      const E = D.ecg, ex = E.excerpt;
      const cv = $("#cmp-ecg");
      const g = drawExcerpt(cv, { ...ex, channels: ["EEGT3", "EEGT4"] }, { channels: ["ECG", "EEGT3", "EEGT4"], scaleBar: false, padTop: 14,
        uvPerPx: 3 * robustUv(ex, ["EEGT3", "EEGT4"]) / (0.42 * ((cv.clientHeight - 36) / 3)) });
      // l'ECG, beaucoup plus ample, est redessinée à sa propre échelle dans le premier couloir
      const d = ex.data.ECG, ctx = g.ctx;
      const amp = Math.max(...(ex.mode === "raw" ? d.map(Math.abs) : d.max.concat(d.min).map(Math.abs)));
      const k = (g.lane * 0.45) / (amp || 1);
      ctx.fillStyle = C.surface; ctx.fillRect(g.x0, g.y0 - 2, g.x1 - g.x0, g.lane);
      ctx.strokeStyle = C.ink; ctx.beginPath();
      if (ex.mode === "raw") d.forEach((v, i) => { const x = g.t2x(ex.t0 + i * ex.dt), y = g.laneY(0) - v * k; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      else d.min.forEach((v, i) => { const x = g.t2x(ex.t0 + (i + 0.5) * ex.dt); i ? ctx.lineTo(x, g.laneY(0) - d.max[i] * k) : ctx.moveTo(x, g.laneY(0) - d.max[i] * k); ctx.lineTo(x, g.laneY(0) - v * k); });
      ctx.stroke();
      ctx.fillStyle = C["coral-edge"];
      for (const t of E.peaks) ctx.fillRect(Math.round(g.t2x(t)), g.y0 - 10, 1, 6);
    }
    this.drawProtocol();
  },
  callouts(g, Z) {
    const ctx = g.ctx, sw = Z.spike_wave, ex = Z.excerpt;
    ctx.strokeStyle = C["ink-2"]; ctx.fillStyle = C.ink; ctx.lineWidth = 1;
    ctx.font = `500 11px ${C.sans}`; ctx.textBaseline = "alphabetic";
    if (sw) {
      const chans = ex.channels;
      const valAt = (c, t) => { const d = ex.data[c]; const i = Math.round((t - ex.t0) / ex.dt); return Array.isArray(d) ? d[Math.max(0, Math.min(d.length - 1, i))] : 0; };
      // voie où la pointe est la plus ample
      let k = 0, best = -1;
      chans.forEach((c, i) => { const v = Math.abs(valAt(c, sw.spike_t)); if (v > best) { best = v; k = i; } });
      const pt = (t, txt, dx) => {
        const x = g.t2x(t), y = Math.max(g.y0 + 2, Math.min(g.y1 - 2, g.v2y(k, valAt(chans[k], t))));
        const ly = 16, lx = x + dx;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly + 4); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill();
        ctx.textAlign = dx < 0 ? "right" : "left"; ctx.fillText(txt, lx + (dx < 0 ? -3 : 3), ly);
      };
      pt(sw.spike_t, "pointe", -18);
      pt(sw.wave_t, "onde", 18);
      // toutes les voies en même temps
      const xs = Math.round(g.t2x(sw.spike_t)) + 0.5;
      ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = C["lav-edge"];
      ctx.beginPath(); ctx.moveTo(xs, g.y0); ctx.lineTo(xs, g.y1); ctx.stroke(); ctx.restore();
      ctx.fillStyle = C["lav-ink"]; ctx.textAlign = "left";
      const tx = Math.min(g.x1 - 4 - ctx.measureText("toutes les voies en même temps").width, xs + 60);
      ctx.fillText("toutes les voies en même temps", tx, 32);
      ctx.strokeStyle = C["lav-edge"]; ctx.beginPath(); ctx.moveTo(tx - 4, 28); ctx.lineTo(xs + 1, 28); ctx.stroke();
      // une seconde de tracé
      const t1 = Math.min(Z.end - 0.05, sw.spike_t + 1), a = g.t2x(t1 - 1), b = g.t2x(t1), yb = g.y1 - 4;
      ctx.fillStyle = C.surface; ctx.globalAlpha = 0.9; ctx.fillRect(a - 2, yb - 16, b - a + 4, 18); ctx.globalAlpha = 1;
      ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.moveTo(a, yb - 4); ctx.lineTo(a, yb); ctx.lineTo(b, yb); ctx.lineTo(b, yb - 4); ctx.stroke();
      ctx.fillStyle = C.ink; ctx.textAlign = "center";
      ctx.fillText(`1 s ≈ ${nf(Z.dominant_hz, 1)} cycles`, (a + b) / 2, yb - 6);
    }
  },
  drawProtocol() {
    const box = $("#cmp-protocol");
    if (!box || !this.data) return;
    const PR = this.data.protocol, W = Math.max(320, box.clientWidth), H = 74, x0 = 4, x1 = W - 4;
    const t2x = t => x0 + t / PR.duration * (x1 - x0);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Déroulé de l’examen ${DEMO}">`;
    for (const e of PR.events) {
      if (e.type === "hpn" || e.type === "sli") {
        s += svgEl("rect", { x: t2x(e.time_s), y: 14, width: Math.max(2, t2x(e.end_s) - t2x(e.time_s)), height: 10, class: "p-blue" });
        s += svgEl("text", { x: t2x(e.time_s), y: 10, class: "p-blue-t" }, esc(e.label));
      } else if (e.type === "yeux") {
        s += svgEl("line", { x1: t2x(e.time_s), x2: t2x(e.time_s), y1: 26, y2: 32, class: "p-tick" });
        s += svgEl("text", { x: t2x(e.time_s), y: 41, class: "p-eye", "text-anchor": "middle" }, esc(e.label));
      }
    }
    for (const [a, b] of PR.truth) s += svgEl("rect", { x: t2x(a), y: 46, width: Math.max(2, t2x(b) - t2x(a)), height: 8, class: "p-sage" });
    s += svgEl("line", { x1: x0, x2: x1, y1: 58.5, y2: 58.5, class: "p-axis" });
    const step = PR.duration > 2400 ? 600 : 300;
    for (let t = 0; t <= PR.duration; t += step) s += svgEl("text", { x: Math.min(x1 - 16, t2x(t)), y: 71, class: "p-time", "text-anchor": t ? "middle" : "start" }, clock(t));
    s += "</svg>";
    box.innerHTML = s;
  },
  bindHead() {
    const info = $("#cmp-elec-info");
    const shown = new Set(((this.data.seizure || this.data.normal || {}).excerpt || {}).channels || []);
    $$(".elec").forEach(g => {
      const name = g.dataset.e;
      if (shown.has("EEG" + name)) g.classList.add("is-shown");
      const on = () => {
        $$(".elec").forEach(x => x.classList.toggle("is-on", x === g));
        const I = electrodeInfo(name);
        info.innerHTML = `<b class="mono">${name}</b> · région ${I.region} · ${I.side}${shown.has("EEG" + name) ? " · visible dans les extraits" : ""}`;
        this.hover = "EEG" + name; this.drawAll();
      };
      const off = () => { g.classList.remove("is-on"); this.hover = null; this.drawAll(); };
      g.addEventListener("mouseenter", on); g.addEventListener("focus", on);
      g.addEventListener("mouseleave", off); g.addEventListener("blur", off);
    });
  },
};

function headMap() {
  const R = 150, cx = 180, cy = 175, W = 360, H = 345;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="headmap" role="group" aria-label="Système international 10-20 : ${Object.keys(ELECTRODES).length} électrodes, nez en haut">`;
  s += `<path class="h-nose" d="M ${cx - 16} ${cy - R + 3} L ${cx} ${cy - R - 20} L ${cx + 16} ${cy - R + 3}"/>`;
  s += `<path class="h-ear" d="M ${cx - R + 2} ${cy - 22} q -16 4 -16 22 q 0 18 16 22"/>`;
  s += `<path class="h-ear" d="M ${cx + R - 2} ${cy - 22} q 16 4 16 22 q 0 18 -16 22"/>`;
  s += `<circle class="h-head" cx="${cx}" cy="${cy}" r="${R}"/>`;
  s += `<line class="h-guide" x1="${cx}" x2="${cx}" y1="${cy - R}" y2="${cy + R}"/><line class="h-guide" x1="${cx - R}" x2="${cx + R}" y1="${cy}" y2="${cy}"/>`;
  s += `<text class="h-side" x="${cx - R - 26}" y="${cy + R - 6}" text-anchor="start">gauche</text><text class="h-side" x="${cx + R + 26}" y="${cy + R - 6}" text-anchor="end">droite</text>`;
  for (const [name, [x, y]] of Object.entries(ELECTRODES)) {
    const I = electrodeInfo(name);
    s += `<g class="elec" data-e="${name}" tabindex="0" role="button" aria-label="${name}, région ${I.region}, ${I.side}">` +
      `<circle cx="${cx + x * R}" cy="${cy + y * R}" r="15"/><text x="${cx + x * R}" y="${cy + y * R + 4}" text-anchor="middle">${name}</text></g>`;
  }
  return s + "</svg>";
}

// ==========================================================================
// 3. Méthode
// ==========================================================================
const FEATURE_TEXT = {
  Mean: ["µV", "moyenne du signal sur la fenêtre (proche de zéro après filtrage)"],
  Std: ["µV", "écart-type : de combien le signal s’écarte de sa moyenne"],
  Variance: ["µV²", "carré de l’écart-type"],
  Min: ["µV", "valeur la plus basse"],
  Max: ["µV", "valeur la plus haute"],
  Amplitude: ["µV", "écart entre le maximum et le minimum"],
  RMS: ["µV", "amplitude efficace, une sorte de « taille moyenne » du signal"],
  Energy: ["µV²", "somme des carrés : l’énergie totale de la fenêtre"],
  P_Delta: ["µV²", "puissance des ondes lentes delta ({Delta})"],
  Rel_Delta: ["", "part de la puissance totale dans la bande delta"],
  P_Theta: ["µV²", "puissance de la bande thêta ({Theta})"],
  Rel_Theta: ["", "part de la puissance totale dans la bande thêta"],
  P_Alpha: ["µV²", "puissance de la bande alpha ({Alpha})"],
  Rel_Alpha: ["", "part de la puissance totale dans la bande alpha"],
  P_Beta: ["µV²", "puissance des ondes rapides bêta ({Beta})"],
  Rel_Beta: ["", "part de la puissance totale dans la bande bêta"],
  Peak_Freq: ["Hz", "fréquence où le spectre est le plus fort"],
};
const SIZE_FEATS = ["Mean", "Std", "Variance", "Min", "Max", "Amplitude", "RMS", "Energy"];
function fmtSig(v) {
  const a = Math.abs(v);
  return a >= 1000 ? nf(v, 0) : a >= 100 ? nf(v, 1) : a >= 1 ? nf(v, 2) : nf(v, 3);
}

const Methode = {
  data: null,
  async enter() {
    const body = $("#mth-body");
    if (!this.data || !this.data.detection) {
      if (!this.data) stateLine(body, "loading", "Préparation des figures…");
      try { this.data = await api(`/api/methode?rid=${DEMO}`); }
      catch (e) { stateLine(body, "error", "Figures indisponibles", `${capital(e.message)}. ${serverHint}`); return; }
      this.render();
      if (!this.data.detection) {
        try {
          await waitDone("/api/cohort", d => { const p = $("#mth-wait"); if (p) p.textContent = progressText(d); }, isPage("methode"));
          this.data = await api(`/api/methode?rid=${DEMO}`);
          this.render();
        } catch (e) { const p = $("#mth-wait"); if (p && e.name !== "AbortError") p.textContent = "Calcul interrompu : " + e.message; }
      }
    }
    requestAnimationFrame(() => this.drawAll());
  },
  render() {
    const D = this.data, P = D.params, F = P.filter, M = D.model;
    const [s0, e0] = D.seizure;
    $("#mth-lede").innerHTML = `Toutes les figures montrent l’enregistrement ${DEMO} autour de sa première crise annotée (${mono(`${clock(s0)}–${clock(e0)}`)}), ` +
      `avec ${D.channels.length} des ${D.n_eeg} voies pour rester lisible. Chaque étape est celle du notebook, exécutée par le serveur.`;
    const nWin = D.windows.length, nCrise = D.windows.filter(w => w.cls).length;
    const step = (n, title, html, fig) => `<section class="mstep" id="mstep-${n}"><p class="mstep-n">${n}</p><div class="mstep-c"><h2 class="h2">${title}</h2>${html}${fig}</div></section>`;
    const out = [];
    out.push(step(1, "Le signal brut",
      `<p>Le fichier contient, pour chaque voie, la tension mesurée ${mono(nf(D.fs))} fois par seconde. Brut, ce signal mêle l’activité du cerveau à des dérives lentes (mouvements, sueur, contact des électrodes) et à du bruit électrique. Ici, chaque voie est seulement recentrée pour tenir dans son couloir.` +
      (D.raw_power && D.raw_power.peak_hz ? ` La bande sombre qui épaissit le tracé est surtout le bruit du secteur : sur cet extrait, ${mono(pct(D.raw_power.peak_pct / 100, 0))} de la puissance du signal brut se concentre autour de ${mono(nf(D.raw_power.peak_hz, 1))} Hz.` : "") + `</p>`,
      `<figure><canvas id="mth-raw" class="fig-canvas wide"></canvas></figure>`));
    out.push(step(2, `Filtrage de ${nf(F.lo, 1)} à ${nf(F.hi)} Hz`,
      `<p>On retire la valeur médiane de chaque voie, puis un filtre passe-bande (Butterworth d’ordre ${mono(F.order)}, appliqué dans les deux sens pour ne pas décaler le signal) ne garde que les fréquences entre ${mono(nf(F.lo, 1))} et ${mono(nf(F.hi))} Hz. Le même extrait, aligné sur le précédent : les dérives ont disparu, le rythme de la crise ressort.</p>`,
      `<figure><canvas id="mth-filt" class="fig-canvas wide"></canvas></figure>`));
    out.push(step(3, `Des fenêtres de ${nf(P.win_s)} s`,
      `<p>Le signal est découpé en fenêtres de ${mono(nf(P.win_s))} s qui se chevauchent de ${mono(nf(P.overlap * 100))} % : une nouvelle fenêtre commence toutes les ${mono(nf(P.win_s * (1 - P.overlap)))} s. ` +
      `Une fenêtre est étiquetée « crise » si au moins la moitié de sa durée tombe dans une crise annotée. Sur cet extrait, ${mono(nCrise)} fenêtres sur ${mono(nWin)} le sont. ` +
      `Les deux fenêtres entourées de lavande sont comparées à l’étape suivante.</p>`,
      `<figure><canvas id="mth-win" class="fig-canvas wide tall"></canvas><figcaption class="caption"><span class="sw sw-annot"></span> fenêtre « crise » &nbsp; <span class="sw sw-neutral"></span> fenêtre « normale » &nbsp; bande verte : crise annotée</figcaption></figure>`));
    if (D.normal && D.crise) {
      const rows = (keys) => keys.map(k => {
        const a = D.normal.features[k], b = D.crise.features[k], [unit, raw] = FEATURE_TEXT[k];
        const bands = D.normal.spectrum.bands;
        const txt = raw.replace(/\{(\w+)\}/g, (_, n) => bands[n] ? `${nf(bands[n][0], 1).replace(/,0$/, "")}–${nf(bands[n][1])} Hz` : "");
        const ratio = Math.abs(a) > 1e-9 && k !== "Mean" ? b / a : null;
        return `<tr><td class="mono f-code">${k}</td><td class="f-text">${txt}</td><td class="num">${fmtSig(a)}</td><td class="num">${fmtSig(b)}</td>` +
          `<td class="num dim">${unit}</td><td class="num">${ratio != null ? "× " + fmtSig(ratio) : "—"}</td></tr>`;
      }).join("");
      const rythme = Object.keys(FEATURE_TEXT).filter(k => !SIZE_FEATS.includes(k));
      out.push(step(4, `${P.features} caractéristiques par fenêtre`,
        `<p>Chaque fenêtre est résumée par ${mono(P.features)} nombres, calculés voie par voie puis moyennés sur les ${mono(D.n_eeg)} voies. Les uns mesurent la taille du signal, les autres son rythme, à partir du spectre (la transformée de Fourier de la fenêtre).</p>`,
        `<table class="tbl tbl-feat">
          <thead><tr><th>Mesure</th><th>Ce qu’elle décrit</th><th class="num">Fenêtre normale<br><span class="mono">${clock(D.normal.t_start)}–${clock(D.normal.t_end)}</span></th><th class="num">Fenêtre de crise<br><span class="mono">${clock(D.crise.t_start)}–${clock(D.crise.t_end)}</span></th><th class="num">Unité</th><th class="num">Rapport</th></tr></thead>
          <tbody><tr class="grp"><td colspan="6">Taille du signal</td></tr>${rows(SIZE_FEATS)}<tr class="grp"><td colspan="6">Rythme</td></tr>${rows(rythme)}</tbody>
        </table>
        <figure class="spectrum-fig"><div id="mth-spec"></div><figcaption class="caption">Spectre moyen des deux fenêtres (échelle logarithmique), avec les quatre bandes de fréquence.</figcaption></figure>`));
    }
    const pr = M.params;
    out.push(step(5, "Le modèle",
      `<p>Le modèle retenu est une forêt aléatoire (${esc(M.name)}) de ${mono(pr.n_estimators)} arbres de décision. Chaque arbre apprend, sur un tirage différent des données, des règles du type « si la puissance delta dépasse tel seuil et que… ». ` +
      `Pour une nouvelle fenêtre, les arbres votent ; la part des votes « crise » donne une probabilité. ` +
      `Pour ${DEMO}, la forêt est entraînée sur les ${mono(M.trained_on)} autres enregistrements annotés : elle n’a jamais vu ce tracé. ` +
      `Les fenêtres de crise y sont rares, d’où une pondération des classes (${mono(esc(String(pr.class_weight)))}).</p>`,
      `<figure class="balance-fig"><div id="mth-balance"></div><figcaption class="caption">Fenêtres d’entraînement : ${mono(nf(M.n_windows))} au total, dont ${mono(nf(M.seizure_windows))} en crise (${mono(pct(M.seizure_windows / M.n_windows))}).</figcaption></figure>`));
    if (D.detection) {
      const X = D.detection, T = X.totals;
      const raw = X.pred.reduce((a, b) => a + b, 0), sm = X.smoothed.reduce((a, b) => a + b, 0);
      const flips = X.pred.reduce((a, v, i) => a + (v !== X.smoothed[i] ? 1 : 0), 0);
      const fa = X.detections.filter(d => !d[2]).length;
      out.push(step(6, "Des fenêtres aux crises",
        `<p>Sur les ${mono(nf(X.pred.length))} fenêtres de l’enregistrement, ${mono(raw)} sont classées « crise ». Un filtre médian sur ${mono(P.smooth)} fenêtres en modifie ${mono(flips)} (il en reste ${mono(sm)}) : une fenêtre isolée prend la valeur de ses voisines. ` +
        `Les fenêtres consécutives sont ensuite fusionnées en intervalles ; deux détections séparées de ${mono(nf(P.merge_gap_s))} s ou moins sont réunies, et celles de moins de ${mono(nf(P.min_event_s))} s sont écartées. ` +
        `Résultat : ${plural(X.detections.length, "intervalle", "intervalles")}, qui retrouvent ${mono(T.detected)} des ${mono(T.n_true)} crises annotées, et ${plural(fa, "fausse alarme", "fausses alarmes")}.</p>`,
        `<figure><div id="mth-strips"></div><figcaption class="caption">Tout l’enregistrement, de ${mono(clock(0))} à ${mono(clock(X.duration))}. <a href="${lectureHref(DEMO, Math.max(0, s0 - 3))}">Voir la première crise dans la lecture</a></figcaption></figure>`));
    } else {
      out.push(step(6, "Des fenêtres aux crises", `<p class="state-hint" id="mth-wait">${esc(progressText(D.cohort))}</p>`, ""));
    }
    $("#mth-body").innerHTML = out.join("");
    for (const id of ["mth-raw", "mth-filt", "mth-win"]) { const cv = $("#" + id); if (cv) onResize(cv, () => this.drawAll()); }
    for (const id of ["mth-spec", "mth-strips", "mth-balance"]) { const el = $("#" + id); if (el) onResize(el, () => this.drawAll()); }
  },
  drawAll() {
    if (!this.data || ROUTE.page !== "methode") return;
    const D = this.data, [s0, e0] = D.seizure;
    const band = [{ start: s0, end: e0, fill: C.sage, edge: C["sage-edge"] }];
    // brut : chaque voie recentrée sur sa médiane
    const raw = JSON.parse(JSON.stringify(D.raw));
    for (const c of raw.channels) {
      const d = raw.data[c];
      if (Array.isArray(d)) { const m = median(d); raw.data[c] = d.map(v => v - m); }
      else { const m = median(d.min.map((v, i) => (v + d.max[i]) / 2)); raw.data[c] = { min: d.min.map(v => v - m), max: d.max.map(v => v - m) }; }
    }
    drawExcerpt($("#mth-raw"), raw, { scaleBar: true, bands: band, laneScale: 0.22 });
    const gF = drawExcerpt($("#mth-filt"), D.filtered, { scaleBar: true, bands: band });
    // fenêtres
    const cv = $("#mth-win");
    const g = drawExcerpt(cv, D.filtered, { channels: D.filtered.channels.slice(0, 2), scaleBar: true, padTop: 44, bands: band, uvPerPx: gF.uvPerPx });
    const ctx = g.ctx;
    D.windows.forEach((w, i) => {
      const a = g.t2x(w.t_start) + 1, b = g.t2x(w.t_end) - 1, y = 6 + (i % 2) * 16;
      ctx.fillStyle = w.cls ? C.sage : C["paper-2"]; ctx.fillRect(a, y, b - a, 12);
      ctx.strokeStyle = w.cls ? C["sage-edge"] : C["rule-strong"]; ctx.strokeRect(Math.round(a) + 0.5, y + 0.5, Math.round(b - a) - 1, 11);
    });
    for (const [key, txt] of [["normal", "normale"], ["crise", "crise"]]) {
      const W0 = D[key]; if (!W0) continue;
      const i = D.windows.findIndex(w => w.n === W0.window);
      const a = g.t2x(W0.t_start), b = g.t2x(W0.t_end), y = 6 + (i % 2) * 16;
      ctx.strokeStyle = C["lav-edge"]; ctx.lineWidth = 2; ctx.strokeRect(a - 1, y - 1, b - a + 2, 14); ctx.lineWidth = 1;
      ctx.fillStyle = C["lav-ink"]; ctx.font = `500 10px ${C.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(txt, (a + b) / 2, 35);
    }
    this.drawSpectrum(); this.drawBalance(); this.drawStrips();
  },
  drawSpectrum() {
    const box = $("#mth-spec"); if (!box || !this.data.normal) return;
    const A = this.data.normal.spectrum, B = this.data.crise.spectrum;
    const W = Math.max(320, box.clientWidth), H = 220, x0 = 46, x1 = W - 10, y0 = 18, y1 = H - 26;
    const fmax = A.freqs[A.freqs.length - 1];
    const all = A.psd.concat(B.psd).filter(v => v > 0);
    const lo = Math.log10(Math.max(1e-3, Math.min(...all))), hi = Math.log10(Math.max(...all));
    const fx = f => x0 + f / fmax * (x1 - x0), py = v => y1 - (Math.log10(Math.max(v, 1e-9)) - lo) / (hi - lo) * (y1 - y0);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Spectre des deux fenêtres">`;
    Object.entries(A.bands).forEach(([name, [a, b]], i) => {
      s += svgEl("rect", { x: fx(a), y: y0, width: fx(b) - fx(a), height: y1 - y0, class: i % 2 ? "sp-band b" : "sp-band" });
      s += svgEl("text", { x: (fx(a) + fx(b)) / 2, y: y0 - 5, class: "sp-blabel", "text-anchor": "middle" }, name);
    });
    for (let p = Math.ceil(lo); p <= hi; p++) {
      s += svgEl("line", { x1: x0, x2: x1, y1: py(10 ** p), y2: py(10 ** p), class: "sp-grid" });
      s += svgEl("text", { x: x0 - 6, y: py(10 ** p) + 4, "text-anchor": "end", class: "sp-tick" }, `10${p < 0 ? "⁻" : ""}${String(Math.abs(p)).split("").map(d => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d]).join("")}`);
    }
    for (let f = 0; f <= fmax; f += 10) s += svgEl("text", { x: fx(f), y: H - 8, "text-anchor": f === 0 ? "start" : f + 10 > fmax ? "end" : "middle", class: "sp-tick" }, `${f} Hz`);
    const line = (S, cls) => `<polyline class="${cls}" points="${S.freqs.map((f, i) => `${fx(f).toFixed(1)},${py(S.psd[i]).toFixed(1)}`).join(" ")}"/>`;
    s += line(A, "sp-normal") + line(B, "sp-crise");
    s += svgEl("text", { x: x1 - 4, y: y0 + 16, "text-anchor": "end", class: "sp-legend crise" }, "fenêtre de crise");
    s += svgEl("text", { x: x1 - 4, y: y0 + 32, "text-anchor": "end", class: "sp-legend normal" }, "fenêtre normale");
    box.innerHTML = s + "</svg>";
  },
  drawBalance() {
    const box = $("#mth-balance"); if (!box) return;
    const M = this.data.model, W = Math.max(320, box.clientWidth), f = M.seizure_windows / M.n_windows;
    box.innerHTML = `<svg viewBox="0 0 ${W} 22" width="${W}" height="22" role="img" aria-label="Proportion de fenêtres de crise">` +
      svgEl("rect", { x: 0, y: 4, width: W, height: 14, class: "bal-all" }) +
      svgEl("rect", { x: 0, y: 4, width: Math.max(2, W * f), height: 14, class: "bal-crise" }) + "</svg>";
  },
  drawStrips() {
    const box = $("#mth-strips"); const X = this.data.detection; if (!box || !X) return;
    const W = Math.max(360, box.clientWidth), lx = 150, x1 = W - 6, dur = X.duration;
    const t2x = t => lx + t / dur * (x1 - lx);
    const rows = [["fenêtres « crise »", 10], ["après lissage", 34], ["intervalles détectés", 58], ["crises annotées", 82]];
    let s = `<svg viewBox="0 0 ${W} 112" width="${W}" height="112" role="img" aria-label="Prédictions par fenêtre, lissage, intervalles détectés et crises annotées">`;
    rows.forEach(([t, y]) => { s += svgEl("text", { x: 0, y: y + 11, class: "st-label" }, t); s += svgEl("line", { x1: lx, x2: x1, y1: y + 16.5, y2: y + 16.5, class: "st-base" }); });
    const ticks = (arr, y, cls) => {
      let d = "";
      arr.forEach((v, i) => { if (v) { const x = t2x(X.t_start[i] + 1); d += `M${x.toFixed(1)} ${y}v16`; } });
      return `<path class="${cls}" d="${d}"/>`;
    };
    s += ticks(X.pred, 10, "st-win") + ticks(X.smoothed, 34, "st-win");
    for (const [a, b, hit] of X.detections) s += svgEl("rect", { x: t2x(a), y: 58, width: Math.max(2, t2x(b) - t2x(a)), height: 16, class: hit ? "st-det" : "st-det fa" });
    for (const [a, b] of X.truth) s += svgEl("rect", { x: t2x(a), y: 82, width: Math.max(2, t2x(b) - t2x(a)), height: 16, class: "st-truth" });
    s += svgEl("text", { x: lx, y: 110, class: "st-time" }, clock(0)) + svgEl("text", { x: x1, y: 110, class: "st-time", "text-anchor": "end" }, clock(dur));
    box.innerHTML = s + "</svg>";
  },
};

// ==========================================================================
// 8. Limites et pistes
// ==========================================================================
const Limites = {
  async enter() {
    const body = $("#lim-body");
    if (!body.dataset.ready) stateLine(body, "loading", "Chargement…");
    let S0;
    try { S0 = await Summary.get(); }
    catch (e) { stateLine(body, "error", "Page indisponible", `${capital(e.message)}. ${serverHint}`); return; }
    this.render(S0);
    if (S0.cohort.status !== "done" || S0.groupkfold.status !== "done") {
      try {
        await waitDone("/api/cohort", null, isPage("limites"));
        await waitDone("/api/groupkfold", null, isPage("limites"));
        this.render(await Summary.get(true));
      } catch (_) { /* la page reste lisible sans ces chiffres */ }
    }
  },
  render(S0) {
    const P = S0.params, E = S0.evaluation, G = S0.groupkfold_scores, B = S0.best_model, ER = S0.errors;
    const fracCrise = S0.seizure_windows / S0.windows;
    // demo : démonstration en direct sous la limite (outils.js, LimDemo)
    const item = (title, text, demo) => `<div class="lim-item"><h3 class="h3">${title}</h3><p>${text}</p>` +
      (demo ? `<button type="button" class="btn btn-quiet lim-demo" data-demo="${demo}" aria-expanded="false">Démontrer</button><div class="lim-demo-out" hidden></div>` : "") + `</div>`;
    const choix = [
      item(`Des fenêtres de ${nf(P.win_s)} s, qui se chevauchent de moitié`,
        `Assez courtes pour situer le début d’une crise à la seconde près, assez longues pour contenir plusieurs cycles de pointe-onde : la plus courte des crises annotées dure ${mono(nf(S0.seizure_s.min))} s.`),
      item("La moyenne des voies",
        `Une absence est généralisée : elle touche toutes les voies à la fois. Moyenner les ${mono(P.features)} mesures sur les ${mono(S0.eeg_channels)} voies donne un résumé court et peu sensible à une électrode défaillante, au prix de toute information de localisation.`),
      item("La pondération des classes",
        `Les fenêtres de crise ne représentent que ${mono(pct(fracCrise))} des ${mono(nf(S0.windows))} fenêtres. Sans pondération, un modèle qui répondrait toujours « pas de crise » aurait raison ${mono(pct(1 - fracCrise))} du temps, sans rien détecter. Le seuil de décision (0,5) est lui aussi un choix : il fixe le compromis entre crises trouvées et fausses alarmes.`, "seuil"),
      item("Une validation par enregistrement",
        `Deux fenêtres voisines se recouvrent à moitié : avec un découpage aléatoire, l’une peut servir à l’entraînement et l’autre au test, ce qui flatte le score. ` +
        (G ? `Évalué enregistrement par enregistrement, le F1 du ${esc(B.name)} passe de ${mono(nf(B.f1_random, 3))} à ${mono(nf(G["F1-score"], 3))}.` : `Le score par enregistrement est en cours de calcul.`), "optimiste"),
    ];
    const ages = S0.ages;
    const atyp = Object.entries(S0.type_abs);
    const limites = [
      item("Une petite cohorte",
        `${mono(S0.recordings)} enregistrements, dont ${mono(S0.annotated)} annotés, soit ${mono(nf(S0.hours_total, 1))} h de signal et ${mono(S0.seizures)} crises. ` +
        `Le nombre de patients n’est pas connu : les données ne contiennent pas d’identifiant patient, et deux enregistrements peuvent venir de la même personne.`, "donnees"),
      ages ? item("Surtout des enfants",
        `Les âges vont de ${mono(nf(ages.min))} à ${mono(nf(ages.max))} ans (médiane ${mono(nf(ages.median))} ans) ; ${ages.adults === 1 ? "un seul patient est adulte" : `${mono(ages.adults)} patients sont adultes`}. Rien ne garantit que le modèle se comporte de la même façon chez l’adulte.`, "adulte") : "",
      atyp.length ? item("Des absences atypiques à peine représentées",
        `${atyp.map(([t, n]) => `${mono(n)} enregistrement${n > 1 ? "s" : ""} marqué${n > 1 ? "s" : ""} « ${esc(t)} »`).join(", ")} : trop peu pour savoir si le modèle reconnaît ces formes, plus irrégulières.`) : "",
      ER ? item("Les artefacts ne sont pas traités",
        `${mono(ER.fa_near_saturation)} des ${mono(ER.false_alarms)} fausses alarmes ${ER.fa_near_saturation > 1 ? "tombent" : "tombe"} à moins de ${mono(nf(ER.tolerance_s))} s d’une saturation consignée dans le journal. Le modèle n’a aucun moyen de reconnaître un artefact : il ne voit que des nombres.`, "artefacts") : "",
      E ? item("Des crises manquées, concentrées",
        `${mono(E.events.missed)} des ${mono(E.events.n_true)} crises annotées ne sont pas retrouvées${E.events.with_missed.length ? `, toutes dans ${E.events.with_missed.map(r => `<a class="mono" href="${lectureHref(r)}">${esc(r)}</a>`).join(", ")}` : ""}. ` +
        `Avec si peu d’exemples, un enregistrement atypique pèse lourd.`) : "",
      item("Des données rétrospectives",
        "Les enregistrements ont été faits pour le soin, pas pour cette étude ; les annotations ont été posées une fois, sans double lecture connue."),
      item("Aucune validation clinique",
        "Les scores mesurent l’accord avec les annotations disponibles, pas un bénéfice pour le patient. L’outil propose des intervalles à vérifier ; il ne pose pas de diagnostic."),
    ];
    const pistes = [
      item("Des mesures par voie", "Garder les caractéristiques de chaque voie, ou de chaque région, au lieu de leur moyenne : le modèle pourrait alors exiger qu’un motif soit présent partout à la fois."),
      item("Des mesures propres aux absences", "Puissance entre 2,5 et 4 Hz, harmoniques du rythme de pointe-onde, longueur de ligne (line length), paramètres de Hjorth (activité, mobilité, complexité)."),
      item("Se servir du journal d’examen", "Masquer les segments où une saturation est consignée, et tenir compte des épreuves d’activation (hyperpnée, stimulation lumineuse)."),
      item("Le contexte temporel", "Classer chaque fenêtre en tenant compte des précédentes, par exemple avec un modèle de Markov caché ou un réseau récurrent, plutôt qu’avec un simple filtre médian."),
      item("Annoncer une crise avant son début", `Ce projet détecte les crises une fois qu’elles ont commencé. Un essai exploratoire d’anticipation est présenté sur la page <a href="#/anticipation">Anticipation</a>.`),
      item("Apprendre sur le signal brut", "Un réseau de neurones convolutif pourrait apprendre lui-même ses mesures ; il faudrait toutefois bien plus d’enregistrements que ceux dont nous disposons."),
    ];
    const sec = (k, title, items) => `<section class="lim-section"><div class="lim-side"><p class="kicker">${k}</p><h2 class="h2">${title}</h2></div><div class="lim-items">${items.filter(Boolean).join("")}</div></section>`;
    $("#lim-body").innerHTML = sec("I", "Choix méthodologiques", choix) + sec("II", "Limites", limites) + sec("III", "Pistes", pistes);
    $("#lim-body").dataset.ready = "1";
    LimDemo.mount();
  },
};
