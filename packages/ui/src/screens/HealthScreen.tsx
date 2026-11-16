import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../api';
import type {
  DoctorConditionViewModel,
  DoctorReportViewModel,
  HealthSummaryViewModel,
  ModelViewModel,
} from '../api/types';

interface HealthScreenProps {
  viewMode?: 'simple' | 'detail';
  health?: HealthSummaryViewModel;
  doctor?: DoctorReportViewModel;
  models?: ModelViewModel[];
}

/**
 * R14: a screen is a pure function of its view-model. Every number, badge and
 * label below comes from the VM. A value the VM does not carry renders as "—";
 * the screen never guesses, never reuses prototype sample data.
 */
const DASH = '—';

const numOrDash = (value: number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : DASH;

const usdOrDash = (value: number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : DASH;

export const HealthScreen: React.FC<HealthScreenProps> = ({
  viewMode = 'simple',
  health: healthProp,
  doctor: doctorProp,
  models: modelsProp,
}) => {
  const { t } = useI18n();
  const api = useApi();

  const [loadedHealth, setLoadedHealth] = useState<HealthSummaryViewModel | undefined>(undefined);
  const [loadedDoctor, setLoadedDoctor] = useState<DoctorReportViewModel | undefined>(undefined);
  const [loadedModels, setLoadedModels] = useState<ModelViewModel[] | undefined>(undefined);

  // Props win; a missing prop falls back to the API client.
  useEffect(() => {
    if (healthProp) return;
    let alive = true;
    api
      .getHealthSummary()
      .then((h) => {
        if (alive) setLoadedHealth(h);
      })
      .catch(() => {
        if (alive) setLoadedHealth(undefined);
      });
    return () => {
      alive = false;
    };
  }, [api, healthProp]);

  useEffect(() => {
    if (doctorProp) return;
    let alive = true;
    api
      .getDoctor()
      .then((d) => {
        if (alive) setLoadedDoctor(d);
      })
      .catch(() => {
        if (alive) setLoadedDoctor(undefined);
      });
    return () => {
      alive = false;
    };
  }, [api, doctorProp]);

  useEffect(() => {
    if (modelsProp) return;
    let alive = true;
    api
      .getModels()
      .then((m) => {
        if (alive) setLoadedModels(m);
      })
      .catch(() => {
        if (alive) setLoadedModels([]);
      });
    return () => {
      alive = false;
    };
  }, [api, modelsProp]);

  const health = healthProp ?? loadedHealth;
  const models = modelsProp ?? loadedModels;

  const [runningDoctor, setRunningDoctor] = useState(false);
  const [doctorNotice, setDoctorNotice] = useState<string | null>(null);
  // The report of the last "Run doctor" click wins over the loaded one.
  const [doctorResult, setDoctorResult] = useState<DoctorReportViewModel | undefined>(undefined);

  const doctor = doctorResult ?? doctorProp ?? loadedDoctor;
  const conditions: DoctorConditionViewModel[] = doctor?.conditions ?? health?.doctorConditions ?? [];

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    setDoctorNotice(t('ui0_doctor_running'));
    try {
      const report = await api.getDoctor();
      setDoctorResult(report);
      if (report.conditions.length === 0) {
        // R19-1 (AT-155): "0 pass · 0 fail" reads like a clean bill of
        // health even when the doctor had nothing to check. Say that instead
        // of counting checks that never ran.
        setDoctorNotice(t('r19_doctor_nothing_checked'));
      } else {
        const pass = report.conditions.filter((c) => c.state === 'pass').length;
        const fail = report.conditions.filter((c) => c.state === 'fail').length;
        const notChecked = report.conditions.filter((c) => c.state === 'not_checked').length;
        setDoctorNotice(t('r14_doctor_summary', { pass, fail, notChecked }));
      }
    } catch {
      setDoctorNotice(t('unavailable'));
    } finally {
      setRunningDoctor(false);
    }
  };

  // --- Doctor state badge -------------------------------------------------
  const doctorStateLabel = (cond: DoctorConditionViewModel): string => {
    const codeLabel = cond.code ? t(cond.code) : '';
    // `t()` returns the key itself when the key has no translation.
    const hasCodeLabel = Boolean(cond.code) && codeLabel !== cond.code;
    if (hasCodeLabel) return codeLabel;
    if (cond.state === 'pass') return t('ui0_doctor_state_pass');
    if (cond.state === 'fail') return t('ui0_doctor_state_fail');
    return t('ui0_doctor_state_not_checked');
  };

  const doctorStateStyle = (cond: DoctorConditionViewModel): React.CSSProperties => {
    if (cond.state === 'fail') {
      return { background: 'var(--cor-t)', color: 'var(--cor-i)' };
    }
    if (cond.state === 'not_checked') {
      return {
        border: '1.5px dashed var(--dash)',
        background: 'var(--fill)',
        color: 'var(--muted)',
      };
    }
    return { background: 'var(--grn-t)', color: 'var(--grn-i)' };
  };

  const doctorStateGlyph = (state: DoctorConditionViewModel['state']): string => {
    if (state === 'pass') return '● ';
    if (state === 'fail') return '▲ ';
    return '◌ ';
  };

  // --- Metrics ------------------------------------------------------------
  const healthyModels = models?.filter((m) => m.status === 'healthy' || m.status === 'new').length ?? 0;
  const totalModels = models?.length ?? 0;

  const metricBillable = numOrDash(health?.billableRequestsToday);
  const metricCost = usdOrDash(health?.costTodayUsd);
  /**
   * R16-3.3: the metric is honest about "not measured".
   *
   * The S1 daemon cannot list models at all, so a missing OR empty model list
   * means "not measured" -> "—". Only a real list yields "healthy / total".
   */
  const metricModels =
    models && models.length > 0 ? `${healthyModels} / ${totalModels}` : DASH;
  const metricSafety = health?.safetyMode ?? DASH;

  /**
   * R16-3.3: the sub-line is built from the view-model only.
   *
   * One part per count the view-model actually carries. No count -> no part,
   * and no count at all -> no sub-line (never a sample string).
   */
  const healthSubParts: string[] = [];
  if (typeof health?.degradedModelsCount === 'number') {
    healthSubParts.push(t('h_sub_degraded', { count: health.degradedModelsCount }));
  }
  if (typeof health?.dueRemovalCount === 'number') {
    healthSubParts.push(t('h_sub_due_removal', { count: health.dueRemovalCount }));
  }
  if (typeof health?.pausedModelsCount === 'number') {
    healthSubParts.push(t('h_sub_paused', { count: health.pausedModelsCount }));
  }
  const healthSubLine = healthSubParts.join(' · ');

  // --- Budgets ------------------------------------------------------------
  const budgets: Array<{ labelKey: string; used?: number | undefined; max?: number | undefined; money: boolean }> = [
    { labelKey: 'h_b1', used: health?.hourlyRequestsUsed, max: health?.hourlyRequestsMax, money: false },
    { labelKey: 'h_b2', used: health?.lumenRequestsUsed, max: health?.lumenRequestsMax, money: false },
    { labelKey: 'h_b2b', used: health?.novaRequestsUsed, max: health?.novaRequestsMax, money: false },
    { labelKey: 'h_b3', used: health?.usdBudgetUsed, max: health?.usdBudgetMax, money: true },
  ];

  const budgetValue = (used: number | undefined, max: number | undefined, money: boolean): string => {
    const fmt = money ? usdOrDash : numOrDash;
    return `${fmt(used)} / ${fmt(max)}`;
  };

  const budgetRatio = (used: number | undefined, max: number | undefined): number | null => {
    if (typeof used !== 'number' || typeof max !== 'number' || !Number.isFinite(used) || !Number.isFinite(max)) {
      return null;
    }
    if (max <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((used / max) * 100)));
  };

  // --- Probe ladder -------------------------------------------------------
  const probeRows: Array<{ id: string | undefined; label: React.ReactNode; how: string; cost: React.ReactNode }> = [
    { id: undefined, label: t('h_pa'), how: t('h_pa1'), cost: <>● {t('h_no')}</> },
    { id: 'P-0', label: 'P-0', how: t('h_p0'), cost: <>● {t('h_no')}</> },
    { id: 'P-0b / P-0c', label: 'P-0b / P-0c', how: t('h_p0b'), cost: <>● {t('h_no')}</> },
    { id: 'P-0d', label: 'P-0d', how: t('h_p0d'), cost: <>? {t('h_maybe')}</> },
    { id: 'P-1', label: 'P-1', how: t('h_p1'), cost: <>▲ {t('h_yes')}</> },
  ];

  const probeState = (id: string | undefined) =>
    id ? health?.probeLadder?.find((p) => p.id === id)?.state : undefined;

  const renderProbeBadge = (id: string | undefined) => {
    const state = probeState(id);
    const testId = `probe-state-${id ?? 'default'}`;
    if (state === 'on') {
      return (
        <span
          data-testid={testId}
          style={{
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            background: 'var(--grn-t)',
            color: 'var(--grn-i)',
          }}
        >
          {t('h_on')}
        </span>
      );
    }
    if (state === 'off') {
      return (
        <span
          data-testid={testId}
          style={{
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            background: 'var(--fill)',
            color: 'var(--muted)',
          }}
        >
          {t('h_off')}
        </span>
      );
    }
    return (
      <span
        data-testid={testId}
        title={t('s1_not_measured')}
        style={{
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '11px',
          background: 'var(--fill)',
          color: 'var(--muted)',
          border: '1.5px dashed var(--dash)',
        }}
      >
        {DASH}
      </span>
    );
  };

  // --- Trust scorecard ----------------------------------------------------
  const scorecard = health?.trustScorecard;
  const scorecardItems: Array<{ labelKey: string; value: string }> = [
    { labelKey: 'h_tr1', value: scorecard?.scansMatching ?? DASH },
    { labelKey: 'h_tr2', value: numOrDash(scorecard?.wrongRemovals) },
    {
      labelKey: 'h_tr3',
      value: `${numOrDash(scorecard?.driftDetected)} / ${numOrDash(scorecard?.driftFixed)}`,
    },
    { labelKey: 'h_tr4', value: numOrDash(scorecard?.rollbacks) },
  ];

  const overallStatus = doctor?.overallStatus;
  const overallColor =
    overallStatus === 'healthy' ? 'var(--grn-i)' : overallStatus === 'warning' ? 'var(--yel-i)' : 'var(--cor-i)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="health-screen">
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 20px', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ maxWidth: '780px' }}>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            {t('h_h')}
          </h1>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('h_sub')}
          </p>
        </div>
        <div>
          <button
            type="button"
            data-testid="health-run-doctor-btn"
            onClick={handleRunDoctor}
            disabled={runningDoctor}
            className="btn"
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '14px',
              minHeight: '44px',
              padding: '0 20px',
              borderRadius: '999px',
              border: '1.5px solid var(--line)',
              cursor: 'pointer',
              background: 'transparent',
              color: 'var(--text)',
            }}
          >
            {runningDoctor ? t('ui0_doctor_running') : t('h_dr')}
          </button>
        </div>
      </div>

      {doctorNotice && (
        <div
          data-testid="doctor-notice"
          style={{
            background: 'var(--fill)',
            color: 'var(--text)',
            borderRadius: '14px',
            padding: '12px 18px',
            fontWeight: 600,
          }}
        >
          {doctorNotice}
        </div>
      )}

      {/* Top 4 Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))', gap: '16px' }}>
        {/* Metric 1 */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '24px', padding: '20px', boxShadow: 'var(--sh-card)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('h_t1')}</span>
          <span
            data-testid="health-metric-billable"
            style={{ fontSize: '36px', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em' }}
          >
            {metricBillable}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
            <span>{t('h_t1s')}</span>
          </span>
        </div>

        {/* Metric 2 */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '24px', padding: '20px', boxShadow: 'var(--sh-card)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('h_t2')}</span>
          <span
            data-testid="health-metric-cost"
            style={{ fontSize: '36px', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em' }}
          >
            {metricCost}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
            <span>{t('h_t2s')}</span>
          </span>
        </div>

        {/* Metric 3 */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '24px', padding: '20px', boxShadow: 'var(--sh-card)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('h_t3')}</span>
          <span
            data-testid="health-metric-models"
            style={{ fontSize: '36px', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em' }}
          >
            {metricModels}
          </span>
          {healthSubLine && (
            <span
              data-testid="health-metric-models-sub"
              style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}
            >
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--yel)' }}></span>
              <span>{healthSubLine}</span>
            </span>
          )}
        </div>

        {/* Metric 4 */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '24px', padding: '20px', boxShadow: 'var(--sh-card)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--muted)' }}>{t('h_t4')}</span>
          <span
            data-testid="health-metric-safety"
            style={{ fontSize: '36px', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.02em' }}
          >
            {metricSafety}
          </span>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '14px', color: 'var(--muted)' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
            <span>{t('h_t4s')}</span>
          </span>
        </div>
      </div>

      {/* Grid: 3 Budgets + Probe Ladder */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
        {/* Budgets */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_bu')}</h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('h_bud')}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {budgets.map((b) => {
              const ratio = budgetRatio(b.used, b.max);
              return (
                <div
                  key={b.labelKey}
                  data-testid={`budget-${b.labelKey}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                    <span style={{ color: 'var(--muted)' }}>{t(b.labelKey)}</span>
                    <span style={{ fontWeight: 700 }}>{budgetValue(b.used, b.max, b.money)}</span>
                  </div>
                  <div
                    style={{
                      height: '8px',
                      background: 'var(--fill)',
                      borderRadius: '999px',
                      overflow: 'hidden',
                      border: ratio === null ? '1.5px dashed var(--line)' : undefined,
                    }}
                  >
                    {ratio !== null && (
                      <div style={{ width: `${ratio}%`, height: '100%', background: 'var(--grn)' }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('h_bun')}
          </p>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('h_bua')}
          </p>
        </section>

        {/* Probe Ladder */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_pr')}</h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('h_prd')}</p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                  <th style={{ padding: '8px 10px' }}>{t('h_ph1')}</th>
                  <th style={{ padding: '8px 10px' }}>{t('h_ph2')}</th>
                  <th style={{ padding: '8px 10px' }}>{t('h_ph3')}</th>
                  <th style={{ padding: '8px 10px' }}>{t('h_ph4')}</th>
                </tr>
              </thead>
              <tbody>
                {probeRows.map((row) => (
                  <tr key={row.id ?? 'default'} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 700 }}>{row.label}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{row.how}</td>
                    <td style={{ padding: '8px 10px', color: 'var(--muted)' }}>{row.cost}</td>
                    <td style={{ padding: '8px 10px' }}>{renderProbeBadge(row.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '12px 14px', fontSize: '13px' }}>
            <b>{t('h_r12')}</b> {t('h_r12b')}
          </div>

          {viewMode === 'detail' && (
            <div style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
              {t('h_prv')}
            </div>
          )}
        </section>
      </div>

      {/* Grid: Per-model health + Lifecycle */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
        {/* Per-model health */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_hm')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {models && models.length > 0 ? (
              models.map((m) => (
                <div
                  key={m.id}
                  data-testid={`health-model-${m.id}`}
                  style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center' }}
                >
                  <span
                    style={{
                      flex: '0 0 140px',
                      fontWeight: 600,
                      fontSize: '13px',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {m.id}
                  </span>
                  {/* S1 has no health history: the sparkline can only say "unknown". */}
                  <div
                    role="img"
                    aria-label={t('h_hb_aria')}
                    style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '22px' }}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <div
                        key={i}
                        style={{
                          width: '6px',
                          height: '14px',
                          boxSizing: 'border-box',
                          borderRadius: '3px',
                          border: '1.5px dashed var(--dash)',
                        }}
                      />
                    ))}
                  </div>
                  <span
                    data-testid={`health-model-state-${m.id}`}
                    title={t('r14_health_unknown')}
                    aria-label={t('r14_health_unknown')}
                    style={{ flex: '1 1 200px', fontSize: '13px', color: 'var(--muted)' }}
                  >
                    {DASH}
                  </span>
                </div>
              ))
            ) : (
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('r14_health_no_models')}</span>
            )}
          </div>
        </section>

        {/* Model Lifecycle */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_lq')}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {[
              { id: 'h_l1', color: 'var(--fill)', fg: 'var(--text)' },
              { id: 'h_l2', color: 'var(--fill)', fg: 'var(--text)' },
              { id: 'h_l3', color: 'var(--fill)', fg: 'var(--text)' },
            ].map((s, i) => (
              <React.Fragment key={s.id}>
                <span style={{ background: s.color, color: s.fg, borderRadius: '999px', padding: '6px 14px', fontWeight: 600, fontSize: '13px' }}>
                  {t(s.id as any)}
                </span>
                <span aria-hidden="true" style={{ color: 'var(--faint)' }}>→</span>
              </React.Fragment>
            ))}
            <span style={{ background: 'var(--cor-t)', color: 'var(--cor-i)', borderRadius: '999px', padding: '6px 14px', fontWeight: 600, fontSize: '13px' }}>
              {t('h_l4')}
            </span>
          </div>

          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}>
            <li>{t('h_lq1')}</li>
            <li>{t('h_lq2')}</li>
            <li>{t('h_lq3')}</li>
            <li>{t('h_lq4')}</li>
          </ul>
        </section>
      </div>

      {/* Grid: Trust scorecard + Recent alerts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
        {/* Trust scorecard */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_tr')}</h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('h_trd')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            {scorecardItems.map((item) => (
              <div
                key={item.labelKey}
                data-testid={`scorecard-${item.labelKey}`}
                style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                <span style={{ fontSize: '12px', color: 'var(--muted)', fontWeight: 700 }}>{t(item.labelKey)}</span>
                <span style={{ fontSize: '28px', fontWeight: 800 }}>{item.value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Recent alerts */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('h_al')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {health?.recentAlerts && health.recentAlerts.length > 0 ? (
              health.recentAlerts.map((a) => (
                <div
                  key={a.id}
                  data-testid={`health-alert-${a.id}`}
                  style={{ display: 'flex', gap: '12px', alignItems: 'baseline', fontSize: '13px' }}
                >
                  <span style={{ flex: '0 0 90px', fontSize: '12px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                    {t(a.timeAgo)}
                  </span>
                  <span style={{ flexGrow: 1 }}>{t(a.text)}</span>
                </div>
              ))
            ) : (
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('r14_health_no_alerts')}</span>
            )}
          </div>
        </section>
      </div>

      {/* Doctor Machine Check Section (conditions come from the daemon) */}
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
        data-testid="doctor-section"
      >
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('h_dc')}</h2>
        <div data-testid="doctor-overall" style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, color: 'var(--muted)' }}>{t('r14_doctor_overall')}</span>
          <span style={{ fontWeight: 800, color: overallStatus ? overallColor : 'var(--muted)' }}>
            {/* R18-5.1: 'healthy' / 'warning' / 'error' are machine enums; a
                Vietnamese screen prints the translated label, and an absent
                value stays the unmeasured dash. */}
            {overallStatus ? t(`r18_overall_${overallStatus}`) : DASH}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
            <thead>
              <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '12px', fontWeight: 700 }}>
                <th style={{ padding: '12px 14px', width: '40px' }}>#</th>
                <th style={{ padding: '12px 14px' }}>{t('h_dh1')}</th>
                <th style={{ padding: '12px 14px' }}>{t('h_dh2')}</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((cond) => (
                <tr key={cond.id} data-testid={`doctor-row-${cond.id}`} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{cond.id}</td>
                  <td style={{ padding: '12px 14px' }}>{t(cond.condKey)}</td>
                  <td style={{ padding: '12px 14px' }}>
                    <span
                      data-testid={`doctor-state-${cond.id}`}
                      title={cond.state === 'not_checked' ? t('ui0_doctor_pending_p3a') : undefined}
                      style={{
                        padding: '3px 10px',
                        borderRadius: '999px',
                        fontSize: '12px',
                        fontWeight: 700,
                        cursor: cond.state === 'not_checked' ? 'help' : 'default',
                        ...doctorStateStyle(cond),
                      }}
                    >
                      {doctorStateGlyph(cond.state)}
                      {doctorStateLabel(cond)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
