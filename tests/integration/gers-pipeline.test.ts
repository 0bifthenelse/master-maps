import { describe, expect, it } from "vitest";
import { GERS_TERRITORY } from "@/lib/data/territory";
import anchors from "../fixtures/gers-landmark-anchors.json";

describe("Gers production territory contract", () => {
  it("uses department 32 and keeps distributed regression anchors", () => {
    expect(GERS_TERRITORY.code).toBe("32");
    expect(GERS_TERRITORY.name).toBe("Gers");
    expect(Object.keys(anchors.anchors)).toEqual(expect.arrayContaining([
      "cathedralSainteMarie", "prefectureGers", "gareAuch", "condom", "lectoure", "lisleJourdain",
    ]));
  });
});
