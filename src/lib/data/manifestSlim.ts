import { TileManifestSchema, type TileManifest } from "./schema";

export type SlimTileManifest = Pick<TileManifest, "tileId" | "lod" | "bounds" | "byteSize" | "featureCount">;

export interface SlimTileManifestFields {
  tiles: SlimTileManifest[];
  bounds: [number, number, number, number];
  tileCount: number;
}

export function slimTileManifestEntry(manifest: TileManifest): SlimTileManifest {
  return {
    tileId: manifest.tileId,
    lod: manifest.lod,
    bounds: manifest.bounds,
    byteSize: manifest.byteSize,
    featureCount: manifest.featureCount,
  };
}

export function slimTileManifestEntries(entries: readonly TileManifest[]): SlimTileManifest[] {
  return entries.map(slimTileManifestEntry);
}

export function tileManifestUnionBounds(entries: readonly TileManifest[]): [number, number, number, number] {
  const first = entries[0]!;
  return entries.reduce<[number, number, number, number]>(
    (accumulator, tile) => [
      Math.min(accumulator[0], tile.bounds[0]),
      Math.min(accumulator[1], tile.bounds[1]),
      Math.max(accumulator[2], tile.bounds[2]),
      Math.max(accumulator[3], tile.bounds[3]),
    ],
    [...first.bounds] as [number, number, number, number],
  );
}

export function parseTileManifestList(raw: unknown): TileManifest[] {
  if (!Array.isArray(raw)) throw new Error("tile manifest must be an array");
  return raw.map((value) => TileManifestSchema.parse(value));
}
