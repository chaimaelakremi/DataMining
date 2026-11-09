/* ==========================================================================
   Absences — analyses du notebook (dossier resultats_local/)
   Page « Recherche » et compléments de la page « Modèles ».
   Tous les chiffres viennent de /api/recherche (tableaux CSV du notebook) ;
   un bloc dont les données manquent n'est pas affiché.
   ========================================================================== */
"use strict";

const Research = {
  data: null,
  async get() {
    if (!this.data) this.data = await api("/api/recherche");
    return this.data;
  },
};

const fmtP = p => (p == null ? "—" : p < 0.001 ? "< 0,001" : nf(p, 3));
const hz = v => `${nf(v, 2)} Hz`;

/* Tableau générique : { cols: [{label, num, dec}], rows: [[…]] } */
function rTable(t, opts = {}) {
  if (!t || !t.rows.length) return "";
  const cell = (v, c) => {
    if (v == null || v === "") return '<td class="num dim">—</td>';
    if (!c.num) return `<td>${esc(v)}</td>`;
    return `<td class="num">${c.dec === "p" ? fmtP(v) : nf(v, c.dec)}</td>`;
  };
  const mark = opts.mark || (() => "");
  if (opts.fold) {
    const { fold, title, note, ...rest } = opts;
    return `<details class="r-details"><summary><span class="r-details-btn">Afficher le tableau</span><span class="r-details-t">${title || ""}</span>${note ? `<span class="h3-note">${note}</span>` : ""}</summary>${rTable(t, rest)}</details>`;
  }
  return `${opts.title ? `<h3 class="h3">${opts.title}${opts.note ? ` <span class="h3-note">${opts.note}</span>` : ""}</h3>` : ""}
    <div class="tbl-scroll"><table class="tbl tbl-r">
      <thead><tr>${t.cols.map(c => `<th class="${c.num ? "num" : ""} sortable" tabindex="0" role="button" title="Trier selon cette colonne">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map(r => `<tr class="${mark(r)}">${r.map((v, i) => cell(v, t.cols[i])).join("")}</tr>`).join("")}</tbody>
    </table></div>${opts.foot ? `<p class="tbl-foot">${opts.foot}</p>` : ""}`;
}

/* Figure du notebook, sur une carte ; un clic l'ouvre en grand */
function rFig(R, key, caption, cls = "") {
  if (!R.figures[key]) return "";
  const src = `/api/recherche/figure/${key}?v=${R.figures[key]}`;
  return `<figure class="rfig ${cls}"><a href="${src}" target="_blank" rel="noopener" title="Ouvrir la figure en grand">
    <img src="${src}" alt="${esc(caption)}" loading="lazy"></a><figcaption>${caption}</figcaption></figure>`;
}

const facts = items => { const li = items.filter(Boolean); return li.length ? `<ul class="r-facts">${li.map(x => `<li>${x}</li>`).join("")}</ul>` : ""; };
const limits = text => `<p class="r-limits"><span class="r-limits-tag">Limites</span> ${text}</p>`;
const NOTEBOOK_NOTE = "Pour produire ces résultats, exécutez le notebook EEG_Absence_Detection.ipynb en local : il écrit ses tableaux et ses figures dans le dossier resultats_local/.";

// ==========================================================================
// Page Recherche
// ==========================================================================
const Recherche = {
  ready: false,
  async enter(params) {
    const box = $("#rech-body");
    this.want = params && params.id ? params.id : this.want;
    if (this.ready) { this.show(this.want); return; }
    stateLine(box, "loading", "Chargement…");
    let R;
    try { R = await Research.get(); }
    catch (e) { stateLine(box, "error", capital(e.message), serverHint); return; }
    if (!R.available) { stateLine(box, "empty", "Aucune analyse disponible", NOTEBOOK_NOTE); return; }
    const sections = this.sections(R).filter(s => s.html);
    box.innerHTML = `<nav class="r-toc" role="tablist" aria-label="Analyses">${sections.map(s =>
      `<button type="button" role="tab" data-id="${s.id}" aria-selected="false"><span class="r-toc-n">${s.n}</span>${s.short}</button>`).join("")}</nav>` +
      sections.map(s => `<section class="rsec" id="rs-${s.id}" hidden><p class="kicker">${s.n} · ${s.kicker}</p><h2 class="h2">${s.title}</h2>${s.html}</section>`).join("");
    this.ids = sections.map(s => s.id);
    $$(".r-toc button", box).forEach(b => b.addEventListener("click", () => go(`#/recherche/${b.dataset.id}`)));
    $$(".explorer", box).forEach(el => new Explorer(el, R[el.dataset.explorer].explorer, +el.dataset.x, +el.dataset.y));
    this.ready = true;
    this.show(this.want);
  },
  /* une seule analyse à l'écran : celle de l'onglet choisi (ou la première) */
  show(id) {
    const cur = this.ids.includes(id) ? id : this.ids[0];
    this.ids.forEach(k => { $(`#rs-${k}`).hidden = k !== cur; });
    $$("#rech-body .r-toc button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.id === cur)));
  },

  sections(R) {
    const out = [
      { id: "fenetres", short: "Taille des fenêtres", kicker: "Découpage du signal", title: "Faut-il des fenêtres plus longues ?", html: this.fenetres(R) },
      { id: "frequence", short: "Fréquence dans la crise", kicker: "Neurophysiologie", title: "Le rythme ralentit-il au cours d’une crise ?", html: this.frequence(R) },
      { id: "typologie", short: "Types de crises", kicker: "Clustering", title: "Toutes les crises se ressemblent-elles ?", html: this.typologie(R) },
      { id: "shap", short: "Ce que regarde le modèle", kicker: "Explicabilité", title: "Sur quoi le modèle fonde-t-il ses décisions ?", html: this.shap(R) },
      { id: "apprentissage", short: "Nombre de patients", kicker: "Courbe d’apprentissage", title: "Combien d’enregistrements faut-il pour apprendre ?", html: this.apprentissage(R) },
      { id: "syndrome", short: "Âge et morphologie", kicker: "Exploration clinique", title: "L’âge change-t-il la forme des décharges, et leur détection ?", html: this.syndrome(R) },
    ];
    out.filter(s => s.html).forEach((s, i) => { s.n = String(i + 1).padStart(2, "0"); });
    return out;
  },

  fenetres(R) {
    const S = R.fenetres; if (!S) return "";
    const f = S.facts;
    return `<p class="body">Toute l’application découpe le signal en fenêtres de 2 secondes. La même chaîne a été refaite avec des fenêtres plus longues, sans rien changer d’autre : même recouvrement de moitié, même Random Forest, même post-traitement. Chaque taille est évaluée par fenêtre (validation par enregistrement) et par crise (chaque enregistrement prédit par un modèle qui ne l’a jamais vu).</p>
      ${f ? facts([
        `Les fenêtres de ${mono(esc(f.moins_manquees))} sont celles qui retrouvent le plus de crises : ${mono(esc(f.detectees || ""))}, soit ${mono(nf(f.manquees))} manquée${f.manquees > 1 ? "s" : ""}.`,
        f.moins_fa !== f.moins_manquees ? `Les fenêtres de ${mono(esc(f.moins_fa))} donnent le moins de fausses alarmes (${mono(nf(f.fa_h, 2))} par heure contre ${mono(nf(f.fa_h_ref, 2))}), mais elles laissent passer ${mono(nf(f.manquees_moins_fa))} crises.` : "",
        "Allonger la fenêtre lisse le signal, ce qui calme les fausses alarmes, mais fait disparaître les crises courtes et retarde la détection.",
      ]) : ""}
      ${rTable(S.table, { title: "Comparaison des tailles", note: "valeurs lues dans le notebook · cliquer un en-tête pour trier" })}
      <p class="r-try"><span class="tool-label">Essayer sur un tracé</span>${S.table.rows.map(r => { const w = parseFloat(String(r[0]).replace(",", "."));
        return isFinite(w) ? `<a class="pill-link" href="#/lecture/230102B-F?vue=analyse&fen=${w}">fenêtres de ${esc(r[0])}</a>` : ""; }).join("")}</p>
      ${rFig(R, "fenetres", "F1 par fenêtre, sensibilité par crise et fausses alarmes par heure selon la taille de fenêtre.")}
      ${limits("Le lissage sur trois fenêtres et la durée minimale de 2 secondes n’ont pas été adaptés à chaque taille : une fenêtre plus longue pourrait mieux faire avec un post-traitement pensé pour elle.")}`;
  },

  frequence(R) {
    const S = R.frequence; if (!S) return "";
    const f = S.facts;
    return `<p class="body">En clinique, on décrit souvent un rythme pointe-onde qui démarre un peu vite puis ralentit avant la fin de la crise. Pour le vérifier, une fenêtre de 2 secondes glisse du début à la fin de chaque crise d’au moins 4 secondes, et l’on y relève la fréquence dominante du signal.</p>
      ${facts([
        `Sur ${mono(nf(f.n))} crises de ${mono(nf(f.patients))} patients, la fréquence médiane passe de ${mono(hz(f.debut))} dans les 2 premières secondes à ${mono(hz(f.fin))} dans les 2 dernières.`,
        `La pente est négative pour ${mono(nf(f.n_neg))} crises sur ${mono(nf(f.n))}${f.p != null ? ` (test de Wilcoxon unilatéral, p ${f.p < 0.001 ? "inférieure à 0,001" : "= " + fmtP(f.p)})` : ""}.`,
        f.pat ? `En ne gardant qu’une valeur par patient, la pente médiane est négative chez ${mono(nf(f.pat_neg))} patients sur ${mono(nf(f.pat))}.` : "",
      ])}
      ${rFig(R, "frequence_evolution", "À gauche, la fréquence moyenne au fil de la crise et son intervalle de confiance. À droite, début contre fin, une crise par point.")}
      ${rFig(R, "frequence_patients", "Le patient aux absences atypiques et le seul patient adulte, comparés à la moyenne des autres.")}
      ${rTable(S.tests, { fold: true, title: "Tests du ralentissement" })}
      ${rTable(S.patients, { fold: true, title: "Par patient", note: "médianes de ses crises d’au moins 4 s" })}
      ${limits("Une fenêtre de 2 secondes ne distingue vraiment que des fréquences écartées d’environ 0,5 Hz : le ralentissement mesuré est du même ordre, et c’est sa répétition d’une crise à l’autre qui le rend crédible. Un seul adulte et un seul patient atypique.")}`;
  },

  typologie(R) {
    const S = R.typologie; if (!S) return "";
    const f = S.facts;
    return `<p class="body">Chaque crise est décrite par plusieurs mesures : durée, fréquence, ralentissement, amplitude par rapport aux secondes qui précèdent, part de la puissance entre 2,5 et 4 Hz, synchronie entre les voies et rapport entre l’avant et l’arrière du crâne. Un algorithme de regroupement (K-means) cherche ensuite des familles de crises, sans connaître ni le patient ni le résultat de la détection.</p>
      ${f ? facts([
        `Le meilleur découpage est en ${mono(nf(f.k))} groupes${f.n ? `, sur ${mono(nf(f.n))} crises` : ""}, avec un score de silhouette de ${mono(nf(f.silhouette, 2))} (1 = groupes parfaitement séparés, 0 = groupes qui se recouvrent).`,
        f.silhouette < 0.5 ? "Ce score est faible : les crises forment un continuum plutôt que des familles nettes, et les groupes ci-dessous sont des repères, pas des types établis." : "",
      ]) : ""}
      ${rTable(S.centroides, { title: "Profil de chaque groupe", note: "médianes, dans les unités d’origine" })}
      ${rTable(S.detection, { title: "Ces groupes sont-ils détectés de la même façon ?", note: "détection par un modèle qui n’a pas vu l’enregistrement" })}
      ${S.explorer ? `<h3 class="h3">Explorer les crises <span class="h3-note">choisir les axes · survoler un point · cliquer pour ouvrir la crise</span></h3><div class="explorer" data-explorer="typologie" data-x="1" data-y="5"></div>` : ""}
      <div class="rfig-pair">${rFig(R, "typologie_silhouette", "Choix du nombre de groupes par le score de silhouette.")}${rFig(R, "typologie_dendrogramme", "Contrôle par une classification hiérarchique.")}</div>
      ${rFig(R, "typologie_acp", "Les crises dans le plan des deux premières composantes : la couleur donne le groupe, la forme le patient.")}
      ${rTable(S.silhouette, { fold: true, title: "Score de silhouette selon le nombre de groupes" })}
      ${limits("Les groupes suivent beaucoup les patients : on ne peut pas séparer l’effet du type de crise de celui du patient. Un groupe de quelques crises chez deux patients n’est pas un type établi.")}`;
  },

  shap(R) {
    const S = R.shap; if (!S) return "";
    const f = S.facts;
    const casMark = t => t;
    return `<p class="body">La méthode SHAP attribue à chaque caractéristique sa part dans la décision du modèle, fenêtre par fenêtre. Les fenêtres expliquées viennent toujours d’enregistrements que le modèle n’a pas vus à l’entraînement. Une valeur positive pousse vers « crise », une valeur négative vers « normal ».</p>
      ${facts([
        f.top && f.top.length ? `Les caractéristiques les plus influentes sont ${f.top.map(x => mono(esc(x))).join(", ")}${f.part_top != null ? ` : à elles ${f.top.length === 5 ? "cinq" : f.top.length}, elles portent ${mono(pct(f.part_top, 0))} de l’effet total` : ""}.` : "",
        "Ce sont surtout des mesures de la taille du signal : le modèle reconnaît d’abord une fenêtre de grande amplitude, plus qu’un rythme à 3 Hz.",
      ])}
      ${rFig(R, "shap_global", "Chaque point est une fenêtre. Sa position donne l’effet de la caractéristique sur la probabilité de crise, sa couleur la valeur de la caractéristique (rouge = élevée).")}
      ${rFig(R, "shap_vp_fp", "Vraies détections et fausses alertes : les mêmes caractéristiques poussent dans le même sens, un peu moins fort pour les fausses alertes.")}
      ${rTable(S.vp_fp, { fold: true, title: "Fausses alertes contre vraies détections", note: "fenêtres prédites « crise » en validation par enregistrement" })}
      <h3 class="h3 r-h3-space">Des décisions expliquées une à une <span class="h3-note">l’EEG de la fenêtre à gauche, l’explication à droite</span></h3>
      ${casMark(rFig(R, "shap_cas_1", "Une fenêtre de crise bien reconnue."))}
      ${rFig(R, "shap_cas_2", "Une fausse alarme : pour le modèle, cette fenêtre a tout d’une crise.")}
      ${rFig(R, "shap_cas_3", "Un début de crise manqué : le signal n’a pas encore pris d’ampleur.")}
      ${rFig(R, "shap_cas_4", "Une fenêtre de crise du patient aux absences atypiques.")}
      ${this.casTable(S.cas)}
      ${rTable(S.importance, { fold: true, title: "Influence de chaque caractéristique", note: "moyenne de la valeur absolue de SHAP" })}
      ${limits("SHAP explique le modèle, pas la physiologie. Plusieurs caractéristiques mesurent presque la même chose et se partagent le crédit : c’est le groupe « amplitude » qu’il faut lire, pas le rang exact de chacune. Ces quelques cas illustrent, ils ne prouvent rien.")}`;
  },

  /* Les quatre cas : chaque ligne ouvre la fenêtre dans la page Lecture */
  casTable(t) {
    if (!t || !t.rows.length) return "";
    const i = Object.fromEntries(t.cols.map((c, k) => [c.label, k]));
    return `<h3 class="h3">Les fenêtres expliquées <span class="h3-note">cliquer pour les ouvrir dans la lecture</span></h3>
      <div class="tbl-scroll"><table class="tbl tbl-r"><thead><tr>${t.cols.map(c => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map(r => `<tr class="clickable" tabindex="0" data-href="#/lecture/${encodeURIComponent(r[i["Enregistrement"]])}?t=${Math.max(0, Math.round(r[i["Début (s)"]] - 4))}">${
        r.map((v, k) => t.cols[k].num ? `<td class="num">${nf(v, t.cols[k].dec)}</td>` : `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  },

  apprentissage(R) {
    const S = R.apprentissage; if (!S) return "";
    const f = S.facts;
    const plateau = f.gain_fin != null && Math.abs(f.gain_fin) < 0.01;
    return `<p class="body">L’expérience est répétée ${mono(nf(f.repetitions))} fois : quelques enregistrements sont mis de côté pour le test, et le Random Forest est entraîné sur un nombre croissant des autres, de ${mono(nf(f.n_min))} à ${mono(nf(f.n_max))}. On mesure à chaque fois le score sur les enregistrements jamais vus.</p>
      ${facts([
        `Le F1 sur les enregistrements de test passe de ${mono(nf(f.f1_min, 3))} avec ${mono(nf(f.n_min))} enregistrements à ${mono(nf(f.f1_max, 3))} avec ${mono(nf(f.n_max))}.`,
        f.gain_fin != null ? `Entre ${mono(nf(f.avant))} et ${mono(nf(f.n_max))} enregistrements, il varie de ${mono(signed(f.gain_fin, 3))} en moyenne, et s’améliore dans ${mono(nf(f.mieux))} répétitions sur ${mono(nf(f.repetitions))}${plateau ? " : la courbe est sur un plateau" : ""}.` : "",
        `Sur les données d’entraînement, le F1 atteint ${mono(nf(f.f1_train, 3))} : l’écart avec le test vient de la variabilité entre patients, que quelques enregistrements de plus du même profil ne comblent pas.`,
      ])}
      ${rFig(R, "apprentissage", "Moyenne et écart-type sur les répétitions, pour le F1 par fenêtre et la sensibilité par crise.")}
      ${rTable(S.table, { fold: true, title: "Scores selon le nombre d’enregistrements d’entraînement" })}
      ${limits("Avec si peu d’enregistrements, les jeux de test se recouvrent d’une répétition à l’autre, et la courbe s’arrête là où s’arrêtent nos données. Elle ne dit rien des profils rares, comme le patient adulte.")}`;
  },

  syndrome(R) {
    const S = R.syndrome; if (!S) return "";
    const f = S.facts || {};
    const g = f.groupes || [];
    const vieux = g[g.length - 1];
    return `<p class="body">L’épilepsie-absence de l’enfant donne typiquement des pointes-ondes régulières autour de 3 Hz ; la forme juvénile, des décharges plus rapides, plus fragmentées, avec des polypointes. Nous n’avons pas le diagnostic de syndrome de nos patients : l’âge n’en est qu’un indicateur indirect, et cette analyse est exploratoire. La question posée : les patients plus âgés ont-ils des décharges d’une autre forme, que le détecteur capterait moins bien ?</p>
      ${facts([
        vieux ? `Les patients du groupe ${mono(esc(vieux.groupe))} sont les moins bien détectés : sur leurs ${mono(nf(vieux.crises))} crises, ${mono(nf(vieux.bien))} bien détectée${vieux.bien > 1 ? "s" : ""}, ${mono(nf(vieux.tardives))} tardive${vieux.tardives > 1 ? "s" : ""} et ${mono(nf(vieux.manquees))} manquée${vieux.manquees > 1 ? "s" : ""}, pour une couverture médiane de ${mono(nf(vieux.couverture, 2))}${g.length > 1 ? ` (contre ${g.slice(0, -1).map(x => mono(nf(x.couverture, 2))).join(" et ")} chez les plus jeunes)` : ""}.` : "",
        f.n_mesures ? (f.n_signif === 0
          ? `Mais aucune des ${mono(nf(f.n_mesures))} mesures de forme n’est liée à l’âge de façon statistiquement établie (plus petite p corrigée : ${mono(fmtP(f.p_holm_min))}, sur ${mono(nf(f.n))} patients).`
          : `${mono(nf(f.n_signif))} mesure${f.n_signif > 1 ? "s" : ""} de forme sur ${mono(nf(f.n_mesures))} ${f.n_signif > 1 ? "sont liées" : "est liée"} à l’âge après correction.`) : "",
        ...(f.couverture_signif || []).map(c => `Ce qui est lié à la couverture par le détecteur : ${esc(c.mesure.charAt(0).toLowerCase() + c.mesure.slice(1))} (rho = ${mono(signed(c.rho, 2))}, p corrigée = ${mono(fmtP(c.p_holm))}).`),
      ])}
      ${rFig(R, "syn_synthese", "Âge, forme des décharges et détection. Grands points : un patient ; petits points gris : une crise.")}
      ${S.explorer ? `<h3 class="h3">Explorer les crises selon l’âge <span class="h3-note">choisir les axes · survoler un point · cliquer pour ouvrir la crise</span></h3><div class="explorer" data-explorer="syndrome" data-x="0" data-y="${Math.max(0, S.explorer.vars.indexOf("Couverture par le détecteur"))}"></div>` : ""}
      ${rTable(S.groupes, { title: "Détection par groupe d’âge", note: "tardive = détectée avec plus de 2 s de retard" })}
      ${rFig(R, "syn_age_frequence", "Âge et fréquence des décharges, avec les plages décrites dans la littérature pour les formes de l’enfant et juvénile.")}
      ${rTable(S.medianes, { fold: true, title: "Forme des décharges par groupe d’âge", note: "médiane des patients de chaque groupe" })}
      ${rFig(R, "syn_groupes", "Chaque point coloré est un patient ; les points gris sont ses crises.")}
      ${rTable(S.age, { fold: true, title: "Lien entre l’âge et chaque mesure", note: "corrélation de Spearman, une valeur par patient" })}
      ${rFig(R, "syn_extraits", "Des patients d’âges différents : un extrait au milieu d’une crise, un zoom et le spectre.")}
      ${rFig(R, "syn_detection", "Couverture et retard selon la fréquence, la fragmentation et les composantes rapides, crise par crise.")}
      ${rTable(S.couverture, { fold: true, title: "Qu’est-ce qui accompagne une bonne couverture ?", note: "corrélation de Spearman, une valeur par patient" })}
      ${limits("Pas de diagnostic de syndrome : l’âge n’est qu’un indicateur indirect. Très peu de patients dans le groupe le plus âgé, donc chaque chiffre de ce groupe repose sur une poignée de crises. EEG de scalp, mesures de forme approximatives. C’est une analyse exploratoire, qui suggère une hypothèse sans la démontrer : il faudrait entraîner et évaluer le détecteur sur des adolescents et des adultes.")}`;
  },
};

// ==========================================================================
// Compléments de la page Modèles : comparaison étendue et tests statistiques
// ==========================================================================
const ModelesPlus = {
  done: false,
  TABS: [["comparaison", "Comparaison des modèles"], ["tests", "Tests statistiques"], ["origine", "Modèles d’origine"], ["enregistrements", "Par enregistrement"], ["banc", "Banc d’essai"]],
  show(id) {
    const cur = this.TABS.some(t => t[0] === id) ? id : this.TABS[0][0];
    $$("#models-body [data-mtab]").forEach(el => { el.hidden = el.dataset.mtab !== cur; });
    $$("#models-tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.id === cur)));
    // le graphique des modèles d'origine se dessine à la bonne taille une fois son onglet visible
    if (cur === "origine" && Modeles.models) drawChart(Modeles.models.models, Modeles.models.best);
    if (cur === "banc") Banc.enter();
  },
  async load(params) {
    const box = $("#models-plus");
    this.want = params && params.id ? params.id : this.want;
    if (this.done) { this.show(this.want); return; }
    if (!box) return;
    let R;
    try { R = await Research.get(); } catch (e) { return; }
    const S = R.modeles;
    if (!S) { box.hidden = true; return; }
    const f = S.facts;
    const name = S.table ? S.table.cols.findIndex(c => c.label === "Modèle") : -1;
    const et = (S.extra_trees || []);
    const anySig = et.some(x => x.p_holm != null && x.p_holm < 0.05);
    box.hidden = false;
    $("#models-first-h2").hidden = false;
    box.innerHTML = `
      <section class="models-section models-section-first">
        <h2 class="h2">${f ? `${nf(f.n)} modèles` : "Davantage de modèles"}, dans les mêmes conditions</h2>
        <p class="body">Aux classifieurs du départ, le notebook en ajoute d’autres (régression logistique, Bayes naïf, Extra Trees, méthodes de boosting, réseau de neurones) et un modèle témoin qui répond toujours « pas de crise ». Mêmes caractéristiques, même découpage, mêmes scores.</p>
        ${f ? facts([
          `Évalué par enregistrement, le meilleur F1 est celui de ${mono(esc(f.best))} (${mono(nf(f.best_f1, 3))})${f.best !== "Random Forest" ? `, devant le Random Forest (${mono(nf(f.rf_f1, 3))})` : ""}.`,
          f.best_random !== f.best ? `Sur le découpage aléatoire, c’est ${mono(esc(f.best_random))} qui arrive en tête : le classement change selon la façon d’évaluer.` : "",
          `Tous les modèles perdent du F1 quand on les teste sur des enregistrements jamais vus : de ${mono(nf(f.gap_min, 3))} à ${mono(nf(f.gap_max, 3))}.`,
        ]) : ""}
        ${rTable(S.table, { note: "triés par F1 par enregistrement", title: "Comparaison étendue", mark: r => (name >= 0 && f && r[name] === f.best ? "is-current" : ""),
                            foot: "Ligne surlignée : meilleur F1 par enregistrement. Valeurs lues dans <span class=\"mono\">resultats_local/comparaison_etendue_modeles.csv</span>." })}
        <figure class="rfig" id="mchart-fig"><div class="mchart-head"><span class="tool-label">Mesure</span><span class="seg" id="mchart-seg"></span>
          <span class="mchart-legend"><i class="mc-a"></i>découpage aléatoire <i class="mc-b"></i>par enregistrement</span></div>
          <div id="mchart"></div><figcaption>Survoler une barre pour lire la valeur ; cliquer un en-tête du tableau pour trier les modèles.</figcaption></figure>
        ${rTable(S.detection, { title: "Détection par crise des deux meilleurs", note: "chaque enregistrement prédit par un modèle qui ne l’a pas vu" })}
      </section>
      <section class="models-section">
        <h2 class="h2">La différence est-elle réelle ?</h2>
        <p class="body">Les meilleurs modèles sont comparés enregistrement par enregistrement, avec un test de Wilcoxon apparié contre le Random Forest et une correction de Holm pour les comparaisons multiples. Les intervalles de confiance sont obtenus en rééchantillonnant les enregistrements.</p>
        ${et.length ? facts([
          anySig ? "Entre Extra Trees et le Random Forest, au moins une différence reste significative après correction."
                 : `Entre Extra Trees et le Random Forest, aucune différence n’est significative après correction (${et.map(x => `${esc(x.metrique)} : p corrigée ${mono(fmtP(x.p_holm))}`).join(" ; ")}).`,
          "Avec si peu d’enregistrements, ces tests ne détectent que des écarts importants et réguliers : « non significatif » ne veut pas dire « équivalent ».",
        ]) : ""}
        ${rFig(R, "tests_ic95", "Estimation et intervalle de confiance à 95 % pour chaque modèle.")}
        ${rTable(S.diff, { title: "Extra Trees moins Random Forest", note: "différence et intervalle de confiance à 95 %" })}
        ${rTable(S.tests, { fold: true, title: "Chaque modèle contre le Random Forest", note: "« plus élevé » : nombre d’enregistrements où sa valeur dépasse celle du Random Forest" })}
        <p class="body">La suite des analyses (taille des fenêtres, types de crises, explicabilité, âge) est sur la page <a class="link" href="#/recherche">Recherche</a>.</p>
      </section>`;
    this.done = true;
    this.chart(S.table, "F1");
    // onglets : chaque bloc de la page reçoit son onglet
    const secs = $$("#models-plus > section");
    if (secs[0]) secs[0].dataset.mtab = "comparaison";
    if (secs[1]) secs[1].dataset.mtab = "tests";
    ["#models-first-h2", "#models-body .models-grid", "#gkf-section", "#smooth-section"].forEach(q => { const el = $(q); if (el) el.dataset.mtab = "origine"; });
    const pr = $("#models-body .per-rec"); if (pr) pr.dataset.mtab = "enregistrements";
    const tabs = $("#models-tabs"); tabs.hidden = false;
    tabs.innerHTML = this.TABS.map(([id, l]) => `<button type="button" role="tab" data-id="${id}" aria-selected="false">${l}</button>`).join("");
    $$("button", tabs).forEach(b => b.addEventListener("click", () => go(`#/modeles/${b.dataset.id}`)));
    this.show(this.want);
  },
  /* Barres par modèle : une mesure au choix, découpage aléatoire contre validation par enregistrement */
  chart(t, metric) {
    const PAIRS = { "F1": ["F1", "F1 par enregistrement"], "Précision": ["Précision", "Précision par enr."], "Rappel": ["Rappel", "Rappel par enr."] };
    const col = l => t.cols.findIndex(c => c.label === l), iName = col("Modèle");
    const avail = Object.keys(PAIRS).filter(k => col(PAIRS[k][0]) >= 0 && col(PAIRS[k][1]) >= 0);
    if (!avail.length || iName < 0) { $("#mchart-fig").hidden = true; return; }
    $("#mchart-seg").innerHTML = avail.map(k => `<button type="button" data-k="${k}" aria-pressed="${k === metric}">${k}</button>`).join("");
    $$("#mchart-seg button").forEach(b => b.addEventListener("click", () => this.chart(t, b.dataset.k)));
    const [a, b] = PAIRS[metric].map(col), rows = [...t.rows].sort((x, y) => (y[b] ?? 0) - (x[b] ?? 0));
    const W = 1000, H = 300, L = 44, T = 16, B = 78, bw = (W - L - 10) / rows.length, y = v => T + (1 - v) * (H - T - B);
    let g = "";
    for (let k = 0; k <= 4; k++) g += `<line class="ant-grid" x1="${L}" x2="${W - 10}" y1="${y(k / 4)}" y2="${y(k / 4)}"/><text class="ant-tick" x="${L - 8}" y="${y(k / 4) + 4}" text-anchor="end">${nf(k / 4, 2)}</text>`;
    rows.forEach((r, i) => {
      const x0 = L + i * bw + bw * 0.14, w = bw * 0.34, bar = (v, dx, cls, lab) => v == null ? "" :
        `<rect class="${cls}" x="${x0 + dx}" y="${y(v)}" width="${w}" height="${Math.max(0, y(0) - y(v))}" rx="3"><title>${esc(r[iName])} — ${lab} : ${nf(v, 3)}</title></rect>` +
        `<text class="mc-val" x="${x0 + dx + w / 2}" y="${y(v) - 4}" text-anchor="middle">${nf(v, 2)}</text>`;
      g += bar(r[a], 0, "mc-a", "découpage aléatoire") + bar(r[b], w + 2, "mc-b", "par enregistrement");
      g += `<text class="mc-name" transform="translate(${x0 + w} ${H - B + 14}) rotate(-28)" text-anchor="end">${esc(r[iName])}</text>`;
    });
    $("#mchart").innerHTML = `<svg class="ant-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(metric)} de chaque modèle, sur le découpage aléatoire et par enregistrement">${g}</svg>`;
  },
};

// ==========================================================================
// Explorateur : nuage de points interactif (une crise = un point)
// ==========================================================================
class Explorer {
  constructor(el, data, ix, iy) {
    this.el = el; this.d = data; this.ix = ix; this.iy = iy; this.off = new Set();
    this.colors = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9"];
    this.draw();
  }
  draw() {
    const d = this.d, opt = i => d.vars.map((v, k) => `<option value="${k}"${k === i ? " selected" : ""}>${esc(v)}</option>`).join("");
    const pts = d.points.filter(p => p.v[this.ix] != null && p.v[this.iy] != null && !this.off.has(p.group));
    const W = 1000, H = 400, L = 64, R = 18, T = 14, B = 46;
    const ext = i => { const v = d.points.map(p => p.v[i]).filter(x => x != null); let a = Math.min(...v), b = Math.max(...v); if (a === b) { a -= 1; b += 1; } const m = (b - a) * 0.06; return [a - m, b + m]; };
    const [x0, x1] = ext(this.ix), [y0, y1] = ext(this.iy);
    const X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const dec = (a, b) => (b - a) < 2 ? 2 : (b - a) < 20 ? 1 : 0;
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const vx = x0 + (x1 - x0) * k / 4, vy = y0 + (y1 - y0) * k / 4;
      g += `<line class="ant-grid" x1="${L}" x2="${W - R}" y1="${Y(vy)}" y2="${Y(vy)}"/><text class="ant-tick" x="${L - 8}" y="${Y(vy) + 4}" text-anchor="end">${nf(vy, dec(y0, y1))}</text>`;
      g += `<text class="ant-tick" x="${X(vx)}" y="${H - B + 18}" text-anchor="middle">${nf(vx, dec(x0, x1))}</text>`;
    }
    g += `<text class="ant-axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${esc(d.vars[this.ix])}</text>`;
    g += `<text class="ant-axis" transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${esc(d.vars[this.iy])}</text>`;
    pts.forEach(p => {
      const c = this.colors[d.groups.indexOf(p.group) % this.colors.length], bad = p.det && /anqu/.test(p.det);
      g += `<a href="#/lecture/${encodeURIComponent(p.id)}?t=${Math.max(0, Math.round((p.start || 0) - 5))}" class="ex-pt" data-info="${esc(`${p.id}, crise ${p.n} · ${p.group}${p.det ? " · " + p.det.toLowerCase() : ""} · ${d.vars[this.ix]} : ${nf(p.v[this.ix], 2)} · ${d.vars[this.iy]} : ${nf(p.v[this.iy], 2)}`)}">
        <circle cx="${X(p.v[this.ix]).toFixed(1)}" cy="${Y(p.v[this.iy]).toFixed(1)}" r="6" fill="${c}" fill-opacity="0.8" stroke="${bad ? "#2C2430" : "#fff"}" stroke-width="${bad ? 2.2 : 1.2}"/></a>`;
    });
    this.el.innerHTML = `<div class="ex-head"><label class="field"><span class="tool-label">Axe horizontal</span><select data-ax="x">${opt(this.ix)}</select></label>
        <label class="field"><span class="tool-label">Axe vertical</span><select data-ax="y">${opt(this.iy)}</select></label>
        <span class="ex-groups">${d.groups.map((gr, k) => `<button type="button" class="ex-g${this.off.has(gr) ? " is-off" : ""}" data-g="${esc(gr)}" aria-pressed="${!this.off.has(gr)}" title="Afficher ou masquer ce groupe"><i style="background:${this.colors[k % this.colors.length]}"></i>${esc(gr)} (${d.points.filter(p => p.group === gr).length})</button>`).join("")}</span></div>
      <svg class="ant-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Nuage de points : ${esc(d.vars[this.iy])} selon ${esc(d.vars[this.ix])}">${g}</svg>
      <p class="ex-info" aria-live="polite">${nf(pts.length)} crises affichées. Contour sombre : crise manquée. Survoler un point pour le détail, cliquer pour l’ouvrir dans la lecture.</p>`;
    const info = $(".ex-info", this.el), base = info.textContent;
    $$("select", this.el).forEach(s => s.addEventListener("change", () => { if (s.dataset.ax === "x") this.ix = +s.value; else this.iy = +s.value; this.draw(); }));
    $$(".ex-g", this.el).forEach(b => b.addEventListener("click", () => { const k = b.dataset.g; this.off.has(k) ? this.off.delete(k) : this.off.add(k); this.draw(); }));
    $$(".ex-pt", this.el).forEach(a => { a.addEventListener("mouseenter", () => { info.textContent = a.dataset.info; }); a.addEventListener("focus", () => { info.textContent = a.dataset.info; });
      a.addEventListener("mouseleave", () => { info.textContent = base; }); });
  }
}

/* Tri des tableaux : un clic sur un en-tête trie, un second clic inverse */
function sortTable(th) {
  const table = th.closest("table"), i = [...th.parentNode.children].indexOf(th), body = table.tBodies[0];
  const asc = th.getAttribute("aria-sort") !== "ascending";
  const val = tr => { const s = tr.children[i].textContent.trim(); const n = parseFloat(s.replace(/[\s\u202f\u00a0<]/g, "").replace(",", ".").replace("−", "-")); return isNaN(n) ? s.toLowerCase() : n; };
  const rows = [...body.rows].sort((a, b) => { const x = val(a), y = val(b);
    if (typeof x === "number" && typeof y === "number") return asc ? x - y : y - x;
    if (typeof x === "number") return -1; if (typeof y === "number") return 1;
    return asc ? String(x).localeCompare(String(y), "fr") : String(y).localeCompare(String(x), "fr"); });
  $$("th", table).forEach(h => h.removeAttribute("aria-sort")); th.setAttribute("aria-sort", asc ? "ascending" : "descending");
  rows.forEach(r => body.appendChild(r));
}
document.addEventListener("click", e => { const th = e.target.closest("th.sortable"); if (th) sortTable(th); });
document.addEventListener("keydown", e => { const th = e.target.closest && e.target.closest("th.sortable"); if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortTable(th); } });

/* lignes cliquables des tableaux de la page Recherche */
document.addEventListener("click", e => { const tr = e.target.closest("tr[data-href]"); if (tr) go(tr.dataset.href); });
document.addEventListener("keydown", e => {
  const tr = e.target.closest && e.target.closest("tr[data-href]");
  if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(tr.dataset.href); }
});
