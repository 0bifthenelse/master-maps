import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJsonStringStream,
  streamFeatureCollection,
  streamJsonArray,
} from "../../scripts/data/normalize";

function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const values: T[] = [];
    for await (const value of stream) values.push(value);
    return values;
  })();
}

function writeFixture(name: string, content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "normalize-stream-"));
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function collectWithFile<T>(stream: { close: () => void } & AsyncIterable<T>): Promise<T[]> {
  try {
    return await collect(stream);
  } finally {
    stream.close();
  }
}

describe("json string stream", () => {
  it("reads a value whose boundary falls on every chunk position", async () => {
    const document = JSON.stringify({ values: [1, 22, 333, 4444, { nested: "x" }, "text", null, true] });
    for (let size = 1; size <= document.length; size += 1) {
      const chunks: string[] = [];
      for (let index = 0; index < document.length; index += size) chunks.push(document.slice(index, index + size));
      const values = await collect(createJsonStringStream(chunks, `size-${size}`));
      expect(values).toEqual([1, 22, 333, 4444, { nested: "x" }, "text", null, true]);
    }
  });

  it("keeps escaped strings, escaped backslashes and unicode intact across chunks", async () => {
    const document = JSON.stringify(["a\\", "quote\"inside", "line\nbreak", "tab\tchar", "accents: éàü", "emoji: 🗺️", "back\\\\slash"]);
    for (let size = 1; size <= document.length; size += 1) {
      const chunks: string[] = [];
      for (let index = 0; index < document.length; index += size) chunks.push(document.slice(index, index + size));
      const values = await collect(createJsonStringStream(chunks, `escapes-${size}`));
      expect(values).toEqual(["a\\", "quote\"inside", "line\nbreak", "tab\tchar", "accents: éàü", "emoji: 🗺️", "back\\\\slash"]);
    }
  });

  it("splits a multi-byte character across the source boundary", async () => {
    const document = JSON.stringify([" Gers éàü 🗺️ "]);
    for (let size = 1; size <= document.length; size += 1) {
      const chunks: string[] = [];
      for (let index = 0; index < document.length; index += size) chunks.push(document.slice(index, index + size));
      const values = await collect(createJsonStringStream(chunks, `utf8-${size}`));
      expect(values).toEqual([" Gers éàü 🗺️ "]);
    }
  });

  it("accepts a document without a trailing newline", async () => {
    const values = await collect(createJsonStringStream(["[1,2,3]"], "no-newline"));
    expect(values).toEqual([1, 2, 3]);
  });

  it("accepts a document with whitespace between values and after the close", async () => {
    const values = await collect(createJsonStringStream(["\n [ 1 ,\n 2 , 3 ]\n\n"], "spaced"));
    expect(values).toEqual([1, 2, 3]);
  });

  it("accepts an empty array", async () => {
    expect(await collect(createJsonStringStream(["[]"], "empty"))).toEqual([]);
  });

  it("fails on a truncated array instead of yielding a partial value", async () => {
    await expect(collect(createJsonStringStream(["[1, 2, {\"a\": "], "truncated-object"))).rejects.toThrow(/Truncated JSON document/);
  });

  it("fails on a value cut at the end of the input", async () => {
    await expect(collect(createJsonStringStream(["[1, 2, 3"], "truncated-list"))).rejects.toThrow(/Truncated JSON document/);
  });

  it("fails on a string cut at the end of the input", async () => {
    await expect(collect(createJsonStringStream(["[\"unterminated"], "truncated-string"))).rejects.toThrow(/Truncated JSON document/);
  });

  it("fails on an escaped backslash at the end of the input", async () => {
    await expect(collect(createJsonStringStream(["[\"trailing\\\\"], "truncated-escape"))).rejects.toThrow(/Truncated JSON document/);
  });
});

describe("streamJsonArray", () => {
  it("streams a named field out of a large pretty printed object", async () => {
    const records = Array.from({ length: 5_000 }, (_, index) => ({
      index,
      name: `row ${index}`,
      nested: { values: [index, index + 1] },
    }));
    const filePath = writeFixture("records.json", `${JSON.stringify({ meta: { total: records.length }, records }, null, 2)}\n`);
    const streamed = await collectWithFile(streamJsonArray(filePath, "records"));
    expect(streamed).toEqual(records);
  });

  it("streams a top level array when no field is given", async () => {
    const values = [{ a: 1 }, { a: 2 }];
    const filePath = writeFixture("plain.json", JSON.stringify(values));
    expect(await collectWithFile(streamJsonArray(filePath))).toEqual(values);
  });

  it("ignores an array nested deeper than the requested field", async () => {
    const filePath = writeFixture("nested.json", JSON.stringify({ outer: { records: [{ a: 1 }] }, records: [{ b: 2 }] }));
    expect(await collectWithFile(streamJsonArray(filePath, "records"))).toEqual([{ b: 2 }]);
  });

  it("returns nothing when the requested field is missing", async () => {
    const filePath = writeFixture("missing.json", JSON.stringify({ other: [{ a: 1 }] }));
    expect(await collectWithFile(streamJsonArray(filePath, "records"))).toEqual([]);
  });

  it("stops at the first top level array when the document is a bare array", async () => {
    const filePath = writeFixture("bare.json", JSON.stringify([{ a: 1 }, { a: 2 }]));
    expect(await collectWithFile(streamJsonArray(filePath, "records"))).toEqual([]);
  });

  it("fails on a truncated record inside the array", async () => {
    const filePath = writeFixture("truncated.json", `{"records": [{"a": 1}, {"b": `);
    await expect(collectWithFile(streamJsonArray(filePath, "records"))).rejects.toThrow(/Truncated JSON document/);
  });
});

describe("streamFeatureCollection", () => {
  it("streams GeoJSON features without reading the whole file", async () => {
    const features = Array.from({ length: 2_000 }, (_, index) => ({
      type: "Feature",
      properties: { cleabs: `ID${index}`, name: `name "quoted" ${index}` },
      geometry: { type: "Point", coordinates: [0.5 + index / 10_000, 43.5] },
    }));
    const filePath = writeFixture("layer.geojson", `${JSON.stringify({ type: "FeatureCollection", name: "layer", features }, null, 1)}\n`);
    const streamed = await collectWithFile(streamFeatureCollection(filePath));
    expect(streamed).toEqual(features);
  });

  it("reads a real export layout with one feature per line", async () => {
    const head = '{\n"type": "FeatureCollection",\n"name": "troncon_de_route",\n"features": [\n';
    const rows = Array.from({ length: 500 }, (_, index) => `${JSON.stringify({
      type: "Feature",
      properties: { cleabs: `T${index}` },
      geometry: { type: "LineString", coordinates: [[0.1, 43.1], [0.2, 43.2]] },
    })},\n`).join("");
    const filePath = writeFixture("roads.geojson", `${head}${rows}]\n}\n`);
    const streamed = await collectWithFile(streamFeatureCollection(filePath));
    expect(streamed).toHaveLength(500);
    expect(streamed[0]?.properties).toEqual({ cleabs: "T0" });
    expect(streamed[499]?.properties).toEqual({ cleabs: "T499" });
  });

  it("fails when the document is not a feature collection", async () => {
    const filePath = writeFixture("bad.geojson", JSON.stringify({ type: "Something" }));
    await expect(collectWithFile(streamFeatureCollection(filePath))).rejects.toThrow(/Invalid GeoJSON FeatureCollection/);
  });
});
