import { z } from "zod";
import { FEATURE_KINDS } from "./schema";

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 25;
export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 256;

export const SearchHitSchema = z.object({
  featureId: z.string().min(1),
  canonicalName: z.string().min(1),
  kind: z.enum(FEATURE_KINDS),
  category: z.string().optional(),
  tileId: z.string().min(1),
  focusLon: z.number().finite(),
  focusLat: z.number().finite(),
  score: z.number(),
  matchType: z.enum(["exact", "accent-insensitive", "prefix", "contains", "edit-distance"]),
}).strict();
export type SearchHit = z.infer<typeof SearchHitSchema>;
