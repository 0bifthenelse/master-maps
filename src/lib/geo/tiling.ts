/**
 * Lambert-93 tile grid. Coordinates use x=easting and z=northing relative to
 * the documented render origin. Tile assignment uses complete feature bounds.
 */

import { Bounds2D } from './bounds';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TileBudget {
  /** True when the grid satisfies both constraints. */
  passes: boolean;
  /** Byte-size estimate for the largest tile (0 = unknown / not measured). */
  largestTileBytes: number;
  /** Total tiles in the grid. */
  tileCount: number;
}

export interface TileCoord {
  col: number;
  row: number;
}
export interface TileLevel {
  level: 0 | 1 | 2;
  tileSize: number;
}

export const GERS_TILE_LEVELS: readonly TileLevel[] = [
  { level: 0, tileSize: 2048 },
  { level: 1, tileSize: 8192 },
  { level: 2, tileSize: 32768 },
];

export function chooseTileLevel(visibleSpanMetres: number): TileLevel {
  if (visibleSpanMetres <= 12000) return GERS_TILE_LEVELS[0]!;
  if (visibleSpanMetres <= 60000) return GERS_TILE_LEVELS[1]!;
  return GERS_TILE_LEVELS[2]!;
}

// ---------------------------------------------------------------------------
// TilingSystem
// ---------------------------------------------------------------------------

export class TilingSystem {
  readonly tileSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly numCols: number;
  readonly numRows: number;

  private readonly _bounds: Bounds2D;

  /**
   * @param bounds  Commune or dataset bounding box (Bouds2D uses minY/maxY
   *                for the north axis; internally mapped to z).
   * @param tileSize  Edge length in local metres. Must be > 0.
   */
  constructor(bounds: Bounds2D, tileSize: number) {
    if (tileSize <= 0) {
      throw new Error(`tileSize must be positive, got ${tileSize}`);
    }
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    if (w <= 0 || h <= 0) {
      throw new Error(
        `Invalid bounds: (${bounds.minX}, ${bounds.minY}) – (${bounds.maxX}, ${bounds.maxY})`,
      );
    }

    this._bounds = bounds;
    this.tileSize = tileSize;
    this.originX = bounds.minX;
    this.originZ = bounds.minY; // minY = south = min z

    this.numCols = Math.ceil(w / tileSize);
    this.numRows = Math.ceil(h / tileSize);
  }

  // -----------------------------------------------------------------------
  // Coordinate → tile
  // -----------------------------------------------------------------------

  /**
   * Resolve a local (x, z) position to its tile coordinate pair.
   * The max-edge boundary is clamped so that a coordinate exactly on the
   * outer edge lands in the last tile.
   */
  positionToCoord(x: number, z: number): TileCoord {
    let col = Math.floor((x - this.originX) / this.tileSize);
    let row = Math.floor((z - this.originZ) / this.tileSize);

    // Clamp to valid range (handles points on the inclusive max edge).
    if (col >= this.numCols) col = this.numCols - 1;
    if (row >= this.numRows) row = this.numRows - 1;
    if (col < 0) col = 0;
    if (row < 0) row = 0;

    return { col, row };
  }

  /**
   * Deterministic tile ID from a local (x, z) position.
   * ID format: `"<col>_<row>"` — parseable via `idToCoord()`.
   */
  getTileId(x: number, z: number): string {
    const { col, row } = this.positionToCoord(x, z);
    return this.coordToId(col, row);
  }

  /** Deterministic tile ID from grid indices. */
  coordToId(col: number, row: number): string {
    return `${col}_${row}`;
  }

  /** Reverse-lookup: parse a tile ID produced by this system. */
  idToCoord(tileId: string): TileCoord {
    const parts = tileId.split('_');
    const col = Number(parts[0]);
    const row = Number(parts[1]);
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      throw new Error(`Invalid tile ID "${tileId}"`);
    }
    return { col, row };
  }

  // -----------------------------------------------------------------------
  // Tile → bounding box
  // -----------------------------------------------------------------------

  /**
   * Return the half-open bounds for a tile.
   *
   * Normal tiles: [min, max) with exclusive upper edge.
   * Max-edge tiles (furthest col, furthest row): [min, max] inclusive so
   * the commune boundary position at exactly maxX/maxY is covered.
   */
  getTileBounds(tileId: string): Bounds2D {
    const { col, row } = this.idToCoord(tileId);
    return this.tileBoundsFromCoord(col, row);
  }

  private tileBoundsFromCoord(col: number, row: number): Bounds2D {
    const minX = this.originX + col * this.tileSize;
    const minY = this.originZ + row * this.tileSize; // minY = south edge in Bounds2D
    
    // Exclusive upper bound (half-open), unless on the max edge.
    let maxX: number;
    let maxY: number;

    if (col === this.numCols - 1) {
      maxX = this._bounds.maxX; // inclusive
    } else {
      maxX = this.originX + (col + 1) * this.tileSize; // exclusive
    }

    if (row === this.numRows - 1) {
      maxY = this._bounds.maxY; // inclusive
    } else {
      maxY = this.originZ + (row + 1) * this.tileSize; // exclusive
    }

    return { minX, minY, maxX, maxY };
  }

  // -----------------------------------------------------------------------
  // Feature assignment
  // -----------------------------------------------------------------------

  /**
   * Determine which tile(s) a feature's local bounding box occupies.
   *
   * @param localBounds  Feature's extent in local metres. The caller extracts
   *                     the feature's local bounds (rich feature types from
   *                     `src/lib/data/schema.ts` have a `localBounds` field).
   *                     Use `{ minX, minZ, maxX, maxZ }` where z = north
   *                     (maps to Bounds2D's minY/maxY).
   * @returns  Stable tile IDs for every tile the bounds intersect.
   */
  assignFeatureToTile(localBounds: {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
  }): string[] {
    const minCol = Math.max(
      0,
      Math.floor((localBounds.minX - this.originX) / this.tileSize),
    );
    const maxCol = Math.min(
      this.numCols - 1,
      Math.floor((localBounds.maxX - this.originX) / this.tileSize),
    );
    const minRow = Math.max(
      0,
      Math.floor((localBounds.minZ - this.originZ) / this.tileSize),
    );
    const maxRow = Math.min(
      this.numRows - 1,
      Math.floor((localBounds.maxZ - this.originZ) / this.tileSize),
    );

    const tiles: string[] = [];
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        tiles.push(this.coordToId(col, row));
      }
    }
    return tiles;
  }

  /** Convenience overload accepting a Bounds2D (which uses minY/maxY for north). */
  assignBoundsToTile(bounds: Bounds2D): string[] {
    return this.assignFeatureToTile({
      minX: bounds.minX,
      minZ: bounds.minY,  // Bounds2D minY = south = min z
      maxX: bounds.maxX,
      maxZ: bounds.maxY,  // Bounds2D maxY = north = max z
    });
  }

  // -----------------------------------------------------------------------
  // Grid queries
  // -----------------------------------------------------------------------

  /** Total number of tiles in the grid. */
  tileCount(): number {
    return this.numCols * this.numRows;
  }

  /** All tile IDs in row-major order (south→north, west→east). */
  allTileIds(): string[] {
    const ids: string[] = [];
    for (let row = 0; row < this.numRows; row++) {
      for (let col = 0; col < this.numCols; col++) {
        ids.push(this.coordToId(col, row));
      }
    }
    return ids;
  }

  /**
   * Structural budget check.
   *
   * `largestTileBytes` is left at 0 because actual byte measurements require
   * built tile data. The caller (`build-tiles.ts` or `validate.ts`) fills
   * in measured values after tile generation.
   *
   * @param maxTiles      Maximum permitted tile count.
   * @param maxTileBytes  Maximum permitted uncompressed tile byte size.
   * @param measuredBytes Optional measured largest-tile byte count from
   *                      actual generated tiles. When omitted/hon-ero the
   *                      byte constraint is skipped.
   */
  budgetCheck(
    maxTiles: number,
    maxTileBytes: number,
    measuredBytes?: number,
  ): TileBudget {
    const tc = this.tileCount();
    const largest = measuredBytes ?? 0;
    const passesCount = tc <= maxTiles;
    const passesBytes = largest <= maxTileBytes;
    return {
      passes: passesCount && passesBytes,
      tileCount: tc,
      largestTileBytes: largest,
    };
  }
}