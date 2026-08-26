'use client'

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1.25rem',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
}

const spinnerStyle: React.CSSProperties = {
  width: '2rem',
  height: '2rem',
  border: '3px solid var(--color-ink, #000000)',
  borderTopColor: 'var(--color-accent, #ff7d27)',
  borderRadius: '50%',
  animation: 'map-loading-spin 0.8s linear infinite',
}

const labelStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 500,
  lineHeight: 1.4,
  color: 'var(--color-ink, #000000)',
  opacity: 0.7,
}

export default function LoadingState() {
  return (
    <div
      role="status"
      aria-label="Chargement d'Auch"
      style={containerStyle}
      data-testid="map-loading"
    >
      <style>{`
        @keyframes map-loading-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={spinnerStyle} aria-hidden="true" />
      <p style={labelStyle}>Chargement d&rsquo;Auch&hellip;</p>
    </div>
  )
}