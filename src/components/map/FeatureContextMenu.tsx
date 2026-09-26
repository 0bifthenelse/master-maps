'use client';

/**
 * @file Menu contextuel d'un element selectionne sur la carte.
 *
 * Surface HUD pensee pour le clavier : la boite piege Tab, se parcourt
 * aux fleches et avec Origine/Fin, se ferme sur Echap et sur tout appui
 * pointeur hors de la boite. Elle est rendue dans une couche fixe au
 * point de clic, puis recadree dans la fenetre apres mesure pour qu'un
 * clic pres d'un bord montre toujours toutes les actions.
 *
 * Tant que le menu est ouvert il pose
 * documentElement.dataset.featureContextOpen, l'indicateur que le
 * suppresseur de menu natif (MapCamera) controle : le menu natif n'est
 * supprime que sur un element, un clic droit dans le vide conserve le
 * menu du navigateur.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { renderToWgs84 } from '@/lib/geo/crs';
import type { PickedFeature } from '@/lib/scene/highlight';

const MENU_MIN_WIDTH = 236;
const MENU_MAX_WIDTH = 320;
const MENU_ESTIMATED_HEIGHT = 460;
const VIEWPORT_MARGIN = 12;
const FEEDBACK_MS = 1400;
const HEADER_ATTRIBUTE_LIMIT = 4;

export interface FeatureContextMenuAttribute {
  label: string;
  value: string;
}

export interface FeatureContextMenuDetail {
  name?: string;
  status?: string;
  address?: string;
  kind: string;
  category?: string;
  attributes?: readonly FeatureContextMenuAttribute[];
  roadClass?: string;
  widthMetres?: number;
}

export interface FeatureContextMenuProps {
  pick: PickedFeature | null;
  /** Point de clic en coordonnees client. */
  clientX: number;
  clientY: number;
  onInspect: (pick: PickedFeature) => void;
  onCenter: (pick: PickedFeature) => void;
  onDismiss: () => void;
  /** Detail riche fusionne dans l'en-tete du menu. */
  detail?: FeatureContextMenuDetail | null;
}

type ActionId = 'inspect' | 'center' | 'coordinates' | 'label' | 'identifier' | 'road';
type CopyId = 'coordinates' | 'label' | 'identifier' | 'road';

interface MenuAction {
  id: ActionId;
  label: string;
  hint: string;
  disabled: boolean;
  run: () => void;
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  building: 'Bâtiment',
  road: 'Route',
  water: 'Eau',
  landuse: 'Occupation du sol',
  poi: "Point d'intérêt",
  business: 'Entreprise',
  address: 'Adresse',
  transport: 'Transport',
  structure: 'Équipement',
  place: 'Lieu',
  boundary: 'Limite',
};

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  yes: 'Non qualifié',
  road: 'Route',
  surface: 'Surface',
  water: "Cours d'eau",
  waterway: "Cours d'eau",
};

const INK = 'var(--color-ink, #000000)';
const PAPER = 'var(--color-paper, #ffffff)';
const ACCENT = 'var(--color-accent, #ff7d27)';
const HAIRLINE = `1px solid color-mix(in srgb, ${INK} 14%, transparent)`;
const MUTED = `color-mix(in srgb, ${INK} 58%, transparent)`;

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value.trim().length === 0 ? null : value.trim();
  return null;
}

/** Libelle lisible d'une cle d'attribut snake_case ou camelCase. */
export function attributeLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Header attributes taken from the render-tile meta, never invented. */
export function pickAttributes(pick: PickedFeature): FeatureContextMenuAttribute[] {
  const out: FeatureContextMenuAttribute[] = [];
  if (pick.height !== undefined) out.push({ label: 'Hauteur', value: `${displayValue(pick.height)} m` });
  if (pick.width !== undefined) out.push({ label: 'Largeur', value: `${displayValue(pick.width)} m` });
  for (const [key, raw] of Object.entries(pick.props ?? {})) {
    const value = displayValue(raw);
    if (value === null) continue;
    out.push({ label: attributeLabel(key), value });
  }
  return out;
}

export function lonLatText(pick: PickedFeature): string {
  const [lon, lat] = pick.lonLat ?? renderToWgs84(pick.anchor);
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

export function roadSummary(pick: PickedFeature, detail: FeatureContextMenuDetail | null | undefined): string | null {
  const roadClass = detail?.roadClass ?? pick.category;
  const width = detail?.widthMetres ?? pick.width;
  if (roadClass === undefined || roadClass.length === 0 || width === undefined) return null;
  return `${roadClass} - ${displayValue(width)} m`;
}

export function primaryLabel(pick: PickedFeature, detail: FeatureContextMenuDetail | null | undefined): string {
  const candidate = detail?.name ?? pick.name ?? detail?.address;
  if (candidate !== undefined && candidate.trim().length > 0) return candidate.trim();
  return 'Élément sans nom';
}

export function copyPayload(
  pick: PickedFeature,
  target: CopyId,
  detail: FeatureContextMenuDetail | null | undefined,
): string {
  if (target === 'coordinates') return lonLatText(pick);
  if (target === 'identifier') return pick.stableId;
  if (target === 'road') return roadSummary(pick, detail) ?? '';
  const label = primaryLabel(pick, detail);
  if (target === 'label') return label;
  const address = detail?.address;
  return address !== undefined && address.length > 0 ? `${label}\n${address}` : label;
}

function copyToClipboard(text: string): void {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

export function buildActions(
  pick: PickedFeature | null,
  detail: FeatureContextMenuDetail | null | undefined,
  onInspect: (pick: PickedFeature) => void,
  onCenter: (pick: PickedFeature) => void,
  onCopied: (id: CopyId) => void,
): MenuAction[] {
  if (pick === null) return [];
  const copy = (id: CopyId) => (): void => {
    copyToClipboard(copyPayload(pick, id, detail));
    onCopied(id);
  };
  const actions: MenuAction[] = [
    { id: 'inspect', label: 'Détails', hint: 'inspecteur', disabled: false, run: () => onInspect(pick) },
    { id: 'center', label: 'Centrer', hint: 'caméra', disabled: false, run: () => onCenter(pick) },
    { id: 'coordinates', label: 'Copier les coordonnées', hint: 'WGS84', disabled: false, run: copy('coordinates') },
    { id: 'label', label: 'Copier le nom / adresse', hint: 'texte', disabled: false, run: copy('label') },
    { id: 'identifier', label: "Copier l'identifiant", hint: 'stableId', disabled: false, run: copy('identifier') },
  ];
  if (roadSummary(pick, detail) !== null) {
    actions.push({
      id: 'road',
      label: 'Copier la classe et la largeur',
      hint: 'route',
      disabled: false,
      run: copy('road'),
    });
  }
  return actions;
}

function focusActionById(menu: HTMLDivElement | null, id: ActionId | undefined): void {
  if (menu === null || id === undefined) return;
  menu.querySelector<HTMLElement>(`[data-action-id="${id}"]`)?.focus();
}

interface MenuItemProps {
  action: MenuAction;
  active: boolean;
  copied: boolean;
  onActivate: () => void;
}

function MenuItem({ action, active, copied, onActivate }: MenuItemProps) {
  const handleClick = (): void => {
    if (action.disabled) return;
    action.run();
    onActivate();
  };
  const label: ReactNode = copied ? `${action.label} copié` : action.label;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={active ? 0 : -1}
      disabled={action.disabled}
      data-menu-action="true"
      data-action-id={action.id}
      data-active={active ? 'true' : 'false'}
      data-copied={copied ? 'true' : 'false'}
      onClick={handleClick}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '5px 12px',
        border: 'none',
        borderLeft: `3px solid ${active ? ACCENT : 'transparent'}`,
        background: active ? `color-mix(in srgb, ${ACCENT} 13%, transparent)` : 'transparent',
        color: copied ? ACCENT : INK,
        font: 'inherit',
        fontWeight: copied ? 650 : 400,
        textAlign: 'left',
        cursor: action.disabled ? 'default' : 'pointer',
        opacity: action.disabled ? 0.45 : 1,
      }}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        style={{
          fontSize: '9.5px',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: `color-mix(in srgb, ${INK} 42%, transparent)`,
          whiteSpace: 'nowrap',
        }}
      >
        {action.hint}
      </span>
    </button>
  );
}

export default function FeatureContextMenu({
  pick,
  clientX,
  clientY,
  onInspect,
  onCenter,
  onDismiss,
  detail,
}: FeatureContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState<CopyId | null>(null);
  const [activeId, setActiveId] = useState<ActionId | null>(null);
  const labelId = useId();
  const descriptionId = useId();

  const handleCopied = useCallback((id: CopyId): void => {
    setCopied(id);
  }, []);

  const actions = useMemo(
    () => buildActions(pick, detail, onInspect, onCenter, handleCopied),
    [detail, handleCopied, onCenter, onInspect, pick],
  );
  const actionIds = useMemo(() => actions.map((action) => action.id), [actions]);

  useEffect(() => {
    if (pick === null) return;
    setActiveId(null);
    setCopied(null);
  }, [pick]);

  useEffect(() => {
    if (pick === null) return undefined;
    document.documentElement.dataset.featureContextOpen = 'true';
    return () => {
      delete document.documentElement.dataset.featureContextOpen;
    };
  }, [pick]);

  useLayoutEffect(() => {
    if (pick === null) {
      setPosition(null);
      return;
    }
    const viewportWidth = typeof window === 'undefined' ? MENU_MIN_WIDTH : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - MENU_MAX_WIDTH - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - MENU_ESTIMATED_HEIGHT - VIEWPORT_MARGIN);
    setPosition({
      left: Math.min(Math.max(clientX, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(clientY, VIEWPORT_MARGIN), maxTop),
    });
  }, [clientX, clientY, pick]);

  useLayoutEffect(() => {
    if (pick === null || position === null) return;
    const measured = menuRef.current;
    if (measured === null) return;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
    const available = Math.max(VIEWPORT_MARGIN, viewportHeight - measured.getBoundingClientRect().height - VIEWPORT_MARGIN);
    const clamped = Math.min(Math.max(position.top, VIEWPORT_MARGIN), available);
    if (clamped !== position.top) setPosition((previous) => (previous === null ? previous : { left: previous.left, top: clamped }));
  }, [actionIds.length, pick, position]);

  useEffect(() => {
    if (pick === null) return;
    menuRef.current?.querySelector<HTMLElement>('[data-menu-action="true"]')?.focus();
  }, [pick]);

  useEffect(() => {
    if (pick === null || copied === null) return undefined;
    const timer = window.setTimeout(() => setCopied(null), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied, pick]);

  useEffect(() => {
    if (pick === null) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onDismiss();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onDismiss, pick]);

  const moveFocus = useCallback((next: number): void => {
    const id = actionIds[next];
    if (id === undefined) return;
    setActiveId(id);
    focusActionById(menuRef.current, id);
  }, [actionIds]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (actionIds.length === 0) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(actionIds.length - 1);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowUp' ? -1
      : event.key === 'Tab' && !event.shiftKey ? 1
      : event.key === 'Tab' && event.shiftKey ? -1
      : 0;
    if (step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = activeId === null ? (step === 1 ? -1 : 0) : actionIds.indexOf(activeId);
    moveFocus((from + step + actionIds.length) % actionIds.length);
  }, [actionIds, activeId, moveFocus, onDismiss]);

  if (pick === null) return null;

  const kind = detail?.kind ?? pick.kind;
  const category = detail?.category ?? pick.category;
  const attributes = detail?.attributes ?? pickAttributes(pick);

  return (
    <div
      ref={menuRef}
      className="feature-context-menu"
      role="menu"
      aria-modal="true"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      data-testid="feature-context-menu"
      data-feature-id={pick.stableId}
      data-feature-kind={pick.kind}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: position?.left ?? clientX,
        top: position?.top ?? clientY,
        minWidth: MENU_MIN_WIDTH,
        maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px))`,
        zIndex: 60,
        borderRadius: '2px',
        border: `1px solid color-mix(in srgb, ${INK} 24%, transparent)`,
        background: `color-mix(in srgb, ${PAPER} 97%, transparent)`,
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        boxShadow: `0 12px 28px color-mix(in srgb, ${INK} 24%, transparent)`,
        color: INK,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '12px',
        lineHeight: 1.45,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '9px 12px 8px',
          borderBottom: HAIRLINE,
          borderLeft: `3px solid ${ACCENT}`,
          background: `color-mix(in srgb, ${ACCENT} 8%, transparent)`,
        }}
      >
        <h2
          id={labelId}
          style={{
            margin: 0,
            fontSize: '12.5px',
            fontWeight: 650,
            lineHeight: 1.35,
            overflowWrap: 'anywhere',
            maxHeight: '2.7em',
            overflow: 'hidden',
          }}
        >
          {primaryLabel(pick, detail)}
        </h2>
        <div
          id={descriptionId}
          style={{
            marginTop: '4px',
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: MUTED,
          }}
        >
          <span data-testid="feature-context-kind">{kindLabel(kind)}</span>
          {category !== undefined && category.length > 0 ? (
            <span
              style={{
                padding: '0 5px',
                border: '1px solid color-mix(in srgb, ${INK} 20%, transparent)',
                borderRadius: '2px',
                color: ACCENT,
                fontWeight: 650,
              }}
            >
              {CATEGORY_LABEL[category] ?? category}
            </span>
          ) : null}
          {detail?.status !== undefined && detail.status.length > 0 ? (
            <span style={{ textTransform: 'none', letterSpacing: 0, color: `color-mix(in srgb, ${INK} 58%, transparent)` }}>
              {detail.status}
            </span>
          ) : null}
          <span style={{ textTransform: 'none', letterSpacing: 0, color: `color-mix(in srgb, ${INK} 45%, transparent)` }}>
            {pick.layer}
          </span>
        </div>
        {attributes.length > 0 ? (
          <dl
            style={{
              margin: '7px 0 0',
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr)',
              gap: '1px 8px',
              fontSize: '10.5px',
              color: `color-mix(in srgb, ${INK} 80%, transparent)`,
            }}
          >
            {attributes.slice(0, HEADER_ATTRIBUTE_LIMIT).map((attribute) => (
              <div key={attribute.label} style={{ display: 'contents' }}>
                <dt style={{ color: MUTED }}>{attribute.label}</dt>
                <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{attribute.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <ul role="presentation" style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
        {actions.map((action) => (
          <li key={action.id} role="presentation">
            <MenuItem
              action={action}
              active={activeId === action.id}
              copied={copied === action.id}
              onActivate={onDismiss}
            />
          </li>
        ))}
      </ul>
      <p
        style={{
          margin: 0,
          padding: '5px 12px 6px',
          borderTop: HAIRLINE,
          color: `color-mix(in srgb, ${INK} 46%, transparent)`,
          fontSize: '9.5px',
        }}
      >
        Flèches pour naviguer - Entrée pour valider - Échap pour fermer
      </p>
    </div>
  );
}
