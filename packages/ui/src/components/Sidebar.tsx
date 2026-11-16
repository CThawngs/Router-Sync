import React from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';
import { HeartbeatHistory } from '../api/types';
import { formatClock } from '../utils/time';

export type ScreenId =
  | 'overview'
  | 'changes'
  | 'combos'
  | 'providers'
  | 'targets'
  | 'models'
  | 'health'
  | 'agents'
  | 'guide'
  | 'settings'
  | 'setup';

interface SidebarProps {
  currentScreen: ScreenId;
  onSelectScreen: (screen: ScreenId) => void;
  heartbeat?: HeartbeatHistory;
  /**
   * R16-2.2: the number of pending changes the daemon really reports.
   * `undefined` means "not measured" -> NO badge is painted.
   */
  pendingChangesCount?: number | undefined;
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentScreen,
  onSelectScreen,
  heartbeat,
  pendingChangesCount,
  isOpen,
  onClose,
}) => {
  const renderNavItem = (
    id: ScreenId,
    key: string,
    iconName: string,
    badgeText?: string
  ) => {
    const isActive = currentScreen === id;
    const tourAttr = id === 'changes' ? 'nav-changes' : id === 'targets' ? 'nav-targets' : undefined;
    return (
      <button
        key={id}
        data-tour={tourAttr}
        onClick={() => {
          onSelectScreen(id);
          onClose?.();
        }}
        aria-current={isActive ? 'page' : undefined}
        className={`nav-btn ${isActive ? 'active' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          minHeight: '46px',
          width: '100%',
          padding: '0 16px',
          border: 0,
          borderRadius: '999px',
          font: 'inherit',
          fontWeight: 700,
          fontSize: '15px',
          textAlign: 'left',
          background: isActive ? 'var(--ink)' : 'transparent',
          color: isActive ? 'var(--on-ink)' : 'var(--text)',
          cursor: 'pointer',
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
      >
        <Icon name={iconName} size={22} />
        <span style={{ flexGrow: 1 }}>{t(key)}</span>
        {badgeText && (
          <span
            className="m"
            style={{
              minWidth: '22px',
              height: '22px',
              borderRadius: '11px',
              background: 'var(--yel)',
              color: '#14131F',
              fontSize: '12px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 6px',
            }}
          >
            {badgeText}
          </span>
        )}
      </button>
    );
  };

  const renderCategory = (key: string) => (
    <div
      key={key}
      style={{
        padding: '10px 16px 2px',
        fontSize: '11px',
        fontWeight: 800,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--faint)',
      }}
    >
      {t(key)}
    </div>
  );

  // R16-2.3: no hard-coded tick pattern any more. Without a measured
  // heartbeat history every mark is a dashed grey line, because S1 has no
  // background scanner to report.
  const emptyTicks = Array.from({ length: 24 }, (_, i) => ({
    id: `t_${i}`,
    status: 'missed' as const,
  }));

  const ticks =
    heartbeat && heartbeat.ticks.length > 0 ? heartbeat.ticks : emptyTicks;

  const measuredTicks = ticks.filter((tick) => tick.status !== 'missed').length;

  const heartbeatLine = (() => {
    if (!heartbeat) return t('hb_unknown');
    if (heartbeat.daemonReachable === false) return t('hb_daemon_down');
    const parts: string[] = [];
    if (typeof heartbeat.uptimeSeconds === 'number') {
      parts.push(t('hb_uptime', { seconds: heartbeat.uptimeSeconds }));
    }
    // R18-5.2: `lastProbeAt` is a raw ISO stamp. The owner reads a clock, not
    // a machine timestamp, so it prints in local time. When the stamp cannot
    // be read the part is omitted instead of printed raw.
    const lastProbeClock = formatClock(heartbeat.lastProbeAt);
    if (lastProbeClock) {
      parts.push(t('hb_last_probe', { time: lastProbeClock }));
    }
    if (parts.length === 0) return t('hb_no_data');
    return parts.join(' · ');
  })();

  const heartbeatAria =
    heartbeat?.source === 'measured'
      ? t('hb_aria_measured', { measured: measuredTicks, total: ticks.length })
      : t('hb_aria_unavailable');

  return (
    <aside
      className={`side ${isOpen ? 'is-open' : ''}`}
      style={{
        flex: '0 0 268px',
        width: '268px',
        boxSizing: 'border-box',
        margin: '20px 0 20px 20px',
        background: 'var(--card)',
        borderRadius: '28px',
        boxShadow: 'var(--sh)',
        padding: '22px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        alignSelf: 'flex-start',
      }}
    >
      {/* Logo */}
      <div style={{ padding: '0 8px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              aria-hidden="true"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #B57BFF, #3D6BFF)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: '12px',
                  height: '3px',
                  borderRadius: '2px',
                  background: '#FFFFFF',
                }}
              />
            </div>
            <div
              style={{
                fontWeight: 800,
                fontSize: '20px',
                letterSpacing: '-0.02em',
                color: 'var(--text)',
              }}
            >
              RouterSync
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              className="rs-mobile-close-btn"
              onClick={onClose}
              aria-label={t('close')}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav
        className="nav"
        data-tour="nav"
        aria-label={t('nav_aria')}
        style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
      >
        {renderNavItem('overview', 'nav_overview', 'overview')}
        {renderNavItem(
          'changes',
          'nav_changes',
          'changes',
          pendingChangesCount !== undefined && pendingChangesCount > 0
            ? String(pendingChangesCount)
            : undefined
        )}

        {renderCategory('cap_manage')}
        {renderNavItem('combos', 'nav_combos', 'combos')}
        {renderNavItem('providers', 'nav_providers', 'providers')}
        {renderNavItem('targets', 'nav_targets', 'targets')}
        {renderNavItem('models', 'nav_models', 'models')}

        {renderCategory('cap_watch')}
        {renderNavItem('health', 'nav_health', 'health')}

        {renderCategory('cap_help')}
        {renderNavItem('agents', 'nav_agents', 'agents')}
        {renderNavItem('guide', 'nav_guide', 'guide')}
        {renderNavItem('settings', 'nav_settings', 'settings')}
      </nav>

      {/* Heartbeat box */}
      <div
        style={{
          background: 'var(--fill)',
          borderRadius: '20px',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div
          role="img"
          aria-label={heartbeatAria}
          data-testid="heartbeat-strip"
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: '3px',
            height: '22px',
          }}
        >
          {ticks.map((tick) => {
            // ponytail: CSS tick spans replace 4-sided dashed borders that rendered
            // as hollow square tofu boxes in browsers (UI-OBS-5).
            if (tick.status === 'warning') {
              return (
                <span
                  key={tick.id}
                  data-testid="heartbeat-tick"
                  aria-hidden="true"
                  className="hb-tick hb-tick-warning"
                  style={{
                    display: 'block',
                    width: '5px',
                    height: '22px',
                    borderRadius: '2.5px',
                    background: 'var(--yel)',
                  }}
                />
              );
            }
            if (tick.status === 'missed') {
              return (
                <span
                  key={tick.id}
                  data-testid="heartbeat-tick"
                  aria-hidden="true"
                  className="hb-tick hb-tick-missed"
                  style={{
                    display: 'block',
                    width: '5px',
                    height: '14px',
                    borderRadius: '2.5px',
                    background:
                      'repeating-linear-gradient(to bottom, var(--faint) 0px, var(--faint) 2.5px, transparent 2.5px, transparent 5px)',
                    opacity: 0.7,
                  }}
                />
              );
            }
            return (
              <span
                key={tick.id}
                data-testid="heartbeat-tick"
                aria-hidden="true"
                className="hb-tick hb-tick-ok"
                style={{
                  display: 'block',
                  width: '5px',
                  height: '14px',
                  borderRadius: '2.5px',
                  background: 'var(--grn)',
                }}
              />
            );
          })}
        </div>
        <div
          className="m"
          data-testid="heartbeat-label"
          style={{
            fontSize: '12px',
            color: 'var(--muted)',
            lineHeight: 1.4,
          }}
        >
          {heartbeatLine}
        </div>
      </div>
    </aside>
  );
};
