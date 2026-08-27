import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { updateNorthUpProjection } from "@/components/map/MapCamera";

describe("north-up camera projection", () => {
  it("projects north upward and east right at zero heading", () => {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 1000);
    camera.position.set(0, 100, 0);
    camera.rotation.set(-Math.PI / 2, 0, 0);
    updateNorthUpProjection(camera);
    camera.updateMatrixWorld();
    const target = new THREE.Vector3(0, 0, 0).project(camera);
    const north = new THREE.Vector3(0, 0, 10).project(camera);
    const east = new THREE.Vector3(10, 0, 0).project(camera);
    expect(north.y).toBeGreaterThan(target.y);
    expect(east.x).toBeGreaterThan(target.x);
  });
});
