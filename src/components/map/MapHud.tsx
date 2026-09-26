'use client';

/**
 * @file HUD de la carte: recherche, reinitialisation, indications clavier.
 *
 * The search field swallows keydown so a global map shortcut can never
 * fire while the user types: the panel stops propagation before the
 * window-level handlers in MapControls see the event. That is a second
 * line of defence behind MapControls.shouldHandle, which already skips
 * text tags, and it is what makes the hints below true.
 */
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';

const ACCENT = 'var(--color-accent, #ff7d27)';
const INK = 'var(--color-ink, #000000)';
const PAPER = 'var(--color-paper, #ffffff)';

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
  borderRadius: '2px',
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
  border: `1px solid color-mix(in srgb, ${INK} 20%, transparent)`,
  cursor: 'pointer',
  color: INK,
  fontWeight: 600,
  fontSize: '12px',
  padding: '5px 9px',
  borderRadius: '2px',
  whiteSpace: 'nowrap',
};

const hintBar: CSSProperties = {
  pointerEvents: 'none',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 10px',
  justifyContent: 'center',
  padding: '3px 12px',
  fontSize: '10.5px',
  color: `color-mix(in srgb, ${INK} 52%, transparent)`,
  background: `color-mix(in srgb, ${PAPER} 80%, transparent)`,
  borderBottom: `1px solid color-mix(in srgb, ${INK} 7%, transparent)`,
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

const keyStyle: CSSProperties = {
  padding: '0 4px',
  border: `1px solid color-mix(in srgb, ${INK} 22%, transparent)`,
  borderRadius: '2px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '9.5px',
  color: INK,
};

/** Shortcuts the map actually implements, in the order a user meets them. */
export const MAP_SHORTCUT_HINTS: readonly { keys: string; label: string }[] = [
  { keys: 'H J K L', label: 'déplacer' },
  { keys: '← ↑ → ↓', label: 'déplacer' },
  { keys: '+ −', label: 'zoom' },
  { keys: 'clic droit', label: 'menu de l\'élément' },
  { keys: 'Échap', label: 'fermer' },
];

export interface MapHudProps {
  query?: string;
  onQueryChange?: (q: string) => void;
  onSearch?: (q: string) => void;
  /** Resets the camera to the full territory view. */
  onResetView?: () => void;
  results?: ReactNode;
  extra?: ReactNode;
  attributions?: string[];
  showShortcuts?: boolean;
}

export function MapHud({
  query = '',
  onQueryChange,
  onSearch,
  onResetView,
  results,
  extra,
  attributions,
  showShortcuts = true,
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

  const swallowMapKeys = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
  }, []);

  return (
    <div style={overlay} role="region" aria-label="Carte">
      <div>
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
                onKeyDown={swallowMapKeys}
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
                data-testid="reset-view"
                aria-label="Réinitialiser la vue sur l'ensemble du département"
                title="Vue d'ensemble du département"
              >
                Vue d'ensemble
              </button>
            )}

            {extra}
          </div>
        </div>

        {showShortcuts ? (
          <div style={hintBar} data-testid="map-shortcuts">
            {MAP_SHORTCUT_HINTS.map((hint) => (
              <span key={`${hint.keys}-${hint.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <kbd style={keyStyle}>{hint.keys}</kbd>
                {hint.label}
              </span>
            ))}
          </div>
        ) : null}

        {results ? (
          <div
            style={{
              pointerEvents: 'auto',
              position: 'absolute',
              top: '82px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '100%',
              maxWidth: '480px',
              background: PAPER,
              border: `1px solid color-mix(in srgb, ${INK} 12%, transparent)`,
              borderRadius: '0 0 2px 2px',
              boxShadow: '0 4px 12px color-mix(in srgb, var(--color-ink, #000) 12%, transparent)',
              overflow: 'hidden',
              zIndex: 10,
            }}
          >
            {results}
          </div>
        ) : null}
      </div>

      {attributions && attributions.length > 0 ? (
        <div style={attributionStrip}>
          <span>Sources: </span>
          {attributions.map((a, i) => (
            <span key={i} dangerouslySetInnerHTML={{ __html: a }} />
          ))}
        </div>
      ) : (
        <div style={attributionStrip}>
          <span>
            <a
              href="https://www.openstreetmap.org/copyright"
              style={linkStyle}
              target="_blank"
              rel="noopener noreferrer"
            >
              &copy; Contributeurs OpenStreetMap
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
