import React from 'react';
import { t } from '../i18n';

export type GlyphType = 'ok' | 'new' | 'warn' | 'bad' | 'unk';
export type TagKind = 'free' | 'neutral' | 'blue' | 'amber' | 'vio' | 'bad';

const GLYPH_MAP: Record<GlyphType, { char: string; colorVar: string }> = {
  ok: { char: '●', colorVar: 'var(--grn-ink)' },
  new: { char: '◆', colorVar: 'var(--blue)' },
  warn: { char: '▲', colorVar: 'var(--amb-ink)' },
  bad: { char: '✕', colorVar: 'var(--cor-ink)' },
  unk: { char: '?', colorVar: 'var(--unk)' },
};

export const Glyph: React.FC<{ type: GlyphType; className?: string; style?: React.CSSProperties }> = ({
  type,
  className = '',
  style,
}) => {
  const g = GLYPH_MAP[type] || GLYPH_MAP.unk;
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        color: g.colorVar,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...style,
      }}
    >
      {g.char}
    </span>
  );
};

const TAG_STYLES: Record<TagKind, { bg: string; color: string }> = {
  free: { bg: 'var(--grn-t)', color: 'var(--grn-ink)' },
  neutral: { bg: 'var(--fill)', color: 'var(--muted)' },
  blue: { bg: 'var(--blue-t)', color: 'var(--blue-i)' },
  amber: { bg: 'var(--yel-t2)', color: 'var(--yel-i)' },
  vio: { bg: 'var(--vio-t)', color: 'var(--vio-i)' },
  bad: { bg: 'var(--cor-t)', color: 'var(--cor-ink)' },
};

export const Tag: React.FC<{
  children: React.ReactNode;
  kind?: TagKind;
  className?: string;
  style?: React.CSSProperties;
}> = ({ children, kind = 'neutral', className = '', style }) => {
  const s = TAG_STYLES[kind] || TAG_STYLES.neutral;
  return (
    <span
      className={className}
      style={{
        background: s.bg,
        color: s.color,
        borderRadius: '999px',
        padding: '2px 12px',
        fontSize: '12px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const DemoChip: React.FC<{
  text?: string;
  isFirstRun?: boolean;
  onToggleFirstRun?: () => void;
}> = ({ text, isFirstRun, onToggleFirstRun }) => {
  const [open, setOpen] = React.useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="m"
        data-testid="demo-chip"
        onClick={() => {
          if (onToggleFirstRun) setOpen(!open);
        }}
        aria-haspopup={onToggleFirstRun ? 'menu' : undefined}
        aria-expanded={onToggleFirstRun ? open : undefined}
        style={{
          fontSize: '11px',
          color: 'var(--muted)',
          border: '1.5px dashed var(--dash)',
          borderRadius: '999px',
          padding: '4px 12px',
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          background: 'transparent',
          cursor: onToggleFirstRun ? 'pointer' : 'default',
        }}
      >
        <span>{text ?? t('demo')}</span>
        {onToggleFirstRun && <span aria-hidden="true" style={{ fontSize: '9px' }}>▾</span>}
      </button>

      {open && onToggleFirstRun && (
        <div
          role="menu"
          data-testid="demo-chip-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            background: 'var(--card)',
            border: '1.5px solid var(--line)',
            borderRadius: '14px',
            boxShadow: 'var(--sh)',
            zIndex: 100,
            padding: '8px',
            minWidth: '220px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted)', padding: '4px 8px' }}>
            {t('ui0_view_state')}
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="demo-chip-toggle"
            onClick={() => {
              onToggleFirstRun();
              setOpen(false);
            }}
            style={{
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--text)',
              background: 'var(--fill)',
              cursor: 'pointer',
            }}
          >
            {isFirstRun ? t('ui0_switch_to_running') : t('ui0_switch_to_first_run')}
          </button>
        </div>
      )}
    </div>
  );
};
