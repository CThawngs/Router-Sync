import React, { useState, useEffect, useCallback } from 'react';
import {
  useApi,
  SystemOverview,
  PipelineModule,
  HeartbeatHistory,
} from './api';
import { resolveDataSource, type DataSource } from './api/dataSource';
import { useTheme } from './theme';
import { useLanguage, t } from './i18n';
import { Sidebar, ScreenId } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { AgentDrawer } from './components/AgentDrawer';
import { PausedBanner, SampleBanner } from './components/Banners';
import { DataSourceBanner } from './components/DataSourceBanner';
import { ScreenErrorBoundary } from './components/ScreenErrorBoundary';
import { TourModal } from './components/TourModal';
import { OverviewScreen } from './screens/OverviewScreen';
import { ChangesScreen } from './screens/ChangesScreen';
import { CombosScreen } from './screens/CombosScreen';
import { ProvidersScreen } from './screens/ProvidersScreen';
import { TargetsScreen } from './screens/TargetsScreen';
import { ModelsScreen } from './screens/ModelsScreen';
import { HealthScreen } from './screens/HealthScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { GuideScreen } from './screens/GuideScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SetupWizardScreen } from './screens/SetupWizardScreen';

const VALID_SCREENS: Set<ScreenId> = new Set([
  'overview',
  'changes',
  'combos',
  'providers',
  'targets',
  'models',
  'health',
  'agents',
  'guide',
  'settings',
  'setup',
]);

function getScreenFromHash(): ScreenId {
  if (typeof window === 'undefined') return 'overview';
  const raw = window.location.hash.replace(/^[#\/]+/, '').split(/[?~&]/)[0];
  if (raw === 'connect') return 'agents';
  if (raw && VALID_SCREENS.has(raw as ScreenId)) {
    return raw as ScreenId;
  }
  return 'overview';
}

export const App: React.FC = () => {
  const api = useApi();
  const [theme] = useTheme();
  const [lang] = useLanguage();

  const [currentScreen, setCurrentScreen] = useState<ScreenId>(getScreenFromHash);
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'simple' | 'detail'>('simple');

  const navigateTo = useCallback((sc: ScreenId) => {
    setCurrentScreen(sc);
    if (typeof window !== 'undefined') {
      const curHash = window.location.hash.replace(/^[#\/]+/, '');
      const curBase = curHash.split(/[?~&]/)[0];
      if (curBase === sc) {
        const hasTilde = curHash.includes('~');
        window.location.hash = hasTilde ? `#${sc}` : `#${sc}~`;
      } else {
        window.location.hash = `#${sc}`;
      }
    }
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const next = getScreenFromHash();
      setCurrentScreen(next);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      if (typeof window !== 'undefined') {
        window.location.hash = '';
      }
    };
  }, []);

  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [pipeline, setPipeline] = useState<PipelineModule[]>([]);
  const [heartbeat, setHeartbeat] = useState<HeartbeatHistory | undefined>(undefined);
  /** R16-2.1: measured number of targets (GET /api/v1/targets). */
  const [targetCount, setTargetCount] = useState<number | undefined>(undefined);
  /** R16-2.2: measured number of pending changes; undefined = not measured. */
  const [pendingChangesCount, setPendingChangesCount] = useState<number | undefined>(undefined);
  /** R16-2.2: false when GET /api/v1/changes/pending is unavailable. */
  const [pendingChangesAvailable, setPendingChangesAvailable] = useState(true);
  /** R16-2.4: the daemon reports whether it is the read-only build. */
  const [daemonReadOnly, setDaemonReadOnly] = useState<boolean | undefined>(undefined);
  /** R18-3: the measured per-router reachability, and whether the daemon answered. */
  const [daemonRouters, setDaemonRouters] = useState<
    Array<{ id: string; reachability: 'up' | 'down' | 'unknown' }>
  >([]);
  const [daemonReachable, setDaemonReachable] = useState<boolean | undefined>(undefined);
  /** R16-2.1: where the numbers on screen come from. */
  const [dataSource, setDataSource] = useState<DataSource>('sample');
  const [loading, setLoading] = useState(true);

  // Tour state management (routersync.tour.v1)
  const [isTourOpen, setIsTourOpen] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined' && window.location?.search) {
        const p = new URLSearchParams(window.location.search);
        if (p.get('tour') === '1') return true;
        if (p.get('tour') === '0') return false;
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        const seen = window.localStorage.getItem('routersync.tour.v1');
        if (seen === 'completed' || seen === 'dismissed') return false;
        return !seen;
      }
    } catch {
      // ignore
    }
    return false;
  });

  const handleCloseTour = () => {
    setIsTourOpen(false);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem('routersync.tour.v1', 'completed');
      }
    } catch {
      // ignore
    }
  };

  const handleOpenTour = () => {
    setIsTourOpen(true);
  };

  const loadData = async () => {
    const isMock = api.isMock();
    // R16-2: every part is settled on its own. One failing endpoint must not
    // blank the whole shell, and the shell must survive a daemon that is not
    // running at all.
    const [ovRes, plRes, hbRes, targetsRes, planRes, healthRes] = await Promise.allSettled([
      api.getOverview(),
      api.getPipelineModules(),
      api.getHeartbeat(),
      api.getTargets(),
      api.getPendingPlan(),
      api.getDaemonHealth(),
    ]);

    const ov = ovRes.status === 'fulfilled' ? ovRes.value : undefined;
    if (ov) setOverview(ov);
    if (plRes.status === 'fulfilled') setPipeline(plRes.value);
    if (hbRes.status === 'fulfilled') setHeartbeat(hbRes.value);
    if (targetsRes.status === 'fulfilled') setTargetCount(targetsRes.value.length);
    if (planRes.status === 'fulfilled') {
      const plan = planRes.value;
      // R16-2.2: an "unavailable" pending plan means the number was NOT
      // measured -> no badge at all and no "review changes" button.
      const available = plan.meta?.source !== 'unavailable';
      setPendingChangesAvailable(available);
      setPendingChangesCount(available ? (plan.actions?.length ?? 0) : undefined);
    }

    const health =
      healthRes.status === 'fulfilled' ? healthRes.value : undefined;
    if (health) setDaemonReadOnly(health.readOnly);
    setDaemonReachable(health?.reachable ?? false);
    setDaemonRouters(health?.routers ?? []);
    const reachable = health?.reachable ?? false;
    setDataSource(resolveDataSource(isMock, ov?.meta?.source, reachable));
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTogglePause = async () => {
    try {
      if (isTourOpen) {
        setIsTourOpen(false);
      }
      const res = await api.toggleEmergencyPause();
      if (overview) {
        setOverview({ ...overview, isPaused: res.isPaused });
      }
      if (res.isPaused) {
        setIsTourOpen(false);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Close tour immediately if Emergency Stop (pause) is triggered
  useEffect(() => {
    if (overview?.isPaused) {
      setIsTourOpen(false);
    }
  }, [overview?.isPaused]);

  const shouldShowTour = isTourOpen && currentScreen !== 'setup' && !overview?.isPaused;

  const handleToggleFirstRun = async () => {
    if (!overview) return;
    const nextState = !overview.isFirstRun;
    await api.setFirstRun(nextState);
    setOverview({ ...overview, isFirstRun: nextState });
  };

  const renderActiveScreen = () => {
    switch (currentScreen) {
      case 'overview':
        return overview ? (
          <OverviewScreen
            overview={overview}
            pipelineModules={pipeline}
            readOnly={daemonReadOnly}
            pendingChangesCount={pendingChangesCount}
            pendingChangesAvailable={pendingChangesAvailable}
            targetCount={targetCount}
            unresponsiveRouters={daemonRouters
              .filter((r) => r.reachability !== 'up')
              .map((r) => r.id)}
            daemonReachable={daemonReachable}
            firstRun={overview.firstRun}
            onNavigate={navigateTo}
            onToggleFirstRun={handleToggleFirstRun}
            onOpenAgentDrawer={() => setIsAgentDrawerOpen(true)}
          />
        ) : (
          <div
            data-testid="overview-unavailable"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <strong>{t('ds_unreachable_title')}</strong>
            <span style={{ color: 'var(--muted)' }}>{t('ds_unreachable_body')}</span>
          </div>
        );
      case 'changes':
        return <ChangesScreen onNavigate={navigateTo} isMock={api.isMock()} />;
      case 'combos':
        return <CombosScreen onNavigate={navigateTo} />;
      case 'providers':
        return <ProvidersScreen viewMode={viewMode} />;
      case 'targets':
        return <TargetsScreen viewMode={viewMode} />;
      case 'models':
        return <ModelsScreen viewMode={viewMode} />;
      case 'health':
        return <HealthScreen viewMode={viewMode} />;
      case 'agents':
        return <AgentsScreen />;
      case 'guide':
        return (
          <GuideScreen
            onOpenSetup={() => navigateTo('setup')}
            onReplayTour={handleOpenTour}
          />
        );
      case 'settings':
        return (
          <SettingsScreen
            viewMode={viewMode}
            onSetViewMode={(vm) => setViewMode(vm)}
            onOpenSetup={() => navigateTo('setup')}
            onOpenGuide={() => navigateTo('guide')}
            onReplayTour={handleOpenTour}
            isMock={api.isMock()}
            onToggleFirstRun={handleToggleFirstRun}
          />
        );
      case 'setup':
        return (
          <SetupWizardScreen
            onFinish={() => navigateTo('overview')}
            onSkip={() => navigateTo('overview')}
          />
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--muted)' }}>
        {t('ui0_loading')}
      </div>
    );
  }

  return (
    <div
      className="rs"
      data-theme={theme}
      style={{
        boxSizing: 'border-box',
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontSize: '15px',
        lineHeight: 1.55,
      }}
    >
      <div
        style={{
          maxWidth: '1440px',
          margin: '0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <Sidebar
          currentScreen={currentScreen}
          onSelectScreen={navigateTo}
          heartbeat={heartbeat}
          pendingChangesCount={pendingChangesCount}
          isOpen={isMobileNavOpen}
          onClose={() => setIsMobileNavOpen(false)}
        />

        <div
          className="rs-main-content"
          style={{
            flex: '999 1 620px',
            minWidth: 0,
            padding: '0 28px 56px',
            boxSizing: 'border-box',
          }}
        >
          <TopBar
            isMock={api.isMock()}
            isFirstRun={overview?.isFirstRun ?? false}
            isPaused={overview?.isPaused ?? false}
            targetCount={targetCount}
            onTogglePause={handleTogglePause}
            onOpenAgentDrawer={() => setIsAgentDrawerOpen(!isAgentDrawerOpen)}
            isAgentDrawerOpen={isAgentDrawerOpen}
            onToggleFirstRun={handleToggleFirstRun}
            onToggleMobileNav={() => setIsMobileNavOpen((prev) => !prev)}
            isMobileNavOpen={isMobileNavOpen}
          />

          <main
            role="main"
            style={{
              paddingTop: '22px',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
            }}
          >
            {/* R16-2.1: the global data-source strip, driven by the client. */}
            <DataSourceBanner source={dataSource} />
            {overview?.isPaused && <PausedBanner onTogglePause={handleTogglePause} />}
            {overview?.isFirstRun && <SampleBanner onStartSetup={() => navigateTo('setup')} />}
            <AgentDrawer
              isOpen={isAgentDrawerOpen}
              onClose={() => setIsAgentDrawerOpen(false)}
              onGoChanges={() => {
                setIsAgentDrawerOpen(false);
                navigateTo('changes');
              }}
              onGoSettingsAi={() => {
                setIsAgentDrawerOpen(false);
                navigateTo('settings');
              }}
            />
            {/* R16-1 (AT-146): one boundary per route. A screen that cannot
                render shows an error card; the shell and the other screens
                keep working. The `key` remounts the boundary on every screen
                change, so leaving a broken screen clears the error card —
                without it the boundary would keep the old error forever. */}
            <ScreenErrorBoundary key={currentScreen} screenId={currentScreen}>
              {renderActiveScreen()}
            </ScreenErrorBoundary>
          </main>
        </div>
      </div>

      <TourModal
        isOpen={shouldShowTour}
        isMock={api.isMock()}
        onClose={handleCloseTour}
        onNavigate={navigateTo}
      />
    </div>
  );
};
