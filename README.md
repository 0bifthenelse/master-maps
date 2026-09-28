# Master Maps

[English](#english) | [Français](#français)

## English

Master Maps is a top-down WebGPU map of the entire Gers department in France. It helps users explore geographic features and inspect source-backed records across department 32. See [the architecture overview](docs/architecture.md) and [the coverage notes](docs/coverage.md).

The client uses Next.js 16, React 19, TypeScript, Three.js, and React Three Fiber. It requires WebGPU and has no WebGL fallback. The camera stays top-down, and the scene has no terrain relief. See [package.json](package.json), [the architecture overview](docs/architecture.md), and [the accuracy audit](docs/accuracy-audit.md).

### Demo image

![Gers overview with its outline, settlement labels, orange feature marks, search field, layer control, and source credits.](docs/media/gers-overview.png)

*Figure 1. Department overview of the Gers map in the browser.*

The capture shows the Gers outline, settlement labels, orange feature marks, search field, layer control, and source credits. It was taken after WebGPU initialized. At capture, the browser reported 225 loaded tiles and 1,582 draw calls on an AMD adapter with `gcn-5` architecture. See [the capture report](reports/wave4/W4_README.md) and [the screenshot](docs/media/gers-overview.png).

### Map controls

- Left-click a feature to select it and draw its silhouette highlight. See [CityScene.tsx](src/components/map/CityScene.tsx), [FeatureHighlightLayer.tsx](src/components/map/FeatureHighlightLayer.tsx), and [the interaction report](reports/wave3/W3_INTERACT.md).
- Right-click a feature to open its context menu. The menu can inspect or centre the feature and copy its coordinates, name, address, identifier, or road class and width. The native browser menu is suppressed while the feature menu is open. See [FeatureContextMenu.tsx](src/components/map/FeatureContextMenu.tsx) and [MapCamera.tsx](src/components/map/MapCamera.tsx).
- Use H, J, K, and L or the arrow keys to pan in world directions. Use plus and minus to zoom. Right-drag to rotate the map heading. See [MapControls.tsx](src/components/map/MapControls.tsx), [mapNavigation.ts](src/components/map/mapNavigation.ts), and [MapCamera.tsx](src/components/map/MapCamera.tsx).
- Use one finger to pan. Use two fingers to zoom and rotate. See [useControlOrbit.ts](src/components/map/useControlOrbit.ts).
- Wheel zoom is intended to stay under the cursor. Pixel-mode events are currently dropped. See the limitations below, [MapControls.tsx](src/components/map/MapControls.tsx), and [useControlOrbit.ts](src/components/map/useControlOrbit.ts).
- Press Escape to close the feature context menu. Use the close button to close the feature inspector. The current inspector has no Escape handler. See [FeatureContextMenu.tsx](src/components/map/FeatureContextMenu.tsx) and [FeatureInspector.tsx](src/components/map/FeatureInspector.tsx).
- Type in the search field without triggering map shortcuts. The field stops key events before they reach the map controls. See [MapHud.tsx](src/components/map/MapHud.tsx) and [mapNavigation.ts](src/components/map/mapNavigation.ts).

### Search and labels

Department-wide search uses [the canonical search index](data/search/index.json), which contains 427,293 entries by JSON array count. Selecting a result loads its target detail tile instead of loading every detailed tile. See [MapShell.tsx](src/components/map/MapShell.tsx), [the architecture overview](docs/architecture.md), and [the coverage report](data/qa/coverage-report.json).

The `Étiquettes` layer control toggles a canvas text atlas. Labels use screen-space collision avoidance and appear by feature class as the camera zooms. Thresholds are zoom 1 for settlements, 8 for transport, 14 for points of interest and businesses, 30 for street names, and 60 for addresses. See [LayerControls.tsx](src/components/map/LayerControls.tsx), [labels.ts](src/lib/scene/labels.ts), and [the label report](reports/wave3/W3_LABELS.md).

### Data sources

The map combines public geographic data with source references and field-level provenance. The source manifest records editions, licences, and acquisition details in [the source manifest](data/manifests/sources.json).

- IGN BD TOPO 3.5, edition 15 June 2026, under Licence Ouverte / Open Licence 2.0. Its GeoPackage lists 57 layers, including 4 support tables. The pipeline adopts 31 layers for rendering or search. See [the source manifest](data/manifests/sources.json), [the adopted layer list](scripts/data/bdtopoLayers.ts), and [the package inventory](reports/wave1/W1_T02_BDTOPO.md).
- IGN Admin Express COG provides the department boundary under Licence Ouverte / Open Licence 2.0. See [the source manifest](data/manifests/sources.json) and [data sources](docs/data-sources.md).
- Base Adresse Nationale supplies addresses under Etalab 2.0. See [the source manifest](data/manifests/sources.json).
- OpenStreetMap data comes through the Geofabrik Midi-Pyrenees extract and is processed with Osmium. It uses ODbL 1.0. See [data sources](docs/data-sources.md) and [the source manifest](data/manifests/sources.json).
- Etalab cadastre data serves as an independent parity source. The pipeline does not merge its records into canonical features. It uses Licence Ouverte / Open Licence 2.0. See [the source manifest](data/manifests/sources.json) and [the reconciliation report](reports/wave4/W4_RECONCILIATION.md).
- SIRENE data through recherche-entreprises supplies business identity under Licence Ouverte / Open Licence 2.0. See [the source manifest](data/manifests/sources.json).

Google Maps data is not an input. The pipeline does not crawl rendered OpenStreetMap tiles. It uses the Geofabrik extract for OSM data and the public OpenStreetMap view only as a visual comparison reference. See [data sources](docs/data-sources.md) and [data provenance](docs/data-provenance.md).

### Data pipeline and render format

The pipeline reads raw sources and normalizes each layer with bounded memory. It deduplicates records in a bounded stream and builds render tiles. A Web Worker decodes each tile. The client creates per-tile GPU resources for a demand-rendered scene. See [data refresh](docs/data-refresh.md), [the Wave 2 contracts](reports/wave2/CONTRACTS.md), and [the deduplication report](reports/wave4/W4_DEDUP_FIX.md).

Render tiles use MMT1, a versioned binary container with a JSON header and one contiguous payload slab. Per-feature ranges map geometry ranges to a flat metadata array. The worker transfers one `ArrayBuffer`. The main thread rebuilds typed-array views over that slab without copying it. The render-tile budget is 2 MiB. See [the Wave 2 contracts](reports/wave2/CONTRACTS.md) and [tile metrics](data/generated/tile-metrics.json).

### Dataset and delivery

The following per-kind counts come from [the coverage report](data/qa/coverage-report.json). The generated manifest omits the department boundary from its `featureCounts` object.

- Building: 330,091
- Road: 196,362
- Address: 116,538
- Place: 92,158
- Business: 84,599
- Water: 63,276
- Land use: 46,097
- Point of interest: 41,296
- Structure: 6,891
- Transport: 2,419
- Boundary: 1

The dataset contains 7,402 render tiles across three levels of detail. Counts and base sizes come from [tile metrics](data/generated/tile-metrics.json) and [the architecture overview](docs/architecture.md).

- LOD0: 5,386 tiles at 2,048 m
- LOD1: 1,747 tiles at 8,192 m
- LOD2: 269 tiles at 32,768 m

LOD0 payloads have a 424 KiB median, 903 KiB p95, and 1,023 KiB maximum. The dataset manifest is 815,130 bytes, or about 0.78 MiB. See [tile metrics](data/generated/tile-metrics.json) and [the coverage report](data/qa/coverage-report.json).

Each tile manifest entry stores its tile ID, level, bounds, feature count, and byte size. Full feature ID arrays reside in a separate index. See [the Wave 2 render-tile report](reports/wave2/W2_T13_RENDER_TILES.md) and [the Wave 2 contracts](reports/wave2/CONTRACTS.md).

### Runtime results and limitations

The stress report's quiet window measured 269 loaded tiles and 1,886 draw calls over 360 consecutive frames. Mean frame time was 16.63 ms, with p99 at 17.0 ms and implied throughput of 60.1 frames per second. The same report records uncaught WebGPU exceptions during LOD changes. See [the stress report](reports/wave4/W4_STRESS.md).

- The stress run did not cross the 12 km LOD0 threshold. It measured LOD1 and LOD2 crossings only. See [the stress report](reports/wave4/W4_STRESS.md).
- The stress run recorded 84 uncaught `setIndexBuffer` TypeErrors after LOD changes. The current cache defers geometry disposal by one timer task, but no clean post-change stress report confirms a fix. See [tileGpuCache.ts](src/lib/render/tileGpuCache.ts) and [the stress report](reports/wave4/W4_STRESS.md).
- Pixel-mode wheel events return early when `deltaMode` is zero. Standard mouse and trackpad zoom therefore remain unverified. See [MapControls.tsx](src/components/map/MapControls.tsx) and [the stress report](reports/wave4/W4_STRESS.md).
- Full-extent mixed-kind deduplication remains unresolved in the available evidence. [W4_DEDUP_FIX.md](reports/wave4/W4_DEDUP_FIX.md) reports subset evidence, but no full-store mixed-kind comparison. The file `reports/wave4/W4_DEDUP_FULL.md` is absent.
- IGN BD TOPO supplies canonical building geometry. The OSM parity report marks OSM building ways as adopted from another source. The building ratio is 1.32% (4,186 of 315,950). Land-use polygons have a 1.65% ratio (986 of 59,740). Natural land-cover areas have a 0.02% ratio (6 of 24,902). See [OSM parity](data/qa/osm-parity.json) and [data provenance](docs/data-provenance.md).
- Browser interaction evidence has limits. The stress harness opened the context menu in 0 of 5 cycles and dropped 65 of 72 pointer drags. Its report treats these paths as untested because the guarded pointer channel was unreliable. See [the stress report](reports/wave4/W4_STRESS.md).
- The guarded runtime did not synthesize a native button click for Enter in the mobile report. Enter activation of the layer panel and search results remains untested. That report did observe Space toggling one layer checkbox. See [the mobile and accessibility report](reports/wave4/W4_MOBILE_A11Y.md).
- The search index contains 427,293 array entries, while the coverage report records 427,292 input records. The capture report also records scene counters at zero despite visible geometry. See [the search index](data/search/index.json), [the coverage report](data/qa/coverage-report.json), and [the capture report](reports/wave4/W4_README.md).

### Run locally

The data volume must exist before the production build. Install dependencies, acquire or reuse source data, build the application, and start the server. A data refresh requires GDAL tools and Osmium. See [data refresh](docs/data-refresh.md), [data sources](docs/data-sources.md), and [package.json](package.json).

```bash
npm ci
npm run data:refresh
npm run build
npm run start
```

Use `npm run data:build` to build from cached raw inputs when they are available. See [data refresh](docs/data-refresh.md).

The following verification files exist, but none is wired into an npm script in [package.json](package.json):

- `scripts/chrome/verify-runtime.ts`
- `scripts/moli/verify-mobile.ts`
- `scripts/moli/verify-stress.ts`
- `scripts/data/qa-coverage-report.ts`
- `scripts/data/qa-stratified.ts`
- `scripts/data/reconcile-audit.ts`
- `scripts/data/parity-osm.ts`

`npm run verify:chrome` instead runs `scripts/chrome/run-verification.ts`. `npm run test:e2e` runs `scripts/moli/run-e2e.ts`.

### Further reading

- [Architecture](docs/architecture.md)
- [Coverage](docs/coverage.md)
- [Data sources](docs/data-sources.md)
- [Data provenance](docs/data-provenance.md)
- [Data refresh](docs/data-refresh.md)
- [Accuracy audit](docs/accuracy-audit.md)
- [Wave 1 reports](reports/wave1)
- [Wave 2 reports](reports/wave2)
- [Wave 3 reports](reports/wave3)
- [Wave 4 reports](reports/wave4)

## Français

Master Maps est une carte WebGPU en vue zénithale pour l'ensemble du Gers, département français 32. Elle permet d'explorer ses objets géographiques et d'inspecter les enregistrements avec leurs sources. Voir [l'architecture](docs/architecture.md) et [le dossier de couverture](docs/coverage.md).

Le client repose sur Next.js 16, React 19, TypeScript, Three.js et React Three Fiber. Il exige WebGPU et ne prévoit aucun repli vers WebGL. La caméra reste en vue de dessus et la scène n'affiche aucun relief. Voir [package.json](package.json), [l'architecture](docs/architecture.md) et [l'audit de précision](docs/accuracy-audit.md).

### Capture de démonstration

![Vue du Gers avec son contour, les noms des communes, des marques orange, la recherche, le panneau des couches et les crédits.](docs/media/gers-overview.png)

*Figure 1. Vue d'ensemble du Gers dans la carte affichée par le navigateur.*

La capture montre le contour du Gers, les noms de communes, des marques orange, la recherche, le panneau des couches et les crédits de sources. Elle a été prise après l'initialisation de WebGPU. Les diagnostics indiquaient 225 tuiles chargées et 1 582 appels de dessin sur un adaptateur AMD d'architecture `gcn-5`. Voir [le rapport de capture](reports/wave4/W4_README.md) et [la capture PNG](docs/media/gers-overview.png).

### Commandes de la carte

- Cliquez avec le bouton gauche sur un objet pour le sélectionner et tracer son contour de surbrillance. Voir [CityScene.tsx](src/components/map/CityScene.tsx), [FeatureHighlightLayer.tsx](src/components/map/FeatureHighlightLayer.tsx) et [le rapport sur les interactions](reports/wave3/W3_INTERACT.md).
- Cliquez avec le bouton droit sur un objet pour ouvrir son menu contextuel. Le menu permet d'inspecter ou de centrer l'objet. Il permet aussi de copier ses coordonnées, son nom, son adresse, son identifiant, ou la classe et la largeur d'une route. Le menu natif du navigateur est masqué tant que le menu de l'application reste ouvert. Voir [FeatureContextMenu.tsx](src/components/map/FeatureContextMenu.tsx) et [MapCamera.tsx](src/components/map/MapCamera.tsx).
- Utilisez H, J, K et L ou les flèches pour déplacer la carte selon les directions du monde. Utilisez plus et moins pour zoomer. Faites glisser le bouton droit pour tourner le cap de la carte. Voir [MapControls.tsx](src/components/map/MapControls.tsx), [mapNavigation.ts](src/components/map/mapNavigation.ts) et [MapCamera.tsx](src/components/map/MapCamera.tsx).
- Utilisez un doigt pour déplacer la carte. Utilisez deux doigts pour zoomer et tourner. Voir [useControlOrbit.ts](src/components/map/useControlOrbit.ts).
- Le zoom à la molette vise le pointeur. Le défaut qui écarte les événements en mode pixel figure dans les limites ci-dessous. Voir [MapControls.tsx](src/components/map/MapControls.tsx) et [useControlOrbit.ts](src/components/map/useControlOrbit.ts).
- Appuyez sur Échap pour fermer le menu contextuel. Le bouton de fermeture ferme l'inspecteur. Le code actuel ne relie pas Échap à l'inspecteur. Voir [FeatureContextMenu.tsx](src/components/map/FeatureContextMenu.tsx) et [FeatureInspector.tsx](src/components/map/FeatureInspector.tsx).
- Saisissez votre recherche sans déclencher les raccourcis de la carte. Le champ interrompt la propagation des touches avant les commandes de la carte. Voir [MapHud.tsx](src/components/map/MapHud.tsx) et [mapNavigation.ts](src/components/map/mapNavigation.ts).

### Recherche et étiquettes

La recherche couvre le département et utilise [l'index canonique](data/search/index.json), qui contient 427 293 entrées selon le nombre d'éléments du tableau JSON. Le choix d'un résultat charge sa tuile détaillée sans charger toutes les tuiles détaillées du département. Voir [MapShell.tsx](src/components/map/MapShell.tsx), [l'architecture](docs/architecture.md) et [le rapport de couverture](data/qa/coverage-report.json).

La commande de couche `Étiquettes` active ou masque un atlas de texte rendu sur canevas. Les collisions sont évitées dans l'espace écran. Les étiquettes apparaissent par famille selon le zoom. Les seuils par famille sont les suivants: communes à 1, transports à 8, lieux d'intérêt et entreprises à 14, rues à 30, adresses à 60. Voir [LayerControls.tsx](src/components/map/LayerControls.tsx), [labels.ts](src/lib/scene/labels.ts) et [le rapport sur les étiquettes](reports/wave3/W3_LABELS.md).

### Sources de données

La carte associe des données géographiques publiques à leurs sources et à la provenance des champs. Le manifeste indique les éditions, les licences et les informations d'acquisition dans [le manifeste des sources](data/manifests/sources.json).

- IGN BD TOPO 3.5, édition du 15 juin 2026, sous Licence Ouverte 2.0. Son GeoPackage répertorie 57 couches, dont 4 tables de support. Le pipeline en adopte 31 pour le rendu ou la recherche. Voir [le manifeste des sources](data/manifests/sources.json), [la liste des couches adoptées](scripts/data/bdtopoLayers.ts) et [l'inventaire du paquet](reports/wave1/W1_T02_BDTOPO.md).
- IGN Admin Express COG fournit la limite départementale sous Licence Ouverte 2.0. Voir [le manifeste des sources](data/manifests/sources.json) et [les sources de données](docs/data-sources.md).
- La Base Adresse Nationale fournit les adresses sous licence Etalab 2.0. Voir [le manifeste des sources](data/manifests/sources.json).
- Les données OpenStreetMap proviennent de l'extrait Geofabrik Midi-Pyrénées, traité avec Osmium. Elles suivent l'ODbL 1.0. Voir [les sources de données](docs/data-sources.md) et [le manifeste des sources](data/manifests/sources.json).
- Le cadastre Etalab sert de référence indépendante pour la parité. Le pipeline ne fusionne pas ses objets avec les données canoniques. La licence est Ouverte 2.0. Voir [le manifeste des sources](data/manifests/sources.json) et [le rapport de réconciliation](reports/wave4/W4_RECONCILIATION.md).
- SIRENE, via recherche-entreprises, fournit l'identité des entreprises sous Licence Ouverte 2.0. Voir [le manifeste des sources](data/manifests/sources.json).

Les données de Google Maps ne sont pas utilisées. Le pipeline ne collecte pas les tuiles rendues d'OpenStreetMap. Il utilise l'extrait Geofabrik comme source OSM et la carte publique OpenStreetMap uniquement comme référence visuelle. Voir [les sources](docs/data-sources.md) et [la provenance des données](docs/data-provenance.md).

### Chaîne de données et format de rendu

Le pipeline lit les sources brutes et normalise chaque couche avec une mémoire bornée. Il déduplique les objets dans un flux borné et construit les tuiles de rendu. Un Web Worker décode chaque tuile. Le client crée les ressources GPU par tuile pour une scène rendue à la demande. Voir [l'actualisation des données](docs/data-refresh.md), [les contrats de la vague 2](reports/wave2/CONTRACTS.md) et [le rapport sur la déduplication](reports/wave4/W4_DEDUP_FIX.md).

Les tuiles de rendu utilisent MMT1, un conteneur binaire versionné avec un en-tête JSON et une seule zone contiguë de données. Les plages de chaque objet relient la géométrie à un tableau plat de métadonnées. Le worker transfère un seul `ArrayBuffer`. Le fil principal reconstruit des vues typées sur cette zone sans la copier. Le budget d'une tuile est de 2 Mio. Voir [les contrats de la vague 2](reports/wave2/CONTRACTS.md) et [les métriques des tuiles](data/generated/tile-metrics.json).

### Jeu de données et livraison

Les comptes par type ci-dessous proviennent du [rapport de couverture](data/qa/coverage-report.json). Le manifeste généré omet la limite départementale de son objet `featureCounts`.

- Bâtiment: 330 091
- Route: 196 362
- Adresse: 116 538
- Lieu: 92 158
- Entreprise: 84 599
- Eau: 63 276
- Occupation du sol: 46 097
- Lieu d'intérêt: 41 296
- Structure: 6 891
- Transport: 2 419
- Limite: 1

Le jeu de données contient 7 402 tuiles de rendu réparties sur trois niveaux de détail. Les comptes et les dimensions de base viennent des [métriques des tuiles](data/generated/tile-metrics.json) et de [l'architecture](docs/architecture.md).

- LOD0: 5 386 tuiles de 2 048 m
- LOD1: 1 747 tuiles de 8 192 m
- LOD2: 269 tuiles de 32 768 m

Les tuiles LOD0 ont une taille médiane de 424 Kio, un p95 de 903 Kio et un maximum de 1 023 Kio. Le manifeste du jeu de données pèse 815 130 octets, soit environ 0,78 Mio. Voir [les métriques des tuiles](data/generated/tile-metrics.json) et [le rapport de couverture](data/qa/coverage-report.json).

Chaque entrée du manifeste des tuiles contient son identifiant, son niveau, ses limites, son compte d'objets et sa taille. Un index distinct conserve les identifiants complets des objets. Voir [le rapport de rendu de la vague 2](reports/wave2/W2_T13_RENDER_TILES.md) et [les contrats de la vague 2](reports/wave2/CONTRACTS.md).

### Résultats et limites

La fenêtre calme du rapport de stress mesure 269 tuiles chargées et 1 886 appels de dessin pendant 360 images consécutives. Le temps moyen est de 16,63 ms, avec un p99 de 17,0 ms et un débit implicite de 60,1 images par seconde. Le même rapport signale des exceptions WebGPU non interceptées pendant les transitions de niveau. Voir [le rapport de stress](reports/wave4/W4_STRESS.md).

- Le test de stress n'a pas franchi le seuil LOD0 de 12 km. Il ne mesure que les transitions entre LOD1 et LOD2. Voir [le rapport de stress](reports/wave4/W4_STRESS.md).
- Le test de stress a relevé 84 erreurs `TypeError` non interceptées sur `setIndexBuffer` après des changements de niveau. Le cache actuel diffère la libération de la géométrie d'une tâche, mais aucun rapport ne confirme encore une exécution de stress sans erreur. Voir [tileGpuCache.ts](src/lib/render/tileGpuCache.ts) et [le rapport de stress](reports/wave4/W4_STRESS.md).
- Les événements de molette en mode pixel sont ignorés lorsque `deltaMode` vaut zéro. Le zoom avec une souris ordinaire ou un pavé tactile reste donc à vérifier. Voir [MapControls.tsx](src/components/map/MapControls.tsx) et [le rapport de stress](reports/wave4/W4_STRESS.md).
- Les preuves disponibles ne résolvent pas le risque de perte d'objets par déduplication mixte à l'échelle du département. [W4_DEDUP_FIX.md](reports/wave4/W4_DEDUP_FIX.md) présente des résultats sur des sous-ensembles, mais pas de comparaison mixte sur tout le jeu. Le fichier `reports/wave4/W4_DEDUP_FULL.md` est absent.
- IGN BD TOPO fait autorité pour la géométrie des bâtiments canoniques. Le rapport classe les bâtiments OSM comme repris d'une autre source. Le ratio des bâtiments est de 1,32 % (4 186 sur 315 950). Le ratio des polygones d'occupation du sol est de 1,65 % (986 sur 59 740). Celui des surfaces naturelles est de 0,02 % (6 sur 24 902). Voir [la parité OSM](data/qa/osm-parity.json) et [la provenance des données](docs/data-provenance.md).
- Les preuves d'interaction dans le navigateur gardé ont des limites. Le test de stress a ouvert le menu contextuel dans 0 cycle sur 5 et a perdu 65 glissements sur 72. Le rapport classe ces chemins comme non testés, car le canal de pointage était peu fiable. Voir [le rapport de stress](reports/wave4/W4_STRESS.md).
- Le rapport mobile montre que le runtime ne produit pas le clic natif attendu avec Entrée. L'activation par Entrée du panneau de couches et des résultats de recherche reste non vérifiée. Ce rapport montre que la barre d'espace a basculé une case de couche. Voir [le rapport mobile et accessibilité](reports/wave4/W4_MOBILE_A11Y.md).
- L'index de recherche contient 427 293 entrées de tableau, tandis que le rapport de couverture en compte 427 292. Le rapport de capture signale aussi des compteurs de scène à zéro malgré une géométrie visible. Voir [l'index de recherche](data/search/index.json), [le rapport de couverture](data/qa/coverage-report.json) et [le rapport de capture](reports/wave4/W4_README.md).

### Lancement local

Le volume de données doit être présent avant la compilation de production. Installez les dépendances, acquérez ou réutilisez les sources, construisez l'application, puis démarrez le serveur. L'actualisation des données exige les outils GDAL et Osmium. Voir [l'actualisation des données](docs/data-refresh.md), [les sources de données](docs/data-sources.md) et [package.json](package.json).

```bash
npm ci
npm run data:refresh
npm run build
npm run start
```

Utilisez `npm run data:build` pour construire à partir des sources brutes en cache lorsqu'elles sont disponibles. Voir [l'actualisation des données](docs/data-refresh.md).

Les fichiers de vérification suivants existent, mais aucun n'est appelé par un script npm dans [package.json](package.json):

- `scripts/chrome/verify-runtime.ts`
- `scripts/moli/verify-mobile.ts`
- `scripts/moli/verify-stress.ts`
- `scripts/data/qa-coverage-report.ts`
- `scripts/data/qa-stratified.ts`
- `scripts/data/reconcile-audit.ts`
- `scripts/data/parity-osm.ts`

`npm run verify:chrome` appelle plutôt `scripts/chrome/run-verification.ts`. `npm run test:e2e` appelle `scripts/moli/run-e2e.ts`.

### Pour aller plus loin

- [Architecture](docs/architecture.md)
- [Couverture](docs/coverage.md)
- [Sources de données](docs/data-sources.md)
- [Provenance des données](docs/data-provenance.md)
- [Actualisation des données](docs/data-refresh.md)
- [Audit de précision](docs/accuracy-audit.md)
- [Rapports de la vague 1](reports/wave1)
- [Rapports de la vague 2](reports/wave2)
- [Rapports de la vague 3](reports/wave3)
- [Rapports de la vague 4](reports/wave4)
