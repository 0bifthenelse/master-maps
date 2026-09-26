"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas, useStore } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";
import WebGPUUnsupported from "./WebGPUUnsupported";
import LoadingState from "./LoadingState";
import { CameraRig, type CameraRigHandle } from "./CameraRig";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";

declare global {
  interface Navigator {
    gpu?: { requestAdapter?: () => Promise<unknown> };
  }
}

interface RendererContract {
  render: (...args: unknown[]) => unknown;
}

export interface WebGPUCityCanvasProps {
  children: ReactNode;
  bounds?: [number, number, number, number];
  cameraFocus?: { x: number; z: number; zoom?: number } | null;
  cameraReset?: number;
  onCameraMoved?: () => void;
  onViewportChange?: (snapshot: {
    target: [number, number];
    zoom: number;
    width: number;
    height: number;
    headingRadians: number;
  }) => void;
}

const DEFAULT_BOUNDS: [number, number, number, number] = [0, -3000, 3000, 0];
const CAMERA_HEIGHT = 10000;

function diagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keyboard camera shortcuts must not fire while reduced motion is asked for
 * by the user: the map jumps instead of gliding. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function WebGPUCityCanvas({
  children,
  bounds,
  cameraFocus,
  cameraReset,
  onCameraMoved,
  onViewportChange,
}: WebGPUCityCanvasProps) {
  const [gpuStatus, setGpuStatus] = useState<"checking" | "supported" | "unsupported">("checking");
  const [initError, setInitError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const cameraRigRef = useRef<CameraRigHandle>(null);
  const sceneBounds = bounds ?? DEFAULT_BOUNDS;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const gpuStatusRef = useRef<"checking" | "supported" | "unsupported">("checking");
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkAdapter = async (): Promise<void> => {
      if (!navigator.gpu?.requestAdapter) {
        const error = "navigator.gpu est indisponible dans ce navigateur.";
        if (!cancelled) {
          setInitError(error);
          sceneMetrics.rendererStatus = "unsupported";
          sceneMetrics.backend = "unknown";
          sceneMetrics.rendererError = error;
          publishSceneDiagnostics(true);
          setGpuStatus("unsupported");
        }
        return;
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        const error = "Aucun adaptateur WebGPU n'est disponible.";
        if (!cancelled) {
          setInitError(error);
          sceneMetrics.rendererStatus = "unsupported";
          sceneMetrics.backend = "webgpu";
          sceneMetrics.rendererError = error;
          publishSceneDiagnostics(true);
          setGpuStatus("unsupported");
        }
        return;
      }
      if (cancelled) return;
      /* The adapter probe and the renderer factory race: whichever finishes
         last used to overwrite the other's status, so a late probe could
         leave renderer-status stuck at "loading". The probe only promotes
         the component to "supported" while it is still checking, and the
         factory remains the single authority that writes "initialized". */
      if (gpuStatusRef.current !== "checking") return;
      sceneMetrics.rendererStatus = "loading";
      sceneMetrics.backend = "webgpu";
      sceneMetrics.rendererError = "none";
      publishSceneDiagnostics(true);
      setGpuStatus("supported");
    };
    void checkAdapter().catch((error: unknown) => {
      if (!cancelled) {
        const message = diagnosticError(error);
        setInitError(message);
        sceneMetrics.rendererStatus = "errored";
        sceneMetrics.backend = "webgpu";
        sceneMetrics.rendererError = message;
        publishSceneDiagnostics(true);
        setGpuStatus("unsupported");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeviceLost = useCallback((info: { message: string; reason: string | null }) => {
    if (!mountedRef.current) return;
    const error = info.reason ? `${info.message} (${info.reason})` : info.message;
    sceneMetrics.rendererStatus = "lost";
    sceneMetrics.rendererError = error;
    publishSceneDiagnostics(true);
    setInitError(error);
    setGpuStatus("unsupported");
  }, []);

  const glFactory = useCallback(async (props: { canvas: HTMLCanvasElement; stencil?: boolean; width?: number; height?: number }): Promise<RendererContract> => {
    if (!navigator.gpu) throw new Error("WebGPU non pris en charge");
    try {
      const renderer = new WebGPURenderer({
        canvas: props.canvas,
        antialias: true,
        alpha: false,
        depth: true,
        stencil: props.stencil ?? true,
        forceWebGL: false,
      });
      renderer.onDeviceLost = handleDeviceLost;
      /* The canvas is laid out after mount, so its client rect can still be
         the 300x150 default when R3F first configures the context. Sizing the
         renderer to the measured drawing buffer up front is what prevents the
         depth-stencil attachment from being created at a different size than
         the render targets, which otherwise invalidates every render pass and
         leaves the frame black. */
      const rect = props.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || props.canvas.clientWidth || props.canvas.width));
      const height = Math.max(1, Math.floor(rect.height || props.canvas.clientHeight || props.canvas.height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      await renderer.init();
      renderer.setSize(width, height, false);
      if (mountedRef.current) {
        sceneMetrics.rendererStatus = "initialized";
        sceneMetrics.backend = "webgpu";
        sceneMetrics.rendererError = "none";
        publishSceneDiagnostics(true);
      }
      return renderer as unknown as RendererContract;
    } catch (error: unknown) {
      const message = diagnosticError(error);
      if (mountedRef.current) {
        sceneMetrics.rendererStatus = "errored";
        sceneMetrics.backend = "webgpu";
        sceneMetrics.rendererError = message;
        publishSceneDiagnostics(true);
        setInitError(message);
        setGpuStatus("unsupported");
      }
      throw error;
    }
  }, [handleDeviceLost]);

  /* Keep the render targets in step with the canvas box. R3F resizes on its
     own, but a container that has not been measured yet (first paint, panel
     collapse) leaves the depth buffer at its old size. */
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(() => {
      const canvas = container.querySelector("canvas");
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      publishSceneDiagnostics(true);
    });
    observer.observe(container);
    resizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
    };
  }, [gpuStatus]);

  /* Dispatch a requested focus to the mounted camera rig. Runs once per
     cameraFocus change; onCameraMoved lets the caller clear the request
     immediately since the move itself is animated inside MapCamera. */
  useEffect(() => {
    if (!cameraFocus) return;
    cameraRigRef.current?.focusOn([cameraFocus.x, cameraFocus.z], undefined, cameraFocus.zoom);
    onCameraMoved?.();
  }, [cameraFocus, onCameraMoved]);

  /* Reset is a fire-once counter: skip the initial mount value so the
     camera doesn't "reset" before it has ever moved. */
  const previousResetRef = useRef(cameraReset);
  useEffect(() => { gpuStatusRef.current = gpuStatus; }, [gpuStatus]);

  useEffect(() => {
    if (cameraReset === undefined || cameraReset === previousResetRef.current) return;
    previousResetRef.current = cameraReset;
    cameraRigRef.current?.resetView();
  }, [cameraReset]);

  if (gpuStatus === "checking") return <LoadingState />;
  if (gpuStatus === "unsupported") return <WebGPUUnsupported error={initError} />;

  return (
    <div ref={containerRef} className="map-canvas" style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <Canvas
        orthographic
        gl={glFactory as Parameters<typeof Canvas>[0]["gl"]}
        dpr={[1, 2]}
        frameloop="demand"
        style={{ display: "block", width: "100%", height: "100%" }}
      >
        <FrameDemandBridge />
        <CameraRig
          ref={cameraRigRef}
          territoryBounds={sceneBounds}
          cameraHeight={CAMERA_HEIGHT}
          reducedMotion={reducedMotion}
          onViewportChange={onViewportChange}
        />
        {children}
      </Canvas>
    </div>
  );
}

/**
 * Demand rendering contract. The Canvas runs frameloop="demand": R3F renders
 * on pointer events, store updates, tile uploads and explicit invalidate()
 * calls, then stops scheduling rAF entirely. This component owns the last
 * trigger, a two frame heartbeat per page view so a WebGPU device loss or a
 * visibility change still repaints.
 */
const HEARTBEAT_MS = 1000;
const MAX_HEARTBEAT_FRAMES = 2;

function FrameDemandBridge() {
  const store = useStore();
  useEffect(() => {
    let pending: number | null = null;
    let frames = 0;
    const tick = (): void => {
      frames = Math.min(MAX_HEARTBEAT_FRAMES, frames + 1);
      store.getState().invalidate();
      pending = frames < MAX_HEARTBEAT_FRAMES ? window.setTimeout(tick, HEARTBEAT_MS) : null;
    };
    const onWake = (): void => {
      if (pending !== null) window.clearTimeout(pending);
      pending = null;
      if (document.visibilityState === "visible") {
        frames = 0;
        tick();
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [store]);
  return null;
}
