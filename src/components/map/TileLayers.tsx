"use client";

import { forwardRef, useEffect, useMemo, useRef } from "react";
import type { BufferGeometry, Group } from "three";
import type { DecodedRenderTile, RenderLayerId } from "@/lib/render/codec";
import { createEdgeGeometry, createLayerGeometry } from "@/lib/render/tileGeometry";
import { buildingEdgesMaterial, layerMaterials } from "@/lib/render/tileMaterials";

export interface LayerVisibility {
  buildings: boolean;
  roads: boolean;
  water: boolean;
  landuse: boolean;
  boundaries: boolean;
  transport: boolean;
}

interface TilePart {
  layerId: RenderLayerId;
  geometry: BufferGeometry;
  edges: BufferGeometry | null;
}

/* Geometry per decoded tile, created lazily and disposed when the tile leaves the scene. */
const parts = new WeakMap<DecodedRenderTile, TilePart[]>();

function tileParts(tile: DecodedRenderTile): TilePart[] {
  const cached = parts.get(tile);
  if (cached !== undefined) return cached;
  const built: TilePart[] = [];
  for (const layer of tile.layers) {
    const geometry = createLayerGeometry(tile, layer);
    if (geometry === null) continue;
    built.push({ layerId: layer.id, geometry, edges: layer.id === "building" ? createEdgeGeometry(tile, layer, geometry) : null });
  }
  parts.set(tile, built);
  return built;
}

function disposeParts(tile: DecodedRenderTile): void {
  const built = parts.get(tile);
  if (built === undefined) return;
  for (const part of built) {
    part.geometry.dispose();
    part.edges?.dispose();
  }
  parts.delete(tile);
}

function visibleLayer(layerId: RenderLayerId, visibility: LayerVisibility): boolean {
  switch (layerId) {
    case "building": return visibility.buildings;
    case "road":
    case "road_bridge":
    case "road_tunnel": return visibility.roads;
    case "water_area":
    case "water_line": return visibility.water;
    case "landcover": return visibility.landuse;
    case "boundary": return visibility.boundaries;
    case "rail":
    case "transport_area": return visibility.transport;
    default: return true;
  }
}

const noRaycast = (): void => undefined;

export interface TileLayersProps {
  tiles: readonly DecodedRenderTile[];
  visibility: LayerVisibility;
}

/**
 * One mesh per tile and layer (plus a casing pass for roads and a hairline
 * pass for roof outlines). Building meshes live in their own group so the
 * picker can raycast them without walking the whole scene.
 */
const TileLayers = forwardRef<Group, TileLayersProps>(function TileLayers({ tiles, visibility }, buildingsRef) {
  const materials = layerMaterials();
  const edgeMaterial = buildingEdgesMaterial();
  const mounted = useRef(new Set<DecodedRenderTile>());

  /* Dispose the GPU buffers of tiles that left the scene, one frame after unmount. */
  useEffect(() => {
    const next = new Set(tiles);
    const leaving = [...mounted.current].filter((tile) => !next.has(tile));
    mounted.current = next;
    if (leaving.length === 0) return;
    const handle = requestAnimationFrame(() => {
      for (const tile of leaving) if (!mounted.current.has(tile)) disposeParts(tile);
    });
    return () => cancelAnimationFrame(handle);
  }, [tiles]);

  useEffect(() => () => {
    for (const tile of mounted.current) disposeParts(tile);
    mounted.current.clear();
  }, []);

  const elements = useMemo(() => {
    const ground: React.ReactNode[] = [];
    const buildings: React.ReactNode[] = [];
    /* Coarser tiles first so detail drawn on top wins where levels overlap. */
    const ordered = [...tiles].sort((a, b) => b.header.lod - a.header.lod);
    ordered.forEach((tile, tileIndex) => {
      const lodBias = (2 - tile.header.lod) * 0.001 + tileIndex * 0.000001;
      for (const part of tileParts(tile)) {
        if (!visibleLayer(part.layerId, visibility)) continue;
        const passes = materials.get(part.layerId);
        if (passes === undefined) continue;
        const key = `${tile.header.tileId}:${part.layerId}`;
        if (part.layerId === "building") {
          buildings.push(<mesh key={key} geometry={part.geometry} material={passes.main} renderOrder={passes.order} frustumCulled={false} />);
          if (part.edges !== null) {
            buildings.push(<lineSegments key={`${key}:edges`} geometry={part.edges} material={edgeMaterial} renderOrder={passes.order + 1} frustumCulled={false} raycast={noRaycast} />);
          }
          continue;
        }
        if (passes.under !== undefined) {
          ground.push(<mesh key={`${key}:under`} geometry={part.geometry} material={passes.under} renderOrder={passes.order - 0.5 + lodBias} frustumCulled={false} raycast={noRaycast} />);
        }
        ground.push(<mesh key={key} geometry={part.geometry} material={passes.main} renderOrder={passes.order + lodBias} frustumCulled={false} raycast={noRaycast} />);
      }
    });
    return { ground, buildings };
  }, [tiles, visibility, materials, edgeMaterial]);

  return (
    <>
      <group>{elements.ground}</group>
      <group ref={buildingsRef}>{elements.buildings}</group>
    </>
  );
});

export default TileLayers;
