import React from 'react';
import { t } from '../i18n';
import { useViewMode } from '../theme/viewMode';
import { Card, Note } from '../components/Card';
import { Button } from '../components/Button';
import { Glyph, GlyphType } from '../components/Badge';
import { Icon } from '../components/Icon';
import { SystemOverview, PipelineModule, FirstRunViewModel } from '../api/types';
import { ScreenId } from '../components/Sidebar';
import { routerLabel } from '../utils/routerLabel';

interface OverviewScreenProps {
  overview: SystemOverview;
  pipelineModules: PipelineModule[];
  /**
   * R16-2.4: the daemon reports `readOnly: true`. Only then may the screen
   * say "RouterSync has not written anything to your configuration".
   */
  readOnly?: boolean | undefined;
  /** R16-2.2: the measured number of pending changes (undefined = not measured). */
  pendingChangesCount?: number | undefined;
  /** R16-2.2: false when GET /api/v1/changes/pending is unavailable. */
  pendingChangesAvailable?: boolean;
  /** R16-2.6: the measured number of targets (GET /api/v1/targets). */
  targetCount?: number | undefined;
  /**
   * R17-3: the first-run checklist and detections. The S1 daemon does not
   * provide them, so the branch renders a dash plus a dashed frame and claims
   * nothing about this machine.
   */
  firstRun?: FirstRunViewModel | undefined;
  /**
   * R18-3: the routers the daemon measured as NOT answering, by name. Empty or
   * undefined means "no name measured", and the banner subtitle then falls
   * back to a neutral sentence instead of inventing a name.
   */
  unresponsiveRouters?: string[] | undefined;
  /** R18-3: false when the daemon could not be reached at all. */
  daemonReachable?: boolean | undefined;
  onNavigate: (screen: ScreenId) => void;
  onToggleFirstRun: () => void;
  onOpenAgentDrawer: () => void;
}

/**
 * UI-OBS-4: Value tiles show text values at readable size.
 * Short numeric / ratio values (<= 5 chars without letters) retain large clamp sizing (32-36px).
 * Text or longer values (> 5 chars or containing letters) downscale to balanced ~20px (weight 700)
 * to prevent card overflow and multi-line stacking.
 */
export function getMetricValueStyle(value: string): React.CSSProperties {
  const isTextOrLong = /[a-zA-Z\p{L}]/u.test(value) || value.trim().length > 5;
  if (isTextOrLong) {
    return {
      fontSize: '20px',
      fontWeight: 700,
      letterSpacing: '-0.01em',
      lineHeight: 1.25,
      wordBreak: 'break-word',
    };
  }
  return {
    fontSize: 'clamp(32px, 3.2vw, 36px)',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  };
}

export const OverviewScreen: React.FC<OverviewScreenProps> = ({
  overview,
  pipelineModules,
  readOnly,
  pendingChangesCount,
  pendingChangesAvailable = true,
  targetCount,
  unresponsiveRouters,
  daemonReachable,
  firstRun,
  onNavigate,
  onToggleFirstRun,
  onOpenAgentDrawer,
}) => {
  const [viewMode] = useViewMode();
  const isDetail = viewMode === 'detail';
  // R14: the screen never invents state. `meta.source` is the only signal that
  // the numbers below are prototype sample content, so it drives the badge.
  const isSample = overview.meta?.source === 'sample';

  const sampleBadge = (
    <div
      data-testid="sample-badge"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        background: 'var(--yel-t)',
        border: '1.5px solid var(--yel)',
        borderRadius: '16px',
        padding: '12px 16px',
      }}
    >
      <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--yel-i)' }}>{t('r14_sample_badge')}</span>
      <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('r14_sample_badge_desc')}</span>
    </div>
  );

  if (overview.isFirstRun) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
        {isSample && sampleBadge}
        {/* Hero Card First Run */}
        <section
          data-tour="hero"
          aria-labelledby="w-t"
          style={{
            boxSizing: 'border-box',
            background: 'linear-gradient(135deg, var(--vio-t), var(--blue-t))',
            borderRadius: '24px',
            padding: '32px',
            boxShadow: 'none',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '20px 32px',
          }}
        >
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <h1
              id="w-t"
              style={{
                margin: 0,
                fontWeight: 800,
                fontSize: 'clamp(30px, 3.6vw, 46px)',
                lineHeight: 1.08,
                letterSpacing: '-0.03em',
              }}
            >
              {t('f_h')}
            </h1>
            <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: '17px', maxWidth: '620px' }}>
              {t('f_p')}
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' }}>
            <Button variant="ink" onClick={() => onNavigate('setup')}>
              {t('f_start')}
            </Button>
            {/* R17-3: the demo toggle only exists for sample content. With a
                live or unavailable payload there is nothing to demo, and the
                branch must not be reachable. */}
            {isSample && (
              <button
                onClick={onToggleFirstRun}
                data-testid="firstrun-demo-toggle"
                className="btn"
                style={{
                  font: 'inherit',
                  fontWeight: 700,
                  minHeight: '44px',
                  padding: '0 4px',
                  border: 0,
                  background: 'transparent',
                  color: 'var(--link)',
                  textDecoration: 'underline',
                }}
              >
                {t('f_demo')}
              </button>
            )}
          </div>
        </section>

        {/* Bắt đầu: 4 bước */}
        <Card id="c-t" title={t('f_check')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '-6px' }}>
            <div style={{ flex: 1, height: '10px', borderRadius: '5px', background: 'var(--track)' }}>
              <div
                style={{
                  width:
                    typeof firstRun?.checklistDone === 'number'
                      ? `${Math.round((firstRun.checklistDone / 4) * 100)}%`
                      : '0%',
                  height: '10px',
                  borderRadius: '5px',
                  background: 'var(--grn)',
                }}
              />
            </div>
            <span className="m" style={{ fontSize: '13px' }} data-testid="firstrun-checklist">
              {typeof firstRun?.checklistDone === 'number' ? `${firstRun.checklistDone} / 4` : '—'}
            </span>
          </div>

          <div style={{ marginTop: '-8px' }}>
            {[
              {
                num: 1,
                tone: 'blue',
                title: t('f_c1'),
                desc: t('f_c1d'),
                isPrimary: true,
              },
              {
                num: 2,
                tone: 'vio',
                title: t('f_c2'),
                desc: t('f_c2d'),
                isPrimary: false,
              },
              {
                num: 3,
                tone: 'grn',
                title: t('f_c3'),
                desc: t('f_c3d'),
                isPrimary: false,
              },
              {
                num: 4,
                tone: 'yel',
                title: t('f_c4'),
                desc: t('f_c4d'),
                isPrimary: false,
              },
            ].map((step) => {
              const toneColors: Record<string, [string, string]> = {
                blue: ['var(--blue-t)', 'var(--blue-i)'],
                vio: ['var(--vio-t)', 'var(--vio-i)'],
                grn: ['var(--grn-t)', 'var(--grn-i)'],
                yel: ['var(--yel-t2)', 'var(--yel-i)'],
              };
              const [bg, fg] = toneColors[step.tone] || ['var(--fill)', 'var(--text)'];

              return (
                <div
                  key={step.num}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '12px 18px',
                    alignItems: 'center',
                    padding: '16px 0',
                    borderTop: '1.5px dashed var(--line)',
                  }}
                >
                  <span
                    className="m"
                    style={{
                      flex: '0 0 40px',
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      background: bg,
                      color: fg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                    }}
                  >
                    {step.num}
                  </span>
                  <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{step.title}</div>
                    <div style={{ color: 'var(--muted)', fontSize: '14px' }}>{step.desc}</div>
                  </div>
                  {step.isPrimary ? (
                    <Button variant="ink" style={{ minHeight: '44px' }} onClick={() => onNavigate('providers')}>
                      {t('f_go')}
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={() => onNavigate('targets')}>
                      {t('f_go')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* 2 cột: Tự kiểm tra máy + Sẽ không bao giờ */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))',
            gap: '20px',
            alignItems: 'start',
          }}
        >
          {/* Card: RouterSync đã tự kiểm tra máy của bạn */}
          <Card id="det-t" title={t('f_det')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {firstRun?.detections && firstRun.detections.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {firstRun.detections.map((item) => (
                    <div key={item.id} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type={item.state === 'ok' ? 'ok' : item.state === 'warn' ? 'warn' : 'unk'} />
                      <span>
                        {t(item.textKey)}
                        {item.value ? (
                          <>
                            {' '}
                            <span className="m">{item.value}</span>
                          </>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  data-testid="firstrun-detections-unavailable"
                  style={{
                    background: 'var(--fill)',
                    border: '1.5px dashed var(--dash)',
                    borderRadius: '14px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    fontSize: '14px',
                    color: 'var(--muted)',
                  }}
                >
                  <strong style={{ color: 'var(--text)' }}>{t('s1_needs_p3a')}</strong>
                  <span>{t('w_detections_unavailable')}</span>
                </div>
              )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '4px' }}>{t('f_dn')}</div>
          </Card>

          {/* Card: RouterSync sẽ không bao giờ */}
          <Card id="nv-t" title={t('f_never')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {[t('f_n1'), t('f_n2'), t('f_n3'), t('f_n4'), t('f_n5')].map((rule, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                  <Glyph type="ok" />
                  <span>{rule}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Card: Tùy chọn dùng agent AI */}
        <Card id="ao-t" title={t('f_ao')}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px 20px',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '-6px',
            }}
          >
            <span style={{ flex: '1 1 420px', color: 'var(--text)', fontSize: '14px', lineHeight: 1.6 }}>
              {t('f_aod')}
            </span>
            <Button variant="secondary" onClick={onOpenAgentDrawer}>
              {t('f_aob')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Trạng thái: Tổng quan đang chạy (Running)
  const todoCount = overview.todoItems?.length ?? 0;

  // R16-2.4 / R17-0.1: the hero state is DERIVED from the view-model, never
  // assumed. The sentence counts the routers that did NOT answer, so it is
  // `probedCount - upCount`, NOT `upCount`: with 0 of 2 up the banner said
  // "0/2 routers did not respond" — the exact opposite of the payload.
  //   - probedCount === 0 -> nothing was probed: no claim about routers;
  //   - downCount > 0     -> "down/probed routers did not respond";
  //   - downCount === 0   -> every probed router answered.
  const routers = overview.routers;
  const routersKnown =
    typeof routers?.upCount === 'number' && typeof routers?.probedCount === 'number';
  const probedCount = routersKnown ? routers.probedCount : undefined;
  const hasProbe = typeof probedCount === 'number' && probedCount > 0;
  const downCount = hasProbe ? probedCount - (routers?.upCount ?? 0) : undefined;
  const isPartial = typeof downCount === 'number' && downCount > 0;
  const isUnmeasured = routersKnown && !hasProbe;
  const isDegraded = isPartial || overview.meta?.source === 'unavailable';
  const heroTitle = isPartial
    ? t('d_hero_warn_routers', { down: downCount ?? 0, probed: probedCount ?? 0 })
    : isUnmeasured
    ? t('d_hero_unmeasured')
    : isDegraded
    ? t('d_hero_warn')
    : t('d_hero');

  // R18-3: the subtitle must never contradict the banner. In the warning state
  // the banner says "N/M routers did not respond", so the line right under it
  // cannot say "nothing needs your attention". Priority order:
  //   1. daemon not reachable -> claim nothing at all;
  //   2. a router is down     -> name the measured ones, else a neutral sentence;
  //   3. nothing measured     -> claim nothing at all;
  //   4. every probed router up -> the calm sentence is finally true.
  // R19-3.1: the reader knows products (`OmniRoute`, `9Router`), the daemon
  // speaks ids. The banner names the product; an id the catalog does not know
  // is printed as it arrived.
  const heroSubtitle =
    daemonReachable === false
      ? t('r18_hero_sub_unknown')
      : isPartial
      ? unresponsiveRouters !== undefined && unresponsiveRouters.length > 0
        ? t('r18_hero_sub_down_named', {
            routers: unresponsiveRouters.map(routerLabel).join(', '),
          })
        : t('r18_hero_sub_down_unnamed')
      : !routersKnown || isUnmeasured || overview.meta?.source === 'unavailable'
      ? t('r18_hero_sub_unknown')
      : todoCount > 0
      ? t('d_hero_p', { count: todoCount })
      : t('d_hero_p_none');

  // R16-2.6: the five step counters come from the view-model (or "—").
  const pendingCount = typeof pendingChangesCount === 'number' ? pendingChangesCount : 0;
  const hasPending = pendingCount > 0;
  const howStepCounts: Record<number, string> = {
    1: '—',
    2:
      typeof overview.trackedModels?.count === 'number'
        ? t('d_h2c_unit', { count: overview.trackedModels.count })
        : '—',
    3: '—',
    4: hasPending ? t('d_h4c') : '—',
    5: typeof targetCount === 'number' ? t('d_h5c_unit', { count: targetCount }) : '—',
  };

  // R16-2.7: the age line only exists when the view-model carries an age.
  const formatAge = (seconds: number | undefined): string | undefined => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
    if (seconds < 60) return t('ago_seconds', { n: Math.round(seconds) });
    if (seconds < 3600) return t('ago_minutes', { n: Math.round(seconds / 60) });
    if (seconds < 86400) return t('ago_hours', { n: Math.round(seconds / 3600) });
    return t('ago_days', { n: Math.round(seconds / 86400) });
  };

  // R16-2.5: the "not measured in S1" label appears if and only if the value
  // shown right above it is "—". A measured value never carries the label.
  // The optional second argument is a TRANSLATED caption (never a raw
  // sentence coming from the payload).
  const tileSubtitle = (valueIsDash: boolean, caption?: string | undefined): string =>
    valueIsDash ? t('s1_not_measured') : (caption ?? '');

  const routersValue = hasProbe ? `${routers?.upCount ?? 0}/${probedCount}` : '—';
  const modelsValue =
    typeof overview.trackedModels?.count === 'number' ? String(overview.trackedModels.count) : '—';
  const requestsValue =
    typeof overview.billableRequestsToday?.count === 'number'
      ? String(overview.billableRequestsToday.count)
      : overview.billableRequestsToday?.code
      ? t(overview.billableRequestsToday.code)
      : '—';
  const lastCheckValue = overview.lastCheck?.code ? t(overview.lastCheck.code) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      {isSample && sampleBadge}
      {/* Hero Banner */}
      <section
        data-tour="hero"
        aria-labelledby="hero-t"
        style={{
          boxSizing: 'border-box',
          background: isDegraded
            ? 'linear-gradient(135deg, var(--yel-t), var(--fill))'
            : 'linear-gradient(135deg, var(--grn-t), var(--blue-t))',
          borderRadius: '24px',
          padding: '24px',
          boxShadow: 'none',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '18px 28px',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flex: '0 0 64px',
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: isDegraded ? 'var(--yel)' : 'var(--grn)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="check" size={30} style={{ stroke: '#14131F', strokeWidth: 3 }} />
        </span>
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <h1
            id="hero-t"
            style={{
              margin: 0,
              fontWeight: 800,
              fontSize: 'clamp(28px, 3.2vw, 40px)',
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
            }}
          >
            {heroTitle}
          </h1>
          <p
            data-testid="hero-subtitle"
            style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: '16px', maxWidth: '640px' }}
          >
            {heroSubtitle}
          </p>
          {/* R16-2.4: this sentence is a static capability of the read-only
              daemon, so it is only shown when the daemon says readOnly. */}
          {readOnly === true && (
            <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '14px', maxWidth: '640px' }}>
              {t('d_hero_readonly')}
            </p>
          )}
        </div>
        {/* R16-2.2: the button points at a list the daemon cannot produce yet
            -> it is hidden instead of leading to an empty page. */}
        {pendingChangesAvailable && (
          <Button variant="ink" onClick={() => onNavigate('changes')}>
            {t('d_hero_btn')}
          </Button>
        )}
      </section>

      {/* 4 Tiles số liệu */}
      <div
        data-tour="tiles"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))',
          gap: '16px',
        }}
      >
        {/* Tile 1: Routers phản hồi (R14: `routers` replaces the removed `activeProviders`) */}
        <button
          data-testid="metric-tile"
          onClick={() => onNavigate('providers')}
          className="lift"
          style={{
            boxSizing: 'border-box',
            background: 'var(--card)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh)',
            textAlign: 'left',
            border: 0,
            font: 'inherit',
            color: 'var(--text)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('r14_routers_tile')}</span>
          <span
            data-testid="metric-routers-value"
            style={getMetricValueStyle(routersValue)}
          >
            {routersValue}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            {tileSubtitle(!routersKnown, t('r14_routers_tile_sub'))}
          </span>
        </button>

        {/* Tile 2: Models */}
        <button
          data-testid="metric-tile"
          onClick={() => onNavigate('models')}
          className="lift"
          style={{
            boxSizing: 'border-box',
            background: 'var(--card)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh)',
            textAlign: 'left',
            border: 0,
            font: 'inherit',
            color: 'var(--text)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('d_t2')}</span>
          <span
            data-testid="metric-models-value"
            style={getMetricValueStyle(modelsValue)}
          >
            {modelsValue}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <Glyph type="new" />
            <span>{tileSubtitle(modelsValue === '—')}</span>
          </span>
        </button>

        {/* Tile 3: Requests */}
        <button
          data-testid="metric-tile"
          onClick={() => onNavigate('health')}
          className="lift"
          style={{
            boxSizing: 'border-box',
            background: 'var(--card)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh)',
            textAlign: 'left',
            border: 0,
            font: 'inherit',
            color: 'var(--text)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('d_t3')}</span>
          <span
            data-testid="metric-requests-value"
            style={getMetricValueStyle(requestsValue)}
          >
            {requestsValue}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <Glyph type="ok" />
            <span>{tileSubtitle(requestsValue === '—')}</span>
          </span>
        </button>

        {/* Tile 4: Last check */}
        <button
          data-testid="metric-tile"
          onClick={() => onNavigate('health')}
          className="lift"
          style={{
            boxSizing: 'border-box',
            background: 'var(--card)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh)',
            textAlign: 'left',
            border: 0,
            font: 'inherit',
            color: 'var(--text)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>
                  {/* R18-3: this tile reports `lastCheck.code` (daemon_running /
                      router_disconnected). Labelled "last check" it read as
                      "the last check is fine"; the label now says it is the
                      daemon's own state, and the banner speaks about routers. */}
                  {t('r18_lastcheck_label')}
                </span>
          <span
            data-testid="metric-lastcheck-value"
            style={getMetricValueStyle(lastCheckValue)}
          >
            {lastCheckValue}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <Glyph type="ok" />
            <span>{tileSubtitle(lastCheckValue === '—')}</span>
          </span>
        </button>
      </div>

      {/* Grid 2 cột: Việc cần bạn làm + RouterSync vừa làm gì */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* Việc cần bạn làm */}
        <Card id="todo-t" title={t('d_todo')}>
          <div style={{ marginTop: '-10px' }}>
            {(overview.todoItems ?? []).length === 0 ? (
              <span style={{ fontSize: '14px', color: 'var(--muted)' }}>{t('r14_overview_no_todo')}</span>
            ) : (
              (overview.todoItems ?? []).map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px 16px',
                    alignItems: 'center',
                    padding: '14px 0',
                    borderTop: '1.5px dashed var(--line)',
                  }}
                >
                  <span
                    style={{
                      flex: '1 1 300px',
                      display: 'flex',
                      gap: '10px',
                      alignItems: 'baseline',
                      minWidth: 0,
                    }}
                  >
                    <Glyph
                      type={
                        item.type === 'amber'
                          ? 'warn'
                          : item.type === 'cross'
                          ? 'bad'
                          : item.type === 'diamond'
                          ? 'new'
                          : 'unk'
                      }
                    />
                    <span style={{ fontSize: '14px', color: 'var(--text)' }}>
                      {item.code ? t(item.code, item.params) : item.text}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => onNavigate(item.targetSection as ScreenId)}
                  >
                    {t(item.actionKey)}
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* RouterSync vừa làm gì */}
        <Card id="ev-t" title={t('d_ev')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {(overview.recentEvents ?? []).length === 0 ? (
              <span style={{ fontSize: '14px', color: 'var(--muted)' }}>{t('r14_overview_no_events')}</span>
            ) : (
              (overview.recentEvents ?? []).map((e) => (
                <div key={e.id} style={{ display: 'flex', gap: '12px', alignItems: 'baseline' }}>
                  <span className="m" style={{ flex: '0 0 72px', fontSize: '12px', color: 'var(--muted)' }}>
                    {e.timeAgoKey ? t(e.timeAgoKey) : e.timeAgo}
                  </span>
                  <Glyph type={e.type === 'amber' ? 'warn' : e.type === 'diamond' ? 'new' : 'ok'} />
                  <span style={{ flexGrow: 1, fontSize: '14px', color: 'var(--text)' }}>
                    {e.code ? (
                      t(e.code, e.params)
                    ) : (
                      <>
                        {e.textPrefix}
                        {e.highlightText && (
                          <span className="m" style={{ fontWeight: 700 }}>
                            {e.highlightText}
                          </span>
                        )}
                        {e.textSuffix}
                      </>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* RouterSync hoạt động thế nào (5 bước) */}
      <Card id="how-t" title={t('d_how')}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))',
            gap: '14px',
          }}
        >
          {[
            {
              num: 1,
              tone: 'blue',
              title: t('d_h1'),
              desc: t('d_h1d'),
              count: howStepCounts[1] ?? '—',
              gate: false,
              noStub: false,
            },
            {
              num: 2,
              tone: 'vio',
              title: t('d_h2'),
              desc: t('d_h2d'),
              count: howStepCounts[2] ?? '—',
              gate: false,
              noStub: false,
            },
            {
              num: 3,
              tone: 'grn',
              title: t('d_h3'),
              desc: t('d_h3d'),
              count: howStepCounts[3] ?? '—',
              gate: false,
              noStub: false,
            },
            {
              num: 4,
              tone: 'yel',
              title: t('d_h4'),
              desc: t('d_h4d'),
              count: howStepCounts[4] ?? '—',
              // R16-2.6: the yellow "waiting for you" frame only when there
              // really is something to approve.
              gate: hasPending,
              noStub: false,
            },
            {
              num: 5,
              tone: 'grn',
              title: t('d_h5'),
              desc: t('d_h5d'),
              count: howStepCounts[5] ?? '—',
              gate: false,
              noStub: true,
            },
          ].map((st) => {
            const toneBgFg: Record<string, [string, string]> = {
              blue: ['var(--blue-t)', 'var(--blue-i)'],
              vio: ['var(--vio-t)', 'var(--vio-i)'],
              grn: ['var(--grn-t)', 'var(--grn-i)'],
              yel: ['var(--yel)', 'var(--yel-i)'],
            };
            const [bg, fg] = toneBgFg[st.tone] || ['var(--fill)', 'var(--text)'];

            return (
              <div
                key={st.num}
                data-testid={`how-step-${st.num}`}
                style={{
                  position: 'relative',
                  boxSizing: 'border-box',
                  background: st.gate ? 'var(--yel-t)' : 'var(--card)',
                  border: st.gate ? '2px solid var(--yel)' : 'none',
                  boxShadow: st.gate ? 'none' : 'var(--sh)',
                  borderRadius: '22px',
                  padding: '18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  minWidth: 0,
                }}
              >
                {!st.noStub && (
                  <div
                    aria-hidden="true"
                    className="stub"
                    style={{
                      position: 'absolute',
                      right: '-14px',
                      top: '50%',
                      width: '14px',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ flexGrow: 1, borderTop: '2px dashed var(--conn)' }} />
                    <div
                      style={{
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        background: 'var(--blue)',
                        marginLeft: '-3px',
                      }}
                    />
                  </div>
                )}
                <span
                  className="m"
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: bg,
                    color: st.gate ? '#14131F' : fg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    fontWeight: 700,
                  }}
                >
                  {st.num}
                </span>
                <div style={{ fontWeight: 800 }}>{st.title}</div>
                <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{st.desc}</div>
                <div
                  data-testid={`how-step-count-${st.num}`}
                  style={{ fontWeight: 700, fontSize: '14px', marginTop: 'auto', paddingTop: '4px' }}
                >
                  {st.count}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Đường ống kỹ thuật (8 module) - chỉ hiển thị ở chế độ Chi tiết */}
      {isDetail && (
        <Card id="pipe-t" title={t('d_pipe')}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))',
              gap: '12px',
            }}
          >
            {pipelineModules.map((mod, idx) => (
              <div
                key={mod.id}
                data-testid={`pipeline-module-${mod.id}`}
                aria-label={mod.isDashed ? `Module ${idx + 1}: ${t(mod.titleKey)} - ${t('ui0_module_unverified')}` : undefined}
                style={{
                  boxSizing: 'border-box',
                  background: 'var(--fill)',
                  borderRadius: '18px',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  border: mod.isDashed ? '1.5px dashed var(--dash)' : '1px solid transparent',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '12px',
                    fontWeight: 700,
                    color: 'var(--muted)',
                  }}
                >
                  <span className="m">{`0${idx + 1}`}</span>
                  <span>{t(mod.titleKey)}</span>
                </div>
                <div style={{ fontSize: '26px', fontWeight: 800 }}>{mod.count ?? '—'}</div>
                <div
                  style={{
                    display: 'flex',
                    gap: '6px',
                    alignItems: 'baseline',
                    fontSize: '12px',
                    color: 'var(--muted)',
                  }}
                >
                  <Glyph type={mod.status === 'ok' ? 'ok' : mod.status === 'amber' ? 'warn' : 'unk'} />
                  <span>
                    {t(mod.descKey)}
                    {mod.isDashed && (
                      <span
                        className="m"
                        style={{
                          marginLeft: '6px',
                          padding: '1px 6px',
                          borderRadius: '999px',
                          background: 'var(--well)',
                          fontSize: '11px',
                          color: 'var(--muted)',
                          border: '1px solid var(--line)',
                        }}
                      >
                        {t('ui0_module_unverified')}
                      </span>
                    )}
                  </span>
                </div>
                {/* R16-2.7: the age line exists only when the view-model carries
                    an age. With no age measured the line shows the unmeasured
                    mark instead of a made-up "just now". */}
                <div style={{ fontSize: '11px', color: 'var(--faint)', marginTop: '4px' }}>
                  {formatAge(mod.ageSeconds) !== undefined
                    ? t('ui0_module_age', { age: formatAge(mod.ageSeconds) as string })
                    : '—'}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('d_pipe_n')}</div>
        </Card>
      )}

      {/* Cách đọc màu và ký hiệu */}
      <Card id="leg-t" title={t('d_leg')}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))',
            gap: '10px 16px',
          }}
        >
          {[
            { glyph: 'ok' as GlyphType, text: t('l1') },
            { glyph: 'new' as GlyphType, text: t('l2') },
            { glyph: 'warn' as GlyphType, text: t('l3') },
            { glyph: 'bad' as GlyphType, text: t('l4') },
            { glyph: 'unk' as GlyphType, text: t('l5') },
          ].map((item, idx) => (
            <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px' }}>
              <Glyph type={item.glyph} />
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};
