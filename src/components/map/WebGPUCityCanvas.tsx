"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
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
  /** Local [x, z] coordinate to focus the camera on; set to request a move. */
  cameraFocus?: { x: number; z: number } | null;
  /** Incrementing counter — each change triggers a reset to the full-commune view. */
  cameraReset?: number;
  /** Fired once a requested cameraFocus has been dispatched to the camera. */
  onCameraMoved?: () => void;
}

const DEFAULT_BOUNDS: [number, number, number, number] = [0, -3000, 3000, 0];
const CAMERA_HEIGHT = 10000;

function diagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function WebGPUCityCanvas({
  children,
  bounds,
  cameraFocus,
  cameraReset,
  onCameraMoved,
}: WebGPUCityCanvasProps) {
  const [gpuStatus, setGpuStatus] = useState<"checking" | "supported" | "unsupported">("checking");
  const [initError, setInitError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const cameraRigRef = useRef<CameraRigHandle>(null);
  const sceneBounds = bounds ?? DEFAULT_BOUNDS;

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
        const error = "Aucun adaptateur WebGPU n’est disponible.";
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
      if (!cancelled) {
        sceneMetrics.rendererStatus = "loading";
        sceneMetrics.backend = "webgpu";
        sceneMetrics.rendererError = "none";
        publishSceneDiagnostics(true);
        setGpuStatus("supported");
      }
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

  const glFactory = useCallback(async (props: { canvas: HTMLCanvasElement; stencil?: boolean }): Promise<RendererContract> => {
    if (!navigator.gpu) throw new Error("WebGPU non pris en charge");
    try {
      const renderer = new WebGPURenderer({
        canvas: props.canvas,
        antialias: true,
        alpha: false,
        depth: true,
        stencil: props.stencil ?? true,
      });
      renderer.onDeviceLost = handleDeviceLost;
      await renderer.init();
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

  /* Dispatch a requested focus to the mounted camera rig. Runs once per
     cameraFocus change; onCameraMoved lets the caller clear the request
     immediately since the move itself is animated inside MapCamera. */
  useEffect(() => {
    if (!cameraFocus) return;
    cameraRigRef.current?.focusOn([cameraFocus.x, cameraFocus.z]);
    onCameraMoved?.();
  }, [cameraFocus, onCameraMoved]);

  /* Reset is a fire-once counter: skip the initial mount value so the
     camera doesn't "reset" before it has ever moved. */
  const previousResetRef = useRef(cameraReset);
  useEffect(() => {
    if (cameraReset === undefined || cameraReset === previousResetRef.current) return;
    previousResetRef.current = cameraReset;
    cameraRigRef.current?.resetView();
  }, [cameraReset]);

  if (gpuStatus === "checking") return <LoadingState />;
  if (gpuStatus === "unsupported") return <WebGPUUnsupported error={initError} />;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <Canvas
        orthographic
        gl={glFactory as Parameters<typeof Canvas>[0]["gl"]}
        dpr={[1, 2]}
        frameloop="always"
        style={{ display: "block", width: "100%", height: "100%" }}
      >
        <CameraRig ref={cameraRigRef} communeBounds={sceneBounds} cameraHeight={CAMERA_HEIGHT} />
        {children}
      </Canvas>
    </div>
  );
}
