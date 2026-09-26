'use client';

/**
 * @file Bridge entre un pick et le groupe de surlignage.
 *
 * CityScene stays free of highlight state: this component owns one
 * THREE.Group for the scene lifetime, swaps the highlight whenever the
 * selected pick changes, and disposes the previous geometry and
 * material on every swap and on unmount. It must be rendered inside the
 * R3F Canvas.
 *
 * The pick carries the range index it was resolved from, which is the
 * only way to address a point feature: every point range starts at
 * vertex index 0, so a face scan alone always returns the first point of
 * the layer.
 */
import { useEffect, useRef } from 'react';
import { getResidentDecodedTile } from '@/lib/render/tileGpuCache';
import type { DecodedRenderTile } from '@/lib/render/codec';
import { renderLayerRanges } from '@/lib/render/codec';
import {
  buildFeatureHighlight,
  clearFeatureHighlight,
  createHighlightGroup,
  setFeatureHighlight,
  type HighlightGroup,
  type PickedFeature,
} from '@/lib/scene/highlight';

export interface FeatureHighlightLayerProps {
  pick: PickedFeature | null;
}

/** Vertex index that addresses the range the pick was resolved from. */
function indexOfRange(tile: DecodedRenderTile, pick: PickedFeature): number | null {
  for (const layer of tile.layers) {
    if (layer.id !== pick.layer) continue;
    const ranges = renderLayerRanges(tile.payload, layer);
    const start = ranges[pick.rangeIndex * 3];
    const count = ranges[pick.rangeIndex * 3 + 1];
    const metaIndex = ranges[pick.rangeIndex * 3 + 2];
    if (start === undefined || count === undefined || metaIndex === undefined) return null;
    if (tile.meta[metaIndex]?.s !== pick.stableId) return null;
    return count === 0 ? pick.rangeIndex : start;
  }
  return null;
}

export default function FeatureHighlightLayer({ pick }: FeatureHighlightLayerProps) {
  const groupRef = useRef<HighlightGroup | null>(null);
  if (groupRef.current === null) groupRef.current = createHighlightGroup();
  const group = groupRef.current;

  useEffect(() => {
    if (pick === null) {
      clearFeatureHighlight(group);
      return;
    }
    const tile = getResidentDecodedTile(pick.tileId);
    if (tile === undefined) {
      clearFeatureHighlight(group);
      return;
    }
    const index = indexOfRange(tile, pick);
    if (index === null) {
      clearFeatureHighlight(group);
      return;
    }
    setFeatureHighlight(group, buildFeatureHighlight({ tile, layer: pick.layer, index }));
  }, [group, pick]);

  useEffect(() => () => clearFeatureHighlight(group), [group]);

  return <primitive object={group} />;
}
