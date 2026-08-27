export type Wgs84Point = [number, number];

export interface OsmNodeElement {
  type: "node";
  id: number;
  lon: number;
  lat: number;
  tags?: Record<string, string>;
}

export interface OsmWayElement {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OsmRelationMember {
  type: string;
  ref: number;
  role: string;
}

export interface OsmRelationElement {
  type: "relation";
  id: number;
  members: OsmRelationMember[];
  tags?: Record<string, string>;
}

export type OsmElement = OsmNodeElement | OsmWayElement | OsmRelationElement;

export interface RelationGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: Wgs84Point[][] | Wgs84Point[][][];
}

export interface RelationReconstruction {
  relationId: number;
  geometry: RelationGeometry;
  memberWayIds: number[];
}

export interface RelationIssue {
  relationId: number;
  reason: string;
  memberWayIds: number[];
}

interface Segment {
  wayId: number;
  nodeIds: number[];
  coordinates: Wgs84Point[];
}

export function isOsmElement(value: Record<string, unknown>): value is OsmElement {
  if (
    typeof value.type !== "string"
    || typeof value.id !== "number"
    || !Number.isFinite(value.id)
  ) {
    return false;
  }
  if (value.type === "node") {
    return (
      typeof value.lon === "number"
      && Number.isFinite(value.lon)
      && typeof value.lat === "number"
      && Number.isFinite(value.lat)
    );
  }
  if (value.type === "way") {
    return (
      Array.isArray(value.nodes)
      && value.nodes.every((node) => typeof node === "number" && Number.isFinite(node))
    );
  }
  if (value.type === "relation") {
    return (
      Array.isArray(value.members)
      && value.members.every((member) =>
        typeof member === "object"
        && member !== null
        && typeof (member as Record<string, unknown>).type === "string"
        && typeof (member as Record<string, unknown>).ref === "number"
        && Number.isFinite((member as Record<string, unknown>).ref)
        && typeof (member as Record<string, unknown>).role === "string"
      )
    );
  }
  return false;
}

export function deduplicateOsmElements(elements: OsmElement[]): OsmElement[] {
  const byKey = new Map<string, OsmElement>();
  for (const element of elements) {
    const key = `${element.type}/${element.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, element);
      continue;
    }
    const mergedTags = {
      ...(existing.tags ?? {}),
      ...(element.tags ?? {}),
    };
    if (Object.keys(mergedTags).length > 0) {
      existing.tags = mergedTags;
    }
  }
  return [...byKey.values()];
}

export function reconstructMultipolygonRelation(
  relation: OsmRelationElement,
  ways: ReadonlyMap<number, OsmWayElement>,
  nodes: ReadonlyMap<number, Wgs84Point>,
): RelationReconstruction | RelationIssue {
  const roleMembers = relation.members.filter(
    (member) => member.type === "way" && (member.role === "outer" || member.role === "inner"),
  );
  const memberWayIds = [...new Set(roleMembers.map((member) => member.ref))];
  if (roleMembers.length === 0) {
    return {
      relationId: relation.id,
      reason: "relation has no outer or inner way members",
      memberWayIds,
    };
  }

  const missingWayIds = memberWayIds.filter((wayId) => !ways.has(wayId));
  if (missingWayIds.length > 0) {
    return {
      relationId: relation.id,
      reason: `missing member way(s): ${missingWayIds.join(", ")}`,
      memberWayIds,
    };
  }

  const outerSegments = buildSegments(roleMembers, "outer", ways, nodes, relation.id);
  if ("reason" in outerSegments) return { ...outerSegments, memberWayIds };
  const innerSegments = buildSegments(roleMembers, "inner", ways, nodes, relation.id);
  if ("reason" in innerSegments) return { ...innerSegments, memberWayIds };

  const outerRings = joinSegments(outerSegments, relation.id);
  if ("reason" in outerRings) return { ...outerRings, memberWayIds };
  const innerRings = joinSegments(innerSegments, relation.id);
  if ("reason" in innerRings) return { ...innerRings, memberWayIds };

  const polygons: Wgs84Point[][][] = outerRings.rings.map((outer) => [orientRing(outer, "outer")]);
  for (const inner of innerRings.rings) {
    const owner = polygons.find((polygon) => pointInRing(inner[0], polygon[0]));
    if (!owner) {
      return {
        relationId: relation.id,
        reason: "inner ring is not contained by any outer ring",
        memberWayIds,
      };
    }
    owner.push(orientRing(inner, "inner"));
  }

  if (polygons.length === 1) {
    return {
      relationId: relation.id,
      geometry: { type: "Polygon", coordinates: polygons[0] },
      memberWayIds,
    };
  }
  return {
    relationId: relation.id,
    geometry: { type: "MultiPolygon", coordinates: polygons },
    memberWayIds,
  };
}

function buildSegments(
  members: OsmRelationMember[],
  role: "outer" | "inner",
  ways: ReadonlyMap<number, OsmWayElement>,
  nodes: ReadonlyMap<number, Wgs84Point>,
  relationId: number,
): Segment[] | RelationIssue {
  const segments: Segment[] = [];
  const seenWayIds = new Set<number>();
  for (const member of members) {
    if (member.type !== "way" || member.role !== role || seenWayIds.has(member.ref)) continue;
    seenWayIds.add(member.ref);
    const way = ways.get(member.ref);
    if (!way) {
      return {
        relationId,
        reason: `missing ${role} member way ${member.ref}`,
        memberWayIds: [member.ref],
      };
    }
    if (way.nodes.length < 2) {
      return {
        relationId,
        reason: `${role} member way ${member.ref} has fewer than two nodes`,
        memberWayIds: [member.ref],
      };
    }
    const coordinates: Wgs84Point[] = [];
    for (const nodeId of way.nodes) {
      const coordinate = nodes.get(nodeId);
      if (!coordinate) {
        return {
          relationId,
          reason: `missing node ${nodeId} referenced by ${role} member way ${member.ref}`,
          memberWayIds: [member.ref],
        };
      }
      coordinates.push(coordinate);
    }
    segments.push({ wayId: member.ref, nodeIds: way.nodes.slice(), coordinates });
  }
  return segments;
}
function joinSegments(
  segments: Segment[],
  relationId: number,
): { rings: Wgs84Point[][] } | RelationIssue {
  const unused = new Set(segments.map((_, index) => index));
  const rings: Wgs84Point[][] = [];

  while (unused.size > 0) {
    const firstIndex = unused.values().next().value as number;
    unused.delete(firstIndex);
    const first = segments[firstIndex];
    const nodeIds = first.nodeIds.slice();
    const coordinates = first.coordinates.slice();

    while (nodeIds[0] !== nodeIds[nodeIds.length - 1]) {
      const endpoint = nodeIds[nodeIds.length - 1];
      let matchedIndex: number | undefined;
      let reversed = false;

      for (const candidateIndex of unused) {
        const candidate = segments[candidateIndex];
        const candidateStart = candidate.nodeIds[0];
        const candidateEnd = candidate.nodeIds[candidate.nodeIds.length - 1];
        if (candidateStart === endpoint) {
          matchedIndex = candidateIndex;
          reversed = false;
          break;
        }
        if (candidateEnd === endpoint) {
          matchedIndex = candidateIndex;
          reversed = true;
          break;
        }
      }

      if (matchedIndex === undefined) {
        return {
          relationId,
          reason: `member segments do not form a closed ring at node ${endpoint}`,
          memberWayIds: segments.map((segment) => segment.wayId),
        };
      }

      unused.delete(matchedIndex);
      const matched = segments[matchedIndex];
      const nextNodeIds = reversed ? matched.nodeIds.slice().reverse() : matched.nodeIds;
      const nextCoordinates = reversed ? matched.coordinates.slice().reverse() : matched.coordinates;
      nodeIds.push(...nextNodeIds.slice(1));
      coordinates.push(...nextCoordinates.slice(1));
    }

    if (coordinates.length < 4 || nodeIds[0] !== nodeIds[nodeIds.length - 1]) {
      return {
        relationId,
        reason: "reconstructed ring is not closed or has fewer than three vertices",
        memberWayIds: segments.map((segment) => segment.wayId),
      };
    }
    rings.push(coordinates);
  }

  return { rings };
}

function signedArea(ring: Wgs84Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function orientRing(ring: Wgs84Point[], role: "outer" | "inner"): Wgs84Point[] {
  const area = signedArea(ring);
  const shouldReverse = role === "outer" ? area < 0 : area > 0;
  return shouldReverse ? ring.slice().reverse() : ring.slice();
}

function pointInRing(point: Wgs84Point, ring: Wgs84Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (
      (current[1] > point[1]) !== (previous[1] > point[1])
      && point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) / (previous[1] - current[1]) + current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}
