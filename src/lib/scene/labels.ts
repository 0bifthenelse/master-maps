/**
 * @file Pure label selection, priority and screen-space collision layout.
 *
 * No Three.js, no DOM: every function here is a deterministic function of the
 * decoded tile metadata, the camera zoom, the enabled layer families and an
 * injected world-to-screen projection, so the same code drives the sprite
 * layer, the unit tests and the metrics the browser probe reads back.
 *
 * The camera is orthographic and its zoom is 1 when the whole department fits
 * the viewport, so every threshold below is expressed in those zoom units and
 * scales with the dataset rather than with pixel density.
 *
 * ZOOM BANDS (Gers, about 131 km wide at zoom 1):
 *   zoom 1    department overview, place labels only
 *   zoom 8    transport stations and the larger villages
 *   zoom 14   points of interest and businesses
 *   zoom 24   every remaining place, streets begin at 30
 *   zoom 60   house numbers (a search result focuses at zoom 80)
 */
import { renderLayerRanges, type DecodedRenderTile, type FeatureMeta, type RenderLayerId } from "@/lib/render/codec";

export type LabelKind = "place" | "street" | "poi" | "business" | "transport" | "address";

/** Zoom at which a label family becomes eligible, in camera zoom units. */
export const LABEL_ZOOM_MIN: Readonly<Record<LabelKind, number>> = {
  place: 1,
  transport: 8,
  poi: 14,
  business: 14,
  street: 30,
  address: 60,
};

/**
 * Zoom values at which the candidate set changes. Rebuilding the candidate
 * pool only when the camera crosses one of these keeps the metadata pass off
 * the per-frame path while still gating on importance.
 */
export const ZOOM_BANDS: readonly number[] = [0, 1, 2.5, 6, 8, 14, 24, 30, 60, 120];

/** Hard ceiling on the number of labels drawn in one frame. */
export const MAX_VISIBLE_LABELS = 320;

/** Ceiling on the pool kept for collision, before the per-frame layout. */
export const MAX_CANDIDATE_POOL = 3000;

/** Address labels are additionally capped per megapixel of viewport. */
export const MAX_ADDRESS_LABELS_PER_MEGAPIXEL = 90;

const TEXT_EM_WIDTH = 0.56;
const LABEL_HEIGHT_EM = 1.3;
const GRID_CELL = 24;
const DEFAULT_META_Y = 2;
const MAX_TEXT_LENGTH = 42;
const ROAD_LAYERS: ReadonlySet<RenderLayerId> = new Set<RenderLayerId>(["road_normal", "road_bridge", "road_tunnel"]);

export interface LabelLayerFlags {
  places: boolean;
  pois: boolean;
  business: boolean;
  transport: boolean;
  addresses: boolean;
  streets: boolean;
}

export interface LabelCandidate {
  /** Canonical stableId, unique per candidate. */
  id: string;
  text: string;
  /** Render-space anchor in local metres, matching FeatureMeta.a. */
  x: number;
  z: number;
  /** Render-space height the anchor sits at, in metres. */
  y: number;
  /** Larger wins a contested cell. */
  priority: number;
  kind: LabelKind;
}

/** A laid-out label, with its box measured in CSS pixels. */
export interface PlacedLabel extends LabelCandidate {
  screenX: number;
  screenY: number;
  halfWidth: number;
  halfHeight: number;
}

/** World-to-screen seam. Returns null when the point is off screen. */
export type LabelProjector = (x: number, z: number) => readonly [number, number] | null;

export interface LabelProjection {
  width: number;
  height: number;
  project: LabelProjector;
  /** Metres covered by one CSS pixel, used to turn pixel boxes back into world units. */
  metresPerPixel: number;
}

function kindEnabled(kind: LabelKind, layers: Partial<LabelLayerFlags>): boolean {
  switch (kind) {
    case "place": return layers.places !== false;
    case "street": return layers.streets !== false;
    case "poi": return layers.pois !== false;
    case "business": return layers.business !== false;
    case "transport": return layers.transport !== false;
    case "address": return layers.addresses !== false;
  }
}

function cleanText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > MAX_TEXT_LENGTH ? `${collapsed.slice(0, MAX_TEXT_LENGTH - 1)}…` : collapsed;
}

function numberProp(meta: FeatureMeta, key: string): number | undefined {
  const value = meta.p?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 6;
  return Math.min(6, Math.max(1, Math.round(value)));
}

/** A real place carries its own importance; a settlement poi borrows one from its category. */
function importanceOf(meta: FeatureMeta): number {
  const declared = numberProp(meta, "importance");
  if (declared !== undefined) return clampImportance(declared);
  return clampImportance(settlementImportance(meta));
}

/** importance 1 is the department seat and 6 a hamlet, so the order inverts. */
function placePriority(importance: number): number {
  return 1000 - importance * 100;
}

const KEY_PLACE = /townhall|mairie|church|cathedral|chapel|monument|museum|theatre|stadium|school|office_townhall|hotel|culture/;


/**
 * Measured against the decoded render tiles: the department carries no
 * FeatureMeta.k === "place" at all. Settlements arrive on the poi layer with
 * a settlement poiType, and every one of them is named. Mapping these
 * categories onto the place family is what puts commune names on the
 * department overview, which is where a map reader looks for them first.
 * The value is the importance the settlement behaves like, 1 being the most
 * significant.
 */
const SETTLEMENT_CATEGORIES: Readonly<Record<string, number>> = {
  town: 1,
  city: 1,
  commune: 1,
  village: 2,
  locality: 2,
  townhall: 2,
  hamlet: 3,
  quarter: 4,
  neighbourhood: 4,
  isolated_dwelling: 5,
};

function settlementImportance(meta: FeatureMeta): number | undefined {
  return SETTLEMENT_CATEGORIES[meta.c];
}

function poiPriority(meta: FeatureMeta): number {
  const category = typeof meta.c === "string" ? meta.c : typeof meta.p?.category === "string" ? meta.p.category : "";
  return KEY_PLACE.test(category) ? 420 : 300;
}

function transportPriority(meta: FeatureMeta): number {
  const type = typeof meta.c === "string" ? meta.c : "transport";
  if (type === "station") return 460;
  if (type === "aerodrome") return 440;
  if (type === "port") return 430;
  if (type === "halt") return 400;
  if (type === "bus_stop") return 180;
  if (type === "parking") return 120;
  return 200;
}

function streetPriority(meta: FeatureMeta): number {
  const className = typeof meta.c === "string" ? meta.c : "road";
  return /motorway|trunk|primary/.test(className) ? 340 : /secondary|tertiary/.test(className) ? 300 : 240;
}

function priorityFor(kind: LabelKind, meta: FeatureMeta): number {
  switch (kind) {
    case "place": return placePriority(importanceOf(meta));
    case "poi": return poiPriority(meta);
    case "business": return poiPriority(meta) - 20;
    case "transport": return transportPriority(meta);
    case "street": return streetPriority(meta);
    case "address": return 60;
  }
}

/**
 * Importance gates places at low zoom: a hamlet has no business competing
 * with a commune seat on a 131 km wide view. Above zoom 24 the buildings own
 * the screen, so every place gets its chance and only collision decides.
 */
function placeImportanceVisibleAt(meta: FeatureMeta, zoom: number): boolean {
  const importance = importanceOf(meta);
  const maxImportance = zoom >= 24 ? 6 : zoom >= 6 ? 5 : zoom >= 2.5 ? 4 : 3;
  return importance <= maxImportance;
}

function anchorY(meta: FeatureMeta, kind: LabelKind): number {
  if (kind === "place") return 0;
  if (kind === "street") return 1.5;
  if (typeof meta.h === "number" && Number.isFinite(meta.h)) return meta.h + 2;
  return DEFAULT_META_Y;
}

function labelKindForLayer(layerId: RenderLayerId, meta: FeatureMeta): LabelKind | null {
  if (ROAD_LAYERS.has(layerId)) return meta.k === "road" ? "street" : null;
  if (layerId === "transport_area" || layerId === "transport_line") return meta.k === "transport" ? "transport" : null;
  if (layerId === "poi") {
    if (meta.k === "poi" && settlementImportance(meta) !== undefined) return "place";
    if (meta.k === "business") return "business";
    return meta.k === "poi" ? "poi" : null;
  }
  if (layerId === "place") return meta.k === "place" ? "place" : null;
  if (layerId === "address") return meta.k === "address" ? "address" : null;
  return null;
}

/** Quantise a live zoom to the band the candidate pool is built for. */
export function zoomBand(zoom: number): number {
  let band = ZOOM_BANDS[0]!;
  for (const value of ZOOM_BANDS) if (zoom >= value) band = value;
  return band;
}

/**
 * Project the resident decoded tiles into label candidates. Only the
 * featureRanges index (three words per feature) is read, never the vertex
 * payload, so the cost scales with the feature count and not with the
 * geometry. The result is sorted by descending priority with the stableId as
 * a total tie-break, so two calls over the same input always agree, and
 * truncated to MAX_CANDIDATE_POOL to bound the per-frame layout.
 */
export function buildLabelCandidates(
  tiles: Iterable<DecodedRenderTile>,
  zoom: number,
  layers: Partial<LabelLayerFlags>,
  pool: number = MAX_CANDIDATE_POOL,
): LabelCandidate[] {
  const candidates: LabelCandidate[] = [];
  const seen = new Set<string>();
  for (const tile of tiles) {
    for (const layer of tile.layers) {
      const featureCount = layer.rangeLength / 3;
      if (featureCount === 0) continue;
      const ranges = renderLayerRanges(tile.payload, layer);
      for (let feature = 0; feature < featureCount; feature += 1) {
        const meta = tile.meta[ranges[feature * 3 + 2]!];
        if (meta === undefined) continue;
        const kind = labelKindForLayer(layer.id, meta);
        if (kind === null || !kindEnabled(kind, layers)) continue;
        if (zoom < LABEL_ZOOM_MIN[kind]) continue;
        if (kind === "place" && !placeImportanceVisibleAt(meta, zoom)) continue;
        const text = cleanText(meta.n);
        if (text === null) continue;
        const key = `${kind}|${text}|${Math.round(meta.a[0])}|${Math.round(meta.a[1])}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          id: `${tile.header.tileId}:${meta.s}`,
          text,
          x: meta.a[0],
          z: meta.a[1],
          y: anchorY(meta, kind),
          priority: priorityFor(kind, meta),
          kind,
        });
      }
    }
  }
  candidates.sort((first, second) => second.priority - first.priority || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));
  return candidates.length > pool ? candidates.slice(0, pool) : candidates;
}

export interface LabelLayoutOptions {
  /** Font size in CSS pixels. */
  fontSize: number;
  /** Spacing kept around each label box, in CSS pixels. */
  padding?: number;
  /** Cap on the number of placed labels. */
  maxLabels?: number;
}

/**
 * Screen-space de-collision on a uniform grid. Candidates arrive in
 * descending priority, so the first label to claim a cell is the one that
 * survives. A label is placed only when every grid cell its box covers is
 * free, which is strictly stronger than a single-cell occupancy test: two
 * placed labels can never overlap, at any zoom, under any heading.
 */
export function layoutLabels(
  candidates: readonly LabelCandidate[],
  projection: LabelProjection,
  options: LabelLayoutOptions,
): PlacedLabel[] {
  const fontSize = options.fontSize;
  const padding = options.padding ?? 1;
  const maxLabels = options.maxLabels ?? MAX_VISIBLE_LABELS;
  const width = projection.width;
  const height = projection.height;
  if (!(width > 0) || !(height > 0)) return [];
  const megapixels = (width * height) / 1_000_000;
  const addressCap = Math.max(4, Math.floor(MAX_ADDRESS_LABELS_PER_MEGAPIXEL * megapixels));
  const columns = Math.max(1, Math.ceil(width / GRID_CELL) + 1);
  const rows = Math.max(1, Math.ceil(height / GRID_CELL) + 1);
  const occupied = new Uint8Array(columns * rows);
  const placed: PlacedLabel[] = [];
  let addressCount = 0;
  for (const candidate of candidates) {
    if (placed.length >= maxLabels) break;
    if (candidate.kind === "address" && addressCount >= addressCap) continue;
    const projected = projection.project(candidate.x, candidate.z);
    if (projected === null) continue;
    const screenX = projected[0];
    const screenY = projected[1];
    if (screenX < -48 || screenX > width + 48 || screenY < -20 || screenY > height + 20) continue;
    const halfWidth = (candidate.text.length * fontSize * TEXT_EM_WIDTH) / 2 + padding;
    const halfHeight = (fontSize * LABEL_HEIGHT_EM) / 2 + padding;
    const left = Math.floor((screenX - halfWidth) / GRID_CELL);
    const right = Math.floor((screenX + halfWidth) / GRID_CELL);
    const top = Math.floor((screenY - halfHeight) / GRID_CELL);
    const bottom = Math.floor((screenY + halfHeight) / GRID_CELL);
    if (left < 0 || top < 0 || right >= columns || bottom >= rows) continue;
    let free = true;
    for (let row = top; row <= bottom && free; row += 1) {
      const offset = row * columns;
      for (let column = left; column <= right; column += 1) {
        if (occupied[offset + column] === 1) {
          free = false;
          break;
        }
      }
    }
    if (!free) continue;
    for (let row = top; row <= bottom; row += 1) {
      const offset = row * columns;
      for (let column = left; column <= right; column += 1) occupied[offset + column] = 1;
    }
    placed.push({ ...candidate, screenX, screenY, halfWidth, halfHeight });
    if (candidate.kind === "address") addressCount += 1;
  }
  return placed;
}

/** Count of placed labels per family, for the diagnostics readout. */
export function countByKind(placed: readonly PlacedLabel[]): Record<LabelKind, number> {
  const counts: Record<LabelKind, number> = { place: 0, street: 0, poi: 0, business: 0, transport: 0, address: 0 };
  for (const label of placed) counts[label.kind] += 1;
  return counts;
}

/**
 * Deterministic overlap audit, used by the unit tests and by the browser
 * probe: returns every pair of placed labels whose boxes intersect.
 */
export function findOverlaps(placed: readonly PlacedLabel[]): [PlacedLabel, PlacedLabel][] {
  const overlaps: [PlacedLabel, PlacedLabel][] = [];
  for (let first = 0; first < placed.length; first += 1) {
    for (let second = first + 1; second < placed.length; second += 1) {
      const a = placed[first]!;
      const b = placed[second]!;
      if (Math.abs(a.screenX - b.screenX) >= a.halfWidth + b.halfWidth) continue;
      if (Math.abs(a.screenY - b.screenY) >= a.halfHeight + b.halfHeight) continue;
      overlaps.push([a, b]);
    }
  }
  return overlaps;
}
