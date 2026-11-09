# Lancer l’application

Prérequis : Python 3.10 ou plus récent, et ce dossier contenant `data/`, `resultats/` et `static/`.

## Installation (une seule fois)

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows : .venv\Scripts\activate
pip install -r requirements.txt
```

## Démarrage

```bash
uvicorn app:app --port 8000
```

Puis ouvrir <http://localhost:8000> dans le navigateur. Le site compte onze pages (Accueil, Comprendre,
Méthode, Lecture, Laboratoire, Patients, Erreurs, Anticipation, Modèles, Recherche, Limites) ; chaque page et chaque position du tracé a sa propre
adresse, par exemple <http://localhost:8000/#/lecture/230102B-F?t=58>.

## Premier démarrage

- Le serveur lit l’en-tête de chaque `.mat` (une dizaine de secondes), puis lance en arrière-plan deux calculs :
  1. la détection sur tous les enregistrements, chacun avec un modèle ré-entraîné **sans lui** (aucune fuite de données) ;
  2. la validation GroupKFold par enregistrement.
- Comptez de 1 à 2 minutes selon la machine. Pendant ce temps, les pages Patients, Erreurs et Modèles affichent
  l’avancement ; tout est ensuite gardé en cache et les démarrages suivants sont immédiats.

## Bon à savoir

- Le journal d’examen (hyperpnée, SLI, saturations) est lu dans les fichiers `<ID>_0000h.mat` de `data/` ;
  sans eux l’application fonctionne, mais sans ce calque.
- Tous les fichiers générés vont dans `.cache/` (environ 130 Mo). Les dossiers `data/` et `resultats/` ne sont
  jamais modifiés. Supprimer `.cache/` remet l’application à zéro.
- Dans Lecture, le réglage « Fenêtres d’analyse » (2 s, 5 s, 10 s) relance la détection avec une autre taille de
  fenêtre. Les tailles autres que 2 s utilisent les jeux `resultats_local/features_windows_{N}s.csv` du notebook.
- Si la page semble ancienne après une mise à jour : Ctrl + Maj + R, ou ouvrir <http://127.0.0.1:8000>.
- La page Anticipation lit `resultats_local/anticipation/`, produit par la section « Anticipation des crises
  (exploratoire) » du notebook. Tant que cette section n’a pas été exécutée, la page l’indique.
- La page Recherche et le début de la page Modèles affichent les analyses du notebook : elles relisent les tableaux et
  les figures de `resultats_local/`. Après une nouvelle exécution du notebook, il suffit de recharger la page.
  Sans ce dossier, ces blocs n’apparaissent pas.
- Les polices viennent de Google Fonts ; sans connexion Internet, des polices système les remplacent.

## Page Laboratoire (démonstrations en direct)

Adresse : <http://localhost:8000/#/laboratoire>, placée juste après « Lecture » dans le menu. Elle compte trois onglets, chacun avec sa propre adresse.
Tout y est calculé à la demande. Le modèle utilisé est toujours celui entraîné **sans** l’enregistrement montré :
ce sont les modèles « sans l’enregistrement » de `.cache/models/`.

- **Temps réel** (`#/laboratoire/temps-reel`). Choisir l’enregistrement et la seconde de départ, puis Lecture, Pause ou
  Recommencer, à la vitesse ×1, ×2, ×5 ou ×10. Le serveur reçoit le signal par paquets et calcule chaque nouvelle fenêtre à la volée,
  avec `extract_features` d’`eeg_pipeline.py`, puis le modèle, puis les règles de `detect()` : lissage médian sur 3
  fenêtres, fusion à 1 s, durée minimale 2 s. Le filtre passe-bande (aller-retour) a besoin de 2 s de signal après chaque fenêtre :
  le moniteur affiche donc le tracé avec 2 s de décalage, comme un appareil réel. Le compteur « Accord avec l’analyse
  complète » mesure en direct la part des fenêtres qui reçoivent la même décision que l’analyse hors ligne (99,9 à 100 %).
  Les crises annotées n’apparaissent qu’une fois terminées. « Passer à la prochaine crise » saute 15 s avant la crise
  annotée suivante, et les compteurs continuent. Le bip est coupé par défaut.
- **Réglages** (`#/laboratoire/reglages`). Les curseurs règlent le seuil, le lissage, l’écart de fusion et la durée minimale. Le choix du modèle
  bascule entre Random Forest et Extra Trees. La détection des 19 enregistrements est refaite dans le navigateur à chaque mouvement de curseur, en
  quelques dizaines de millisecondes. La règle de décision est « probabilité > seuil » : au seuil 0,5, elle est identique à `model.predict`.
  « Réinitialiser » revient au réglage du projet : Random Forest 80/82 et 25 fausses alarmes, comme `resultats/detection_par_enregistrement.csv` ;
  Extra Trees 81/82 et 41, comme `resultats_local/comparaison_etendue_detection.csv`. La ligne sous les chiffres compare les trois
  calculs : navigateur, serveur avec `eeg_pipeline.py`, et notebook.
  Les probabilités sont calculées une seule fois (environ 15 s pour RF et 25 s pour Extra Trees), puis gardées dans `.cache/lab/`.
- **Stress test** (`#/laboratoire/stress`). Un extrait calme de 10 s est choisi par calcul (loin des crises, probabilité la plus
  basse), ou à la main. Les injections se font dans une copie en mémoire : les fichiers ne sont jamais modifiés.
  - a) Cinq artefacts : mouvement, muscle, 50 Hz, décollement d’électrode, clignement. La page montre l’EEG avant et après (filtré ou brut), la
    probabilité par fenêtre et le verdict « Fausse alarme » ou « Pas d’alarme ».
  - b) Décharge pointe-onde synthétique : fréquence, amplitude crête à crête sur les voies frontales, durée, régularité. Le gabarit est une
    pointe d’environ 70 ms suivie d’une onde lente (le pic du spectre tombe sur la fréquence choisie, comme pour les vraies
    absences). Il est présent sur toutes les voies, avec un maximum frontal et une légère variation d’une voie à l’autre. La
    page indique aussi l’amplitude mesurée par la chaîne, à comparer à celle des vraies crises.
  - c) « Cartographier » balaie 13 fréquences (2 à 5 Hz) × 11 amplitudes (20 à 400 µV), soit 143 analyses complètes, en environ 15 s.
    Le résultat est mis en cache dans `.cache/lab/`. La phrase sous la carte est calculée : la part de la variation expliquée par
    l’amplitude et par la fréquence, comparée à l’importance SHAP du notebook (`resultats_local/shap_importance_globale.csv`).

### Démo en 5 minutes

1. **Temps réel** (2 min). Enregistrement `230102B-F`, vitesse ×5, cliquer « Passer à la prochaine crise ». L’alarme se
   déclenche (« CRISE DÉTECTÉE »), puis la bande verte de l’annotation apparaît une fois la crise passée. Cliquer encore deux fois
   « Passer à la prochaine crise ». Montrer les compteurs (crises détectées / annotées, retard moyen) et l’accord avec
   l’analyse complète.
2. **Réglages** (1 min 30). Passer le seuil à 0,30 : plus de crises, beaucoup plus de fausses alarmes, et les lignes changées se colorent.
   Passer à 0,80 : l’inverse. Montrer le point « réglage du projet » sur la courbe. Basculer sur Extra Trees, puis revenir
   sur Random Forest et cliquer « Réinitialiser » : 80/82 et 25 fausses alarmes.
3. **Stress test** (1 min 30). Extrait calme automatique de `230102B-F`. Cliquer « Clignement des yeux » puis « Parasite 50 Hz » :
   pas d’alarme, et le filtre 0,5–40 Hz efface le 50 Hz. Décharge synthétique à 3 Hz et 300 µV : « Détectée ». Baisser
   l’amplitude à 150 µV : « Non détectée ». Cliquer « Cartographier » et lire la phrase calculée (amplitude contre fréquence,
   et SHAP).

Avant la présentation, ouvrir une fois chaque onglet (et lancer « Cartographier ») : les calculs initiaux sont alors en
cache et tout s’affiche ensuite sans attente. La page fonctionne sans Internet (aucune bibliothèque externe).

## Outils interactifs : Modèles, Patients, Limites

Les calculs longs tournent sur le serveur comme des tâches de fond : barre de progression, bouton « Annuler », un seul
calcul lourd à la fois, les autres attendent. Chaque résultat est gardé dans `.cache/outils/` selon ses paramètres :
relancer exactement le même calcul est immédiat. Un enregistrement annoté n’est jamais évalué par un modèle qui l’a vu
(GroupKFold par enregistrement, ou un enregistrement laissé de côté).

- **Modèles → onglet « Banc d’essai »** (`#/modeles/banc`).
  - a) Entraîner un modèle : modèle, réglages, fenêtres de 2, 5 ou 10 s, caractéristiques (raccourcis « Sans amplitude »,
    « Sans fréquences », « Tout ») et type d’évaluation. Le résultat s’affiche à côté du Random Forest de référence évalué de
    la même façon. L’historique garde les 5 derniers essais.
  - b) Tester sur un patient : frise, probabilité et tableau des crises.
  - c) Duel : deux configurations sur un même enregistrement, avec la liste de leurs désaccords.
  - Le SVM est entraîné sur 6 000 fenêtres tirées au hasard : sur le jeu complet, un seul entraînement prend environ 50 s.
- **Patients**, au-dessus du tableau :
  - carte des patients (ACP des 17 caractéristiques moyennes) ;
  - K-means (k = 2 à 5, silhouette) ;
  - filtres et comparaison de deux groupes ;
  - relance de la détection sur les lignes cochées (Random Forest ou Extra Trees, seuil au choix) ;
  - bouton « proches » sur chaque ligne.
- **Limites** : un bouton « Démontrer » sous cinq des limites et des choix :
  - pondération des classes : seuil ;
  - validation par enregistrement : évaluation optimiste ;
  - petite cohorte : peu de données ;
  - surtout des enfants : le patient adulte ;
  - artefacts.
- **Anticipation** : un tableau de la part des crises annoncées par groupe d’âge.

### Démo en 5 minutes : Modèles, Patients, Limites

1. **Modèles → Banc d’essai** (2 min).
   1. Laisser Random Forest, 2 s, « Par enregistrement (GroupKFold, 5 plis) », et cliquer « Lancer » : environ 15 s, ou immédiat si déjà en cache.
   2. Cliquer « Sans amplitude », puis « Lancer » : le F1 et les crises détectées chutent, en rose dans la comparaison, et
      l’historique montre les deux lignes l’une sous l’autre.
   3. Dans b), choisir `230102B-F` et cliquer « Lancer » : la frise et la probabilité s’affichent, puis « Ouvrir dans Lecture ».
   4. Dans c), garder KNN comme configuration B, enregistrement `210504B-C`, cliquer « Lancer le duel » et lire les désaccords.
2. **Patients** (1 min 30).
   1. Sur la carte, choisir « Couleur : groupe d’âge » : le patient adulte se détache.
   2. Onglet K-means : k = 3, « Regrouper », puis lire la silhouette et les fiches des groupes.
   3. Onglet Filtres : « Âge ≥ 12 ans » ; le tableau et les totaux se mettent à jour. Cocher « comparer deux groupes » avec B = « < 8 ans ».
   4. Cliquer « proches » sur `191113A-D`.
3. **Limites** (1 min 30).
   1. Sous « La pondération des classes », « Démontrer » puis bouger le seuil.
   2. Sous « Une validation par enregistrement », « Démontrer » puis les deux boutons : l’écart de F1 s’affiche.
   3. Sous « Une petite cohorte », « Démontrer », choisir 3 puis « Lancer », puis 15 puis « Lancer » : la courbe d’apprentissage se construit.
   4. Sous « Surtout des enfants », « Démontrer » : les 2 crises manquées de `191113A-D`.

Avant la présentation, faire une fois chaque calcul pour qu’il soit en cache (la durée de chacun est indiquée à côté de
la barre de progression).

## Deux études exploratoires : Découverte et Électrodes

Les deux dernières sections du notebook produisent `resultats_local/autoencodeur/` et `resultats_local/electrodes/`.
Le site relit ces dossiers. Leur code est dans `etude_autoencodeur.py` et `etude_electrodes.py`, à côté du notebook.
Elles demandent PyTorch (CPU), dans `requirements.txt`. Les caches vont dans `.cache/autoencodeur/` et `.cache/electrodes/`.

- **Page Découverte** (`#/decouverte`, après « Erreurs »). Un autoencodeur entraîné uniquement sur de l’EEG normal signale
  ce qui ne lui ressemble pas. La page présente :
  - les chiffres clés, dont l’AUC sur les 82 crises connues, comparée au Random Forest ;
  - la liste des événements anormaux hors des crises annotées : miniature, étiquette, fréquence, voies concernées, notes du journal ;
  - des filtres par étiquette et par enregistrement, et une entrée « fausses alarmes du RF ».
  - Un clic sur la miniature ouvre l’événement dans Lecture.
  - Les boutons « Crise probable », « Artefact », « Normal », « Incertain » enregistrent un avis dans
    `resultats_local/autoencodeur/avis_medecin.csv`, avec un résumé en direct.
- **Lecture** : le calque « courbe d’anomalie », sous la légende, ajoute le score sous le tracé. Il montre aussi la ligne du seuil,
  les « décharges possibles » en rose et les autres événements en bleu.
- **Laboratoire → Électrodes** (`#/laboratoire/electrodes`).
  - Un clic sur une électrode la fait passer d’intacte à retirée, puis à corrompue (type de panne choisi dans la liste).
  - On peut aussi retirer une région, changer la référence (originale, moyenne commune, Cz) et cocher la variante robuste (médiane des voies).
  - « Lancer » refait la détection des 19 enregistrements avec les caractéristiques par voie en cache.
    Le premier calcul charge les 19 modèles, environ 20–30 s ; les suivants prennent quelques secondes.
  - Un clic sur un enregistrement touché ouvre Lecture avec la même configuration : voies retirées grisées, voies corrompues tracées en couleur avec la panne.

### Démo en 3 minutes : Découverte

1. Ouvrir **Découverte** et lire le bandeau et le schéma, puis les quatre chiffres : AUC sur les crises connues, crises
   connues repérées sans étiquette, « décharges possibles », fausses alarmes du RF qui ressemblent à une décharge.
2. Filtre « décharge possible », tri « score combiné » : montrer le premier candidat, puis voter « Incertain » ou « Crise probable »
   (le résumé des avis se met à jour).
3. Filtre « fausses alarmes du RF » : montrer une fausse alarme étiquetée « décharge possible ».
4. Cliquer sa miniature : Lecture s’ouvre à cet endroit. Activer « courbe d’anomalie » : le score dépasse le seuil sur l’événement.

### Démo en 3 minutes : Électrodes

1. **Laboratoire → Électrodes**, puis « Lancer » sans rien changer : 80/82 et 25 fausses alarmes (le résultat intact).
2. Scénario « Électrode décollée en frontal » : comparer les chiffres en rouge et en vert. Cocher « variante robuste », puis « Lancer » : comparer.
3. Scénario « 3 électrodes perdues », puis « Référence moyenne ».
4. Cliquer l’enregistrement le plus touché : Lecture montre la voie corrompue en couleur.

## Notebook en local (VS Code)

- Ouvrir `EEG_Absence_Detection.ipynb` dans VS Code, puis choisir le noyau **Python (.venv DataMining EEG)**
  (ou l’interpréteur `.venv` du dossier) et lancer « Run All ».
- Hors Colab, le notebook lit les `.mat` et `Annotations MAJ.xlsx` dans `data/` et écrit ses sorties dans
  `resultats_local/` ; `resultats/` (résultats Colab, lus par l’application) n’est pas modifié.
  Pour changer : variables d’environnement `DM_DATA` et `DM_OUT`.
- Sur une autre machine, enregistrer le noyau une fois :
  `python -m ipykernel install --user --name datamining-eeg --display-name "Python (.venv DataMining EEG)"`
- Durée d’une exécution complète : environ 13 minutes la première fois (dont 6 pour la section « Analyses de recherche » et 1 pour la section « Âge, syndrome et morphologie »,
  qui garde ensuite ses calculs dans `resultats_local/cache_recherche/`).
