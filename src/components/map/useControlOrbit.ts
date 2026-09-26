'use client';

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { MOUSE, OrthographicCamera, TOUCH } from 'three';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

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

    controls.minPolarAngle = 0;
    controls.maxPolarAngle = 0;
    controls.screenSpacePanning = false;
    controls.mouseButtons.LEFT = MOUSE.PAN;
    controls.mouseButtons.RIGHT = MOUSE.ROTATE;
    controls.touches.ONE = TOUCH.PAN;
    controls.touches.TWO = TOUCH.DOLLY_ROTATE;
    const syncOrbit = (): void => {
      onOrbit();
      invalidate();
    };
    controls.addEventListener('start', syncOrbit);
    controls.addEventListener('change', syncOrbit);
    return () => {
      controls.removeEventListener('start', syncOrbit);
      controls.removeEventListener('change', syncOrbit);
    };
  }, [controls, headingRotationEnabled, camera, domElement, invalidate, onOrbit]);
}
