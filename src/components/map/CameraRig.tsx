"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { MapCamera, type CameraDiagnostics, type CameraHandle } from "./MapCamera";
import { MapControls, type CameraCommandSink, type ControlsDiagnostics, type ControlsHandle } from "./MapControls";
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

const MIN_ZOOM = 1;
const MAX_ZOOM = 4000;
const EPSILON = 0.005;

export interface CameraRigHandle {
  focusOn: (coord: [number, number], bounds?: [number, number, number, number], zoom?: number) => void;
  resetView: () => void;
  getCameraState: () => CameraDiagnostics;
  getControlsState: () => ControlsDiagnostics;
}

export interface ViewportSnapshot {
  target: [number, number];
  zoom: number;
  width: number;
  height: number;
  headingRadians: number;
}

export interface CameraRigProps {
  /** Full territory bounds [west, south, east, north] in render metres. */
  territoryBounds: [number, number, number, number];
  cameraHeight?: number;
  /** Honour prefers-reduced-motion: no damped interpolation, no idle frames. */
  reducedMotion?: boolean;
  onViewportChange?: (snapshot: ViewportSnapshot) => void;
  /**
   * Force one more frame while an interpolation or a controls damping step is
   * still running. The Canvas renders on demand, so a static view costs
   * nothing and an active one keeps ticking.
   */
  onNeedsFrame?: () => void;
}

function settled(
  controls: ControlsHandle | null,
  camera: CameraHandle | null,
): boolean {
  if (camera === null || controls === null) return false;
  if (camera.isInterpolating()) return false;
  const cameraState = camera.getCameraState();
  const controlsState = controls.getControlsState();
  if (Math.abs(controlsState.target[0] - cameraState.target[0]) > EPSILON) return false;
  if (Math.abs(controlsState.target[2] - cameraState.target[2]) > EPSILON) return false;
  if (Math.abs(controlsState.zoom - cameraState.zoom) > EPSILON) return false;
  return true;
}

/**
 * Bridges the imperative camera/controls API into the R3F tree so
 * WebGPUCityCanvas (outside the Canvas) can command focus/reset via a
 * single ref, and publishes the real camera/controls state (not a
 * requested-but-unapplied focus) into scene diagnostics only when the
 * viewport actually moved, instead of on a fixed 100 ms timer.
 */
export const CameraRig = forwardRef<CameraRigHandle, CameraRigProps>(
  ({ territoryBounds, cameraHeight, reducedMotion, onViewportChange, onNeedsFrame }, ref) => {
    const cameraRef = useRef<CameraHandle>(null);
    const controlsRef = useRef<ControlsHandle>(null);
    const lastPublished = useRef<ViewportSnapshot | null>(null);
    const pendingPublish = useRef<number | null>(null);
    const lastActivity = useRef<number>(0);

    useImperativeHandle(ref, () => ({
      focusOn: (coord, bounds) => cameraRef.current?.focusOn(coord, bounds),
      resetView: () => cameraRef.current?.resetView(),
      getCameraState: () => cameraRef.current?.getCameraState() ?? IDLE_CAMERA_STATE,
      getControlsState: () => controlsRef.current?.getControlsState() ?? IDLE_CONTROLS_STATE,
    }));

    /* Publishing is edge triggered: an unchanged viewport is never
       republished, so a static map performs zero DOM diagnostics work. */
    const publish = useCallback((): void => {
      const camera = cameraRef.current;
      const cameraState = camera?.getCameraState();
      const ortho = camera?.getCamera() ?? null;
      if (!cameraState || !ortho) return;
      const snapshot: ViewportSnapshot = {
        target: [cameraState.target[0], cameraState.target[2]],
        zoom: cameraState.zoom,
        width: Math.abs(ortho.right - ortho.left),
        height: Math.abs(ortho.top - ortho.bottom),
        headingRadians: cameraState.headingRadians,
      };
      const previous = lastPublished.current;
      const same = previous !== null
        && previous.zoom === snapshot.zoom
        && previous.width === snapshot.width
        && previous.height === snapshot.height
        && Math.abs(previous.headingRadians - snapshot.headingRadians) < 1e-6
        && Math.abs(previous.target[0] - snapshot.target[0]) < EPSILON
        && Math.abs(previous.target[1] - snapshot.target[1]) < EPSILON;
      if (same) return;
      lastPublished.current = snapshot;
      sceneMetrics.cameraTargetX = snapshot.target[0];
      sceneMetrics.cameraTargetZ = snapshot.target[1];
      sceneMetrics.cameraZoom = snapshot.zoom;
      sceneMetrics.cameraState = JSON.stringify(cameraState);
      publishSceneDiagnostics(true);
      onViewportChange?.(snapshot);
    }, [onViewportChange]);

    /* The opening frames run before the ref bridge is committed, so the
       first viewport publish is deferred by one task. */
    useEffect(() => {
      pendingPublish.current = window.setTimeout(() => {
        pendingPublish.current = null;
        publish();
      }, 0);
      return () => {
        if (pendingPublish.current !== null) window.clearTimeout(pendingPublish.current);
        pendingPublish.current = null;
      };
    }, [publish]);

    useFrame(() => {
      publish();
      if (lastActivity.current > 0) {
        lastActivity.current = 0;
        return;
      }
      if (settled(controlsRef.current, cameraRef.current)) return;
      onNeedsFrame?.();
    });

    const noteActivity = useCallback(() => {
      lastActivity.current = 1;
      onNeedsFrame?.();
    }, [onNeedsFrame]);

    /* The controls need a camera command sink on their very first render, but
       a React ref is still null at that point, so the bridge resolves it on
       every call instead of capturing it. */
    const cameraBridge = useRef<CameraCommandSink>({
      setHeading: (radians) => cameraRef.current?.setHeading(radians),
      zoomBy: (factor) => cameraRef.current?.zoomBy(factor),
      isInterpolating: () => cameraRef.current?.isInterpolating() ?? false,
      cancelInterpolation: () => cameraRef.current?.cancelInterpolation(),
    });

    return (
      <>
        <MapCamera
          ref={cameraRef}
          territoryBounds={territoryBounds}
          cameraHeight={cameraHeight}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          reducedMotion={reducedMotion}
          onCameraActivity={noteActivity}
        />
        <MapControls
          ref={controlsRef}
          territoryBounds={territoryBounds}
          maxZoom={MAX_ZOOM}
          camera={cameraBridge.current}
          onChange={noteActivity}
        />
      </>
    );
  },
);

CameraRig.displayName = "CameraRig";
