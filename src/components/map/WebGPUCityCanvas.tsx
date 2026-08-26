"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { WebGPURenderer } from "three/webgpu";
import WebGPUUnsupported from "./WebGPUUnsupported";
import LoadingState from "./LoadingState";
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
}

const DEFAULT_BOUNDS: [number, number, number, number] = [0, -3000, 3000, 0];
const CAMERA_HEIGHT = 10000;
const CAMERA_FAR = 50000;

function diagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function WebGPUCityCanvas({ children, bounds }: WebGPUCityCanvasProps) {
  const [gpuStatus, setGpuStatus] = useState<"checking" | "supported" | "unsupported">("checking");
  const [initError, setInitError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const sceneBounds = bounds ?? DEFAULT_BOUNDS;
  const centerX = (sceneBounds[0] + sceneBounds[2]) / 2;
  const centerZ = (sceneBounds[1] + sceneBounds[3]) / 2;
  const width = Math.max(1, sceneBounds[2] - sceneBounds[0]);
  const height = Math.max(1, sceneBounds[3] - sceneBounds[1]);

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

  if (gpuStatus === "checking") return <LoadingState />;
  if (gpuStatus === "unsupported") return <WebGPUUnsupported error={initError} />;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
      <Canvas
        orthographic
        camera={{
          position: [centerX, CAMERA_HEIGHT, centerZ],
          rotation: [-Math.PI / 2, 0, 0],
          up: [0, 0, -1],
          near: 1,
          far: CAMERA_FAR,
          left: -Math.max(width / 2, 1),
          right: Math.max(width / 2, 1),
          top: Math.max(height / 2, 1),
          bottom: -Math.max(height / 2, 1),
          zoom: 0.9,
        }}
        gl={glFactory as Parameters<typeof Canvas>[0]["gl"]}
        dpr={[1, 2]}
        frameloop="always"
        style={{ display: "block", width: "100%", height: "100%" }}
      >
        {children}
      </Canvas>
    </div>
  );
}
