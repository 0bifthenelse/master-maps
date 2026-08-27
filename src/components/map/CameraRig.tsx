"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MapCamera, type CameraDiagnostics, type CameraHandle } from "./MapCamera";
import { MapControls, type ControlsDiagnostics, type ControlsHandle } from "./MapControls";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";

const IDLE_CAMERA_STATE: CameraDiagnostics = {
  position: [0, 0, 0],
  target: [0, 0, 0],
  zoom: 0,
  azimuthalAngle: 0,
  headingRadians: 0,
  rotationZ: 0,
};

const IDLE_CONTROLS_STATE: ControlsDiagnostics = {
  target: [0, 0, 0],
  azimuthalAngle: 0,
  polarAngle: 0,
  zoom: 0,
};

export interface CameraRigHandle {
  focusOn: (coord: [number, number], bounds?: [number, number, number, number]) => void;
  resetView: () => void;
  getCameraState: () => CameraDiagnostics;
  getControlsState: () => ControlsDiagnostics;
}

export interface CameraRigProps {
  /** Full commune bounds [west, south, east, north] in local metres */
  communeBounds: [number, number, number, number];
  /** Height of the camera above the ground plane */
  cameraHeight?: number;
}

/** Minimum interval between diagnostics publishes, matching CityScene's cadence. */
const DIAGNOSTICS_INTERVAL_MS = 100;

/**
 * Bridges the imperative camera/controls API into the R3F tree so
 * WebGPUCityCanvas (outside the Canvas) can command focus/reset via a
 * single ref, and publishes the real camera/controls state (not a
 * requested-but-unapplied focus) into scene diagnostics every frame,
 * throttled to DIAGNOSTICS_INTERVAL_MS.
 */
export const CameraRig = forwardRef<CameraRigHandle, CameraRigProps>(
  ({ communeBounds, cameraHeight }, ref) => {
    const cameraRef = useRef<CameraHandle>(null);
    const controlsRef = useRef<ControlsHandle>(null);
    const lastPublish = useRef(0);

    useImperativeHandle(ref, () => ({
      focusOn: (coord, bounds) => cameraRef.current?.focusOn(coord, bounds),
      resetView: () => cameraRef.current?.resetView(),
      getCameraState: () => cameraRef.current?.getCameraState() ?? IDLE_CAMERA_STATE,
      getControlsState: () => controlsRef.current?.getControlsState() ?? IDLE_CONTROLS_STATE,
    }));

    useFrame((state) => {
      const now = state.clock.elapsedTime * 1000;
      if (now - lastPublish.current < DIAGNOSTICS_INTERVAL_MS) return;
      lastPublish.current = now;

      const cameraState = cameraRef.current?.getCameraState();
      if (!cameraState) return;
      sceneMetrics.cameraTargetX = cameraState.target[0];
      sceneMetrics.cameraTargetZ = cameraState.target[2];
      sceneMetrics.cameraZoom = cameraState.zoom;
      sceneMetrics.cameraState = JSON.stringify(cameraState);
      publishSceneDiagnostics();
    });

    return (
      <>
        <MapCamera ref={cameraRef} communeBounds={communeBounds} cameraHeight={cameraHeight} />
        <MapControls ref={controlsRef} communeBounds={communeBounds} />
      </>
    );
  },
);

CameraRig.displayName = "CameraRig";
