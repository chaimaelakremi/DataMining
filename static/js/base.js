/* ==========================================================================
   Absences — outils partagés par toutes les pages
   (JS natif, aucun framework ; les tracés sont dessinés à la main sur <canvas>)
   ========================================================================== */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------- couleurs (lues dans le CSS)
const C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["paper", "paper-2", "ink", "ink-2", "ink-3", "rule", "rule-strong",
                   "sage", "sage-edge", "sage-ink", "coral", "coral-edge", "coral-ink",
                   "lav", "lav-edge", "lav-ink", "lav-wash", "blue", "blue-edge", "blue-ink",
                   "butter", "butter-edge", "butter-ink",
                   "grid-minor", "grid-major", "envelope", "window-fill", "hover-lane", "mono", "sans", "serif",
                   "surface", "hatch", "ctrl"]) {
    C[k] = cs.getPropertyValue("--" + k).trim();
  }
  // les dessins ont besoin d'un blanc plein (les cartes, elles, peuvent être translucides)
  C.surface = cs.getPropertyValue("--surface-canvas").trim() || C.surface;
}

// ---------------------------------------------------------------- formats (français)
const nf = (v, d = 0) => Number(v).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => `${nf(100 * v, d)} %`;
const signed = (v, d = 1) => (v > 0 ? "+" : v < 0 ? "−" : "") + nf(Math.abs(v), d);
function clock(t, dec = 0) {
  const neg = t < 0; t = Math.abs(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  let ss = dec ? s.toFixed(dec).replace(".", ",") : String(Math.floor(s));
  if (parseFloat(ss.replace(",", ".")) < 10) ss = "0" + ss;
  const mm = String(m).padStart(2, "0");
  return (neg ? "−" : "") + (h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`);
}
function humanDur(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.round(t % 60);
  if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
  return s ? `${m} min ${String(s).padStart(2, "0")} s` : `${m} min`;
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const label = ch => ch.replace(/^EEG/, "");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
/* chiffre dans une phrase : police du texte, un peu plus grasse (la chasse fixe est réservée aux tableaux) */
const mono = v => `<span class="n">${v}</span>`;
const median = a => { const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); }
  catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error("le serveur ne répond pas");
  }
  if (!r.ok) {
    let msg = `erreur ${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch (_) { /* corps non JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

/* Interroge un endpoint calculé en arrière-plan (cohorte, GroupKFold) jusqu'à ce qu'il soit prêt.
   onProgress(état) est appelé à chaque attente ; renvoie la réponse finale. */
async function waitDone(path, onProgress, isActive = () => true) {
  for (;;) {
    const d = await api(path);
    if (d.status === "done" || d.status === undefined) return d;
    if (d.status === "error") throw new Error(d.error || "le calcul a échoué");
    if (onProgress) onProgress(d);
    await new Promise(r => setTimeout(r, 1500));
    if (!isActive()) throw Object.assign(new Error("abandon"), { name: "AbortError" });
  }
}
function progressText(d, what = "la détection sur l’ensemble des enregistrements") {
  if (!d) return "";
  if (d.n_splits) return `Calcul en cours : validation par enregistrement, pli ${d.fold} sur ${d.n_splits}…`;
  if (d.total) return `Calcul en cours : ${what}, ${d.done} sur ${d.total}${d.current ? ` (${d.current})` : ""}…`;
  return "Calcul en cours…";
}

/* États de chargement / vide / erreur dans un conteneur */
function stateLine(el, kind, title, hint = "") {
  el.innerHTML = `<div class="state state-${kind}">${kind === "loading" ? '<span class="state-line" aria-hidden="true"></span>' : ""}` +
    `<p class="state-title">${esc(title)}</p>${hint ? `<p class="state-hint">${esc(hint)}</p>` : ""}</div>`;
}
const serverHint = "Vérifiez que le serveur tourne toujours dans le terminal (uvicorn app:app --port 8000), puis rechargez la page.";

// ---------------------------------------------------------------- canvas
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
const crisp = v => Math.round(v) + 0.5;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/* Hachures fines et peu contrastées des crises détectées : elles distinguent le calque
   sans la couleur, et restent derrière le tracé. */
function hatchRect(ctx, x, y, w, h) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = C.hatch; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = Math.floor((x - h) / 7) * 7; i < x + w; i += 7) { ctx.moveTo(i, y + h); ctx.lineTo(i + h, y); }
  ctx.stroke();
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* Amplitude typique (écart-type robuste) d'un extrait, toutes voies confondues. */
function robustUv(ex, chans) {
  const vals = [];
  for (const c of chans || ex.channels) {
    const d = ex.data[c];
    if (!d) continue;
    if (Array.isArray(d)) for (let i = 0; i < d.length; i += 2) vals.push(d[i]);
    else for (let i = 0; i < d.min.length; i++) vals.push((d.min[i] + d.max[i]) / 2);
  }
  if (!vals.length) return 10;
  const m = median(vals);
  return Math.max(1, 1.4826 * median(vals.map(v => Math.abs(v - m))));
}

/*
  Extrait EEG statique (pages Accueil, Comprendre, Méthode, Erreurs).
  ex : réponse de /signal (ou extrait embarqué) ; opts :
    channels, uvPerPx (échelle commune), bands [{start,end,fill,edge}], grid, axis, labels,
    scaleBar, laneScale (fraction du couloir occupée par ±3σ), padLeft, clipLanes
  Renvoie la géométrie { t2x, laneY, v2y, x0, x1, y0, y1, lane } pour dessiner des annotations par-dessus.
*/
function drawExcerpt(cv, ex, opts = {}) {
  const { ctx, w, h } = fitCanvas(cv);
  const chans = opts.channels || ex.channels;
  const labels = opts.labels !== false;
  const x0 = opts.padLeft != null ? opts.padLeft : labels ? 44 : 4;
  const x1 = w - (opts.padRight != null ? opts.padRight : opts.scaleBar ? 46 : 6);
  const y0 = opts.padTop != null ? opts.padTop : 8;
  const y1 = h - (opts.axis === false ? 6 : 22);
  const start = opts.start != null ? opts.start : ex.start, end = opts.end != null ? opts.end : ex.end;
  const t2x = t => x0 + (t - start) / (end - start) * (x1 - x0);
  const lane = (y1 - y0) / Math.max(1, chans.length);
  const uvPerPx = opts.uvPerPx || (3 * robustUv(ex, chans)) / ((opts.laneScale || 0.42) * lane);
  const laneY = i => y0 + lane * (i + 0.5);
  const v2y = (i, v) => laneY(i) - v / uvPerPx;

  ctx.clearRect(0, 0, w, h);          // fond transparent : la figure repose sur sa carte
  for (const b of opts.bands || []) {
    const a = Math.max(x0, t2x(b.start)), bb = Math.min(x1, t2x(b.end));
    if (bb <= a) continue;
    ctx.fillStyle = b.fill; ctx.fillRect(a, b.top != null ? b.top : y0, bb - a, b.height != null ? b.height : y1 - y0);
    if (b.hatch) {
      hatchRect(ctx, a, y0, bb - a, y1 - y0);
      ctx.fillStyle = b.edge; ctx.fillRect(Math.round(a), y0, 1, y1 - y0); ctx.fillRect(Math.round(bb) - 1, y0, 1, y1 - y0);
    } else if (b.edge) { ctx.fillStyle = b.edge; ctx.fillRect(a, b.top != null ? b.top : y0, bb - a, 2); }
  }
  if (opts.highlight) {
    const k = chans.indexOf(opts.highlight);
    if (k >= 0) { ctx.fillStyle = C["hover-lane"]; ctx.fillRect(x0, y0 + lane * k, x1 - x0, lane); }
  }
  if (opts.grid !== false) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = C["grid-minor"]; ctx.beginPath();
    const pxs = (x1 - x0) / (end - start);
    if (pxs * 0.2 >= 6) for (let t = Math.ceil(start / 0.2) * 0.2; t <= end; t += 0.2) {
      if (Math.abs(t - Math.round(t)) < 1e-6) continue;
      const x = crisp(t2x(t)); ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
    for (let y = y0 + 5; y < y1; y += 5) { ctx.moveTo(x0, crisp(y)); ctx.lineTo(x1, crisp(y)); }
    ctx.stroke();
    ctx.strokeStyle = C["grid-major"]; ctx.beginPath();
    for (let t = Math.ceil(start); t <= end + 1e-9; t += 1) { const x = crisp(t2x(t)); ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
  }
  // traces
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4); ctx.clip();
  ctx.strokeStyle = opts.ink || C.ink; ctx.lineWidth = opts.lineWidth || 1; ctx.lineJoin = "round";
  chans.forEach((c, k) => {
    const d = ex.data[c];
    if (!d) return;
    const lim = lane * (opts.clipLanes || 1.25);
    const Y = v => laneY(k) - Math.max(-lim, Math.min(lim, v / uvPerPx));
    ctx.beginPath();
    if (ex.mode === "raw") {
      for (let i = 0; i < d.length; i++) {
        const x = t2x(ex.t0 + i * ex.dt);
        i ? ctx.lineTo(x, Y(d[i])) : ctx.moveTo(x, Y(d[i]));
      }
    } else {
      for (let i = 0; i < d.min.length; i++) {
        const x = t2x(ex.t0 + (i + 0.5) * ex.dt);
        i ? ctx.lineTo(x, Y(d.max[i])) : ctx.moveTo(x, Y(d.max[i]));
        ctx.lineTo(x, Y(d.min[i]));
      }
    }
    ctx.stroke();
  });
  ctx.restore();
  if (labels) {
    ctx.font = `10.5px ${C.mono}`; ctx.fillStyle = C["ink-2"]; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    chans.forEach((c, k) => {
      ctx.fillStyle = c === opts.highlight ? C.ink : C["ink-2"];
      ctx.fillText(opts.labelOf ? opts.labelOf(c) : label(c), x0 - 8, laneY(k));
    });
  }
  if (opts.axis !== false) {
    ctx.strokeStyle = C["rule-strong"]; ctx.beginPath(); ctx.moveTo(x0, crisp(y1)); ctx.lineTo(x1, crisp(y1)); ctx.stroke();
    ctx.font = `10px ${C.mono}`; ctx.fillStyle = C["ink-3"]; ctx.textAlign = "center"; ctx.textBaseline = "top";
    const span = end - start, step = span <= 12 ? 1 : span <= 30 ? 2 : span <= 90 ? 10 : 60;
    for (let t = Math.ceil(start / step) * step; t <= end + 1e-9; t += step) {
      const x = t2x(t);
      if (x < x0 + 14 || x > x1 - 14) continue;
      ctx.fillText(opts.relative ? `${nf(t - start)} s` : clock(t), x, y1 + 6);
    }
  }
  if (opts.scaleBar) {
    const uv = niceUv(uvPerPx * lane * 0.8);
    const hh = uv / uvPerPx, xs = x1 + 14, yb = y1 - 4;
    ctx.strokeStyle = C.ink; ctx.beginPath();
    ctx.moveTo(crisp(xs), yb - hh); ctx.lineTo(crisp(xs), yb);
    ctx.moveTo(xs - 3, crisp(yb - hh)); ctx.lineTo(xs + 4, crisp(yb - hh));
    ctx.moveTo(xs - 3, crisp(yb)); ctx.lineTo(xs + 4, crisp(yb)); ctx.stroke();
    ctx.fillStyle = C["ink-2"]; ctx.font = `10px ${C.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(nf(uv), xs + 7, yb - hh / 2 - 6); ctx.fillText(opts.unit || "µV", xs + 7, yb - hh / 2 + 7);
  }
  return { ctx, t2x, laneY, v2y, x0, x1, y0, y1, lane, uvPerPx, w, h };
}
function niceUv(v) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  return steps.reduce((best, s) => (s <= v ? s : best), steps[0]);
}

/* Petite ligne de temps SVG (cohorte, protocole) : rangées d'intervalles. */
function svgEl(tag, attrs = {}, text) {
  const a = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return `<${tag} ${a}>${text != null ? text : ""}</${tag}>`;
}

/* Redessine une figure quand son conteneur change de taille. */
function onResize(el, fn) {
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fn); }).observe(el);
}

/* Fichier CSV téléchargé côté navigateur */
function downloadCSV(name, rows) {
  const csv = rows.map(r => r.map(v => {
    const s = v == null ? "" : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n") + "\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
