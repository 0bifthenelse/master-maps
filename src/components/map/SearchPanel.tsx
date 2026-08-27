'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MapFeature } from "@/lib/data/schema";
import { SearchRecordSchema } from "@/lib/data/schema";
import { searchIndex } from "@/lib/data/search";
export interface SearchResult {
  featureId: string;
  name: string;
  kind: MapFeature['kind'];
  category?: string;
  tileId: string;
  focus: [number, number];
}

export interface SearchPanelProps {
  /**
   * Called when a result is selected. Passes the feature ID and focus coordinate.
   */
  onSelect: (featureId: string, focus: [number, number]) => void;
  /** Called to close/dismiss the search panel */
  onClose?: () => void;
  /** Whether the panel is open */
  open?: boolean;
}

const PLACEHOLDER = 'Rechercher dans le Gers';
const DEBOUNCE_MS = 200;
export function SearchPanel({ onSelect, onClose, open = true }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Debounced search
  const performSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setSelectedIndex(-1);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/map/search");
      const payload: unknown = await response.json();
      if (!response.ok || !Array.isArray(payload)) throw new Error("Search index unavailable");
      const records = payload.map((entry) => SearchRecordSchema.parse(entry));
      const matches = searchIndex(trimmed, records).map(({ record }) => ({
        featureId: record.featureId,
        name: record.canonicalName,
        kind: record.kind,
        category: record.category,
        tileId: record.tileId,
        focus: [record.focusLon, record.focusLat] as [number, number],
      }));
      setResults(matches);
      setSelectedIndex(matches.length > 0 ? 0 : -1);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      setQuery(value);
      clearTimeout(timerRef.current ?? undefined);
      timerRef.current = setTimeout(() => performSearch(value), DEBOUNCE_MS);
    },
    [performSearch],
  );

  const commitSelection = useCallback(
    (index: number) => {
      const r = results[index];
      if (!r) return;
      onSelect(r.featureId, r.focus);
      setQuery('');
      setResults([]);
    },
    [results, onSelect],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (results.length === 0) {
        if (e.key === 'Escape' && onClose) {
          onClose();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
          break;
        }
        case 'Enter': {
          e.preventDefault();
          commitSelection(selectedIndex);
          break;
        }
        case 'Escape': {
          e.preventDefault();
          setResults([]);
          setSelectedIndex(-1);
          inputRef.current?.blur();
          if (onClose) onClose();
          break;
        }
      }
    },
    [results, selectedIndex, commitSelection, onClose],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div className="search-panel" role="combobox" aria-expanded={results.length > 0} aria-haspopup="listbox" aria-controls="search-results">
      <div className="search-input-wrapper">
        <svg
          className="search-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          className="search-input"
          placeholder={PLACEHOLDER}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={PLACEHOLDER}
          aria-autocomplete="list"
          aria-controls="search-results"
          autoComplete="off"
        />
        {loading && <span className="search-spinner" aria-label="Chargement" />}
      </div>

      {results.length > 0 && (
        <div
          ref={listRef}
          id="search-results"
          className="search-results"
          role="listbox"
          aria-label="Résultats de recherche"
        >
          {results.map((r, i) => (
            <button
              key={r.featureId}
              role="option"
              aria-selected={i === selectedIndex}
              className={`search-result-item${i === selectedIndex ? ' active' : ''}`}
              onClick={() => commitSelection(i)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="result-name">{r.name}</span>
              <span className="result-kind">{r.kind}</span>
            </button>
          ))}
        </div>
      )}

      {query.trim() && !loading && results.length === 0 && (
        <div className="search-empty" role="status">
          Aucun résultat
        </div>
      )}

      <style jsx>{`
        .search-panel {
          position: relative;
          width: 100%;
          max-width: 380px;
        }

        .search-input-wrapper {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border: 1px solid color-mix(in srgb, var(--color-ink) 20%, transparent);
          border-radius: 6px;
          background: var(--color-paper);
        }

        .search-input-wrapper:focus-within {
          border-color: var(--color-accent);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 30%, transparent);
        }

        .search-icon {
          flex-shrink: 0;
          color: color-mix(in srgb, var(--color-ink) 45%, transparent);
        }

        .search-input {
          flex: 1;
          border: none;
          outline: none;
          background: transparent;
          font: inherit;
          font-size: 0.875rem;
          color: var(--color-ink);
        }

        .search-input::placeholder {
          color: color-mix(in srgb, var(--color-ink) 45%, transparent);
        }

        .search-spinner {
          width: 14px;
          height: 14px;
          border: 2px solid color-mix(in srgb, var(--color-ink) 15%, transparent);
          border-top-color: var(--color-accent);
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .search-results {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          max-height: 320px;
          overflow-y: auto;
          background: var(--color-paper);
          border: 1px solid color-mix(in srgb, var(--color-ink) 15%, transparent);
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          z-index: 100;
        }

        .search-result-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 10px 12px;
          border: none;
          background: transparent;
          color: var(--color-ink);
          font: inherit;
          font-size: 0.875rem;
          text-align: left;
          cursor: pointer;
          transition: background-color 0.1s;
        }

        .search-result-item.active {
          background: color-mix(in srgb, var(--color-accent) 12%, transparent);
        }

        .search-result-item:hover {
          background: color-mix(in srgb, var(--color-accent) 8%, transparent);
        }

        .result-name {
          font-weight: 500;
        }

        .result-kind {
          font-size: 0.75rem;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
          text-transform: uppercase;
        }

        .search-empty {
          padding: 12px;
          font-size: 0.875rem;
          color: color-mix(in srgb, var(--color-ink) 50%, transparent);
          text-align: center;
        }
      `}</style>
    </div>
  );
}

export default SearchPanel;