import { describe, expect, it } from "vitest";
import { LocalProjection } from "@/lib/geo/projection";
import fixture from "../fixtures/auch-landmark-anchors.json";
import { GERS_TERRITORY } from "@/lib/data/territory";

type Anchor = { coordinate: [number, number]; sourceUrl: string };

testTopology(fixture.anchors as Record<string, Anchor>);

function testTopology(anchors: Record<string, Anchor>): void {
  describe("source-backed Auch landmark topology", () => {
    it("retains the independently sourced relative positions", () => {
      const projection = new LocalProjection(GERS_TERRITORY.renderOriginWgs84);
      const local = Object.fromEntries(
        Object.entries(anchors).map(([name, anchor]) => [name, projection.forward(...anchor.coordinate)]),
      ) as Record<string, [number, number]>;

      expect(local.gersNorth[1]).toBeGreaterThan(local.gersSouth[1]);
      expect(local.museum[0]).toBeGreaterThan(local.cathedral[0]);
      expect(local.gareAuch[0]).toBeGreaterThan(local.museum[0]);
      expect(local.nocibe[0]).toBeGreaterThan(local.cathedral[0]);
      expect(local.nocibe[0]).toBeLessThan(local.gareAuch[0]);
      expect(local.rueDu11Novembre[1]).toBeLessThan(local.avenueDeLaMarne[1]);
      expect(local.avenueDAlsace[0]).toBeLessThan(local.gareAuch[0]);
    });

    it("records reusable source URLs for every anchor", () => {
      for (const anchor of Object.values(anchors)) {
        expect(anchor.sourceUrl).toMatch(/^https:\/\//);
      }
    });
  });
}
