/* ==========================================================================
   Absences — page Méthode : visite guidée et animée de la vraie chaîne, sur un
   segment de 20 s centré sur une crise annotée (/api/methode/tour).
   Animations en canvas / SVG / CSS ; aucune si prefers-reduced-motion.
   ========================================================================== */
"use strict";

const MethodeTour = (() => {
  const STEPS = [
    { k: "brut", n: "Signal brut", ic: "〰", t: "Le signal tel qu’il sort de l’appareil",
      x: "Chaque électrode enregistre une tension en microvolts, 256 fois par seconde. Le tracé brut porte un décalage continu propre à chaque voie et du bruit rapide : le trait paraît « épais ».",
      w: "Le modèle ne peut pas comparer des voies et des patients si chacun a son propre décalage et son propre bruit." },
    { k: "filtre", n: "Filtrage", ic: "⌇", t: "Garder la bande utile",
      x: "On retire la médiane de chaque voie, puis un filtre passe-bande ne garde que les fréquences utiles, appliqué dans les deux sens pour ne pas décaler le signal. Faites glisser la poignée pour comparer.",
      w: "Les pointes-ondes d’une absence vivent autour de 3 Hz : la dérive lente et le bruit secteur ou musculaire ne font que gêner." },
    { k: "fenetres", n: "Fenêtres", ic: "▭", t: "Découper en fenêtres qui se chevauchent",
      x: "Le signal filtré est découpé en fenêtres de 2 s, décalées de 1 s : chaque fenêtre recouvre la moitié de la précédente. Une fenêtre est étiquetée « crise » si au moins la moitié de sa durée est dans la crise annotée.",
      w: "Une fenêtre courte situe le début d’une crise à la seconde près ; le recouvrement évite de couper une pointe-onde en deux." },
    { k: "carac", n: "Caractéristiques", ic: "▤", t: "Résumer chaque fenêtre en 17 nombres",
      x: "Pour chaque voie : taille du signal (écart-type, amplitude, énergie…) et rythme (puissance de chaque bande, fréquence du pic), puis moyenne sur les voies. Déplacez la fenêtre : les barres grandissent quand elle entre dans la crise.",
      w: "Un modèle de classification compare des nombres, pas des courbes. Chaque barre est placée face à la cohorte : médiane hors crise (bleu) et en crise (rose)." },
    { k: "modele", n: "Modèle", ic: "🌲", t: "300 arbres votent",
      x: "Le Random Forest a été entraîné sur les autres enregistrements uniquement. Chaque arbre donne sa probabilité de crise ; la forêt en fait la moyenne. Au-dessus de 0,5, la fenêtre est classée « crise ».",
      w: "Beaucoup d’arbres un peu différents se trompent moins qu’un seul : leur moyenne est plus stable." },
    { k: "detect", n: "Crises détectées", ic: "✓", t: "Des fenêtres aux crises",
      x: "Trois règles transforment les décisions fenêtre par fenêtre en intervalles : lissage médian, fusion des détections proches, suppression des détections trop courtes.",
      w: "Le médecin a besoin d’un début et d’une fin de crise, pas de 20 décisions isolées." },
  ];
  const T = { D: null, step: 0, playing: false, timer: 0, raf: 0, win: 0, rid: "230102B-F", n: 1, split: 0.5, resid: false, built: false };
  const RM = () => reducedMotion();

  async function enter(r) {
    const body = $("#mth-body");
    if (!T.built) {
      let recs = [];
      try { recs = (await api("/api/recordings")).filter(x => x.annotated && x.in_training_set); } catch (_) { /* liste vide */ }
      T.recs = recs;
      body.innerHTML = `
        <div class="filters lab-controls mt-controls"><label class="field"><span class="tool-label">Enregistrement</span><select id="mt-rec">${recs.map(x => `<option value="${x.id}">${x.id} · ${plural(x.n_seizures, "crise", "crises")}</option>`).join("")}</select></label>
          <label class="field"><span class="tool-label">Crise</span><select id="mt-sz"></select></label>
          <span class="mt-play"><button type="button" class="btn btn-quiet" id="mt-prev">◀ Précédent</button><button type="button" class="btn" id="mt-auto">Lecture automatique ▶</button><button type="button" class="btn btn-quiet" id="mt-next">Suivant ▶</button></span></div>
        <ol class="mt-stepper" id="mt-stepper">${STEPS.map((s, i) => `<li><button type="button" data-i="${i}"><span class="mt-n">${i + 1}</span>${s.n}</button></li>`).join("")}</ol>
        <div class="mt-progress" aria-hidden="true"><span id="mt-bar"></span></div>
        <section class="mt-stage lab-card" aria-live="polite"><h2 class="h2 mt-title" id="mt-title"></h2><p class="body mt-x" id="mt-x"></p><p class="mt-why" id="mt-why"></p><div id="mt-view" class="mt-view"></div></section>
        <h3 class="h3 mt-rh">La chaîne en un coup d’œil</h3><div class="mt-recap" id="mt-recap"></div>`;
      $("#mt-rec").value = T.rid;
      $("#mt-rec").addEventListener("change", e => { T.rid = e.target.value; T.n = 1; load(); });
      $("#mt-sz").addEventListener("change", e => { T.n = +e.target.value; load(); });
      $("#mt-prev").addEventListener("click", () => { pause(); show(T.step - 1); });
      $("#mt-next").addEventListener("click", () => { pause(); show(T.step + 1); });
      $("#mt-auto").addEventListener("click", () => (T.playing ? pause() : play()));
      $("#mt-stepper").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { pause(); show(+b.dataset.i); } });
      onResize($("#mt-view"), () => T.D && draw(false));
      T.built = true;
    }
    if (!T.D) await load();
  }

  async function load() {
    stop();
    stateLine($("#mt-view"), "loading", "Calcul du segment : filtrage, fenêtres, caractéristiques, votes des arbres…");
    try { T.D = await api(`/api/methode/tour?rid=${encodeURIComponent(T.rid)}&n=${T.n}`); }
    catch (e) { stateLine($("#mt-view"), "error", "Segment indisponible", e.message); return; }
    const D = T.D, P = D.params;
    $("#mt-sz").innerHTML = Array.from({ length: D.n_seizures }, (_, i) => `<option value="${i + 1}">crise ${i + 1}</option>`).join("");
    $("#mt-sz").value = D.n;
    $("#mth-lede").innerHTML = `Six étapes, sur un vrai extrait : ${esc(D.id)}, de ${mono(clock(D.start))} à ${mono(clock(D.end))}, autour de la crise annotée ${mono(D.n)} (${mono(clock(D.seizure[0], 1))}–${mono(clock(D.seizure[1], 1))}). Le modèle est un ${esc(P.model)} entraîné sur les ${mono(P.trained_on)} autres enregistrements.`;
    const W = D.windows; T.win = Math.max(0, W.cls.indexOf(1));
    $("#mt-recap").innerHTML = [`${nf(P.lo, 1)}–${nf(P.hi)} Hz`, `${nf(P.win_s)} s · ${nf(100 * P.overlap)} %`, `${P.features} caractéristiques`, `${P.trees} arbres`,
      `lissage ${P.smooth} · fusion ${nf(P.merge_gap_s)} s · min. ${nf(P.min_event_s)} s`, D.error ? `écart début ${fmtS(D.error.start)}` : "crise manquée"]
      .map((p, i) => `<button type="button" class="mt-ri" data-i="${i}"><span class="mt-ric">${STEPS[i].ic}</span><span class="mt-rin">${i + 1}. ${STEPS[i].n}</span><span class="mt-rip">${p}</span></button>`).join("");
    $$("#mt-recap button").forEach(b => b.addEventListener("click", () => { pause(); show(+b.dataset.i); $("#mt-stepper").scrollIntoView({ behavior: RM() ? "auto" : "smooth" }); }));
    show(0);
  }

  function show(i) {
    T.step = (i + STEPS.length) % STEPS.length;
    const S = STEPS[T.step];
    $$("#mt-stepper button").forEach((b, k) => { b.classList.toggle("is-on", k === T.step); b.classList.toggle("is-done", k < T.step); b.setAttribute("aria-current", k === T.step ? "step" : "false"); });
    $("#mt-title").textContent = `${T.step + 1}. ${S.t}`;
    $("#mt-x").textContent = S.x;
    $("#mt-why").innerHTML = `<b>Pourquoi ?</b> ${esc(S.w)}`;
    $("#mt-bar").style.width = `${100 * (T.step + 1) / STEPS.length}%`;
    const v = $("#mt-view");
    v.classList.remove("mt-in"); void v.offsetWidth; v.classList.add("mt-in");
    v.innerHTML = VIEWS[S.k]();
    draw(true);
  }
  function play() {
    T.playing = true; $("#mt-auto").textContent = "Pause ❚❚";
    const tick = () => { T.timer = setTimeout(() => { if (!T.playing) return; if (T.step === STEPS.length - 1) { pause(); return; } show(T.step + 1); tick(); }, 6000); };
    show(T.step); tick();
  }
  function pause() { T.playing = false; clearTimeout(T.timer); const b = $("#mt-auto"); if (b) b.textContent = "Lecture automatique ▶"; }
  function stop() { pause(); cancelAnimationFrame(T.raf); }
  /* anime fn(p) de 0 à 1 en `ms` ; immédiat si mouvement réduit */
  function animate(ms, fn, done) {
    cancelAnimationFrame(T.raf);
    if (RM() || ms <= 0) { fn(1); if (done) done(); return; }
    const t0 = performance.now();
    const f = now => { const p = Math.min(1, (now - t0) / ms); fn(p); if (p < 1) T.raf = requestAnimationFrame(f); else if (done) done(); };
    T.raf = requestAnimationFrame(f);
  }

  // ---------------------------------------------------------------- tracés multivoies
  function traces(cv, rows, o = {}) {
    const D = T.D, { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const x0 = 40, x1 = w - 8, y0 = 8, y1 = h - 20, lane = (y1 - y0) / rows.length;
    const t2x = t => x0 + (t - D.start) / (D.end - D.start) * (x1 - x0);
    const [sa, sb] = D.seizure;
    ctx.fillStyle = C.sage; ctx.globalAlpha = 0.5; ctx.fillRect(Math.max(x0, t2x(sa)), y0, Math.min(x1, t2x(sb)) - Math.max(x0, t2x(sa)), y1 - y0); ctx.globalAlpha = 1;
    ctx.strokeStyle = C["grid-major"]; ctx.beginPath();
    for (let t = Math.ceil(D.start); t <= D.end; t++) { ctx.moveTo(crisp(t2x(t)), y0); ctx.lineTo(crisp(t2x(t)), y1); } ctx.stroke();
    if (o.under) o.under(ctx, t2x, y0, y1);
    const uv = o.uv || 120;
    rows.forEach((r, k) => {
      const yc = y0 + lane * (k + 0.5), lim = lane * 0.75;
      for (const seg of r.segs) {
        ctx.save(); ctx.beginPath(); ctx.rect(seg.xa != null ? seg.xa : x0, y0, (seg.xb != null ? seg.xb : x1) - (seg.xa != null ? seg.xa : x0), y1 - y0); ctx.clip();
        ctx.strokeStyle = seg.color; ctx.lineWidth = seg.lw || 1; ctx.beginPath();
        const d = seg.data, n = Math.floor(d.length * (o.upTo != null ? o.upTo : 1)), c = seg.center || 0;
        for (let i = 0; i < n; i++) { const x = t2x(D.start + i * D.dt), y = yc - Math.max(-lim, Math.min(lim, (d[i] - c) / uv * lane * 0.45)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke(); ctx.restore();
      }
      ctx.fillStyle = C["ink-2"]; ctx.font = `10.5px ${C.mono}`; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(r.label, x0 - 6, yc);
      if (r.note) { ctx.textAlign = "left"; ctx.fillStyle = C["ink-3"]; ctx.font = `10px ${C.mono}`; ctx.fillText(r.note, x0 + 4, yc - lane * 0.38); }
    });
    ctx.fillStyle = C["ink-3"]; ctx.font = `10px ${C.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let t = Math.ceil(D.start / 2) * 2; t <= D.end; t += 2) ctx.fillText(clock(t), t2x(t), y1 + 5);
    if (o.over) o.over(ctx, t2x, y0, y1);
    return { t2x, x0, x1, y0, y1 };
  }
  const median_ = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  // ---------------------------------------------------------------- vues
  const VIEWS = {
    brut: () => `<canvas class="mt-cv" id="mt-cv"></canvas><p class="lab-legend"><span><span class="sw sw-annot"></span>crise annotée</span><span class="lab-dim">Chaque voie est centrée sur son décalage, indiqué à côté de son nom ; échelle commune.</span></p>`,
    filtre: () => `<div class="mt-two"><div><canvas class="mt-cv" id="mt-cv"></canvas><p class="lab-legend"><span class="lab-dim">À gauche de la poignée : filtré ; à droite : brut.</span><label class="field check"><input type="checkbox" id="mt-resid" ${T.resid ? "checked" : ""}> montrer seulement ce qui est retiré</label></p></div>
      <figure class="lab-card mt-spec"><figcaption class="tool-label">Spectre du segment (moyenne des voies)</figcaption><div id="mt-spec"></div><p class="lab-legend"><span><i class="lab-k" style="background:#B9AEB4"></i>brut</span><span><i class="lab-k" style="background:var(--berry)"></i>filtré</span><span><i class="lab-k" style="background:var(--p-mint)"></i>bande gardée</span></p></figure></div>`,
    fenetres: () => `<canvas class="mt-cv" id="mt-cv"></canvas><div class="mt-badges" id="mt-badges"></div><p class="mt-count" id="mt-count"></p>`,
    carac: () => `${scrub()}<div class="mt-two"><figure class="lab-card"><figcaption class="tool-label">Spectre de la fenêtre</figcaption><div id="mt-wspec"></div></figure><figure class="lab-card"><figcaption class="tool-label">Les 17 caractéristiques face à la cohorte</figcaption><div id="mt-bars" class="mt-bars"></div>
      <p class="lab-legend"><span><i class="mt-tk mt-tk-n"></i>médiane hors crise</span><span><i class="mt-tk mt-tk-c"></i>médiane en crise</span></p></figure></div>`,
    modele: () => `${scrub()}<div class="mt-two mt-two-m"><figure class="lab-card"><figcaption class="tool-label">Le vote des arbres</figcaption><canvas id="mt-trees" class="mt-trees"></canvas><p class="lab-small" id="mt-vote"></p></figure>
      <figure class="lab-card mt-gauge-c"><figcaption class="tool-label">Probabilité de crise</figcaption><svg id="mt-gauge" viewBox="0 0 220 146" class="lab-gauge"></svg></figure></div>
      <figure class="lab-card"><figcaption class="tool-label">Probabilité, fenêtre après fenêtre</figcaption><div id="mt-curve"></div></figure>`,
    detect: () => `<div id="mt-post" class="mt-post"></div><div class="mt-final" id="mt-final"></div>`,
  };
  function scrub() {
    const n = T.D.windows.t_start.length;
    return `<label class="lab-slider mt-scrub"><span class="tool-label">Fenêtre</span><input type="range" id="mt-w" min="0" max="${n - 1}" step="1" value="${T.win}"><output id="mt-wv"></output></label><canvas class="mt-mini" id="mt-mini"></canvas>`;
  }
  function bindScrub(fn) {
    const el = $("#mt-w"); if (!el) return;
    el.addEventListener("input", () => { T.win = +el.value; fn(false); });
  }
  function miniPos() {
    const D = T.D, W = D.windows, k = T.win;
    $("#mt-wv").textContent = `${clock(W.t_start[k], 0)}–${clock(W.t_end[k], 0)} · ${W.cls[k] ? "crise" : "normal"} (${pct(W.frac[k], 0)})`;
    traces($("#mt-mini"), [{ label: D.channels[0], segs: [{ data: D.filtered[0], color: C.ink }] }], { uv: 160,
      over: (ctx, t2x, y0, y1) => { ctx.fillStyle = "rgba(163,62,97,0.18)"; ctx.fillRect(t2x(W.t_start[k]), y0, t2x(W.t_end[k]) - t2x(W.t_start[k]), y1 - y0); ctx.strokeStyle = "#A33E61"; ctx.lineWidth = 2; ctx.strokeRect(t2x(W.t_start[k]), y0, t2x(W.t_end[k]) - t2x(W.t_start[k]), y1 - y0); } });
  }

  function draw(first) {
    const D = T.D, k = STEPS[T.step].k, W = D.windows;
    if (k === "brut") {
      const rows = D.raw.map((d, i) => ({ label: D.channels[i], note: `décalage ${signed(D.offset[i], 0)} µV`, segs: [{ data: d, color: C.ink, center: median_(d) }] }));
      animate(first ? 4500 : 0, p => traces($("#mt-cv"), rows, { upTo: p, uv: 160 }));
    } else if (k === "filtre") {
      const cv = $("#mt-cv");
      const render = () => {
        const rows = D.raw.map((d, i) => {
          if (T.resid) return { label: D.channels[i], segs: [{ data: d.map((v, j) => v - D.filtered[i][j]), color: C["coral-edge"], center: median_(d) - median_(D.filtered[i]) }] };
          return { label: D.channels[i], segs: [{ data: d, color: "#B9AEB4", center: median_(d), xa: null }, { data: D.filtered[i], color: C.ink }] };
        });
        const g = traces(cv, rows.map(r => (T.resid ? r : { ...r, segs: [] })), { uv: 160 });
        if (!T.resid) {
          const xs = g.x0 + T.split * (g.x1 - g.x0);
          traces(cv, rows.map(r => ({ ...r, segs: [{ ...r.segs[1], xb: xs }, { ...r.segs[0], xa: xs }] })), { uv: 160,
            over: ctx => { ctx.fillStyle = "#A33E61"; ctx.fillRect(xs - 1, g.y0, 2, g.y1 - g.y0); ctx.beginPath(); ctx.arc(xs, (g.y0 + g.y1) / 2, 9, 0, 7); ctx.fill(); ctx.fillStyle = "#fff"; ctx.font = `11px ${C.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("⇔", xs, (g.y0 + g.y1) / 2); } });
        }
      };
      let drag = false;
      const at = e => { const r = cv.getBoundingClientRect(); T.split = Math.max(0, Math.min(1, (e.clientX - r.left - 40) / (r.width - 48))); render(); };
      cv.onpointerdown = e => { drag = true; cv.setPointerCapture(e.pointerId); at(e); };
      cv.onpointermove = e => { if (drag) at(e); };
      cv.onpointerup = () => { drag = false; };
      $("#mt-resid").onchange = e => { T.resid = e.target.checked; render(); };
      if (first) animate(1800, p => { T.split = 0.15 + 0.7 * (1 - p); render(); }); else render();
      spectrum();
    } else if (k === "fenetres") {
      const n = W.t_start.length, rows = D.filtered.map((d, i) => ({ label: D.channels[i], segs: [{ data: d, color: C.ink }] }));
      const frame = j => {
        traces($("#mt-cv"), rows, { uv: 160, over: (ctx, t2x, y0, y1) => {
          if (j > 0) { ctx.strokeStyle = "rgba(101,94,138,0.45)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeRect(t2x(W.t_start[j - 1]), y0, t2x(W.t_end[j - 1]) - t2x(W.t_start[j - 1]), y1 - y0); ctx.setLineDash([]);
            ctx.fillStyle = "rgba(101,94,138,0.10)"; ctx.fillRect(t2x(W.t_start[j]), y0, t2x(W.t_end[j - 1]) - t2x(W.t_start[j]), y1 - y0); }
          ctx.strokeStyle = W.cls[j] ? "#A33E61" : "#2F7A5F"; ctx.lineWidth = 2.5; ctx.strokeRect(t2x(W.t_start[j]), y0, t2x(W.t_end[j]) - t2x(W.t_start[j]), y1 - y0); } });
        $("#mt-badges").innerHTML = W.t_start.map((t, i) => i <= j ? `<span class="mt-bd ${W.cls[i] ? "is-1" : "is-0"}" title="fenêtre ${clock(t)}–${clock(W.t_end[i])} : ${pct(W.frac[i], 0)} dans la crise"><b>${W.cls[i]}</b><small>${nf(100 * W.frac[i])} %</small></span>` : `<span class="mt-bd is-wait"></span>`).join("");
        const k1 = W.cls.slice(0, j + 1).filter(Boolean).length;
        $("#mt-count").innerHTML = `${mono(j + 1)} fenêtres créées sur ce segment, dont ${mono(k1)} en crise (au moins 50 % dans la crise annotée). Zone hachurée : la moitié partagée avec la fenêtre précédente.`;
      };
      if (first && !RM()) animate(5200, p => frame(Math.min(n - 1, Math.floor(p * n)))); else frame(n - 1);
    } else if (k === "carac") {
      const upd = () => { miniPos(); wspec(); bars(); };
      bindScrub(upd); upd();
    } else if (k === "modele") {
      const n = W.t_start.length;
      const upd = (anim) => { miniPos(); trees(anim); curve(); };
      bindScrub(() => upd(false));
      if (first && T.playing && !RM()) { let j = 0; T.win = 0; $("#mt-w").value = 0; const nx = () => { if (STEPS[T.step].k !== "modele" || j >= n || ROUTE.page !== "methode") return; T.win = j; $("#mt-w").value = j; miniPos(); trees(false); curve(); j++; T.raf = setTimeout(nx, 5200 / n); }; nx(); }
      else upd(first);
    } else if (k === "detect") post(first);
  }

  // ---------------------------------------------------------------- étape 2 : spectres
  function spectrum() {
    const D = T.D, [fr, pr] = D.spectrum_raw, [ff, pf] = D.spectrum_filt, P = D.params;
    const el = $("#mt-spec"), Wd = Math.max(260, el.clientWidth), H = 220, m = { l: 36, r: 8, t: 8, b: 26 };
    const lo = Math.min(...pr, ...pf), hi = Math.max(...pr, ...pf);
    const X = f => m.l + f / 60 * (Wd - m.l - m.r), Y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
    const path = (f, p) => f.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join("");
    let s = `<svg viewBox="0 0 ${Wd} ${H}" class="lab-svg"><rect x="${X(P.lo)}" y="${m.t}" width="${X(P.hi) - X(P.lo)}" height="${H - m.t - m.b}" fill="var(--p-mint)"/>`;
    for (const f of [0, 10, 20, 30, 40, 50, 60]) s += `<text x="${X(f)}" y="${H - 8}" class="lab-tick" text-anchor="middle">${f}</text>`;
    s += `<text x="${Wd - m.r}" y="${H - 8 - 12}" class="lab-tick" text-anchor="end">Hz</text><text x="${m.l - 4}" y="${m.t + 10}" class="lab-tick" text-anchor="end">log</text>`;
    s += `<path d="${path(fr, pr)}" fill="none" stroke="#B9AEB4" stroke-width="1.6"/><path d="${path(ff, pf)}" fill="none" stroke="var(--berry)" stroke-width="2"/></svg>`;
    el.innerHTML = s;
  }
  // ---------------------------------------------------------------- étape 4 : spectre de fenêtre, barres
  const BAND_C = { Delta: "#F9D3DF", Theta: "#E3DFF0", Alpha: "#D6E0EC", Beta: "#CFE5DA" };
  function wspec() {
    const D = T.D, k = T.win, f = D.spec_freqs, p = D.windows.spectra[k], all = D.windows.spectra.flat();
    const el = $("#mt-wspec"), Wd = Math.max(260, el.clientWidth), H = 230, m = { l: 30, r: 8, t: 10, b: 26 };
    const lo = Math.min(...all), hi = Math.max(...all), X = x => m.l + x / 30 * (Wd - m.l - m.r), Y = v => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
    let s = `<svg viewBox="0 0 ${Wd} ${H}" class="lab-svg">`;
    for (const [b, [a, c]] of Object.entries(D.bands)) s += `<rect x="${X(a)}" y="${m.t}" width="${X(c) - X(a)}" height="${H - m.t - m.b}" fill="${BAND_C[b]}"/><text x="${(X(a) + X(c)) / 2}" y="${m.t + 12}" class="lab-tick" text-anchor="middle">${b}</text>`;
    s += `<path d="${f.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join("")}" fill="none" stroke="var(--ink)" stroke-width="1.8"/>`;
    const pk = D.windows.features.Peak_Freq[k];
    s += `<line x1="${X(pk)}" x2="${X(pk)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--berry)" stroke-dasharray="4 3"/><text x="${X(pk) + 4}" y="${m.t + 26}" class="lab-tick" fill="var(--berry)">pic ${nf(pk, 2)} Hz</text>`;
    for (const x of [0, 5, 10, 15, 20, 25, 30]) s += `<text x="${X(x)}" y="${H - 8}" class="lab-tick" text-anchor="middle">${x}</text>`;
    el.innerHTML = s + "</svg>";
  }
  function bars() {
    const D = T.D, k = T.win, C_ = D.cohort, F = D.windows.features;
    const box = $("#mt-bars");
    if (!box.children.length) box.innerHTML = Object.keys(C_).map(f => `<div class="mt-br" data-f="${f}"><span class="mono mt-bn">${f}</span><span class="mt-bt"><i class="mt-bv"></i><i class="mt-tk mt-tk-n"></i><i class="mt-tk mt-tk-c"></i></span><span class="mono mt-bx"></span></div>`).join("");
    for (const f of Object.keys(C_)) {
      const c = C_[f], logs = c.lo > 0 && c.hi / c.lo > 30;
      const sc = v => { const a = logs ? Math.log10(c.lo) : c.lo, b = logs ? Math.log10(c.hi) : c.hi, x = logs ? Math.log10(Math.max(v, c.lo)) : v; return Math.max(0, Math.min(1, (x - a) / (b - a))); };
      const row = $(`.mt-br[data-f="${f}"]`, box), v = F[f][k];
      $(".mt-bv", row).style.width = `${100 * sc(v)}%`;
      $(".mt-bv", row).classList.toggle("is-c", Math.abs(sc(v) - sc(c.crise)) < Math.abs(sc(v) - sc(c.normal)));
      $(".mt-tk-n", row).style.left = `${100 * sc(c.normal)}%`; $(".mt-tk-c", row).style.left = `${100 * sc(c.crise)}%`;
      $(".mt-bx", row).textContent = Math.abs(v) >= 1000 ? nf(v, 0) : nf(v, Math.abs(v) < 1 ? 3 : 1);
    }
  }
  // ---------------------------------------------------------------- étape 5 : arbres, jauge, courbe
  function trees(anim) {
    const D = T.D, k = T.win, v = D.windows.votes[k], n = v.length, p = D.windows.proba[k];
    const cv = $("#mt-trees"), cols = 25;
    const fill = q => {
      const { ctx, w, h } = fitCanvas(cv); ctx.clearRect(0, 0, w, h);
      const rows = Math.ceil(n / cols), cw = w / cols, ch = h / rows, r = Math.min(cw, ch) * 0.36, upto = Math.floor(q * n);
      for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc((i % cols + 0.5) * cw, (Math.floor(i / cols) + 0.5) * ch, r, 0, 7); ctx.fillStyle = i >= upto ? "#EEE6EA" : v[i] ? "#A33E61" : "#8FB8A6"; ctx.fill(); }
      const yes = v.slice(0, upto).reduce((a, b) => a + b, 0);
      $("#mt-vote").innerHTML = `${mono(yes)} arbres sur ${mono(upto)} votent « crise ». La forêt fait la moyenne des probabilités de ses ${n} arbres : ${mono(nf(p, 3))}${p > 0.5 ? " &gt; 0,5 : fenêtre classée crise." : " ≤ 0,5 : fenêtre classée normale."}`;
      gauge(q < 1 ? null : p);
    };
    animate(anim ? 1600 : 0, fill);
  }
  function gauge(p) {
    const svg = $("#mt-gauge"), cx = 110, cy = 122, r = 86, at = v => { const a = Math.PI * (1 - v); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
    const arc = (a, b) => { const [xa, ya] = at(a), [xb, yb] = at(b); return `M${xa.toFixed(1)} ${ya.toFixed(1)} A${r} ${r} 0 0 1 ${xb.toFixed(1)} ${yb.toFixed(1)}`; };
    svg.innerHTML = `<path d="${arc(0, 1)}" class="lg-track"/>${p != null && p > 0.002 ? `<path d="${arc(0, p)}" class="lg-val ${p > 0.5 ? "is-high" : ""}"/>` : ""}` +
      `<line x1="${cx}" y1="${cy - r + 14}" x2="${cx}" y2="${cy - r - 10}" class="lg-thr"/><text x="${cx}" y="${cy - r - 14}" class="lg-thr-t" text-anchor="middle">seuil 0,5</text>` +
      `<text x="${cx}" y="${cy - 14}" class="lg-v" text-anchor="middle">${p == null ? "…" : nf(p, 2)}</text>`;
  }
  function curve() {
    const D = T.D, W = D.windows, k = T.win, el = $("#mt-curve"), Wd = Math.max(300, el.clientWidth), H = 150, m = { l: 34, r: 8, t: 8, b: 22 };
    const X = t => m.l + (t - D.start) / (D.end - D.start) * (Wd - m.l - m.r), Y = v => H - m.b - v * (H - m.t - m.b);
    const mid = i => (W.t_start[i] + W.t_end[i]) / 2;
    let s = `<svg viewBox="0 0 ${Wd} ${H}" class="lab-svg"><rect x="${X(D.seizure[0])}" y="${m.t}" width="${X(D.seizure[1]) - X(D.seizure[0])}" height="${H - m.t - m.b}" fill="var(--sage)" opacity="0.5"/>`;
    s += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${Y(0.5)}" y2="${Y(0.5)}" class="lab-thr"/><text x="${m.l - 4}" y="${Y(0.5) + 4}" class="lab-tick" text-anchor="end">0,5</text>`;
    const pts = W.proba.slice(0, k + 1).map((p, i) => [X(mid(i)), Y(p)]);
    s += `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join("")}" class="lab-line"/>`;
    pts.forEach((q, i) => { s += `<circle cx="${q[0]}" cy="${q[1]}" r="${i === k ? 5 : 3}" class="lab-pt ${W.proba[i] > 0.5 ? "is-high" : ""}"/>`; });
    for (let t = Math.ceil(D.start / 2) * 2; t <= D.end; t += 2) s += `<text x="${X(t)}" y="${H - 6}" class="lab-tick" text-anchor="middle">${clock(t)}</text>`;
    el.innerHTML = s + "</svg>";
  }
  // ---------------------------------------------------------------- étape 6 : post-traitement
  function post(first) {
    const D = T.D, W = D.windows, P = D.params, el = $("#mt-post"), Wd = Math.max(320, el.clientWidth), m = { l: 150, r: 10 };
    const X = t => m.l + (t - D.start) / (D.end - D.start) * (Wd - m.l - m.r), rowH = 34;
    const clip = L => L.map(([a, b]) => [Math.max(a, D.start), Math.min(b, D.end)]).filter(([a, b]) => b > a);
    const sq = (vals, cls, extra) => W.t_start.map((t, i) => `<rect x="${X(t + 0.5) + 1}" y="6" width="${X(t + 1.5) - X(t + 0.5) - 2}" height="18" rx="3" class="${vals[i] ? cls : "mt-sq0"}${extra ? extra(i) : ""}"><title>${clock(t)}–${clock(W.t_end[i])} : ${vals[i] ? "crise" : "normal"}</title></rect>`).join("");
    const bars = (L, cls) => clip(L).map(([a, b]) => `<rect x="${X(a)}" y="6" width="${X(b) - X(a)}" height="18" rx="4" class="${cls}"/>`).join("");
    const gone = i => (W.raw[i] && !W.smoothed[i] ? " mt-gone" : "");
    const born = i => (!W.raw[i] && W.smoothed[i] ? " mt-born" : "");
    const rows = [
      ["Décisions du modèle", sq(W.raw, "mt-sq1", gone)],
      [`1. Lissage médian (${P.smooth})`, sq(W.smoothed, "mt-sq1", born)],
      [`2. Fusion (≤ ${nf(P.merge_gap_s)} s)`, bars(D.stages.merged, "mt-iv")],
      [`3. Durée min. (${nf(P.min_event_s)} s)`, bars(D.stages.final, "mt-iv mt-iv-f")],
    ];
    const H = rows.length * rowH + 40;
    let s = `<svg viewBox="0 0 ${Wd} ${H}" class="lab-svg mt-postsvg">`;
    rows.forEach(([lab, body], i) => { s += `<g class="mt-row" style="--d:${i * 1.3}s" transform="translate(0 ${i * rowH})"><text x="${m.l - 10}" y="20" class="lab-axis" text-anchor="end">${lab}</text>${body}</g>`; });
    s += `<g transform="translate(0 ${rows.length * rowH})"><text x="${m.l - 10}" y="20" class="lab-axis" text-anchor="end">Crise annotée</text><rect x="${X(D.seizure[0])}" y="6" width="${X(D.seizure[1]) - X(D.seizure[0])}" height="18" rx="4" fill="var(--sage)" stroke="var(--sage-edge)"/></g>`;
    for (let t = Math.ceil(D.start / 2) * 2; t <= D.end; t += 2) s += `<text x="${X(t)}" y="${H - 2}" class="lab-tick" text-anchor="middle">${clock(t)}</text>`;
    el.innerHTML = s + "</svg>";
    el.classList.toggle("mt-anim", first && !RM());
    const nGone = W.raw.filter((v, i) => v && !W.smoothed[i]).length, nBorn = W.smoothed.filter((v, i) => v && !W.raw[i]).length;
    const fin = clip(D.stages.final);
    $("#mt-final").innerHTML = `<p class="body">Sur ce segment, le lissage efface ${mono(nGone)} décision${nGone > 1 ? "s" : ""} isolée${nGone > 1 ? "s" : ""} « crise » (cerclée${nGone > 1 ? "s" : ""}) et en comble ${mono(nBorn)}. ` +
      (D.error ? `Crise détectée de ${mono(clock(fin[0] ? fin[0][0] : 0, 1))} à ${mono(clock(fin[0] ? fin[0][1] : 0, 1))} : début ${mono(fmtS(D.error.start))}, fin ${mono(fmtS(D.error.end))} par rapport à l’annotation.` : "Cette crise n’est pas détectée.") + `</p>` +
      `<a class="btn" href="${lectureHref(D.id, Math.max(0, (fin[0] ? fin[0][0] : D.seizure[0]) - 5))}">Voir dans Lecture</a>`;
  }

  return { enter, stop, state: T };
})();
