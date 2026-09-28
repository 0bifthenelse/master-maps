'use client';

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { MOUSE, OrthographicCamera, TOUCH } from 'three';
import { WHEEL_ZOOM_SPEED } from './mapNavigation';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

/** The two hosts three-stdlib calls pointer capture on: the canvas and the document. */
interface PointerCaptureHost {
  releasePointerCapture: (pointerId: number) => void;
  setPointerCapture: (pointerId: number) => void;
  hasPointerCapture: (pointerId: number) => boolean;
}

/**
 * Locks the polar angle to the top-down view, gates horizontal orbit on an
 * explicit caller flag so wheel zoom stays cursor-anchored, and normalises
 * two-finger touch to pinch zoom plus heading rotation.
 */
export function useControlOrbit(
  controls: MapControlsImpl | null,
  headingRotationEnabled: boolean,
  onOrbit: () => void,
): void {
  const invalidate = useThree((state) => state.invalidate);
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);

  useEffect(() => {
    if (controls === null) return;
    const ortho = camera as unknown as OrthographicCamera;
    if (ortho.isOrthographicCamera !== true) return;

    /* The mirrored north-up frustum makes (top - bottom) negative, and the
       library divides that same value into its pan direction basis, so the two
       sign flips cancel and its own drag pan still tracks the cursor. Cursor
       anchoring is left off because the single capture-phase wheel handler in
       MapControls owns zoom for every deltaMode. */
    controls.zoomToCursor = false;
    controls.zoomSpeed = WHEEL_ZOOM_SPEED;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;
    controls.screenSpacePanning = false;
    controls.mouseButtons.LEFT = MOUSE.PAN;
    controls.mouseButtons.RIGHT = MOUSE.ROTATE;
    controls.touches.ONE = TOUCH.PAN;
    controls.touches.TWO = TOUCH.DOLLY_PAN;
    const enabledPan = controls.enablePan;
    const touchPointers = new Set<number>();
    /* three-stdlib calls releasePointerCapture unconditionally on pointerup
       (OrbitControls.js:642) with no matching capture, which throws
       NotFoundError as an uncaught document-level error. Only the canvas is
       wrapped: patching the document breaks pointer dispatch. The call is
       swallowed rather than pre-checked because hasPointerCapture can report a
       capture the browser has already released. */
    const guardHost = domElement as unknown as PointerCaptureHost;
    const release = guardHost.releasePointerCapture.bind(domElement);
    const capture = guardHost.setPointerCapture.bind(domElement);
    Object.defineProperty(domElement, 'releasePointerCapture', {
      configurable: true,
      value: (pointerId: number): void => {
        try {
          release(pointerId);
        } catch {
          return;
        }
      },
    });
    Object.defineProperty(domElement, 'setPointerCapture', {
      configurable: true,
      value: (pointerId: number): void => {
        try {
          capture(pointerId);
        } catch {
          return;
        }
      },
    });
    const onTouchPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      touchPointers.add(event.pointerId);
      controls.enablePan = touchPointers.size < 2 && enabledPan;
    };
    const onTouchPointerEnd = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return;
      touchPointers.delete(event.pointerId);
      controls.enablePan = touchPointers.size < 2 && enabledPan;
    };
    domElement.addEventListener('pointerdown', onTouchPointerDown);
    domElement.addEventListener('pointerup', onTouchPointerEnd);
    domElement.addEventListener('pointercancel', onTouchPointerEnd);
    const syncOrbit = (): void => {
      onOrbit();
      invalidate();
    };
    controls.addEventListener('start', syncOrbit);
    controls.addEventListener('change', syncOrbit);
    return () => {
      controls.removeEventListener('start', syncOrbit);
      controls.removeEventListener('change', syncOrbit);
      domElement.removeEventListener('pointerdown', onTouchPointerDown);
      domElement.removeEventListener('pointerup', onTouchPointerEnd);
      domElement.removeEventListener('pointercancel', onTouchPointerEnd);
      controls.enablePan = enabledPan;
      const restorable = domElement as { releasePointerCapture?: unknown; setPointerCapture?: unknown };
      delete restorable.releasePointerCapture;
      delete restorable.setPointerCapture;
    };
  }, [controls, headingRotationEnabled, camera, domElement, invalidate, onOrbit]);
}
