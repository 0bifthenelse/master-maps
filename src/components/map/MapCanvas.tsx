"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type Group, type PerspectiveCamera } from "three";
import type { DecodedRenderTile } from "@/lib/render/codec";
import type { MapTransform } from "@/lib/map/transform";
import type { BaseMap } from "@/lib/map/theme";
import { MACHINE } from "@/lib/map/theme";
import { updateFrameUniforms } from "@/lib/render/tileMaterials";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";
import TileLayers, { type LayerVisibility } from "./TileLayers";
import SatelliteLayer from "./SatelliteLayer";
import Graticule from "./Graticule";

export interface MapCanvasProps {
  transform: MapTransform;
  /** Bumped by the parent whenever the transform changed. */
  revision: number;
  tiles: readonly DecodedRenderTile[];
  visibility: LayerVisibility;
  basemap: BaseMap;
  grid: boolean;
  bounds: [number, number, number, number];
  buildingsRef: MutableRefObject<Group | null>;
  /** Receives R3F's invalidate so controllers can request frames. */
  onInvalidate: (invalidate: () => void) => void;
  /** Called after the camera is updated, every rendered frame (draw the overlay here). */
  onFrame: () => void;
  onError: (message: string) => void;
}

function FrameSync({ transform, basemap, onFrame, onInvalidate }: Pick<MapCanvasProps, "transform" | "basemap" | "onFrame" | "onInvalidate">) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const invalidate = useThree((state) => state.invalidate);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    (camera as PerspectiveCamera & { manual?: boolean }).manual = true;
    onInvalidate(invalidate);
    invalidate();
  }, [camera, invalidate, onInvalidate]);
  useFrame(() => {
    transform.applyToCamera(camera);
    updateFrameUniforms(transform.zoom, transform.metresPerPixel, basemap === "satellite");
    onFrame();
    sceneMetrics.drawCalls = gl.info.render.calls;
  });
  return null;
}

export default function MapCanvas(props: MapCanvasProps) {
  const { transform, revision, tiles, visibility, basemap, grid, bounds, buildingsRef, onInvalidate, onFrame, onError } = props;
  const invalidateRef = useRef<() => void>(() => undefined);
  const handleInvalidate = useCallback((invalidate: () => void) => {
    invalidateRef.current = invalidate;
    onInvalidate(invalidate);
  }, [onInvalidate]);
  const requestFrame = useCallback(() => invalidateRef.current(), []);

  return (
    <Canvas
      linear
      flat
      dpr={[1, 2]}
      frameloop="demand"
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance", stencil: false }}
      camera={{ fov: 36.87, near: 1, far: 1e6, position: [0, 1000, 0] }}
      style={{ position: "absolute", inset: 0, display: "block" }}
      onCreated={(state) => {
        const context = state.gl.getContext();
        sceneMetrics.backend = typeof WebGL2RenderingContext !== "undefined" && context instanceof WebGL2RenderingContext ? "webgl2" : "webgl";
        sceneMetrics.rendererStatus = "initialized";
        sceneMetrics.rendererError = "none";
        publishSceneDiagnostics(true);
        state.gl.domElement.addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          sceneMetrics.rendererStatus = "lost";
          publishSceneDiagnostics(true);
          onError("The graphics context was lost. Reload the page to restore the map.");
        });
      }}
    >
      <color attach="background" args={[MACHINE.void]} />
      <FrameSync transform={transform} basemap={basemap} onFrame={onFrame} onInvalidate={handleInvalidate} />
      {/* Map space: local metres with +z = north, flipped once into a right-handed world. */}
      <group scale={[1, 1, -1]}>
        {basemap === "satellite" ? <SatelliteLayer transform={transform} revision={revision} onLoaded={requestFrame} /> : null}
        {grid && basemap === "machine" ? <Graticule bounds={bounds} /> : null}
        <TileLayers ref={buildingsRef} tiles={tiles} visibility={visibility} />
      </group>
    </Canvas>
  );
}
