'use client';

import type { SourceReference } from '@/lib/data/schema';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AttributionData {
  /** Dataset version string */
  datasetVersion?: string;
  /** UTC acquisition timestamp */
  acquisitionTime?: string;
  /** Ordered list of source references for attribution display */
  sources: SourceReference[];
  /** Additional attribution text (e.g. OSM contributors) */
  osmAttribution?: string;
}

export interface SourceAttributionProps {
  /** Attribution data from the manifest */
  data: AttributionData;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function SourceAttribution({ data }: SourceAttributionProps) {
  if (!data) return null;
  const { sources = [], datasetVersion, acquisitionTime, osmAttribution } = data;

  // Collect unique license strings
  const licenses = new Set(
    sources.filter((s) => s.license).map((s) => s.license as string),
  );

  return (
    <footer className="source-attribution" role="contentinfo" aria-label="Sources et attribution">
      <div className="attribution-content">
        {/* Source names */}
        <span className="attribution-sources">
          Données&nbsp;:&nbsp;
          {sources.map((s, i) => (
            <span key={i}>
              {s.url ? (
                <a
                  className="attribution-link"
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.source}
                </a>
              ) : (
                <span>{s.source}</span>
              )}
              {i < sources.length - 1 && <span>, </span>}
            </span>
          ))}
        </span>

        {/* OSM attribution (if separate) */}
        {osmAttribution && (
          <span className="attribution-osm">
            &copy;{' '}
            <a
              className="attribution-link"
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
            >
              {osmAttribution}
            </a>
          </span>
        )}

        {/* Licenses */}
        {licenses.size > 0 && (
          <span className="attribution-licenses">
            Licences&nbsp;: {[...licenses].join(', ')}
          </span>
        )}

        {/* Version / timestamp */}
        {(datasetVersion || acquisitionTime) && (
          <span className="attribution-meta">
            {datasetVersion && <span>v{datasetVersion}</span>}
            {datasetVersion && acquisitionTime && <span> &middot; </span>}
            {acquisitionTime && (
              <time dateTime={acquisitionTime}>
                {new Date(acquisitionTime).toLocaleDateString('fr-FR', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
            )}
          </span>
        )}
      </div>

      <style jsx>{`
        .source-attribution {
          padding: 6px 12px;
          background: color-mix(in srgb, var(--color-paper) 92%, transparent);
          backdrop-filter: blur(4px);
          border-top: 1px solid color-mix(in srgb, var(--color-ink) 8%, transparent);
          font-size: 0.6875rem;
          line-height: 1.5;
          color: color-mix(in srgb, var(--color-ink) 55%, transparent);
        }

        .attribution-content {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px 12px;
        }

        .attribution-sources,
        .attribution-osm,
        .attribution-licenses,
        .attribution-meta {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          white-space: nowrap;
        }

        .attribution-link {
          color: color-mix(in srgb, var(--color-ink) 55%, transparent);
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        .attribution-link:hover {
          color: var(--color-accent);
        }

        .attribution-meta {
          margin-left: auto;
          opacity: 0.75;
        }

        @media (max-width: 640px) {
          .attribution-content {
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
          }

          .attribution-meta {
            margin-left: 0;
          }
        }
      `}</style>
    </footer>
  );
}

export default SourceAttribution;