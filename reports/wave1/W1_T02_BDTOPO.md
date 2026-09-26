# W1-T02 — IGN BD TOPO D032 inventory & current adoption state

Agent: wave1-2 · Wave 1 (investigation only) · no tracked file modified.

## 0. Source package (VERIFIED)

| Item | Value | Evidence |
|---|---|---|
| GeoPackage | `data/raw/bdtopo/BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_2026-06-15/BDTOPO/1_DONNEES_LIVRAISON_2026-06-00418/BDT_3-5_GPKG_LAMB93_D032_ED2026-06-15/BDT_3-5_GPKG_LAMB93_D032-ED2026-06-15.gpkg` | `ls -la` (1 583 919 104 B) |
| Edition | **2026-06-15** | directory name `..._ED2026-06-15`, `metadonnees_lot.titre_ressource = "BDTOPO_3-5 traitement du 2026-06-25"`, `data/intermediate/bdtopo-manifest.json:edition` |
| Product | BD TOPO **3.5** (GPKG), IGN-F, licence Ouverte / Open Licence 2.0 | `metadonnees_lot.id_ressource = IGNF_BDTOPO_3-5_GPKG_LAMB93_D032-ED2026-06-15` |
| CRS | EPSG:2154 (RGF93 v1 Lambert 93) for every spatial layer | `metadonnees_lot.systeme_ref_code`, `gpkg_contents.srs_id = 2154` for all 53 spatial layers |
| Metadata date | `info_metadonnees.date_metadonnees = 2026-06-25`; per-layer `last_change` 2026/06/25 09:45→09:52 | `ogrinfo -sql` on `info_metadonnees` / `gpkg_contents` |
| Themes (9) | ADRESSES (2026-06-11), TRANSPORT (2025-08-18→2026-05-21), ADMINISTRATIF (2026-01-01), HYDROGRAPHIE (2025-06-09), BATI (2025-06-09), SERVICES_ET_ACTIVITES (2010-11-10→2024-12-18), LIEUX_NOMMES (non renseigné), ZONES_REGLEMENTEES (non renseigné), OCCUPATION_DU_SOL (2011-08-01) | `ogrinfo <gpkg> metadonnees_theme` (9 rows) |
| Geoidal extent declared | `westBoundLongitude=-0.3442, eastBoundLongitude=1.2649, southBoundLatitude=43.2661, northBoundLatitude=44.1248` | `metadonnees_lot.etendue_geographique` |
| Overall feature total (Gers envelope) | **2 245 241** spatial records across 53 layers (+71 metadata/style rows) | computed, see §2 |
| Layer count reported by fetch script | 57 (`ogrinfo -ro -q` line count) | `scripts/data/fetch-bdtopo.ts:282`, manifest `package.layers: 57` |

Note: the fetch script counts 57 because it parses numbered listing lines (includes 4 aspatial tables: `info_metadonnees`, `metadonnees_lot`, `metadonnees_theme`, `layer_styles`); the real layer list is 57 entries = 53 spatial + 4 aspatial. Verified count: 57 listing lines.

## 1. Commands used

```
G=data/raw/bdtopo/BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_2026-06-15/BDTOPO/1_DONNEES_LIVRAISON_2026-06-00418/BDT_3-5_GPKG_LAMB93_D032_ED2026-06-15/BDT_3-5_GPKG_LAMB93_D032-ED2026-06-15.gpkg
ogrinfo -ro -q "$G"                                     # layer list
ogrinfo -ro -so -al "$G"                                # geometry + FC + full field schema (~6 min)
ogrinfo -ro -so -al -spat 435144.5 6248685.9 554835.0 6334164.0 "$G"   # in-Gers-envelope FC per layer
ogrinfo -ro -q "$G" -dialect SQLITE -sql "SELECT nature, COUNT(*) ... GROUP BY nature"
```

Gers Lambert-93 envelope used = the one recorded in `data/intermediate/bdtopo-manifest.json:clipping.sourceBoundsLambert93`
`[435144.4999131731, 6248685.900145752, 554835.000112572, 6334163.999727008]`
→ **`InGers` counts below are envelope-based (superset of the true Gers polygon); exact polygon clipping happens in `normalizeBdtopo`.**

GDAL 3.13.1 "Iowa City". No GEOS → `-clipsrc` unavailable, and `geom.MINX`/rtree spatial SQL not usable (verified: `no such column: geom.MINX`, `no such table: rtree_<layer>_geom`; this GPKG has no RTree extension).

## 2. Complete layer inventory (all 57 layers; real names from ogrinfo)

Columns: name | geometry | feature count (all) | in Gers envelope | n fields | decision | reason

### 2.1 TRANSPORT

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `troncon_de_route` | 3D LineString | 178 806 | 166 839 | 86 | **ADOPT-RENDER** (already) | roads, all 9 nature classes; class mapping exists |
| `troncon_de_voie_ferree` | 3D LineString | 308 | 303 | 21 | **ADOPT-RENDER** | rail network incl. LGV; distinct styling |
| `equipement_de_transport` | 3D MultiPolygon | 656 | 578 | 24 | **ADOPT-RENDER** | 313 vehicle services, 276 parkings, 41 roundabouts, stations, péage, port, aérogar |
| `piste_d_aerodrome` | 3D MultiPolygon | 27 | 27 | 14 | **ADOPT-RENDER** | runways/taxiways (14 herbe, 13 dur) |
| `aerodrome` | MultiPolygon | 14 | 14 | 19 | **ADOPT-RENDER** | aerodrome boundary, has `code_icao`/`code_iata`/`altitude` |
| `route_numerotee_ou_nommee` | MultiLineString | 732 | 690 | 12 | **ADOPT-SEARCH-ONLY** | administrative route object, no geometry value over the road layer |
| `itineraire_autre` | MultiLineString | 366 | 346 | 13 | **ADOPT-SEARCH-ONLY** | GR/GR + PR itineraries; searchable, no extra render |
| `voie_ferree_nommee` | MultiLineString | 1 | 1 | 9 | **ADOPT-SEARCH-ONLY** | single named rail line (metadata link target) |
| `point_de_repere` | Point | 8 594 | 8 068 | 19 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | highway PR markers, ~8 k clutter; searchable by `libelle`/`cote` |
| `section_de_points_de_repere` | LineString | 1 317 | 1 224 | 11 | **EXCLUDE** | PR sections, administrative |
| `non_communication` | Point | 31 | 31 | 7 | **EXCLUDE** | physical road-block markers, not renderable |
| `point_du_reseau` | 3D Point | 1 010 | 882 | 20 | **ADOPT-SEARCH-ONLY** | network infrastructure points; good search/label source |

### 2.2 BATI

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `batiment` | 3D MultiPolygon | 441 718 | 397 881 | 28 | **ADOPT-RENDER** (already) | footprints with `hauteur`, `nombre_d_etages`, `nature` |
| `cimetiere` | 3D MultiPolygon | 966 | 933 | 17 | **ADOPT-RENDER** | cemetery areas (964 Civil), valuable landuse mask |
| `construction_surfacique` | 3D MultiPolygon | 96 | 88 | 17 | **ADOPT-RENDER** | 70 Pont, 16 Ecluse, 10 Barrage — decks of works, needed with `construction_lineaire` |
| `construction_lineaire` | 3D LineString | 9 027 | 8 666 | 17 | **ADOPT-RENDER** | 4 639 Pont, 2 692 Ruines, 1 345 Barrage, 152 Mur de soutènement, 104 Mur, 48 Quai, 11 Tunnel, 11 Clôture … |
| `construction_ponctuelle` | 3D Point | 4 674 | 4 497 | 18 | **ADOPT-SEARCH-ONLY** | 2 726 Croix, 981 Clocher, 483 Transformateur, 406 Antenne, 43 autre construction élevée, 12 Cheminée, 11 Calvaire, 9 puits, 3 torchère — label/POI layer, not geometry |
| `reservoir` | 3D MultiPolygon | 660 | 610 | 20 | **ADOPT-RENDER** | 269 Réservoir d'eau au sol, 214 Château d'eau, 177 Réservoir industriel; has `hauteur`/`volume` |
| `terrain_de_sport` | 3D MultiPolygon | 1 262 | 1 168 | 14 | **ADOPT-RENDER** | 488 tennis, 261 grand terrain, 247 multi-sports, 164 carrière équestre, 57 piscine, 45 piste de sport |
| `pylone` | 3D Point | 2 131 | 1 970 | 14 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | 2 k pylons = pure clutter at every zoom; no user-facing value |
| `ligne_electrique` | 3D LineString | 121 | 111 | 15 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | power lines, only meaningful at very high zoom |
| `poste_de_transformation` | 3D MultiPolygon | 29 | 26 | 15 | **ADOPT-SEARCH-ONLY** | 26 substations, no `nature` field |

### 2.3 HYDROGRAPHIE

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `troncon_hydrographique` | 3D LineString | 51 987 | 50 275 | 44 | **ADOPT-RENDER** (already) | watercourses, `classe_de_largeur`, `persistance`, `fictif` |
| `surface_hydrographique` | 3D MultiPolygon | 14 157 | 13 598 | 29 | **ADOPT-RENDER** (already) | lakes/ponds |
| `plan_d_eau` | MultiPolygon | 532 | 511 | 22 | **ADOPT-SEARCH-ONLY** | 399 Retenue, 88 Retenue-barrage, 21 Réservoir-bassin, 16 gravière, 5 Lac, 2 orage, 1 Mare; named + `altitude_moyenne` — search/label, polygon is the `surface_hydrographique` geometry |
| `cours_d_eau` | MultiLineString | 4 068 | 3 909 | 15 | **ADOPT-SEARCH-ONLY** | named watercourse objects, geometry is aggregated axis |
| `detail_hydrographique` | Point | 3 687 | 3 643 | 19 | **ADOPT-SEARCH-ONLY** | 2 240 Source, 661 Point d'eau, 274 Citerne, 205 Fontaine, 198 Lavoir, 103 Source captée — excellent POI source |
| `canalisation` | 3D LineString | 27 | 27 | 14 | **ADOPT-RENDER** (minor) | covered waterways/canalisation, should be drawn over hydro lines |
| `bassin_versant_topographique` | MultiPolygon | 183 | 173 | 20 | **ADOPT-SEARCH-ONLY** | watershed polygons, cartographic noise for a city map |
| `noeud_hydrographique` | 3D Point | 50 940 | 49 224 | 22 | **EXCLUDE** | topological nodes, no independent semantic value |

### 2.4 ADMINISTRATIF

Already served by IGN ADMIN EXPRESS COG (separate source), so BD TOPO admin is redundant except as search/label enrichment.

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `commune` | MultiPolygon | 726 | 693 | 26 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | Admin Express already authoritative; `code_insee`, `population`, `code_postal`, `nom_officiel` useful for search |
| `departement` | MultiPolygon | 7 | 7 | 10 | **EXCLUDE** | department outline, 7 sub-parts; Admin Express used |
| `region` | MultiPolygon | 2 | 2 | 9 | **EXCLUDE** | out of scope |
| `arrondissement` | MultiPolygon | 12 | 12 | 11 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | already used (`AUCH_DETAIL_SCOPE`); no render gain |
| `canton` | MultiPolygon | 35 | 33 | 12 | **EXCLUDE** | obsolete (redrawn 2015-2026), no render value |
| `epci` | MultiPolygon | 35 | 33 | 11 | **ADOPT-SEARCH-ONLY** | intercommunalities, search only |
| `collectivite_territoriale` | MultiPolygon | 7 | 7 | 10 | **ADOPT-SEARCH-ONLY** | 7 CT, search only |
| `commune_associee_ou_deleguee` | MultiPolygon | 13 | 13 | 14 | **ADOPT-SEARCH-ONLY** | delegated communes |

### 2.5 LIEUX_NOMMES (toponymy)

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `zone_d_habitation` | MultiPolygon | 37 440 | 36 138 | 20 | **ADOPT-RENDER** | settlement polygons with `toponyme` + `importance`; the base for place labels and the "village" fill |
| `lieu_dit_non_habite` | Point | 3 911 | 3 722 | 16 | **ADOPT-SEARCH-ONLY** (label source) | 3 709 at `importance=5`; label by zoom, searchable |
| `detail_orographique` | Point | 315 | 271 | 17 | **ADOPT-SEARCH-ONLY** | 99 Sommet, 96 Versant, 39 Vallée, 25 Plaine, 23 Crête, 18 Gouffre, 12 Grotte — place-name search |
| `toponymie` | Point | 56 023 | 54 043 | 9 | **ADOPT-SEARCH-ONLY** | generic toponymy table keyed by `cleabs_de_l_objet` + `classe_de_l_objet`; the umbrella name index |
| `erp` | Point | 8 004 | 7 764 | 34 | **ADOPT-RENDER** (as POI) / ADOPT-SEARCH-ONLY | 5 835 cat.5 (culture), 769 cat.4, 364 cat.3; has `libelle`, `activite_principale`, `public`, `ouvert`, `adresse_nom_1`, `code_postal`, `liens_vers_batiment` — richest POI source in BD TOPO |
| `foret_publique` | MultiPolygon | 104 | 93 | 13 | **ADOPT-SEARCH-ONLY** | 93 public forests |

### 2.6 OCCUPATION_DU_SOL

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `zone_de_vegetation` | MultiPolygon | 269 313 | 259 207 | 10 | **ADOPT-RENDER** (or vector-tile texture) | 127 393 Haie, 103 242 Bois, 22 531 Forêt fermée de feuillus, 6 730 Vigne, 2 240 Lande, 1 773 Peupleraie, 1 759 Forêt ouverte, 1 408 mixte, 1 355 conifères, 882 Verger — 259 k polygons, far too many for 20 000-record JSON chunks; needs LOD/threshold policy (keep Bois+Forêt+Haie, drop tiny) |
| `haie` | LineString | 413 239 | 413 239 | 11 | **ADOPT-RENDER** (high-LOD only) | 413 k linear hedges, duplicates `zone_de_vegetation.nature='Haie'`; must not ship at every LOD |
| `parc_ou_reserve` | MultiPolygon | 26 | 22 | 15 | **ADOPT-RENDER** | 14 Natura 2000, 10 CEN, 2 protection orders — regulatory overlay, always wanted |

### 2.7 SERVICES_ET_ACTIVITES

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `zone_d_activite_ou_d_interet` | MultiPolygon | 5 308 | 5 040 | 23 | **ADOPT-RENDER** | 9 `categorie` values; 1 022 Culte chrétien, 663 Mairie, 326 Espace public, 301 Enseignement primaire, 257 Monument, 252 Station d'épuration, 240 Construction, 231 Station de pompage, 132 Aire de détente, 106 Stade, 79 Zone industrielle, 63 Camping, 60 Caserne de pompiers, 45 Musée, 40 Office de tourisme, 39 Centrale électrique … → landuse fill + label + POI |

### 2.8 ADRESSES

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `adresse_ban` | Point | 193 942 | 177 951 | 20 | **EXCLUDE** (render) / ADOPT-SEARCH-ONLY | duplicates the standalone BAN CSV source (already adopted, 115 379 features in coverage.json); use only to fill BAN gaps |
| `lien_adresse_vers_bdtopo` | LineString | 179 961 | 164 082 | 15 | **EXCLUDE** | address-to-support linkage geometry (parcel stub), no render value |
| `batiment_rnb_lien_bdtopo` | Point | 418 998 | 382 528 | 6 | **ADOPT-SEARCH-ONLY** (join only) | `identifiants_rnb` ↔ `batiment.identifiants_rnb`; the only way to attach RNB building IDs |

### 2.9 ZONES_REGLEMENTEES

| layer | geom | count | inGers | fields | decision | reason |
|---|---|---|---|---|---|---|
| `parc_ou_reserve` | (see 2.6) | 26 | 22 | 15 | ADOPT-RENDER | only regulated-zone layer present in this package |

### 2.10 Aspatial / support tables (never rendered)

| layer | rows | purpose |
|---|---|---|
| `info_metadonnees` | 1 | producer, date, language, charset |
| `metadonnees_lot` | 1 | INSPIRE lot metadata (edition, licence, CRS, extent) |
| `metadonnees_theme` | 9 | per-theme freshness |
| `layer_styles` | 60 | QML/SLD styles, not used by the pipeline |

## 3. Value distributions for the adopted/classification fields (VERIFIED, department-wide)

### 3.1 `troncon_de_route.nature` (178 806)

| value | count | current `roadClass()` result |
|---|---|---|
| Route à 1 chaussée | 108 868 | secondary |
| Chemin | 34 967 | track |
| Route empierrée | 26 838 | track |
| Sentier | 5 327 | path |
| Rond-point | 1 731 | tertiary |
| Route à 2 chaussées | 498 | trunk |
| Type autoroutier | 303 | motorway |
| Escalier | 182 | path |
| Bretelle | 92 | secondary |


Gap: 64 % of the network is "Route à 1 chaussée" collapsed into one bucket, while `importance` (below) carries the real hierarchy. The mapping ignores `nombre_de_voies` and `largeur_de_chaussee` entirely.

### 3.2 `troncon_de_route.importance` (1…6)

`5: 132 897 · 4: 22 166 · 3: 12 033 · 6: 6 222 · 2: 5 377 · 1: 111` — 100 % populated. This is the field that should drive road styling; it is currently stored only in `sourceMetadata.importance` (`normalizeBdtopo.ts:373`) and never used for class or width.

### 3.3 `troncon_de_route.position_par_rapport_au_sol`

`0: 174 122 · 1: 4 590 · "Gué ou radier": 84 · -1: 10`

Bug in current code: `normalizeBdtopo.ts:353-355` maps bridge=`"1"`, tunnel=`"-1"`, and the 84 fords fall through to `stratum: "normal"` with no representation. `isClipFailure`/layer naming OK otherwise.

### 3.4 `troncon_de_route.fictif` / `etat_de_l_objet` / `largeur_de_chaussee`

* `fictif`: empty 178 781, `1`: 25 (25 fictitious road segments currently rendered as real).
* `etat_de_l_objet`: En service 178 792, En construction 10, En projet 4.
* `largeur_de_chaussee`: NULL 65 046 (36 %), positive 113 071, zero 689. `numeric()` at `normalizeBdtopo.ts:50-52` requires `value > 0`, so the 689 zeros become `widthInferred`; NULLs likewise. `widthSource: "inferred_default"` therefore applies to 65 735 segments (37 %).
* `cleabs` null/empty: **0** (identity is safe). `nature` null/empty: **0**.

### 3.5 `batiment.nature` (441 718)

Indifférenciée 395 229 (89 %) · Industriel, agricole ou commercial 40 707 · Silo 1 621 · Serre 1 225 · Eglise 1 104 · Château 678 · Tour/donjon 660 · Chapelle 256 · Tribune 148 · Arène ou théâtre antique 53 · Moulin à vent 37.

`nombre_d_etages`: NULL 282 529 (64 %) · 1: 106 371 · 2: 47 866 · 3: 3 049 · 0: 1 222 · 4: 508 · 5: 120 · 6: 23.
`hauteur`: positive 434 480 · NULL 7 033 · **0: 205** (dropped by `numeric()`'s `> 0` test, `normalizeBdtopo.ts:50`).
`etat_de_l_objet`: En service 441 203 · En ruine 342 · En construction 166 · En projet 7.
Additional unused discriminators: `usage_1`/`usage_2`, `construction_legere`, `nombre_de_logements`, `materiaux_des_murs`, `materiaux_de_la_toiture`, `altitude_maximale_toit`, `origine_du_batiment`, `identifiants_rnb`.

### 3.6 `troncon_hydrographique.nature` (51 987)

Écoulement naturel 46 373 · Retenue 3 638 · Canal 831 · Retenue-barrage 567 · Conduit buse 473 · Réservoir-bassin 35 · Inconnue 22 · Mare 21 · Aqueduc 13 · Lac 7 · Écoulement canalisé 5 · Réservoir-bassin d'orage 2.

`classe_de_largeur`: "Entre 0 et 5 m" 41 502 · Sans objet 4 244 · "Entre 5 et 15 m" 3 487 · "Entre 15 et 50 m" 1 344 · En attente de mise à jour 1 169 · "Plus de 50 m" 241.
`persistance`: Intermittent 35 939 (69 %) · Permanent 16 042 · Inconnue 5 · Sec 1.
`fictif`: empty 41 697 · `1` 10 290.
Currently `WaterFeature.width` is hard-coded `undefined` and `widthInferred = layer === "water-line"` (`normalizeBdtopo.ts:389-390`) — so `classe_de_largeur` and `persistance`/`intermittent` (schema has `intermittent`, `src/lib/data/schema.ts:227`) are never set despite being present on 52 k records.

### 3.7 `surface_hydrographique.nature` (14 157)

Retenue 8 052 · Mare 3 209 · Réservoir-bassin 1 510 · Écoulement naturel 1 012 · Réservoir-bassin d'orage 167 · Retenue-barrage 131 · Plan d'eau de gravière 38 · Réservoir-bassin piscicole 30 · Lac 5 · Marais 3.
`position_par_rapport_au_sol`: `0` 14 156 · `-1` 1.

### 3.8 `troncon_de_voie_ferree` (308)

`nature`: Sans objet 222 · Voie ferrée principale 81 · Voie de service 3 · LGV 2.
`usage`: Sans objet 196 · Voyageur 69 · NULL 36 · Vélo-rail 7.
Unused: `electrifie`, `largeur`, `nombre_de_voies`, `vitesse_maximale`, `cpx_toponyme`, `liens_vers_voie_ferree_nommee`.

### 3.9 `equipement_de_transport.nature` (656)

Service dédié aux véhicules 313 · Parking 276 · Carrefour 41 · Aire de repos ou de service 5 · Péage 4 · Port 4 · Arrêt voyageurs 4 · Aire de triage 3 · Gare routière 2 · Tour de contrôle aérien 1 · Gare voyageurs uniquement 1 · Gare voyageurs et fret 1 · Aérogare 1. (`categorie` column is empty on all 656 rows.)

### 3.10 `zone_d_activite_ou_d_interet` (5 308)

`categorie`: Culture et loisirs 1 481 · Religieux 1 030 · Administratif ou militaire 995 · Gestion des eaux 499 · Science et enseignement 433 · Industriel et commercial 410 · Sport 371 · Santé 89.
`importance`: 5: 3 676 · 3: 1 167 · 4: 233 · 6: 192 · 2: 35 · 1: 3 · NULL 2.
Top `nature`: Culte chrétien 1 022 · Mairie 663 · Espace public 326 · Enseignement primaire 301 · Monument 257 · Station d'épuration 252 · Construction 240 · Station de pompage 231 · Aire de détente 132 · Divers industriel 129 · Poste 109 · Stade 106 · Zone industrielle 79 · Camping 63 · Caserne de pompiers 60 · Musée 45 · Office de tourisme 40 · Gendarmerie 40 · Centrale électrique 39 (85 distinct `nature` values total).

### 3.11 `erp` (8 004)

`categorie`: 5 → 5 835 · NULL 847 · 4 → 769 · 3 → 364 · 2 → 119 · 1 → 70.
`type_principal`: M 2 066 · NULL 1 110 · W 1 051 · L 961 · V 636 · R 516 · N 445 · U 345 · PA 186 · X 158 · O 128 · T 124 · J 116 · RH 39 · S 36 · Y 32 · P 21 · … plus one literal `ERREUR` (data-quality defect, 1 record).

### 3.12 `zone_d_habitation.importance` (37 440)

4 → 15 075 · 5 → 10 497 · 6 → 8 878 · 3 → 2 185 · 2 → 745 · 1 → 60. (`importance` 1-6, usable as label priority.)

### 3.13 `lieu_dit_non_habite.importance` (3 911)

5 → 3 709 (95 %) · 4 → 162 · 6 → 34 · 3 → 5 · 2 → 1.

### 3.14 `toponymie.classe_de_l_objet` (56 023)

Zone d'habitation 45 452 · Lieu-dit non habité 4 055 · Zone d'activité ou d'intérêt 3 074 · Cours d'eau 2 037 · Itinéraire autre 340 · Détail orographique 315 · Détail hydrographique 146 · Point du réseau 142 · Équipement de transport 110 · Plan d'eau 102 · Forêt publique 95 · Construction linéaire 46 · Route 33 · Construction ponctuelle 27 · Parc ou réserve 20 · Construction surfacique 13 · Aérodrome 9 · Cimetière 5 · Voie ferrée 1 · Poste de transformation 1.
This is the ready-made name index: `graphie_du_toponyme` + `classe_de_l_objet` + `cleabs_de_l_objet` for every named object.

### 3.15 `voie_nommee` (22 601)

`type_voie`: chemin 7 380 · route 4 651 · rue 3 906 · impasse 2 684 · NULL 1 388 · place 791 · avenue 356 · allée 280 · lotissement 195 · voie communale 122 · boulevard 112 · côte 103 · … (~110 distinct values, includes artifacts such as `vieux chemin`, `city`…).
Carries `liens_vers_supports` = `/`-separated list of `TRONROUT...` cleabs (verified on a sample: 20 linked road sections for `Route de Plaisance`). Also `identifiant_voie_ban`, `nom_normalise`, `insee_commune`, `nom_commune`, `id_ban_odonyme` → this is the missing road-name link that the current pipeline fakes by reading `nom_voie_ban_gauche/droite`.

### 3.16 Other distributions

* `terrain_de_sport.nature`: Tennis 488 · Grand terrain 261 · Petit multi-sports 247 · Carrière équestre 164 · Bassin natation 57 · Piste de sport 45.
* `piste_d_aerodrome.nature`: Piste en herbe 14 · Piste en dur 13.
* `zone_de_vegetation.nature`: Haie 127 393 · Bois 103 242 · Forêt fermée feuillus 22 531 · Vigne 6 730 · Lande ligneuse 2 240 · Peupleraie 1 773 · Forêt ouverte 1 759 · Forêt fermée mixte 1 408 · Forêt fermée conifères 1 355 · Verger 882.
* `cimetiere.nature`: Civil 964 · Militaire 1 · Militaire étranger 1.
* `reservoir.nature`: Réservoir d'eau ou château d'eau au sol 269 · Château d'eau 214 · Réservoir industriel 177.
* `construction_lineaire.nature`: Pont 4 639 · Ruines 2 692 · Barrage 1 345 · Mur de soutènement 152 · Mur 104 · Quai 48 · Fronton de pelote basque 13 · Tunnel 11 · Clôture 11 · Autre ligne descriptive 7 · Mur anti-bruit 5.
* `construction_surfacique.nature`: Pont 70 · Ecluse 16 · Barrage 10.
* `construction_ponctuelle.nature`: Croix 2 726 · Clocher 981 · Transformateur 483 · Antenne 406 · Autre construction élevée 43 · Cheminée 12 · Calvaire 11 · Puits d'hydrocarbures 9 · Torchère 3.
* `ligne_orographique.nature`: Talus 2 405 · Levée 981 · Carrière 116.
* `detail_orographique.nature`: Sommet 99 · Versant 96 · Vallée 39 · Plaine 25 · Crête 23 · Gouffre 18 · Grotte 12 · Ile 1 · Dépression 1 · Col 1.
* `detail_hydrographique.nature`: Source 2 240 · Point d'eau 661 · Citerne 274 · Fontaine 205 · Lavoir 198 · Source captée 103 · Perte 3 · Résurgence 2 · Marais 1.
* `cours_d_eau.importance`: 5 → 4 030 · 4 → 30 · 6 → 4 · 3 → 3 · 1 → 1.
* `plan_d_eau.nature`: Retenue 399 · Retenue-barrage 88 · Réservoir-bassin 21 · Plan d'eau de gravière 16 · Lac 5 · Réservoir-bassin d'orage 2 · Mare 1.
* `parc_ou_reserve.nature`: Site Natura 2000 14 · Site acquis/CEN 10 · Arrêté de protection 2.
* `aerodrome`, `foret_publique`, `canton`, `epci`… not distributed (small counts, low value).

## 4. What the pipeline exports today (VERIFIED, code + on-disk artifacts)

### 4.1 `scripts/data/fetch-bdtopo.ts`

* `LAYERS` declaration, **lines 46-51** — exactly 4 layers, nothing else:

```ts
const LAYERS: readonly LayerSpec[] = [
  { name: "buildings",       layer: "batiment",             output: "bdtopo-buildings.geojson" },
  { name: "roads",           layer: "troncon_de_route",     output: "bdtopo-roads.geojson" },
  { name: "water-surfaces",  layer: "surface_hydrographique", output: "bdtopo-water-surfaces.geojson" },
  { name: "water-lines",     layer: "troncon_hydrographique", output: "bdtopo-water-lines.geojson" },
];
```

  The package's other 49 spatial layers (1 616 719 records in the Gers envelope) are never touched.
* Discovery (lines 92-120): GeoPlateforme Atom capabilities → `?zone=D032` must contain a "bd topo" product, then `resource/BDTOPO` catalog filtered by `resourceTitle()` regex (line 78-80: `^BDTOPO_\d+-\d+_TOUSTHEMES_GPKG_LAMB93_D032_\d{4}-\d{2}-\d{2}$`), newest `editionDate` wins, `BDTOPO_EDITION` env override (line 93). Cached in `data/raw/.http-cache/<sha256>.xml`.
* Download (lines 306-326): 7z archive → `data/raw/BDTOPO_3-5_..._2026-06-15.7z` (273 308 797 B, sha256 `aed0afbc…562fa`), size cross-checked against `gpf_dl:length` (line 312-314), extracted with `7z x -y` into `data/raw/bdtopo/`, stale-edition package purged (316-320), exactly one `.gpkg` required (325).
* Export (lines 191-225, `exportLayers`): for each spec

```
ogr2ogr -f GeoJSON <output> <gpkg> <layer> -spat <W S E N Lambert93> [-clipsrc <boundary.geojson>] -t_srs EPSG:4326 -lco RFC7946=YES
```

  Argument surgery at line 203 inserts `-clipsrc` at position 10. **GEOS fallback** (lines 186-189, 204-211): on `/GEOS support not enabled|cannot load source clip geometry/` it deletes the partial output, sets `clipFallback = true`, and re-runs with `-spat` only. Gers scope passes `clipPath = null` (line 333) so the Gers run *never* clips at export time — only the Lambert-93 envelope. Auch scope passes the commune polygon (line 264).
* Validation (lines 165-171, 212-222): the file must parse as a non-empty `FeatureCollection`; the record count comes from `parsed.features.length` (i.e. it JSON-parses a 507 MB file into memory); sha256 over the raw file text.
* Gers boundary: `lambertBounds()` (lines 136-157) reads `data/raw/gers-boundary.geojson` and converts every coordinate with `toLambert93` → `[435144.4999131731, 6248685.900145752, 554835.000112572, 6334163.999727008]`.
* Manifest: `data/intermediate/bdtopo-manifest.json` (line 356) with edition, archive sha256/bytes, `package.layers`, `clipping`. **`outputs` is only present in the Auch manifest** (line 291) — the Gers manifest has no `outputs` array (verified: `python3 -c json…['outputs']` → `None`). So per-layer record counts and sha256 are not auditable for Gers today.
* On-disk results (VERIFIED by counting `"type":"Feature"`):

| file | features | bytes | vs `ogrinfo -spat` |
|---|---|---|---|
| `data/raw/bdtopo-buildings.geojson` | 397 880 | 466 880 516 | −1 vs 397 881 |
| `data/raw/bdtopo-roads.geojson` | 166 838 | 507 110 744 | −1 vs 166 839 |
| `data/raw/bdtopo-water-lines.geojson` | 50 274 | 101 914 275 | −1 vs 50 275 |
| `data/raw/bdtopo-water-surfaces.geojson` | 13 597 | 29 515 129 | −1 vs 13 598 |

  The off-by-one is a `grep` counting artifact of the last feature (no trailing `,`), not a data loss — VERIFIED that the final feature is present (file ends with a complete object). Treat as equal.
  Total on disk: **1 105 296 664 B (1.03 GiB)** of GeoJSON for 628 589 features (4 fewer than the 628 593 `ogrinfo -spat` count, from the trailing-feature counting artifact of the previous line).
  Z coordinates are preserved (`[0.0855255,43.5455312,152.4]`), so `-t_srs EPSG:4326` keeps the Lambert altitude as the 3rd ordinate. Consumer must ignore or use it.
* Auch scope: same 4 layers only, `data/raw/auch/bdtopo-*.geojson` (46.9 MB total) + `data/auch/intermediate/bdtopo-manifest.json`.

### 4.2 `scripts/data/normalizeBdtopo.ts` — `normalizeBdtopo()` lines 288-406

* Input: `Record<string, unknown>[]` already tagged with `sourceLayer = path.basename(file)` by `normalize.ts:974-978`. `sourceLayerName()` (279-286) maps **only** the 4 known basenames to `building|road|water-surface|water-line`; anything else returns `null` → `continue` (line 293-294). So adding a 5th export file is a hard stop: it is silently dropped unless this switch is extended.
* Geometry: `asGeometry()` (100-132) accepts Point/LineString/MultiLineString/Polygon/MultiPolygon and **drops any 3-element coordinate silently** — `coordinate()` (54-61) only reads `value[0]`/`value[1]`, so Z is discarded here. Multi-part requires every part valid, else the whole feature is dropped.
* Clipping: `clipToBoundary()` (238-262) does exact polygon clipping against the Gers/Auch boundary using the hand-rolled `clipLineStringToPolygon` / `clipPolygonToPolygon` (no GEOS needed). Fast paths: `boundaryIndex.lineInside` / `lineOutside` / `polygonInside` / `polygonOutside`. **This is the only reason envelope-based exports are safe today.**
* Projection: `localize()` (229-236) applies `wgs84ToRender` per vertex; polygons go through `normalizePolygonGeometry`.
* Anchor/label position: `geometryAnchor()` (195-227) — midpoint by arc length for lines, area-weighted centroid (holes subtracted) for polygons.
* Identity: `const sourceId = text(properties.cleabs); if (!sourceId) continue;` (304-305) → **every feature without `cleabs` is dropped**. Verified 0 such records for `troncon_de_route`; not verified for the other 49 layers (`[INFERENCE]` they are all populated, IGN guarantees the key).
  `stableId = ign-bdtopo:<layer>/<cleabs>` (306).
* Name extraction (307-311): road → `nom_voie_ban_gauche` ?? `nom_voie_ban_droite`; water-line → `cpx_toponyme_de_cours_d_eau` ?? `cpx_toponyme_d_entite_de_transition`; otherwise `cpx_toponyme_de_plan_d_eau` ?? `cpx_toponyme_de_cours_d_eau`. Buildings therefore get **no name at all**.
* Common envelope (312-326): `confidence: "high"`, `status: "active"`, one provenance record and one sourceRef per feature (`timestamp = new Date().toISOString()` evaluated **once at module load**, line 28, so every feature in a run shares it).
* Building branch (327-351): `kind: "building"`, `height = numeric(hauteur)`, `levels` from `nombre_d_etages`, `buildingType = nature`, `heightSource: "explicit"` when present. Drops 205 zero heights and 282 529 null floor counts silently. Ignores `usage_1`, `usage_2`, `etat_de_l_objet`, `nombre_de_logements`, `materiaux_*`, `origine_du_batiment`, `identifiants_rnb`, `altitude_maximale_toit`.
* Road branch (352-383): `roadClass()` (268-277) — NFD + accent-strip + lowercase, then 9 literal matches; everything else → `"unclassified"`. `position === "1"` bridge, `"-1"` tunnel, `stratum` derived. `width = numeric(largeur_de_chaussee)`. `fictif` is only written into `sourceMetadata`, never used to filter. `importance` only into `sourceMetadata`.
* Water branch (384-403): `waterType = nature`, `width: undefined` **hard-coded**, `widthInferred = (layer === "water-line")`, `fictiveAxis` from `fictif` for lines only, `isSurface` for polygons. `persistance`, `classe_de_largeur`, `position_par_rapport_au_sol` land in `sourceMetadata` only.
* Kinds produced: only `building`, `road`, `water`. The schema (`src/lib/data/schema.ts:314`) offers `landuse`, `poi`, `transport` too — **never produced by BD TOPO**.

### 4.3 Wiring and downstream reality

* `normalize.ts:866-869` accepts only files matching `/^bdtopo-(buildings|roads|water-surfaces|water-lines)\.geojson$/`; a rename or a 5th file is invisible there too.
* `data/manifests/coverage.json` (VERIFIED): `sourceCounts["IGN BD TOPO"] = 486 321`; `featureCounts` building 305 761 / road 182 254 / water 52 716; `failedSources` includes `invalid-source-geometries: 111 source records were excluded`. **The 486 321 figure is post-clipping: of 628 589 exported records, 142 268 (22.6 %) are discarded by exact polygon clipping and are not attributed per layer anywhere.**
* `data/manifests/sources.json` records BD TOPO as `status: "ok"` with edition 2026-06-15 and **no `recordCount`** and **no `sha256`** (fields exist for ADMIN EXPRESS: `recordCount: 1`, `sha256: …`). So there is no auditable statement of how many BD TOPO records were ingested.

### 4.4 Z-ordinate sentinel (VERIFIED)

The exported GeoJSON carries a third ordinate that is sometimes a **null sentinel, not an altitude**: the last feature of `bdtopo-roads.geojson` ends with `"coordinates":[[0.6385556,43.6598425,-1000.0]]`, while `bdtopo-buildings.geojson` roofs carry real altitudes (`…43.7671642,224.5]`). BD TOPO writes `-1000.0` when Z is unknown. `asGeometry()` (`normalizeBdtopo.ts:54-61`) discards Z unconditionally, which silently neutralises this today, but any consumer reading the raw exports must filter `-1000`.

## 5. Gap list (ranked by map value)

**P0 — big rendering value, cheap to add**

| # | Gap | Evidence | Why it matters |
|---|---|---|---|
| 1 | 49 of 53 spatial layers never exported | `fetch-bdtopo.ts:46-51` | 1 616 719 records (72 % of spatial volume) invisible |
| 2 | No landuse: `zone_de_vegetation` (259 207 inGers), `zone_d_activite_ou_d_interet` (5 040), `cimetiere` (933), `terrain_de_sport` (1 168), `parc_ou_reserve` (22), `bassin_versant_topographique` (173) | §2 | the map has no forest/vineyard/cemetery/sport fill at all |
| 3 | No place names/labels: `zone_d_habitation` (36 138), `lieu_dit_non_habite` (3 722), `detail_orographique` (271), `toponymie` (54 043) | §2 | search + labels have no official IGN toponymy; 34 618 POIs currently come only from OSM |
| 4 | No rail: `troncon_de_voie_ferree` (303) incl. LGV | §2 | Gers has a real rail network; currently invisible |
| 5 | No POI layer from BD TOPO: `erp` (7 764) with `libelle`/`activite_principale`/`public`/`ouvert` | §2 | authoritative public/accessible POIs, complements SIRENE + OSM |
| 6 | No named ways: `voie_nommee` (20 973) with `liens_vers_supports` → road cleabs | §3.15 | road search relies on OSM; `voie_nommee` gives the official `nom_voie_ban` per road section |
| 7 | `construction_lineaire` (8 666: 4 639 Pont, 1 345 Barrage, 11 Tunnel) + `construction_surfacique` (88) | §2 | bridges/barrages currently appear as bare road lines |

**P1 — quality of what is already adopted**

| # | Gap | Evidence |
|---|---|

Exact gap accounting (computed from the per-layer `ogrinfo -spat` counts of §2): in-Gers-envelope total = **2 245 312 rows across all 57 layers**, of which 71 are aspatial metadata/style rows → **2 245 241 spatial records**. The 4 exported layers account for **628 593**; the **unexported gap is 1 616 719 records (72 % of the department's spatial volume)**. 1 420 274 of that (88 %) sits in 7 layers: `batiment_rnb_lien_bdtopo` 382 528, `haie` 413 239, `zone_de_vegetation` 259 207, `adresse_ban` 177 951, `lien_adresse_vers_bdtopo` 164 082, `toponymie` 54 043, `noeud_hydrographique` 49 224.

| 8 | `roadClass()` ignores `importance` (100 % populated) and `nombre_de_voies` | §3.1/3.2, `normalizeBdtopo.ts:268-277` |
| 9 | 25 fictitious road segments rendered as real; 10 290 fictive water axes flagged but only stored in metadata | §3.4, §3.6, `normalizeBdtopo.ts:384` |
| 10 | 84 fords/radiers (`position_par_rapport_au_sol = "Gué ou radier"`) unmapped | §3.3, `normalizeBdtopo.ts:353-355` |
| 11 | `WaterFeature.width` hard-coded `undefined`; `classe_de_largeur` (6 value classes) unused | `normalizeBdtopo.ts:389-390`, §3.6 |
| 12 | `persistance` → `intermittent` never set (69 % of watercourses intermittent) | `normalizeBdtopo.ts:398`, `schema.ts:227` |
| 13 | Buildings have no name; `usage_1`/`usage_2`/`nombre_de_logements`/`materiaux_*` dropped | `normalizeBdtopo.ts:307-311, 339-347` |
| 14 | `etat_de_l_objet` ignored: 342 ruins, 166 under construction, 10+4 roads | §3.4/3.5 |
| 15 | Z coordinates present in the GeoJSON but silently dropped in `asGeometry()`; no decision recorded | `normalizeBdtopo.ts:54-61` |
| 16 | Every feature gets `confidence: "high"`, `status: "active"` regardless of `fictif`/`etat`/`precision_planimetrique` | `normalizeBdtopo.ts:322-323` |

**P2 — auditability (blocks the "auditable exclusion report" mission requirement)**

| # | Gap | Evidence |
|---|---|---|
| 17 | Gers `bdtopo-manifest.json` has **no `outputs` array** (only the Auch path writes one) | `fetch-bdtopo.ts:291` vs `335-355`; verified `outputs → null` |
| 18 | `sources.json` BD TOPO entry has **no `recordCount`, no `sha256`** | `data/manifests/sources.json` |
| 19 | The 142 268 records dropped by exact polygon clipping are not counted per layer anywhere; only an aggregate "486 321" | `coverage.json:sourceCounts`, `clipping.method` |
| 20 | No exclusion report exists for the 49 unexported layers (1 616 719 records silently absent) | §2 |
| 21 | `haie` (413 239) and `zone_de_vegetation` (259 207) are 60 % of the department's spatial volume; adopting them naively would need a documented LOD/threshold policy | §2.6 |

## 6. Practical adoption path (INFERENCE, not implemented)

1. Extend `LAYERS` in `fetch-bdtopo.ts:46-51` with the P0 layers (add ~14 specs: `troncon_de_voie_ferree`, `equipement_de_transport`, `aerodrome`, `piste_d_aerodrome`, `zone_de_vegetation`, `zone_d_activite_ou_d_interet`, `cimetiere`, `terrain_de_sport`, `parc_ou_reserve`, `zone_d_habitation`, `lieu_dit_non_habite`, `detail_orographique`, `construction_lineaire`, `construction_surfacique`, `reservoir`, `erp`, `voie_nommee`, `toponymie`, `detail_hydrographique`, `plan_d_eau`, `cours_d_eau`, `canalisation`, `ligne_orographique`).
2. Replace the 4-way `sourceLayerName()` switch (`normalizeBdtopo.ts:279-286`) and the regex in `normalize.ts:867` with one shared table (single source of truth), and add the missing `MapFeature` producers for `landuse`, `poi`, `transport` (schema already supports them: `schema.ts:237-300`).
3. Add `outputs` to the Gers manifest (`fetch-bdtopo.ts:335-355`) and `recordCount`/`sha256` to `sources.json`; write an `exclusions.json` listing every layer and every record dropped, with a reason code.
4. `haie`/`zone_de_vegetation` need a size threshold + LOD gating, otherwise a single Gers-wide `zone_de_vegetation` export is ~2× the size of today's four files combined.
