import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi, type ApiClient } from '../api';
import type { SettingsViewModel } from '../api/types';

/**
 * R17-2: the Settings screen is a pure function of the view-model.
 *
 * The R16 screen printed prototype values as if they were settings: a
 * "3 / 7" shadow week, a "50%" impact cap, a "2" and a "30" limit, and a
 * hard-coded `http://127.0.0.1:4173`. The S1 daemon measures ONE field
 * (`policyMode`, plus where it came from). Everything else renders "—" here,
 * and the prototype content lives in api/mock.ts where it is shown only when
 * the collection says `sample`.
 */
interface SettingsScreenProps {
  viewMode?: 'simple' | 'detail';
  onSetViewMode?: (mode: 'simple' | 'detail') => void;
  onOpenSetup?: () => void;
  onOpenGuide?: () => void;
  onReplayTour?: () => void;
  isMock?: boolean;
  onToggleFirstRun?: () => void;
  settings?: SettingsViewModel | undefined;
  api?: ApiClient | undefined;
}

const UNMEASURED = '—';

const POLICY_MODES: ReadonlyArray<{ id: 'manual' | 'low' | 'auto'; vm: SettingsViewModel['policyMode'] }> = [
  { id: 'manual', vm: 'manual' },
  { id: 'low', vm: 'auto-low-risk' },
  { id: 'auto', vm: 'auto' },
];

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  viewMode = 'simple',
  onSetViewMode,
  onOpenSetup,
  onOpenGuide,
  onReplayTour,
  isMock = true,
  onToggleFirstRun,
  settings: settingsProp,
  api: apiProp,
}) => {
  const { lang, setLang, t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [settings, setSettings] = useState<SettingsViewModel | undefined>(settingsProp);

  useEffect(() => {
    if (settingsProp !== undefined) {
      setSettings(settingsProp);
      return;
    }
    let active = true;
    api
      .getSettings()
      .then((data) => {
        if (active) setSettings(data);
      })
      .catch(() => {
        if (active) {
          setSettings({ meta: { source: 'unavailable', generatedAt: new Date().toISOString() } });
        }
      });
    return () => {
      active = false;
    };
  }, [settingsProp, api]);

  const settingsSource = settings?.meta?.source;
  const isSampleSettings = settingsSource === 'sample';
  const settingsUnavailable = settingsSource === 'unavailable';
  const policyMode = settings?.policyMode;
  const policyModeSource = settings?.policyModeSource;
  const limitValue = (value: number | undefined, suffix = ''): string =>
    typeof value === 'number' ? `${value}${suffix}` : UNMEASURED;
  const shadowWeek = settings?.shadowWeek;
  const shadowLabel =
    typeof shadowWeek?.day === 'number' && typeof shadowWeek?.total === 'number'
      ? `${shadowWeek.day} / ${shadowWeek.total}`
      : UNMEASURED;
  const mcpClients = settings?.mcpClients;

  /**
   * R17-2: the selected radio follows the mode the daemon reports. The S1
   * daemon is read-only, so clicking another option cannot be saved; the
   * screen says that instead of pretending the click did something.
   */
  useEffect(() => {
    const measured = settings?.policyMode;
    if (!measured) return;
    const match = POLICY_MODES.find((mode) => mode.vm === measured);
    if (match) setApprovalMode(match.id);
  }, [settings?.policyMode]);
  const [activeTab, setActiveTab] = useState<'general' | 'safety' | 'ai' | 'notify' | 'advanced'>('general');
  const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'auto'>('auto');
  const [approvalMode, setApprovalMode] = useState<'manual' | 'low' | 'auto'>('manual');
  const [aiBrain, setAiBrain] = useState<'none' | 'harness' | 'byok'>('harness');
  const [agentMode, setAgentMode] = useState<'interactive' | 'headless'>('interactive');
  const [showMcpDiff, setShowMcpDiff] = useState(false);
  const [approvalChannels, setApprovalChannels] = useState({
    ui: true,
    tty: false,
    notif: true,
    os: true,
  });
  const [actionDone, setActionDone] = useState<string | null>(null);

  const toggleApprovalChannel = (k: keyof typeof approvalChannels) => {
    setApprovalChannels((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  const applyTheme = (mode: 'light' | 'dark' | 'auto') => {
    setThemeMode(mode);
    if (mode === 'light') {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    } else if (mode === 'dark') {
      document.documentElement.classList.remove('light');
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('light', 'dark');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="settings-screen">
      {/* Header */}
      <div style={{ maxWidth: '820px' }}>
        <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          {t('s_h')}
        </h1>
        <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
          {t('s_sub')}
        </p>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('s_tabs')}
        style={{ display: 'flex', gap: '8px', borderBottom: '1.5px solid var(--line)', paddingBottom: '12px', overflowX: 'auto' }}
      >
        {[
          { id: 'general' as const, label: t('s_tab1') },
          { id: 'safety' as const, label: t('s_tab2') },
          { id: 'ai' as const, label: t('s_tab3') },
          { id: 'notify' as const, label: t('s_tab4') },
          { id: 'advanced' as const, label: t('s_tab5') },
        ].map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(tab.id);
                setActionDone(null);
                const h = window.location.hash || '#settings';
                window.location.hash = h.includes(`tab=${tab.id}`) ? h.replace(`tab=${tab.id}`, `tab=${tab.id}2`) : (h.includes('?') ? h + `&tab=${tab.id}` : h + `?tab=${tab.id}`);
              }}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '15px',
                padding: '8px 18px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--on-ink)' : 'var(--muted)',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {actionDone && (
        <div style={{ background: 'var(--grn-t)', color: 'var(--grn-i)', borderRadius: '14px', padding: '10px 16px', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{actionDone}</span>
          <button
            onClick={() => setActionDone(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '18px', lineHeight: 1, padding: '0 4px' }}
            aria-label="Đóng thông báo"
          >
            ×
          </button>
        </div>
      )}

      {/* Tab 1: General */}
      {activeTab === 'general' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="settings-tab-general">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            {/* Appearance */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_g1')}</h2>

              {/* Language */}
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_g1a')}</div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g1ad')}</div>
                </div>
                <div style={{ display: 'inline-flex', gap: '4px', background: 'var(--fill)', borderRadius: '999px', padding: '3px' }}>
                  <button
                    onClick={() => {
                      setLang('vi');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('lang=vi') ? h.replace('lang=vi', 'lang=vi2') : (h.includes('?') ? h + '&lang=vi' : h + '?lang=vi');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: lang === 'vi' ? 'var(--ink)' : 'transparent',
                      color: lang === 'vi' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    VI
                  </button>
                  <button
                    onClick={() => {
                      setLang('en');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('lang=en') ? h.replace('lang=en', 'lang=en2') : (h.includes('?') ? h + '&lang=en' : h + '?lang=en');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: lang === 'en' ? 'var(--ink)' : 'transparent',
                      color: lang === 'en' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    EN
                  </button>
                </div>
              </div>

              {/* Theme */}
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_g1b')}</div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g1bd')}</div>
                </div>
                <div style={{ display: 'inline-flex', gap: '4px', background: 'var(--fill)', borderRadius: '999px', padding: '3px' }}>
                  <button
                    onClick={() => {
                      applyTheme('light');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('th=light') ? h.replace('th=light', 'th=light2') : (h.includes('?') ? h + '&th=light' : h + '?th=light');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 12px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: themeMode === 'light' ? 'var(--ink)' : 'transparent',
                      color: themeMode === 'light' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    {t('s_light')}
                  </button>
                  <button
                    onClick={() => {
                      applyTheme('dark');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('th=dark') ? h.replace('th=dark', 'th=dark2') : (h.includes('?') ? h + '&th=dark' : h + '?th=dark');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 12px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: themeMode === 'dark' ? 'var(--ink)' : 'transparent',
                      color: themeMode === 'dark' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    {t('s_dark')}
                  </button>
                  <button
                    onClick={() => {
                      applyTheme('auto');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('th=auto') ? h.replace('th=auto', 'th=auto2') : (h.includes('?') ? h + '&th=auto' : h + '?th=auto');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 12px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: themeMode === 'auto' ? 'var(--ink)' : 'transparent',
                      color: themeMode === 'auto' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    {t('s_auto')}
                  </button>
                </div>
              </div>

              {/* View Mode */}
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_g1c')}</div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g1cd')}</div>
                </div>
                <div style={{ display: 'inline-flex', gap: '4px', background: 'var(--fill)', borderRadius: '999px', padding: '3px' }}>
                  <button
                    onClick={() => {
                      onSetViewMode && onSetViewMode('simple');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('vm=s') ? h.replace('vm=s', 'vm=s2') : (h.includes('?') ? h + '&vm=s' : h + '?vm=s');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: viewMode === 'simple' ? 'var(--ink)' : 'transparent',
                      color: viewMode === 'simple' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    {t('s_simple')}
                  </button>
                  <button
                    onClick={() => {
                      onSetViewMode && onSetViewMode('detail');
                      const h = window.location.hash || '#settings';
                      window.location.hash = h.includes('vm=d') ? h.replace('vm=d', 'vm=d2') : (h.includes('?') ? h + '&vm=d' : h + '?vm=d');
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '4px 14px',
                      borderRadius: '999px',
                      border: 0,
                      cursor: 'pointer',
                      background: viewMode === 'detail' ? 'var(--ink)' : 'transparent',
                      color: viewMode === 'detail' ? 'var(--on-ink)' : 'var(--muted)',
                    }}
                  >
                    {t('s_detail')}
                  </button>
                </div>
              </div>

              {/* Onboarding Tour */}
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('tour_replay')}</div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('tour_replay_desc')}</div>
                </div>
                {onReplayTour && (
                  <button
                    type="button"
                    data-testid="settings-replay-tour"
                    onClick={onReplayTour}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '6px 16px',
                      borderRadius: '999px',
                      border: '1.5px solid var(--line)',
                      background: 'var(--fill)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                    }}
                  >
                    {t('tour_replay')}
                  </button>
                )}
              </div>

              {/* Rerun Setup - only available in MockApi mode */}
              {isMock && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('ui0_reset_first_run')}</div>
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('f_sub')}</div>
                  </div>
                  <button
                    data-testid="settings-reset-first-run"
                    onClick={() => {
                      if (onToggleFirstRun) onToggleFirstRun();
                      if (onOpenSetup) onOpenSetup();
                    }}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '6px 16px',
                      borderRadius: '999px',
                      border: '1.5px solid var(--line)',
                      background: 'var(--fill)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                    }}
                  >
                    {t('ui0_reset_first_run')}
                  </button>
                </div>
              )}
            </section>

            {/* Scan Schedule */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_g2')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: '700', fontSize: '14px' }}>{t('s_g2a')}</div>
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g2ad')}</div>
                  </div>
                  <span
                    data-testid="settings-scan-schedule"
                    style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--text)' }}
                  >
                    {settings?.scanSchedule ? t(settings.scanSchedule) : UNMEASURED}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_g2b')}</div>
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g2bd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    {t('s_cost0')}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_g2c')}</div>
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('s_g2cd')}</div>
                  </div>
                  <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', color: 'var(--grn-i)', fontWeight: 600, fontSize: '13px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--grn)' }} />
                    {t('s_run')}
                  </span>
                </div>
              </div>
            </section>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            {/* Data on machine */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_g3')}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
                <div style={{ background: 'var(--fill)', borderRadius: '14px', padding: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_g3a')}</div>
                  <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '13px', marginTop: '2px' }}>~/.routersync</div>
                </div>
                <div style={{ background: 'var(--fill)', borderRadius: '14px', padding: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_g3b')}</div>
                  <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '13px', marginTop: '2px' }}>routersync.yaml</div>
                </div>
                <div style={{ background: 'var(--fill)', borderRadius: '14px', padding: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_g3c')}</div>
                  <div
                    data-testid="settings-local-url"
                    style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: '13px', marginTop: '2px' }}
                  >
                    {settings?.localUrl ?? UNMEASURED}
                  </div>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('s_g3n')}</p>
            </section>

            {/* Sample data & Reset */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_g4')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('s_g4d')}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                {onOpenSetup && (
                  <button
                    onClick={onOpenSetup}
                    className="btn"
                    style={{ font: 'inherit', fontSize: '13px', fontWeight: 700, padding: '8px 18px', borderRadius: '999px', border: '1.5px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                  >
                    {t('s_g4a')}
                  </button>
                )}
                {onOpenGuide && (
                  <button
                    onClick={onOpenGuide}
                    className="btn"
                    style={{ font: 'inherit', fontSize: '13px', fontWeight: 700, padding: '8px 18px', borderRadius: '999px', border: '1.5px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                  >
                    {t('s_g4b')}
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Tab 2: Safety */}
      {activeTab === 'safety' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="settings-tab-safety">
          {/* Approval mode */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_p1')}</h2>
            {/* R17-2: the mode the DAEMON reports, and where it came from. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'baseline', fontSize: '14px' }}>
              <span style={{ color: 'var(--muted)' }}>{t('s_policy_measured')}:</span>
              <span className="m" style={{ fontWeight: 700 }} data-testid="settings-policy-mode">
                {policyMode ?? UNMEASURED}
              </span>
              {policyModeSource === 'default' && (
                <span
                  data-testid="settings-policy-source"
                  style={{ padding: '2px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--yel-t)', color: 'var(--yel-i)' }}
                >
                  {t('s_policy_default_source')}
                </span>
              )}
            </div>
            {settingsUnavailable && (
              <div
                data-testid="settings-unavailable"
                style={{ background: 'var(--fill)', border: '1.5px dashed var(--dash)', borderRadius: '14px', padding: '14px 16px', fontSize: '13px', color: 'var(--muted)' }}
              >
                {t('s_policy_unavailable')}
              </div>
            )}
            <div role="radiogroup" aria-label={t('s_p1g')} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { id: 'manual' as const, label: t('s_p1a'), desc: t('s_p1ad') },
                { id: 'low' as const, label: t('s_p1b'), desc: t('s_p1bd') },
                { id: 'auto' as const, label: t('s_p1c'), desc: t('s_p1cd') },
              ].map((opt) => {
                const on = approvalMode === opt.id;
                return (
                  <label
                    key={opt.id}
                    onClick={() => setApprovalMode(opt.id)}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'flex-start',
                      padding: '12px 16px',
                      borderRadius: '16px',
                      cursor: 'pointer',
                      background: on ? 'var(--blue-sel)' : 'var(--fill)',
                      border: `1.5px solid ${on ? 'var(--blue)' : 'transparent'}`,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        flex: '0 0 18px',
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        border: `2px solid ${on ? 'var(--blue)' : 'var(--dash)'}`,
                        boxSizing: 'border-box',
                        marginTop: '3px',
                        background: on ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent',
                      }}
                    />
                    <span>
                      <span style={{ fontWeight: 700, display: 'block' }}>{opt.label}</span>
                      <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{opt.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            {approvalMode === 'auto' && (
              <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '12px 16px', fontSize: '13px' }}>
                {t('s_p1w')}
              </div>
            )}

            <div style={{ background: 'var(--fill)', borderRadius: '18px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontWeight: 700 }}>{t('s_sh')}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--muted)' }}>
                <span>{t('s_shd')}</span>
                <span style={{ fontWeight: 700 }} data-testid="settings-shadow-week">
                  {shadowLabel}
                </span>
              </div>
              <div style={{ height: '8px', background: 'var(--line)', borderRadius: '999px', overflow: 'hidden' }}>
                <div
                  style={{
                    width:
                      typeof shadowWeek?.day === 'number' && typeof shadowWeek?.total === 'number' && shadowWeek.total > 0
                        ? `${Math.round((shadowWeek.day / shadowWeek.total) * 100)}%`
                        : '0%',
                    height: '100%',
                    background: 'var(--blue)',
                  }}
                />
              </div>
            </div>
          </section>

          {/* Limits + Hard rules grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            {/* User adjustable limits */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_r1')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1a')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_r1ad')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }} data-testid="settings-limit-impact">
                    {limitValue(settings?.limits?.impactPercent, '%')}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1b')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_r1bd')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }} data-testid="settings-limit-min-models">
                    {limitValue(settings?.limits?.minModels)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1c')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_r1cd')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }} data-testid="settings-limit-min-providers">
                    {limitValue(settings?.limits?.minProviders)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1d')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_r1dd')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{t('s_r1dv')}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1e')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_r1ed')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{t('s_r1ev')}</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_r1f')}</div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }} data-testid="settings-limit-backups">
                    {limitValue(settings?.limits?.backups)}
                  </span>
                </div>
              </div>
            </section>

            {/* Hard rules */}
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_r2')}</h2>
              <div style={{ color: 'var(--muted)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span>🔒 {t('s_r2l')}:</span>
                <span>{t('s_r2n')}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}>
                <li>{t('s_h1')}</li>
                <li>{t('s_h2')}</li>
                <li>{t('s_h3')}</li>
                <li>{t('s_h4')}</li>
                <li>{t('s_h5')}</li>
                <li>{t('s_h6')}</li>
                <li>{t('s_h7')}</li>
                <li>{t('s_h8')}</li>
              </ul>
            </section>
          </div>

          {/* Emergency Stop & Breaker */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_k')}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('s_k1')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('s_k1d')}</span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('s_k2')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('s_k2d')}</span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b style={{ fontSize: '14px' }}>{t('s_k3')}</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('s_k3d')}</span>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Tab 3: AI & MCP */}
      {activeTab === 'ai' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="settings-tab-ai">
          <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px 18px', fontSize: '14px', color: 'var(--muted)' }}>
            {t('s_a0')}
          </div>

          {/* AI Brain Selection */}
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('v5_s_ab')}</h2>
            <div role="radiogroup" aria-label={t('v5_s_abg')} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { id: 'none' as const, label: t('v5_s_ab1'), desc: t('v5_s_ab1d') },
                { id: 'harness' as const, label: t('v5_s_ab2'), desc: t('v5_s_ab2d') },
                { id: 'byok' as const, label: t('v5_s_ab3'), desc: t('v5_s_ab3d') },
              ].map((opt) => {
                const on = aiBrain === opt.id;
                return (
                  <label
                    key={opt.id}
                    onClick={() => setAiBrain(opt.id)}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      alignItems: 'flex-start',
                      padding: '12px 16px',
                      borderRadius: '16px',
                      cursor: 'pointer',
                      background: on ? 'var(--blue-sel)' : 'var(--fill)',
                      border: `1.5px solid ${on ? 'var(--blue)' : 'transparent'}`,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        flex: '0 0 18px',
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        border: `2px solid ${on ? 'var(--blue)' : 'var(--dash)'}`,
                        boxSizing: 'border-box',
                        marginTop: '3px',
                        background: on ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent',
                      }}
                    />
                    <span>
                      <span style={{ fontWeight: 700, display: 'block' }}>{opt.label}</span>
                      <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{opt.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>
              {t('v5_s_abn')}
            </p>
          </section>

          {/* When Harness selected */}
          {aiBrain === 'harness' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
                {/* Your AI agents table */}
                <section
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: '24px',
                    padding: '24px',
                    boxShadow: 'var(--sh-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('v5_s_h1')}</h2>
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('v5_s_h1d')}</p>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                          <th style={{ padding: '8px 10px' }}>{t('v5_s_h1c1')}</th>
                          <th style={{ padding: '8px 10px' }}>{t('v5_s_h1c2')}</th>
                          <th style={{ padding: '8px 10px' }}>{t('v5_s_h1c3')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mcpClients && mcpClients.length > 0 ? (
                          mcpClients.map((client) => (
                            <tr key={client.client} style={{ borderBottom: '1px solid var(--line)' }}>
                              <td style={{ padding: '8px 10px', fontWeight: 600 }}>{client.client}</td>
                              <td style={{ padding: '8px 10px' }}>
                                <span
                                  style={{
                                    padding: '2px 8px',
                                    borderRadius: '999px',
                                    fontSize: '11px',
                                    background: client.configured ? 'var(--grn-t)' : 'var(--yel-t)',
                                    color: client.configured ? 'var(--grn-i)' : 'var(--yel-i)',
                                  }}
                                >
                                  {client.configured ? t('v5_s_cl_ok') : t('v5_s_cl_no')}
                                </span>
                              </td>
                              <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>
                                mcp: routersync
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td
                              colSpan={3}
                              data-testid="settings-mcp-unavailable"
                              style={{ padding: '8px 10px', color: 'var(--muted)' }}
                            >
                              {UNMEASURED} · {t('s_policy_unavailable')}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {showMcpDiff && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '12px', padding: '10px 14px', fontSize: '12px' }}>
                        {t('v5_s_h1w')}
                      </div>
                      <pre style={{ margin: 0, padding: '10px 14px', background: 'var(--code-bg)', color: 'var(--code-fg)', borderRadius: '12px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                        {`~/.config/hermes/mcp.json:\n{\n  "mcpServers": {\n+   "routersync": { "command": "routersync", "args": ["mcp"] }\n  }\n}`}
                      </pre>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => {
                            setActionDone('Đã đăng ký RouterSync vào Hermes Agent');
                            setShowMcpDiff(false);
                          }}
                          className="btn"
                          style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '6px 14px', borderRadius: '999px', border: 0, cursor: 'pointer', background: 'var(--ink)', color: 'var(--on-ink)' }}
                        >
                          {t('v5_s_h1ap')}
                        </button>
                        <button
                          onClick={() => setShowMcpDiff(false)}
                          className="btn"
                          style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '6px 14px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                        >
                          {t('v5_s_h1cl')}
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                {/* Agent mode */}
                <section
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: '24px',
                    padding: '24px',
                    boxShadow: 'var(--sh-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '14px',
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('v5_s_h2')}</h2>
                  <div role="radiogroup" aria-label={t('v5_s_h2g')} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label
                      onClick={() => setAgentMode('interactive')}
                      style={{
                        display: 'flex',
                        gap: '12px',
                        alignItems: 'flex-start',
                        padding: '12px 16px',
                        borderRadius: '16px',
                        cursor: 'pointer',
                        background: agentMode === 'interactive' ? 'var(--blue-sel)' : 'var(--fill)',
                        border: `1.5px solid ${agentMode === 'interactive' ? 'var(--blue)' : 'transparent'}`,
                      }}
                    >
                      <span aria-hidden="true" style={{ flex: '0 0 18px', width: '18px', height: '18px', borderRadius: '50%', border: '2px solid var(--blue)', boxSizing: 'border-box', marginTop: '3px', background: agentMode === 'interactive' ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent' }} />
                      <span>
                        <span style={{ fontWeight: 700, display: 'block' }}>{t('v5_s_h2a')}</span>
                        <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('v5_s_h2ad')}</span>
                      </span>
                    </label>
                    <label
                      onClick={() => setAgentMode('headless')}
                      style={{
                        display: 'flex',
                        gap: '12px',
                        alignItems: 'flex-start',
                        padding: '12px 16px',
                        borderRadius: '16px',
                        cursor: 'pointer',
                        background: agentMode === 'headless' ? 'var(--blue-sel)' : 'var(--fill)',
                        border: `1.5px solid ${agentMode === 'headless' ? 'var(--blue)' : 'transparent'}`,
                      }}
                    >
                      <span aria-hidden="true" style={{ flex: '0 0 18px', width: '18px', height: '18px', borderRadius: '50%', border: '2px solid var(--dash)', boxSizing: 'border-box', marginTop: '3px', background: agentMode === 'headless' ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent' }} />
                      <span>
                        <span style={{ fontWeight: 700, display: 'block' }}>{t('v5_s_h2b')}</span>
                        <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('v5_s_h2bd')}</span>
                      </span>
                    </label>
                  </div>
                </section>
              </div>

              {/* Approval channels */}
              <section
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: '24px',
                  padding: '24px',
                  boxShadow: 'var(--sh-card)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '14px',
                }}
              >
                <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('v5_s_ac')}</h2>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('v5_s_acd')}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  <button
                    onClick={() => toggleApprovalChannel('ui')}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontWeight: 600,
                      fontSize: '14px',
                      minHeight: '40px',
                      padding: '0 16px',
                      borderRadius: '999px',
                      border: `1.5px solid ${approvalChannels.ui ? 'var(--blue)' : 'var(--line)'}`,
                      cursor: 'pointer',
                      background: approvalChannels.ui ? 'var(--blue-sel)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    {approvalChannels.ui ? '✓ ' : ''}{t('v5_s_ac1')}
                  </button>
                  <button
                    onClick={() => toggleApprovalChannel('tty')}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontWeight: 600,
                      fontSize: '14px',
                      minHeight: '40px',
                      padding: '0 16px',
                      borderRadius: '999px',
                      border: `1.5px solid ${approvalChannels.tty ? 'var(--blue)' : 'var(--line)'}`,
                      cursor: 'pointer',
                      background: approvalChannels.tty ? 'var(--blue-sel)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    {approvalChannels.tty ? '✓ ' : ''}{t('v5_s_ac2')}
                  </button>
                  <button
                    onClick={() => toggleApprovalChannel('notif')}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontWeight: 600,
                      fontSize: '14px',
                      minHeight: '40px',
                      padding: '0 16px',
                      borderRadius: '999px',
                      border: `1.5px solid ${approvalChannels.notif ? 'var(--blue)' : 'var(--line)'}`,
                      cursor: 'pointer',
                      background: approvalChannels.notif ? 'var(--blue-sel)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    {approvalChannels.notif ? '✓ ' : ''}{t('v5_s_ac3')}
                  </button>
                  <button
                    onClick={() => toggleApprovalChannel('os')}
                    className="btn"
                    style={{
                      font: 'inherit',
                      fontWeight: 600,
                      fontSize: '14px',
                      minHeight: '40px',
                      padding: '0 16px',
                      borderRadius: '999px',
                      border: `1.5px solid ${approvalChannels.os ? 'var(--blue)' : 'var(--line)'}`,
                      cursor: 'pointer',
                      background: approvalChannels.os ? 'var(--blue-sel)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    {approvalChannels.os ? '✓ ' : ''}{t('v5_s_ac4')}
                  </button>
                </div>
                <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '12px', padding: '10px 14px', fontSize: '13px' }}>
                  {t('v5_s_acw')}
                </div>
                <div style={{ background: 'var(--fill)', borderRadius: '12px', padding: '10px 14px', fontSize: '13px', color: 'var(--muted)' }}>
                  {t('v5_s_dl')}
                </div>
              </section>
            </div>
          )}

          {/* MCP Server + Why agents cannot approve */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_a3')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_a3a')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_a3ad')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    {t('s_on')}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('v5_s_a3e')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('v5_s_a3ed')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    {t('s_on')}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_a3b')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_a3bd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}>
                    {t('s_off')}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('v5_s_a3f')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('v5_s_a3fd')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>~4,000</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_a3c')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_a3cd')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>stdio</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_a3d')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_a3dd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    {t('s_on')}
                  </span>
                </div>
              </div>
            </section>

            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_a4')}</h2>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}>
                <li>{t('s_a4a')}</li>
                <li>{t('s_a4b')}</li>
                <li>{t('s_a4c')}</li>
                <li>{t('v5_s_a4d')}</li>
                <li>{t('v5_s_a4e')}</li>
              </ul>
            </section>
          </div>
        </div>
      )}

      {/* Tab 4: Notifications */}
      {activeTab === 'notify' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }} data-testid="settings-tab-notify">
          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_n1')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {['Telegram', 'Discord', 'Webhook'].map((ch) => (
                <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{ch}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_n1a')}</div>
                  </div>
                  <button
                    onClick={() => setActionDone(`Kết nối ${ch}`)}
                    className="btn"
                    style={{ font: 'inherit', fontSize: '13px', fontWeight: 700, padding: '4px 14px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                  >
                    {t('s_conn')}
                  </button>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>{t('s_n1n')}</p>
          </section>

          <section
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '24px',
              boxShadow: 'var(--sh-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_n2')}</h2>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[t('s_n2a'), t('s_n2b'), t('s_n2c'), t('s_n2d')].map((item) => (
                <div key={item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <span style={{ fontSize: '14px' }}>{item}</span>
                  <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '12px', background: 'var(--grn-t)', color: 'var(--grn-i)', fontWeight: 700 }}>
                    ON
                  </span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1.5px dashed var(--line)' }}>
                <div>
                  <div style={{ fontSize: '14px' }}>{t('s_n2e')}</div>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_n2ed')}</div>
                </div>
                <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '12px', background: 'var(--fill)', color: 'var(--muted)', fontWeight: 700 }}>
                  OFF
                </span>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Tab 5: Advanced */}
      {activeTab === 'advanced' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="settings-tab-advanced">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_x1')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x1a')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x1ad')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--text)' }}>
                    stable
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x1b')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x1bd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    ● {t('s_x1bv')}
                  </span>
                </div>
              </div>
            </section>

            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_x2')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x2a')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x2ad')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>127.0.0.1</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x2b')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x2bd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}>
                    OFF
                  </span>
                </div>
              </div>
            </section>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_x3')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[
                  { a: t('s_x3a'), b: t('s_x3ad') },
                  { a: t('s_x3b'), b: t('s_x3bd') },
                  { a: t('s_x3c'), b: t('s_x3cd') },
                  { a: t('s_x3d'), b: t('s_x3dd') },
                ].map((act) => (
                  <div key={act.a} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '14px' }}>{act.a}</div>
                      <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{act.b}</div>
                    </div>
                    <button
                      onClick={() => setActionDone(`Đã thực hiện: ${act.a}`)}
                      className="btn"
                      style={{ font: 'inherit', fontSize: '13px', fontWeight: 700, padding: '4px 14px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                    >
                      {t('s_do')}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
            >
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('s_x4')}</h2>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x4a')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x4ad')}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>routersync-adapter-*</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x4b')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x4bd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}>
                    {t('s_off')}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{t('s_x4c')}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('s_x4cd')}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--grn-t)', color: 'var(--grn-i)' }}>
                    {t('s_none')}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
