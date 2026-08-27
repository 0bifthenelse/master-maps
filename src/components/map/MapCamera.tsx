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
  headingRadians: number;
  rotationZ: number;
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
// Corrected default: 180-degree reversal from previous [ -PI/2, 0, PI ] -> [ -PI/2, 0, 0 ]
const NORTH_UP_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];
const ROTATION_SENSITIVITY = 0.005; // radians per pixel of horizontal drag

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
    const { set, get, size, gl } = useThree();
    const cameraRef = useRef<THREE.OrthographicCamera>(null!);

    /* Heading state - authoritative in-plane rotation around viewing axis.
       0 = corrected north-up (Z=0), PI = old reversed default. */
    const headingRef = useRef<number>(0);

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
    const initialised = useRef(false);

    const applyNorthUp = useCallback(
      (targetX: number, targetZ: number): void => {
        const camera = cameraRef.current;
        if (!camera) return;

        const heading = headingRef.current;
        camera.up.set(0, 1, 0);
        camera.position.set(targetX, cameraHeight, targetZ);
        camera.rotation.set(-Math.PI / 2, 0, heading);
        camera.updateMatrixWorld();

        const controls = get().controls as MapControlsImpl | null;
        if (controls) {
          controls.target.set(targetX, 0, targetZ);
          controls.update();
          camera.position.set(targetX, cameraHeight, targetZ);
          camera.rotation.set(-Math.PI / 2, 0, heading);
          camera.updateMatrixWorld();
        }
      },
      [cameraHeight, get],
    );

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

    /* Right-drag heading rotation - authoritative heading state.
       Uses pointer capture and suppresses context menu only on canvas. */
    useEffect(() => {
      // WebGPURenderer exposes domElement; named cast documents the boundary.
      const glWithDom = gl as unknown as { domElement: HTMLCanvasElement };
      const canvas = glWithDom.domElement;
      if (!canvas) return;

      let isRotating = false;
      let startX = 0;
      let startHeading = 0;
      let activePointerId: number | null = null;

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 2) return;
        isRotating = true;
        startX = e.clientX;
        startHeading = headingRef.current;
        activePointerId = e.pointerId;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {}
        e.preventDefault();
      };

      const onPointerMove = (e: PointerEvent) => {
        if (!isRotating) return;
        if (activePointerId !== null && e.pointerId !== activePointerId) return;
        const deltaX = e.clientX - startX;
        const newHeading = startHeading + deltaX * ROTATION_SENSITIVITY;
        headingRef.current = newHeading;
        const cam = cameraRef.current;
        if (cam) {
          cam.rotation.set(-Math.PI / 2, 0, newHeading);
          cam.updateMatrixWorld();
        }
      };

      const endRotation = (e: PointerEvent) => {
        if (!isRotating) return;
        if (activePointerId !== null && e.pointerId !== activePointerId) return;
        isRotating = false;
        activePointerId = null;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {}
      };

      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
      };

      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', endRotation);
      canvas.addEventListener('pointercancel', endRotation);
      canvas.addEventListener('contextmenu', onContextMenu);

      return () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', endRotation);
        canvas.removeEventListener('pointercancel', endRotation);
        canvas.removeEventListener('contextmenu', onContextMenu);
        if (activePointerId !== null) {
          try {
            canvas.releasePointerCapture(activePointerId);
          } catch {}
        }
      };
    }, [gl]);

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

      headingRef.current = 0;
      desiredTarget.current.set(centreX, 0, centreZ);
      applyNorthUp(centreX, centreZ);
      initialised.current = true;
      initFrustum(initialZoom);
      desiredZoom.current = initialZoom;
      animating.current = true;
    }, [applyNorthUp, centreX, centreZ, initFrustum, initialZoom]);

    /* --- Animation loop --- */

    useFrame(() => {
      if (!initialised.current) {
        applyNorthUp(desiredTarget.current.x, desiredTarget.current.z);
        if (get().controls) initialised.current = true;
      }
      const camera = cameraRef.current;
      if (!camera) return;

      const applyHeading = () => {
        camera.rotation.set(-Math.PI / 2, 0, headingRef.current);
        camera.updateMatrixWorld();
      };

      if (!animating.current) {
        applyHeading();
        return;
      }

      /* Animate target via the controls when available. */
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
        /* Fallback: move camera position directly. */
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

      /* Animate zoom when desired. */
      const zDelta = desiredZoom.current - camera.zoom;
      if (Math.abs(zDelta) > 0.01) {
        camera.zoom += zDelta * DAMPING;
        camera.updateProjectionMatrix();
      }
      applyHeading();
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
            headingRadians: 0,
            rotationZ: 0,
          };
        }
        const controls = get().controls as MapControlsImpl | null;
        const target: [number, number, number] = controls
          ? [controls.target.x, controls.target.y, controls.target.z]
          : [0, 0, 0];
        return {
          position: [
            camera.position.x,
            camera.position.y,
            camera.position.z,
          ],
          target,
          zoom: camera.zoom,
          azimuthalAngle: headingRef.current,
          headingRadians: headingRef.current,
          rotationZ: camera.rotation.z,
        };
      },
    }));

    return (
      <orthographicCamera
        ref={cameraRef}
        position={[centreX, cameraHeight, centreZ] as [number, number, number]}
        up={[0, 1, 0]}
        rotation={NORTH_UP_ROTATION}
        zoom={initialZoom}
        near={1}
        far={cameraHeight * 4}
      />
    );
  },
);

MapCamera.displayName = 'MapCamera';
