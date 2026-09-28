import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyNorthUpFrustum,
  readOrientation,
  updateNorthUpProjection,
} from "@/components/map/MapCamera";

const SOURCE_ROOT = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function mapCamera(heading: number): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  camera.position.set(0, 500, 0);
  camera.rotation.set(-Math.PI / 2, 0, heading);
  applyNorthUpFrustum(camera, 100, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function screenAxis(camera: THREE.OrthographicCamera, world: [number, number, number]): THREE.Vector2 {
  const target = new THREE.Vector3(0, 0, 0).project(camera);
  const point = new THREE.Vector3(world[0], world[1], world[2]).project(camera);
  return new THREE.Vector2(point.x - target.x, point.y - target.y);
}

/* At heading PI/2 the map is a quarter turn rotated, so north projects along X
   and east along Y and both components fall below float resolution. A sign test
   on one axis proves nothing there, while the cross product of the two screen
   axes is the handedness itself: positive means east sits right of north. */
function isNorthUpAndEastRight(camera: THREE.OrthographicCamera): boolean {
  const north = screenAxis(camera, [0, 0, 1]);
  const east = screenAxis(camera, [1, 0, 0]);
  return east.x * north.y - east.y * north.x > 0;
}

const MATRIX_WRITE =
  /projectionMatrix(?!\w)(?:\.\s*elements\b|\[\s*\d+\s*\])\s*(?:\[[^\]]*\]\s*)*[-+*/]?=/;

describe("durable north-up projection", () => {
  it("puts north up and east right at heading zero", () => {
    const camera = mapCamera(0);
    expect(isNorthUpAndEastRight(camera)).toBe(true);
    expect(camera.projectionMatrix.elements[5]).toBeLessThan(0);
  });

  it("keeps north up and east right at every heading", () => {
    for (const heading of [0.25, Math.PI / 4, Math.PI / 2, -Math.PI / 3, Math.PI - 1e-3, Math.PI]) {
      const camera = mapCamera(heading);
      expect(isNorthUpAndEastRight(camera)).toBe(true);
      expect(camera.projectionMatrix.elements[5]).toBeLessThan(0);
    }
  });

  it("survives the projection rebuild that R3F resize and OrbitControls trigger", () => {
    const camera = mapCamera(Math.PI / 3);
    for (let rebuild = 0; rebuild < 5; rebuild += 1) {
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      expect(isNorthUpAndEastRight(camera)).toBe(true);
      expect(camera.projectionMatrix.elements[5]).toBeLessThan(0);
    }
  });

  it("keeps the projection Y scale negative for every zoom", () => {
    for (const zoom of [0.5, 1, 10, 4000]) {
      const camera = mapCamera(Math.PI / 7);
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      expect(camera.projectionMatrix.elements[5]).toBeLessThan(0);
      expect(isNorthUpAndEastRight(camera)).toBe(true);
    }
  });

  it("encodes the reflection in the frustum, not in a generated matrix", () => {
    const camera = mapCamera(0);
    expect(camera.top).toBe(-100);
    expect(camera.bottom).toBe(100);
    const before = Array.from(camera.projectionMatrix.elements);
    updateNorthUpProjection(camera);
    camera.updateMatrixWorld(true);
    expect(Array.from(camera.projectionMatrix.elements)).toEqual(before);
    expect(isNorthUpAndEastRight(camera)).toBe(true);
  });

  it("re-mirrors a plain frustum instead of inverting an already mirrored one", () => {
    const plain = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 4000);
    plain.position.set(0, 500, 0);
    plain.rotation.set(-Math.PI / 2, 0, 0);
    plain.updateMatrixWorld(true);
    expect(isNorthUpAndEastRight(plain)).toBe(false);

    updateNorthUpProjection(plain);
    plain.updateMatrixWorld(true);
    expect(isNorthUpAndEastRight(plain)).toBe(true);
    updateNorthUpProjection(plain);
    plain.updateMatrixWorld(true);
    expect(isNorthUpAndEastRight(plain)).toBe(true);
  });

  it("lets no source line assign through a projection matrix", () => {
    const offenders = sourceFiles(SOURCE_ROOT)
      .filter((path) => MATRIX_WRITE.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SOURCE_ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("reads orientation from the live matrices", () => {
    expect(readOrientation(mapCamera(0))).toMatchObject({
      northScreenUp: true,
      eastScreenRight: true,
    });
    expect(readOrientation(mapCamera(Math.PI / 3)).northScreenUp).toBe(true);

    const plain = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 4000);
    plain.position.set(0, 500, 0);
    plain.rotation.set(-Math.PI / 2, 0, 0);
    plain.updateMatrixWorld(true);
    expect(readOrientation(plain)).toMatchObject({
      northScreenUp: false,
      eastScreenRight: true,
    });
  });
});
