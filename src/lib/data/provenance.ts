// ---------------------------------------------------------------------------
// Master Maps — Provenance & source-priority conflict resolution
//
// Every feature property that could carry conflicting values from multiple
// sources is resolved through this module.  The result is always a
// ProvenanceRecord that preserves every contender, the winning source, the
// rationale (priority ordering), and a UTC timestamp.
//
// Stable-ID and geometry-deduplication strategies live in deduplicate.ts;
// this module handles per-property value conflicts within a known feature.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local type declarations — match the expected schema.ts contract
// These will be replaced by imports once src/lib/data/schema.ts exists.
// ---------------------------------------------------------------------------

/** Represents a single source contributing to a feature property. */
export interface SourceReference {
  source: string;
  url?: string;
  timestamp: string; // ISO 8601 UTC
  license?: string;
  sha256?: string;
  recordCount?: number;
}

/**
 * Records the resolution of one property where multiple sources disagreed.
 * Stored per feature and made visible in the inspector.
 */
export interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string; // winning source name
  contenders: string[]; // all source names that supplied a value
  priority: number; // the winning source's ordinal (1 = highest)
  timestamp: string; // ISO 8601 UTC — when the conflict was resolved
}

// ---------------------------------------------------------------------------
// Source priority constants
// ---------------------------------------------------------------------------

/**
 * Ordinal priority of each source family.
 * Lower number = higher priority.
 * 1 is the most authoritative; 7 is corroboration-only.
 */
export const SOURCE_PRIORITY = {
  OFFICIAL_ADMIN: 1,
  IGN: 2,
  OSM: 3,
  BAN: 4,
  SIRENE: 5,
  BUSINESS_WEBSITE: 6,
  GOOGLE_MAPS: 7,
} as const;

export type SourcePriorityKey =
  (typeof SOURCE_PRIORITY)[keyof typeof SOURCE_PRIORITY];

/** Canonical priority ordering from highest to lowest authority. */
export const PRIORITY_ORDER: readonly string[] = Object.entries(SOURCE_PRIORITY)
  .sort(([, a], [, b]) => a - b)
  .map(([key]) => key.toLowerCase().replace(/_/g, " "));

/**
 * Map a source-name string to its ordinal priority.
 * Accepts common forms: "OSM", "osm", "OpenStreetMap", "IGN", "BAN",
 * "official admin", "SIRENE", "business website", "Google Maps".
 * Unknown sources get priority 99.
 */
export function priorityForSource(source: string): number {
  const normalized = source.toLowerCase().trim();

  // Direct key match
  if (normalized in SOURCE_PRIORITY) return SOURCE_PRIORITY[normalized as keyof typeof SOURCE_PRIORITY];

  // Common aliases
  if (normalized === "openstreetmap" || normalized === "overpass") return SOURCE_PRIORITY.OSM;
  if (normalized === "ban" || normalized === "base adresse nationale") return SOURCE_PRIORITY.BAN;
  if (normalized === "annuaire des entreprises" || normalized === "insee") return SOURCE_PRIORITY.SIRENE;
  if (normalized.startsWith("google")) return SOURCE_PRIORITY.GOOGLE_MAPS;
  if (normalized.includes("admin") || normalized === "geo.api.gouv.fr") return SOURCE_PRIORITY.OFFICIAL_ADMIN;
  if (normalized === "ign" || normalized === "géoplateforme" || normalized.includes("geoplateforme")) return SOURCE_PRIORITY.IGN;
  if (normalized.includes("sirene")) return SOURCE_PRIORITY.SIRENE;
  if (normalized.includes("website") || normalized.includes("site web")) return SOURCE_PRIORITY.BUSINESS_WEBSITE;

  return 99;
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

export interface PropertyContender {
  /** Canonical source name (e.g. "BAN", "OSM", "SIRENE"). */
  source: string;
  /** The value this source supplied for the property. */
  value: unknown;
}

export interface ConflictResolution {
  /** The winning value. */
  winner: unknown;
  /** Every contender that participated in the resolution. */
  contenders: PropertyContender[];
  /** The ProvenanceRecord describing this resolution. */
  provenance: ProvenanceRecord;
}

/**
 * Resolve a property conflict among multiple source values.
 *
 * Uses the supplied `priorityOrder` (source names from highest to lowest
 * priority) to pick the winner.  Ties between contenders from the same
 * source-priority level are broken by preferring the value with the earlier
 * source timestamp (lexicographic ISO 8601, i.e. oldest authoritative
 * record wins among equal-priority sources).
 *
 * @param featureId  Stable feature ID.
 * @param property   Property key (e.g. "name", "address", "height").
 * @param values     Array of contenders, each with a source name and value.
 * @param priorityOrder  Source names in descending priority (first = highest).
 * @param timestamps Optional map of source → ISO-8601 timestamp for tie-breaking.
 */
export function resolvePropertyConflict(
  featureId: string,
  property: string,
  values: PropertyContender[],
  priorityOrder: readonly string[] = PRIORITY_ORDER,
  timestamps?: Record<string, string>,
): ConflictResolution {
  if (values.length === 0) {
    throw new RangeError(
      `resolvePropertyConflict: no values supplied for ${featureId}.${property}`,
    );
  }

  // Build a lookup of source → priority for O(1) access.
  const priorityLookup: Record<string, number> = {};
  priorityOrder.forEach((src, idx) => {
    const lower = src.toLowerCase();
    // Register both the raw form and the lowercased form.
    priorityLookup[src] = idx + 1;
    if (lower !== src) priorityLookup[lower] = idx + 1;
  });

  // If no explicit priority order match, fall back to priorityForSource.
  const effectivePriority = (src: string): number => {
    const direct = priorityLookup[src];
    if (direct !== undefined) return direct;
    const lower = priorityLookup[src.toLowerCase()];
    if (lower !== undefined) return lower;
    return priorityForSource(src);
  };

  // Sort contenders: highest priority (lowest number) first, then by
  // earliest timestamp among equal-priority entries.
  const sorted = [...values].sort((a, b) => {
    const pa = effectivePriority(a.source);
    const pb = effectivePriority(b.source);
    if (pa !== pb) return pa - pb;

    // Same priority — earliest timestamp wins.
    if (timestamps) {
      const ta = timestamps[a.source] ?? "";
      const tb = timestamps[b.source] ?? "";
      const cmp = ta.localeCompare(tb);
      if (cmp !== 0) return cmp;
    }

    // Stable: preserve input order as final tiebreaker.
    return values.indexOf(a) - values.indexOf(b);
  });

  const winner = sorted[0];
  if (winner === undefined) {
    throw new RangeError(
      `resolvePropertyConflict: no values supplied for ${featureId}.${property}`,
    );
  }
  const sourceNames = values.map((v) => v.source);
  const uniqueSources = [...new Set(sourceNames)];

  const provenance: ProvenanceRecord = {
    featureId,
    property,
    winner: winner.source,
    contenders: uniqueSources,
    priority: effectivePriority(winner.source),
    timestamp: new Date().toISOString(),
  };

  return {
    winner: winner.value,
    contenders: values,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Provenance-record builders
// ---------------------------------------------------------------------------

/**
 * Build a ProvenanceRecord directly from known winner, contenders, and
 * the source priority.
 */
export function buildProvenanceRecord(
  featureId: string,
  property: string,
  winner: string,
  contenders: string[],
): ProvenanceRecord {
  const uniqueContenders = [...new Set(contenders)];
  return {
    featureId,
    property,
    winner,
    contenders: uniqueContenders,
    priority: priorityForSource(winner),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Feature merge — source-priority aware
// ---------------------------------------------------------------------------

/**
 * Shape of a MapFeature — matches the expected discriminated union contract.
 * Imported projects should use MapFeature from schema.ts directly.
 */
export interface MapFeatureLike {
  id: string;
  kind: string;
  provenance?: ProvenanceRecord[];
  [key: string]: unknown;
}

/**
 * Merge two features using source priority for every property.
 *
 * `existing` is the current canonical record; `incoming` is a newly acquired
 * or updated record from any source.  For each property where both features
 * supply a value, resolvePropertyConflict is called with the incoming source
 * as a contender against the existing value's source (from provenance history
 * or the source field on the feature).
 *
 * Rules:
 * - Properties unique to `existing` or `incoming` are kept as-is.
 * - Conflicting properties are resolved by source priority.
 * - Every conflict generates a ProvenanceRecord appended to the merged
 *   feature's provenance list.
 * - The merged feature keeps the stable ID of `existing`.
 * - `kind` must match between both features; a mismatch throws TypeError.
 *
 * @param existing   Current canonical feature (with an `id` and `source`).
 * @param incoming   Incoming feature from a new source or refresh.
 * @param sourceMap  Optional mapping of property → source name when the
 *                   feature doesn't carry per-property source metadata.
 *                   Defaults to `incoming.source` for all incoming properties.
 */
export function mergeFeatures(
  existing: MapFeatureLike,
  incoming: MapFeatureLike,
  sourceMap?: Record<string, string>,
): MapFeatureLike {
  if (existing.kind !== incoming.kind) {
    throw new TypeError(
      `mergeFeatures: kind mismatch — existing="${existing.kind}" ` +
        `incoming="${incoming.kind}" (id=${existing.id})`,
    );
  }

  const merged: MapFeatureLike = {
    id: existing.id,
    kind: existing.kind,
    provenance: [...(existing.provenance ?? [])],
  };

  // Collect all property keys from both features (skip internal keys).
  const skipKeys: Record<string, true> = {
    id: true,
    kind: true,
    provenance: true,
    source: true,
  };
  const allKeys = new Set([
    ...Object.keys(existing).filter((k) => !(k in skipKeys)),
    ...Object.keys(incoming).filter((k) => !(k in skipKeys)),
  ]);

  // We need the source of the existing feature for conflict resolution.
  // It lives on the feature itself as `source` (a string) or we fall back
  // to "unknown".
  const existingSource =
    (typeof existing.source === "string" ? existing.source : undefined) ?? "unknown";
  const incomingSource =
    (typeof incoming.source === "string" ? incoming.source : undefined) ?? "unknown";

  // Build a timestamp map with fallback to now.
  const timestamps: Record<string, string> = {};
  timestamps[existingSource] =
    typeof existing.timestamp === "string"
      ? existing.timestamp
      : new Date().toISOString();
  timestamps[incomingSource] =
    typeof incoming.timestamp === "string"
      ? incoming.timestamp
      : new Date().toISOString();

  for (const key of allKeys) {
    const hasExisting = key in existing;
    const hasIncoming = key in incoming;

    if (!hasExisting) {
      // Only incoming has this property — keep it.
      merged[key] = incoming[key];
      continue;
    }

    if (!hasIncoming) {
      // Only existing has this property — keep it.
      merged[key] = existing[key];
      continue;
    }

    const existingVal = existing[key];
    const incomingVal = incoming[key];

    // If values are strictly equal, no conflict.
    if (existingVal === incomingVal) {
      merged[key] = existingVal;
      continue;
    }

    // Resolve conflict via source priority.
    const propertySourceForIncoming = sourceMap?.[key] ?? incomingSource;

    const resolution = resolvePropertyConflict(
      existing.id,
      key,
      [
        { source: existingSource, value: existingVal },
        { source: propertySourceForIncoming, value: incomingVal },
      ],
      PRIORITY_ORDER,
      timestamps,
    );

    merged[key] = resolution.winner;
    merged.provenance!.push(resolution.provenance);
  }

  return merged;
}