'use client';

import { type CSSProperties, type FormEvent, type ReactNode, useCallback, useRef, useState } from 'react';

const ACCENT = '#ff7d27';
const INK = '#000000';
const PAPER = '#ffffff';

const overlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: '14px',
  color: INK,
};

const topBar: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 12px',
  background: `color-mix(in srgb, ${PAPER} 92%, transparent)`,
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  borderBottom: `1px solid color-mix(in srgb, ${INK} 10%, transparent)`,
  justifyContent: 'center',
};

const searchContainer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  width: '100%',
  maxWidth: '480px',
};

const searchInput: CSSProperties = {
  flex: 1,
  border: `1px solid color-mix(in srgb, ${INK} 20%, ${PAPER})`,
  borderRadius: '4px',
  padding: '6px 10px',
  fontSize: '14px',
  background: PAPER,
  color: INK,
  outline: 'none',
  boxSizing: 'border-box' as const,
};

const searchInputFocus: CSSProperties = {
  borderColor: ACCENT,
  boxShadow: `0 0 0 2px color-mix(in srgb, ${ACCENT} 25%, transparent)`,
};

const resetBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: ACCENT,
  fontWeight: 600,
  fontSize: '12px',
  padding: '4px 8px',
  borderRadius: '3px',
  whiteSpace: 'nowrap',
};

const attributionStrip: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 12px',
  padding: '4px 12px',
  fontSize: '11px',
  color: `color-mix(in srgb, ${INK} 55%, transparent)`,
  background: `color-mix(in srgb, ${PAPER} 88%, transparent)`,
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  borderTop: `1px solid color-mix(in srgb, ${INK} 8%, transparent)`,
};

const linkStyle: CSSProperties = {
  color: 'inherit',
  textDecoration: 'underline',
  textDecorationColor: `color-mix(in srgb, ${INK} 30%, transparent)`,
  textUnderlineOffset: '2px',
};

export interface MapHudProps {
  query?: string;
  onQueryChange?: (q: string) => void;
  onSearch?: (q: string) => void;
  onResetView?: () => void;
  results?: ReactNode;
  extra?: ReactNode;
  attributions?: string[];
}

export function MapHud({
  query = '',
  onQueryChange,
  onSearch,
  onResetView,
  results,
  extra,
  attributions,
}: MapHudProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      onSearch?.(query);
    },
    [onSearch, query],
  );

  const handleReset = useCallback(() => {
    onResetView?.();
  }, [onResetView]);

  return (
    <div style={overlay} role="region" aria-label="Carte">
      <div style={topBar}>
        <div style={searchContainer}>
          <form
            onSubmit={handleSubmit}
            style={{ display: 'contents' }}
            role="search"
            aria-label="Rechercher dans le Gers"
          >
            <input
              ref={inputRef}
              type="search"
              data-testid="search-input"
              placeholder="Rechercher dans le Gers..."
              aria-label="Rechercher dans le Gers"
              value={query}
              onChange={(e) => onQueryChange?.(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                ...searchInput,
                ...(focused ? searchInputFocus : {}),
              }}
            />
          </form>

          {onResetView && (
            <button
              type="button"
              style={resetBtn}
              onClick={handleReset}
              aria-label="Réinitialiser la vue"
            >
              Réinitialiser
            </button>
          )}

          {extra}
        </div>
      </div>

      {results && (
        <div
          style={{
            pointerEvents: 'auto',
            position: 'absolute',
            top: '48px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '100%',
            maxWidth: '480px',
            background: PAPER,
            border: `1px solid color-mix(in srgb, ${INK} 12%, transparent)`,
            borderRadius: '0 0 6px 6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.10)',
            overflow: 'hidden',
            zIndex: 10,
          }}
        >
          {results}
        </div>
      )}

      {attributions && attributions.length > 0 && (
        <div style={attributionStrip}>
          <span>Sources: </span>
          {attributions.map((a, i) => (
            <span key={i} dangerouslySetInnerHTML={{ __html: a }} />
          ))}
        </div>
      )}

      {(!attributions || attributions.length === 0) && (
        <div style={attributionStrip}>
          <span>
            <a
              href="https://www.openstreetmap.org/copyright"
              style={linkStyle}
              target="_blank"
              rel="noopener noreferrer"
            >
              © Contributeurs OpenStreetMap
            </a>
          </span>
          <span>
            <a
              href="https://cartes.gouv.fr/"
              style={linkStyle}
              target="_blank"
              rel="noopener noreferrer"
            >
              IGN Géoplateforme
            </a>
          </span>
          <span>
            <a
              href="https://adresse.data.gouv.fr/"
              style={linkStyle}
              target="_blank"
              rel="noopener noreferrer"
            >
              Base Adresse Nationale
            </a>
          </span>
        </div>
      )}
    </div>
  );
}

MapHud.displayName = 'MapHud';
export default MapHud;
