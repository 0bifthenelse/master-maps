'use client';

/**
 * @file Inspecteur de l'element selectionne.
 *
 * The panel is fed by the pick payload the scene resolved from the
 * render-tile meta (stableId, kind, category, name, layer, tile, anchor)
 * and enriches it with the geometry-less feature record served by
 * /api/map/tile/<tileId>. Every value shown comes from one of those two
 * sources: there is no placeholder row and no section that is rendered
 * without a real value behind it.
 *
 * The dead Nocibé audit section and the dead "Détails" toggle are gone:
 * the audit overlay has no scene branch to drive, and the panel itself is
 * the detail surface the context menu opens.
 */
import { useRef, type ReactNode } from 'react';
import type { PickedFeature } from '@/lib/scene/highlight';
import { kindLabel, attributeLabel } from '@/components/map/FeatureContextMenu';

export interface InspectorField {
  label: string;
  value: string;
}

export interface FeatureDetailRecord {
  kind: string;
  name?: string;
  address?: string;
  category?: string;
  status?: string;
  confidence?: string;
  lon?: number;
  lat?: number;
  attributes?: readonly InspectorField[];
  sources?: readonly { source: string; timestamp?: string; license?: string; url?: string }[];
}

export interface FeatureInspectorProps {
  pick: PickedFeature | null;
  /** Geometry-less record fetched from /api/map/tile/<tileId>. */
  detail?: FeatureDetailRecord | null;
  detailLoading?: boolean;
  detailError?: string | null;
  onClose: () => void;
  onCenter?: (pick: PickedFeature) => void;
  onToggleDetail?: (visible: boolean) => void;
  detailOpen?: boolean;
  className?: string;
}

const STATUS_TONE: Readonly<Record<string, string>> = {
  active: 'confirmé',
  uncertain: 'incertain',
  inferred: 'déduit',
  unresolved: 'non résolu',
};

const INK = 'var(--color-ink, #000000)';
const PAPER = 'var(--color-paper, #ffffff)';
const ACCENT = 'var(--color-accent, #ff7d27)';

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3 className="inspector-section-header">{label}</h3>
      <div className="inspector-section-body">{children}</div>
    </section>
  );
}

function DefinitionList({ fields }: { fields: readonly InspectorField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="inspector-fields">
      {fields.map((field) => (
        <div key={field.label} className="inspector-field">
          <dt className="inspector-field-label">{field.label}</dt>
          <dd className="inspector-field-value">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FeatureInspector({
  pick,
  detail,
  detailLoading = false,
  detailError = null,
  onClose,
  onCenter,
  className,
}: FeatureInspectorProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  if (pick === null) return null;

  const kind = detail?.kind ?? pick.kind;
  const category = detail?.category ?? pick.category;
  const title = detail?.name ?? pick.name ?? detail?.address ?? kindLabel(kind);
  const status = detail?.status;
  const confidence = detail?.confidence;
  const lon = detail?.lon ?? pick.lonLat?.[0];
  const lat = detail?.lat ?? pick.lonLat?.[1];

  const identity: InspectorField[] = [
    { label: 'Identifiant', value: pick.stableId },
    { label: 'Type', value: kindLabel(kind) },
    { label: 'Catégorie', value: category.length > 0 ? category : 'non précisée' },
    { label: 'Couche de rendu', value: pick.layer },
    { label: 'Tuile', value: pick.tileId },
  ];
  if (status !== undefined) identity.push({ label: 'Statut', value: STATUS_TONE[status] ?? status });
  if (confidence !== undefined && confidence.length > 0) identity.push({ label: 'Confiance', value: confidence });

  const locality: InspectorField[] = [];
  if (detail?.address !== undefined && detail.address.length > 0) locality.push({ label: 'Adresse', value: detail.address });
  if (lon !== undefined && lat !== undefined) locality.push({ label: 'Coordonnées WGS84', value: `${lat.toFixed(6)}, ${lon.toFixed(6)}` });
  if (pick.height !== undefined) locality.push({ label: 'Hauteur', value: `${pick.height} m` });
  if (pick.width !== undefined) locality.push({ label: 'Largeur', value: `${pick.width} m` });
  locality.push({ label: 'Position locale', value: `${pick.anchor[0].toFixed(1)}, ${pick.anchor[1].toFixed(1)}` });

  const attributes: InspectorField[] = (detail?.attributes ?? []).filter((field) => field.value.length > 0);
  const sources = detail?.sources ?? [];

  return (
    <aside
      className={className ?? "feature-inspector"}
      role="complementary"
      aria-label="Détails de l'élément"
      data-testid="feature-inspector"
      data-feature-id={pick.stableId}
      style={{
        width: 336,
        maxWidth: '100%',
        maxHeight: '100%',
        overflowY: 'auto',
        borderLeft: `1px solid color-mix(in srgb, ${INK} 14%, transparent)`,
        background: PAPER,
        color: INK,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          padding: '13px 16px 11px',
          borderBottom: `1px solid color-mix(in srgb, ${INK} 12%, transparent)`,
          borderTop: `3px solid ${ACCENT}`,
          background: PAPER,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <h2
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 650,
              lineHeight: 1.3,
              overflowWrap: 'anywhere',
            }}
          >
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="inspector-close"
            onClick={onClose}
            aria-label="Fermer les détails"
            style={{
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              marginTop: -3,
              border: 'none',
              borderRadius: 2,
              background: 'transparent',
              color: `color-mix(in srgb, ${INK} 55%, transparent)`,
              cursor: 'pointer',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div
          style={{
            marginTop: '5px',
            display: 'flex',
            gap: '7px',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontSize: '10px',
              fontWeight: 650,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              padding: '1px 6px',
              border: '1px solid color-mix(in srgb, ${INK} 20%, transparent)',
              borderRadius: 2,
              color: ACCENT,
            }}
          >
            {kindLabel(kind)}
          </span>
          {status !== undefined ? (
            <span style={{ fontSize: '10px', letterSpacing: '0.05em', color: `color-mix(in srgb, ${INK} 58%, transparent)` }}>
              {STATUS_TONE[status] ?? status}
            </span>
          ) : null}
        </div>
        {onCenter ? (
          <button
            type="button"
            onClick={() => onCenter(pick)}
            data-testid="feature-inspector-center"
            style={{
              marginTop: '9px',
              padding: '5px 10px',
              border: `1px solid color-mix(in srgb, ${ACCENT} 55%, transparent)`,
              borderRadius: 2,
              background: `color-mix(in srgb, ${ACCENT} 12%, transparent)`,
              color: INK,
              font: 'inherit',
              fontSize: '11.5px',
              fontWeight: 650,
              letterSpacing: '0.02em',
              cursor: 'pointer',
            }}
          >
            Centrer sur l'élément
          </button>
        ) : null}
      </div>

      {detailLoading ? (
        <p
          role="status"
          style={{
            margin: 0,
            padding: '9px 16px',
            fontSize: '0.75rem',
            color: `color-mix(in srgb, ${INK} 55%, transparent)`,
          }}
        >
          Chargement de la fiche détaillée...
        </p>
      ) : null}
      {detailError !== null ? (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '9px 16px',
            fontSize: '0.75rem',
            color: `color-mix(in srgb, ${ACCENT} 70%, ${INK})`,
          }}
        >
          {detailError ?? 'Fiche détaillée indisponible pour cet élément.'}
        </p>
      ) : null}

      <Section label="Identité">
        <DefinitionList fields={identity} />
      </Section>

      {locality.length > 0 ? (
        <Section label="Localisation">
          <DefinitionList fields={locality} />
        </Section>
      ) : null}

      {attributes.length > 0 ? (
        <Section label="Attributs">
          <DefinitionList
            fields={attributes.map((field) => ({ label: attributeLabel(field.label), value: field.value }))}
          />
        </Section>
      ) : null}

      {sources.length > 0 ? (
        <Section label="Sources">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {sources.map((source) => (
              <li key={source.source} className="source-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '0.75rem' }}>
                <span style={{ fontWeight: 600 }}>{source.source}</span>
                {source.license !== undefined ? (
                  <span style={{ color: `color-mix(in srgb, ${INK} 55%, transparent)` }}>{source.license}</span>
                ) : null}
                {source.url !== undefined ? (
                  <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.75rem' }}>
                    Voir la source
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <p
        style={{
          margin: 0,
          padding: '10px 16px 18px',
          fontSize: '0.6875rem',
          color: `color-mix(in srgb, ${INK} 45%, transparent)`,
        }}
      >
        Échap ferme le menu contextuel. Maj+Tab quitte le panneau.
      </p>
    </aside>
  );
}

export default FeatureInspector;
