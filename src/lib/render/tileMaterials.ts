import { Color, DoubleSide, ShaderMaterial, Vector4, type IUniform } from "three";
import {
  BOUNDARY_LOOK,
  BOUNDARY_STYLES,
  BUILDING_ROOF_COLORS,
  BUILDING_STYLES,
  LANDCOVER_COLORS,
  LANDCOVER_STYLES,
  MACHINE,
  RAIL_LOOK,
  RAIL_STYLES,
  ROAD_LOOK,
  ROAD_STYLES,
  STRUCTURE_AREA_COLORS,
  STRUCTURE_LINE_LOOK,
  STRUCTURE_STYLES,
  TRANSPORT_AREA_COLORS,
  TRANSPORT_AREA_STYLES,
  WATER_AREA_COLORS,
  WATER_AREA_STYLES,
  WATER_LINE_LOOK,
  WATER_LINE_STYLES,
  hexToRgb,
  type LineLook,
} from "@/lib/map/theme";
import type { RenderLayerId } from "./codec";

/**
 * Uniforms every tile material reads; the scene updates them once per frame
 * and every material sees the change because they share these objects.
 */
export const frameUniforms = {
  uMpp: { value: 10 } as IUniform<number>,
  uZoom: { value: 10 } as IUniform<number>,
  /** 0 hides the ground fills (satellite under the vectors), 1 shows them. */
  uGround: { value: 1 } as IUniform<number>,
  /** Scales building heights; 0 flattens them at low zoom. */
  uHeightScale: { value: 1 } as IUniform<number>,
  /** 1 in satellite mode: lines turn lighter and translucent over imagery. */
  uSatellite: { value: 0 } as IUniform<number>,
  uTime: { value: 0 } as IUniform<number>,
};

const MAX_STYLES = 24;

function colorArray(colors: readonly string[], alphas?: readonly number[]): Vector4[] {
  const array: Vector4[] = [];
  for (let index = 0; index < MAX_STYLES; index += 1) {
    const hex = colors[index] ?? "#ff00ff";
    const [r, g, b] = hexToRgb(hex);
    array.push(new Vector4(r, g, b, alphas?.[index] ?? 1));
  }
  return array;
}

function paramArray(looks: readonly LineLook[]): Vector4[] {
  const array: Vector4[] = [];
  for (let index = 0; index < MAX_STYLES; index += 1) {
    const look = looks[index];
    array.push(look === undefined ? new Vector4(1, 0, 0, 0) : new Vector4(look.minHalfPx, look.fromZoom, look.dash[0], look.dash[1]));
  }
  return array;
}

/* ------------------------------------------------------------------ */
/*  Fills                                                              */
/* ------------------------------------------------------------------ */

const FILL_VERTEX = /* glsl */ `
attribute float aStyle;
uniform vec4 uColors[${MAX_STYLES}];
varying vec4 vColor;
void main() {
  int s = int(aStyle + 0.5);
  vColor = uColors[s];
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FILL_FRAGMENT = /* glsl */ `
uniform float uGround;
uniform float uLayerOpacity;
varying vec4 vColor;
void main() {
  float alpha = vColor.a * uLayerOpacity * uGround;
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
}
`;

function fillMaterial(colors: readonly string[], opacity = 1, alphas?: readonly number[]): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FILL_VERTEX,
    fragmentShader: FILL_FRAGMENT,
    uniforms: {
      uColors: { value: colorArray(colors, alphas) },
      uGround: frameUniforms.uGround,
      uLayerOpacity: { value: opacity },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
}

/* ------------------------------------------------------------------ */
/*  Lines                                                              */
/* ------------------------------------------------------------------ */

const LINE_VERTEX = /* glsl */ `
attribute vec2 aExtrude;
attribute float aHalfWidth;
attribute float aStyle;
attribute float aDistance;
uniform vec4 uColors[${MAX_STYLES}];
uniform vec4 uParams[${MAX_STYLES}];
uniform float uMpp;
uniform float uZoom;
uniform float uExtraPx;
uniform float uWidthScale;
uniform float uMaxHalfPx;
varying vec4 vColor;
varying float vDistancePx;
varying vec2 vDash;
varying float vFade;
void main() {
  int s = int(aStyle + 0.5);
  vec4 params = uParams[s];
  vColor = uColors[s];
  float halfMetres = max(aHalfWidth * uWidthScale, params.x * uMpp);
  halfMetres = min(halfMetres, uMaxHalfPx * uMpp);
  halfMetres += uExtraPx * uMpp;
  vec3 world = position + vec3(aExtrude.x, 0.0, aExtrude.y) * halfMetres;
  vDistancePx = aDistance / uMpp;
  vDash = params.zw;
  /* fromZoom > 0 fades a line in up to that zoom; < 0 fades it out from there. */
  vFade = params.y >= 0.0 ? smoothstep(params.y - 0.75, params.y, uZoom) : 1.0 - smoothstep(-params.y - 0.75, -params.y, uZoom);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const LINE_FRAGMENT = /* glsl */ `
uniform float uLayerOpacity;
uniform float uSatellite;
uniform vec3 uSatelliteTint;
varying vec4 vColor;
varying float vDistancePx;
varying vec2 vDash;
varying float vFade;
void main() {
  if (vDash.x > 0.0) {
    float period = vDash.x + vDash.y;
    if (mod(vDistancePx, period) > vDash.x) discard;
  }
  float alpha = vColor.a * uLayerOpacity * vFade * mix(1.0, 0.82, uSatellite);
  if (alpha <= 0.002) discard;
  vec3 rgb = mix(vColor.rgb, max(vColor.rgb, uSatelliteTint), uSatellite * 0.35);
  gl_FragColor = vec4(rgb, alpha);
}
`;

interface LineMaterialOptions {
  colors: readonly string[];
  alphas?: readonly number[];
  params: readonly LineLook[];
  extraPx?: number;
  opacity?: number;
  widthScale?: number;
  maxHalfPx?: number;
  /** Casing passes are solid even when the fill is dashed. */
  solid?: boolean;
}

function lineMaterial(options: LineMaterialOptions): ShaderMaterial {
  const params = options.solid === true ? options.params.map((look) => ({ ...look, dash: [0, 0] as [number, number] })) : options.params;
  return new ShaderMaterial({
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    uniforms: {
      uColors: { value: colorArray(options.colors, options.alphas ?? options.params.map((look) => look.opacity)) },
      uParams: { value: paramArray(params) },
      uMpp: frameUniforms.uMpp,
      uZoom: frameUniforms.uZoom,
      uSatellite: frameUniforms.uSatellite,
      uSatelliteTint: { value: new Color("#ffffff") },
      uExtraPx: { value: options.extraPx ?? 0 },
      uWidthScale: { value: options.widthScale ?? 1 },
      uMaxHalfPx: { value: options.maxHalfPx ?? 60 },
      uLayerOpacity: { value: options.opacity ?? 1 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
}

/* ------------------------------------------------------------------ */
/*  Buildings                                                          */
/* ------------------------------------------------------------------ */

const BUILDING_VERTEX = /* glsl */ `
attribute float aHeight;
attribute float aStyle;
uniform vec4 uRoofs[${MAX_STYLES}];
uniform float uHeightScale;
varying vec3 vWorld;
varying float vRelative;
varying vec3 vRoof;
void main() {
  int s = int(aStyle + 0.5);
  vRoof = uRoofs[s].rgb;
  vec3 local = position;
  vRelative = local.y / max(aHeight, 0.1);
  local.y *= uHeightScale;
  vec4 world = modelMatrix * vec4(local, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const BUILDING_FRAGMENT = /* glsl */ `
uniform vec3 uWall;
uniform vec3 uEdge;
uniform float uOpacity;
uniform float uSatellite;
varying vec3 vWorld;
varying float vRelative;
varying vec3 vRoof;
void main() {
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(normal, cameraPosition - vWorld) < 0.0) normal = -normal;
  float roof = step(0.6, abs(normal.y));
  vec3 light = normalize(vec3(-0.42, 0.78, 0.46));
  float lambert = 0.58 + 0.42 * max(dot(normal, light), 0.0);
  vec3 wall = uWall * (0.55 + 0.45 * vRelative) * lambert;
  vec3 color = mix(wall, vRoof * (0.92 + 0.08 * lambert), roof);
  /* A cold band of light along the top of each wall: the Machine's wireframe city. */
  float rim = (1.0 - roof) * smoothstep(0.86, 1.0, vRelative);
  color = mix(color, uEdge, rim * 0.55);
  /* Over aerial imagery the roofs turn to glass so the photo shows through a wireframe city. */
  float alpha = uOpacity * mix(1.0, mix(0.5, 0.08, roof), uSatellite);
  gl_FragColor = vec4(color, alpha);
}
`;

const EDGE_VERTEX = /* glsl */ `
uniform float uHeightScale;
void main() {
  vec3 local = position;
  local.y *= uHeightScale;
  local.y += 0.05;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);
}
`;

const EDGE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uZoom;
void main() {
  float alpha = uOpacity * smoothstep(14.5, 16.5, uZoom);
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

/* ------------------------------------------------------------------ */
/*  Material registry                                                  */
/* ------------------------------------------------------------------ */

export interface LayerPasses {
  /** Drawn first (casings, glows), then `main`. */
  under?: ShaderMaterial;
  main: ShaderMaterial;
  /** Painter order of the main pass; the under pass draws at order - 0.5. */
  order: number;
}

let registry: Map<RenderLayerId, LayerPasses> | null = null;
let buildingEdgeMaterial: ShaderMaterial | null = null;

const roadColors = ROAD_STYLES.map((style) => ROAD_LOOK[style].fill);
const roadCasings = ROAD_STYLES.map((style) => ROAD_LOOK[style].casing);
const roadParams: LineLook[] = ROAD_STYLES.map((style) => ({ color: ROAD_LOOK[style].fill, minHalfPx: ROAD_LOOK[style].minHalfPx, fromZoom: ROAD_LOOK[style].fromZoom, dash: ROAD_LOOK[style].dash, opacity: 1 }));

export function layerMaterials(): Map<RenderLayerId, LayerPasses> {
  if (registry !== null) return registry;
  const map = new Map<RenderLayerId, LayerPasses>();
  map.set("landcover", { main: fillMaterial(LANDCOVER_STYLES.map((style) => LANDCOVER_COLORS[style])), order: 1 });
  map.set("water_area", { main: fillMaterial(WATER_AREA_STYLES.map((style) => WATER_AREA_COLORS[style])), order: 3 });
  map.set("transport_area", { main: fillMaterial(TRANSPORT_AREA_STYLES.map((style) => TRANSPORT_AREA_COLORS[style])), order: 4 });
  map.set("structure_area", { main: fillMaterial(STRUCTURE_STYLES.map((style) => STRUCTURE_AREA_COLORS[style])), order: 5 });
  const waterLooks = WATER_LINE_STYLES.map((style) => WATER_LINE_LOOK[style]);
  map.set("water_line", { main: lineMaterial({ colors: waterLooks.map((look) => look.color), params: waterLooks }), order: 6 });
  const railLooks = RAIL_STYLES.map((style) => RAIL_LOOK[style]);
  map.set("rail", {
    under: lineMaterial({ colors: railLooks.map(() => "#05070a"), params: railLooks, extraPx: 1, solid: true, opacity: 0.9 }),
    main: lineMaterial({ colors: railLooks.map((look) => look.color), params: railLooks }),
    order: 8,
  });
  map.set("road_tunnel", {
    main: lineMaterial({ colors: roadColors, params: roadParams.map((look) => ({ ...look, dash: [4, 4] as [number, number] })), opacity: 0.45 }),
    order: 9,
  });
  map.set("road", {
    under: lineMaterial({ colors: roadCasings, params: roadParams, extraPx: 1.1, solid: true }),
    main: lineMaterial({ colors: roadColors, params: roadParams }),
    order: 11,
  });
  map.set("road_bridge", {
    /* The dark deck edge only reads at street scale; earlier, a culvert's widened casing would cut its road into dashes. */
    under: lineMaterial({ colors: roadParams.map(() => "#020305"), params: roadParams.map((look) => ({ ...look, fromZoom: Math.max(look.fromZoom, 15.5) })), extraPx: 1.8, solid: true }),
    main: lineMaterial({ colors: roadColors, params: roadParams }),
    order: 13,
  });
  const structureLooks = STRUCTURE_STYLES.map((style) => STRUCTURE_LINE_LOOK[style]);
  map.set("structure_line", { main: lineMaterial({ colors: structureLooks.map((look) => look.color), params: structureLooks }), order: 14 });
  const boundaryLooks = BOUNDARY_STYLES.map((style) => BOUNDARY_LOOK[style]);
  map.set("boundary", {
    under: lineMaterial({ colors: boundaryLooks.map((look) => look.color), alphas: [0.16, 0, 0.16], params: boundaryLooks, extraPx: 3, solid: true }),
    main: lineMaterial({ colors: boundaryLooks.map((look) => look.color), params: boundaryLooks, maxHalfPx: 1.6 }),
    order: 15,
  });
  const roofs = colorArray(BUILDING_STYLES.map((style) => BUILDING_ROOF_COLORS[style]));
  map.set("building", {
    main: new ShaderMaterial({
      vertexShader: BUILDING_VERTEX,
      fragmentShader: BUILDING_FRAGMENT,
      uniforms: {
        uRoofs: { value: roofs },
        uWall: { value: new Color(...hexToRgb(MACHINE.walls)) },
        uEdge: { value: new Color(...hexToRgb(MACHINE.edges)) },
        uHeightScale: frameUniforms.uHeightScale,
        uSatellite: frameUniforms.uSatellite,
        uOpacity: { value: 1 },
      },
      /* Every map material sits in the transparent list so one renderOrder
         sequence governs the whole frame: ground, lines, then buildings. */
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: DoubleSide,
    }),
    order: 30,
  });
  registry = map;
  return map;
}

export function buildingEdgesMaterial(): ShaderMaterial {
  if (buildingEdgeMaterial !== null) return buildingEdgeMaterial;
  buildingEdgeMaterial = new ShaderMaterial({
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    uniforms: {
      uColor: { value: new Color(...hexToRgb(MACHINE.edges)) },
      uOpacity: { value: 0.55 },
      uZoom: frameUniforms.uZoom,
      uHeightScale: frameUniforms.uHeightScale,
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  return buildingEdgeMaterial;
}

/** Update the per-frame uniforms from the camera state. */
export function updateFrameUniforms(zoom: number, metresPerPixel: number, satellite: boolean): void {
  frameUniforms.uZoom.value = zoom;
  frameUniforms.uMpp.value = metresPerPixel;
  frameUniforms.uHeightScale.value = Math.min(1, Math.max(0, (zoom - 14.6) / 1.4));
  frameUniforms.uGround.value = satellite ? 0 : 1;
  frameUniforms.uSatellite.value = satellite ? 1 : 0;
}
