import { MapTransform, MAX_PITCH, wrapAngle, type MapPoint, type ViewState } from "./transform";

/**
 * Pointer, wheel, touch and keyboard navigation for MapTransform.
 *
 * Every gesture is anchored: the map point under the cursor (or between two
 * fingers) stays under it while the view zooms, turns or tilts, which is what
 * makes a map feel "held" rather than steered. Motion is driven from one
 * requestAnimationFrame loop that only runs while something moves.
 */

export type ChangeReason = "pan" | "zoom" | "rotate" | "pitch" | "animate" | "resize" | "jump";

export interface ControllerCallbacks {
  /** Called whenever the transform changed (at most once per frame per source). */
  onChange: (reason: ChangeReason) => void;
  /** Primary click/tap that did not turn into a drag. */
  onClick?: (x: number, y: number, event: PointerEvent | MouseEvent) => void;
  /** Secondary click that did not turn into a rotate. */
  onContextMenu?: (x: number, y: number, event: MouseEvent) => void;
  /** Pointer moved over the map without dragging. */
  onHover?: (x: number, y: number) => void;
  onHoverEnd?: () => void;
  /** True while the user asked the OS to reduce motion. */
  reducedMotion?: () => boolean;
  /** Called on interactions that should dismiss transient UI. */
  onInteractionStart?: () => void;
}

export interface EaseOptions extends Partial<ViewState> {
  duration?: number;
  /** Keep this screen pixel's map point fixed (zoom/rotate around the cursor). */
  around?: [number, number];
  easing?: (t: number) => number;
}

export interface FlyOptions extends Partial<ViewState> {
  /** Average speed, in "screenfuls" per second (Mapbox convention, default 1.3). */
  speed?: number;
  maxDuration?: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DRAG_THRESHOLD_PX = 3;
const TAP_MAX_MS = 280;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 28;
const WHEEL_LEVELS_PER_NOTCH = 0.85;
const WHEEL_NOTCH = 100;
const WHEEL_EASE_MS = 90;
const TRACKPAD_ZOOM_RATE = 1 / 220;
const PINCH_ZOOM_RATE = 1 / 85;
const ROTATE_RADIANS_PER_PX = (0.45 * Math.PI) / 180;
const PITCH_RADIANS_PER_PX = (0.35 * Math.PI) / 180;
const INERTIA_SAMPLE_MS = 90;
const INERTIA_DECAY_MS = 320;
const INERTIA_MIN_SPEED = 0.06; /* px per ms */
const INERTIA_MAX_SPEED = 4.5;
const KEY_PAN_PX = 120;
const KEY_ROTATE = (15 * Math.PI) / 180;
const KEY_PITCH = (10 * Math.PI) / 180;

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface Ease {
  from: ViewState;
  to: ViewState;
  start: number;
  duration: number;
  easing: (t: number) => number;
  around: [number, number] | null;
  aroundPoint: MapPoint | null;
  fly: FlyPath | null;
  resolve: () => void;
}

interface FlyPath {
  S: number;
  r0: number;
  rho: number;
  w0: number;
  u1: number;
  startZoom: number;
}

interface PointerSample {
  t: number;
  x: number;
  y: number;
}

interface TrackedPointer {
  id: number;
  type: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startTime: number;
}

type DragMode = "none" | "pan" | "rotate" | "pinch";

export class MapController {
  private readonly pointers = new Map<number, TrackedPointer>();
  private dragMode: DragMode = "none";
  private dragged = false;
  private grabbed: MapPoint | null = null;
  private rotateStart = { x: 0, y: 0, bearing: 0, pitch: 0 };
  private pinch = { midX: 0, midY: 0, distance: 0, angle: 0, tilt: false, decided: false, moved: 0, startTime: 0, startMidY: 0 };
  private samples: PointerSample[] = [];
  private inertia: { vx: number; vy: number; last: number } | null = null;
  private wheel: { target: number; x: number; y: number; last: number } | null = null;
  private ease: Ease | null = null;
  private frame: number | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private hoverFrame: number | null = null;
  private hoverPoint: [number, number] | null = null;
  private attached = false;

  constructor(
    private readonly element: HTMLElement,
    readonly transform: MapTransform,
    private readonly callbacks: ControllerCallbacks,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const element = this.element;
    element.style.touchAction = "none";
    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointermove", this.onPointerMove);
    element.addEventListener("pointerup", this.onPointerUp);
    element.addEventListener("pointercancel", this.onPointerCancel);
    element.addEventListener("pointerleave", this.onPointerLeave);
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("dblclick", this.onDoubleClick);
    element.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    this.updateCursor();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const element = this.element;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerCancel);
    element.removeEventListener("pointerleave", this.onPointerLeave);
    element.removeEventListener("wheel", this.onWheel);
    element.removeEventListener("dblclick", this.onDoubleClick);
    element.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame);
    this.frame = null;
    this.hoverFrame = null;
  }

  /** True while an animation, inertia or a gesture is changing the view. */
  isMoving(): boolean {
    return this.ease !== null || this.inertia !== null || this.wheel !== null || this.dragMode !== "none";
  }

  /* ---------------------------------------------------------------- */
  /*  Programmatic camera                                               */
  /* ---------------------------------------------------------------- */

  stop(): void {
    if (this.ease !== null) {
      const resolve = this.ease.resolve;
      this.ease = null;
      resolve();
    }
    this.inertia = null;
    this.wheel = null;
  }

  jumpTo(state: Partial<ViewState>): void {
    this.stop();
    this.transform.set(state);
    this.callbacks.onChange("jump");
  }

  easeTo(options: EaseOptions): Promise<void> {
    this.stop();
    const from = this.transform.state;
    const to: ViewState = {
      center: options.center ?? from.center,
      zoom: options.zoom ?? from.zoom,
      bearing: options.bearing ?? from.bearing,
      pitch: options.pitch ?? from.pitch,
    };
    const duration = this.callbacks.reducedMotion?.() === true ? 0 : options.duration ?? 320;
    const around = options.center === undefined && options.around !== undefined ? options.around : null;
    if (duration <= 0) {
      if (around !== null) {
        const point = this.transform.screenToMap(...around);
        this.transform.set({ zoom: to.zoom, bearing: to.bearing, pitch: to.pitch });
        this.transform.setLocationAtPoint(point, ...around);
      } else {
        this.transform.set(to);
      }
      this.callbacks.onChange("jump");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.ease = {
        from,
        to,
        start: performance.now(),
        duration,
        easing: options.easing ?? easeOutCubic,
        around,
        aroundPoint: around === null ? null : this.transform.screenToMap(...around),
        fly: null,
        resolve,
      };
      this.schedule();
    });
  }

  /** Zoom out, travel, zoom in: the van Wijk & Nuij optimal path used by every web map. */
  flyTo(options: FlyOptions): Promise<void> {
    this.stop();
    const t = this.transform;
    const from = t.state;
    const to: ViewState = {
      center: options.center ?? from.center,
      zoom: options.zoom ?? from.zoom,
      bearing: options.bearing ?? from.bearing,
      pitch: options.pitch ?? from.pitch,
    };
    if (this.callbacks.reducedMotion?.() === true) {
      t.set(to);
      this.callbacks.onChange("jump");
      return Promise.resolve();
    }
    const rho = 1.42;
    const w0 = Math.max(t.width, t.height);
    const scale = 2 ** (to.zoom - from.zoom);
    const w1 = w0 / scale;
    const u1 = Math.hypot(to.center[0] - from.center[0], to.center[1] - from.center[1]) / t.metresPerPixel;
    const rho2 = rho * rho;
    let S: number;
    let r0 = 0;
    let fly: FlyPath | null = null;
    if (u1 < 1) {
      S = Math.abs(Math.log(w1 / w0)) / rho;
    } else {
      const b = (i: 0 | 1): number => ((w1 * w1 - w0 * w0 + (i === 0 ? 1 : -1) * rho2 * rho2 * u1 * u1) / (2 * (i === 0 ? w0 : w1) * rho2 * u1));
      const r = (i: 0 | 1): number => Math.log(Math.sqrt(b(i) * b(i) + 1) - b(i));
      r0 = r(0);
      S = (r(1) - r0) / rho;
      fly = { S, r0, rho, w0, u1, startZoom: from.zoom };
    }
    const speed = options.speed ?? 1.3;
    let duration = (1000 * Math.max(S, 0.4)) / speed;
    duration = Math.min(duration, options.maxDuration ?? 2600);
    if (!Number.isFinite(duration)) duration = 600;
    return new Promise((resolve) => {
      this.ease = { from, to, start: performance.now(), duration, easing: easeInOutCubic, around: null, aroundPoint: null, fly, resolve };
      this.schedule();
    });
  }

  /** Frame a map rectangle with padding, optionally at a new bearing. */
  fitBounds(bounds: [number, number, number, number], options: { padding?: Partial<Padding>; maxZoom?: number; bearing?: number; pitch?: number; animate?: "ease" | "fly" | "none" } = {}): Promise<void> {
    const padding: Padding = { top: 40, right: 40, bottom: 40, left: 40, ...options.padding };
    const bearing = options.bearing ?? this.transform.bearing;
    const zoom = Math.min(options.maxZoom ?? this.transform.constraints.maxZoom, this.transform.zoomToFit(bounds, padding, bearing));
    /* Shift the centre so the padded area, not the whole canvas, is centred. */
    const mpp = 113_288 / 2 ** zoom;
    const offsetX = ((padding.left - padding.right) / 2) * mpp;
    const offsetY = ((padding.top - padding.bottom) / 2) * mpp;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    const centre: MapPoint = [
      (bounds[0] + bounds[2]) / 2 - (offsetX * cos + offsetY * sin),
      (bounds[1] + bounds[3]) / 2 - (-offsetX * sin + offsetY * cos),
    ];
    const target = { center: centre, zoom, bearing, pitch: options.pitch ?? this.transform.pitch };
    if (options.animate === "none") {
      this.jumpTo(target);
      return Promise.resolve();
    }
    return options.animate === "ease" ? this.easeTo({ ...target, duration: 450 }) : this.flyTo(target);
  }

  zoomBy(levels: number, around?: [number, number], duration = 260): Promise<void> {
    const anchor = around ?? [this.transform.width / 2, this.transform.height / 2];
    return this.easeTo({ zoom: this.transform.zoom + levels, around: anchor, duration });
  }

  resetNorth(duration = 420): Promise<void> {
    return this.easeTo({ bearing: 0, pitch: 0, duration, around: [this.transform.width / 2, this.transform.height / 2] });
  }

  /* ---------------------------------------------------------------- */
  /*  Frame loop                                                        */
  /* ---------------------------------------------------------------- */

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    let changed: ChangeReason | null = null;
    if (this.ease !== null) {
      changed = "animate";
      const ease = this.ease;
      const raw = ease.duration <= 0 ? 1 : Math.min(1, (now - ease.start) / ease.duration);
      this.applyEase(ease, raw);
      if (raw >= 1) {
        this.ease = null;
        ease.resolve();
      }
    }
    if (this.inertia !== null) {
      const inertia = this.inertia;
      const dt = Math.min(64, now - inertia.last);
      inertia.last = now;
      const decay = Math.exp(-dt / INERTIA_DECAY_MS);
      const dx = inertia.vx * dt;
      const dy = inertia.vy * dt;
      this.transform.panBy(-dx, -dy);
      inertia.vx *= decay;
      inertia.vy *= decay;
      changed = "pan";
      if (Math.hypot(inertia.vx, inertia.vy) < 0.01) this.inertia = null;
    }
    if (this.wheel !== null) {
      const wheel = this.wheel;
      const dt = Math.min(64, now - wheel.last);
      wheel.last = now;
      const diff = wheel.target - this.transform.zoom;
      const step = Math.abs(diff) < 0.004 ? diff : diff * (1 - Math.exp(-dt / WHEEL_EASE_MS));
      this.transform.zoomAround(this.transform.zoom + step, wheel.x, wheel.y);
      changed = "zoom";
      if (Math.abs(wheel.target - this.transform.zoom) < 0.004 || step === 0) this.wheel = null;
    }
    if (changed !== null) this.callbacks.onChange(changed);
    if (this.ease !== null || this.inertia !== null || this.wheel !== null) this.schedule();
  };

  private applyEase(ease: Ease, raw: number): void {
    const k = ease.easing(raw);
    const { from, to } = ease;
    const bearing = from.bearing + wrapAngle(to.bearing - from.bearing) * k;
    const pitch = from.pitch + (to.pitch - from.pitch) * k;
    if (ease.fly !== null) {
      const { S, r0, rho, w0, u1, startZoom } = ease.fly;
      const s = k * S;
      const w = Math.cosh(r0) / Math.cosh(r0 + rho * s);
      const u = (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / (rho * rho))) / u1;
      const zoom = raw >= 1 ? to.zoom : startZoom + Math.log2(1 / w);
      const progress = raw >= 1 ? 1 : u;
      this.transform.set({
        zoom,
        bearing,
        pitch,
        center: [from.center[0] + (to.center[0] - from.center[0]) * progress, from.center[1] + (to.center[1] - from.center[1]) * progress],
      });
      return;
    }
    const zoom = from.zoom + (to.zoom - from.zoom) * k;
    if (ease.around !== null && ease.aroundPoint !== null) {
      this.transform.set({ zoom, bearing, pitch });
      this.transform.setLocationAtPoint(ease.aroundPoint, ease.around[0], ease.around[1]);
      return;
    }
    this.transform.set({
      zoom,
      bearing,
      pitch,
      center: [from.center[0] + (to.center[0] - from.center[0]) * k, from.center[1] + (to.center[1] - from.center[1]) * k],
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Input                                                             */
  /* ---------------------------------------------------------------- */

  private local(event: { clientX: number; clientY: number }): [number, number] {
    const rect = this.element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private updateCursor(): void {
    const style = this.element.style;
    if (this.dragMode === "pan") style.cursor = "grabbing";
    else if (this.dragMode === "rotate") style.cursor = "move";
    else if (style.cursor === "grabbing" || style.cursor === "move" || style.cursor === "") style.cursor = "grab";
  }

  /** Lets the scene show a pointer over clickable features. */
  setHoverCursor(pointer: boolean): void {
    if (this.dragMode !== "none") return;
    this.element.style.cursor = pointer ? "pointer" : "grab";
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
    this.callbacks.onInteractionStart?.();
    this.stop();
    const [x, y] = this.local(event);
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      /* A synthetic event may not be capturable; the gesture still works. */
    }
    this.pointers.set(event.pointerId, { id: event.pointerId, type: event.pointerType, startX: x, startY: y, x, y, startTime: performance.now() });
    this.dragged = false;
    if (this.pointers.size === 2 && event.pointerType === "touch") {
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 1) return;
    const rotate = event.pointerType === "mouse" && (event.button === 2 || event.ctrlKey || event.metaKey);
    if (rotate) {
      this.dragMode = "rotate";
      this.rotateStart = { x, y, bearing: this.transform.bearing, pitch: this.transform.pitch };
    } else {
      this.dragMode = "pan";
      this.grabbed = this.transform.screenToMap(x, y);
      this.samples = [{ t: performance.now(), x, y }];
    }
    this.updateCursor();
  };

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (a === undefined || b === undefined) return;
    this.dragMode = "pinch";
    this.dragged = false;
    this.pinch = {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      tilt: false,
      decided: false,
      moved: 0,
      startTime: performance.now(),
      startMidY: (a.y + b.y) / 2,
    };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const [x, y] = this.local(event);
    const tracked = this.pointers.get(event.pointerId);
    if (tracked === undefined) {
      if (event.pointerType === "mouse" && this.dragMode === "none") this.queueHover(x, y);
      return;
    }
    tracked.x = x;
    tracked.y = y;
    if (this.dragMode === "pinch") {
      this.movePinch();
      return;
    }
    if (!this.dragged && Math.hypot(x - tracked.startX, y - tracked.startY) < DRAG_THRESHOLD_PX) return;
    if (!this.dragged) this.callbacks.onHoverEnd?.();
    this.dragged = true;
    if (this.dragMode === "pan" && this.grabbed !== null) {
      this.transform.setLocationAtPoint(this.grabbed, x, y);
      const now = performance.now();
      this.samples.push({ t: now, x, y });
      while (this.samples.length > 2 && now - this.samples[0]!.t > INERTIA_SAMPLE_MS) this.samples.shift();
      this.callbacks.onChange("pan");
      return;
    }
    if (this.dragMode === "rotate") {
      const start = this.rotateStart;
      const bearing = start.bearing + (x - start.x) * ROTATE_RADIANS_PER_PX;
      const pitch = Math.min(MAX_PITCH, Math.max(0, start.pitch - (y - start.y) * PITCH_RADIANS_PER_PX));
      this.transform.set({ pitch });
      this.transform.rotateAround(bearing, this.transform.width / 2, this.transform.height / 2);
      this.callbacks.onChange("rotate");
    }
  };

  private movePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (a === undefined || b === undefined) return;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const previous = this.pinch;
    this.pinch.moved += Math.hypot(midX - previous.midX, midY - previous.midY) + Math.abs(distance - previous.distance);
    if (this.pinch.moved > 6) this.dragged = true;
    if (!previous.decided && this.pinch.moved > 12) {
      /* Two fingers sliding up or down together, without spreading or turning, tilt the map. */
      const da = a.y - a.startY;
      const db = b.y - b.startY;
      const sameDirection = Math.sign(da) === Math.sign(db) && Math.abs(da) > 8 && Math.abs(db) > 8;
      const vertical = Math.abs(midY - previous.startMidY) > Math.abs(midX - (a.startX + b.startX) / 2) * 1.5;
      const spread = Math.abs(Math.log(distance / Math.max(1, Math.hypot(b.startX - a.startX, b.startY - a.startY))));
      this.pinch.tilt = sameDirection && vertical && spread < 0.12;
      this.pinch.decided = true;
    }
    const t = this.transform;
    if (this.pinch.tilt) {
      t.set({ pitch: t.pitch - (midY - previous.midY) * PITCH_RADIANS_PER_PX * 1.6 });
      this.callbacks.onChange("pitch");
    } else {
      const anchor = t.screenToMap(previous.midX, previous.midY);
      const zoom = t.zoom + Math.log2(distance / previous.distance);
      const bearing = t.bearing - wrapAngle(angle - previous.angle);
      t.set({ zoom, bearing });
      t.setLocationAtPoint(anchor, midX, midY);
      this.callbacks.onChange("zoom");
    }
    this.pinch.midX = midX;
    this.pinch.midY = midY;
    this.pinch.distance = distance;
    this.pinch.angle = angle;
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (tracked === undefined) return;
    const [x, y] = this.local(event);
    const mode = this.dragMode;
    this.pointers.delete(event.pointerId);
    try {
      this.element.releasePointerCapture(event.pointerId);
    } catch {
      /* Already released by the browser. */
    }
    if (mode === "pinch") {
      const quick = performance.now() - this.pinch.startTime < TAP_MAX_MS && !this.dragged;
      if (this.pointers.size === 0 || this.pointers.size === 1) {
        if (quick && this.pointers.size === 1) {
          /* Two-finger tap: zoom out around the fingers. */
          void this.zoomBy(-1, [this.pinch.midX, this.pinch.midY]);
        }
        const remaining = [...this.pointers.values()][0];
        if (remaining !== undefined) {
          this.dragMode = "pan";
          remaining.startX = remaining.x;
          remaining.startY = remaining.y;
          this.grabbed = this.transform.screenToMap(remaining.x, remaining.y);
          this.samples = [{ t: performance.now(), x: remaining.x, y: remaining.y }];
          this.dragged = true;
          return;
        }
      }
      this.dragMode = "none";
      this.updateCursor();
      return;
    }
    if (this.pointers.size > 0) return;
    this.dragMode = "none";
    this.updateCursor();
    if (!this.dragged) {
      if (event.pointerType === "mouse" && event.button === 2) return;
      if (event.pointerType === "touch") {
        const now = performance.now();
        if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_PX) {
          this.lastTap.t = 0;
          void this.zoomBy(1, [x, y]);
          return;
        }
        this.lastTap = { t: now, x, y };
      }
      this.callbacks.onClick?.(x, y, event);
      return;
    }
    if (mode === "pan") this.startInertia();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) {
      this.dragMode = "none";
      this.updateCursor();
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.dragMode === "none") this.callbacks.onHoverEnd?.();
  };

  private startInertia(): void {
    if (this.callbacks.reducedMotion?.() === true) return;
    const samples = this.samples;
    const now = performance.now();
    const first = samples.find((sample) => now - sample.t <= INERTIA_SAMPLE_MS);
    const last = samples[samples.length - 1];
    if (first === undefined || last === undefined || last === first) return;
    const dt = last.t - first.t;
    if (dt <= 0 || now - last.t > 50) return;
    let vx = (last.x - first.x) / dt;
    let vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < INERTIA_MIN_SPEED) return;
    if (speed > INERTIA_MAX_SPEED) {
      vx *= INERTIA_MAX_SPEED / speed;
      vy *= INERTIA_MAX_SPEED / speed;
    }
    /* panBy moves the view opposite to its argument, so the content keeps travelling with the throw. */
    this.inertia = { vx: -vx, vy: -vy, last: now };
    this.schedule();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.callbacks.onInteractionStart?.();
    if (this.ease !== null) this.stop();
    this.inertia = null;
    const [x, y] = this.local(event);
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 40;
    else if (event.deltaMode === 2) delta *= 800;
    if (delta === 0) return;
    const absolute = Math.abs(delta);
    const mouseWheel = event.deltaMode !== 0
      || (absolute % 4.000244140625 === 0)
      || (!event.ctrlKey && absolute >= 40 && Number.isInteger(delta) && Math.abs(event.deltaX) < 1);
    const t = this.transform;
    if (mouseWheel && this.callbacks.reducedMotion?.() !== true) {
      const levels = Math.max(-2, Math.min(2, (-delta / WHEEL_NOTCH) * WHEEL_LEVELS_PER_NOTCH));
      const base = this.wheel !== null ? this.wheel.target : t.zoom;
      const target = Math.min(t.constraints.maxZoom, Math.max(t.constraints.minZoom, base + levels));
      this.wheel = { target, x, y, last: performance.now() };
      this.schedule();
      return;
    }
    const rate = event.ctrlKey ? PINCH_ZOOM_RATE : TRACKPAD_ZOOM_RATE;
    const levels = mouseWheel ? (-delta / WHEEL_NOTCH) * WHEEL_LEVELS_PER_NOTCH : -delta * rate;
    this.wheel = null;
    t.zoomAround(t.zoom + Math.max(-2, Math.min(2, levels)), x, y);
    this.callbacks.onChange("zoom");
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    const [x, y] = this.local(event);
    void this.zoomBy(event.shiftKey ? -1 : 1, [x, y], 300);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.dragged) return;
    const [x, y] = this.local(event);
    this.callbacks.onContextMenu?.(x, y, event);
  };

  private queueHover(x: number, y: number): void {
    this.hoverPoint = [x, y];
    if (this.hoverFrame !== null) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = null;
      if (this.hoverPoint !== null) this.callbacks.onHover?.(this.hoverPoint[0], this.hoverPoint[1]);
    });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!acceptsMapKey(event)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const t = this.transform;
    const cx = t.width / 2;
    const cy = t.height / 2;
    /* An arrow looks that way: ArrowLeft reveals what lies to the left, so the content slides right. */
    const pan = (dx: number, dy: number): void => {
      const target = t.clone();
      target.panBy(-dx, -dy);
      void this.easeTo({ center: target.center, duration: 220 });
    };
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
      case "h":
        if (event.shiftKey) void this.easeTo({ bearing: t.bearing - KEY_ROTATE, around: [cx, cy], duration: 240 });
        else pan(-KEY_PAN_PX, 0);
        break;
      case "ArrowRight":
      case "l":
        if (event.shiftKey) void this.easeTo({ bearing: t.bearing + KEY_ROTATE, around: [cx, cy], duration: 240 });
        else pan(KEY_PAN_PX, 0);
        break;
      case "ArrowUp":
      case "k":
        if (event.shiftKey) void this.easeTo({ pitch: Math.min(MAX_PITCH, t.pitch + KEY_PITCH), duration: 240 });
        else pan(0, -KEY_PAN_PX);
        break;
      case "ArrowDown":
      case "j":
        if (event.shiftKey) void this.easeTo({ pitch: Math.max(0, t.pitch - KEY_PITCH), duration: 240 });
        else pan(0, KEY_PAN_PX);
        break;
      case "H":
        void this.easeTo({ bearing: t.bearing - KEY_ROTATE, around: [cx, cy], duration: 240 });
        break;
      case "L":
        void this.easeTo({ bearing: t.bearing + KEY_ROTATE, around: [cx, cy], duration: 240 });
        break;
      case "+":
      case "=":
        void this.zoomBy(1);
        break;
      case "-":
      case "_":
        void this.zoomBy(-1);
        break;
      case "n":
      case "N":
        void this.resetNorth();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      this.callbacks.onInteractionStart?.();
    }
  };
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Typing in a field, or with a menu or dialog focused, must never move the map. */
export function acceptsMapKey(event: KeyboardEvent): boolean {
  const target = event.target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;
  if (target === null || typeof target.tagName !== "string") return true;
  if (TEXT_TAGS.has(target.tagName)) return false;
  if (target.isContentEditable === true) return false;
  if (typeof target.closest === "function" && target.closest("[role='menu'],[role='dialog'],[role='listbox']") !== null) return false;
  return true;
}
