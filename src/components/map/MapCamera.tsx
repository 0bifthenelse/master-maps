'use client';

import { useThree, useFrame } from '@react-three/fiber';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { normalizeHeading } from './mapNavigation';

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
  /** Animate camera target to world coordinate with optional tight bounds. */
  focusOn: (coord: [number, number], bounds?: [number, number, number, number], zoom?: number) => void;
  /** Reset to the full territory boundary view. */
  resetView: () => void;
  /** Live orthographic camera, for callers that need the current frustum. */
  getCamera: () => THREE.OrthographicCamera | null;
  /** Heading in radians, applied on the next damped step. */
  setHeading: (radians: number) => void;
  /** Zoom factor multiplier, 1 leaves the zoom untouched. */
  zoomBy: (factor: number) => void;
  /** True while a focus or reset interpolation is still running. */
  isInterpolating: () => boolean;
  /** Any user interaction that must cancel a running interpolation. */
  cancelInterpolation: () => void;
  /** Snapshot of current camera state for diagnostics. */
  getCameraState: () => CameraDiagnostics;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface MapCameraProps {
  /** Full territory bounds [west, south, east, north] in local meters. */
  territoryBounds: [number, number, number, number];
  /** Initial target in local coordinates (defaults to territory centre) */
  initialTarget?: [number, number];
  /** Initial zoom level */
  initialZoom?: number;
  /** Register as the R3F default camera */
  makeDefault?: boolean;
  /** Height of camera above the plane */
  cameraHeight?: number;
  /** Smallest allowed zoom, applied to every zoom source. */
  minZoom?: number;
  /** Largest allowed zoom, applied to every zoom source. */
  maxZoom?: number;
  /** Observe prefers-reduced-motion: damping and interpolation become instant. */
  reducedMotion?: boolean;
  /** Notified whenever the camera or controls moved and a frame is needed. */
  onCameraActivity?: () => void;
}

const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 4000;
const DAMPING = 0.08;
const CAMERA_TOP_DOWN_PITCH = -Math.PI / 2;
const ROTATION_SENSITIVITY = 0.005;
const TARGET_EPSILON = 0.01;
const ZOOM_EPSILON = 0.01;
const HEADING_EPSILON = 1e-4;

/** Three's right-handed top-down basis maps +Z to screen down at zero roll.
 * Flip only NDC-Y in the orthographic projection so +X remains screen-right
 * and +Z remains screen-up without mutating geographic geometry. */
export function updateNorthUpProjection(camera: THREE.OrthographicCamera): void {
  camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[5] *= -1;
}

export const MapCamera = forwardRef<CameraHandle, MapCameraProps>(
  (
    {
      territoryBounds,
      initialTarget,
      initialZoom = 1,
      makeDefault = true,
      cameraHeight = 500,
      minZoom = DEFAULT_MIN_ZOOM,
      maxZoom = DEFAULT_MAX_ZOOM,
      reducedMotion = false,
      onCameraActivity,
    },
    ref,
  ) => {
    const { set, get, size, gl, invalidate } = useThree();
    const cameraRef = useRef<THREE.OrthographicCamera>(null!);
    const reducedMotionRef = useRef(reducedMotion);
    const activityRef = useRef(onCameraActivity);

    reducedMotionRef.current = reducedMotion;
    activityRef.current = onCameraActivity;

    /* Heading state - authoritative in-plane rotation around viewing axis.
       0 = corrected north-up (Z=0), PI = old reversed default. */
    const headingRef = useRef<number>(0);

    /* Initialise frustum once at mount, using the actual Canvas size (not
       window dimensions) so the fit is correct on any viewport. */
    const initFrustum = useCallback(
      (zoom: number): THREE.OrthographicCamera => {
        const camera = cameraRef.current;
        const worldWest = territoryBounds[0];
        const worldEast = territoryBounds[2];
        const worldSouth = territoryBounds[1];
        const worldNorth = territoryBounds[3];
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

        // 15% padding keeps the territory boundary visible with margin.
        const pad = 1.15;
        camera.left = (-fw / 2) * pad;
        camera.right = (fw / 2) * pad;
        camera.top = (fh / 2) * pad;
        camera.bottom = (-fh / 2) * pad;
        camera.zoom = Math.min(maxZoom, Math.max(minZoom, zoom));
        updateNorthUpProjection(camera);
        return camera;
      },
      [territoryBounds, size, minZoom, maxZoom],
    );

    /* Centre of the territory */
    const centreX = (territoryBounds[0] + territoryBounds[2]) / 2;
    const centreZ = (territoryBounds[1] + territoryBounds[3]) / 2;

    /* Animation state */
    const desiredTarget = useRef(new THREE.Vector3(
      initialTarget?.[0] ?? centreX,
      0,
      initialTarget?.[1] ?? centreZ,
    ));
    const animating = useRef(false);
    const desiredHeading = useRef(0);
    const desiredZoom = useRef(initialZoom);
    const initialised = useRef(false);

    const applyNorthUp = useCallback(
      (targetX: number, targetZ: number): void => {
        const camera = cameraRef.current;
        if (!camera) return;

        const heading = headingRef.current;
        camera.up.set(0, 1, 0);
        camera.position.set(targetX, cameraHeight, targetZ);
        camera.rotation.set(CAMERA_TOP_DOWN_PITCH, 0, heading);
        camera.updateMatrixWorld();

        const controls = get().controls as MapControlsImpl | null;
        if (controls) {
          controls.target.set(targetX, 0, targetZ);
          controls.update();
          camera.position.set(targetX, cameraHeight, targetZ);
          camera.rotation.set(CAMERA_TOP_DOWN_PITCH, 0, heading);
          camera.updateMatrixWorld();
        }
      },
      [cameraHeight, get],
    );

    const setZoom = useCallback(
      (value: number): void => {
        const camera = cameraRef.current;
        if (!camera) return;
        const clamped = Math.min(maxZoom, Math.max(minZoom, value));
        if (camera.zoom === clamped) return;
        camera.zoom = clamped;
        updateNorthUpProjection(camera);
      },
      [minZoom, maxZoom],
    );

    /* --- Heading, driven by pointer drag and by the controls' own orbit --- */

    const commitHeading = useCallback((radians: number): void => {
      const camera = cameraRef.current;
      if (!camera) return;
      const heading = normalizeHeading(radians);
      if (heading === headingRef.current) return;
      headingRef.current = heading;
      desiredHeading.current = heading;
      camera.rotation.set(CAMERA_TOP_DOWN_PITCH, 0, heading);
      camera.updateMatrixWorld();
      activityRef.current?.();
      invalidate();
    }, [invalidate]);

    /* The map is a strict top-down view: the camera always sits directly
       above its target, which makes Object3D.lookAt a degenerate basis (the
       view direction and the up vector are parallel). Three then falls back
       to the matrix Z axis, which silently rolls the camera a few degrees on
       every OrbitControls.update(). The heading is owned by this component,
       so the aim step is neutralised and the controls keep the position. */
    useEffect(() => {
      const camera = cameraRef.current;
      if (!camera) return;
      const aim = camera.lookAt.bind(camera);
      camera.lookAt = (): void => {};
      return () => {
        camera.lookAt = aim;
      };
    }, []);

    /* Re-fit the frustum whenever the Canvas is resized (mobile rotation,
       window resize) so the territory stays fully visible. */
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
        if (e.pointerType !== 'mouse' || e.button !== 2) return;
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
        commitHeading(startHeading + (e.clientX - startX) * ROTATION_SENSITIVITY);
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
        if (document.documentElement.dataset.featureContextOpen !== 'true') return;
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
    }, [gl, commitHeading]);

    /* --- Imperative API --- */

    const doFocusOn = useCallback(
      (coord: [number, number], focusBounds?: [number, number, number, number], focusZoom?: number) => {
        const camera = cameraRef.current;
        if (!camera) return;

        desiredTarget.current.set(coord[0], 0, coord[1]);

        if (focusBounds) {
          const fw = Math.max(focusBounds[2] - focusBounds[0], 1);
          const fh = Math.max(focusBounds[3] - focusBounds[1], 1);
          const aspect = size.height > 0 ? size.width / size.height : 16 / 9;
          const pad = 1.2;
          const nfw = fw / fh > aspect ? fw * pad : fh * pad * aspect;
          const nfh = fw / fh > aspect ? fw * pad / aspect : fh * pad;
          camera.left = -nfw / 2;
          camera.right = nfw / 2;
          camera.top = nfh / 2;
          camera.bottom = -nfh / 2;
          setZoom(1);
        }
        desiredZoom.current = Math.min(
          maxZoom,
          Math.max(minZoom, focusZoom ?? (focusBounds ? 1 : Math.max(initialZoom, 20))),
        );
        animating.current = true;
        invalidate();
      },
      [initialZoom, size, invalidate, setZoom, minZoom, maxZoom],
    );

    const doResetView = useCallback(() => {
      const camera = cameraRef.current;
      if (!camera) return;

      desiredHeading.current = 0;
      desiredTarget.current.set(centreX, 0, centreZ);
      initFrustum(initialZoom);
      desiredZoom.current = Math.min(maxZoom, Math.max(minZoom, initialZoom));
      animating.current = true;
      invalidate();
    }, [centreX, centreZ, initFrustum, initialZoom, invalidate, minZoom, maxZoom]);

    const doSetHeading = useCallback((radians: number) => {
      desiredHeading.current = normalizeHeading(radians);
      animating.current = true;
      invalidate();
    }, [invalidate]);

    const doZoomBy = useCallback((factor: number) => {
      const camera = cameraRef.current;
      if (!camera || !Number.isFinite(factor) || factor <= 0) return;
      desiredZoom.current = Math.min(maxZoom, Math.max(minZoom, camera.zoom * factor));
      animating.current = true;
      invalidate();
    }, [invalidate, minZoom, maxZoom]);

    const doCancel = useCallback(() => {
      if (!animating.current) return;
      animating.current = false;
      desiredHeading.current = headingRef.current;
      desiredZoom.current = cameraRef.current?.zoom ?? desiredZoom.current;
    }, []);

    /* --- Animation loop --- */

    useFrame(() => {
      const camera = cameraRef.current;
      if (!camera) return;

      const controls = get().controls as MapControlsImpl | null;
      if (!initialised.current) {
        if (controls) {
          applyNorthUp(desiredTarget.current.x, desiredTarget.current.z);
          initialised.current = true;
        }
      }

      let moving = false;

      if (animating.current) {
        const instant = reducedMotionRef.current;
        const blend = instant ? 1 : DAMPING;

        const t = controls ? controls.target : null;
        const dx = desiredTarget.current.x - (t ? t.x : camera.position.x);
        const dz = desiredTarget.current.z - (t ? t.z : camera.position.z);
        if (Math.abs(dx) < TARGET_EPSILON && Math.abs(dz) < TARGET_EPSILON) {
          if (t) {
            t.x = desiredTarget.current.x;
            t.z = desiredTarget.current.z;
          } else {
            camera.position.x = desiredTarget.current.x;
            camera.position.z = desiredTarget.current.z;
          }
        } else {
          if (t) {
            t.x += dx * blend;
            t.z += dz * blend;
          } else {
            camera.position.x += dx * blend;
            camera.position.z += dz * blend;
          }
          moving = true;
        }

        const zDelta = desiredZoom.current - camera.zoom;
        if (Math.abs(zDelta) > ZOOM_EPSILON) {
          setZoom(camera.zoom + zDelta * blend);
          moving = true;
        }

        const hDelta = normalizeHeading(desiredHeading.current) - headingRef.current;
        if (Math.abs(hDelta) > HEADING_EPSILON) {
          const next = normalizeHeading(headingRef.current + hDelta * blend);
          headingRef.current = next;
          moving = true;
        } else if (headingRef.current !== desiredHeading.current) {
          headingRef.current = normalizeHeading(desiredHeading.current);
        }

        if (!moving) animating.current = false;
      }

      /* OrbitControls re-aims the camera at its target on every update, and
         a pure lookAt leaves a roll whenever the two are not exactly
         vertical. The heading is authoritative here, so the orientation is
         re-asserted every frame instead of only while animating. */
      if (camera.rotation.z !== headingRef.current) {
        camera.rotation.set(CAMERA_TOP_DOWN_PITCH, 0, headingRef.current);
        moving = true;
      }
      camera.updateMatrixWorld();

      /* Keep the controls inside the zoom range even for wheel and pinch. */
      if (
        (camera.zoom < minZoom && camera.zoom !== minZoom)
        || (camera.zoom > maxZoom && camera.zoom !== maxZoom)
      ) {
        setZoom(camera.zoom);
        moving = true;
      }

      if (moving) {
        activityRef.current?.();
        invalidate();
      }
    });

    /* --- Ref API exposed to parent --- */

    useImperativeHandle(ref, () => ({
      focusOn: doFocusOn,
      resetView: doResetView,
      getCamera: () => cameraRef.current ?? null,
      setHeading: doSetHeading,
      zoomBy: doZoomBy,
      isInterpolating: () => animating.current,
      cancelInterpolation: doCancel,
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
        rotation={[CAMERA_TOP_DOWN_PITCH, 0, 0]}
        zoom={initialZoom}
        near={1}
        far={cameraHeight * 4}
      />
    );
  },
);

MapCamera.displayName = 'MapCamera';
