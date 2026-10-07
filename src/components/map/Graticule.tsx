"use client";

import { useMemo } from "react";
import { DoubleSide, PlaneGeometry, ShaderMaterial } from "three";
import { frameUniforms } from "@/lib/render/tileMaterials";
import { MACHINE, hexToRgb } from "@/lib/map/theme";

/**
 * A faint survey grid over the territory (1 km lines, 100 m lines when close),
 * the Machine's sense of being measured. Computed per pixel from world
 * coordinates, so it costs one quad.
 */

const VERTEX = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = vec2(position.x, position.y);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uZoom;
uniform float uMpp;
uniform float uGround;
varying vec2 vWorld;
float gridLine(vec2 coordinate, float spacing) {
  vec2 cell = abs(fract(coordinate / spacing - 0.5) - 0.5) * spacing;
  vec2 width = fwidth(coordinate);
  vec2 line = 1.0 - smoothstep(vec2(0.0), width * 1.2, cell);
  return max(line.x, line.y);
}
void main() {
  float km = gridLine(vWorld, 1000.0) * smoothstep(7.5, 10.5, uZoom) * (1.0 - smoothstep(17.0, 19.0, uZoom));
  float hectometre = gridLine(vWorld, 100.0) * smoothstep(14.0, 16.0, uZoom);
  float tenKm = gridLine(vWorld, 10000.0) * (1.0 - smoothstep(11.0, 13.0, uZoom));
  float alpha = max(max(km * 0.075, hectometre * 0.045), tenKm * 0.09) * uGround;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export interface GraticuleProps {
  bounds: [number, number, number, number];
}

export default function Graticule({ bounds }: GraticuleProps) {
  const [geometry, material] = useMemo(() => {
    const margin = 20_000;
    const width = bounds[2] - bounds[0] + margin * 2;
    const height = bounds[3] - bounds[1] + margin * 2;
    const plane = new PlaneGeometry(width, height, 1, 1);
    /* PlaneGeometry lies in x/y; keep x/y as local east/north and lay it flat below. */
    plane.translate((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 0);
    const shader = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uColor: { value: hexToRgb(MACHINE.grid) },
        uZoom: frameUniforms.uZoom,
        uMpp: frameUniforms.uMpp,
        uGround: frameUniforms.uGround,
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    return [plane, shader] as const;
  }, [bounds]);
  /* Rotate the x/y plane onto x/z: local north (+y) becomes +z inside the map group. */
  return <mesh geometry={geometry} material={material} rotation={[Math.PI / 2, 0, 0]} renderOrder={7} frustumCulled={false} raycast={() => undefined} />;
}
