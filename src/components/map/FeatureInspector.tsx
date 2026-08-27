'use client';

import { useState, type ReactNode } from 'react';
import type { MapFeature, ProvenanceRecord, SourceReference } from '@/lib/data/schema';

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function Section({
  label,
  defaultOpen = true,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="inspector-section">
      <button
        className="inspector-section-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg
          className={`section-chevron${open ? ' open' : ''}`}
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
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <div className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <span className="inspector-field-value">{String(value)}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export interface FeatureInspectorProps {
  /** The currently selected feature, or null */
  feature: MapFeature | null;
  /** Called to close / deselect */
  onClose?: () => void;
  /** Called to toggle the Nocibé commercial audit overlay */
  onToggleAudit?: (visible: boolean) => void;
  /** Current state of the audit overlay */
  auditVisible?: boolean;
  /** Provenance records for the selected feature */
  provenance?: ProvenanceRecord[];
}

export function FeatureInspector({
  feature,
  onClose,
  onToggleAudit,
  auditVisible = false,
  provenance,
}: FeatureInspectorProps) {
  if (!feature) return null;

  const isNocibe = feature.kind === "business" && /nocibe/i.test(feature.businessName);
  const category = "category" in feature ? feature.category : undefined;
  const banId = feature.kind === "address" ? feature.banId : undefined;
  const provenanceRecords = provenance ?? feature.provenance;
  const coordinateLabel = typeof feature.lon === "number" && typeof feature.lat === "number"
    ? `${feature.lat.toFixed(6)}, ${feature.lon.toFixed(6)}`
    : undefined;
  const sources = feature.sourceRefs ?? [];

  return (
    <aside className="feature-inspector" role="complementary" aria-label="Détails de l'élément">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-title-row">
          <h2 className="inspector-title">
            {feature.name ?? 'Sans nom'}
          </h2>
          <button
            className="inspector-close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="inspector-type-row">
          <span className="inspector-kind">{feature.kind}</span>
          <StatusBadge status={feature.status ?? 'active'} />
        </div>
      </div>

      {/* General info */}
      <Section label="Informations">
        <Field label="Identifiant" value={feature.stableId} />
        <Field label="Type" value={feature.kind} />
        {category && <Field label="Catégorie" value={category} />}
        {feature.confidence != null && (
          <Field label="Confiance" value={feature.confidence} />
        )}
      </Section>

      {/* Address section */}
      {(feature.address || banId || coordinateLabel) && (
        <Section label="Adresse">
          {feature.address && <Field label="Adresse" value={feature.address} />}
          {banId && <Field label="BAN ID" value={banId} />}
          {coordinateLabel && <Field label="Coordonnées" value={coordinateLabel} />}
        </Section>
      )}

      {/* Nocibé-specific: audited perimeter */}
      {isNocibe && onToggleAudit && (
        <Section label="Zone de chalandise Nocibé">
          <div className="inspector-note">
            Périmètre audité de la zone de chalandise. Affiche un rayon de 750&nbsp;m autour de Nocibé
            et le corridor vers la zone commerciale de la Place Villaret Joyeuse.
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={auditVisible}
              onChange={(e) => onToggleAudit(e.target.checked)}
            />
            <span>Afficher le périmètre audité</span>
          </label>

        </Section>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <Section label="Sources">
          {sources.map((s: SourceReference, i: number) => (
            <div key={i} className="source-row">
              <span className="source-name">{s.source}</span>
              {s.timestamp && <span className="source-ts">{s.timestamp}</span>}
              {s.license && <span className="source-license">{s.license}</span>}
              {s.url && (
                <a
                  className="source-url"
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Voir la source
                </a>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Provenance records */}
      {provenanceRecords.length > 0 && (
        <Section label="Conflits de provenance">
          {provenanceRecords.map((p: ProvenanceRecord, i: number) => (
            <div key={i} className="provenance-row">
              <span className="prov-property">{p.property}</span>
              <span className="prov-winner">
                Gagnant&nbsp;: <strong>{p.winner}</strong>
              </span>
              <span className="prov-contenders">
                Contendants&nbsp;: {p.contenders.join(', ')}
              </span>
            </div>
          ))}
        </Section>
      )}

      {/* Height / levels if building */}
      {feature.kind === 'building' && (
        <Section label="Hauteur">
          {feature.height != null && <Field label="Hauteur" value={`${feature.height} m`} />}
          {feature.levels != null && <Field label="Niveaux" value={feature.levels} />}
          {feature.heightInferred && (
            <div className="inspector-note">Hauteur estimée par catégorie</div>
          )}
        </Section>
      )}

      <style jsx>{`
        .feature-inspector {
          background: var(--color-paper);
          border-left: 1px solid color-mix(in srgb, var(--color-ink) 12%, transparent);
          width: 320px;
          max-height: 100%;
          overflow-y: auto;
          font-size: 0.8125rem;
          line-height: 1.5;
        }

        .inspector-header {
          padding: 14px 16px 10px;
          border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 10%, transparent);
        }

        .inspector-title-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .inspector-title {
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
          color: var(--color-ink);
        }

        .inspector-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
          cursor: pointer;
        }

        .inspector-close:hover {
          background: color-mix(in srgb, var(--color-ink) 8%, transparent);
          color: var(--color-ink);
        }

        .inspector-type-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 4px;
        }

        .inspector-kind {
          font-size: 0.6875rem;
          text-transform: uppercase;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
        }

        /* Status badges */
        .status-badge {
          display: inline-block;
          padding: 1px 6px;
          border-radius: 3px;
          font-size: 0.625rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .status-active {
          background: color-mix(in srgb, #22c55e 15%, transparent);
          color: #15803d;
        }

        .status-uncertain {
          background: color-mix(in srgb, #f59e0b 15%, transparent);
          color: #b45309;
        }

        .status-inferred {
          background: color-mix(in srgb, #3b82f6 15%, transparent);
          color: #1d4ed8;
        }

        .status-unresolved {
          background: color-mix(in srgb, #ef4444 15%, transparent);
          color: #b91c1c;
        }

        /* Sections */
        .inspector-section {
          border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 8%, transparent);
        }

        .inspector-section-header {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 10px 16px;
          border: none;
          background: transparent;
          color: var(--color-ink);
          font: inherit;
          font-size: 0.8125rem;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
        }

        .inspector-section-header:hover {
          background: color-mix(in srgb, var(--color-ink) 4%, transparent);
        }

        .section-chevron {
          transition: transform 0.15s;
        }

        .section-chevron.open {
          transform: rotate(90deg);
        }

        .inspector-section-body {
          padding: 0 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        /* Field rows */
        .inspector-field {
          display: flex;
          flex-direction: column;
          gap: 1px;
        }

        .inspector-field-label {
          font-size: 0.6875rem;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
          text-transform: uppercase;
          letter-spacing: 0.02em;
        }

        .inspector-field-value {
          font-size: 0.8125rem;
          color: var(--color-ink);
          word-break: break-all;
        }

        .inspector-note {
          padding: 6px 8px;
          border-radius: 4px;
          background: color-mix(in srgb, var(--color-ink) 4%, transparent);
          font-size: 0.75rem;
          color: color-mix(in srgb, var(--color-ink) 65%, transparent);
          line-height: 1.4;
        }

        /* Toggle */
        .toggle-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.8125rem;
          cursor: pointer;
          user-select: none;
        }

        .toggle-row input[type='checkbox'] {
          accent-color: var(--color-accent);
        }

        /* Anchor list */
        .anchor-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 4px;
        }

        .anchor-item {
          display: flex;
          justify-content: space-between;
          font-size: 0.75rem;
        }

        .anchor-name {
          font-weight: 500;
        }

        .anchor-coord {
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
          font-family: monospace;
          font-size: 0.6875rem;
        }

        /* Source rows */
        .source-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px 8px;
          font-size: 0.75rem;
        }

        .source-name {
          font-weight: 600;
        }

        .source-ts,
        .source-license {
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
        }

        .source-url {
          color: var(--color-accent);
          text-decoration: underline;
        }

        .source-url:hover {
          opacity: 0.8;
        }

        /* Provenance */
        .provenance-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 4px 0;
          border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 6%, transparent);
        }

        .provenance-row:last-child {
          border-bottom: none;
        }

        .prov-property {
          font-weight: 600;
          font-size: 0.6875rem;
          text-transform: uppercase;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
        }

        .prov-winner {
          font-size: 0.75rem;
        }

        .prov-contenders {
          font-size: 0.6875rem;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
        }
      `}</style>
    </aside>
  );
}

export default FeatureInspector;