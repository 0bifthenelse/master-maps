'use client';

import { MapControls as DreiMapControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { forwardRef, useEffect, useRef, useImperativeHandle, useCallback } from 'react';
import type { OrthographicCamera } from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { useControlOrbit } from './useControlOrbit';
import {
  acceptsMapKey,
  headingForKey,
  worldPanFor,
  zoomDirectionFor,
  KEY_PANS,
} from './mapNavigation';

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ControlsDiagnostics {
  target: [number, number, number];
  azimuthalAngle: number;
  polarAngle: number;
  zoom: number;
}

export interface ControlsHandle {
  getControlsState: () => ControlsDiagnostics;
  /** Nudge the map target by one clamped keyboard step. */
  panByStep: (screenX: number, screenY: number) => void;
  /** Multiply the orthographic zoom, clamped to the configured range. */
  zoomByFactor: (factor: number) => void;
  /** Requested heading in radians, the camera damps towards it. */
  requestHeading: (radians: number) => void;
  /** Ask the camera to abort any running focus or reset interpolation. */
  cancelInterpolation: () => void;
}

export interface CameraCommandSink {
  setHeading: (radians: number) => void;
  zoomBy: (factor: number) => void;
  isInterpolating: () => boolean;
  cancelInterpolation: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface MapControlsProps {
  /** Largest zoom the controls accept from any source. */
  maxZoom?: number;
  /** Enable damping for smooth interaction */
  enableDamping?: boolean;
  /** Damping factor */
  dampingFactor?: number;
  /** Enable in-plane rotation. Desktop keeps right-drag heading, touch uses
      two fingers, so the OrbitControls mouse rotate stays off. */
  enableRotate?: boolean;
  /** Rotation speed */
  rotateSpeed?: number;
  /** Enable panning */
  enablePan?: boolean;
  /** Pan speed */
  panSpeed?: number;
  /** Register as the R3F default controls */
  makeDefault?: boolean;
  /** Territory bounds [west, south, east, north] in local metres, used by HJKL */
  territoryBounds?: [number, number, number, number];
  /** Zoom factor applied by one plus or minus key press. */
  keyboardZoomFactor?: number;
  /** Camera command sink, required for heading keys and zoom keys. */
  camera?: CameraCommandSink | null;
  /** Callback when camera changes */
  onChange?: () => void;
}
const MIN_ZOOM = 0.01;
const TERRITORY_MARGIN = 0.1;

export const MapControls = forwardRef<ControlsHandle, MapControlsProps>(
  (
    {
      maxZoom = 4000,
      enableDamping = true,
      dampingFactor = 0.08,
      enableRotate = false,
      rotateSpeed = 0.5,
      enablePan = true,
      panSpeed = 0.5,
      makeDefault = true,
      territoryBounds,
      keyboardZoomFactor = 1.25,
      camera = null,
      onChange,
    },
    ref,
  ) => {
    const controlsRef = useRef<MapControlsImpl>(null!);
    const { get, invalidate, size } = useThree();
    const cameraRef = useRef(camera);
    cameraRef.current = camera;

    const readHeading = useCallback((): number => {
      const current = get().camera as unknown as OrthographicCamera;
      if (current && current.isOrthographicCamera) return current.rotation.z;
      return 0;
    }, [get]);

    const readZoom = useCallback((): number => {
      const current = get().camera as unknown as OrthographicCamera;
      if (current && current.isOrthographicCamera) return current.zoom;
      return 1;
    }, [get]);

    /* Wheel deltas are expressed in pixels, so the same notch moved twice as
       fast on a 120 Hz display as on a 60 Hz one. One wheel notch is 100 px
       of delta; a step of that size is mapped to one keyboard zoom step so a
       notch and a key press move the map by the same amount. */
    useEffect(() => {
      const controls = controlsRef.current;
      if (!controls) return;
      const onWheel = (event: WheelEvent): void => {
        if (event.deltaMode === 0) return;
        event.preventDefault();
        const notches = event.deltaY * (event.deltaMode === 1 ? 16 : 400);
        const clamped = Math.max(-3, Math.min(3, notches / 100));
        const current = readZoom();
        if (clamped === 0 || current <= 0) return;
        controls.setScale(Math.pow(keyboardZoomFactor, clamped));
        controls.update();
      };
      const canvas = controls.domElement ?? null;
      if (!canvas) return;
      canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
      return () => canvas.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    }, [readZoom, keyboardZoomFactor]);

    /* A damping pan keeps moving after the last pointer event, and a demand
       rendered Canvas only draws the frames it has been asked for. The
       controls stop reporting a change exactly when the pan has settled, so
       a settled update is what ends this loop. */
    const panSettled = useRef(true);
    const requestFrame = useCallback(() => {
      panSettled.current = false;
      invalidate();
    }, [invalidate]);

    useEffect(() => {
      const controls = controlsRef.current;
      if (!controls) return;
      let running = false;
      const step = (): void => {
        if (panSettled.current) {
          running = false;
          return;
        }
        if ((controls.update() as unknown as boolean) === false) panSettled.current = true;
        invalidate();
        requestAnimationFrame(step);
      };
      const start = (): void => {
        panSettled.current = false;
        if (running) return;
        running = true;
        requestAnimationFrame(step);
      };
      controls.addEventListener('change', start);
      return () => controls.removeEventListener('change', start);
    }, [invalidate]);

    /* Keyboard panning is bounded by the territory, the same way the map
       tiles are: the camera can never leave the Gers by more than a tenth of
       its own extent in any direction. */
    useEffect(() => {
      const controls = controlsRef.current;
      if (controls === null || territoryBounds === undefined) return;
      const [west, south, east, north] = territoryBounds;
      const marginX = Math.max(0, (east - west) * TERRITORY_MARGIN);
      const marginZ = Math.max(0, (north - south) * TERRITORY_MARGIN);
      const clampTarget = (): void => {
        controls.target.x = Math.min(east + marginX, Math.max(west - marginX, controls.target.x));
        controls.target.z = Math.min(north + marginZ, Math.max(south - marginZ, controls.target.z));
      };
      controls.addEventListener('change', clampTarget);
      return () => controls.removeEventListener('change', clampTarget);
    }, [territoryBounds]);


    useControlOrbit(controlsRef.current, enableRotate, () => onChange?.());

    /* --- HJKL, arrows, plus/minus and heading keys --- */

    const onKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (!acceptsMapKey(e)) return;

        const zoomDirection = zoomDirectionFor(e);
        if (zoomDirection !== 0) {
          e.preventDefault();
          const sink = cameraRef.current;
          if (sink) {
            sink.cancelInterpolation();
            sink.zoomBy(zoomDirection > 0 ? keyboardZoomFactor : 1 / keyboardZoomFactor);
          }
          return;
        }

        const headingStep = headingForKey(e);
        if (headingStep !== null) {
          e.preventDefault();
          const sink = cameraRef.current;
          if (!sink) return;
          const heading = readHeading() + headingStep;
          sink.cancelInterpolation();
          sink.setHeading(heading);
          return;
        }

        const pan = KEY_PANS[e.code];
        if (pan === undefined) return;
        e.preventDefault();

        const sink = cameraRef.current;
        if (sink && sink.isInterpolating()) sink.cancelInterpolation();

        const controls = controlsRef.current;
        if (!controls) return;
        const ortho = get().camera as unknown as OrthographicCamera;
        if (!ortho || ortho.isOrthographicCamera !== true) return;

        const halfWidth = Math.abs(ortho.right - ortho.left) / ortho.zoom;
        const halfHeight = Math.abs(ortho.top - ortho.bottom) / ortho.zoom;
        const delta = worldPanFor(halfWidth * 2, halfHeight * 2, readHeading(), pan);
        const bounds = territoryBounds;
        if (bounds !== undefined) {
          const marginX = Math.max(0, (bounds[2] - bounds[0]) * TERRITORY_MARGIN);
          const marginZ = Math.max(0, (bounds[3] - bounds[1]) * TERRITORY_MARGIN);
          controls.target.x = Math.min(
            bounds[2] + marginX,
            Math.max(bounds[0] - marginX, controls.target.x + delta.dx),
          );
          controls.target.z = Math.min(
            bounds[3] + marginZ,
            Math.max(bounds[1] - marginZ, controls.target.z + delta.dz),
          );
        } else {
          controls.target.x += delta.dx;
          controls.target.z += delta.dz;
        }
        controls.update();
        cameraRef.current?.cancelInterpolation();
        onChange?.();
        requestFrame();
      },
      [get, readHeading, keyboardZoomFactor, onChange, requestFrame, territoryBounds],
    );

    useEffect(() => {
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [onKeyDown]);

    /* A resize refits the frustum, so re-assert the zoom ceiling. */
    useEffect(() => {
      const ortho = get().camera as unknown as OrthographicCamera;
      if (!ortho || ortho.isOrthographicCamera !== true) return;
      if (ortho.zoom <= maxZoom) return;
      ortho.zoom = maxZoom;
      ortho.updateProjectionMatrix();
    }, [size.width, size.height, maxZoom, get]);

    /* --- Diagnostics --- */

    useImperativeHandle(ref, () => ({
      getControlsState: (): ControlsDiagnostics => {
        const c = controlsRef.current;
        if (!c) {
          return {
            target: [0, 0, 0],
            azimuthalAngle: 0,
            polarAngle: 0,
            zoom: 0,
          };
        }
        const camera = get().camera as unknown as OrthographicCamera;
        return {
          target: [c.target.x, c.target.y, c.target.z],
          azimuthalAngle: c.getAzimuthalAngle(),
          polarAngle: c.getPolarAngle(),
          zoom: camera?.zoom ?? 0,
        };
      },
      panByStep: (screenX: number, screenY: number) => {
        const controls = controlsRef.current;
        if (!controls) return;
        const ortho = get().camera as unknown as OrthographicCamera;
        if (!ortho || ortho.isOrthographicCamera !== true) return;
        const visibleWidth = Math.abs(ortho.right - ortho.left) / ortho.zoom;
        const visibleHeight = Math.abs(ortho.top - ortho.bottom) / ortho.zoom;
        const delta = worldPanFor(visibleWidth, visibleHeight, readHeading(), {
          screenX,
          screenY,
        });
        controls.target.x += delta.dx;
        controls.target.z += delta.dz;
        controls.update();
        invalidate();
      },
      zoomByFactor: (factor: number) => {
        const controls = controlsRef.current;
        if (!controls || !Number.isFinite(factor) || factor <= 0) return;
        controls.setScale(factor);
        controls.update();
        invalidate();
      },
      requestHeading: (radians: number) => cameraRef.current?.setHeading(radians),
      cancelInterpolation: () => cameraRef.current?.cancelInterpolation(),
    }));

    return (
      <DreiMapControls
        ref={controlsRef}
        makeDefault={makeDefault}
        enableDamping={enableDamping}
        dampingFactor={dampingFactor}
        enableRotate={enableRotate}
        rotateSpeed={rotateSpeed}
        enablePan={enablePan}
        panSpeed={panSpeed}
        minZoom={MIN_ZOOM}
        maxZoom={maxZoom}
        onChange={onChange}
      />
    );
  },
);

MapControls.displayName = 'MapControls';
