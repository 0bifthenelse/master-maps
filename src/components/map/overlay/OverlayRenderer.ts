import { categoryDefinition, type CategoryDefinition } from "@/lib/data/categories";
import {
  RANGE_STRIDE,
  renderLayerRanges,
  renderLayerVertices,
  type DecodedRenderTile,
  type FeatureMeta,
  type RenderLayerId,
} from "@/lib/render/codec";
import { ROAD_STYLES, roadStyle, type RoadStyle } from "@/lib/render/styles";
import { MACHINE, type BaseMap } from "@/lib/map/theme";
import type { MapPoint, MapTransform, ScreenPoint } from "@/lib/map/transform";
import { drawGlyph } from "./icons";

/**
 * Screen-space layer drawn on a 2D canvas above the WebGL map: every label,
 * marker, shield and selection bracket. Text stays upright and crisp at any
 * bearing or tilt because it is laid out in pixels each frame from the
 * projected anchors, with a collision grid deciding what fits.
 */

export interface OverlayLayers {
  labels: boolean;
  places: boolean;
  pois: boolean;
  businesses: boolean;
  addresses: boolean;
  roads: boolean;
}

export interface OverlayTarget {
  stableId: string;
  kind: string;
  anchor: MapPoint;
  name?: string;
  category?: string;
  /** Optional footprint, in map metres, to frame with brackets. */
  bbox?: [number, number, number, number];
  height?: number;
}

export interface OverlayState {
  tiles: readonly DecodedRenderTile[];
  layers: OverlayLayers;
  selection: OverlayTarget | null;
  hover: OverlayTarget | null;
  /** Search results or category hits, outlined in yellow. */
  highlights: readonly OverlayTarget[];
  basemap: BaseMap;
  /** Font families resolved from next/font. */
  fonts: { display: string; mono: string };
}

export interface PlacedMarker {
  target: OverlayTarget;
  x: number;
  y: number;
  radius: number;
}

interface PointCandidate {
  s: string;
  kind: string;
  name?: string;
  category: CategoryDefinition;
  anchor: MapPoint;
  minZoom: number;
  priority: number;
  emergency: boolean;
}

interface PlaceCandidate {
  s: string;
  name: string;
  anchor: MapPoint;
  minZoom: number;
  priority: number;
  tier: 0 | 1 | 2 | 3;
}

interface RoadCandidate {
  s: string;
  name?: string;
  ref?: string;
  style: RoadStyle;
  anchor: MapPoint;
  /** Unit direction in map metres at the anchor. */
  direction: MapPoint;
  length: number;
  minZoom: number;
  shieldZoom: number;
  priority: number;
}

interface AddressCandidate {
  number: string;
  anchor: MapPoint;
}

interface TileCandidates {
  points: PointCandidate[];
  places: PlaceCandidate[];
  roads: RoadCandidate[];
  waters: RoadCandidate[];
  addresses: AddressCandidate[];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const CELL = 48;
const ROAD_LABEL_ZOOM: Readonly<Record<RoadStyle, number>> = {
  motorway: 10.5, trunk: 10.5, primary: 12, secondary: 13, tertiary: 14, residential: 15.2, unclassified: 15, service: 16.5,
  track: 16, path: 16.8, cycleway: 16.5, steps: 17.5, pedestrian: 16, ferry: 13,
};
const SHIELD_ZOOM: Readonly<Record<RoadStyle, number>> = {
  motorway: 8, trunk: 8, primary: 9.5, secondary: 11, tertiary: 12.5, residential: 30, unclassified: 30, service: 30,
  track: 30, path: 30, cycleway: 30, steps: 30, pedestrian: 30, ferry: 30,
};
const ROAD_LABEL_LAYERS: readonly RenderLayerId[] = ["road", "road_bridge", "road_tunnel"];
const EMERGENCY = new Set(["hospital", "police", "fire_station"]);

export class OverlayRenderer {
  private readonly context: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private readonly cache = new Map<string, TileCandidates>();
  private grid = new Map<number, Box[]>();
  private placed: PlacedMarker[] = [];
  private readonly scratch: ScreenPoint = { x: 0, y: 0, depth: 0, visible: false };
  private readonly scratchB: ScreenPoint = { x: 0, y: 0, depth: 0, visible: false };
  private textWidthCache = new Map<string, number>();
  private fontsKey = "";

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas unavailable");
    this.context = context;
  }

  resize(width: number, height: number, ratio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.ratio = Math.min(3, Math.max(1, ratio));
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  /** Forget cached candidates of tiles no longer mounted. */
  retainTiles(ids: ReadonlySet<string>): void {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  hitTest(x: number, y: number): PlacedMarker | null {
    let best: PlacedMarker | null = null;
    let bestDistance = Infinity;
    for (const marker of this.placed) {
      const distance = Math.hypot(marker.x - x, marker.y - y);
      if (distance <= marker.radius && distance < bestDistance) {
        best = marker;
        bestDistance = distance;
      }
    }
    return best;
  }

  draw(transform: MapTransform, state: OverlayState, now: number): void {
    const g = this.context;
    g.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    g.clearRect(0, 0, this.width, this.height);
    this.grid = new Map();
    this.placed = [];
    const fontsKey = `${state.fonts.display}|${state.fonts.mono}`;
    if (fontsKey !== this.fontsKey) {
      this.fontsKey = fontsKey;
      this.textWidthCache.clear();
    }
    const zoom = transform.zoom;
    const satellite = state.basemap === "satellite";
    const seen = new Set<string>();
    const tiles = state.tiles;

    /* Reserve the space of the selection and highlights first so labels flow around them. */
    const reserved: OverlayTarget[] = [...(state.selection === null ? [] : [state.selection]), ...state.highlights];
    for (const target of reserved) {
      const point = transform.project(target.anchor[0], target.anchor[1], 0, this.scratch);
      if (!this.onScreen(point, 40)) continue;
      this.insert({ x0: point.x - 16, y0: point.y - 16, x1: point.x + 16, y1: point.y + 16 });
    }

    if (state.layers.labels) {
      /* 1. Settlements, by importance. */
      if (state.layers.places) {
        const places: PlaceCandidate[] = [];
        for (const tile of tiles) for (const place of this.candidates(tile).places) {
          if (place.minZoom > zoom || seen.has(place.s)) continue;
          seen.add(place.s);
          places.push(place);
        }
        places.sort((a, b) => b.priority - a.priority);
        /* A commune and its chef-lieu (or an OSM town node) share a name: label it once. */
        const placedPlaces = new Map<string, [number, number][]>();
        for (const place of places.slice(0, 260)) this.drawPlace(transform, place, zoom, state, satellite, placedPlaces);
      }

      /* 2. Road numbers and street names. */
      if (state.layers.roads) {
        const roads: RoadCandidate[] = [];
        for (const tile of tiles) for (const road of this.candidates(tile).roads) {
          if (Math.min(road.minZoom, road.shieldZoom) > zoom || seen.has(road.s)) continue;
          seen.add(road.s);
          roads.push(road);
        }
        roads.sort((a, b) => b.priority - a.priority);
        this.drawShields(transform, roads, zoom, state);
        this.drawRoadNames(transform, roads, zoom, state, satellite);
        const waters: RoadCandidate[] = [];
        for (const tile of tiles) for (const water of this.candidates(tile).waters) {
          if (water.minZoom > zoom || seen.has(water.s)) continue;
          seen.add(water.s);
          waters.push(water);
        }
        this.drawWaterNames(transform, waters, zoom, state);
      }
    }

    /* 3. Places of interest and businesses. */
    if (state.layers.pois || state.layers.businesses) {
      const points: PointCandidate[] = [];
      for (const tile of tiles) for (const point of this.candidates(tile).points) {
        if (point.minZoom > zoom || seen.has(point.s)) continue;
        if (point.kind === "business" && !state.layers.businesses) continue;
        if (point.kind !== "business" && !state.layers.pois) continue;
        seen.add(point.s);
        points.push(point);
      }
      points.sort((a, b) => b.priority - a.priority);
      /* Like a printed map: fewer, well-spaced markers at town scale, everything at street scale. */
      const budget = zoom >= 18 ? 420 : zoom >= 17 ? 220 : zoom >= 16 ? 110 : 50;
      const spacing = zoom >= 18 ? 2 : zoom >= 17 ? 6 : 11;
      const placedNames = new Map<string, [number, number][]>();
      let drawn = 0;
      for (const point of points) {
        if (drawn >= budget) break;
        if (this.drawPoint(transform, point, zoom, state, spacing, placedNames)) drawn += 1;
      }
      void now;
    }

    /* 4. House numbers. */
    if (state.layers.addresses && zoom >= 17.6) {
      g.font = `500 10px ${state.fonts.mono}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (const tile of tiles) for (const address of this.candidates(tile).addresses) {
        const point = transform.project(address.anchor[0], address.anchor[1], 0, this.scratch);
        if (!this.onScreen(point, 10)) continue;
        const width = this.measure(address.number, g.font) + 4;
        const box = { x0: point.x - width / 2, y0: point.y - 7, x1: point.x + width / 2, y1: point.y + 7 };
        if (this.collides(box)) continue;
        this.insert(box);
        this.text(address.number, point.x, point.y, "rgba(170,182,194,0.92)", 2.5);
      }
    }

    /* 5. Highlights, hover and selection, always on top. */
    for (const target of state.highlights) this.drawTargetMarker(transform, target, state, now, "highlight");
    if (state.hover !== null && state.hover.stableId !== state.selection?.stableId) this.drawTargetMarker(transform, state.hover, state, now, "hover");
    if (state.selection !== null) this.drawSelection(transform, state.selection, state, now);
  }

  /* ---------------------------------------------------------------- */
  /*  Candidates                                                        */
  /* ---------------------------------------------------------------- */

  private candidates(tile: DecodedRenderTile): TileCandidates {
    const id = tile.header.tileId;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const built = buildCandidates(tile);
    this.cache.set(id, built);
    return built;
  }

  /* ---------------------------------------------------------------- */
  /*  Drawing                                                           */
  /* ---------------------------------------------------------------- */

  private drawPlace(transform: MapTransform, place: PlaceCandidate, zoom: number, state: OverlayState, satellite: boolean, placedNames: Map<string, [number, number][]>): void {
    const g = this.context;
    const point = transform.project(place.anchor[0], place.anchor[1], 0, this.scratch);
    if (!this.onScreen(point, 60)) return;
    const nameKey = place.name.toLowerCase();
    const previous = placedNames.get(nameKey) ?? [];
    if (previous.some(([x, y]) => Math.hypot(x - point.x, y - point.y) < 500)) return;
    const tierSize = [21, 16, 13, 11.5][place.tier]!;
    const size = Math.min(26, tierSize + Math.max(0, zoom - 11) * (place.tier <= 1 ? 0.6 : 0.25));
    const upper = place.tier <= 2;
    const label = upper ? place.name.toUpperCase() : place.name;
    const weight = place.tier <= 1 ? 700 : place.tier === 2 ? 600 : 500;
    g.font = `${weight} ${size}px ${state.fonts.display}`;
    const spacing = upper ? size * 0.12 : 0;
    const width = this.measure(label, g.font) + spacing * label.length;
    const box = { x0: point.x - width / 2 - 4, y0: point.y - size / 2 - 3, x1: point.x + width / 2 + 4, y1: point.y + size / 2 + 3 };
    if (this.collides(box)) return;
    this.insert(box);
    previous.push([point.x, point.y]);
    placedNames.set(nameKey, previous);
    const color = place.tier <= 1 ? MACHINE.white : place.tier === 2 ? "#d6dee7" : satellite ? "#f3f6f9" : "#9fadbb";
    g.textAlign = "center";
    g.textBaseline = "middle";
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
    this.text(label, point.x, point.y, color, place.tier <= 1 ? 4 : 3);
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
    if (place.tier <= 1 && zoom < 13) {
      /* A small reticle marks the town centre at regional zoom. */
      g.strokeStyle = "rgba(245,196,0,0.85)";
      g.lineWidth = 1;
      const r = 3;
      g.strokeRect(point.x - r, point.y + size / 2 + 4, r * 2, r * 2);
    }
  }

  private drawShields(transform: MapTransform, roads: readonly RoadCandidate[], zoom: number, state: OverlayState): void {
    const g = this.context;
    const placedRefs = new Map<string, [number, number][]>();
    g.font = `700 10.5px ${state.fonts.mono}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let count = 0;
    for (const road of roads) {
      if (road.ref === undefined || road.shieldZoom > zoom) continue;
      if (count > 70) break;
      const point = transform.project(road.anchor[0], road.anchor[1], 0, this.scratch);
      if (!this.onScreen(point, 0)) continue;
      const ref = shieldText(road.ref);
      if (ref === null) continue;
      const previous = placedRefs.get(ref) ?? [];
      if (previous.some(([x, y]) => Math.hypot(x - point.x, y - point.y) < 280)) continue;
      const width = this.measure(ref, g.font) + 10;
      const box = { x0: point.x - width / 2, y0: point.y - 8, x1: point.x + width / 2, y1: point.y + 8 };
      if (this.collides(box)) continue;
      this.insert(box);
      previous.push([point.x, point.y]);
      placedRefs.set(ref, previous);
      count += 1;
      const national = ref.startsWith("N") || ref.startsWith("A") || road.style === "trunk" || road.style === "motorway";
      g.fillStyle = national ? MACHINE.yellow : "#0b0f14";
      g.strokeStyle = national ? "#3d2f00" : "#d2dbe5";
      g.lineWidth = 1;
      g.fillRect(box.x0, box.y0, width, 16);
      g.strokeRect(box.x0 + 0.5, box.y0 + 0.5, width - 1, 15);
      g.fillStyle = national ? "#0b0f14" : "#e8eef4";
      g.fillText(ref, point.x, point.y + 0.5);
    }
  }

  private drawRoadNames(transform: MapTransform, roads: readonly RoadCandidate[], zoom: number, state: OverlayState, satellite: boolean): void {
    const g = this.context;
    const placedNames = new Map<string, [number, number][]>();
    let count = 0;
    for (const road of roads) {
      if (road.name === undefined || road.minZoom > zoom) continue;
      if (count > 160) break;
      const size = road.style === "motorway" || road.style === "trunk" || road.style === "primary" ? 12 : 11;
      g.font = `600 ${size}px ${state.fonts.display}`;
      const width = this.measure(road.name, g.font);
      const mpp = transform.metresPerPixel;
      if (road.length / mpp < width * 0.75) continue;
      const a = transform.project(road.anchor[0], road.anchor[1], 0, this.scratch);
      if (!this.onScreen(a, -10)) continue;
      const step = Math.max(1, mpp * 20);
      const b = transform.project(road.anchor[0] + road.direction[0] * step, road.anchor[1] + road.direction[1] * step, 0, this.scratchB);
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const previous = placedNames.get(road.name) ?? [];
      if (previous.some(([x, y]) => Math.hypot(x - a.x, y - a.y) < 320)) continue;
      const box = rotatedBox(a.x, a.y, width + 6, size + 4, angle);
      if (this.collides(box)) continue;
      this.insert(box);
      previous.push([a.x, a.y]);
      placedNames.set(road.name, previous);
      count += 1;
      g.save();
      g.translate(a.x, a.y);
      g.rotate(angle);
      g.textAlign = "center";
      g.textBaseline = "middle";
      const major = road.style === "motorway" || road.style === "trunk";
      this.text(road.name, 0, 0, major ? MACHINE.yellowSoft : satellite ? "#ffffff" : "#c8d2dc", 3);
      g.restore();
    }
  }

  private drawWaterNames(transform: MapTransform, waters: readonly RoadCandidate[], zoom: number, state: OverlayState): void {
    const g = this.context;
    let count = 0;
    for (const water of waters) {
      if (water.name === undefined || count > 40) continue;
      g.font = `italic 500 ${zoom > 14 ? 12 : 11}px ${state.fonts.display}`;
      const width = this.measure(water.name, g.font);
      if (water.length / transform.metresPerPixel < width) continue;
      const a = transform.project(water.anchor[0], water.anchor[1], 0, this.scratch);
      if (!this.onScreen(a, -10)) continue;
      const step = transform.metresPerPixel * 20;
      const b = transform.project(water.anchor[0] + water.direction[0] * step, water.anchor[1] + water.direction[1] * step, 0, this.scratchB);
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const box = rotatedBox(a.x, a.y, width + 6, 15, angle);
      if (this.collides(box)) continue;
      this.insert(box);
      count += 1;
      g.save();
      g.translate(a.x, a.y);
      g.rotate(angle);
      g.textAlign = "center";
      g.textBaseline = "middle";
      this.text(water.name, 0, 0, "#59b8e8", 2.5);
      g.restore();
    }
  }

  private drawPoint(transform: MapTransform, candidate: PointCandidate, zoom: number, state: OverlayState, spacing: number, placedNames: Map<string, [number, number][]>): boolean {
    const point = transform.project(candidate.anchor[0], candidate.anchor[1], 0, this.scratch);
    if (!this.onScreen(point, 12)) return false;
    const size = zoom >= 17 ? 17 : 15;
    const half = size / 2;
    const nameKey = candidate.name?.toLowerCase();
    if (nameKey !== undefined && (placedNames.get(nameKey) ?? []).some(([x, y]) => Math.hypot(x - point.x, y - point.y) < 160)) return false;
    const reach = half + spacing;
    if (this.collides({ x0: point.x - reach, y0: point.y - reach, x1: point.x + reach, y1: point.y + reach })) return false;
    const markerBox = { x0: point.x - half - 1, y0: point.y - half - 1, x1: point.x + half + 1, y1: point.y + half + 1 };
    const g = this.context;
    const showName = candidate.name !== undefined && (zoom >= candidate.minZoom + 0.6 || candidate.priority > 60);
    let labelBox: Box | null = null;
    if (showName) {
      g.font = `600 11.5px ${state.fonts.display}`;
      const width = this.measure(candidate.name!, g.font);
      labelBox = { x0: point.x + half + 3, y0: point.y - 8, x1: point.x + half + 7 + width, y1: point.y + 8 };
      if (this.collides(labelBox)) labelBox = null;
    }
    this.insert(markerBox);
    if (labelBox !== null) this.insert(labelBox);
    const color = candidate.emergency ? MACHINE.red : MACHINE.white;
    this.box(point.x, point.y, size, color, candidate.emergency ? "rgba(60,4,4,0.92)" : "rgba(5,8,12,0.9)");
    drawGlyph(g, candidate.category.glyph, point.x, point.y, size - 5, color);
    if (labelBox !== null) {
      g.textAlign = "left";
      g.textBaseline = "middle";
      this.text(candidate.name!, labelBox.x0 + 2, point.y, candidate.emergency ? "#ff8a8a" : "#e3eaf1", 3);
    }
    this.placed.push({
      target: { stableId: candidate.s, kind: candidate.kind, anchor: candidate.anchor, name: candidate.name, category: candidate.category.id },
      x: point.x,
      y: point.y,
      radius: half + 6,
    });
    if (nameKey !== undefined) placedNames.set(nameKey, [...(placedNames.get(nameKey) ?? []), [point.x, point.y]]);
    return true;
  }

  private drawTargetMarker(transform: MapTransform, target: OverlayTarget, state: OverlayState, now: number, mode: "hover" | "highlight"): void {
    const point = transform.project(target.anchor[0], target.anchor[1], 0, this.scratch);
    if (!this.onScreen(point, 30)) return;
    const g = this.context;
    const color = mode === "highlight" ? MACHINE.yellow : MACHINE.white;
    const size = mode === "highlight" ? 18 : 22;
    this.brackets(point.x, point.y, size, size, color, mode === "hover" ? 1.2 : 1.5, 0.3);
    if (mode === "highlight") {
      const category = categoryDefinition(target.category);
      drawGlyph(g, category.glyph, point.x, point.y, size - 7, color);
      this.placed.push({ target, x: point.x, y: point.y, radius: size / 2 + 6 });
    }
    if (target.name !== undefined && (mode === "hover" || transform.zoom >= 13)) {
      g.font = `600 12px ${state.fonts.display}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      this.text(target.name, point.x + size / 2 + 6, point.y, mode === "highlight" ? MACHINE.yellowSoft : MACHINE.white, 3.5);
    }
    void now;
  }

  private drawSelection(transform: MapTransform, target: OverlayTarget, state: OverlayState, now: number): void {
    const g = this.context;
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    if (target.bbox !== undefined) {
      const [minE, minN, maxE, maxN] = target.bbox;
      const top = target.height ?? 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [e, n] of [[minE, minN], [maxE, minN], [maxE, maxN], [minE, maxN]] as const) {
        for (const height of top > 0 ? [0, top] : [0]) {
          const point = transform.project(e, n, height, this.scratch);
          if (!Number.isFinite(point.x)) continue;
          x0 = Math.min(x0, point.x);
          y0 = Math.min(y0, point.y);
          x1 = Math.max(x1, point.x);
          y1 = Math.max(y1, point.y);
        }
      }
      if (!Number.isFinite(x0)) return;
      x = (x0 + x1) / 2;
      y = (y0 + y1) / 2;
      w = Math.max(26, x1 - x0 + 14);
      h = Math.max(26, y1 - y0 + 14);
    } else {
      const point = transform.project(target.anchor[0], target.anchor[1], 0, this.scratch);
      if (!Number.isFinite(point.x)) return;
      x = point.x;
      y = point.y;
      w = 30;
      h = 30;
    }
    if (x < -w || y < -h || x > this.width + w || y > this.height + h) return;
    /* The Machine's admin box: yellow corner brackets that breathe, with a scan tick. */
    const pulse = 0.5 + 0.5 * Math.sin(now / 380);
    const grow = 1 + pulse * 0.06;
    this.brackets(x, y, w * grow, h * grow, MACHINE.yellow, 2, 0.28);
    g.fillStyle = "rgba(245,196,0,0.07)";
    g.fillRect(x - (w * grow) / 2, y - (h * grow) / 2, w * grow, h * grow);
    g.strokeStyle = `rgba(245,196,0,${0.25 + pulse * 0.35})`;
    g.lineWidth = 1;
    const scan = ((now / 1400) % 1) * h * grow;
    g.beginPath();
    g.moveTo(x - (w * grow) / 2 + 3, y - (h * grow) / 2 + scan);
    g.lineTo(x + (w * grow) / 2 - 3, y - (h * grow) / 2 + scan);
    g.stroke();
    if (target.name !== undefined) {
      const label = target.name.toUpperCase();
      g.font = `700 11px ${state.fonts.mono}`;
      const width = this.measure(label, g.font) + 14;
      const lx = x - (w * grow) / 2;
      const ly = y - (h * grow) / 2 - 22;
      g.fillStyle = MACHINE.yellow;
      g.fillRect(lx, ly, Math.min(width, 360), 17);
      g.fillStyle = "#06080b";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(label.length > 48 ? `${label.slice(0, 46)}…` : label, lx + 7, ly + 9);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Primitives                                                        */
  /* ---------------------------------------------------------------- */

  private box(x: number, y: number, size: number, color: string, fill: string): void {
    const g = this.context;
    const half = size / 2;
    g.fillStyle = fill;
    g.fillRect(x - half, y - half, size, size);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.strokeRect(x - half + 0.5, y - half + 0.5, size - 1, size - 1);
  }

  private brackets(x: number, y: number, w: number, h: number, color: string, lineWidth: number, armFraction: number): void {
    const g = this.context;
    const x0 = x - w / 2;
    const y0 = y - h / 2;
    const x1 = x + w / 2;
    const y1 = y + h / 2;
    const arm = Math.max(6, Math.min(w, h) * armFraction);
    g.strokeStyle = color;
    g.lineWidth = lineWidth;
    g.lineCap = "square";
    g.beginPath();
    g.moveTo(x0, y0 + arm); g.lineTo(x0, y0); g.lineTo(x0 + arm, y0);
    g.moveTo(x1 - arm, y0); g.lineTo(x1, y0); g.lineTo(x1, y0 + arm);
    g.moveTo(x1, y1 - arm); g.lineTo(x1, y1); g.lineTo(x1 - arm, y1);
    g.moveTo(x0 + arm, y1); g.lineTo(x0, y1); g.lineTo(x0, y1 - arm);
    g.stroke();
  }

  private text(value: string, x: number, y: number, color: string, halo: number): void {
    const g = this.context;
    g.lineJoin = "round";
    g.strokeStyle = MACHINE.halo;
    g.lineWidth = halo;
    g.strokeText(value, x, y);
    g.fillStyle = color;
    g.fillText(value, x, y);
  }

  private measure(text: string, font: string): number {
    const key = `${font}|${text}`;
    const cached = this.textWidthCache.get(key);
    if (cached !== undefined) return cached;
    this.context.font = font;
    const width = this.context.measureText(text).width;
    if (this.textWidthCache.size > 20_000) this.textWidthCache.clear();
    this.textWidthCache.set(key, width);
    return width;
  }

  private onScreen(point: ScreenPoint, margin: number): boolean {
    return point.visible && point.x >= -margin && point.y >= -margin && point.x <= this.width + margin && point.y <= this.height + margin;
  }

  private collides(box: Box): boolean {
    for (const key of cellsOf(box)) {
      const bucket = this.grid.get(key);
      if (bucket === undefined) continue;
      for (const other of bucket) {
        if (box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0) return true;
      }
    }
    return false;
  }

  private insert(box: Box): void {
    for (const key of cellsOf(box)) {
      const bucket = this.grid.get(key);
      if (bucket === undefined) this.grid.set(key, [box]);
      else bucket.push(box);
    }
  }
}

function cellsOf(box: Box): number[] {
  const keys: number[] = [];
  const x0 = Math.floor(box.x0 / CELL);
  const x1 = Math.floor(box.x1 / CELL);
  const y0 = Math.floor(box.y0 / CELL);
  const y1 = Math.floor(box.y1 / CELL);
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) keys.push((y + 1000) * 4096 + (x + 1000));
  return keys;
}

function rotatedBox(x: number, y: number, width: number, height: number, angle: number): Box {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const halfW = (width * cos + height * sin) / 2;
  const halfH = (width * sin + height * cos) / 2;
  return { x0: x - halfW, y0: y - halfH, x1: x + halfW, y1: y + halfH };
}

/* ------------------------------------------------------------------ */
/*  Candidate extraction (once per tile)                               */
/* ------------------------------------------------------------------ */

const SHIELD_REF = /^(A|N|D|E)\s?(\d{1,4}[A-Z]?)$/i;

/** The first official road number of a ref list, written compactly ("D 930" → "D930"); communal and exit refs get no shield. */
export function shieldText(ref: string): string | null {
  for (const part of ref.split(/\s*[/;,]\s*/)) {
    const match = SHIELD_REF.exec(part.trim());
    if (match !== null) return `${match[1]!.toUpperCase()}${match[2]!.toUpperCase()}`;
  }
  return null;
}

function placeTier(meta: FeatureMeta): { tier: 0 | 1 | 2 | 3; minZoom: number; priority: number } | null {
  const population = typeof meta.p?.pop === "number" ? meta.p.pop : 0;
  const importance = typeof meta.p?.imp === "number" ? meta.p.imp : 6;
  if (meta.c === "commune") {
    if (population >= 15_000) return { tier: 0, minZoom: 6, priority: 1000 + population / 100 };
    if (population >= 4_000) return { tier: 1, minZoom: 8.3, priority: 800 + population / 100 };
    if (population >= 1_500) return { tier: 1, minZoom: 9.4, priority: 600 + population / 100 };
    if (population >= 600) return { tier: 2, minZoom: 10.3, priority: 400 + population / 100 };
    if (population >= 250) return { tier: 2, minZoom: 11, priority: 300 + population / 100 };
    return { tier: 2, minZoom: 11.6, priority: 200 + population / 100 };
  }
  if (meta.s.includes(":toponymie/")) return null;
  switch (meta.c) {
    case "city": return { tier: 0, minZoom: 7, priority: 900 };
    case "town": return { tier: 1, minZoom: 9, priority: 650 };
    case "village": return { tier: 2, minZoom: 11, priority: 250 };
    case "suburb":
    case "quarter":
    case "neighbourhood": return { tier: 3, minZoom: 13.5, priority: 120 };
    case "hamlet":
      if (importance <= 4) return { tier: 3, minZoom: 12.5, priority: 150 - importance };
      if (importance === 5) return { tier: 3, minZoom: 13.6, priority: 100 };
      return { tier: 3, minZoom: 14.6, priority: 80 };
    case "isolated_dwelling":
    case "farm":
      return { tier: 3, minZoom: 15.2, priority: 60 };
    case "locality":
      return { tier: 3, minZoom: 15.4, priority: 50 };
    case "peak":
    case "col":
    case "valley":
      return { tier: 3, minZoom: 14.5, priority: 55 };
    default:
      return null;
  }
}

function lineSample(vertices: Float32Array, stride: number, vertexStart: number, vertexCount: number): { anchor: MapPoint; direction: MapPoint; length: number } | null {
  const points: MapPoint[] = [];
  for (let vertex = vertexStart; vertex < vertexStart + vertexCount; vertex += 2) {
    const x = vertices[vertex * stride]!;
    const z = vertices[vertex * stride + 2]!;
    const last = points[points.length - 1];
    if (last !== undefined && Math.abs(last[0] - x) < 0.01 && Math.abs(last[1] - z) < 0.01) continue;
    points.push([x, z]);
  }
  if (points.length < 2) return null;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1]);
  const half = length / 2;
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (walked + step >= half && step > 0) {
      const t = (half - walked) / step;
      return { anchor: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], direction: [(b[0] - a[0]) / step, (b[1] - a[1]) / step], length };
    }
    walked += step;
  }
  return null;
}

export function buildCandidates(tile: DecodedRenderTile): TileCandidates {
  const result: TileCandidates = { points: [], places: [], roads: [], waters: [], addresses: [] };
  const lineFeatures = new Set<number>();
  /* Lines: one sample per named road or river. */
  for (const layer of tile.layers) {
    const isRoad = ROAD_LABEL_LAYERS.includes(layer.id);
    const isWater = layer.id === "water_line";
    if (!isRoad && !isWater) continue;
    const ranges = renderLayerRanges(tile.payload, layer);
    const vertices = renderLayerVertices(tile.payload, layer);
    for (let row = 0; row < ranges.length; row += RANGE_STRIDE) {
      const metaIndex = ranges[row + 2]!;
      const meta = tile.meta[metaIndex];
      if (meta === undefined) continue;
      lineFeatures.add(metaIndex);
      if (meta.n === undefined && meta.r === undefined) continue;
      const sample = lineSample(vertices, layer.stride, ranges[row + 3]!, ranges[row + 4]!);
      if (sample === null) continue;
      if (isWater) {
        if (meta.n === undefined) continue;
        const river = meta.c === "river" || meta.c === "canal";
        result.waters.push({ s: meta.s, name: meta.n, style: "ferry", ...sample, minZoom: river ? 11.5 : 14.5, shieldZoom: 30, priority: river ? 40 : 20 });
        continue;
      }
      const style = roadStyle(meta.c);
      result.roads.push({
        s: meta.s,
        name: meta.n,
        ref: meta.r,
        style,
        ...sample,
        minZoom: ROAD_LABEL_ZOOM[style],
        shieldZoom: SHIELD_ZOOM[style],
        priority: (ROAD_STYLES.length - ROAD_STYLES.indexOf(style)) * 10 + Math.min(9, sample.length / 200),
      });
    }
  }
  for (const meta of tile.meta) {
    switch (meta.k) {
      case "place": {
        if (meta.n === undefined) break;
        const tier = placeTier(meta);
        if (tier === null) break;
        result.places.push({ s: meta.s, name: meta.n, anchor: meta.a, ...tier });
        break;
      }
      case "poi":
      case "business":
      case "landuse": {
        const category = categoryDefinition(meta.c);
        if (meta.k === "landuse" && (meta.n === undefined || category.id === "other")) break;
        if (meta.k === "poi" && category.id === "other" && meta.n === undefined) break;
        const named = meta.n !== undefined;
        const emergency = EMERGENCY.has(category.id);
        const groupWeight = emergency ? 70 : category.group === "landmark" || category.group === "culture" ? 55 : category.group === "transport" ? 45 : category.group === "health" ? 40 : 30;
        const minZoom = named ? category.minZoom : category.minZoom + 1.5;
        result.points.push({
          s: meta.s,
          kind: meta.k === "landuse" ? "poi" : meta.k,
          name: meta.n,
          category,
          anchor: meta.a,
          minZoom: meta.k === "business" ? Math.max(minZoom, 15.5) : minZoom,
          priority: groupWeight + (named ? 10 : 0) - (meta.k === "business" ? 5 : 0) + (typeof meta.p?.brand === "string" ? 6 : 0),
          emergency,
        });
        break;
      }
      case "address": {
        const number = typeof meta.p?.hn === "string" ? meta.p.hn : undefined;
        if (number !== undefined && number !== "") result.addresses.push({ number, anchor: meta.a });
        break;
      }
      case "transport": {
        if (meta.c === "station" || meta.c === "halt" || meta.c === "bus_stop" || meta.c === "aerodrome") {
          const category = categoryDefinition(meta.c === "bus_stop" ? "bus_stop" : meta.c === "aerodrome" ? "airport" : "train_station");
          result.points.push({ s: meta.s, kind: "poi", name: meta.n, category, anchor: meta.a, minZoom: category.minZoom, priority: 50, emergency: false });
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}
