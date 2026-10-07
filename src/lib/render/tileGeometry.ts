import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Sphere, Vector3 } from "three";
import {
  RENDER_LAYER_KINDS,
  renderLayerEdges,
  renderLayerIndices,
  renderLayerRanges,
  renderLayerVertices,
  type DecodedRenderLayer,
  type DecodedRenderTile,
} from "./codec";

/**
 * BufferGeometry views over a decoded tile slab. Nothing is copied: the
 * interleaved buffer aliases the Float32 vertex section, the index aliases
 * the Uint32 index section.
 */
export function createLayerGeometry(tile: DecodedRenderTile, layer: DecodedRenderLayer): BufferGeometry | null {
  const vertices = renderLayerVertices(tile.payload, layer);
  const indices = renderLayerIndices(tile.payload, layer);
  if (vertices.length === 0 || indices.length === 0) return null;
  const interleaved = new InterleavedBuffer(vertices, layer.stride);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new InterleavedBufferAttribute(interleaved, 3, 0));
  switch (RENDER_LAYER_KINDS[layer.id]) {
    case "fill":
      geometry.setAttribute("aStyle", new InterleavedBufferAttribute(interleaved, 1, 3));
      break;
    case "line":
      geometry.setAttribute("aExtrude", new InterleavedBufferAttribute(interleaved, 2, 3));
      geometry.setAttribute("aHalfWidth", new InterleavedBufferAttribute(interleaved, 1, 5));
      geometry.setAttribute("aStyle", new InterleavedBufferAttribute(interleaved, 1, 6));
      geometry.setAttribute("aDistance", new InterleavedBufferAttribute(interleaved, 1, 7));
      break;
    case "extrusion":
      geometry.setAttribute("aHeight", new InterleavedBufferAttribute(interleaved, 1, 3));
      geometry.setAttribute("aStyle", new InterleavedBufferAttribute(interleaved, 1, 4));
      break;
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.boundingSphere = tileSphere(tile);
  geometry.userData = { tileId: tile.header.tileId, layerId: layer.id, ranges: renderLayerRanges(tile.payload, layer) };
  return geometry;
}

/** Roof outline hairlines: same vertex buffer, edge index pairs. */
export function createEdgeGeometry(tile: DecodedRenderTile, layer: DecodedRenderLayer, shared: BufferGeometry): BufferGeometry | null {
  const edges = renderLayerEdges(tile.payload, layer);
  if (edges.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", shared.getAttribute("position"));
  geometry.setIndex(new BufferAttribute(edges, 1));
  geometry.boundingSphere = shared.boundingSphere;
  return geometry;
}

function tileSphere(tile: DecodedRenderTile): Sphere {
  const [minX, minZ, maxX, maxZ] = tile.header.bounds;
  const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 200;
  return new Sphere(new Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2), radius);
}
