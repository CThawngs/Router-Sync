import React from 'react';
import { useLanguage, t } from '../i18n';
import { useTheme } from '../theme';
import { useViewMode } from '../theme/viewMode';
import { DemoChip } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';

interface TopBarProps {
  isMock: boolean;
  isFirstRun: boolean;
  isPaused: boolean;
  /**
   * R16-2.1: the number of targets the daemon really reports. When it is
   * undefined the chip is not rendered at all — the top bar must never show
   * a hard-coded "two active, one preview" chip.
   */
  targetCount?: number | undefined;
  onTogglePause: () => void;
  onOpenAgentDrawer: () => void;
  isAgentDrawerOpen: boolean;
  onToggleFirstRun?: () => void;
  onToggleMobileNav?: () => void;
  isMobileNavOpen?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  isMock,
  isFirstRun,
  isPaused,
  targetCount,
  onTogglePause,
  onOpenAgentDrawer,
  isAgentDrawerOpen,
  onToggleFirstRun,
  onToggleMobileNav,
  isMobileNavOpen,
}) => {
  const [lang, setLang] = useLanguage();
  const [theme, , toggleTheme] = useTheme();
  const [viewMode, setViewMode] = useViewMode();

  const isDark =
    theme === 'dark' ||
    (theme === 'auto' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  // R16-2.1: the chip carries a MEASURED number only. The S1 daemon has no
  // "mode", so there is no active/preview chip to draw.
  const chipText =
    typeof targetCount === 'number' ? t('tb_targets', { count: targetCount }) : undefined;
  const chipLabel = isFirstRun ? t('ui0_mode_not_connected') : chipText;

  return (
    <header
      role="banner"
      className="rs-topbar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px 20px',
        padding: '20px 0 0',
      }}
    >
      {/* Trái: Mode Chip + Demo Chip */}
      <div
        className="rs-topbar-left"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}
      >
        {onToggleMobileNav && (
          <button
            type="button"
            className="rs-mobile-nav-btn"
            onClick={onToggleMobileNav}
            aria-label={t('nav_aria')}
            aria-expanded={isMobileNavOpen}
          >
            <Icon name="menu" size={20} />
          </button>
        )}
        {chipLabel !== undefined && (
          <div
            data-testid="mode-chip"
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              background: 'var(--card)',
              borderRadius: '999px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 700,
              boxShadow: 'var(--sh2)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: isFirstRun ? 'var(--unk)' : 'var(--grn-g)',
              }}
            />
            <span>{chipLabel}</span>
          </div>
        )}
        {isMock && (
          <DemoChip
            text={t('demo')}
            isFirstRun={isFirstRun}
            onToggleFirstRun={onToggleFirstRun}
          />
        )}
      </div>

      {/* Phải: Controls */}
      <div
        className="rs-topbar-right"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}
      >
        <div
          data-tour="controls"
          className="rs-topbar-controls"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}
        >
          {/* View Mode: Đơn giản / Chi tiết */}
        <div
          role="radiogroup"
          aria-label={t('vm_aria')}
          style={{
            display: 'flex',
            gap: '2px',
            background: 'var(--fill)',
            borderRadius: '999px',
            padding: '4px',
          }}
        >
          <button
            role="radio"
            aria-checked={viewMode === 'simple'}
            onClick={() => {
              setViewMode('simple');
              if (typeof window !== 'undefined') {
                const h = window.location.hash || '#overview';
                window.location.hash = h.includes('vm=s') ? h.replace('vm=s', 'vm=s2') : (h.includes('?') ? h + '&vm=s' : h + '?vm=s');
              }
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              minHeight: '40px',
              padding: '0 16px',
              border: 0,
              borderRadius: '999px',
              background: viewMode === 'simple' ? 'var(--ink)' : 'transparent',
              color: viewMode === 'simple' ? 'var(--on-ink)' : 'var(--muted)',
            }}
          >
            {t('vm_s')}
          </button>
          <button
            role="radio"
            aria-checked={viewMode === 'detail'}
            onClick={() => {
              setViewMode('detail');
              if (typeof window !== 'undefined') {
                const h = window.location.hash || '#overview';
                window.location.hash = h.includes('vm=d') ? h.replace('vm=d', 'vm=d2') : (h.includes('?') ? h + '&vm=d' : h + '?vm=d');
              }
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              minHeight: '40px',
              padding: '0 16px',
              border: 0,
              borderRadius: '999px',
              background: viewMode === 'detail' ? 'var(--ink)' : 'transparent',
              color: viewMode === 'detail' ? 'var(--on-ink)' : 'var(--muted)',
            }}
          >
            {t('vm_d')}
          </button>
        </div>

        {/* Ngôn ngữ: VI / EN */}
        <div
          role="group"
          aria-label="Language"
          style={{
            display: 'flex',
            gap: '2px',
            background: 'var(--fill)',
            borderRadius: '999px',
            padding: '4px',
          }}
        >
          <button
            aria-pressed={lang === 'vi'}
            onClick={() => {
              setLang('vi');
              if (typeof window !== 'undefined') {
                const h = window.location.hash || '#overview';
                window.location.hash = h.includes('lang=vi') ? h.replace('lang=vi', 'lang=vi2') : (h.includes('?') ? h + '&lang=vi' : h + '?lang=vi');
              }
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              minHeight: '40px',
              minWidth: '46px',
              border: 0,
              borderRadius: '999px',
              background: lang === 'vi' ? 'var(--ink)' : 'transparent',
              color: lang === 'vi' ? 'var(--on-ink)' : 'var(--muted)',
            }}
          >
            VI
          </button>
          <button
            aria-pressed={lang === 'en'}
            onClick={() => {
              setLang('en');
              if (typeof window !== 'undefined') {
                const h = window.location.hash || '#overview';
                window.location.hash = h.includes('lang=en') ? h.replace('lang=en', 'lang=en2') : (h.includes('?') ? h + '&lang=en' : h + '?lang=en');
              }
            }}
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '13px',
              minHeight: '40px',
              minWidth: '46px',
              border: 0,
              borderRadius: '999px',
              background: lang === 'en' ? 'var(--ink)' : 'transparent',
              color: lang === 'en' ? 'var(--on-ink)' : 'var(--muted)',
            }}
          >
            EN
          </button>
        </div>

        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          aria-label={t('theme_toggle')}
          aria-pressed={isDark}
          className="btn"
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: 0,
            background: 'var(--fill)',
            color: 'var(--text)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={isDark ? 'sun' : 'moon'} size={22} />
        </button>

        {/* Nút: Mở trong agent của bạn */}
        <Button
          variant="gradient"
          onClick={onOpenAgentDrawer}
          aria-expanded={isAgentDrawerOpen}
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {t('ui0_open_in_agent')}
        </Button>
      </div>

      {/* Nút: Dừng khẩn / Tiếp tục */}
      <div
        data-tour="emergency"
        className="rs-topbar-emergency"
        style={{ position: 'relative', zIndex: 10001 }}
      >
        {isPaused ? (
          <Button
            variant="ink"
            onClick={onTogglePause}
            aria-label={t('resume')}
          >
            {t('resume')}
          </Button>
        ) : (
          <Button
            variant="pause"
            onClick={onTogglePause}
            aria-label={t('pause')}
          >
            {t('pause')}
          </Button>
        )}
      </div>
    </div>
    </header>
  );
};
