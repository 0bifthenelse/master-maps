import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { MapFeatureSchema, TileManifestSchema, type Geometry, type MapFeature } from "@/lib/data/schema";
import { decodeRenderTile } from "@/lib/render/codec";

const BOUNDARY: unknown[] = [{
  stableId: "boundary:32",
  kind: "boundary",
  territoryCode: "32",
  geometry: { type: "Polygon", coordinates: [[[-4000, -4000], [-4000, 4000], [4000, 4000], [4000, -4000], [-4000, -4000]]] },
  localGeometry: { type: "Polygon", coordinates: [[[-4000, -4000], [-4000, 4000], [4000, 4000], [4000, -4000], [-4000, -4000]]] },
  lon: 0.5,
  lat: 43.6,
  x: 0,
  z: 0,
}];

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const CHILD_SCRIPT = [
  `const { buildTilesAll } = require(${JSON.stringify(`${REPO_ROOT}scripts/data/build-tiles.ts`)});`,
  'const { readFileSync } = require("node:fs");',
  "const [, , inDir, tiles, render, meta, size, jsonTiles] = process.argv;",
  'buildTilesAll(inDir, tiles, Number(size), render, "9.9.9", meta, jsonTiles === "1", { quiet: true }).then(() => {',
  '  const peak = Number(/VmHWM:\\s*(\\d+)/.exec(readFileSync("/proc/self/status", "utf8"))[1]);',
  '  process.stdout.write(JSON.stringify({ peakRss: peak }));',
  "});",
].join("\n");

interface RunResult { root: string; generated: string; tiles: string; render: string; meta: string; manifest: TileManifest[]; peakRss: number }

function square(cx: number, cz: number, half: number): Geometry {
  return { type: "Polygon", coordinates: [[[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half], [cx - half, cz - half]]] };
}

function cross(cx: number, cz: number, half: number): Geometry {
  return { type: "LineString", coordinates: [[cx - half, cz], [cx, cz - half], [cx + half, cz], [cx, cz + half], [cx - half, cz]] };
}

function canonical(kind: string, stableId: string, geometry: Geometry, extra: Record<string, unknown> = {}): MapFeature {
  return MapFeatureSchema.parse({
    kind,
    stableId,
    geometry,
    localGeometry: geometry,
    x: 0,
    z: 0,
    provenance: [{ featureId: stableId, property: "geometry", winner: "fixture", contenders: ["fixture"], priority: 1, timestamp: "2026-01-01T00:00:00Z" }],
    sourceRefs: [{ source: "fixture", timestamp: "2026-01-01T00:00:00Z" }],
    ...extra,
  });
}

function grid(count: number, kind: string, build: (index: number) => Geometry, extra: Record<string, unknown> = {}): unknown[] {
  const features: unknown[] = [];
  for (let index = 0; index < count; index += 1) features.push(canonical(kind, `${kind}:${index}`, build(index), extra));
  return features;
}

function buildInChild(root: string, tileSize: number, emitJsonTiles: boolean): Promise<{ peakRss: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ peakRss: number }>();
  const child = spawn(
    process.execPath,
    [
      "--import", "tsx", join(root, "run-build.cjs"),
      join(root, "intermediate"),
      join(root, "generated", "tiles"),
      join(root, "generated", "render"),
      join(root, "generated", "meta"),
      String(tileSize),
      emitJsonTiles ? "1" : "0",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) { reject(new Error(`child build exited with ${String(code)}: ${errors}`)); return; }
    resolve(JSON.parse(out) as { peakRss: number });
  });
  return promise;
}

async function runFixture(features: unknown[], options: { tileSize?: number; emitJsonTiles?: boolean } = {}): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), "tiles-throughput-"));
  await mkdir(join(root, "intermediate"), { recursive: true });
  await writeFile(join(root, "intermediate", "features.json"), JSON.stringify(features), "utf8");
  await writeFile(join(root, "intermediate", "boundary.json"), JSON.stringify(BOUNDARY), "utf8");
  await writeFile(join(root, "run-build.cjs"), CHILD_SCRIPT, "utf8");
  const child = await buildInChild(root, options.tileSize ?? 2048, options.emitJsonTiles === true);
  const generated = join(root, "generated");
  const manifest = (JSON.parse(await readFile(join(generated, "tile-manifest.json"), "utf8")) as unknown[]).map((entry) => TileManifestSchema.parse(entry));
  return {
    root,
    generated,
    tiles: join(generated, "tiles"),
    render: join(generated, "render"),
    meta: join(generated, "meta"),
    manifest,
    peakRss: child.peakRss * 1024,
  };
}

describe("build-tiles streaming output", () => {
  it("completes a large level in bounded peak memory and leaves no stale tile behind on a rebuild", async () => {
    const features = grid(40_000, "building", (index) => square((index % 200) * 30 - 3000, Math.floor(index / 200) * 30 - 3000, 6));
    const root = await mkdtemp(join(tmpdir(), "tiles-memory-"));
    await mkdir(join(root, "intermediate"), { recursive: true });
    await writeFile(join(root, "intermediate", "features.json"), JSON.stringify(features), "utf8");
    await writeFile(join(root, "intermediate", "boundary.json"), JSON.stringify(BOUNDARY), "utf8");
    await writeFile(join(root, "run-build.cjs"), CHILD_SCRIPT, "utf8");
    const first = await buildInChild(root, 512, false);
    const manifest = (JSON.parse(await readFile(join(root, "generated", "tile-manifest.json"), "utf8")) as unknown[]).map((entry) => TileManifestSchema.parse(entry));
    expect(manifest.length).toBeGreaterThan(1);
    expect(first.peakRss * 1024).toBeLessThan(2 * 2 ** 30);
    const second = await buildInChild(root, 512, false);
    const rebuilt = (JSON.parse(await readFile(join(root, "generated", "tile-manifest.json"), "utf8")) as unknown[]).map((entry) => TileManifestSchema.parse(entry));
    expect(second.peakRss * 1024).toBeLessThan(2 * 2 ** 30);
    expect(rebuilt.map((entry) => entry.tileId)).toEqual(manifest.map((entry) => entry.tileId));
    const renderNames = (await readdir(join(root, "generated", "render"))).filter((name) => name.endsWith(".mmt"));
    expect(renderNames.filter((name) => name !== "boundary.mmt").length).toBe(manifest.length);
    expect(renderNames).toContain("boundary.mmt");
    const sidecarNames = (await readdir(join(root, "generated", "meta"))).filter((name) => name.endsWith(".json.gz"));
    expect(sidecarNames.filter((name) => name !== "boundary.json.gz").length).toBe(manifest.length);
    expect(sidecarNames).toContain("boundary.json.gz");
    await rm(root, { recursive: true, force: true });
  }, 600_000);

  it("subdivides an oversized tile until every emitted tile respects the render and sidecar ceilings", async () => {
    const features = grid(2_000, "building", (index) => square((index % 40) * 12 - 800, Math.floor(index / 40) * 12 - 800, 2));
    expect(grid(2_000, "building", (index) => square((index % 40) * 12 - 800, Math.floor(index / 40) * 12 - 800, 2)).length).toBe(2_000);
    const result = await runFixture(features);
    expect(result.manifest.length).toBeGreaterThan(1);
    let largestTile = 0;
    let largestSidecar = 0;
    for (const entry of result.manifest) {
      const tile = (await stat(join(result.render, `${entry.tileId}.mmt`))).size;
      const sidecar = (await stat(join(result.meta, `${entry.tileId}.json.gz`))).size;
      expect(tile).toBeLessThanOrEqual(2 * 2 ** 20);
      expect(sidecar).toBeLessThanOrEqual(2 * 2 ** 20);
      if (tile > largestTile) largestTile = tile;
      if (sidecar > largestSidecar) largestSidecar = sidecar;
    }
    const subdivided = result.manifest.filter((entry) => /_s\d+_\d+_\d+$/.test(entry.tileId));
    expect(subdivided.length).toBeGreaterThan(0);
    for (const entry of subdivided) {
      expect(entry.bounds[2] - entry.bounds[0]).toBeLessThan(2048);
      expect(entry.bounds[3] - entry.bounds[1]).toBeLessThan(2048);
    }
    expect(largestTile).toBeGreaterThan(0);
    expect(largestSidecar).toBeGreaterThan(0);
    await rm(result.root, { recursive: true, force: true });
  }, 600_000);

  it("fragments a feature across tiles and keeps one fragment id per tile", async () => {
    const line = [canonical("road", "road:spanning", cross(0, 0, 6000), { roadClass: "residential", highway: "residential" })];
    const result = await runFixture(line);
    const index = (JSON.parse(await readFile(join(result.generated, "tile-index.json"), "utf8")) as unknown[]).map((entry) => TileManifestSchema.parse(entry));
    expect(index.length).toBeGreaterThan(3);
    expect(index.every((entry) => entry.features?.length === entry.featureCount)).toBe(true);
    expect(new Set(index.flatMap((entry) => entry.fragmentIds ?? [])).size).toBe(index.length);
    for (const entry of index) {
      const sidecar = JSON.parse(gunzipSync(await readFile(join(result.meta, `${entry.tileId}.json.gz`))).toString("utf8")) as Array<Record<string, unknown>>;
      expect(sidecar).toHaveLength(entry.featureCount);
      for (const feature of sidecar) {
        expect(feature).not.toHaveProperty("geometry");
        expect(feature).not.toHaveProperty("localGeometry");
        expect(feature).not.toHaveProperty("sourceGeometry");
        expect(feature.fragmentId).toBe(`road:spanning@${entry.tileId}`);
      }
    }
    await rm(result.root, { recursive: true, force: true });
  }, 300_000);

  it("emits render tiles whose indices and feature range metaIndex values are all in range", async () => {
    const features = [
      ...grid(2_000, "building", (index) => square((index % 40) * 40 - 800, Math.floor(index / 40) * 40 - 800, 12)),
      ...grid(1_200, "road", (index) => cross((index % 30) * 60 - 900, Math.floor(index / 30) * 60 - 900, 40), { roadClass: "residential", highway: "residential" }),
      ...grid(600, "poi", (index) => ({ type: "Point", coordinates: [(index % 20) * 90 - 900, Math.floor(index / 20) * 90 - 900] } as Geometry), { poiType: "restaurant" }),
    ];
    const result = await runFixture(features);
    const renderFiles = (await readdir(result.render)).filter((name) => name.endsWith(".mmt"));
    expect(renderFiles).toContain("boundary.mmt");
    expect(renderFiles.length).toBe(result.manifest.length + 1);
    let checkedRanges = 0;
    for (const name of renderFiles) {
      const buffer = await readFile(join(result.render, name));
      const decoded = decodeRenderTile(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
      expect(decoded.header.tileId).toBe(name.slice(0, -".mmt".length));
      for (const layer of decoded.layers) {
        const vertexCount = layer.positionLength / 3;
        const indices = new Uint32Array(decoded.payload, layer.indexOffset, layer.indexLength);
        for (const index of indices) expect(index).toBeLessThan(vertexCount);
        const ranges = new Uint32Array(decoded.payload, layer.rangeOffset, layer.rangeLength);
        expect(ranges.length % 3).toBe(0);
        for (let entry = 0; entry < ranges.length; entry += 3) {
          expect(ranges[entry]! + ranges[entry + 1]!).toBeLessThanOrEqual(indices.length);
          expect(ranges[entry + 2]!).toBeLessThan(decoded.meta.length);
          checkedRanges += 1;
        }
      }
    }
    expect(checkedRanges).toBeGreaterThan(1_000);
    await rm(result.root, { recursive: true, force: true });
  }, 300_000);

  it("writes no spool file, no fat tile by default, and reports a clean audit", async () => {
    const features = grid(1_500, "water", (index) => cross((index % 25) * 50 - 600, Math.floor(index / 25) * 50 - 600, 30), { waterType: "river" });
    const result = await runFixture(features);
    const tileFiles = await readdir(result.tiles);
    expect(tileFiles.filter((name) => name.endsWith(".pass1"))).toEqual([]);
    expect(tileFiles.filter((name) => name.endsWith(".json"))).toEqual([]);
    const rendered = (await readdir(result.render)).filter((name) => name.endsWith(".mmt"));
    const compressed = (await readdir(result.render)).filter((name) => name.endsWith(".mmt.gz"));
    const sidecars = (await readdir(result.meta)).filter((name) => name.endsWith(".json.gz"));
    expect(rendered.filter((name) => name !== "boundary.mmt").length).toBe(result.manifest.length);
    expect(compressed.filter((name) => name !== "boundary.mmt.gz").length).toBe(result.manifest.length);
    expect(sidecars.filter((name) => name !== "boundary.json.gz").length).toBe(result.manifest.length);
    expect(rendered).toContain("boundary.mmt");
    expect(compressed).toContain("boundary.mmt.gz");
    expect(sidecars).toContain("boundary.json.gz");
    const metrics = JSON.parse(await readFile(join(result.generated, "tile-metrics.json"), "utf8")) as { validation: { structuralFailures: number; zodFailures: number } };
    expect(metrics.validation.structuralFailures).toBe(0);
    expect(metrics.validation.zodFailures).toBe(0);
    await rm(result.root, { recursive: true, force: true });
  }, 300_000);

  it("emits fat canonical JSON tiles whose payload is the array the manifest byteSize projects", async () => {
    const features = grid(900, "building", (index) => square((index % 20) * 60 - 600, Math.floor(index / 20) * 60 - 600, 10));
    const result = await runFixture(features, { emitJsonTiles: true });
    const index = (JSON.parse(await readFile(join(result.generated, "tile-index.json"), "utf8")) as unknown[]).map((entry) => TileManifestSchema.parse(entry));
    let projectedTotal = 0;
    let realTotal = 0;
    for (const entry of index) {
      const raw = await readFile(join(result.tiles, `${entry.tileId}.json`), "utf8");
      const parsed = JSON.parse(raw) as MapFeature[];
      expect(parsed).toHaveLength(entry.featureCount);
      expect(raw.endsWith("\n")).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(parsed))).toBe(entry.byteSize);
      expect(Buffer.byteLength(raw)).toBe(entry.byteSize + 1);
      for (const feature of parsed) expect(MapFeatureSchema.safeParse(feature).success).toBe(true);
      const sidecar = JSON.parse(gunzipSync(await readFile(join(result.meta, `${entry.tileId}.json.gz`))).toString("utf8")) as unknown[];
      expect(sidecar).toHaveLength(entry.featureCount);
      projectedTotal += entry.byteSize;
      realTotal += (await stat(join(result.tiles, `${entry.tileId}.json`))).size;
    }
    expect(projectedTotal).toBe(realTotal - index.length);
    expect(realTotal).toBeGreaterThan(0);
    await rm(result.root, { recursive: true, force: true });
  }, 300_000);

  it("rejects a corrupt intermediate record instead of writing a partial dataset", async () => {
    const root = await mkdtemp(join(tmpdir(), "tiles-corrupt-"));
    await mkdir(join(root, "intermediate"), { recursive: true });
    await writeFile(join(root, "intermediate", "features.json"), JSON.stringify([canonical("building", "building:0", square(0, 0, 5))]), "utf8");
    await writeFile(join(root, "intermediate", "boundary.json"), JSON.stringify(BOUNDARY), "utf8");
    await writeFile(join(root, "run-build.cjs"), CHILD_SCRIPT, "utf8");
    await writeFile(join(root, "intermediate", "broken.json"), "[\n{\"stableId\":\"building:1\",\"kind\":\"building\",\"geometry\":{\"type\":\"Polygon\"\n]\n", "utf8");
    await expect(buildInChild(root, 2048, false)).rejects.toThrow(/SyntaxError|JSON/);
    await rm(root, { recursive: true, force: true });
  }, 300_000);
});
