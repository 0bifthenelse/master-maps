'use client'

import type { ReactNode } from 'react'

interface WebGPUUnsupportedProps {
  /** Optional error detail message */
  error?: string | null
  /** Whether this was triggered by device loss after initial success */
  deviceLost?: boolean
  /** Optional custom fallback replaces the default panel entirely */
  children?: ReactNode
}

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  padding: '2rem',
  textAlign: 'center',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
}

const iconStyle: React.CSSProperties = {
  fontSize: '2.5rem',
  lineHeight: 1,
}

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.25rem',
  fontWeight: 600,
  lineHeight: 1.3,
  color: 'var(--color-ink, #000000)',
}

const messageStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  lineHeight: 1.5,
  maxWidth: '28rem',
  color: 'var(--color-ink, #000000)',
  opacity: 0.75,
}

export default function WebGPUUnsupported({
  error,
  deviceLost = false,
  children,
}: WebGPUUnsupportedProps) {
  // Allow complete override via children slot
  if (children) {
    return <>{children}</>
  }

  const title = deviceLost
    ? 'Connexion GPU perdue'
    : 'WebGPU non disponible'
  const message = deviceLost
    ? "L'accélérateur graphique s'est déconnecté. Rechargez la carte pour tenter une reconnexion."
    : 'Cette carte nécessite WebGPU, une API graphique moderne. Utilisez un navigateur récent compatible (Chrome 113+, Edge 113+, Firefox Nightly) avec un GPU supporté.'

  return (
    <div
      role="alert"
      aria-live="polite"
      style={panelStyle}
      data-testid="webgpu-unsupported"
    >
      <div style={iconStyle} aria-hidden="true">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent, #ff7d27)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>

      <h2 style={headingStyle}>{title}</h2>

      <p style={messageStyle}>
        {message}
        {error && (
          <>
            <br />
            <code style={{ fontSize: '0.8rem', opacity: 0.6 }}>
              {error}
            </code>
          </>
        )}
      </p>
    </div>
  )
}