"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  LinearFilter,
  MeshBasicMaterial,
  Vector3,
  type Mesh,
  type OrthographicCamera,
  type Texture,
} from "three";
import type { DecodedRenderTile } from "@/lib/render/codec";
import { getResidentDecodedTiles } from "@/lib/render/tileGpuCache";
import {
  MAX_ADDRESS_LABELS_PER_MEGAPIXEL,
  MAX_CANDIDATE_POOL,
  MAX_VISIBLE_LABELS,
  buildLabelCandidates,
  countByKind,
  findOverlaps,
  layoutLabels,
  zoomBand,
  type LabelCandidate,
  type LabelKind,
  type LabelProjection,
  type PlacedLabel,
} from "@/lib/scene/labels";

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_SIZE_PX = 13;
const TEXT_EM_WIDTH = 0.56;
const ATLAS_CELL_HEIGHT = Math.round(FONT_SIZE_PX * 1.45);
const ATLAS_PADDING = 3;
const ATLAS_MAX_WIDTH = 2048;
const LABEL_RENDER_ORDER = 40;
const LABEL_OPACITY = 0.92;
const FADE_MS = 160;
const CANDIDATE_INTERVAL_MS = 250;
const LAYOUT_INTERVAL_MS = 60;
const QUAD_Y_LIFT = 0.25;

const LABEL_COLOR: Readonly<Record<LabelKind, string>> = {
  place: "#000000",
  street: "#000000",
  poi: "#ff7d27",
  business: "#ff7d27",
  transport: "#ff7d27",
  address: "#000000",
};

const LABEL_WEIGHT: Readonly<Record<LabelKind, string>> = {
  place: "700",
  street: "500",
  poi: "600",
  business: "600",
  transport: "600",
  address: "500",
};

export interface LabelDiagnostics {
  placed: number;
  candidates: number;
  zoom: number;
  counts: Record<LabelKind, number>;
  overlaps: number;
  atlasCells: number;
  reducedMotion: boolean;
  worldPerPixel: number;
  visible: boolean;
}

declare global {
  interface Window {
    __masterMapsLabels?: LabelDiagnostics;
  }
}

export interface LabelLayerProps {
  /** Tile ids whose decoded metadata is resident, in render order. */
  tileIds: readonly string[];
  /** Layer toggles owned by LayerControls. */
  layers: Record<string, boolean>;
}

interface AtlasEntry {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  pixelWidth: number;
}

interface Atlas {
  texture: Texture;
  entries: Map<string, AtlasEntry>;
}

interface QuadCorner {
  x: number;
  z: number;
  u: number;
  v: number;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function atlasKey(label: PlacedLabel): string {
  return `${label.kind}|${label.text}`;
}

/**
 * One canvas holds every distinct string currently on screen. The atlas is
 * rebuilt only when the placed set changes, so a static view pays for the
 * rasterisation once and the per-frame cost stays a projection plus a grid
 * pass over the candidate pool.
 */
function buildAtlas(labels: readonly PlacedLabel[]): Atlas | null {
  if (typeof document === "undefined" || labels.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_MAX_WIDTH;
  canvas.height = ATLAS_CELL_HEIGHT + ATLAS_PADDING * 2;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "middle";
  context.textAlign = "left";
  const entries = new Map<string, AtlasEntry>();
  let cursorX = ATLAS_PADDING;
  const baseline = canvas.height / 2;
  for (const label of labels) {
    const key = atlasKey(label);
    if (entries.has(key)) continue;
    const width = Math.ceil(label.text.length * FONT_SIZE_PX * TEXT_EM_WIDTH) + ATLAS_PADDING * 2;
    if (cursorX + width > canvas.width) break;
    context.font = `${LABEL_WEIGHT[label.kind]} ${FONT_SIZE_PX}px ${FONT_STACK}`;
    context.fillStyle = LABEL_COLOR[label.kind];
    context.fillText(label.text, cursorX, baseline);
    entries.set(key, { u0: cursorX / canvas.width, v0: 0, u1: (cursorX + width) / canvas.width, v1: 1, pixelWidth: width });
    cursorX += width;
  }
  if (entries.size === 0) return null;
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, entries };
}

/**
 * One quad per label, in world units, billboarded by cancelling the camera
 * heading. The quad extent is derived from the measured pixel box, so the
 * glyphs keep a constant on-screen size at every zoom level.
 */
function buildLabelGeometry(placed: readonly PlacedLabel[], atlas: Atlas, worldPerPixel: number): BufferGeometry {
  const count = placed.length;
  const positions = new Float32Array(count * 4 * 3);
  const uvs = new Float32Array(count * 4 * 2);
  const indices = new Uint32Array(count * 6);
  for (let index = 0; index < count; index += 1) {
    const label = placed[index]!;
    const entry = atlas.entries.get(atlasKey(label));
    if (entry === undefined) continue;
    const halfWidth = (entry.pixelWidth / 2) * worldPerPixel;
    const halfHeight = (ATLAS_CELL_HEIGHT / 2) * worldPerPixel;
    const y = label.y + QUAD_Y_LIFT;
    const corners: readonly QuadCorner[] = [
      { x: label.x - halfWidth, z: label.z - halfHeight, u: entry.u0, v: entry.v0 },
      { x: label.x + halfWidth, z: label.z - halfHeight, u: entry.u1, v: entry.v0 },
      { x: label.x + halfWidth, z: label.z + halfHeight, u: entry.u1, v: entry.v1 },
      { x: label.x - halfWidth, z: label.z + halfHeight, u: entry.u0, v: entry.v1 },
    ];
    for (let slot = 0; slot < 4; slot += 1) {
      const corner = corners[slot]!;
      const vertex = index * 4 + slot;
      positions[vertex * 3] = corner.x;
      positions[vertex * 3 + 1] = y;
      positions[vertex * 3 + 2] = corner.z;
      uvs[vertex * 2] = corner.u;
      uvs[vertex * 2 + 1] = corner.v;
    }
    const base = index * 6;
    indices[base] = index * 4;
    indices[base + 1] = index * 4 + 1;
    indices[base + 2] = index * 4 + 2;
    indices[base + 3] = index * 4;
    indices[base + 4] = index * 4 + 2;
    indices[base + 5] = index * 4 + 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const scratch = new Vector3();

/**
 * Orthographic world-to-screen projection built from the live camera matrices,
 * so it follows pan, zoom and heading without any duplicated camera maths.
 * A label quad is then billboarded by rotating its own corners about the
 * anchor, which keeps the glyphs upright under any heading.
 */
function createProjection(camera: OrthographicCamera, width: number, height: number): LabelProjection {
  const viewProjection = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const worldWidth = (camera.right - camera.left) / (camera.zoom || 1);
  const project = (x: number, z: number): readonly [number, number] | null => {
    scratch.set(x, 0, z).applyMatrix4(viewProjection);
    const ndcX = scratch.x;
    const ndcY = scratch.y;
    if (ndcX < -1.4 || ndcX > 1.4 || ndcY < -1.4 || ndcY > 1.4) return null;
    return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
  };
  return { width, height, project, metresPerPixel: worldWidth / width };
}

export default function LabelLayer({ tileIds, layers }: LabelLayerProps) {
  const meshRef = useRef<Mesh>(null);
  const size = useThree((state) => state.size);
  const candidatesRef = useRef<LabelCandidate[]>([]);
  const placedRef = useRef<PlacedLabel[]>([]);
  const geometryRef = useRef<BufferGeometry | null>(null);
  const textureRef = useRef<Texture | null>(null);
  const candidateSignatureRef = useRef("");
  const layoutSignatureRef = useRef("");
  const lastCandidateAtRef = useRef(-Infinity);
  const lastLayoutAtRef = useRef(-Infinity);
  const opacityRef = useRef(0);
  const reducedMotionRef = useRef(false);

  const material = useMemo(() => new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: DoubleSide,
    opacity: 0,
  }), []);

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion();
  }, []);

  useEffect(() => () => {
    material.dispose();
    geometryRef.current?.dispose();
    textureRef.current?.dispose();
  }, [material]);

  const labelFlags = useMemo(() => ({
    places: layers.places !== false,
    pois: layers.pois !== false,
    business: layers.pois !== false,
    transport: layers.transport !== false,
    addresses: layers.pois !== false && layers.addresses !== false,
    streets: layers.roads !== false,
  }), [layers.places, layers.pois, layers.transport, layers.addresses, layers.roads]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const camera = state.camera as OrthographicCamera;
    if (!camera.isOrthographicCamera) return;
    const now = state.clock.elapsedTime * 1000;
    const zoom = camera.zoom || 1;
    const band = zoomBand(zoom);

    const candidateSignature = `${tileIds.length}|${band}|${labelFlags.places}${labelFlags.pois}${labelFlags.business}${labelFlags.transport}${labelFlags.addresses}${labelFlags.streets}`;
    if (candidateSignature !== candidateSignatureRef.current && now - lastCandidateAtRef.current >= CANDIDATE_INTERVAL_MS) {
      candidateSignatureRef.current = candidateSignature;
      lastCandidateAtRef.current = now;
      candidatesRef.current = buildLabelCandidates(residentTiles(), band, labelFlags, MAX_CANDIDATE_POOL);
    }

    if (now - lastLayoutAtRef.current >= LAYOUT_INTERVAL_MS) {
      lastLayoutAtRef.current = now;
      const projection = createProjection(camera, size.width, size.height);
      const placed = layoutLabels(candidatesRef.current, projection, { fontSize: FONT_SIZE_PX, maxLabels: MAX_VISIBLE_LABELS });
      const signature = placed.length === 0
        ? "empty"
        : placed.map((label) => `${atlasKey(label)}@${label.screenX.toFixed(0)},${label.screenY.toFixed(0)}`).join(";");
      if (signature !== layoutSignatureRef.current) {
        layoutSignatureRef.current = signature;
        placedRef.current = placed;
        const atlas = buildAtlas(placed);
        if (atlas !== null) {
          const geometry = buildLabelGeometry(placed, atlas, projection.metresPerPixel);
          if (geometryRef.current !== null) geometryRef.current.dispose();
          if (textureRef.current !== null) textureRef.current.dispose();
          geometryRef.current = geometry;
          textureRef.current = atlas.texture;
          material.map = atlas.texture;
          material.needsUpdate = true;
          mesh.geometry = geometry;
        }
        publishLabelDiagnostics(placed, candidatesRef.current.length, zoom, projection, atlasCellCount(placed), reducedMotionRef.current);
      }
    }

    const targetOpacity = placedRef.current.length > 0 ? LABEL_OPACITY : 0;
    if (reducedMotionRef.current) {
      opacityRef.current = targetOpacity;
    } else {
      opacityRef.current += (targetOpacity - opacityRef.current) * Math.min(1, (delta * 1000) / FADE_MS);
    }
    material.opacity = opacityRef.current;
    mesh.visible = opacityRef.current > 0.01;
  });

  return <mesh ref={meshRef} material={material} renderOrder={LABEL_RENDER_ORDER} frustumCulled={false} visible={false} />;
}

/** Decoded tiles the scene is currently drawing, in render order. */
function residentTiles(): DecodedRenderTile[] {
  return [...getResidentDecodedTiles().values()];
}

function atlasCellCount(placed: readonly PlacedLabel[]): number {
  const unique = new Set<string>();
  for (const label of placed) unique.add(atlasKey(label));
  return unique.size;
}

function publishLabelDiagnostics(
  placed: readonly PlacedLabel[],
  candidates: number,
  zoom: number,
  projection: LabelProjection,
  atlasCells: number,
  reducedMotion: boolean,
): void {
  if (typeof window === "undefined") return;
  window.__masterMapsLabels = {
    placed: placed.length,
    candidates,
    zoom,
    counts: countByKind(placed),
    overlaps: findOverlaps(placed).length,
    atlasCells,
    reducedMotion,
    worldPerPixel: projection.metresPerPixel,
    visible: true,
  };
}

export { MAX_ADDRESS_LABELS_PER_MEGAPIXEL };
