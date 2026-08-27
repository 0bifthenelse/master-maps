'use client';

import { useThree, useFrame } from '@react-three/fiber';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export interface CameraDiagnostics {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  azimuthalAngle: number;
}

export interface CameraHandle {
  /** Animate camera target to world coordinate with optional tight bounds */
  focusOn: (coord: [number, number], bounds?: [number, number, number, number]) => void;
  /** Reset to the full commune boundary view */
  resetView: () => void;
  /** Snapshot of current camera state for diagnostics */
  getCameraState: () => CameraDiagnostics;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface MapCameraProps {
  /** Full commune bounds [west, south, east, north] in local meters */
  communeBounds: [number, number, number, number];
  /** Initial target in local coordinates (defaults to commune centre) */
  initialTarget?: [number, number];
  /** Initial zoom level */
  initialZoom?: number;
  /** Register as the R3F default camera */
  makeDefault?: boolean;
  /** Height of camera above the plane */
  cameraHeight?: number;
}

const DAMPING = 0.08;

export const MapCamera = forwardRef<CameraHandle, MapCameraProps>(
  (
    {
      communeBounds,
      initialTarget,
      initialZoom = 1,
      makeDefault = true,
      cameraHeight = 500,
    },
    ref,
  ) => {
    const { set, get, size } = useThree();
    const cameraRef = useRef<THREE.OrthographicCamera>(null!);

    /* Initialise frustum once at mount, using the actual Canvas size (not
       window dimensions) so the fit is correct on any viewport. */
    const initFrustum = useCallback(
      (zoom: number): THREE.OrthographicCamera => {
        const camera = cameraRef.current;
        const worldWest = communeBounds[0];
        const worldEast = communeBounds[2];
        const worldSouth = communeBounds[1];
        const worldNorth = communeBounds[3];
        const worldWidth = worldEast - worldWest;
        const worldHeight = worldNorth - worldSouth;

        const aspect = size.height > 0 ? size.width / size.height : 16 / 9;

        let fw: number;
        let fh: number;
        if (worldWidth / worldHeight > aspect) {
          fw = worldWidth;
          fh = worldWidth / aspect;
        } else {
          fh = worldHeight;
          fw = worldHeight * aspect;
        }

        // 15% padding so the commune boundary is visible with margin.
        const pad = 1.15;
        camera.left = (-fw / 2) * pad;
        camera.right = (fw / 2) * pad;
        camera.top = (fh / 2) * pad;
        camera.bottom = (-fh / 2) * pad;
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
        return camera;
      },
      [communeBounds, size],
    );

    /* Centre of the commune */
    const centreX = (communeBounds[0] + communeBounds[2]) / 2;
    const centreZ = (communeBounds[1] + communeBounds[3]) / 2;

    /* Animation state */
    const desiredTarget = useRef(new THREE.Vector3(
      initialTarget?.[0] ?? centreX,
      0,
      initialTarget?.[1] ?? centreZ,
    ));
    const animating = useRef(false);
    const desiredZoom = useRef(initialZoom);

    /* Re-fit the frustum whenever the Canvas is resized (mobile rotation,
       window resize) so the commune stays fully visible. */
    useEffect(() => {
      if (cameraRef.current) initFrustum(cameraRef.current.zoom || initialZoom);
    }, [initFrustum, initialZoom]);

    /* Set camera as R3F default once mounted */
    useEffect(() => {
      if (makeDefault && cameraRef.current) {
        const old = get().camera;
        set({ camera: cameraRef.current });
        return () => set({ camera: old });
      }
      return undefined;
    }, [makeDefault, set, get]);

    /* --- Imperative API --- */

    const doFocusOn = useCallback(
      (coord: [number, number], focusBounds?: [number, number, number, number]) => {
        const camera = cameraRef.current;
        if (!camera) return;

        desiredTarget.current.set(coord[0], 0, coord[1]);

        if (focusBounds) {
          /* Fit the supplied bounds inside the frustum with 20 % padding */
          const fw = focusBounds[2] - focusBounds[0];
          const fh = focusBounds[3] - focusBounds[1];
          const aspect = size.height > 0 ? size.width / size.height : 16 / 9;
          const pad = 1.2;

          let nfw: number;
          let nfh: number;
          if (fw / fh > aspect) {
            nfw = fw * pad;
            nfh = nfw / aspect;
          } else {
            nfh = fh * pad;
            nfw = nfh * aspect;
          }

          camera.left = -nfw / 2;
          camera.right = nfw / 2;
          camera.top = nfh / 2;
          camera.bottom = -nfh / 2;
          camera.zoom = 1;
          camera.updateProjectionMatrix();
          desiredZoom.current = 1;
        }

        animating.current = true;
      },
      [size],
    );

    const doResetView = useCallback(() => {
      const camera = cameraRef.current;
      if (!camera) return;

      desiredTarget.current.set(centreX, 0, centreZ);
      initFrustum(initialZoom);
      desiredZoom.current = initialZoom;
      animating.current = true;
    }, [centreX, centreZ, initFrustum, initialZoom]);

    /* --- Animation loop --- */

    useFrame(() => {
      if (!animating.current) return;
      const camera = cameraRef.current;
      if (!camera) return;

      /* Animate target via the controls when available */
      const controls = get().controls as MapControlsImpl | null;
      if (controls) {
        const t = controls.target;
        const dx = desiredTarget.current.x - t.x;
        const dz = desiredTarget.current.z - t.z;
        if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) {
          t.x = desiredTarget.current.x;
          t.z = desiredTarget.current.z;
          animating.current = false;
        } else {
          t.x += dx * DAMPING;
          t.z += dz * DAMPING;
        }
      } else {
        /* Fallback: move camera position directly */
        const cp = camera.position;
        const dx = desiredTarget.current.x - cp.x;
        const dz = desiredTarget.current.z - cp.z;
        if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) {
          cp.x = desiredTarget.current.x;
          cp.z = desiredTarget.current.z;
          animating.current = false;
        } else {
          cp.x += dx * DAMPING;
          cp.z += dz * DAMPING;
        }
      }

      /* Animate zoom when desired */
      const zDelta = desiredZoom.current - camera.zoom;
      if (Math.abs(zDelta) > 0.01) {
        camera.zoom += zDelta * DAMPING;
        camera.updateProjectionMatrix();
      }
    });

    /* --- Ref API exposed to parent --- */

    useImperativeHandle(ref, () => ({
      focusOn: doFocusOn,
      resetView: doResetView,
      getCameraState: (): CameraDiagnostics => {
        const camera = cameraRef.current;
        if (!camera) {
          return {
            position: [0, 0, 0],
            target: [0, 0, 0],
            zoom: 0,
            azimuthalAngle: 0,
          };
        }
        const euler = new THREE.Euler().setFromQuaternion(camera.quaternion);
        const controls = get().controls as MapControlsImpl | null;
        return {
          position: [
            camera.position.x,
            camera.position.y,
            camera.position.z,
          ],
          target: controls
            ? [controls.target.x, controls.target.y, controls.target.z]
            : [0, 0, 0],
          zoom: camera.zoom,
          azimuthalAngle: euler.y,
        };
      },
    }));

    return (
      <orthographicCamera
        ref={cameraRef}
        position={[centreX, cameraHeight, centreZ] as [number, number, number]}
        rotation={[-Math.PI / 2, 0, 0] as [number, number, number]}
        zoom={initialZoom}
        near={1}
        far={cameraHeight * 4}
      />
    );
  },
);

MapCamera.displayName = 'MapCamera';
