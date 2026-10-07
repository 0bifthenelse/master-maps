import { Matrix4, PerspectiveCamera, Vector3 } from "three";

/**
 * The map camera, as numbers.
 *
 * Map coordinates are local Lambert-93 metres: e (east) and n (north). The
 * three.js scene renders a map point (e, n) at world (e, height, -n): with x
 * east and y up, a right-handed world has north at -z. Every map object
 * lives under one group scaled (1, 1, -1) so the tile data, which stores
 * +north as +z, lands there without a mirrored projection.
 *
 * - zoom is web-map style: metres per CSS pixel = MPP_AT_ZOOM_0 / 2^zoom.
 * - bearing is the compass direction the camera faces, clockwise from north
 *   in radians (Google Maps / Mapbox convention): at bearing +90° east is up
 *   and the content appears turned counter-clockwise.
 * - pitch tilts the camera away from straight down, 0 to MAX_PITCH.
 */

/** Web-Mercator metres per pixel at zoom 0, scaled to the Gers latitude (43.65° N). */
export const MPP_AT_ZOOM_0 = 113_288;
export const FOV_DEGREES = 36.87;
export const MAX_PITCH = (60 * Math.PI) / 180;
export const DEFAULT_MIN_ZOOM = 7;
export const DEFAULT_MAX_ZOOM = 21.5;
const HALF_FOV = ((FOV_DEGREES / 2) * Math.PI) / 180;
const TAN_HALF_FOV = Math.tan(HALF_FOV);
/** Rays flatter than this from the vertical are treated as reaching the horizon. */
const HORIZON_ANGLE = (88 * Math.PI) / 180;

export type MapPoint = [number, number];

export interface ViewState {
  center: MapPoint;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** NDC depth; > 1 or < -1 means outside the depth range. */
  depth: number;
  /** False when the point is behind the camera. */
  visible: boolean;
}

export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = ((angle + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function zoomForMetresPerPixel(metresPerPixel: number): number {
  return Math.log2(MPP_AT_ZOOM_0 / metresPerPixel);
}

export function metresPerPixelAt(zoom: number): number {
  return MPP_AT_ZOOM_0 / 2 ** zoom;
}

export interface TransformConstraints {
  minZoom: number;
  maxZoom: number;
  /** Centre must stay inside [west, south, east, north]; null disables. */
  bounds: [number, number, number, number] | null;
}

export class MapTransform {
  centerE = 0;
  centerN = 0;
  zoom = 10;
  bearing = 0;
  pitch = 0;
  width = 1;
  height = 1;
  constraints: TransformConstraints = { minZoom: DEFAULT_MIN_ZOOM, maxZoom: DEFAULT_MAX_ZOOM, bounds: null };

  readonly camera = new PerspectiveCamera(FOV_DEGREES, 1, 1, 1e6);
  private readonly viewProjection = new Matrix4();
  private readonly inverseViewProjection = new Matrix4();
  private readonly scratchNear = new Vector3();
  private readonly scratchFar = new Vector3();
  private readonly target = new Vector3();
  private dirty = true;
  private version = 0;

  constructor(state?: Partial<ViewState> & { width?: number; height?: number }) {
    if (state !== undefined) this.set(state);
  }

  /** Increases every time the view changes; cheap change detection for consumers. */
  get revision(): number {
    this.ensure();
    return this.version;
  }

  get metresPerPixel(): number {
    return metresPerPixelAt(this.zoom);
  }

  get center(): MapPoint {
    return [this.centerE, this.centerN];
  }

  get state(): ViewState {
    return { center: [this.centerE, this.centerN], zoom: this.zoom, bearing: this.bearing, pitch: this.pitch };
  }

  /** Distance from the camera to the centre point, in metres. */
  get cameraDistance(): number {
    return ((this.height / 2) * this.metresPerPixel) / TAN_HALF_FOV;
  }

  set(state: Partial<ViewState> & { width?: number; height?: number }): this {
    if (state.width !== undefined) this.width = Math.max(1, state.width);
    if (state.height !== undefined) this.height = Math.max(1, state.height);
    if (state.center !== undefined) {
      this.centerE = state.center[0];
      this.centerN = state.center[1];
    }
    if (state.zoom !== undefined) this.zoom = state.zoom;
    if (state.bearing !== undefined) this.bearing = state.bearing;
    if (state.pitch !== undefined) this.pitch = state.pitch;
    this.constrain();
    this.dirty = true;
    return this;
  }

  resize(width: number, height: number): this {
    return this.set({ width, height });
  }

  setConstraints(constraints: Partial<TransformConstraints>): this {
    this.constraints = { ...this.constraints, ...constraints };
    this.constrain();
    this.dirty = true;
    return this;
  }

  clone(): MapTransform {
    const copy = new MapTransform();
    copy.constraints = { ...this.constraints, bounds: this.constraints.bounds === null ? null : [...this.constraints.bounds] };
    copy.set({ ...this.state, width: this.width, height: this.height });
    return copy;
  }

  private constrain(): void {
    const { minZoom, maxZoom, bounds } = this.constraints;
    if (!Number.isFinite(this.zoom)) this.zoom = minZoom;
    this.zoom = Math.min(maxZoom, Math.max(minZoom, this.zoom));
    this.bearing = wrapAngle(Number.isFinite(this.bearing) ? this.bearing : 0);
    this.pitch = Math.min(MAX_PITCH, Math.max(0, Number.isFinite(this.pitch) ? this.pitch : 0));
    if (!Number.isFinite(this.centerE)) this.centerE = 0;
    if (!Number.isFinite(this.centerN)) this.centerN = 0;
    if (bounds !== null) {
      this.centerE = Math.min(bounds[2], Math.max(bounds[0], this.centerE));
      this.centerN = Math.min(bounds[3], Math.max(bounds[1], this.centerN));
    }
  }

  private ensure(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.version += 1;
    const camera = this.camera;
    const distance = this.cameraDistance;
    const sinBearing = Math.sin(this.bearing);
    const cosBearing = Math.cos(this.bearing);
    const sinPitch = Math.sin(this.pitch);
    const cosPitch = Math.cos(this.pitch);
    /* forward on the ground, in three world: map (sin b, cos b) -> (sin b, 0, -cos b) */
    const fx = sinBearing;
    const fz = -cosBearing;
    this.target.set(this.centerE, 0, -this.centerN);
    camera.position.set(
      this.centerE - distance * sinPitch * fx,
      distance * cosPitch,
      -this.centerN - distance * sinPitch * fz,
    );
    camera.up.set(cosPitch * fx, sinPitch, cosPitch * fz);
    camera.lookAt(this.target);
    const altitude = distance * cosPitch;
    const topRay = Math.min(this.pitch + HALF_FOV, HORIZON_ANGLE);
    const farGround = altitude / Math.cos(topRay);
    camera.near = Math.max(0.25, altitude * 0.01);
    camera.far = Math.max(farGround * 1.2, distance * 2, 2000);
    camera.fov = FOV_DEGREES;
    camera.aspect = this.width / this.height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.inverseViewProjection.copy(this.viewProjection).invert();
  }

  /** Copy this view into a three camera (the one R3F renders with). */
  applyToCamera(target: PerspectiveCamera): void {
    this.ensure();
    target.position.copy(this.camera.position);
    target.quaternion.copy(this.camera.quaternion);
    target.up.copy(this.camera.up);
    target.fov = this.camera.fov;
    target.aspect = this.camera.aspect;
    target.near = this.camera.near;
    target.far = this.camera.far;
    target.updateProjectionMatrix();
    target.updateMatrixWorld(true);
  }

  get viewProjectionMatrix(): Matrix4 {
    this.ensure();
    return this.viewProjection;
  }

  /** Screen position (CSS pixels from the top-left) of a map point at a height. */
  project(e: number, n: number, height = 0, out?: ScreenPoint): ScreenPoint {
    this.ensure();
    const m = this.viewProjection.elements;
    const x = e;
    const y = height;
    const z = -n;
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    const result = out ?? { x: 0, y: 0, depth: 0, visible: false };
    if (w <= 1e-9) {
      result.x = Number.NaN;
      result.y = Number.NaN;
      result.depth = 2;
      result.visible = false;
      return result;
    }
    const ndcX = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
    const ndcY = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    const ndcZ = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w;
    result.x = ((ndcX + 1) / 2) * this.width;
    result.y = ((1 - ndcY) / 2) * this.height;
    result.depth = ndcZ;
    result.visible = ndcZ >= -1 && ndcZ <= 1;
    return result;
  }

  /** Shorthand returning [x, y] in CSS pixels. */
  mapToScreen(e: number, n: number, height = 0): [number, number] {
    const point = this.project(e, n, height);
    return [point.x, point.y];
  }

  /** Ray from the camera through a screen pixel, in three world coordinates. */
  screenRay(x: number, y: number): { origin: Vector3; direction: Vector3 } {
    this.ensure();
    const ndcX = (x / this.width) * 2 - 1;
    const ndcY = 1 - (y / this.height) * 2;
    const near = this.scratchNear.set(ndcX, ndcY, -1).applyMatrix4(this.inverseViewProjection);
    const far = this.scratchFar.set(ndcX, ndcY, 1).applyMatrix4(this.inverseViewProjection);
    return { origin: near.clone(), direction: far.clone().sub(near).normalize() };
  }

  /**
   * The map point under a screen pixel: the ray meets the ground plane. A
   * pixel above the horizon (only possible when tilted) resolves to the
   * point where its ray would touch the ground at the horizon limit.
   */
  screenToMap(x: number, y: number): MapPoint {
    const { origin, direction } = this.screenRay(x, y);
    const minDown = -Math.cos(HORIZON_ANGLE);
    let dy = direction.y;
    if (dy > minDown) {
      /* Flatten the ray to the horizon limit while keeping its heading. */
      const horizontal = Math.hypot(direction.x, direction.z) || 1;
      const scale = Math.sin(HORIZON_ANGLE) / horizontal;
      direction.set(direction.x * scale, minDown, direction.z * scale);
      dy = minDown;
    }
    const t = -origin.y / dy;
    return [origin.x + direction.x * t, -(origin.z + direction.z * t)];
  }

  /** Visible ground polygon, corners top-left, top-right, bottom-right, bottom-left. */
  groundFootprint(margin = 0): MapPoint[] {
    return [
      this.screenToMap(-margin, -margin),
      this.screenToMap(this.width + margin, -margin),
      this.screenToMap(this.width + margin, this.height + margin),
      this.screenToMap(-margin, this.height + margin),
    ];
  }

  /** Metres per pixel at a screen row; larger towards the horizon when tilted. */
  metresPerPixelAtRow(y: number): number {
    const a = this.screenToMap(this.width / 2, y);
    const b = this.screenToMap(this.width / 2 + 1, y);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /* ---------------------------------------------------------------- */
  /*  Anchored edits: the map point under a screen pixel stays put      */
  /* ---------------------------------------------------------------- */

  /** Shift the centre so that `point` ends up under screen pixel (x, y). */
  setLocationAtPoint(point: MapPoint, x: number, y: number): this {
    const current = this.screenToMap(x, y);
    this.centerE += point[0] - current[0];
    this.centerN += point[1] - current[1];
    this.constrain();
    this.dirty = true;
    return this;
  }

  zoomAround(zoom: number, x: number, y: number): this {
    const anchor = this.screenToMap(x, y);
    this.zoom = zoom;
    this.constrain();
    this.dirty = true;
    return this.setLocationAtPoint(anchor, x, y);
  }

  rotateAround(bearing: number, x: number, y: number): this {
    const anchor = this.screenToMap(x, y);
    this.bearing = bearing;
    this.constrain();
    this.dirty = true;
    return this.setLocationAtPoint(anchor, x, y);
  }

  /** Pan by a screen delta in pixels (content follows the pointer). */
  panBy(dx: number, dy: number): this {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const anchor = this.screenToMap(cx, cy);
    return this.setLocationAtPoint(anchor, cx + dx, cy + dy);
  }

  /** Zoom that fits a map rectangle in the viewport at the current bearing, pitch ignored. */
  zoomToFit(bounds: [number, number, number, number], padding: { top: number; right: number; bottom: number; left: number }, bearing = this.bearing): number {
    const [west, south, east, north] = bounds;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [e, n] of [[west, south], [east, south], [east, north], [west, north]] as const) {
      /* Screen axes at this bearing: right = (cos b, -sin b), up = (sin b, cos b). */
      const sx = e * cos - n * sin;
      const sy = e * sin + n * cos;
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    const availableWidth = Math.max(1, this.width - padding.left - padding.right);
    const availableHeight = Math.max(1, this.height - padding.top - padding.bottom);
    const mpp = Math.max((maxX - minX) / availableWidth, (maxY - minY) / availableHeight, 1e-3);
    return zoomForMetresPerPixel(mpp);
  }
}
