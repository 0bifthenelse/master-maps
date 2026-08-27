'use client';

import { useThree } from '@react-three/fiber';
import { MapControls as DreiMapControls } from '@react-three/drei';
import { forwardRef, useEffect, useRef, useImperativeHandle, useCallback } from 'react';
import type { OrthographicCamera } from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

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
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface MapControlsProps {
  /** Minimum zoom level */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
  /** Enable damping for smooth interaction */
  enableDamping?: boolean;
  /** Damping factor */
  dampingFactor?: number;
  /** Enable in-plane rotation */
  enableRotate?: boolean;
  /** Rotation speed */
  rotateSpeed?: number;
  /** Enable panning */
  enablePan?: boolean;
  /** Pan speed */
  panSpeed?: number;
  /** Screen-space panning (dragging feels correct regardless of rotation) */
  screenSpacePanning?: boolean;
  /** Register as the R3F default controls */
  makeDefault?: boolean;
  /** Commune bounds [west, south, east, north] in local metres — used by HJKL */
  communeBounds?: [number, number, number, number];
  /** Callback when camera changes */
  onChange?: () => void;
}

const TEXT_TAGS: Record<string, true> = { INPUT: true, TEXTAREA: true, SELECT: true };

/**
 * Determine whether a keyboard event should be absorbed by this component
 * rather than forwarded to the focused element.
 */
function shouldHandle(e: KeyboardEvent): boolean {
  if (!(e.target instanceof HTMLElement)) return false;
  if (TEXT_TAGS[e.target.tagName]) return false;
  if (e.target.isContentEditable) return false;
  return true;
}

export const MapControls = forwardRef<ControlsHandle, MapControlsProps>(
  (
    {
      minZoom = 0.1,
      maxZoom = 200,
      enableDamping = true,
      dampingFactor = 0.08,
      enableRotate = true,
      rotateSpeed = 0.5,
      enablePan = true,
      panSpeed = 0.5,
      screenSpacePanning = true,
      makeDefault = true,
      communeBounds,
      onChange,
    },
    ref,
  ) => {
    const controlsRef = useRef<MapControlsImpl>(null!);
    const { get } = useThree();

    /* --- HJKL keyboard handling --- */

    const onKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (!shouldHandle(e)) return;
        if (!communeBounds) return;

        const controls = controlsRef.current;
        if (!controls) return;

        const camera = get().camera as unknown as OrthographicCamera;
        if (!camera || !('isOrthographicCamera' in camera)) return;

        // Visible span in world units: (frustum extent) / zoom.
        // Move target by 25% of the visible span per keypress.
        const halfSpanX = ((camera.right - camera.left) / camera.zoom) * 0.25;
        const halfSpanZ = ((camera.top - camera.bottom) / camera.zoom) * 0.25;

        /* Which direction does "north" point on screen?  Need to account for
           azimuthal (in-plane) rotation.  Zero rotation → +z is up on screen.
           Clockwise rotation → up rotates accordingly. */
        const azimuth = controls.getAzimuthalAngle();
        const cosA = Math.cos(azimuth);
        const sinA = Math.sin(azimuth);

        let dx = 0;
        let dz = 0;

        switch (e.code) {
          case 'KeyH': /* west  */ { dx = -1; break; }
          case 'KeyL': /* east  */ { dx = 1; break; }
          case 'KeyJ': /* south */ { dz = -1; break; }
          case 'KeyK': /* north */ { dz = 1; break; }
          default:
            return;
        }

        /* Rotate the move vector by the inverse of the azimuth so that
           HJKL always move in world NSEW directions regardless of rotation */
        const worldDx = dx * cosA + dz * sinA;
        const worldDz = -dx * sinA + dz * cosA;

        controls.target.x += worldDx * halfSpanX;
        controls.target.z += worldDz * halfSpanZ;
        controls.update();
      },
      [communeBounds, get],
    );

    useEffect(() => {
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [onKeyDown]);

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
        screenSpacePanning={screenSpacePanning}
        minZoom={minZoom}
        maxZoom={maxZoom}
        maxPolarAngle={0}
        minPolarAngle={0}
        onChange={onChange}
      />
    );
  },
);

MapControls.displayName = 'MapControls';
