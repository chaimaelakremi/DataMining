/* ==========================================================================
   Absences — page Lecture : tracé EEG, journal d’examen et analyse
   (même comportement que la version mono-page ; adressable par #/lecture/<id>?t=…)
   ========================================================================== */
"use strict";

// ---------------------------------------------------------------- état
const S = {
  recs: [], rid: null, meta: null, overview: null, journal: [],
  view: "lecture",
  start: 0, win: 20, sens: 50, hidden: new Set(),
  layers: { annot: true, det: true, journal: true },
  buf: null, fetchTimer: null, ctrl: null,
  det: {},            // rid -> résultat de détection, pour la taille de fenêtre d'analyse courante
  detByWin: {},       // taille de fenêtre d'analyse (s) -> { rid -> résultat }
  awin: null, awinDefault: null, awins: [],   // fenêtres d'analyse : courante, celle du notebook, disponibles
  job: null,          // { id, rid }
  jobErr: {},         // rid -> { step, message }
  anim: null,         // { rid, t0 } apparition des bandes détectées
  hover: null,        // { x, y } curseur sur le tracé
  models: null,
};

const WINDOWS = [10, 20, 60];
const SENS_STEPS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000];
const MM = 5;            // un « millimètre » du papier = 5 px
const GEOM = { left: 64, right: 56, top: 60, bottom: 30 };
// marge haute : trois rails (journal, crises annotées, crises détectées)
const RAIL = {
  journal: { text: 11, bar: 15, h: 6, label: "journal", y0: 0, y1: 25 },
  annot:   { text: 33, bar: 36, h: 3, label: "annot.",  y0: 25, y1: 41 },
  det:     { text: 48, bar: 51, h: 3, label: "détect.", y0: 41, y1: 58 },
};
const ANIM_MS = 250;

const displayName = r => (r.source === "upload" ? r.id.replace(/^import-/, "") : r.id);

function animCut() {
  // instant (en s) jusqu'auquel les bandes détectées sont dessinées (apparition de gauche à droite)
  const dur = S.meta ? S.meta.duration : 0;
  if (!S.anim || S.anim.rid !== S.rid) return dur;
  const p = Math.min(1, (performance.now() - S.anim.t0) / ANIM_MS);
  return (1 - Math.pow(1 - p, 3)) * dur;
}
function tickAnim() {
  if (!S.anim) return;
  drawViewer(); drawMini();
  if (performance.now() - S.anim.t0 < ANIM_MS) requestAnimationFrame(tickAnim);
  else { S.anim = null; drawViewer(); drawMini(); }
}

// ---------------------------------------------------------------- calques visibles
const detResult = () => S.det[S.rid] || null;
const annotList = () => (S.layers.annot && S.meta ? S.meta.seizures : []);
const detList = () => {
  const d = detResult();
  if (!S.layers.det || !d) return [];
  const cut = animCut();
  return d.intervals.filter(iv => iv.start < cut).map(iv => ({ ...iv, end: Math.min(iv.end, cut) }));
};
const journalList = () => (S.layers.journal ? S.journal : []);

/* Bandes de crise : annotée = vert, détectée = corail, chevauchement = bande partagée
   (vert en haut, corail en bas) pour que les deux restent lisibles. */
function paintBands(ctx, t2x, xa, xb, top, height, A, D) {
  const span = (s, e) => [Math.max(xa, t2x(s)), Math.min(xb, t2x(e))];
  const fill = (s, e, col, y, hh) => {
    const [a, b] = span(s, e);
    if (b - a <= 0) return;
    ctx.fillStyle = col; ctx.fillRect(a, y, Math.max(1, b - a), hh);
  };
  for (const iv of A) fill(iv.start, iv.end, C.sage, top, height);
  for (const iv of D) {
    fill(iv.start, iv.end, C.coral, top, height);
    const [a, b] = span(iv.start, iv.end);
    hatchRect(ctx, a, top, b - a, height);
  }
  for (const a of A) for (const d of D) {
    const s = Math.max(a.start, d.start), e = Math.min(a.end, d.end);
    if (e > s) fill(s, e, C.sage, top, height / 2);
  }
}

// ==========================================================================
// Index des enregistrements
// ==========================================================================
function renderIndex() {
  const ol = $("#rec-list");
  ol.innerHTML = "";
  if (!S.recs.length) { ol.innerHTML = '<li class="rec-empty">Aucun enregistrement trouvé dans data/.</li>'; return; }
  for (const r of S.recs) {
    const li = document.createElement("li");
    li.className = "rec-row";
    li.setAttribute("role", "option");
    li.tabIndex = r.id === S.rid ? 0 : -1;
    li.dataset.id = r.id;
    li.setAttribute("aria-selected", r.id === S.rid ? "true" : "false");
    li.title = r.source === "upload" ? "Fichier importé, sans annotation" : r.annotated ? "" : "Enregistrement sans annotation";
    const tag = r.source === "upload" ? '<span class="tag">importé</span>' : "";
    li.innerHTML =
      `<span class="rid">${esc(displayName(r))}${tag}</span>` +
      `<span class="num ${r.annotated ? "" : "muted"}">${r.annotated ? r.n_seizures : "—"}</span>` +
      `<span class="num">${clock(r.duration)}</span>`;
    li.addEventListener("click", () => go(lectureHref(r.id)));
    li.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(lectureHref(r.id)); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        const sib = e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
        if (sib) sib.focus();
      }
    });
    ol.appendChild(li);
  }
  const local = S.recs.filter(r => r.source === "local");
  const ann = local.filter(r => r.annotated);
  const nSz = ann.reduce((a, r) => a + r.n_seizures, 0);
  $("#index-total").textContent = `${local.length} enregistrements, dont ${ann.length} annotés (${nSz} crises). « — » : sans annotation.`;
}

// ==========================================================================
// Sélection d'un enregistrement
// ==========================================================================
async function selectRec(rid, opts = {}) {
  if (!S.recs.find(r => r.id === rid)) return;
  S.rid = rid; S.buf = null; S.meta = null; S.overview = null; S.journal = []; S.hidden = new Set();
  renderIndex();
  setMsg(null); setLoading(true);
  drawViewer(); drawMini(); updateLayers();
  try {
    const enc = encodeURIComponent(rid);
    const [meta, ov, jr] = await Promise.all([
      api(`/api/recordings/${enc}`),
      api(`/api/recordings/${enc}/overview`),
      api(`/api/recordings/${enc}/journal`).catch(() => []),
    ]);
    if (S.rid !== rid) return;
    S.meta = meta; S.overview = ov; S.journal = jr;
  } catch (e) {
    if (S.rid !== rid) return;
    setLoading(false);
    setMsg("Lecture impossible", `${capital(e.message)}. Vérifiez que le serveur tourne toujours dans le terminal (uvicorn app:app --port 8000).`, true);
    return;
  }
  renderHeader();
  renderChannels();
  S.start = opts.t != null ? opts.t : (S.meta.seizures.length ? Math.max(0, S.meta.seizures[0].start - 3) : 0);
  clampStart();
  autoSens();
  updateLayers();
  renderAnalysis();
  requestData(true);
  drawMini();
  writeHash();
}

function renderHeader() {
  const m = S.meta, i = S.recs.findIndex(r => r.id === m.id);
  const local = S.recs.filter(r => r.source === "local").length;
  $("#rec-kicker").textContent = m.source === "upload" ? "Fichier importé" : `Enregistrement ${i + 1} sur ${local}`;
  $("#rec-title").innerHTML = esc(displayName(m)) + (m.source === "upload" ? " <em>importé</em>" : "");
  const parts = [
    `${nf(m.fs)} Hz`,
    humanDur(m.duration),
    `${m.n_eeg} voies EEG`,
    m.annotated ? plural(m.n_seizures, "crise annotée", "crises annotées") : "non annoté",
  ];
  if (m.sex || m.age != null) parts.push([m.sex, m.age != null ? `${nf(m.age)} ans` : null].filter(Boolean).join(", "));
  if (m.type_abs) parts.push(`absences ${m.type_abs}`);
  $("#rec-meta").innerHTML = parts.map(esc).join('<span class="sep">·</span>');
  updateAnalyseBtn();
  const k = S.recs.findIndex(r => r.id === m.id);
  const prev = S.recs[k - 1], next = S.recs[k + 1];
  const pn = (r, cls, txt) => r
    ? `<a class="pn ${cls}" href="${lectureHref(r.id)}">${txt} <span class="mono">${esc(displayName(r))}</span></a>`
    : `<span class="pn ${cls} is-off" aria-disabled="true">${txt}</span>`;
  $("#rec-pn").innerHTML = pn(prev, "pn-prev", "← Précédent") + pn(next, "pn-next", "Suivant →");
  document.title = `${displayName(m)} · Lecture · Absences`;
}

function renderChannels() {
  const box = $("#ch-list");
  box.innerHTML = "";
  for (const ch of S.meta.channels) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" ${S.hidden.has(ch) ? "" : "checked"}> ${esc(label(ch))}`;
    l.querySelector("input").addEventListener("change", e => {
      if (e.target.checked) S.hidden.delete(ch); else S.hidden.add(ch);
      channelsChanged();
    });
    box.appendChild(l);
  }
  updateChCount();
}
function updateChCount() {
  const n = S.meta ? S.meta.channels.length : 0;
  $("#ch-count").textContent = `${n - S.hidden.size}/${n}`;
}
function channelsChanged() {
  updateChCount();
  S.buf = null;
  autoSens();
  requestData(true);
}
const visibleChannels = () => (S.meta ? S.meta.channels.filter(c => !S.hidden.has(c)) : []);

// ---------------------------------------------------------------- calques
function updateLayers() {
  const d = detResult(), m = S.meta;
  const set = (id, key, available, why) => {
    const b = $(id);
    b.disabled = !available;
    b.setAttribute("aria-pressed", String(S.layers[key]));
    b.title = available ? b.dataset.key : why;
  };
  $("#layer-annot").dataset.key = "Touche A";
  $("#layer-det").dataset.key = "Touche D";
  $("#layer-journal").dataset.key = "Touche J";
  set("#layer-annot", "annot", !!(m && m.annotated), "Cet enregistrement n’est pas annoté");
  set("#layer-det", "det", !!d, "Lancez l’analyse pour obtenir les crises détectées");
  set("#layer-journal", "journal", S.journal.length > 0,
      m && m.source === "upload" ? "Fichier importé : pas de journal d’examen" : "Pas de journal d’examen (_0000h.mat) pour ce tracé");
}
function toggleLayer(key) {
  S.layers[key] = !S.layers[key];
  updateLayers(); drawViewer(); drawMini(); updateTip();
}

// ---------------------------------------------------------------- sensibilité
function laneHeight() {
  const cv = $("#eeg-canvas");
  return (cv.clientHeight - GEOM.top - GEOM.bottom) / Math.max(1, visibleChannels().length);
}
function autoSens() {
  if (!S.overview) return;
  // ±3 écarts-types robustes tiennent dans un demi-couloir : le fond reste lisible, les pointes-ondes débordent
  const target = (3 * S.overview.typical_uv) / (0.5 * laneHeight()) * MM;
  S.sens = SENS_STEPS.find(v => v >= target) || SENS_STEPS[SENS_STEPS.length - 1];
  renderSens();
}
function renderSens() {
  $("#sens-val").textContent = `${nf(S.sens)} µV/mm`;
  const i = SENS_STEPS.indexOf(S.sens);
  $("#sens-up").disabled = i <= 0;
  $("#sens-down").disabled = i >= SENS_STEPS.length - 1;
}
function stepSens(dir) {
  const i = SENS_STEPS.indexOf(S.sens);
  const j = Math.max(0, Math.min(SENS_STEPS.length - 1, (i < 0 ? 8 : i) + dir));
  S.sens = SENS_STEPS[j]; renderSens(); drawViewer(); updateTip();
}

// ---------------------------------------------------------------- position
function clampStart() {
  const dur = S.meta ? S.meta.duration : 0;
  S.start = Math.max(0, Math.min(S.start, Math.max(0, dur - S.win)));
}
function moveTo(t, fetch = true) {
  S.start = t; clampStart();
  drawViewer(); drawMini(); renderPos(); updateTip();
  if (fetch) requestData(false);
}
function renderPos() {
  if (!S.meta) { $("#pos-label").textContent = ""; return; }
  $("#pos-label").innerHTML = `${clock(S.start, 1)} – ${clock(Math.min(S.meta.duration, S.start + S.win), 1)}<span class="pos-total"> / ${clock(S.meta.duration)}</span>`;
}
function setWin(w) {
  if (!WINDOWS.includes(w)) return;
  const center = S.start + S.win / 2;
  S.win = w;
  $$("#win-seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.win === w)));
  S.start = center - w / 2; clampStart();
  S.buf = null;
  requestData(true); drawMini(); renderPos(); writeHash();
}
function zoomWin(dir) {
  const i = WINDOWS.indexOf(S.win);
  setWin(WINDOWS[Math.max(0, Math.min(WINDOWS.length - 1, i + dir))]);
}

// ==========================================================================
// Données du tracé : on demande ~3 fenêtres (une de part et d'autre) pour
// pouvoir glisser sans attendre le serveur.
// ==========================================================================
function bufCovers() {
  const b = S.buf;
  return b && b.rid === S.rid && b.win === S.win &&
         b.start <= S.start + 1e-6 && b.end >= Math.min(S.meta.duration, S.start + S.win) - 1e-6;
}
function requestData(immediate) {
  if (!S.meta) return;
  drawViewer(); renderPos();
  if (bufCovers()) return;
  clearTimeout(S.fetchTimer);
  S.fetchTimer = setTimeout(fetchData, immediate ? 0 : 50);
}
async function fetchData() {
  if (!S.meta) return;
  const chans = visibleChannels();
  if (!chans.length) {
    S.buf = null; setLoading(false); drawViewer();
    setMsg("Aucune voie affichée", "Ouvrez « Voies » dans la barre d’outils et cochez au moins une électrode.");
    return;
  }
  const dur = S.meta.duration;
  const a = Math.max(0, S.start - S.win), b = Math.min(dur, S.start + 2 * S.win);
  const pw = $("#eeg-canvas").clientWidth - GEOM.left - GEOM.right;
  const width = Math.max(64, Math.min(8000, Math.round(pw * (b - a) / S.win)));
  if (S.ctrl) S.ctrl.abort();
  S.ctrl = new AbortController();
  const rid = S.rid, win = S.win;
  const q = new URLSearchParams({ start: a.toFixed(3), end: b.toFixed(3), width, channels: chans.join(",") });
  if (!S.buf) setLoading(true);
  try {
    const corrupt = Voies.corruptParam(chans);          // voies corrompues : même panne que le Laboratoire
    if (corrupt) { q.set("rid", rid); q.set("corrupt", corrupt); }
    const resp = await api(corrupt ? `/api/electrodes/signal?${q}` : `/api/recordings/${encodeURIComponent(rid)}/signal?${q}`, { signal: S.ctrl.signal });
    if (rid !== S.rid) return;
    S.buf = { rid, win, start: a, end: b, resp };
    setLoading(false); setMsg(null);
    drawViewer(); updateTip();
    if (!bufCovers()) requestData(false);
  } catch (e) {
    if (e.name === "AbortError") return;
    setLoading(false);
    setMsg("Signal indisponible", `${capital(e.message)}. Vérifiez que le serveur tourne toujours (uvicorn app:app --port 8000), puis déplacez légèrement le tracé pour réessayer.`, true);
  }
}
function setMsg(title, hint = "", isError = false) {
  const el = $("#viewer-msg");
  el.hidden = !title;
  el.classList.toggle("is-error", !!isError);
  $("#msg-title").textContent = title || "";
  $("#msg-hint").textContent = hint || "";
}
function setLoading(on) { $("#viewer-loading").hidden = !on; }

// ==========================================================================
// Dessin du tracé EEG
// ==========================================================================
function viewerGeom() {
  const cv = $("#eeg-canvas");
  const w = cv.clientWidth, h = cv.clientHeight;
  const x0 = GEOM.left, x1 = w - GEOM.right, y0 = GEOM.top, y1 = h - GEOM.bottom;
  return { w, h, x0, x1, y0, y1, pw: x1 - x0, ph: y1 - y0 };
}

function drawViewer() {
  const cv = $("#eeg-canvas");
  const { ctx, w, h } = fitCanvas(cv);
  const { x0, x1, y0, y1, pw, ph } = viewerGeom();
  ctx.clearRect(0, 0, w, h);

  const t2x = t => x0 + (t - S.start) / S.win * pw;
  const tEnd = S.start + S.win;
  const chans = visibleChannels();
  const lane = ph / Math.max(1, chans.length);
  const A = annotList(), D = detList();
  const hov = hoverInfo();

  // --- 1. bandes de crise, sous la grille et les traces
  if (S.meta) paintBands(ctx, t2x, x0, x1, y0, ph, A, D);

  // --- 2. voie survolée (lavande pâle)
  if (hov && hov.zone === "plot" && hov.lane != null) {
    ctx.fillStyle = C["hover-lane"]; ctx.fillRect(x0, y0 + lane * hov.lane, pw, lane);
  }

  // --- 3. grille millimétrée : petits carreaux de 1 mm, traits majeurs chaque seconde
  ctx.lineWidth = 1;
  const pxPerS = pw / S.win;
  ctx.strokeStyle = C["grid-minor"]; ctx.beginPath();
  if (pxPerS * 0.2 >= 6) {
    for (let t = Math.ceil(S.start / 0.2) * 0.2; t <= tEnd + 1e-9; t += 0.2) {
      if (Math.abs(t - Math.round(t)) < 1e-6) continue;
      const x = crisp(t2x(t)); ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
  }
  for (let y = y0 + MM, k = 1; y < y1; y += MM, k++) if (k % 5) { ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); }
  ctx.stroke();
  ctx.strokeStyle = C["grid-major"]; ctx.beginPath();
  for (let t = Math.ceil(S.start); t <= tEnd + 1e-9; t += 1) { const x = crisp(t2x(t)); ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = y0 + 5 * MM; y < y1; y += 5 * MM) { ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); }
  ctx.stroke();
  if (!S.meta) return;

  // --- 4. bords des détections (traits corail fins)
  ctx.fillStyle = C["coral-edge"];
  for (const iv of D) {
    const a = t2x(iv.start), b = t2x(iv.end);
    if (a >= x0 && a <= x1) ctx.fillRect(Math.round(a), y0, 1, ph);
    if (iv.end === (detResult().intervals.find(d => d.n === iv.n) || {}).end && b >= x0 && b <= x1) ctx.fillRect(Math.round(b) - 1, y0, 1, ph);
  }

  // --- 5. libellés des voies
  ctx.font = `11px ${C.mono}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  chans.forEach((ch, i) => {
    const yc = y0 + lane * (i + 0.5);
    const isHov = hov && hov.zone === "plot" && hov.lane === i;
    if (isHov) {
      const tw = ctx.measureText(label(ch)).width;
      ctx.fillStyle = C.lav; roundRect(ctx, x0 - 14 - tw - 5, yc - 8, tw + 10, 16, 3); ctx.fill();
    }
    const vs = Voies.state(ch);
    ctx.fillStyle = vs === "retiree" ? C["rule-strong"] : vs ? (C.berry || "#A33E61") : isHov ? C.ink : C["ink-2"];
    ctx.fillText(label(ch), x0 - 14, yc);
    ctx.fillStyle = C["rule-strong"]; ctx.fillRect(x0 - 6, Math.round(yc), 4, 1);
  });

  // --- 6. traces
  const buf = S.buf && S.buf.rid === S.rid ? S.buf : null;
  const pxPerUV = MM / S.sens;
  if (buf) {
    const r = buf.resp;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip();
    ctx.strokeStyle = C.ink; ctx.lineWidth = (window.devicePixelRatio || 1) >= 2 ? 0.9 : 1;
    ctx.lineJoin = "round";
    const i0 = Math.max(0, Math.floor((S.start - r.t0) / r.dt) - 2);
    chans.forEach((ch, k) => {
      const d = r.data[ch];
      if (!d) return;
      const yc = y0 + lane * (k + 0.5);
      const lim = lane * 1.3;
      const Y = v => yc - Math.max(-lim, Math.min(lim, v * pxPerUV));
      const vs = Voies.state(ch);                          // retirée : grisée ; corrompue : en couleur
      ctx.strokeStyle = vs === "retiree" ? C["rule-strong"] : vs ? (C.berry || "#A33E61") : C.ink;
      ctx.beginPath();
      if (r.mode === "raw") {
        const i1 = Math.min(d.length, Math.ceil((tEnd - r.t0) / r.dt) + 2);
        for (let i = i0; i < i1; i++) {
          const x = t2x(r.t0 + i * r.dt), y = Y(d[i]);
          i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      } else {
        const mn = d.min, mx = d.max, i1 = Math.min(mn.length, Math.ceil((tEnd - r.t0) / r.dt) + 2);
        for (let i = i0; i < i1; i++) {
          const x = t2x(r.t0 + (i + 0.5) * r.dt);
          if (i === i0) ctx.moveTo(x, Y(mx[i])); else ctx.lineTo(x, Y(mx[i]));
          ctx.lineTo(x, Y(mn[i]));
        }
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  // --- 7. rails de la marge haute
  ctx.font = `500 9.5px ${C.sans}`; ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = C["ink-3"];
  for (const key of ["journal", "annot", "det"]) {
    const R = RAIL[key];
    ctx.fillText(R.label.toUpperCase(), x0 - 10, R.bar + R.h / 2);
  }
  ctx.strokeStyle = C.rule; ctx.beginPath(); ctx.moveTo(x0, crisp(y0 - 3)); ctx.lineTo(x1, crisp(y0 - 3)); ctx.stroke();
  drawJournalRail(ctx, t2x, x0, x1, tEnd);
  drawSeizureRail(ctx, t2x, x0, x1, tEnd, A, RAIL.annot, C["sage-edge"], C["sage-ink"], "A");
  drawSeizureRail(ctx, t2x, x0, x1, tEnd, D, RAIL.det, C["coral-edge"], C["coral-ink"], "D");

  // --- 8. axe du temps
  ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, crisp(y1)); ctx.lineTo(x1, crisp(y1)); ctx.stroke();
  const step = S.win <= 10 ? 1 : S.win <= 20 ? 2 : 5;
  const minor = S.win <= 20 ? 0.5 : 1;
  ctx.beginPath();
  for (let t = Math.ceil(S.start / minor) * minor; t <= tEnd + 1e-9; t += minor) {
    const x = crisp(t2x(t)), major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ctx.moveTo(x, y1); ctx.lineTo(x, y1 + (major ? 6 : 3));
  }
  ctx.strokeStyle = C["ink-3"]; ctx.stroke();
  ctx.fillStyle = C["ink-2"]; ctx.font = `10.5px ${C.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let t = Math.ceil(S.start / step) * step; t <= tEnd + 1e-9; t += step) {
    const x = t2x(t);
    if (x < x0 + 18 || x > x1 - 18) continue;
    ctx.fillText(clock(t), x, y1 + 9);
  }

  // --- 9. étalonnage dans la marge droite : 10 mm verticaux
  const calX = x1 + 14, calH = MM * 10, calY = y1 - 6;
  ctx.strokeStyle = C.ink; ctx.beginPath();
  ctx.moveTo(crisp(calX), calY - calH); ctx.lineTo(crisp(calX), calY);
  ctx.moveTo(calX - 3, crisp(calY - calH)); ctx.lineTo(calX + 4, crisp(calY - calH));
  ctx.moveTo(calX - 3, crisp(calY)); ctx.lineTo(calX + 4, crisp(calY));
  ctx.stroke();
  ctx.fillStyle = C["ink-2"]; ctx.font = `10px ${C.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(nf(S.sens * 10), calX + 7, calY - calH / 2 - 6);
  ctx.fillText("µV", calX + 7, calY - calH / 2 + 7);

  // --- 10. réticule
  if (hov && hov.x >= x0 && hov.x <= x1) {
    ctx.strokeStyle = C["lav-edge"]; ctx.globalAlpha = 0.7;
    ctx.beginPath(); ctx.moveTo(crisp(hov.x), hov.zone === "plot" ? y0 : 0); ctx.lineTo(crisp(hov.x), y1); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  Anom.draw();
}

function drawSeizureRail(ctx, t2x, x0, x1, tEnd, list, R, edge, ink, prefix) {
  ctx.font = `10px ${C.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  for (const iv of list) {
    if (iv.end <= S.start || iv.start >= tEnd) continue;
    const a = Math.max(x0, t2x(iv.start)), b = Math.min(x1, t2x(iv.end));
    ctx.fillStyle = edge; ctx.fillRect(a, R.bar, Math.max(1, b - a), R.h);
    const txt = prefix + iv.n;
    if (b - a > ctx.measureText(txt).width + 6) { ctx.fillStyle = ink; ctx.fillText(txt, a + 2, R.text); }
  }
}

function drawJournalRail(ctx, t2x, x0, x1, tEnd) {
  const R = RAIL.journal, J = journalList();
  if (!J.length) {
    if (S.meta && S.layers.journal) {
      ctx.font = `italic 10px ${C.sans}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(S.journal.length ? "" : (S.meta.source === "upload" ? "pas de journal (fichier importé)" : "pas de journal d’examen"), x0, R.bar + R.h / 2);
    }
    return;
  }
  let textEnd = -Infinity;
  const putText = (txt, x, color, font) => {
    ctx.font = font; const tw = ctx.measureText(txt).width;
    if (x < textEnd + 6 || x + tw > x1) return false;
    ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(txt, x, R.text); textEnd = x + tw; return true;
  };
  const inView = t => t >= S.start && t <= tEnd;
  // intervalles HPN / SLI
  for (const g of J.filter(e => e.type === "hpn" || e.type === "sli")) {
    if (g.end_s < S.start || g.time_s > tEnd) continue;
    const a = Math.max(x0, t2x(g.time_s)), b = Math.min(x1, t2x(Math.max(g.end_s, g.time_s + 0.5)));
    ctx.fillStyle = C.blue; ctx.fillRect(a, R.bar, Math.max(2, b - a), R.h);
    ctx.strokeStyle = C["blue-edge"]; ctx.strokeRect(crisp(a), crisp(R.bar), Math.max(1, Math.round(b - a) - 1), R.h - 1);
    ctx.fillStyle = C["blue-edge"];
    for (const st of g.steps) if (inView(st.time_s)) ctx.fillRect(Math.round(t2x(st.time_s)), R.bar - 3, 1, R.h + 3);
    putText(g.label, a + 2, C["blue-ink"], `500 10px ${C.sans}`);
    for (const st of g.steps) {
      if (!inView(st.time_s)) continue;
      putText(stepLabel(g, st), t2x(st.time_s) + 3, C["blue-ink"], `10px ${C.mono}`);
    }
  }
  // événements ponctuels
  for (const e of J) {
    if (!inView(e.time_s)) continue;
    const x = Math.round(t2x(e.time_s));
    if (e.type === "saturation") {
      ctx.fillStyle = C.butter; ctx.fillRect(x - 2, R.bar - 4, 4, R.h + 8);
      ctx.strokeStyle = C["butter-edge"]; ctx.strokeRect(x - 1.5, R.bar - 3.5, 3, R.h + 7);
    } else if (e.type === "yeux") {
      ctx.fillStyle = C["ink-3"]; ctx.fillRect(x, R.bar, 1, R.h);
      putText(e.label, x + 3, C["ink-2"], `10px ${C.mono}`);
    } else if (e.type === "autre") {
      ctx.fillStyle = C["ink-3"]; ctx.fillRect(x, R.bar + 1, 1, R.h - 2);
    }
  }
}
function stepLabel(g, st) {
  if (g.type === "sli") return st.freq_hz != null ? `${nf(st.freq_hz)} Hz` : st.label;
  const m = st.label.match(/(\d\d):(\d\d):(\d\d)/);
  if (m) return `${m[2]}:${m[3]}`;
  return /fin/i.test(st.label) ? "fin" : "";
}

// ==========================================================================
// Survol du tracé : réticule et info-bulle
// ==========================================================================
function hoverInfo() {
  if (!S.hover || !S.meta) return null;
  const { x0, x1, y0, y1, pw, ph } = viewerGeom();
  const { x, y } = S.hover;
  if (x < x0 || x > x1 || y > y1) return null;
  const t = S.start + (x - x0) / pw * S.win;
  if (y >= y0) {
    const chans = visibleChannels();
    const lane = Math.min(chans.length - 1, Math.floor((y - y0) / (ph / Math.max(1, chans.length))));
    return { zone: "plot", x, y, t, lane: chans.length ? lane : null, ch: chans[lane] };
  }
  const zone = y < RAIL.journal.y1 ? "journal" : y < RAIL.annot.y1 ? "annot" : "det";
  return { zone, x, y, t };
}

function sampleAt(ch, t) {
  const b = S.buf;
  if (!b || b.rid !== S.rid || !b.resp.data[ch]) return null;
  const r = b.resp, d = r.data[ch];
  if (r.mode === "raw") {
    const i = Math.round((t - r.t0) / r.dt);
    return i >= 0 && i < d.length ? { v: d[i] } : null;
  }
  const i = Math.floor((t - r.t0) / r.dt);
  return i >= 0 && i < d.min.length ? { min: d.min[i], max: d.max[i] } : null;
}

function journalAt(t, x) {
  const J = journalList(), pxPerS = viewerGeom().pw / S.win;
  const near = J.filter(e => !["hpn", "sli"].includes(e.type) && Math.abs(e.time_s - t) * pxPerS <= 5)
                .sort((a, b) => Math.abs(a.time_s - t) - Math.abs(b.time_s - t));
  if (near.length) return { point: near[0] };
  const g = J.find(e => (e.type === "hpn" || e.type === "sli") && t >= e.time_s && t <= e.end_s);
  if (g) return { group: g, step: [...g.steps].reverse().find(s => s.time_s <= t) || g.steps[0] };
  return null;
}

function updateTip() {
  const tip = $("#eeg-tip"), h = hoverInfo();
  if (!h) { tip.hidden = true; return; }
  const lines = [];
  const inIv = list => list.find(iv => h.t >= iv.start && h.t <= iv.end);
  if (h.zone === "plot") {
    lines.push(`<b>${nf(h.t, 2)} s</b> <span class="t-dim">${clock(h.t, 1)}</span>`);
    if (h.ch) {
      const s = sampleAt(h.ch, h.t);
      const amp = !s ? '<span class="t-dim">—</span>'
        : s.v != null ? `${signed(s.v, 1)} µV`
        : `${signed(s.min, 0)} à ${signed(s.max, 0)} µV`;
      lines.push(`<span class="t-ch">${esc(label(h.ch))}</span>  ${amp}`);
    }
    const a = inIv(annotList()), d = inIv(detList());
    if (a) lines.push(`<span class="t-sage">crise annotée A${a.n}</span>`);
    if (d) lines.push(`<span class="t-coral">crise détectée D${d.n}</span>`);
  } else if (h.zone === "journal") {
    const j = journalAt(h.t, h.x);
    if (!j) { tip.hidden = true; return; }
    if (j.point) {
      const e = j.point;
      if (e.type === "saturation") lines.push(`<span class="t-butter">Saturation</span> · ${esc(e.channels.join(", "))}`);
      else if (e.type === "yeux") lines.push(`${esc(e.label)} · ${esc(e.detail)}`);
      else lines.push(`<span class="t-dim">Note :</span> ${esc(e.label)}`);
      lines.push(`<span class="t-dim">${nf(e.time_s, 1)} s · ${clock(e.time_s, 1)}</span>`);
    } else {
      const g = j.group;
      lines.push(`<span class="t-blue">${esc(g.label)}</span> · ${clock(g.time_s)} → ${clock(g.end_s)}`);
      lines.push(`<span class="t-dim">étape :</span> ${esc(j.step.label)}`);
    }
  } else {
    const list = h.zone === "annot" ? annotList() : detList();
    const iv = inIv(list);
    if (!iv) { tip.hidden = true; return; }
    const cls = h.zone === "annot" ? "t-sage" : "t-coral";
    const name = h.zone === "annot" ? `Crise annotée A${iv.n}` : `Crise détectée D${iv.n}`;
    const full = h.zone === "det" ? detResult().intervals.find(d => d.n === iv.n) : iv;
    lines.push(`<span class="${cls}">${name}</span>`);
    lines.push(`${clock(full.start, 1)} → ${clock(full.end, 1)} · ${nf(full.end - full.start, 1)} s`);
    if (h.zone === "det" && detResult().annotated) lines.push(`<span class="t-dim">${full.hit ? "recouvre une crise annotée" : "fausse alarme"}</span>`);
  }
  tip.innerHTML = lines.join("<br>");
  tip.hidden = false;
  const vw = $("#viewer").clientWidth, vh = $("#viewer").clientHeight;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = h.x + 14, top = h.y + 16;
  if (left + tw > vw - 8) left = h.x - tw - 14;
  if (top + th > vh - 8) top = h.y - th - 12;
  tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${Math.max(4, top)}px`;
}

// ==========================================================================
// Vue d'ensemble (minimap) + bande de probabilité
// ==========================================================================
function miniLayout(h) {
  const det = detResult(), hasJ = journalList().length > 0;
  let y = 2;
  const L = {};
  if (det) { L.probaY = y; L.probaH = 24; y += 24 + 8; }
  if (hasJ) { L.jY = y; L.jH = 7; y += 7 + 5; }
  L.envY = y; L.envH = h - 20 - y;
  return L;
}
function drawMini() {
  const wrap = $("#overview");
  wrap.classList.toggle("has-proba", !!detResult());
  const cv = $("#mini-canvas");
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!S.meta || !S.overview) return;
  const x0 = GEOM.left, x1 = w - GEOM.right, pw = x1 - x0;
  const dur = S.meta.duration;
  const t2x = t => x0 + t / dur * pw;
  const L = miniLayout(h);
  const det = detResult(), cut = animCut();
  const A = annotList(), D = detList();

  const sideLabel = (txt, y) => {
    ctx.font = `500 9.5px ${C.sans}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(txt, x0 - 10, y);
  };

  // ---- probabilité de crise par fenêtre
  if (det) {
    const W = det.windows, y0 = L.probaY, H = L.probaH;
    sideLabel("P(CRISE)", y0 + H / 2);
    ctx.strokeStyle = C.rule; ctx.beginPath();
    ctx.moveTo(x0, crisp(y0 + H)); ctx.lineTo(x1, crisp(y0 + H)); ctx.stroke();
    ctx.setLineDash([2, 3]); ctx.beginPath();
    ctx.moveTo(x0, crisp(y0 + H / 2)); ctx.lineTo(x1, crisp(y0 + H / 2)); ctx.stroke(); ctx.setLineDash([]);
    for (let i = 0; i < W.proba.length; i++) {
      const c = (W.t_start[i] + W.t_end[i]) / 2;
      if (c > cut) break;
      const a = t2x(c - 0.5), b = t2x(c + 0.5), v = W.proba[i] * H;
      ctx.fillStyle = W.smoothed[i] && S.layers.det ? C["coral-edge"] : C["rule-strong"];
      ctx.fillRect(a, y0 + H - v, Math.max(0.6, b - a), v);
    }
  }

  // ---- journal
  if (L.jY != null) {
    sideLabel("JOURNAL", L.jY + L.jH / 2);
    for (const e of journalList()) {
      if (e.type === "hpn" || e.type === "sli") {
        const a = t2x(e.time_s), b = Math.max(a + 2, t2x(e.end_s));
        ctx.fillStyle = C.blue; ctx.fillRect(a, L.jY, b - a, L.jH);
        ctx.strokeStyle = C["blue-edge"]; ctx.strokeRect(crisp(a), crisp(L.jY), Math.round(b - a) - 1, L.jH - 1);
      }
    }
    for (const e of journalList()) {
      if (e.type !== "saturation") continue;
      const x = Math.round(t2x(e.time_s));
      ctx.fillStyle = C["butter-edge"]; ctx.fillRect(x - 1, L.jY - 1, 2, L.jH + 2);
    }
  }

  // ---- enveloppe RMS + crises
  const y0 = L.envY, H = L.envH;
  sideLabel("RMS", y0 + H / 2);
  paintBands(ctx, t2x, x0, x1, y0, H, A, D);
  ctx.fillStyle = C["sage-edge"];
  for (const iv of A) ctx.fillRect(t2x(iv.start), y0, Math.max(1.5, t2x(iv.end) - t2x(iv.start)), 2);
  ctx.fillStyle = C["coral-edge"];
  for (const iv of D) ctx.fillRect(t2x(iv.start), y0 + H - 3, Math.max(1.5, t2x(iv.end) - t2x(iv.start)), 3);
  const rms = S.overview.rms;
  const sorted = [...rms].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.995)] || 1;
  ctx.beginPath(); ctx.moveTo(x0, y0 + H);
  const n = rms.length, stepPx = Math.max(1, Math.floor(n / pw));
  for (let i = 0; i < n; i += stepPx) {
    let m = 0; for (let j = i; j < Math.min(n, i + stepPx); j++) m = Math.max(m, rms[j]);
    ctx.lineTo(t2x(i + 0.5), y0 + H - Math.min(1, m / top) * (H - 6));
  }
  ctx.lineTo(t2x(n), y0 + H); ctx.closePath();
  ctx.fillStyle = C.envelope; ctx.fill();
  ctx.strokeStyle = C["ink-2"]; ctx.lineWidth = 0.8; ctx.stroke(); ctx.lineWidth = 1;

  // ---- axe
  const ay = y0 + H;
  ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.moveTo(x0, crisp(ay)); ctx.lineTo(x1, crisp(ay)); ctx.stroke();
  const tick = dur > 2400 ? 600 : dur > 900 ? 300 : 60;
  ctx.font = `10.5px ${C.mono}`; ctx.fillStyle = C["ink-2"]; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.beginPath();
  for (let t = 0; t <= dur; t += tick / 5) {
    const x = crisp(t2x(t)), maj = t % tick === 0;
    ctx.moveTo(x, ay); ctx.lineTo(x, ay + (maj ? 5 : 2.5));
    if (maj && t > 0 && x < x1 - 20) ctx.fillText(clock(t), x, ay + 7);
  }
  ctx.strokeStyle = C["ink-3"]; ctx.stroke();
  ctx.textAlign = "left"; ctx.fillText(clock(0), x0, ay + 7);

  // ---- cadre lavande de la fenêtre affichée
  const fa = t2x(S.start), fb = Math.max(fa + 4, t2x(S.start + S.win));
  const top0 = det ? L.probaY : L.jY != null ? L.jY : y0;
  ctx.fillStyle = C["window-fill"]; ctx.fillRect(fa, top0, fb - fa, ay - top0);
  ctx.strokeStyle = C["lav-edge"]; ctx.lineWidth = 1.5;
  ctx.strokeRect(Math.round(fa) + 0.75, top0 + 0.75, Math.round(fb - fa) - 1.5, ay - top0 - 1.5);
  ctx.lineWidth = 1;

  cv.setAttribute("aria-valuemax", String(Math.round(dur)));
  cv.setAttribute("aria-valuenow", String(Math.round(S.start)));
  cv.setAttribute("aria-valuetext", `${clock(S.start)} sur ${clock(dur)}`);
}

function miniTip(x, y) {
  const tip = $("#mini-tip"), cv = $("#mini-canvas");
  if (!S.meta || x == null) { tip.hidden = true; return; }
  const pw = cv.clientWidth - GEOM.left - GEOM.right;
  const t = (x - GEOM.left) / pw * S.meta.duration;
  if (t < 0 || t > S.meta.duration) { tip.hidden = true; return; }
  const lines = [`<b>${clock(t)}</b>`];
  const a = annotList().find(iv => t >= iv.start && t <= iv.end);
  const d = detList().find(iv => t >= iv.start && t <= iv.end);
  if (a) lines.push(`<span class="t-sage">crise annotée A${a.n}</span>`);
  if (d) lines.push(`<span class="t-coral">crise détectée D${d.n}</span>`);
  const g = journalList().find(e => (e.type === "hpn" || e.type === "sli") && t >= e.time_s && t <= e.end_s);
  if (g) lines.push(`<span class="t-blue">${esc(g.label)}</span>`);
  tip.innerHTML = lines.join("<br>");
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(cv.clientWidth - tw - 4, x + 12)}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
}

// ==========================================================================
// Interactions : glisser, clavier, minimap
// ==========================================================================
function bindViewer() {
  const cv = $("#eeg-canvas");
  let drag = null;
  cv.addEventListener("pointerdown", e => {
    if (!S.meta) return;
    drag = { x: e.clientX, start: S.start };
    cv.setPointerCapture(e.pointerId); cv.classList.add("dragging"); cv.focus({ preventScroll: true });
  });
  cv.addEventListener("pointermove", e => {
    const r = cv.getBoundingClientRect();
    S.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (drag) {
      const pw = cv.clientWidth - GEOM.left - GEOM.right;
      moveTo(drag.start - (e.clientX - drag.x) / pw * S.win);
    } else { drawViewer(); updateTip(); }
  });
  const end = () => { drag = null; cv.classList.remove("dragging"); writeHash(); };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("pointerleave", () => { S.hover = null; drawViewer(); updateTip(); });
  cv.addEventListener("wheel", e => {
    if (!S.meta || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // seulement le défilement horizontal
    e.preventDefault();
    moveTo(S.start + e.deltaX / cv.clientWidth * S.win);
  }, { passive: false });

  const mini = $("#mini-canvas");
  let mdrag = null;
  const tAt = x => (x - GEOM.left) / (mini.clientWidth - GEOM.left - GEOM.right) * S.meta.duration;
  mini.addEventListener("pointerdown", e => {
    if (!S.meta) return;
    const t = tAt(e.clientX - mini.getBoundingClientRect().left);
    const inside = t >= S.start && t <= S.start + S.win;
    mdrag = { off: inside ? t - S.start : S.win / 2 };
    mini.setPointerCapture(e.pointerId);
    moveTo(t - mdrag.off);
  });
  mini.addEventListener("pointermove", e => {
    const r = mini.getBoundingClientRect(), x = e.clientX - r.left;
    if (mdrag) { moveTo(tAt(x) - mdrag.off); $("#mini-tip").hidden = true; }
    else miniTip(x, e.clientY - r.top);
  });
  const mend = () => { mdrag = null; writeHash(); };
  mini.addEventListener("pointerup", mend);
  mini.addEventListener("pointercancel", mend);
  mini.addEventListener("pointerleave", () => miniTip(null));

  document.addEventListener("keydown", e => {
    if (ROUTE.page !== "lecture" || !S.meta || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement, tag = (el && el.tagName) || "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (el && el.closest(".rec-list, .tabs, .pop")) return;
    const onSignal = !el || el === document.body || el.id === "eeg-canvas" || el.id === "mini-canvas";
    const big = e.shiftKey ? S.win : S.win / 2;
    const k = e.key;
    if (k === "ArrowRight") { e.preventDefault(); moveTo(S.start + big); writeHash(); }
    else if (k === "ArrowLeft") { e.preventDefault(); moveTo(S.start - big); writeHash(); }
    else if (k === "Home") { e.preventDefault(); moveTo(0); writeHash(); }
    else if (k === "End") { e.preventDefault(); moveTo(S.meta.duration); writeHash(); }
    else if (k === "+" || k === "=") { e.preventDefault(); zoomWin(-1); }
    else if (k === "-" || k === "_") { e.preventDefault(); zoomWin(1); }
    else if (k === "ArrowUp" && onSignal) { e.preventDefault(); stepSens(-1); }
    else if (k === "ArrowDown" && onSignal) { e.preventDefault(); stepSens(1); }
    else if ((k === "a" || k === "A") && !$("#layer-annot").disabled) toggleLayer("annot");
    else if ((k === "d" || k === "D") && !$("#layer-det").disabled) toggleLayer("det");
    else if ((k === "j" || k === "J") && !$("#layer-journal").disabled) toggleLayer("journal");
  });
}

function bindPopover(btnSel, popSel, onOpen) {
  const pop = $(popSel), btn = $(btnSel);
  const close = (refocus) => { if (pop.hidden) return; pop.hidden = true; btn.setAttribute("aria-expanded", "false"); if (refocus) btn.focus(); };
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = pop.hidden;
    $$(".pop").forEach(p => { if (p !== pop) p.hidden = true; });
    $$("[aria-controls]").forEach(b => b !== btn && b.setAttribute("aria-expanded", "false"));
    pop.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open && onOpen) onOpen(pop);
  });
  document.addEventListener("click", e => { if (!pop.hidden && !pop.contains(e.target)) close(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !pop.hidden) close(true); });
}

function bindToolbar() {
  $$("#win-seg button").forEach(b => b.addEventListener("click", () => setWin(+b.dataset.win)));
  $("#sens-up").addEventListener("click", () => stepSens(-1));
  $("#sens-down").addEventListener("click", () => stepSens(1));
  bindPopover("#ch-btn", "#ch-pop", pop => { const f = pop.querySelector("input"); if (f) f.focus(); });
  bindPopover("#keys-btn", "#keys-pop");
  $("#ch-all").addEventListener("click", () => { S.hidden.clear(); renderChannels(); channelsChanged(); });
  $("#ch-none").addEventListener("click", () => { S.meta.channels.forEach(c => S.hidden.add(c)); renderChannels(); channelsChanged(); });
  $("#layer-annot").addEventListener("click", () => toggleLayer("annot"));
  $("#layer-det").addEventListener("click", () => toggleLayer("det"));
  $("#layer-journal").addEventListener("click", () => toggleLayer("journal"));
}

// ==========================================================================
// Vues (onglets)
// ==========================================================================
function setView(v, push = true) {
  S.view = v;
  $$(".tabs button").forEach(b => {
    const on = b.dataset.view === v;
    b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
  });
  $("#view-rec").classList.toggle("is-analyse", v === "analyse");
  $("#analysis").hidden = v !== "analyse";
  updateAnalyseBtn();
  if (v === "analyse") renderAnalysis();
  requestAnimationFrame(() => { drawViewer(); drawMini(); if (S.meta) { S.buf = S.buf && S.buf.win === S.win ? S.buf : null; requestData(true); } });
  if (push) writeHash();
}
function bindTabs() {
  const tabs = $$(".tabs button");
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => setView(b.dataset.view));
    b.addEventListener("keydown", e => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); setView(n.dataset.view);
    });
  });
}

// ==========================================================================
// Analyse
// ==========================================================================
const STEPS = ["Chargement", "Filtrage", "Fenêtrage", "Caractéristiques", "Classification", "Reconstruction"];

function renderSteps(cur, state = "running") {
  $("#steps").innerHTML = STEPS.map((s, i) => {
    const cls = state === "done" || i < cur ? "done" : i === cur ? (state === "error" ? "failed" : state === "idle" ? "" : "current") : "";
    return `<li class="${cls}">${s}</li>`;
  }).join("");
  const p = state === "done" ? 100 : state === "idle" ? 0 : ((cur + (state === "error" ? 0 : 0.5)) / STEPS.length) * 100;
  $("#progress-bar").style.width = `${p}%`;
  $(".progress").classList.toggle("is-error", state === "error");
}

function updateAnalyseBtn(stepName) {
  const b = $("#analyse-btn");
  const running = S.job && S.job.rid === S.rid;
  const done = !!S.det[S.rid];
  b.disabled = !!running || !S.meta;
  $$("#awin-seg button").forEach(x => { x.disabled = !!running; });
  b.classList.toggle("is-busy", !!running);
  b.textContent = running ? (stepName ? `Analyse · ${stepName}…` : "Analyse en cours…")
    : done ? "Voir l’analyse"
    : S.jobErr[S.rid] ? "Relancer l’analyse"
    : S.view === "analyse" ? "Lancer l’analyse" : "Analyser l’enregistrement";
  // dans l'écran Analyse, le bouton n'a plus d'utilité une fois le résultat affiché
  b.hidden = S.view === "analyse" && done;
}

/* ---- Taille des fenêtres d'analyse (2 s par défaut ; 5 s, 10 s… si le notebook a produit leur jeu d'entraînement) ---- */
async function initAwin() {
  if (S.awins.length) return;
  let A;
  try { A = await api("/api/analysis-windows"); } catch (_) { A = null; }
  S.awinDefault = A ? A.default : 2;
  S.awins = A ? A.windows : [S.awinDefault];
  S.awin = S.awinDefault;
  S.detByWin[S.awin] = S.det;
  const tool = $("#awin-tool"), seg = $("#awin-seg");
  tool.hidden = S.awins.length < 2;
  seg.innerHTML = S.awins.map(w => `<button type="button" data-awin="${w}" aria-pressed="${w === S.awin}">${nf(w)} s</button>`).join("");
  $$("button", seg).forEach(b => b.addEventListener("click", () => setAwin(+b.dataset.awin)));
}

function setAwin(w, run = true) {
  if (!S.awins.includes(w) || w === S.awin || S.job) return;
  S.awin = w;
  S.det = S.detByWin[w] = S.detByWin[w] || {};
  S.jobErr = {};
  $$("#awin-seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.awin === w)));
  updateAnalyseBtn(); updateLayers();
  if (S.view === "analyse") renderAnalysis();
  drawViewer(); drawMini(); writeHash();
  // changer de taille relance l'analyse de l'enregistrement affiché avec cette taille
  if (run && S.meta && !S.det[S.rid]) startAnalysis();
}

async function startAnalysis() {
  if (!S.meta) return;
  if (S.view !== "analyse") setView("analyse");
  if (S.det[S.rid]) { renderAnalysis(); return; }
  if (S.job) return;
  const rid = S.rid;
  delete S.jobErr[rid];
  try {
    const q = S.awin != null && S.awin !== S.awinDefault ? `?win=${S.awin}` : "";
    const { job } = await api(`/api/recordings/${encodeURIComponent(rid)}/detect${q}`, { method: "POST" });
    S.job = { id: job, rid };
    updateAnalyseBtn(); renderAnalysis();
    poll();
  } catch (e) {
    S.jobErr[rid] = { step: 0, message: e.message };
    renderAnalysis();
  }
}

async function poll() {
  if (!S.job) return;
  const { id, rid } = S.job;
  let st;
  try { st = await api(`/api/jobs/${id}`); }
  catch (e) { st = { status: "error", error: e.message, step: 0 }; }
  if (st.status === "running") {
    if (rid === S.rid) {
      updateAnalyseBtn(st.step_name);
      if (S.view === "analyse") { renderSteps(st.step); $("#step-detail").textContent = st.detail || ""; }
    }
    setTimeout(poll, 250);
    return;
  }
  S.job = null;
  if (st.status === "done") {
    const w = st.result.params.win_s;
    (S.detByWin[w] = S.detByWin[w] || {})[rid] = st.result;
    if (rid === S.rid && w === S.awin && !reducedMotion()) {
      S.anim = { rid, t0: performance.now() };
      requestAnimationFrame(tickAnim);
    }
  } else {
    S.jobErr[rid] = { step: st.step || 0, message: st.error || "erreur inconnue" };
  }
  updateAnalyseBtn(); updateLayers();
  if (rid === S.rid) { renderAnalysis(true); drawViewer(); drawMini(); }
}

function renderAnalysis(reveal = false) {
  const det = S.det[S.rid];
  const running = S.job && S.job.rid === S.rid;
  const err = S.jobErr[S.rid];
  const res = $("#results"), empty = $("#analysis-empty");
  $("#step-detail").classList.remove("err");
  updateAnalyseBtn();
  if (!S.meta) { res.hidden = true; empty.hidden = true; return; }

  if (!det) {
    res.hidden = true;
    if (running) {
      empty.hidden = true;
      renderSteps(0);
      $("#step-detail").textContent = "Envoi de la demande au serveur…";
    } else if (err) {
      renderSteps(err.step, "error");
      $("#step-detail").textContent = `Échec à l’étape « ${STEPS[Math.min(err.step, STEPS.length - 1)]} » : ${err.message}`;
      $("#step-detail").classList.add("err");
      empty.hidden = false;
      $("#empty-title").textContent = "L’analyse n’a pas abouti";
      $("#empty-text").textContent = "Le tracé reste consultable. Relancez l’analyse avec le bouton en haut à droite ; si l’erreur se reproduit, le message complet est affiché dans le terminal où tourne le serveur.";
    } else {
      renderSteps(0, "idle");
      $("#step-detail").textContent = "";
      empty.hidden = false;
      const nWin = Math.max(0, Math.floor((S.meta.duration - 2) / 1) + 1);
      const how = S.meta.source === "upload"
        ? "avec le modèle complet enregistré dans <span class=\"mono\">best_model.joblib</span>"
        : S.meta.in_training_set
          ? "avec le modèle retenu, ré-entraîné sans ce tracé pour qu’il ne l’ait jamais vu"
          : "avec le modèle complet (ce tracé n’a pas servi à l’entraînement)";
      $("#empty-title").textContent = `Pas encore d’analyse pour ${displayName(S.meta)}`;
      $("#empty-text").innerHTML = `La chaîne du notebook découpe le tracé en <span class="mono">${nf(nWin)}</span> fenêtres de 2 s, calcule 17 caractéristiques par fenêtre et les classe ${how}. ` +
        `Comptez de 10 à 40 s la première fois ; les analyses suivantes sont quasi instantanées. Bouton « Lancer l’analyse » en haut à droite.`;
    }
    drawMini();
    return;
  }

  empty.hidden = true;
  renderSteps(STEPS.length, "done");
  $("#step-detail").textContent = `Terminé en ${nf(det.elapsed_s, 1)} s · ${nf(det.windows.t_start.length)} fenêtres classées`;

  // --- résumé typographique
  const n = det.intervals.length;
  if (det.annotated) {
    const T = det.totals;
    $("#headline").innerHTML = `<span class="big">${T.detected}</span> crise${T.detected > 1 ? "s" : ""} sur ${T.n_true} détectée${T.detected > 1 ? "s" : ""}`;
    const bits = [`<span class="mono">${T.false_alarms}</span> fausse${T.false_alarms > 1 ? "s" : ""} alarme${T.false_alarms > 1 ? "s" : ""} (${nf(T.fa_per_hour, 1)} par heure)`];
    if (T.missed) bits.push(`<span class="mono">${T.missed}</span> manquée${T.missed > 1 ? "s" : ""}`);
    if (T.mean_start_delay != null) bits.push(`retard moyen au début <span class="mono">${signed(T.mean_start_delay)} s</span>`);
    if (T.mean_end_gap != null) bits.push(`écart moyen en fin <span class="mono">${signed(T.mean_end_gap)} s</span>`);
    $("#subline").innerHTML = bits.map(b => `<span class="bit">${b}</span>`).join(" ");
  } else {
    $("#headline").innerHTML = n
      ? `<span class="big">${n}</span> crise${n > 1 ? "s" : ""} détectée${n > 1 ? "s" : ""}`
      : `Aucune crise détectée`;
    $("#subline").textContent = "Enregistrement non annoté : aucune comparaison avec une vérité terrain n’est possible.";
  }
  renderContext(det);

  const M = det.model, P = det.params;
  const how = M.excluded
    ? `${M.name} ré-entraîné sur ${M.trained_on} enregistrements annotés (${nf(M.n_windows)} fenêtres), sans ${M.excluded} : le modèle n’a jamais vu ce tracé.`
    : `${M.name} complet (${M.source}), entraîné sur les ${M.trained_on} enregistrements annotés (${nf(M.n_windows)} fenêtres)${S.meta.source === "upload" ? "" : " ; cet enregistrement n’a pas servi à l’entraînement"}.`;
  const chNote = det.n_channels !== det.train_channels
    ? ` Attention : ce tracé ne compte que ${det.n_channels} voies EEG, contre ${det.train_channels} pour les enregistrements d’entraînement ; les caractéristiques (moyennées sur les voies) ne sont pas strictement comparables.`
    : "";
  $("#provenance").textContent = `${how}${chNote} Fenêtres de ${nf(P.win_s)} s, recouvrement ${nf(P.overlap * 100)} %, lissage médian sur ${P.smooth} fenêtres, fusion des détections séparées de ${nf(P.merge_gap_s)} s ou moins, durée minimale ${nf(P.min_event_s)} s.`;
  $("#provenance").classList.toggle("warn", !!chNote);

  // --- tableau des crises détectées
  const tb = $("#det-table tbody");
  tb.innerHTML = "";
  if (!n) tb.innerHTML = `<tr><td colspan="5" class="empty-row">Aucun intervalle n’a dépassé ${nf(P.min_event_s)} s après lissage.</td></tr>`;
  for (const iv of det.intervals) {
    const tr = document.createElement("tr");
    tr.className = "clickable"; tr.tabIndex = 0;
    const st = !det.annotated ? '<span class="status-none">—</span>'
      : iv.hit ? '<span class="status-hit">recouvre une crise annotée</span>' : '<span class="status-fa">fausse alarme</span>';
    tr.innerHTML = `<td class="num"><span class="mark-det"></span>D${iv.n}</td><td class="num">${clock(iv.start, 1)}</td>` +
      `<td class="num">${clock(iv.end, 1)}</td><td class="num">${nf(iv.duration, 1)} s</td><td>${st}</td>`;
    const go = () => jumpTo(iv);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    tb.appendChild(tr);
  }

  // --- confrontation
  $("#match-block").hidden = !det.annotated;
  if (det.annotated) {
    const mb = $("#match-table tbody");
    mb.innerHTML = "";
    const c = (v, f) => (v == null ? '<td class="num dim">—</td>' : `<td class="num">${f(v)}</td>`);
    for (const r of det.match) {
      const tr = document.createElement("tr");
      const res = r["Résultat"];
      const cls = res === "Détectée" ? "status-hit" : res === "Manquée" ? "status-miss" : "status-fa";
      tr.innerHTML = c(r["Crise réelle"], v => `A${v}`) + c(r["Début réel"], v => clock(v, 1)) + c(r["Fin réelle"], v => clock(v, 1)) +
        c(r["Début détecté"], v => clock(v, 1)) + c(r["Fin détectée"], v => clock(v, 1)) +
        c(r["Retard début (s)"], v => signed(v) + " s") + c(r["Écart fin (s)"], v => signed(v) + " s") +
        `<td class="${cls}">${res.toLowerCase()}</td>`;
      const s = r["Début réel"] != null ? r["Début réel"] : r["Début détecté"];
      const e = r["Fin réelle"] != null ? r["Fin réelle"] : r["Fin détectée"];
      tr.className = "clickable"; tr.tabIndex = 0;
      tr.addEventListener("click", () => jumpTo({ start: s, end: e }));
      tr.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jumpTo({ start: s, end: e }); } });
      mb.appendChild(tr);
    }
  }
  res.hidden = false;
  if (reveal) { res.classList.remove("reveal"); void res.offsetWidth; res.classList.add("reveal"); }
  drawMini(); drawViewer();
}

/* Faits tirés du journal d'examen, calculés côté serveur (exam_journal.context_lines). */
function renderContext(det) {
  const box = $("#context"), ul = $("#context-list");
  const items = [];
  const X = det.context;
  if (!X) {
    items.push(["c-none", S.meta.source === "upload"
      ? "Fichier importé : pas de journal d’examen, donc pas de contexte (hyperpnée, SLI, saturations)."
      : "Pas de journal d’examen (_0000h.mat) pour ce tracé."]);
  } else {
    const what = (k, of) => of === "crises annotées" ? (k > 1 ? "crises annotées" : "crise annotée") : (k > 1 ? "détections" : "détection");
    const nameOf = e => e.type === "hpn" ? "l’hyperpnée" : "la SLI";
    const shown = X.epreuves.filter(e => e.count > 0);
    for (const e of shown) {
      items.push(["c-blue", `<span class="mono">${e.count}</span> ${what(e.count, e.of)} sur <span class="mono">${e.total}</span> pendant ${nameOf(e)} ` +
        `<span class="dim">(${esc(e.label)}, <span class="mono">${clock(e.start)}–${clock(e.end)}</span>)</span>`]);
    }
    if (X.epreuves.length && !shown.length) {
      const names = [...new Set(X.epreuves.map(nameOf))].join(" ni ");
      items.push(["c-none", `Aucune ${X.epreuves[0].of === "crises annotées" ? "crise annotée" : "détection"} pendant ${names}.`]);
    }
    if (!X.epreuves.length) items.push(["c-none", "Ni hyperpnée ni SLI consignées dans le journal de cet examen."]);
    const sat = X.saturation;
    if (sat && sat.count > 0) {
      items.push(["c-butter", `<span class="mono">${sat.count}</span> détection${sat.count > 1 ? "s" : ""} sur <span class="mono">${sat.total}</span> à moins de ${nf(sat.tolerance_s)} s d’une saturation ` +
        `<span class="dim">(${esc(sat.channels.join(", "))})</span>`]);
    }
  }
  ul.innerHTML = items.map(([cls, html]) => `<li class="${cls}"><span>${html}</span></li>`).join("");
  box.hidden = !items.length;
}

function jumpTo(iv) {
  const len = iv.end - iv.start;
  moveTo(len + 2 > S.win ? iv.start - 1 : (iv.start + iv.end) / 2 - S.win / 2);
  writeHash();
  $("#viewer").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
}

function exportCSV() {
  const det = S.det[S.rid];
  if (!det) return;
  const lines = ["n,debut_s,fin_s,duree_s" + (det.annotated ? ",statut" : "")];
  for (const iv of det.intervals) {
    lines.push([iv.n, iv.start, iv.end, iv.duration].join(",") + (det.annotated ? "," + (iv.hit ? "crise_annotee" : "fausse_alarme") : ""));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${S.rid}_crises_detectees.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ==========================================================================
// Import d'un fichier externe
// ==========================================================================
function bindUpload() {
  const input = $("#file-input"), st = $("#upload-status");
  $("#upload-label").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", async () => {
    const f = input.files[0];
    if (!f) return;
    st.classList.remove("err");
    st.textContent = `Envoi et vérification de ${f.name}…`;
    const fd = new FormData(); fd.append("file", f);
    try {
      const meta = await api("/api/upload", { method: "POST", body: fd });
      S.recs = await api("/api/recordings");
      st.textContent = `Importé : ${displayName(meta)} (${humanDur(meta.duration)}, ${meta.n_eeg} voies EEG).`;
      go(lectureHref(meta.id));
    } catch (e) {
      st.classList.add("err"); st.textContent = `Import refusé : ${e.message}`;
    }
    input.value = "";
  });
}


// ==========================================================================
// Adresse : #/lecture/<id>?t=…&win=…&vue=analyse
// ==========================================================================
const lectureHref = (rid, t) => `#/lecture/${encodeURIComponent(rid)}${t != null ? `?t=${Math.round(t * 10) / 10}` : ""}`;

/* Position courante dans l'adresse, sans créer d'entrée d'historique (le bouton Retour
   ramène à la page ou à l'enregistrement précédent, pas à chaque déplacement du tracé). */
function writeHash() {
  if (!S.rid || ROUTE.page !== "lecture") return;
  const q = new URLSearchParams({ t: Math.round(S.start * 10) / 10 });
  if (S.win !== 20) q.set("win", S.win);
  if (S.view === "analyse") q.set("vue", "analyse");
  if (S.awin != null && S.awin !== S.awinDefault) q.set("fen", S.awin);
  if (Voies.query()) q.set("voies", Voies.query());
  replaceHash(`#/lecture/${encodeURIComponent(S.rid)}?${q}`);
}

const Lecture = {
  ready: null,
  init() {
    if (this.ready) return this.ready;
    bindViewer(); bindToolbar(); bindTabs(); bindUpload();
    $("#analyse-btn").addEventListener("click", startAnalysis);
    $("#export-btn").addEventListener("click", exportCSV);
    onResize($("#viewer"), () => { drawViewer(); drawMini(); });
    onResize($("#overview"), drawMini);
    if (document.fonts) document.fonts.ready.then(() => { drawViewer(); drawMini(); });
    renderSens();
    this.ready = (async () => {
      try { S.recs = await api("/api/recordings"); }
      catch (e) {
        $("#rec-list").innerHTML = '<li class="rec-empty">Liste indisponible.</li>';
        setMsg("Serveur injoignable", serverHint, true);
        throw e;
      }
      renderIndex();
    })();
    return this.ready;
  },
  async enter(params) {
    try { await this.init(); } catch (_) { return; }
    const rid = params.id ? decodeURIComponent(params.id) : (S.rid || (S.recs.find(r => r.id === "230102B-F") || S.recs[0] || {}).id);
    if (!rid || !S.recs.find(r => r.id === rid)) {
      S.rid = null; S.meta = null; renderIndex(); drawViewer(); drawMini();
      $("#rec-title").textContent = "—"; $("#rec-meta").textContent = ""; $("#rec-pn").innerHTML = "";
      document.title = "Lecture · Absences";
      setMsg("Enregistrement introuvable", `Aucun tracé ne s’appelle « ${rid || ""} ». Choisissez-en un dans la liste de gauche.`, true);
      return;
    }
    const win = params.q.get("win") ? +params.q.get("win") : null;
    const t = params.q.get("t") != null && params.q.get("t") !== "" ? +params.q.get("t") : null;
    const vue = params.q.get("vue") === "analyse" ? "analyse" : "lecture";
    const voiesAvant = Voies.query();
    Voies.parse(params.q);
    if (Voies.query() !== voiesAvant) S.buf = null;      // autre configuration : on recharge le signal
    await initAwin();
    const fen = params.q.get("fen") ? +params.q.get("fen") : null;
    if (fen && fen !== S.awin) setAwin(fen, false);
    if (win && WINDOWS.includes(win) && win !== S.win) {
      S.win = win; S.buf = null;
      $$("#win-seg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.win === S.win)));
    }
    setView(vue, false);
    if (rid !== S.rid) await selectRec(rid, { t });
    else {
      if (t != null && Math.abs(t - S.start) > 0.05) moveTo(t);
      requestAnimationFrame(() => { drawViewer(); drawMini(); });
    }
    if (vue === "analyse" && !S.det[rid] && !S.job) startAnalysis();
    writeHash();
  },
};
