/* ==========================================================================
   Absences — page Laboratoire : trois démonstrations calculées en direct
     1. Temps réel : le serveur traite le signal au fil de l'eau (/api/lab/live/…)
     2. Réglages   : la détection est refaite ici, à chaque mouvement de curseur,
                     avec les mêmes règles que detect() (eeg_pipeline.py)
     3. Stress test: injections dans une copie en mémoire (/api/lab/stress/…)
   Tracés dessinés à la main (canvas, SVG), sans bibliothèque.
   ========================================================================== */
"use strict";

const Labo = (() => {
  const TABS = ["temps-reel", "reglages", "stress", "electrodes", "augmentation"];
  const st = { tab: null, recs: null, inited: {} };

  async function enter(r) {
    const tab = TABS.includes(r.id) ? r.id : "temps-reel";
    if (r.id !== tab) replaceHash(`#/laboratoire/${tab}`);
    if (!st.wired) wireTabs();
    if (!C.berry) C.berry = getComputedStyle(document.documentElement).getPropertyValue("--berry").trim();
    if (st.tab === "temps-reel" && tab !== "temps-reel") Live.pause();
    st.tab = tab;
    $$("#page-laboratoire .lab-tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$("#page-laboratoire .lab-pane").forEach(p => { p.hidden = p.dataset.tab !== tab; });
    document.title = `Laboratoire · ${{ "temps-reel": "Temps réel", reglages: "Réglages", stress: "Stress test", electrodes: "Électrodes", augmentation: "Augmentation" }[tab]} · Absences`;
    if (!st.recs) {
      try { st.recs = (await api("/api/recordings")).filter(x => x.source === "local"); }
      catch (e) { st.recs = null; stateLine($(`#lab-${tab}`), "error", "Liste des enregistrements indisponible", serverHint); return; }
    }
    if (!st.inited[tab]) {
      st.inited[tab] = true;
      ({ "temps-reel": Live, reglages: Tune, stress: Stress, electrodes: Elec, augmentation: Augment })[tab].init(st.recs);
    }
    if (tab === "reglages") Tune.redraw();
  }
  function leave() { Live.pause(); }
  function wireTabs() {
    st.wired = true;
    $$("#page-laboratoire .lab-tabs button").forEach(b => b.addEventListener("click", () => go(`#/laboratoire/${b.dataset.tab}`)));
  }
  return { enter, leave };
})();

/* Remplit un <select> d'enregistrements (les annotés d'abord). */
function labRecOptions(sel, recs, pick) {
  const ann = recs.filter(r => r.annotated), other = recs.filter(r => !r.annotated);
  const opt = r => `<option value="${esc(r.id)}">${esc(r.id)} · ${r.annotated ? plural(r.n_seizures, "crise", "crises") : "non annoté"} · ${humanDur(r.duration)}</option>`;
  sel.innerHTML = `<optgroup label="Annotés">${ann.map(opt).join("")}</optgroup>` +
    (other.length ? `<optgroup label="Non annotés">${other.map(opt).join("")}</optgroup>` : "");
  sel.value = recs.some(r => r.id === pick) ? pick : (ann[0] || recs[0]).id;
}
function bindSeg(seg, fn) {
  seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", seg).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    fn(b.dataset.v);
  });
}
const fmtS = (v, d = 1) => `${signed(v, d)} s`;

/* ==========================================================================
   1. TEMPS RÉEL
   ========================================================================== */
const Live = (() => {
  const VIEW = 10, GAP = 0.25, STRIP = 60;
  const L = {
    sid: null, info: null, playing: false, speed: 1, cursor: 0, dataEnd: 0, ended: false, inflight: false,
    chunks: [], pending: [], probs: [], snaps: [], view: null, raf: 0, last: 0, typ: 20, gen: 0,
    alarmSeen: new Set(), err: null, note: "", revealedAll: [],
  };

  function init(recs) {
    labRecOptions($("#lt-rec"), recs.filter(r => r.annotated), "230102B-F");
    const syncClock = () => { $("#lt-start-clock").textContent = clock(+$("#lt-start").value || 0); };
    $("#lt-start").addEventListener("input", syncClock); syncClock();
    $("#lt-rec").addEventListener("change", () => { $("#lt-start").value = 0; syncClock(); restart(); });
    $("#lt-play").addEventListener("click", () => (L.playing ? pause() : play()));
    $("#lt-restart").addEventListener("click", restart);
    $("#lt-next").addEventListener("click", nextSeizure);
    bindSeg($("#lt-speed"), v => { L.speed = +v; });
    drawGauge(null); drawCounters(); render();
    onResize($("#lt-eeg"), render);
  }

  async function open(t) {
    const gen = ++L.gen;
    if (L.sid) api(`/api/lab/live/${L.sid}/stop`, { method: "POST" }).catch(() => {});
    L.sid = null;
    setStatus("wait", "Préparation…", "Chargement de l’enregistrement et du modèle.");
    const rid = $("#lt-rec").value;
    const [info, ov] = await Promise.all([
      api(`/api/lab/live/start?rid=${encodeURIComponent(rid)}&t=${t}`, { method: "POST" }),
      api(`/api/recordings/${encodeURIComponent(rid)}/overview`).catch(() => null)]);
    if (gen !== L.gen) return false;
    L.sid = info.sid; L.info = info; L.note = ""; L.typ = ov ? ov.typical_uv : 20;
    L.alarmSeen = new Set();
    resetBuffers(info.t0);
    $("#lt-model").textContent = `${info.model.label} (entraîné sur ${info.model.trained_on} enregistrements). Lissage ${info.params.smooth} fenêtres, fusion ≤ ${nf(info.params.merge_gap_s)} s, durée min. ${nf(info.params.min_event_s)} s.`;
    $("#lt-lag").textContent = `Tracé affiché avec ${nf(info.lookahead_s)} s de décalage : le filtre a besoin de ce signal après chaque fenêtre.`;
    setStatus("ok", "Normal", "Aucune alarme.");
    drawCounters();
    return true;
  }
  function resetBuffers(t0) {
    L.cursor = t0; L.dataEnd = t0; L.ended = false; L.inflight = false;
    L.chunks = []; L.pending = []; L.probs = []; L.snaps = [];
    L.view = { events: [], alarm: null, revealed: [], counters: L.view ? L.view.counters : null, concordance: L.view ? L.view.concordance : null, t0 };
    L.revealedAll = L.revealedAll || [];
  }

  async function play() {
    try {
      if (!L.sid || L.ended) { L.revealedAll = []; L.view = null; if (!(await open(+$("#lt-start").value || 0))) return; }
    } catch (e) { setStatus("err", "Lecture impossible", e.message); return; }
    L.playing = true; L.err = null;
    $("#lt-play").textContent = "Pause";
    L.last = performance.now();
    cancelAnimationFrame(L.raf); L.raf = requestAnimationFrame(tick);
  }
  function pause() {
    L.playing = false;
    $("#lt-play").textContent = "Lecture";
    cancelAnimationFrame(L.raf);
    render();
  }
  async function restart() {
    pause();
    L.revealedAll = []; L.view = null;
    try { if (await open(+$("#lt-start").value || 0)) { render(); play(); } }
    catch (e) { setStatus("err", "Lecture impossible", e.message); }
  }
  async function nextSeizure() {
    if (!L.sid) { try { L.revealedAll = []; L.view = null; if (!(await open(+$("#lt-start").value || 0))) return; } catch (e) { setStatus("err", "Lecture impossible", e.message); return; } }
    try {
      const n = await api(`/api/lab/live/${L.sid}/next-seizure`);
      if (n.t == null) { L.note = "Plus aucune crise annotée après ce point."; $("#lt-buffer").textContent = L.note; return; }
      L.gen++;
      const r = await api(`/api/lab/live/${L.sid}/seek?t=${n.t}`, { method: "POST" });
      resetBuffers(r.t0);
      L.note = `Saut à ${clock(r.t0)}, 15 s avant la crise annotée suivante.`; $("#lt-buffer").textContent = L.note;
      if (!L.playing) play(); else render();
    } catch (e) { setStatus("err", "Saut impossible", e.message); }
  }

  async function fetchNext() {
    L.inflight = true;
    const gen = L.gen, sid = L.sid;
    const dt = Math.max(0.5, L.speed * 0.6);
    try {
      const d = await api(`/api/lab/live/${sid}/next?dt=${dt.toFixed(2)}`);
      if (gen !== L.gen) return;
      if (d.disp && d.disp.data.length) {
        const data = d.disp.data.map(a => Float32Array.from(a));
        L.chunks.push({ t0: d.disp.t0, dt: d.disp.dt, n: data[0].length, data });
      }
      L.dataEnd = Math.max(L.dataEnd, d.t_proc);
      L.pending.push(...d.windows);
      L.snaps.push(d);
      if (d.ended) L.ended = true;
    } catch (e) {
      if (gen === L.gen) { L.err = e.message; pause(); setStatus("err", "Le calcul s’est interrompu", e.message); }
    } finally { if (gen === L.gen) L.inflight = false; }
  }

  function tick(now) {
    const dtReal = Math.min(0.1, (now - L.last) / 1000);
    L.last = now;
    if (L.playing) {
      L.cursor = Math.min(L.cursor + dtReal * L.speed, L.dataEnd);
      if (!L.inflight && !L.ended && L.dataEnd - L.cursor < L.speed * 1.2 + 0.6) fetchNext();
      // résultats révélés au rythme du tracé
      while (L.pending.length && L.pending[0][1] <= L.cursor + 1e-6) L.probs.push(L.pending.shift());
      while (L.snaps.length && L.snaps[0].t_proc <= L.cursor + 1e-6) apply(L.snaps.shift());
      // mémoire bornée : 12 s de tracé, 70 s de probabilités
      while (L.chunks.length && L.chunks[0].t0 + L.chunks[0].n * L.chunks[0].dt < L.cursor - VIEW - 1) L.chunks.shift();
      while (L.probs.length && L.probs[0][1] < L.cursor - STRIP - 10) L.probs.shift();
      $("#lt-buffer").textContent = (!L.ended && L.dataEnd - L.cursor < 0.05) ? "calcul en cours…" : L.note;
      if (L.ended && L.cursor >= L.dataEnd - 1e-6 && !L.snaps.length) {
        L.note = "Fin de l’enregistrement."; pause(); $("#lt-buffer").textContent = L.note;
      }
    }
    render();
    if (L.playing) L.raf = requestAnimationFrame(tick);
  }

  function apply(d) {
    const prevAlarm = L.view && L.view.alarm;
    L.view = { ...d, t0: d.t0 };
    for (const r of d.revealed) if (!L.revealedAll.some(x => x.start === r.start)) L.revealedAll.push(r);
    if (d.alarm) {
      const key = d.alarm.start.toFixed(2);
      if (!L.alarmSeen.has(key) && !(prevAlarm && prevAlarm.start === d.alarm.start)) { L.alarmSeen.add(key); flash(); }
      setStatus("alarm", "CRISE DÉTECTÉE", `depuis ${clock(d.alarm.start, 1)} · ${nf(d.alarm.end - d.alarm.start, 0)} s`);
    } else {
      const lastEv = d.events[d.events.length - 1];
      setStatus("ok", "Normal", lastEv ? `Dernière alarme : ${clock(lastEv.start, 1)}, ${nf(lastEv.end - lastEv.start, 0)} s${lastEv.status === "fa" ? " — fausse alarme" : lastEv.status === "hit" ? " — crise annotée confirmée" : ""}` : "Aucune alarme.");
    }
    drawCounters();
  }

  function flash() {
    for (const el of [$("#lt-status"), $("#lt-monitor")]) {
      el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
    }
    if ($("#lt-beep").checked) beep();
  }
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
    } catch (_) { /* pas de son disponible */ }
  }

  function setStatus(kind, v, s) {
    const el = $("#lt-status");
    el.dataset.state = kind;
    $("#lt-status-v").textContent = v;
    $("#lt-status-s").textContent = s;
  }

  function drawCounters() {
    const c = L.view && L.view.counters, k = L.view && L.view.concordance;
    const row = (l, v, cls = "") => `<div class="${cls}"><dt>${l}</dt><dd>${v}</dd></div>`;
    $("#lt-counters").innerHTML =
      row("Crises détectées / annotées", c ? `${c.detected} / ${c.annotated}` : "—") +
      row("Fausses alarmes", c ? `${c.false_alarms}` : "—") +
      row("Retard moyen au début", c && c.mean_delay != null ? fmtS(c.mean_delay) : "—") +
      row("Accord avec l’analyse complète", k && k.n ? `${pct(k.same / k.n, 1)} <span class="lab-dim">(${nf(k.n)} fen.)</span>` : "—", "lab-conc");
  }

  // ---------------- dessins
  function render() {
    drawMonitor(); drawStrip();
    const p = L.probs.length ? L.probs[L.probs.length - 1][2] : null;
    drawGauge(p);
    $("#lt-pos").textContent = L.info ? `${clock(L.cursor, 1)} / ${clock(L.info.duration)} · ×${L.speed}` : "—";
  }

  /* Balayage façon moniteur : le curseur avance de gauche à droite et efface l'ancien tracé devant lui. */
  function drawMonitor() {
    const cv = $("#lt-eeg");
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const chans = L.info ? L.info.channels : [];
    const x0 = 40, x1 = w - 8, y0 = 6, y1 = h - 20;
    const lane = (y1 - y0) / Math.max(1, chans.length || 19);
    const cur = L.cursor, pos = t => x0 + (((t % VIEW) + VIEW) % VIEW) / VIEW * (x1 - x0);
    const tFrom = cur - VIEW + GAP;
    /* intervalle [a, b] → rectangles visibles (le balayage replie le temps sur la largeur) */
    const spans = (a, b) => {
      a = Math.max(a, tFrom); b = Math.min(b, cur);
      if (b <= a) return [];
      const xa = pos(a), xb = pos(b);
      return xb >= xa ? [[xa, xb]] : [[xa, x1], [x0, xb]];
    };
    // fenêtres révélées : crises annotées (vert pâle), détections (hachures)
    for (const r of L.revealedAll) for (const [a, b] of spans(r.start, r.end)) { ctx.fillStyle = C.sage; ctx.globalAlpha = 0.55; ctx.fillRect(a, y0, b - a, y1 - y0); ctx.globalAlpha = 1; ctx.fillStyle = C["sage-edge"]; ctx.fillRect(a, y0, b - a, 2); }
    const evs = (L.view && L.view.events) || [];
    for (const e of evs) for (const [a, b] of spans(e.start, e.end)) { ctx.fillStyle = "rgba(248, 220, 196, 0.55)"; ctx.fillRect(a, y0 + 3, b - a, y1 - y0 - 3); hatchRect(ctx, a, y0 + 3, b - a, y1 - y0 - 3); }
    // grille : secondes
    ctx.strokeStyle = C["grid-major"]; ctx.lineWidth = 1; ctx.beginPath();
    for (let s = 0; s <= VIEW; s++) { const x = crisp(x0 + s / VIEW * (x1 - x0)); ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
    // traces
    if (chans.length) {
      const uvPerPx = (3 * L.typ) / (0.42 * lane), lim = lane * 1.2;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.lineJoin = "round";
      chans.forEach((c, k) => {
        const yc = y0 + lane * (k + 0.5);
        ctx.beginPath();
        let px = -1;
        for (const ch of L.chunks) {
          const d = ch.data[k];
          const iA = Math.max(0, Math.ceil((tFrom - ch.t0) / ch.dt)), iB = Math.min(ch.n - 1, Math.floor((cur - ch.t0) / ch.dt));
          for (let i = iA; i <= iB; i++) {
            const t = ch.t0 + i * ch.dt, x = pos(t), y = yc - Math.max(-lim, Math.min(lim, d[i] / uvPerPx));
            if (x < px || px < 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            px = x;
          }
        }
        ctx.stroke();
      });
      ctx.restore();
      ctx.font = `10.5px ${C.mono}`; ctx.fillStyle = C["ink-2"]; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      chans.forEach((c, k) => ctx.fillText(label(c), x0 - 7, y0 + lane * (k + 0.5)));
    }
    // curseur et heures sous les traits de seconde
    if (L.info) {
      const xc = crisp(pos(cur));
      ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(xc + 1, y0, (GAP / VIEW) * (x1 - x0), y1 - y0);
      ctx.strokeStyle = C.berry || C.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(xc, y0); ctx.lineTo(xc, y1); ctx.stroke();
      ctx.font = `10px ${C.mono}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "center"; ctx.textBaseline = "top";
      const curPos = ((cur % VIEW) + VIEW) % VIEW;
      for (let s = 0; s < VIEW; s += 2) {
        const t = cur - ((curPos - s + VIEW) % VIEW);
        if (t < (L.view ? L.view.t0 : 0) - 1e-6) continue;
        const x = x0 + s / VIEW * (x1 - x0);
        if (Math.abs(x - xc) < 26) continue;
        ctx.fillText(clock(Math.round(t)), Math.max(x0 + 16, x), y1 + 5);
      }
    } else {
      ctx.font = `14px ${C.sans}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Appuyez sur Lecture pour démarrer le moniteur.", (x0 + x1) / 2, (y0 + y1) / 2);
    }
    ctx.strokeStyle = C["rule-strong"]; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, crisp(y1)); ctx.lineTo(x1, crisp(y1)); ctx.stroke();
  }

  function drawStrip() {
    const cv = $("#lt-strip");
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const x0 = 40, x1 = w - 64, y0 = 16, y1 = h - 20, cur = L.cursor;
    const t2x = t => x0 + (t - (cur - STRIP)) / STRIP * (x1 - x0), p2y = p => y1 - p * (y1 - y0);
    const band = (a, b, fill, edge, top) => {
      const xa = Math.max(x0, t2x(a)), xb = Math.min(x1, t2x(b));
      if (xb <= xa) return;
      ctx.fillStyle = fill; ctx.fillRect(xa, top ? y0 - 10 : y0, xb - xa, top ? 6 : y1 - y0);
      if (edge) { ctx.fillStyle = edge; ctx.fillRect(xa, top ? y0 - 10 : y0, xb - xa, top ? 6 : 2); }
    };
    for (const r of L.revealedAll) band(r.start, r.end, "rgba(207, 229, 218, 0.6)", C["sage-edge"]);
    for (const e of (L.view && L.view.events) || []) band(e.start, e.end, C.coral, null, true);
    // axes
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath();
    for (const p of [0, 0.25, 0.75, 1]) { ctx.moveTo(x0, crisp(p2y(p))); ctx.lineTo(x1, crisp(p2y(p))); }
    ctx.stroke();
    ctx.font = `10px ${C.mono}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const p of [0, 0.5, 1]) ctx.fillText(nf(p, p === 0.5 ? 1 : 0), x0 - 6, p2y(p));
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let s = 60; s >= 0; s -= 10) ctx.fillText(s ? `−${s} s` : "maintenant", t2x(cur - s), y1 + 5);
    // seuil
    ctx.strokeStyle = C["coral-edge"]; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x0, crisp(p2y(0.5))); ctx.lineTo(x1, crisp(p2y(0.5))); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C["coral-ink"]; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText("seuil 0,5", x1 + 6, p2y(0.5));
    // probabilités : une valeur par fenêtre, placée à la fin de la fenêtre
    const pts = L.probs.filter(q => q[1] >= cur - STRIP - 1);
    if (pts.length) {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
      ctx.beginPath(); ctx.moveTo(t2x(pts[0][1]), y1);
      for (const q of pts) ctx.lineTo(t2x(q[1]), p2y(q[2]));
      ctx.lineTo(t2x(pts[pts.length - 1][1]), y1); ctx.closePath();
      ctx.fillStyle = "rgba(163, 62, 97, 0.10)"; ctx.fill();
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, t2x(q[1]), p2y(q[2])));
      ctx.strokeStyle = C.berry || C.ink; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = C["ink-3"]; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.font = `10px ${C.sans}`;
    ctx.fillText("détections", x1 + 6, y0 - 12);
  }

  function drawGauge(p) {
    const svg = $("#lt-gauge"), cx = 110, cy = 122, r = 86;
    const at = v => { const a = Math.PI * (1 - v); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
    const arc = (a, b) => { const [xa, ya] = at(a), [xb, yb] = at(b); return `M${xa.toFixed(1)} ${ya.toFixed(1)} A${r} ${r} 0 0 1 ${xb.toFixed(1)} ${yb.toFixed(1)}`; };
    const v = p == null ? 0 : Math.max(0, Math.min(1, p));
    const [tx0, ty0] = [cx + (r - 14) * Math.cos(Math.PI / 2), cy - (r - 14) * Math.sin(Math.PI / 2)];
    const [tx1, ty1] = [cx + (r + 12) * Math.cos(Math.PI / 2), cy - (r + 12) * Math.sin(Math.PI / 2)];
    svg.innerHTML =
      `<path d="${arc(0, 1)}" class="lg-track"/>` +
      (p != null && v > 0.002 ? `<path d="${arc(0, v)}" class="lg-val ${v > 0.5 ? "is-high" : ""}"/>` : "") +
      `<line x1="${tx0}" y1="${ty0}" x2="${tx1}" y2="${ty1 - 4}" class="lg-thr"/>` +
      `<text x="${cx}" y="${ty1 - 8}" class="lg-thr-t" text-anchor="middle">seuil 0,5</text>` +
      `<text x="${cx - r}" y="${cy + 16}" class="lg-tick" text-anchor="middle">0</text><text x="${cx + r}" y="${cy + 16}" class="lg-tick" text-anchor="middle">1</text>` +
      `<text x="${cx}" y="${cy - 14}" class="lg-v" text-anchor="middle">${p == null ? "—" : nf(v, 2)}</text>` +
      `<text x="${cx}" y="${cy + 12}" class="lg-l" text-anchor="middle">probabilité de crise</text>`;
  }

  return { init, pause, state: L };
})();

/* ==========================================================================
   2. RÉGLAGES — détection refaite dans le navigateur (mêmes règles que detect())
   ========================================================================== */
const Tune = (() => {
  const SMOOTHS = [1, 3, 5, 7];
  const T = { model: "rf", data: {}, prev: null, base: null };

  /* scipy.signal.medfilt sur 0/1, bords complétés par des zéros comme scipy */
  function medfilt01(x, k) {
    if (k <= 1) return x;
    const h = k >> 1, n = x.length, out = new Uint8Array(n);
    let s = 0;
    for (let i = 0; i < Math.min(n, h); i++) s += x[i];
    for (let i = 0; i < n; i++) {
      if (i + h < n) s += x[i + h];
      if (i - h - 1 >= 0) s -= x[i - h - 1];
      out[i] = s > h ? 1 : 0;
    }
    return out;
  }
  /* P.windows_to_intervals */
  function intervals(ts, te, pred, minLen, gap) {
    const ev = []; let cur = null;
    for (let i = 0; i < pred.length; i++) {
      if (pred[i]) cur = cur ? [cur[0], te[i]] : [ts[i], te[i]];
      else if (cur) { ev.push(cur); cur = null; }
    }
    if (cur) ev.push(cur);
    const merged = [];
    for (const e of ev) {
      const m = merged[merged.length - 1];
      if (m && e[0] - m[1] <= gap) m[1] = Math.max(m[1], e[1]); else merged.push([e[0], e[1]]);
    }
    return merged.filter(([s, e]) => e - s >= minLen);
  }
  /* P.match_events : crises touchées, retard du premier intervalle, fausses alarmes */
  function match(truth, ev) {
    const used = new Set(); const delays = []; let det = 0;
    for (const [ts, te] of truth) {
      const hit = []; ev.forEach(([ps, pe], j) => { if (ps < te && pe > ts) hit.push(j); });
      if (hit.length) { det++; hit.forEach(j => used.add(j)); delays.push(Math.round((ev[hit[0]][0] - ts) * 10) / 10); }
    }
    return { det, delays, fa: ev.length - used.size };
  }
  function evaluate(data, p, withRows = true) {
    let det = 0, nTrue = 0, fa = 0, hours = 0, tp = 0, fp = 0, fn = 0; const delays = []; const rows = [];
    for (const r of data.recordings) {
      const n = r.proba.length, pred = new Uint8Array(n);
      for (let i = 0; i < n; i++) pred[i] = r.proba[i] > p.thr ? 1 : 0;
      const sm = medfilt01(pred, p.smooth);
      const ev = intervals(r.t_start, r.t_end, sm, p.min, p.gap);
      const m = match(r.truth, ev);
      det += m.det; nTrue += r.truth.length; fa += m.fa; hours += r.hours; delays.push(...m.delays);
      if (withRows) {
        for (let i = 0; i < n; i++) { if (sm[i] && r.cls[i]) tp++; else if (sm[i]) fp++; else if (r.cls[i]) fn++; }
        rows.push({ id: r.id, n: r.truth.length, det: m.det, fa: m.fa, delay: m.delays.length ? m.delays.reduce((a, b) => a + b, 0) / m.delays.length : null });
      }
    }
    const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0;
    return { det, nTrue, fa, hours, sens: nTrue ? det / nTrue : 0, faH: fa / hours,
             delay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
             prec, rec, f1: prec + rec ? 2 * prec * rec / (prec + rec) : 0, rows };
  }

  function params() {
    return { thr: +$("#rg-thr").value, smooth: SMOOTHS[+$("#rg-smooth").value], gap: +$("#rg-gap").value, min: +$("#rg-min").value };
  }
  function defaults(d) { return { thr: d.defaults.threshold, smooth: d.defaults.smooth, gap: d.defaults.merge_gap_s, min: d.defaults.min_event_s }; }
  function setSliders(p) {
    $("#rg-thr").value = p.thr; $("#rg-smooth").value = SMOOTHS.indexOf(p.smooth); $("#rg-gap").value = p.gap; $("#rg-min").value = p.min;
  }

  function init() {
    for (const id of ["rg-thr", "rg-smooth", "rg-gap", "rg-min"]) $("#" + id).addEventListener("input", update);
    $("#rg-reset").addEventListener("click", () => { const d = T.data[T.model]; if (d) { setSliders(defaults(d)); update(); } });
    bindSeg($("#rg-model"), v => { T.model = v; T.prev = null; load(); });
    $("#rg-curve").addEventListener("mousemove", hover);
    $("#rg-curve").addEventListener("mouseleave", () => { $("#rg-tip").hidden = true; });
    onResize($("#rg-curve"), () => T.data[T.model] && drawCurve());
    load();
  }

  async function load() {
    const key = T.model;
    if (!T.data[key]) {
      $("#rg-controls").classList.add("is-busy");
      stateLine($("#rg-msg"), "loading", "Calcul des probabilités « sans l’enregistrement »…", "Une seule fois : le résultat est ensuite gardé en cache.");
      try {
        T.data[key] = await waitDone(`/api/lab/reglages?model=${key}`,
          d => stateLine($("#rg-msg"), "loading", progressText(d, `le modèle ${key === "rf" ? "Random Forest" : "Extra Trees"} sans chaque enregistrement`), "Une seule fois : le résultat est ensuite gardé en cache."));
      } catch (e) { stateLine($("#rg-msg"), "error", "Probabilités indisponibles", e.message); return; }
      finally { $("#rg-controls").classList.remove("is-busy"); }
      $("#rg-msg").innerHTML = "";
    }
    if (key !== T.model) return;
    const d = T.data[key];
    T.base = evaluate(d, defaults(d));
    update();
  }
  function redraw() { if (T.data[T.model]) drawCurve(); }

  function update() {
    const d = T.data[T.model];
    const p = params();
    $("#rg-thr-v").textContent = nf(p.thr, 2);
    $("#rg-smooth-v").textContent = p.smooth === 1 ? "aucun" : `${p.smooth} fenêtres`;
    $("#rg-gap-v").textContent = `${nf(p.gap, 1)} s`;
    $("#rg-min-v").textContent = `${nf(p.min, 1)} s`;
    if (!d) return;
    const t0 = performance.now();
    const r = evaluate(d, p);
    // courbe : le seuil varie de 0,05 à 0,95, les autres réglages restent ceux choisis
    T.curve = [];
    for (let k = 5; k <= 95; k++) { const q = evaluate(d, { ...p, thr: k / 100 }, false); T.curve.push({ thr: k / 100, sens: q.sens, faH: q.faH, det: q.det, fa: q.fa }); }
    const ms = performance.now() - t0;
    T.cur = r;
    drawKpis(r, d); drawTable(r); drawCurve();
    $("#rg-time").textContent = `19 enregistrements et ${T.curve.length} seuils recalculés en ${nf(ms, 0)} ms`;
    const b = T.base, ref = d.reference, sc = d.server_check;
    const same = b.det === sc.detected && b.fa === sc.false_alarms && (!ref || (ref.detected === b.det && ref.false_alarms === b.fa));
    $("#rg-check").innerHTML = `Au réglage du projet, ce calcul donne ${mono(`${b.det}/${b.nTrue}`)} crises et ${mono(b.fa)} fausses alarmes ; ` +
      `le serveur, avec les fonctions d’<span class="mono">eeg_pipeline.py</span>, donne ${mono(`${sc.detected}/${sc.n_true}`)} et ${mono(sc.false_alarms)}` +
      (ref ? ` ; le notebook (<span class="mono">${esc(ref.source)}</span>) ${mono(`${ref.detected}/${ref.n_true}`)} et ${mono(ref.false_alarms)}` : "") +
      `. ${same ? "Les trois concordent." : "<b>Écart à examiner.</b>"} Décision : ${esc(d.rule)}.`;
    T.prev = r;
  }

  function drawKpis(r, d) {
    const b = T.base;
    const delta = (v, base, fmt) => (Math.abs(v - base) < 1e-9 ? `<span class="lab-was">= réglage du projet</span>` : `<span class="lab-was">projet : ${fmt(base)}</span>`);
    const kpi = (cls, v, l, extra) => `<div class="kpi ${cls}"><p class="kpi-v">${v}</p><p class="kpi-l">${l}<br>${extra}</p></div>`;
    $("#rg-kpis").innerHTML =
      kpi("kpi-mint", `${r.det}<span class="kpi-of">/${r.nTrue}</span>`, `crises détectées · sensibilité ${pct(r.sens, 1)}`, delta(r.det, b.det, v => `${v}/${b.nTrue}`)) +
      kpi("kpi-peach", `${r.fa}`, `fausses alarmes · ${nf(r.faH, 2)} par heure`, delta(r.fa, b.fa, v => v)) +
      kpi("kpi-lav", r.delay == null ? "—" : fmtS(r.delay), "retard moyen au début", r.delay == null || b.delay == null ? "" : delta(Math.round(r.delay * 100), Math.round(b.delay * 100), v => fmtS(v / 100))) +
      kpi("kpi-blue", nf(r.f1, 3), `F1 par fenêtre (après lissage)<br>précision ${nf(r.prec, 3)} · rappel ${nf(r.rec, 3)}`, delta(Math.round(r.f1 * 1000), Math.round(b.f1 * 1000), v => nf(v / 1000, 3)));
  }

  function drawTable(r) {
    const b = T.base, prev = T.prev;
    const tb = $("#rg-table tbody");
    // valeur du réglage du projet entre parenthèses (dans l'infobulle seulement pour le retard, faute de place)
    const cell = (v, base, fmt = x => x, inline = true) => {
      const same = v === base || (v != null && base != null && Math.abs(v - base) < 1e-9);
      const was = base == null ? "—" : fmt(base);
      return `<td class="num${same ? "" : " is-diff"}"${same ? "" : ` title="réglage du projet : ${esc(was)}"`}>${v == null ? "—" : fmt(v)}${same || !inline ? "" : `<span class="lab-was"> (${was})</span>`}</td>`;
    };
    const dl = v => fmtS(v);
    tb.innerHTML = r.rows.map((row, i) => {
      const br = b.rows[i], pr = prev && prev.rows[i];
      const diff = row.det !== br.det || row.fa !== br.fa;
      const changed = pr && (row.det !== pr.det || row.fa !== pr.fa || row.delay !== pr.delay);
      return `<tr class="${diff ? "is-off" : ""} ${changed ? "is-changed" : ""}"><td><a class="mono rid-link" href="#/lecture/${esc(row.id)}">${esc(row.id)}</a></td>` +
        `<td class="num">${row.n}</td>${cell(row.det, br.det)}${cell(row.fa, br.fa)}${cell(row.delay == null ? null : Math.round(row.delay * 10) / 10, br.delay == null ? null : Math.round(br.delay * 10) / 10, dl, false)}</tr>`;
    }).join("");
    $("#rg-table tfoot").innerHTML = `<tr><td>Total</td><td class="num">${r.nTrue}</td><td class="num">${r.det}</td><td class="num">${r.fa}</td><td class="num">${r.delay == null ? "—" : fmtS(r.delay, 2)}</td></tr>`;
  }

  function drawCurve() {
    const el = $("#rg-curve"), d = T.data[T.model];
    if (!d || !T.curve) return;
    const W = Math.max(320, el.clientWidth), H = 300, m = { l: 52, r: 16, t: 14, b: 42 };
    const pts = T.curve, base = T.base, cur = T.cur, p = params();
    const allMax = Math.max(...pts.map(q => q.faH));
    const at20 = (pts.find(q => q.thr >= 0.2) || pts[0]).faH;
    const xMax = Math.min(allMax, Math.max(8, at20, cur.faH * 1.25, base.faH * 2.5)) * 1.05;
    const clipped = allMax > xMax;
    const yMin = Math.max(0, Math.floor(Math.min(...pts.map(q => q.sens), base.sens) * 10) / 10 - 0.05);
    const X = v => m.l + v / xMax * (W - m.l - m.r), Y = v => H - m.b - (v - yMin) / (1 - yMin) * (H - m.t - m.b);
    T.geom = { X, Y, pts, W, H };
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="lab-svg" role="img" aria-label="Sensibilité en fonction des fausses alarmes par heure, quand le seuil varie">`;
    const xs = niceTicks(0, xMax, 6), ys = niceTicks(yMin, 1, 5);
    for (const v of xs) s += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}" class="lab-grid"/><text x="${X(v)}" y="${H - m.b + 16}" class="lab-tick" text-anchor="middle">${nf(v, v < 10 && v % 1 ? 1 : 0)}</text>`;
    for (const v of ys) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="lab-grid"/><text x="${m.l - 8}" y="${Y(v) + 4}" class="lab-tick" text-anchor="end">${nf(100 * v, 0)} %</text>`;
    s += `<text x="${(m.l + W - m.r) / 2}" y="${H - 6}" class="lab-axis" text-anchor="middle">fausses alarmes par heure</text>`;
    s += `<text x="14" y="${(m.t + H - m.b) / 2}" class="lab-axis" text-anchor="middle" transform="rotate(-90 14 ${(m.t + H - m.b) / 2})">sensibilité (crises)</text>`;
    s += `<clipPath id="rg-clip"><rect x="${m.l}" y="${m.t - 8}" width="${W - m.l - m.r}" height="${H - m.t - m.b + 16}"/></clipPath><g clip-path="url(#rg-clip)">`;
    s += `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${X(q.faH).toFixed(1)} ${Y(q.sens).toFixed(1)}`).join("")}" class="lab-line"/>`;
    for (const q of pts) if (Math.round(q.thr * 100) % 10 === 0) s += `<circle cx="${X(q.faH)}" cy="${Y(q.sens)}" r="3" class="lab-dot"><title>seuil ${nf(q.thr, 1)}</title></circle>`;
    s += "</g>";
    if (clipped) s += `<text x="${W - m.r - 4}" y="${H - m.b - 10}" class="lab-tick" text-anchor="end">seuils plus bas : jusqu’à ${nf(allMax, 0)} fausses alarmes / h →</text>`;
    // réglage du projet et réglage courant
    s += `<g class="lab-proj"><circle cx="${X(base.faH)}" cy="${Y(base.sens)}" r="7"/><text x="${X(base.faH) + 11}" y="${Y(base.sens) + 16}">réglage du projet</text></g>`;
    s += `<g class="lab-cur"><circle cx="${X(cur.faH)}" cy="${Y(cur.sens)}" r="6"/><text x="${X(cur.faH) + 10}" y="${Y(cur.sens) - 9}">seuil ${nf(p.thr, 2)}</text></g>`;
    s += `<circle class="lab-hover" r="5" cx="0" cy="0" visibility="hidden"/></svg>`;
    el.innerHTML = s;
  }
  function niceTicks(a, b, n) {
    const span = b - a, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw) || raw;
    const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function hover(e) {
    const g = T.geom; if (!g) return;
    const box = $("#rg-curve svg").getBoundingClientRect();
    const mx = (e.clientX - box.left) * g.W / box.width, my = (e.clientY - box.top) * g.H / box.height;
    let best = null, bd = 1e9;
    for (const q of g.pts) { const dd = Math.hypot(g.X(q.faH) - mx, g.Y(q.sens) - my); if (dd < bd) { bd = dd; best = q; } }
    const tip = $("#rg-tip"), dot = $("#rg-curve .lab-hover");
    if (!best || bd > 30 || g.X(best.faH) > g.W) { tip.hidden = true; dot.setAttribute("visibility", "hidden"); return; }
    dot.setAttribute("visibility", "visible"); dot.setAttribute("cx", g.X(best.faH)); dot.setAttribute("cy", g.Y(best.sens));
    tip.innerHTML = `<b>seuil ${nf(best.thr, 2)}</b><br>${best.det} crises sur ${T.cur.nTrue} (${pct(best.sens, 1)})<br>${best.fa} fausses alarmes (${nf(best.faH, 2)} / h)`;
    tip.hidden = false;
    const fig = $("#rg-curve").parentElement.getBoundingClientRect();
    tip.style.left = `${e.clientX - fig.left + 14}px`; tip.style.top = `${e.clientY - fig.top - 10}px`;
  }

  return { init, redraw, evaluate, state: T };
})();

/* ==========================================================================
   3. STRESS TEST
   ========================================================================== */
const Stress = (() => {
  const S = { info: null, start: null, rawView: false, art: null, syn: null, map: null, busy: false };
  const ART_LABELS = { mouvement: "Pic de mouvement", muscle: "Bruit musculaire", secteur: "Parasite 50 Hz", electrode: "Décollement d’électrode", clignement: "Clignement des yeux" };

  async function init(recs) {
    labRecOptions($("#st-rec"), recs, "230102B-F");
    $("#st-rec").addEventListener("change", calm);
    $("#st-calm").addEventListener("click", calm);
    $("#st-start").addEventListener("change", () => { S.start = Math.max(0, Math.round(+$("#st-start").value || 0)); $("#st-start-clock").textContent = clock(S.start); $("#st-calm-info").textContent = "Extrait choisi à la main."; clearOut(); });
    for (const [id, f] of [["sy-freq", v => `${nf(v, 2)} Hz`], ["sy-amp", v => `${nf(v)} µV`], ["sy-dur", v => `${nf(v)} s`], ["sy-reg", v => nf(v, 1)]]) {
      const el = $("#" + id), out = $(`#${id}-v`);
      const sync = () => { out.textContent = f(+el.value); if (id === "sy-freq" || id === "sy-reg") drawTemplate(); };
      el.addEventListener("input", sync); sync();
      el.addEventListener("change", () => { if (S.syn) runSynth(); });
    }
    $("#sy-run").addEventListener("click", runSynth);
    bindSeg($("#sy-model"), () => { if (S.syn) runSynth(); });
    $("#mp-run").addEventListener("click", runMap);
    try { S.info = await api("/api/lab/stress/info"); }
    catch (e) { stateLine($("#st-art-out"), "error", "Stress test indisponible", e.message); return; }
    $("#st-arts").innerHTML = Object.keys(S.info.artifacts).map(k => `<button type="button" class="btn btn-quiet" data-k="${k}" title="${esc(S.info.artifacts[k])}">${esc(ART_LABELS[k] || k)}</button>`).join("");
    $("#st-arts").addEventListener("click", e => { const b = e.target.closest("button"); if (b) runArtifact(b.dataset.k); });
    calm();
  }
  function clearOut() { S.art = S.syn = null; $("#st-art-out").innerHTML = ""; $("#st-syn-out").innerHTML = ""; $("#mp-out").innerHTML = ""; $("#mp-state").textContent = ""; }

  async function calm() {
    clearOut();
    $("#st-calm-info").textContent = "Recherche d’un extrait calme…";
    try {
      const c = await api(`/api/lab/stress/calm?rid=${encodeURIComponent($("#st-rec").value)}`);
      S.start = c.start; $("#st-start").value = c.start; $("#st-start-clock").textContent = clock(c.start);
      $("#st-calm-info").innerHTML = `Choisi par calcul parmi ${nf(c.n_candidates)} extraits loin des crises : probabilité maximale ${nf(c.max_proba, 3)}, amplitude typique (${nf(c.rms_uv, 1)} µV efficaces).`;
    } catch (e) { $("#st-calm-info").textContent = e.message; }
  }
  const rid = () => $("#st-rec").value;

  /* réponse de vue → extrait au format de drawExcerpt */
  function excerptOf(v, kind, a, b) {
    const part = v[kind], data = {};
    v.channels.forEach((c, k) => { data[c] = part.data[k]; });
    return { start: a, end: b, t0: v.t0, dt: part.dt, mode: "raw", channels: v.channels, data };
  }
  function busy(btns, on) { btns.forEach(b => { b.disabled = on; b.classList.toggle("is-busy", on); }); }

  // ---------------- a) artefacts
  async function runArtifact(kind) {
    if (S.start == null) return;
    const out = $("#st-art-out"), btns = $$("#st-arts button");
    busy(btns, true);
    stateLine(out, "loading", `${ART_LABELS[kind]} : injection et analyse…`);
    try {
      S.art = await api("/api/lab/stress/artifact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rid: rid(), start: S.start, kind }) });
      renderArtifact();
    } catch (e) { stateLine(out, "error", "Analyse impossible", e.message); }
    finally { busy(btns, false); }
  }
  function renderArtifact() {
    const d = S.art, out = $("#st-art-out");
    const fa = d.verdict === "Fausse alarme";
    const affected = winRows(d, d.start, d.end);
    const pmB = Math.max(...affected.map(r => r.b)), pmA = Math.max(...affected.map(r => r.a));
    out.innerHTML = `<div class="lab-result">
      <div class="lab-verdict ${fa ? "is-bad" : "is-good"}"><p class="tool-label">Verdict</p><p class="lab-verdict-v">${fa ? "Fausse alarme" : "Pas d’alarme"}</p>
        <p class="lab-small">${esc(capital(d.label))}${d.channels_touched.length < 19 ? ` (${d.channels_touched.join(", ")})` : " (toutes les voies)"}.</p>
        <p class="lab-small">Probabilité maximale sur l’extrait : ${mono(nf(pmB, 3))} avant, ${mono(nf(pmA, 3))} après.</p>
        ${fa ? `<p class="lab-small">Détection de ${mono(nf(d.events_in_segment[0][1] - d.events_in_segment[0][0], 0) + " s")} à ${mono(clock(d.events_in_segment[0][0], 1))}.</p>` : ""}
        <p class="lab-small lab-dim">Calculé en ${nf(d.elapsed_s, 2)} s · ${esc(d.model.label)}.</p></div>
      <div class="lab-ab">
        <div class="lab-row lab-ab-head"><span class="seg" id="st-view"><button type="button" data-v="filtered" aria-pressed="${!S.rawView}">filtré (ce que voit le modèle)</button><button type="button" data-v="raw" aria-pressed="${S.rawView}">brut</button></span></div>
        <figure class="lab-card"><figcaption class="h3">Avant <span class="h3-note">temps depuis ${clock(d.start - 1)}</span></figcaption><canvas class="lab-ex" id="st-ex-b"></canvas></figure>
        <figure class="lab-card"><figcaption class="h3">Après injection <span class="h3-note">même échelle</span></figcaption><canvas class="lab-ex" id="st-ex-a"></canvas></figure>
      </div>
      <figure class="lab-card lab-probs"><figcaption class="h3">Probabilité par fenêtre <span class="h3-note">fenêtres qui touchent l’extrait</span></figcaption>
        <p class="lab-legend"><span><i class="lab-k lab-k-b"></i>avant</span><span><i class="lab-k lab-k-a"></i>après</span><span><i class="lab-k lab-k-t"></i>seuil 0,5</span></p>
        <div id="st-art-bars"></div></figure></div>`;
    bindSeg($("#st-view"), v => { S.rawView = v === "raw"; drawAB(); });
    drawAB();
    $("#st-art-bars").innerHTML = bars(affected, $("#st-art-bars").clientWidth);
  }
  function drawAB() {
    const d = S.art; if (!d) return;
    const kind = S.rawView && d.view_before.raw ? "raw" : "filtered";
    const a = d.start - 1, b = d.end + 1;
    const exB = excerptOf(d.view_before, kind, a, b), exA = excerptOf(d.view_after, kind, a, b);
    const cvB = $("#st-ex-b"), lane = (cvB.clientHeight - 30) / exB.channels.length;
    const uv = (3 * robustUv(exB)) / (0.42 * lane);
    const band = [{ start: d.start, end: d.end, fill: C["window-fill"] }];
    const evs = d.events_in_segment.map(([s, e]) => ({ start: s, end: e, fill: "rgba(248,220,196,0.6)", edge: C["coral-edge"], hatch: true }));
    const o = { uvPerPx: uv, padLeft: 34, clipLanes: 1.1, scaleBar: true, relative: true };
    drawExcerpt(cvB, exB, { ...o, bands: band });
    drawExcerpt($("#st-ex-a"), exA, { ...o, bands: [...band, ...evs] });
  }
  function winRows(d, a, b) {
    const rows = [];
    d.after.t_start.forEach((s, i) => {
      const e = d.after.t_end[i];
      if (s < b && e > a) {
        const j = d.before.t_start.indexOf(s);
        rows.push({ s, e, a: d.after.proba[i], b: j >= 0 ? d.before.proba[j] : null });
      }
    });
    return rows;
  }
  /* barres groupées (avant / après) par fenêtre, seuil en pointillés ; une seule échelle 0–1 */
  function bars(rows, W = 760) {
    const H = 150, m = { l: 34, r: 8, t: 8, b: 26 };
    const bw = (W - m.l - m.r) / rows.length, Y = v => H - m.b - v * (H - m.t - m.b);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg lab-bars" role="img" aria-label="Probabilité par fenêtre avant et après">`;
    for (const v of [0, 0.5, 1]) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0.5 ? "lab-thr" : "lab-grid"}"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="lab-tick" text-anchor="end">${nf(v, v === 0.5 ? 1 : 0)}</text>`;
    rows.forEach((r, i) => {
      const x = m.l + i * bw, w = Math.max(2, bw / 2 - 3);
      const title = `${clock(r.s)}–${clock(r.e)} : ${r.b == null ? "—" : nf(r.b, 3)} avant, ${nf(r.a, 3)} après`;
      if (r.b != null) s += `<rect x="${x + 2}" y="${Y(r.b)}" width="${w}" height="${Math.max(0, Y(0) - Y(r.b))}" rx="2" class="lab-bar-b"><title>${title}</title></rect>`;
      s += `<rect x="${x + 2 + w + 2}" y="${Y(r.a)}" width="${w}" height="${Math.max(0, Y(0) - Y(r.a))}" rx="2" class="lab-bar-a ${r.a > 0.5 ? "is-high" : ""}"><title>${title}</title></rect>`;
      if (i % 2 === 0) s += `<text x="${x + bw / 2}" y="${H - 8}" class="lab-tick" text-anchor="middle">${clock(r.s)}</text>`;
    });
    return s + "</svg>";
  }

  // ---------------- b) décharge synthétique
  const synModel = () => $("#sy-model [aria-pressed='true']").dataset.v;     // modèle du projet ou modèle augmenté
  function synParams() { return { freq: +$("#sy-freq").value, amp: +$("#sy-amp").value, dur: +$("#sy-dur").value, regularity: +$("#sy-reg").value, model: synModel() }; }
  async function runSynth() {
    if (S.start == null) return;
    const out = $("#st-syn-out"), btn = $("#sy-run");
    busy([btn], true);
    if (!S.syn) stateLine(out, "loading", "Injection et analyse de la décharge…");
    try {
      S.syn = await api("/api/lab/stress/synth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rid: rid(), start: S.start, ...synParams() }) });
      renderSynth();
    } catch (e) { stateLine(out, "error", "Analyse impossible", e.message); }
    finally { busy([btn], false); }
  }
  function renderSynth() {
    const d = S.syn, ds = S.info.dataset, out = $("#st-syn-out");
    const ok = d.detected;
    out.innerHTML = `<div class="lab-verdict ${ok ? "is-good" : "is-bad"} lab-verdict-row">
        <div><p class="tool-label">Verdict</p><p class="lab-verdict-v">${ok ? "Détectée" : "Non détectée"}</p></div>
        <div class="lab-small">${ok ? `Alarme ${d.delay >= 0 ? "après" : "avant"} le début réel de la décharge : retard ${mono(fmtS(d.delay))}.` : "Le modèle n’a pas déclenché d’alarme sur la décharge."}
          Probabilité moyenne pendant la décharge : ${mono(nf(d.mean_proba, 3))} (maximum ${mono(nf(d.max_proba, 3))}).<br>
          Ce que mesure la chaîne : amplitude ${mono(nf(d.measured_amplitude, 0) + " µV")} et fréquence du pic ${mono(nf(d.measured_peak_freq, 2) + " Hz")} (médianes des fenêtres) ; sur les vraies crises du jeu d’entraînement, ${mono(nf(ds.seizure_amplitude, 0) + " µV")} et ${mono(nf(ds.seizure_peak_freq, 2) + " Hz")}.
          ${d.fa_outside ? `<br>Hors de la décharge : ${plural(d.fa_outside, "détection", "détections")}.` : ""}<br><span class="lab-dim">Calculé en ${nf(d.elapsed_s, 2)} s · ${esc(d.model.label)}.</span></div></div>
      <figure class="lab-card"><figcaption class="h3">EEG avec la décharge injectée <span class="h3-note">filtré comme pour la détection</span></figcaption><canvas class="lab-ex lab-ex-syn" id="sy-ex"></canvas>
        <p class="lab-legend"><span><span class="sw sw-win" aria-hidden="true"></span>décharge injectée</span><span><span class="sw sw-det" aria-hidden="true"></span>détection du modèle</span></p></figure>
      <figure class="lab-card"><figcaption class="h3">Probabilité par fenêtre</figcaption><div id="sy-probs"></div></figure>`;
    const v = d.view, a = v.t0, b = v.t0 + v.filtered.data[0].length * v.filtered.dt;
    const ex = excerptOf(v, "filtered", a, b);
    const bands = [{ start: d.onset, end: d.end, fill: C["window-fill"] }, ...d.after.events.filter(([s, e]) => s < b && e > a).map(([s, e]) => ({ start: s, end: e, fill: "rgba(248,220,196,0.6)", edge: C["coral-edge"], hatch: true }))];
    // échelle fixe (200 µV par couloir) : deux essais restent comparables d'un coup d'œil
    const cv = $("#sy-ex"), lane = (cv.clientHeight - 30) / ex.channels.length;
    drawExcerpt(cv, ex, { bands, padLeft: 34, clipLanes: 1.6, uvPerPx: 200 / lane, scaleBar: true });
    $("#sy-probs").innerHTML = probLine(d, a, b, $("#sy-probs").clientWidth);
  }
  function probLine(d, a, b, W = 760) {
    const H = 150, m = { l: 34, r: 8, t: 8, b: 24 };
    const X = t => m.l + (t - a) / (b - a) * (W - m.l - m.r), Y = v => H - m.b - v * (H - m.t - m.b);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg" role="img" aria-label="Probabilité par fenêtre autour de la décharge">`;
    s += `<rect x="${X(d.onset)}" y="${m.t}" width="${Math.max(0, X(d.end) - X(d.onset))}" height="${H - m.t - m.b}" class="lab-inj"/>`;
    for (const v of [0, 0.5, 1]) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0.5 ? "lab-thr" : "lab-grid"}"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="lab-tick" text-anchor="end">${nf(v, v === 0.5 ? 1 : 0)}</text>`;
    const pts = d.after.t_start.map((t, i) => [t + 1, d.after.proba[i], d.after.t_start[i], d.after.t_end[i]]).filter(q => q[0] >= a && q[0] <= b);
    s += `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${X(q[0]).toFixed(1)} ${Y(q[1]).toFixed(1)}`).join("")}" class="lab-line"/>`;
    for (const q of pts) s += `<circle cx="${X(q[0])}" cy="${Y(q[1])}" r="4" class="lab-pt ${q[1] > 0.5 ? "is-high" : ""}"><title>fenêtre ${clock(q[2])}–${clock(q[3])} : ${nf(q[1], 3)}</title></circle>`;
    for (let t = Math.ceil(a / 2) * 2; t <= b; t += 2) s += `<text x="${X(t)}" y="${H - 6}" class="lab-tick" text-anchor="middle">${clock(t)}</text>`;
    return s + "</svg>";
  }
  function drawTemplate() {
    const f = +$("#sy-freq").value, svg = $("#sy-tpl");
    // même forme que spike_wave (laboratoire.py), pour illustrer seulement
    const T = 1 / f, n = 240, ys = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * T, u = t % T;
      const spike = -0.7 * Math.exp(-0.5 * ((u - 0.035) / 0.011) ** 2), bump = 0.35 * Math.exp(-0.5 * ((u - 0.075) / 0.02) ** 2);
      const v = (u - 0.1) / (0.9 * Math.max(0.02, T - 0.1));
      ys.push(spike + bump + (v >= 0 && v <= 1 ? -Math.sin(Math.PI * v) : 0));
    }
    const lo = Math.min(...ys), hi = Math.max(...ys);
    svg.innerHTML = `<line x1="0" x2="240" y1="35" y2="35" class="lab-grid"/><path class="lab-tpl" d="${ys.map((y, i) => `${i ? "L" : "M"}${i.toFixed(0)} ${(62 - (y - lo) / (hi - lo) * 54).toFixed(1)}`).join("")}"/>` +
      `<text x="236" y="12" class="lab-tick" text-anchor="end">${nf(2 * T * 1000, 0)} ms</text>`;
  }

  // ---------------- c) carte de détection
  async function runMap() {
    if (S.start == null) return;
    const p = synParams(), btn = $("#mp-run"), bar = $("#mp-bar"), prog = $("#mp-progress");
    busy([btn], true); prog.hidden = false; bar.style.width = "0%";
    $("#mp-state").textContent = "Balayage en cours…";
    try {
      const { job } = await api("/api/lab/stress/map", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rid: rid(), start: S.start, dur: p.dur, regularity: p.regularity, model: p.model }) });
      for (;;) {
        const d = await api(`/api/lab/stress/map/${job}`);
        if (d.status === "done") { S.map = d; break; }
        if (d.status === "error") throw new Error(d.error || "le calcul a échoué");
        bar.style.width = `${100 * d.done / d.total}%`;
        $("#mp-state").textContent = `Balayage : ${d.done} sur ${d.total} combinaisons (${d.current || "…"}), ${nf(d.elapsed_s, 0)} s`;
        await new Promise(r => setTimeout(r, 600));
      }
      bar.style.width = "100%";
      $("#mp-state").textContent = S.map.cached ? `Résultat relu dans le cache (calculé en ${nf(S.map.computed_in_s, 0)} s).` : `Calculé en ${nf(S.map.computed_in_s, 0)} s, gardé en cache.`;
      renderMap();
    } catch (e) { $("#mp-state").textContent = `Échec : ${e.message}`; }
    finally { busy([btn], false); setTimeout(() => { prog.hidden = true; }, 800); }
  }
  /* rampe séquentielle d'une seule teinte (rose pâle → berry foncé), interpolée en RGB */
  const RAMP = ["#FFF4F7", "#F9D3DF", "#EDA3BA", "#D46F93", "#A33E61", "#6A1E39"];
  function ramp(v) {
    const x = Math.max(0, Math.min(1, v)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
    const c = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
    const a = c(RAMP[i]), b = c(RAMP[i + 1]);
    return `rgb(${a.map((v0, k) => Math.round(v0 + (b[k] - v0) * f)).join(",")})`;
  }
  function renderMap() {
    const d = S.map, out = $("#mp-out");
    const nF = d.freqs.length, nA = d.amps.length;
    const cw = 46, ch = 30, m = { l: 66, t: 10, r: 120, b: 46 };
    const W = m.l + nF * cw + m.r, H = m.t + nA * ch + m.b;
    let s = `<svg viewBox="0 0 ${W} ${H}" class="lab-svg lab-map" role="img" aria-label="Carte de la probabilité de détection selon la fréquence et l’amplitude">`;
    for (let i = 0; i < nA; i++) for (let j = 0; j < nF; j++) {
      const p = d.proba[i][j], det = d.detected[i][j], x = m.l + j * cw, y = m.t + (nA - 1 - i) * ch;
      const tip = `${nf(d.freqs[j], 2)} Hz, ${d.amps[i]} µV : probabilité moyenne ${p == null ? "—" : nf(p, 3)} — ${det ? `détectée (retard ${fmtS(d.delay[i][j])})` : "non détectée"}`;
      s += `<g class="lab-cell" tabindex="0"><rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${ramp(p || 0)}"/>` +
        (det ? `<circle cx="${x + cw / 2}" cy="${y + ch / 2}" r="4.5" class="lab-cell-det ${p > 0.6 ? "on-dark" : ""}"/>` : "") + `<title>${tip}</title></g>`;
    }
    d.freqs.forEach((f, j) => { if (j % 2 === 0) s += `<text x="${m.l + j * cw + cw / 2}" y="${m.t + nA * ch + 16}" class="lab-tick" text-anchor="middle">${nf(f, f % 1 ? 1 : 0)}</text>`; });
    d.amps.forEach((a, i) => { if (i % 2 === 0) s += `<text x="${m.l - 8}" y="${m.t + (nA - 1 - i) * ch + ch / 2 + 4}" class="lab-tick" text-anchor="end">${a}</text>`; });
    s += `<text x="${m.l + nF * cw / 2}" y="${H - 6}" class="lab-axis" text-anchor="middle">fréquence de la décharge (Hz)</text>`;
    s += `<text x="16" y="${m.t + nA * ch / 2}" class="lab-axis" text-anchor="middle" transform="rotate(-90 16 ${m.t + nA * ch / 2})">amplitude (µV)</text>`;
    // légende : rampe 0 → 1 et marque de détection
    const lx = m.l + nF * cw + 26, lh = nA * ch;
    for (let k = 0; k < 40; k++) s += `<rect x="${lx}" y="${m.t + lh - (k + 1) * lh / 40}" width="14" height="${lh / 40 + 0.5}" fill="${ramp(k / 39)}"/>`;
    for (const v of [0, 0.5, 1]) s += `<text x="${lx + 20}" y="${m.t + lh - v * lh + 4}" class="lab-tick">${nf(v, v === 0.5 ? 1 : 0)}</text>`;
    s += `<text x="${lx + 62}" y="${m.t + lh / 2}" class="lab-tick" transform="rotate(-90 ${lx + 62} ${m.t + lh / 2})" text-anchor="middle">probabilité moyenne</text>` +
      `<circle cx="${lx + 7}" cy="${m.t + lh + 22}" r="4.5" class="lab-cell-det"/><text x="${lx + 16}" y="${m.t + lh + 26}" class="lab-tick">détectée</text>`;
    s += "</svg>";
    const sm = d.summary, sh = d.shap;
    const ampWins = sm.var_amplitude >= sm.var_frequency;
    let sentence = `La détection dépend surtout de ${ampWins ? "l’amplitude" : "la fréquence"} : ${ampWins ? "l’amplitude" : "la fréquence"} explique ${pct(ampWins ? sm.var_amplitude : sm.var_frequency, 0)} de la variation de la probabilité sur la carte, contre ${pct(ampWins ? sm.var_frequency : sm.var_amplitude, 0)} pour ${ampWins ? "la fréquence" : "l’amplitude"}.`;
    if (sh) {
      const shapAmp = sh.amplitude_share >= sh.frequency_share;
      sentence += ` Cela ${shapAmp === ampWins ? "confirme" : "contredit"} l’analyse SHAP du notebook, où les variables d’amplitude pèsent ${pct(sh.amplitude_share, 0)} de l’importance totale contre ${pct(sh.frequency_share, 0)} pour celles de fréquence (variable la plus importante : ${esc(sh.top)}).`;
    }
    const firsts = d.freqs.map((f, j) => [f, sm.first_detected_amp[j]]).filter(q => q[1] != null);
    out.innerHTML = `<div class="lab-map-wrap"><figure class="lab-card lab-map-fig">${s}</figure>
      <div class="lab-map-text"><p class="r-facts lab-sentence">${sentence}</p>
      <p class="body">${plural(sm.detected_cells, "combinaison détectée", "combinaisons détectées")} sur ${sm.cells}. ${firsts.length ? `Amplitude la plus faible détectée : de ${mono(Math.min(...firsts.map(q => q[1])) + " µV")} à ${mono(Math.max(...firsts.map(q => q[1])) + " µV")} selon la fréquence.` : "Aucune combinaison n’est détectée."} Les vraies crises du jeu d’entraînement ont une amplitude médiane de ${mono(nf(S.info.dataset.seizure_amplitude, 0) + " µV")} (moyenne des voies, fenêtres de 2 s).</p>
      <p class="note-small">Durée ${nf(d.params.dur)} s, régularité ${nf(d.params.regularity, 1)}, extrait ${esc(d.params.rid)} à ${clock(d.params.start)}. Chaque case : injection, filtrage, fenêtres, caractéristiques, modèle et détection. Survoler une case pour son détail.</p></div></div>`;
  }

  return { init };
})();
