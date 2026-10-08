"use client";

import { useId, type KeyboardEvent, type RefObject } from "react";
import { Icon } from "./Icon";

export interface SearchResultView {
  id: string;
  code: string;
  tone: "yellow" | "white" | "red" | "ghost";
  name: string;
  context: string;
  kind: string;
}

export interface CategoryChip {
  id: string;
  label: string;
}

export interface SearchConsoleProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  results: readonly SearchResultView[];
  pending: boolean;
  open: boolean;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (index: number) => void;
  /** Enter before the typed query has answered: search it now and open the best match. */
  onSubmit: () => void;
  onClose: () => void;
  onFocus: () => void;
  chips: readonly CategoryChip[];
  activeChip: string | null;
  onChip: (id: string | null) => void;
  statusText: string;
}

function highlight(text: string, query: string): React.ReactNode {
  const tokens = query
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return text;
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  /* NFD keeps one combining mark per accented letter, so map folded indices back to the original. */
  const map: number[] = [];
  let source = 0;
  for (const char of text) {
    const decomposed = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (let index = 0; index < decomposed.length; index += 1) map.push(source);
    source += char.length;
  }
  const marks = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at < 0) break;
      const atWordStart = at === 0 || !/[a-z0-9]/.test(folded[at - 1]!);
      if (atWordStart) for (let index = at; index < at + token.length; index += 1) marks[map[index] ?? index] = true;
      from = at + token.length;
    }
  }
  const parts: React.ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number): void => {
    if (run === "") return;
    parts.push(marked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    if (marks[index] !== marked) {
      flush(index);
      marked = marks[index]!;
    }
    run += text[index];
  }
  flush(text.length);
  return parts;
}

export default function SearchConsole(props: SearchConsoleProps) {
  const { inputRef, query, onQueryChange, results, pending, open, activeIndex, onActiveIndexChange, onSelect, onSubmit, onClose, onFocus, chips, activeChip, onChip, statusText } = props;
  const listId = useId();
  const showResults = open && (results.length > 0 || (query.trim().length >= 2 && !pending));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) onActiveIndexChange((activeIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) onActiveIndexChange((activeIndex - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (pending || results.length === 0) onSubmit();
      else onSelect(Math.max(0, activeIndex));
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") onQueryChange("");
      else {
        onClose();
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className="mm-search" role="search">
      <div className="mm-search__box mm-panel mm-brackets">
        <span className="mm-search__prompt" aria-hidden="true">&gt;</span>
        <label className="sr-only" htmlFor={`${listId}-input`}>Search the Gers</label>
        <input
          id={`${listId}-input`}
          ref={inputRef}
          className="mm-search__input"
          data-testid="search-input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search places, streets, addresses"
          value={query}
          role="combobox"
          aria-expanded={showResults}
          aria-controls={`${listId}-list`}
          aria-activedescendant={activeIndex >= 0 && results[activeIndex] !== undefined ? `${listId}-${activeIndex}` : undefined}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
        />
        {query !== "" ? (
          <button type="button" className="mm-search__clear" aria-label="Clear search" onClick={() => { onQueryChange(""); inputRef.current?.focus(); }}>
            <Icon name="close" width={16} height={16} />
          </button>
        ) : <span className="mm-search__kbd" aria-hidden="true">/</span>}
        {pending ? <span className="mm-scanbar" aria-hidden="true" /> : null}
      </div>
      <div className="mm-chips" role="toolbar" aria-label="Find nearby">
        {chips.map((chip) => (
          <button key={chip.id} type="button" className="mm-chip" aria-pressed={activeChip === chip.id} onClick={() => onChip(activeChip === chip.id ? null : chip.id)}>
            {chip.label}
          </button>
        ))}
      </div>
      {showResults ? (
        <div className="mm-panel mm-results" id={`${listId}-list`} role="listbox" aria-label="Search results" aria-busy={pending}>
          <div className="mm-results__status">
            <span className="mm-tag">{pending ? "Analyzing…" : statusText}</span>
            <span className="mm-tag">{results.length > 0 ? `${results.length} match${results.length > 1 ? "es" : ""}` : ""}</span>
          </div>
          {results.length === 0 ? <div className="mm-results__empty">No match in the Gers. Try a commune, a street, a business name or a category such as “pharmacy”.</div> : null}
          {results.map((result, index) => (
            <button
              key={result.id}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="mm-result"
              data-testid={`search-result-${result.id}`}
              data-feature-kind={result.kind}
              onMouseEnter={() => onActiveIndexChange(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(index)}
            >
              <span className={`mm-chip-code mm-result__code${result.tone === "yellow" ? "" : ` mm-chip-code--${result.tone}`}`}>{result.code}</span>
              <span>
                <span className="mm-result__name">{highlight(result.name, query)}</span>
                {result.context !== "" ? <span className="mm-result__context">{result.context}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
