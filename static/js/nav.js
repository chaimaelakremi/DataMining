/* ==========================================================================
   Absences — navigation de visite, commune à toutes les pages :
   « Continuer la visite » (page précédente / suivante, toutes les pages), bouton
   « Haut de page », raccourcis Alt+← / Alt+→. L'ordre suit le menu du site.
   ========================================================================== */
"use strict";

const PageNav = (() => {
  const INFO = {
    accueil: ["⌂", "Le projet en quelques chiffres et un premier tracé."],
    comprendre: ["◎", "À quoi ressemble une absence sur l’EEG."],
    methode: ["⚙", "La chaîne pas à pas, sur un vrai enregistrement."],
    lecture: ["≋", "Faire défiler un EEG réel et lancer la détection."],
    laboratoire: ["⚗", "Démonstrations calculées en direct."],
    patients: ["☷", "Les enregistrements un par un, carte de la cohorte."],
    erreurs: ["⚠", "Les crises manquées et les fausses alarmes."],
    decouverte: ["✦", "Ce que l’autoencodeur signale hors des annotations."],
    anticipation: ["⏱", "Peut-on annoncer une crise avant son début ?"],
    modeles: ["⚖", "Les modèles comparés et le banc d’essai."],
    recherche: ["❖", "Analyses complémentaires du notebook."],
    limites: ["⚑", "Ce que ce travail permet de dire, et ce qu’il ne permet pas."],
  };
  const order = () => $$(".site-nav a").map(a => ({ page: a.dataset.page, name: a.textContent.trim() }));

  function render(page) {
    const sec = $(`#page-${page}`);
    if (!sec || page === "accueil") return;
    let box = $(".page-nav", sec);
    if (!box) { box = document.createElement("nav"); box.className = "page-nav"; box.setAttribute("aria-label", "Continuer la visite"); sec.appendChild(box); }
    const O = order(), i = O.findIndex(p => p.page === page);
    const prev = O[(i - 1 + O.length) % O.length], next = O[(i + 1) % O.length];
    const card = (p, dir) => `<a class="pn-card pn-${dir}" href="#/${p.page}"><span class="pn-dir">${dir === "prev" ? "← Page précédente" : "Page suivante →"}</span>` +
      `<span class="path-title">${INFO[p.page] ? INFO[p.page][0] + " " : ""}${esc(p.name)}</span><span class="path-text">${esc((INFO[p.page] || ["", ""])[1])}</span></a>`;
    box.innerHTML = `<p class="kicker">Continuer la visite <span class="pn-keys"><kbd>Alt</kbd> + <kbd>←</kbd> / <kbd>→</kbd></span></p>
      <div class="pn-big">${card(prev, "prev")}${card(next, "next")}</div>
      <div class="pn-all">${O.map(p => p.page === page
        ? `<span class="pn-mini is-current" aria-current="page"><span aria-hidden="true">${(INFO[p.page] || [""])[0]}</span>${esc(p.name)}</span>`
        : `<a class="pn-mini" href="#/${p.page}"><span aria-hidden="true">${(INFO[p.page] || [""])[0]}</span>${esc(p.name)}</a>`).join("")}</div>`;
  }

  function step(d) {
    const O = order(), i = O.findIndex(p => p.page === ROUTE.page);
    if (i < 0) return;
    go(`#/${O[(i + d + O.length) % O.length].page}`);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const up = document.createElement("button");
    up.type = "button"; up.className = "to-top"; up.hidden = true; up.textContent = "↑ Haut de page";
    up.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" }));
    document.body.appendChild(up);
    const onScroll = () => { up.hidden = window.scrollY < 600; document.body.classList.toggle("is-scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    document.addEventListener("keydown", e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if (e.target.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault(); step(e.key === "ArrowLeft" ? -1 : 1);
    });
  });
  return { render };
})();
