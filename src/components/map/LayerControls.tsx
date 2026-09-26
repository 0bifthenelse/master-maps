'use client';

import { useId, useState, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface LayerState {
  buildings: boolean;
  roads: boolean;
  water: boolean;
  landuse: boolean;
  pois: boolean;
  places: boolean;
  transport: boolean;
  structures: boolean;
  boundary: boolean;
  labels: boolean;
  [key: string]: boolean;
}

export const DEFAULT_LAYERS: LayerState = {
  buildings: true,
  roads: true,
  water: true,
  landuse: true,
  pois: true,
  places: true,
  transport: true,
  structures: true,
  boundary: true,
  labels: true,
};

export type LayerId = keyof LayerState;

export interface LayerControlsProps {
  /** Current layer visibility state */
  layers: LayerState;
  /** Called when a single layer is toggled */
  onToggle: (layer: LayerId, visible: boolean) => void;
  /** Called to reset the camera to the department view. */
  onReset?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Layer definitions with French labels                               */
/* ------------------------------------------------------------------ */

interface LayerDef {
  id: LayerId;
  label: string;
}

const LAYERS: readonly LayerDef[] = [
  { id: 'labels', label: 'Étiquettes' },
  { id: 'places', label: 'Lieux' },
  { id: 'pois', label: "Points d'intérêt" },
  { id: 'transport', label: 'Transports' },
  { id: 'structures', label: 'Structures' },
  { id: 'buildings', label: 'Bâtiments' },
  { id: 'roads', label: 'Routes' },
  { id: 'water', label: 'Eau' },
  { id: 'landuse', label: 'Occupation du sol' },
  { id: 'boundary', label: 'Limite du département' },
];

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function CollapsiblePanel({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className="layer-controls-panel">
      <button
        type="button"
        className="panel-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <svg
          className={`panel-chevron${open ? ' open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>{label}</span>
      </button>
      <div id={panelId} hidden={!open}>
        {open && <div className="panel-body">{children}</div>}
      </div>

      <style jsx>{`
        .layer-controls-panel {
          background: var(--color-paper);
          border: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
          border-radius: 6px;
          overflow: hidden;
          min-width: 208px;
        }

        .panel-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 8px 12px;
          border: none;
          background: transparent;
          color: var(--color-ink);
          font: inherit;
          font-size: 0.8125rem;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
          user-select: none;
        }

        .panel-toggle:hover {
          background: color-mix(in srgb, var(--color-ink) 4%, transparent);
        }

        .panel-toggle:focus-visible,
        .layer-toggle input:focus-visible,
        .reset-button:focus-visible {
          outline: var(--focus-ring-width) solid var(--color-focus-ring);
          outline-offset: var(--focus-ring-offset);
        }

        .panel-chevron {
          transition: transform 0.15s;
          flex-shrink: 0;
        }

        .panel-chevron.open {
          transform: rotate(90deg);
        }

        .panel-body {
          padding: 4px 12px 8px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .layer-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .layer-toggle {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          cursor: pointer;
          user-select: none;
          font-size: 0.8125rem;
          color: var(--color-ink);
        }

        .layer-toggle:hover {
          opacity: 0.85;
        }

        .layer-toggle input[type='checkbox'] {
          accent-color: var(--color-accent);
          width: 14px;
          height: 14px;
        }

        .layer-label {
          line-height: 1.3;
        }

        .reset-button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          margin-top: 6px;
          padding: 6px 10px;
          border: 1px solid color-mix(in srgb, var(--color-ink) 15%, transparent);
          border-radius: 4px;
          background: transparent;
          color: var(--color-ink);
          font: inherit;
          font-size: 0.75rem;
          cursor: pointer;
          transition: background-color 0.1s;
        }

        .reset-button:hover {
          background: color-mix(in srgb, var(--color-ink) 6%, transparent);
        }

        @media (prefers-reduced-motion: reduce) {
          .panel-chevron {
            transition: none;
          }

          .reset-button {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function LayerControls({ layers, onToggle, onReset }: LayerControlsProps) {
  return (
    <CollapsiblePanel label="Couches" defaultOpen={false}>
      <div className="layer-list" role="group" aria-label="Couches de la carte">
        {LAYERS.map((def) => (
          <label key={def.id} className="layer-toggle">
            <input
              type="checkbox"
              checked={layers[def.id] !== false}
              onChange={(e) => onToggle(def.id, e.target.checked)}
            />
            <span className="layer-label">{def.label}</span>
          </label>
        ))}
      </div>

      {onReset && (
        <button
          type="button"
          className="reset-button"
          onClick={onReset}
          title="Recentrer la carte sur le département"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          <span>Recentrer la carte</span>
        </button>
      )}
    </CollapsiblePanel>
  );
}

export default LayerControls;
