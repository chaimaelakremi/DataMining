/* ==========================================================================
   Absences — routage par l'adresse (#/page/param?clé=valeur)
   Chaque page et chaque position du tracé a une adresse partageable ;
   le bouton Retour du navigateur fonctionne.
   ========================================================================== */
"use strict";

const ROUTE = { page: null, hash: "" };

const PAGES = {
  accueil:    { enter: p => Accueil.enter(p) },
  comprendre: { enter: p => Comprendre.enter(p) },
  methode:    { enter: p => MethodeTour.enter(p), leave: () => MethodeTour.stop() },
  lecture:    { enter: p => Lecture.enter(p) },
  laboratoire: { enter: p => Labo.enter(p), leave: () => Labo.leave() },
  patients:   { enter: p => Patients.enter(p) },
  erreurs:    { enter: p => Erreurs.enter(p) },
  decouverte: { enter: p => Decouverte.enter(p) },
  anticipation: { enter: p => Anticipation.enter(p) },
  modeles:    { enter: p => Modeles.enter(p) },
  recherche:  { enter: p => Recherche.enter(p) },
  limites:    { enter: p => Limites.enter(p) },
};

function parseHash(hash) {
  let h = (hash || "").replace(/^#/, "");
  // anciennes adresses de la version mono-page : #rec=…&t=…&view=…
  if (/^rec=/.test(h)) {
    const p = new URLSearchParams(h);
    const q = new URLSearchParams();
    if (p.get("t")) q.set("t", p.get("t"));
    if (p.get("win")) q.set("win", p.get("win"));
    if (p.get("view") === "modeles") return { page: "modeles", id: null, q: new URLSearchParams() };
    if (p.get("view") === "analyse") q.set("vue", "analyse");
    return { page: "lecture", id: p.get("rec"), q };
  }
  const [path, query = ""] = h.replace(/^\//, "").split("?");
  const [page, id] = path.split("/");
  return { page: PAGES[page] ? page : "accueil", id: id || null, q: new URLSearchParams(query) };
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function replaceHash(hash) {
  history.replaceState(null, "", hash);
  ROUTE.hash = hash;
}

async function route() {
  const r = parseHash(location.hash);
  const asked = (location.hash.replace(/^#\/?/, "").split(/[/?]/)[0]) || "";
  if (asked && !PAGES[asked] && !/^rec=/.test(location.hash.slice(1))) replaceHash("#/accueil");
  const changed = r.page !== ROUTE.page;
  if (changed && ROUTE.page && PAGES[ROUTE.page].leave) PAGES[ROUTE.page].leave();
  ROUTE.page = r.page; ROUTE.hash = location.hash;
  for (const [name] of Object.entries(PAGES)) $(`#page-${name}`).hidden = name !== r.page;
  $$(".site-nav a").forEach(a => {
    const on = a.dataset.page === r.page;
    a.classList.toggle("is-current", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.body.dataset.page = r.page;
  const sec = $(`#page-${r.page}`);
  if (r.page !== "lecture") document.title = `${sec.dataset.title} · Absences`;
  if (changed) {
    window.scrollTo(0, 0);
    if (ROUTE.started) $("#page").focus({ preventScroll: true });
  }
  ROUTE.started = true;
  PageNav.render(r.page);                                  // « Continuer la visite », commune à toutes les pages
  try { await PAGES[r.page].enter(r); }
  catch (e) { console.error(e); }
}

window.addEventListener("hashchange", route);
document.addEventListener("DOMContentLoaded", () => {
  readColors();
  if (!location.hash || location.hash === "#") replaceHash("#/accueil");
  else if (/^#rec=/.test(location.hash)) {
    const r = parseHash(location.hash);
    replaceHash(r.page === "lecture" ? `#/lecture/${r.id}${r.q.toString() ? "?" + r.q : ""}` : `#/${r.page}`);
  }
  route();
});
