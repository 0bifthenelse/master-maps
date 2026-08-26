'use client'

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import { Canvas } from '@react-three/fiber'
import { WebGPURenderer } from 'three/webgpu'
import WebGPUUnsupported from './WebGPUUnsupported'
import LoadingState from './LoadingState'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebGPUCityCanvasProps {
  children: ReactNode
}

/** Augment Navigator so strict DOM libs accept the WebGPU property. */
declare global {
  interface Navigator {
    gpu?: { readonly [key: string]: unknown }
  }
}

/** Runtime tracker for WebGPU support in this browser session. */
type GpuStatus = 'checking' | 'supported' | 'unsupported'

/** Minimal shape r3f requires from a renderer: it must expose `render`. */
interface GlRendererContract {
  render: (...args: unknown[]) => unknown
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

function setDiagnostic(key: string, value: string | number | null): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById('scene-diagnostics')
  if (!el) return
  const attr = `data-${key}`
  if (value === null || value === '') {
    el.removeAttribute(attr)
  } else {
    el.setAttribute(attr, String(value))
  }
}

function showDiagnostics(): boolean {
  return (
    process.env.NEXT_PUBLIC_MAP_DIAGNOSTICS === '1' ||
    process.env.NODE_ENV !== 'production'
  )
}

// ---------------------------------------------------------------------------
// Default orthographic frustum (world units, centred on commune)
// Auch spans roughly 10 km east-west × 5 km north-south; add padding.
// ---------------------------------------------------------------------------

const FRUSTUM_SIZE = 6000 // half-extent in metres
const CAMERA_HEIGHT = 10000
const CAMERA_FAR = 50000

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WebGPUCityCanvas({ children }: WebGPUCityCanvasProps) {
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('checking')
  const [deviceLost, setDeviceLost] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const initAttempted = useRef(false)

  // ---------- Cleanup flag ----------

  useEffect(() => {
    return () => {
      mountedRef.current = false

      if (showDiagnostics()) {
        setDiagnostic('renderer-status', null)
        setDiagnostic('backend', null)
        setDiagnostic('renderer-error', null)
      }
    }
  }, [])

  // ---------- WebGPU availability check ----------

  useEffect(() => {
    const available =
      typeof navigator !== 'undefined' &&
      typeof navigator.gpu !== 'undefined'

    if (!mountedRef.current) return

    if (!available) {
      setGpuStatus('unsupported')
      setInitError(
        'navigator.gpu est indéfini. WebGPU nécessite un navigateur compatible (Chrome 113+, Edge 113+).',
      )
    } else {
      setGpuStatus('supported')
    }
  }, [])

  // ---------- Device lost handler ----------

  const handleDeviceLost = useCallback(
    (info: { message: string; reason: string | null; api?: string }) => {
      if (!mountedRef.current) return
      setDeviceLost(true)
      setInitError(
        info.reason
          ? `Device lost: ${info.message} (${info.reason})`
          : `Device lost: ${info.message}`,
      )
      setDiagnostic('renderer-status', 'lost')
      setDiagnostic('renderer-error', info.message)
    },
    [],
  )

  // ---------- Async WebGPU renderer factory ----------

  const glFactory = useCallback(
    async (defaultProps: {
      canvas: HTMLCanvasElement
      stencil?: boolean
    }): Promise<GlRendererContract> => {
      if (
        typeof navigator === 'undefined' ||
        typeof navigator.gpu === 'undefined'
      ) {
        throw new Error('WebGPU non pris en charge')
      }

      initAttempted.current = true

      let renderer: WebGPURenderer
      try {
        renderer = new WebGPURenderer({
          canvas: defaultProps.canvas,
          antialias: true,
          alpha: false,
          depth: true,
          stencil: defaultProps.stencil ?? true,
        } as ConstructorParameters<typeof WebGPURenderer>[0])
      } catch (constructErr) {
        const msg =
          constructErr instanceof Error
            ? constructErr.message
            : 'Échec de la construction du renderer WebGPU'
        if (mountedRef.current) {
          setInitError(msg)
          setGpuStatus('unsupported')
        }
        throw constructErr
      }

      // ---------- Wire up device lost ----------

      renderer.onDeviceLost = handleDeviceLost

      // ---------- Initialise ----------

      try {
        await renderer.init()
      } catch (initErr) {
        const msg =
          initErr instanceof Error
            ? initErr.message
            : "Échec de l'initialisation du renderer WebGPU"
        if (mountedRef.current) {
          setInitError(msg)
          setGpuStatus('unsupported')
        }
        throw initErr
      }

      // Update diagnostics once initialised
      if (showDiagnostics()) {
        setDiagnostic('renderer-status', 'initialized')
        setDiagnostic('backend', 'webgpu')
      }

      return renderer as unknown as GlRendererContract
    },
    [handleDeviceLost],
  )

  // ---------- Render branches ----------

  if (gpuStatus === 'checking') {
    return <LoadingState />
  }

  if (gpuStatus === 'unsupported' || deviceLost) {
    return (
      <WebGPUUnsupported
        deviceLost={deviceLost && gpuStatus === 'supported'}
        error={initError}
      />
    )
  }

  // ---------- Canvas with async WebGPU renderer ----------

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Canvas
        orthographic
        camera={{
          position: [0, CAMERA_HEIGHT, 0],
          up: [0, 0, 1],
          near: 0.1,
          far: CAMERA_FAR,
          left: -FRUSTUM_SIZE,
          right: FRUSTUM_SIZE,
          top: FRUSTUM_SIZE,
          bottom: -FRUSTUM_SIZE,
          zoom: 1,
        }}
        // The async factory matches r3f's GLProps contract structurally.
        // The concrete return type differs from THREE.WebGLRenderer but
        // satisfies the { render } interface r3f actually consumes.
        gl={glFactory as unknown as Parameters<typeof Canvas>[0]['gl']}
        dpr={[1, 2]}
        frameloop="always"
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
        }}
        onCreated={() => {
          if (showDiagnostics()) {
            setDiagnostic('renderer-status', 'initialized')
            setDiagnostic('backend', 'webgpu')
          }
        }}
      >
        {children}
      </Canvas>

      {/* Diagnostics element — machine-readable test hook */}
      {showDiagnostics() && (
        <div
          id="scene-diagnostics"
          aria-hidden="true"
          data-renderer-status={
            initAttempted.current ? 'initializing' : 'pending'
          }
          data-backend="webgpu"
          data-loaded-tile-count="0"
          data-loaded-feature-count="0"
          data-building-count="0"
          data-road-count="0"
          data-poi-count="0"
          data-draw-calls="0"
          data-camera-state="unknown"
          data-renderer-error=""
        />
      )}
    </div>
  )
}