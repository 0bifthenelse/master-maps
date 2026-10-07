"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BufferAttribute, BufferGeometry, DoubleSide, NoColorSpace, ShaderMaterial, Texture, TextureLoader, LinearFilter, type Mesh } from "three";
import { renderToWgs84, wgs84ToRender } from "@/lib/geo/crs";
import type { MapTransform } from "@/lib/map/transform";

/**
 * IGN Géoplateforme orthophotos (Licence Ouverte 2.0), requested as
 * Web-Mercator WMTS tiles and warped into the local Lambert-93 frame: each
 * tile is a subdivided quad whose vertices are reprojected, which absorbs the
 * ~1.6° meridian convergence between the two projections over the Gers.
 */

const WMTS_URL = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg";
const MAX_LEVEL = 19;
const MIN_LEVEL = 6;
const MAX_TILES = 72;
const SUBDIVISIONS = 4;
const CACHE_LIMIT = 260;

interface TileKey {
  level: number;
  x: number;
  y: number;
}

const keyOf = (tile: TileKey): string => `${tile.level}/${tile.x}/${tile.y}`;

function lonToTileX(lon: number, level: number): number {
  return ((lon + 180) / 360) * 2 ** level;
}

function latToTileY(lat: number, level: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** level;
}

function tileXToLon(x: number, level: number): number {
  return (x / 2 ** level) * 360 - 180;
}

function tileYToLat(y: number, level: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** level;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function satelliteTilesFor(transform: MapTransform, maxDistance: number): TileKey[] {
  const centre = transform.center;
  const corners = transform.groundFootprint(16).map(([e, n]) => {
    const dx = e - centre[0];
    const dz = n - centre[1];
    const distance = Math.hypot(dx, dz);
    const scale = distance > maxDistance ? maxDistance / distance : 1;
    return renderToWgs84([centre[0] + dx * scale, centre[1] + dz * scale]);
  });
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  let level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(transform.zoom + 0.35 + Math.log2(Math.min(2, window.devicePixelRatio || 1)) * 0.5)));
  for (;;) {
    const x0 = Math.floor(lonToTileX(Math.min(...lons), level));
    const x1 = Math.floor(lonToTileX(Math.max(...lons), level));
    const y0 = Math.floor(latToTileY(Math.max(...lats), level));
    const y1 = Math.floor(latToTileY(Math.min(...lats), level));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= MAX_TILES || level <= MIN_LEVEL) {
      const tiles: TileKey[] = [];
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) tiles.push({ level, x, y });
      return tiles;
    }
    level -= 1;
  }
}

function tileGeometry(tile: TileKey): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= SUBDIVISIONS; row += 1) {
    for (let column = 0; column <= SUBDIVISIONS; column += 1) {
      const u = column / SUBDIVISIONS;
      const v = row / SUBDIVISIONS;
      const lon = tileXToLon(tile.x + u, tile.level);
      const lat = tileYToLat(tile.y + v, tile.level);
      const [x, z] = wgs84ToRender([lon, lat]);
      positions.push(x, -0.5, z);
      uvs.push(u, 1 - v);
    }
  }
  const stride = SUBDIVISIONS + 1;
  for (let row = 0; row < SUBDIVISIONS; row += 1) {
    for (let column = 0; column < SUBDIVISIONS; column += 1) {
      const a = row * stride + column;
      indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec3 color = texture2D(uMap, vUv).rgb;
  /* Slightly darkened and cooled so the vector overlay and labels read on top. */
  color = mix(color, color * vec3(0.86, 0.9, 0.96), 0.55) * 0.92;
  gl_FragColor = vec4(color, uOpacity);
}
`;

interface LoadedTile {
  key: string;
  tile: TileKey;
  geometry: BufferGeometry;
  material: ShaderMaterial;
  texture: Texture;
  lastUsed: number;
}

const loader = new TextureLoader();
loader.setCrossOrigin("anonymous");

export interface SatelliteLayerProps {
  transform: MapTransform;
  revision: number;
  onLoaded: () => void;
}

export default function SatelliteLayer({ transform, revision, onLoaded }: SatelliteLayerProps) {
  const cache = useRef(new Map<string, LoadedTile>());
  const pending = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const wanted = useMemo(() => {
    void revision;
    return satelliteTilesFor(transform, transform.metresPerPixel * Math.max(transform.width, transform.height) * 2.5);
  }, [transform, revision]);

  useEffect(() => {
    for (const tile of wanted) {
      const key = keyOf(tile);
      if (cache.current.has(key) || pending.current.has(key)) continue;
      pending.current.add(key);
      const url = `${WMTS_URL}&TILEMATRIX=${tile.level}&TILEROW=${tile.y}&TILECOL=${tile.x}`;
      loader.load(url, (texture) => {
        pending.current.delete(key);
        texture.colorSpace = NoColorSpace;
        texture.minFilter = LinearFilter;
        texture.generateMipmaps = false;
        const material = new ShaderMaterial({
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          uniforms: { uMap: { value: texture }, uOpacity: { value: 1 } },
          transparent: true,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
        });
        cache.current.set(key, { key, tile, geometry: tileGeometry(tile), material, texture, lastUsed: performance.now() });
        if (cache.current.size > CACHE_LIMIT) {
          const sorted = [...cache.current.values()].sort((a, b) => a.lastUsed - b.lastUsed);
          for (const old of sorted.slice(0, cache.current.size - CACHE_LIMIT)) {
            old.geometry.dispose();
            old.material.dispose();
            old.texture.dispose();
            cache.current.delete(old.key);
          }
        }
        setVersion((value) => value + 1);
        onLoaded();
      }, undefined, () => {
        pending.current.delete(key);
      });
    }
  }, [wanted, onLoaded]);

  useEffect(() => () => {
    for (const entry of cache.current.values()) {
      entry.geometry.dispose();
      entry.material.dispose();
      entry.texture.dispose();
    }
    cache.current.clear();
  }, []);

  /* Draw the wanted tiles plus any loaded coarser ancestor of a missing one, so
     zooming never flashes an empty frame. */
  const visible: LoadedTile[] = [];
  const now = performance.now();
  const wantedLevel = wanted[0]?.level ?? MIN_LEVEL;
  for (const tile of wanted) {
    const loaded = cache.current.get(keyOf(tile));
    if (loaded !== undefined) {
      loaded.lastUsed = now;
      visible.push(loaded);
      continue;
    }
    for (let level = tile.level - 1; level >= Math.max(MIN_LEVEL, tile.level - 5); level -= 1) {
      const shift = tile.level - level;
      const parent = cache.current.get(keyOf({ level, x: tile.x >> shift, y: tile.y >> shift }));
      if (parent !== undefined) {
        parent.lastUsed = now;
        if (!visible.includes(parent)) visible.push(parent);
        break;
      }
    }
  }
  visible.sort((a, b) => a.tile.level - b.tile.level);

  return (
    <group>
      {visible.map((entry) => (
        <mesh
          key={entry.key}
          geometry={entry.geometry}
          material={entry.material}
          renderOrder={-10 + (entry.tile.level - wantedLevel) * 0.01}
          frustumCulled={false}
          raycast={noRaycast}
          ref={(mesh: Mesh | null) => { if (mesh !== null) mesh.matrixAutoUpdate = false; }}
        />
      ))}
    </group>
  );
}

function noRaycast(): void {}
