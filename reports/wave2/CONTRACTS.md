# Wave 2 contracts

Status: contract. All Wave 2 agents MUST code against this document. Evidence base: reports/wave1/*.md.

## 1. Canonical kinds (schema.ts, committed ef52a82)

FEATURE_KINDS = boundary, building, road, water, landuse, poi, business, address, transport, structure, place.

- structure: linear/areal/point constructions (pont, barrage, ecluse, mur, ruines, reservoir, quai). Fields: structureType, height?, heightSource?.
- place: named settlements and toponyms (zone_d_habitation, lieu_dit_non_habite, detail_orographique, commune). Fields: placeType, importance 1-6, population?.
- transport: rail lines, stations/stops, aerodromes, runways, parkings, bus stops. transportType values: rail, station, halt, bus_stop, platform, aerodrome, runway, parking, roundabout, toll, port.
- landuse landuseType values now include: forest, wood, vineyard, heath, orchard, poplar, grove, cemetery, sports, park, reserve, habitat, activity, plus existing OSM values.
- road: existing classes + roadClass values: motorway, trunk, primary, secondary, tertiary, residential, service, track, path, footway, cycleway, pedestrian, steps, roundabout, ford. New optional field usage: width from BD TOPO largeur_de_chaussee when present; importance 1-6 kept in sourceMetadata.importance.
- water: intermittent from persistance=="Intermittent"; fictiveAxis from fictif=="Oui"; fictive axes are kept in canonical data but marked fictiveAxis=true and NOT rendered (renderer skips them); width from classe_de_largeur mapping {0:0.5, 1:1.5, 2:4, 3:10, 4:25} metres when largeur absent.
- address: geometry Point; fields street, housenumber, postcode, city, banId; rendered only at LOD0 zoom>=threshold; always searchable.
- poi poiType: free string; BD TOPO erp maps to poi with poiType=erp:<categorie>, detail_hydrographique maps to poi (spring, fountain, water_point, cistern, washhouse), construction_ponctuelle maps to poi (cross, bell_tower, antenna, chimney...).

## 2. Render-tile binary format MMT1 (src/lib/render/codec.ts)

File per tile: data/generated/render/<tileId>.mmt. Little-endian.

```
u32 magic 0x4D4D5431 ("MMT1")
u32 formatVersion = 1
u32 headerBytes
u8  header[headerBytes]   UTF-8 JSON header
u8  payload[...]          concatenated sections, 4-byte aligned
```

Header JSON:
```json
{
  "tileId": "l0_558_293_s4_1_0",
  "lod": 0,
  "bounds": [x0, z0, x1, z1],
  "datasetVersion": "...",
  "layers": [
    {"id": "buildings", "vertexCount": 0, "indexCount": 0, "positionOffset": 0, "indexOffset": 0, "featureCount": 0}
  ],
  "featureMetaBytes": 0,
  "featureMetaOffset": 0
}
```

Layer ids (fixed set, renderOrder ascending):
habitat(landuse), landuse, water_surface, water_line, transport_area, transport_line, structure_line, structure_area, road_tunnel, road_normal, road_bridge, buildings, structures_point(pois instanced), poi, address, place, boundary.

Payload per layer:
- positions: Float32Array vertexCount*3 [x,y,z] in local render coords (x east, y up, z north-negative per existing scene convention: builders map [x,z] -> three (x, y, z)). Buildings are pre-extruded (roof + walls) at build time; y already contains height.
- indices: Uint32Array indexCount.
- featureRanges: Uint32Array featureCount*3 [indexStart, indexCount, metaIndex] appended right after indices (offset = indexOffset + indexCount*4).

featureMeta section: UTF-8 JSON array, one entry per metaIndex:
```json
{"s":"stableId","k":"kind","c":"category-or-class","n":"name?","a":[x,z],"h":height?,"w":width?,"p":{...small extra props for inspector...}}
```

Sizes: positions float32; no normals (flat lighting via vertex-position hashing in shader or MeshBasicMaterial-style shading already in materials.ts); colors per layer fixed, variation via per-vertex y or attribute only if needed.

Codec module API (both Node build-time and browser worker use the SAME code):
- encodeRenderTile(input: RenderTileInput): ArrayBuffer
- decodeRenderTile(buffer: ArrayBuffer): DecodedRenderTile { header, layers: [{id, positions: Float32Array, indices: Uint32Array, ranges: Uint32Array}], meta: FeatureMeta[] }
- RenderTileInput = { tileId, lod, bounds, datasetVersion, layers: [{id, positions: Float32Array, indices: Uint32Array, ranges: Uint32Array}], meta: FeatureMeta[] }

No compression inside codec; HTTP layer serves precompressed .gz sidecar (route sets Content-Encoding: gzip) when present.

## 3. Worker protocol (src/lib/render/tileWorker.ts + workerPool.ts)

- new Worker(new URL("./tileWorker.ts", import.meta.url), { type: "module" }); pool size = clamp(navigator.hardwareConcurrency - 2, 2, 6).
- Main -> worker: { t: "decode", tileId, gen, buffer } with buffer transferred. Worker replies { t: "decoded", tileId, gen, header, layers, meta } with all ArrayBuffers transferred back. { t: "error", tileId, gen, message }.
- Main -> worker: { t: "cancel", gen } drops queued/running work for older generations.
- Main thread creates THREE.BufferGeometry from transferred arrays (setAttribute/setIndex), one geometry per (tileId, layerId).

### 3.1 Transfer rule (binding amendment)

`decodeRenderTile` MUST return per-layer views over ONE shared payload slab plus an explicit descriptor list, so the worker transfers exactly one ArrayBuffer:

```ts
decodeRenderTile(buffer: ArrayBuffer): {
  header: RenderTileHeader;
  payload: ArrayBuffer;                      // the single slab to transfer
  layers: Array<{ id: RenderLayerId; positionOffset: number; positionLength: number; indexOffset: number; indexLength: number; rangeOffset: number; rangeLength: number }>;
  meta: FeatureMeta[];
}
```

- Worker reply: `{ t: "decoded", tileId, gen, header, payload, layers, meta }` with only `payload` in the transfer list.
- Main thread: build Float32Array/Uint32Array views over the transferred `payload` using the descriptors; views are then owned by the tile's GPU cache entry.
- Rationale: per-layer views over one slab cannot be transferred individually (transferring one detaches the shared buffer for every other view). Consumers that must keep a layer past the cache lifetime copy that layer explicitly.

`encodeRenderTile`/`decodeRenderTile` are also used at build time in Node, where no transfer happens: same signatures, views over the returned slab.

## 4. Tile scene assembly (MapShell/CityScene rework, W2 T15)

- MapShell keeps Map<tileId, DecodedRenderTile> (from worker pool) and Map<tileId, Map<layerId, BufferGeometry>> GPU cache with byte budget 512MB LRU; evict disposes geometries.
- CityScene receives stable per-tile groups; React key = tileId; adding/removing a tile mounts/unmounts only that tile's meshes. No global deduplicateSceneFeatures over JSON features for rendering; boundary rendered once from a dedicated dataset-level layer (boundary layer id in each tile still present but boundary geometry comes from manifest-level file boundary.mmt rendered once).
- Inspector/hover: pick via featureRanges metaIndex on raycast; meta has stableId + small props; full detail fetch on demand from /api/map/tile/<id> JSON (kept for inspection only).

## 5. Delivery (W2 T16)

- /api/map/manifest: serve slim manifest (tiles: [{tileId, lod, bounds, byteSize}] only + datasetVersion + boundary bbox + renderOrigin). In-memory cache keyed by file mtime; ETag = datasetVersion; Cache-Control: public, max-age=60.
- /api/map/render/<tileId>: streams data/generated/render/<tileId>.mmt(.gz) with Content-Encoding when .gz exists, Cache-Control: public, max-age=31536000, immutable only when URL carries ?v=<datasetVersion>; X-Dataset-Version header always.
- /api/map/tile/<tileId>: legacy JSON stays for inspector detail fetches; in-memory LRU 64 entries; ETag per datasetVersion.
- /api/map/search: unchanged contract; index extended with place/transport kinds.

## 6. Data pipeline ownership (W2 T10-T12, T13 builder)

- fetch-bdtopo.ts LAYERS extended per reports/wave1/W1_T02_BDTOPO.md ADOPT table. normalizeBdtopo.ts maps each layer to canonical kinds per §1. normalize.ts:867 layer allowlist extended accordingly.
- normalizeOsmBulk.ts: DEFAULT retention becomes "complete" department-wide; classifier gains railway/public_transport/place/aeroway/leisure/man_made(barrier subset)/power(line only)/landuse+natural polygons (closed ways); osmium extract keeps area assembly (ways with closed rings) so forests are Polygons.
- fetch-addresses.ts: reconciliation counters (raw, parsed, in-boundary, normalized, indexed) written to data/qa/address-reconciliation.json; the 74-record gap must be accounted.
- fetch-cadastre.ts (new): downloads cadastre-32-batiments.json.gz + lieux_dits.json.gz from https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/32/ into data/raw via http-cache; used for parity report only (scripts/data/reconcile-sources.ts), not merged.
- fetch-businesses.ts: SIRENE department-wide via recherche-entreprises.api.gouv.fr pagination (curated NAF/commune query partition to stay under the 10k/page cap), geocode missing coords via BAN; keep Auch hardcoded queries removed.
- deduplicate.ts + refresh.ts: write data/qa/exclusion-report.json accounting every dropped record per stage with reason.
- build-tiles.ts: keeps writing canonical JSON tiles AND writes render .mmt + .mmt.gz using the codec; slim manifest; tile-manifest.json keeps only {tileId, lod, bounds, byteSize, featureCount}.

## 7. Definition of done W2

- typecheck + eslint + unit tests green.
- Full offline rebuild: npm run data:build (uses cached raw sources) succeeds; validate + qa green; coverage.json featureCounts include new kinds; exclusion-report.json has zero unexplained records.
- Render tiles exist for every manifest tile; codec round-trip test green.
- Worker pool + GPU cache integrated; map loads from .mmt tiles in dev server smoke test.
- Reports committed under reports/wave2/.
