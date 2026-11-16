import React, { useEffect, useState } from 'react';
import { t, hasTranslation } from '../i18n';
import { Card, Note, WarnNote } from '../components/Card';
import { Button } from '../components/Button';
import { Glyph, Tag } from '../components/Badge';
import { ScreenId } from '../components/Sidebar';
import { useApi, PlanViewModel, SnapshotViewModel } from '../api';

interface ChangesScreenProps {
  onNavigate: (screen: ScreenId) => void;
  isMock?: boolean;
  plan?: PlanViewModel | undefined;
  snapshots?: SnapshotViewModel[] | undefined;
}

/**
 * R14 (DECISIONS 2026-10-17-12 item 6): the screen renders the plan
 * view-model only. The prototype sample content lives in
 * packages/ui/src/api/mock.ts.
 */
const RISK_KEY: Record<'low' | 'medium' | 'high', string> = {
  low: 'risk_low',
  medium: 'risk_mid',
  high: 'risk_high',
};

export const ChangesScreen: React.FC<ChangesScreenProps> = ({
  onNavigate,
  isMock = true,
  plan: planProp,
  snapshots: snapshotsProp,
}) => {
  const api = useApi();
  const [plan, setPlan] = useState<PlanViewModel | undefined>(planProp);
  const [snapshots, setSnapshots] = useState<SnapshotViewModel[]>(snapshotsProp ?? []);
  const [activeTab, setActiveTab] = useState<'pending' | 'history'>('pending');
  const [decisionState, setDecisionState] = useState<'none' | 'approved' | 'rejected'>('none');
  const [rollbackSnapshot, setRollbackSnapshot] = useState<{ id: string; target: string; when: string; size: string } | null>(null);
  const [rollbackConfirmed, setRollbackConfirmed] = useState(false);
  const [rollbackDone, setRollbackDone] = useState(false);
  const [showTerminalModal, setShowTerminalModal] = useState(false);

  useEffect(() => {
    if (planProp !== undefined) {
      setPlan(planProp);
      return;
    }
    let active = true;
    api
      .getPendingPlan()
      .then((data) => {
        if (active) setPlan(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [planProp, api]);

  useEffect(() => {
    if (snapshotsProp !== undefined) {
      setSnapshots(snapshotsProp);
      return;
    }
    let active = true;
    api
      .getSnapshots()
      .then((data) => {
        if (active) setSnapshots(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [snapshotsProp, api]);

  const actions = plan?.actions ?? [];
  const hasPlan = actions.length > 0;
  // R16-3: the age of the plan is painted only when the view-model carries a
  // translation key. A plain sentence is not a key, so no age is invented.
  const planAgeText = plan?.computedTimeAgoKey
    ? t(plan.computedTimeAgoKey)
    : plan?.computedTimeAgo && hasTranslation(plan.computedTimeAgo)
      ? t(plan.computedTimeAgo)
      : '';

  const handleApprove = () => {
    setDecisionState('approved');
  };

  const handleReject = () => {
    setDecisionState('rejected');
  };

  // R16-3: the tiles show a number only when a REAL plan exists. The S1
  // daemon answers "unavailable" for the pending plan, so every tile stays
  // on "—" instead of painting a fake 0%.
  const summaryTiles = [
    { label: t('c_s1'), val: hasPlan ? `${plan?.impactPercent ?? 0}%` : '—', desc: t('c_s1d'), glyph: 'ok' as const },
    { label: t('c_s2'), val: hasPlan ? `${plan?.billableRequestsCount ?? 0}` : '—', desc: t('c_s2d'), glyph: 'ok' as const },
    { label: t('c_s3'), val: hasPlan ? (plan?.targetsSummary ? t(plan.targetsSummary) : '—') : '—', desc: '', glyph: 'new' as const },
    {
      label: t('c_s4'),
      val: hasPlan ? (plan?.hasRollbackBackup ? t('c_s4b') : t('m_v0')) : '—',
      desc: t('c_s4d'),
      glyph: 'ok' as const,
    },
    {
      label: t('c_s5'),
      val: hasPlan ? (plan?.sourceSummary ?? '—') : '—',
      desc: hasPlan && plan?.sourceDetail ? t(plan.sourceDetail) : '',
      glyph: 'new' as const,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      {/* Header */}
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 'clamp(26px, 3vw, 36px)',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: 'var(--text)',
          }}
        >
          {t('c_h')}
        </h1>
        <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: '16px', maxWidth: '720px' }}>
          {t('c_sub')}
        </p>
      </div>

      {/* R14: sample content is flagged, never passed off as real router data. */}
      {plan?.meta?.source === 'sample' && (
        <div
          data-testid="sample-badge"
          style={{
            alignSelf: 'flex-start',
            background: 'var(--yel-t)',
            color: 'var(--yel-i)',
            border: '1px solid var(--yel)',
            borderRadius: '14px',
            padding: '8px 14px',
            fontSize: '13px',
            fontWeight: 600,
          }}
        >
          <b>{t('r14_sample_badge')}</b> — {t('r14_sample_badge_desc')}
        </div>
      )}

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('c_tabs')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          background: 'var(--fill)',
          borderRadius: '999px',
          padding: '4px',
          alignSelf: 'flex-start',
        }}
      >
        <button
          role="tab"
          aria-selected={activeTab === 'pending'}
          onClick={() => {
            setActiveTab('pending');
            if (typeof window !== 'undefined') {
              window.location.hash = window.location.hash.includes('tab=p')
                ? window.location.hash.replace('tab=p', 'tab=p2')
                : (window.location.hash.includes('?') ? window.location.hash + '&tab=p' : window.location.hash + '?tab=p');
            }
          }}
          className="btn"
          style={{
            font: 'inherit',
            fontWeight: 700,
            fontSize: '14px',
            minHeight: '44px',
            padding: '0 20px',
            border: 0,
            borderRadius: '999px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: activeTab === 'pending' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'pending' ? 'var(--on-ink)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {t('c_tab1')}
          <span
            className="m"
            style={{
              minWidth: '20px',
              height: '20px',
              borderRadius: '10px',
              background: 'var(--yel)',
              color: '#14131F',
              fontSize: '11px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
              fontWeight: 700,
            }}
          >
            {hasPlan ? 1 : 0}
          </span>
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'history'}
          onClick={() => {
            setActiveTab('history');
            if (typeof window !== 'undefined') {
              window.location.hash = window.location.hash.includes('tab=h')
                ? window.location.hash.replace('tab=h', 'tab=h2')
                : (window.location.hash.includes('?') ? window.location.hash + '&tab=h' : window.location.hash + '?tab=h');
            }
          }}
          className="btn"
          style={{
            font: 'inherit',
            fontWeight: 700,
            fontSize: '14px',
            minHeight: '44px',
            padding: '0 20px',
            border: 0,
            borderRadius: '999px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: activeTab === 'history' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'history' ? 'var(--on-ink)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {t('c_tab2')}
        </button>
      </div>

      {/* Tab Panel: Pending */}
      {activeTab === 'pending' && (
        <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* Gate Section */}
          <section
            aria-labelledby="gt"
            style={{
              boxSizing: 'border-box',
              background: 'linear-gradient(135deg, var(--yel-t), var(--yel-t2))',
              border: '2px solid var(--yel)',
              borderRadius: '24px',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px 16px',
                alignItems: 'baseline',
                justifyContent: 'space-between',
              }}
            >
              <h2 id="gt" style={{ margin: 0, fontSize: '22px', fontWeight: 800 }}>
                {hasPlan ? t('c_gt_live', { code: plan?.proposalCode ?? '', count: actions.length }) : t('c_gt_empty')}
              </h2>
              {hasPlan && planAgeText && (
                <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{planAgeText}</span>
              )}
            </div>

            {/* Summary 5 tiles */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
                gap: '12px',
              }}
            >
              {summaryTiles.map((item, idx) => (
                <div
                  key={idx}
                  data-testid="summary-tile"
                  style={{
                    background: 'var(--card)',
                    borderRadius: '18px',
                    padding: '14px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}
                >
                  <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted)' }}>
                    {item.label}
                  </span>
                  <span style={{ fontSize: '28px', fontWeight: 800, lineHeight: 1.15 }}>
                    {item.val}
                  </span>
                  {item.desc && (
                    <span
                      style={{
                        display: 'flex',
                        gap: '6px',
                        alignItems: 'baseline',
                        fontSize: '12px',
                        color: 'var(--muted)',
                      }}
                    >
                      <Glyph type={item.glyph} />
                      <span>{item.desc}</span>
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Action Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {actions.length === 0 ? (
                <div style={{ fontSize: '14px', color: 'var(--muted)' }} data-testid="changes-empty">
                  {t('r14_changes_empty')}
                </div>
              ) : (
                actions.map((act, idx) => (
                  <div
                    key={act.id}
                    style={{
                      background: 'var(--card)',
                      borderRadius: '20px',
                      boxShadow: 'var(--sh2)',
                      padding: '18px 20px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '10px 18px',
                      alignItems: 'flex-start',
                    }}
                    data-testid={`change-action-${act.id}`}
                  >
                    <span
                      className="m"
                      style={{
                        flex: '0 0 32px',
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        background: 'var(--blue-t)',
                        color: 'var(--blue-i)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '13px',
                        fontWeight: 700,
                      }}
                    >
                      {idx + 1}
                    </span>

                    <div style={{ flex: '1 1 360px', minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '16px' }}>
                        {t(act.titleKey)}
                        <span className="m" style={{ fontWeight: 600 }}>{act.modelId}</span>
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: '14px', marginTop: '2px' }}>
                        {t(act.description)}
                      </div>
                      <div style={{ fontSize: '13px', marginTop: '6px' }}>
                        {t(act.appliesTo)}
                      </div>
                      {act.evidenceSnippet && (
                        <div style={{ fontSize: '13px', marginTop: '6px', color: 'var(--muted)' }}>
                          {t(act.evidenceSnippet)}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                      <Tag kind={act.risk === 'low' ? 'free' : act.risk === 'medium' ? 'amber' : 'bad'}>
                        {t(RISK_KEY[act.risk])}
                      </Tag>
                      {act.source === 'agent' ? (
                        <Tag kind="vio">{t(act.agentName ?? 'c_src_ag')}</Tag>
                      ) : (
                        <Tag kind="neutral">{t('c_src_au')}</Tag>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Advanced Hash & Order Note */}
            <div
              className="m"
              style={{
                fontSize: '12px',
                color: 'var(--muted)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              {hasPlan && (
                <>
                  <span>{t('c_hash')}</span>
                  <span>
                    {plan?.proposalCode} · {plan?.planHash}
                  </span>
                </>
              )}
              <span>{t('c_ord')}</span>
            </div>

            {/* Decision Buttons */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
              <Button variant="ink" onClick={handleApprove}>
                {t('c_btn1')}
              </Button>
              <Button variant="secondary" onClick={handleReject}>
                {t('c_btn2')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setShowTerminalModal(true)}
              >
                {t('cli_run_terminal')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => onNavigate('combos')}
                style={{ borderColor: 'var(--dash)' }}
              >
                {t('c_btn3')}
              </Button>
            </div>

            {/* Human approval disclaimer */}
            <div style={{ fontSize: '13px', color: 'var(--muted)' }}>
              {t('c_ai')}
            </div>

            {/* Decision feedback note */}
            {decisionState === 'approved' && (
              <Note>
                <b>{t('c_ok')}</b> {t('c_ok2')}
              </Note>
            )}
            {decisionState === 'rejected' && (
              <WarnNote>
                <b>{t('c_rej')}</b> {t('c_rej2')}
              </WarnNote>
            )}
          </section>

          {/* Agent Box */}
          <Card id="ag-t" title={t('c_ag')}>
            <div style={{ color: 'var(--muted)', fontSize: '13px' }}>
              {hasPlan ? t('c_agd') : t('c_agd_empty')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[t('c_ag1'), t('c_ag2'), t('c_ag3'), t('c_ag4')].map((bullet, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                  <Glyph type="ok" />
                  <span>{bullet}</span>
                </div>
              ))}
            </div>
            <div
              className="m"
              style={{
                fontSize: '12px',
                color: 'var(--muted)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              {hasPlan && <span>{t('c_agj')}</span>}
              <span>{t('c_agj2')}</span>
            </div>
          </Card>

          {/* Terminal CLI Card — Chạy trong terminal, Sao chép lệnh */}
          <Card id="cli-t" title={t('cli_run_terminal')}>
            <div style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '10px' }}>
              {t('cli_card_desc')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <code className="m" style={{ background: 'var(--fill)', padding: '8px 14px', borderRadius: '8px', fontSize: '13px' }}>
                routersync apply --write
              </code>
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText('routersync apply --write');
                }}
              >
                {t('cli_copy_cmd')}
              </Button>
            </div>
          </Card>

          {/* Grid Excluded and Impact */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))',
              gap: '20px',
              alignItems: 'start',
            }}
          >
            {/* Excluded Box */}
            <Card id="ex-t" title={t('c_ex')}>
              <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_exd')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {plan && (plan.deliberateExclusions ?? []).length > 0 ? (
                  plan.deliberateExclusions.map((exclusion, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="warn" />
                      <span>{t(exclusion)}</span>
                    </div>
                  ))
                ) : (
                  <span style={{ color: 'var(--muted)', fontSize: '13px' }}>—</span>
                )}
              </div>
            </Card>

            {/* Impact Box */}
            <Card id="im-t" title={t('c_im')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[t('c_i1'), t('c_i2'), t('c_i3'), t('c_i4')].map((bullet, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                    <Glyph type="ok" />
                    <span>{bullet}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Risk Legend */}
          <Card id="rk-t" title={t('c_rk')}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
                gap: '12px',
                alignItems: 'start',
              }}
            >
              <div
                style={{
                  boxSizing: 'border-box',
                  background: 'var(--fill)',
                  borderRadius: '18px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div><Tag kind="free">{t('risk_low')}</Tag></div>
                <span style={{ fontSize: '14px' }}>{t('c_rk1')}</span>
              </div>

              <div
                style={{
                  boxSizing: 'border-box',
                  background: 'var(--fill)',
                  borderRadius: '18px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div><Tag kind="amber">{t('risk_mid')}</Tag></div>
                <span style={{ fontSize: '14px' }}>{t('c_rk2')}</span>
              </div>

              <div
                style={{
                  boxSizing: 'border-box',
                  background: 'var(--fill)',
                  borderRadius: '18px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div><Tag kind="bad">{t('risk_high')}</Tag></div>
                <span style={{ fontSize: '14px' }}>{t('c_rk3')}</span>
              </div>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_rk4')}</div>
          </Card>

          {/* Diff Box */}
          <Card id="df-t" title={t('c_df')}>
            <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_dfd')}</div>
            {plan?.unifiedDiff ? (
              <pre
                className="m"
                data-testid="plan-diff"
                style={{
                  margin: 0,
                  padding: '14px 16px',
                  borderRadius: '16px',
                  border: '1.5px solid var(--line)',
                  background: 'var(--well)',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                }}
              >
                {plan.unifiedDiff}
              </pre>
            ) : (
              <div style={{ fontSize: '14px', color: 'var(--muted)' }} data-testid="changes-empty">
                {t('r14_changes_empty')}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Tab Panel: History */}
      {activeTab === 'history' && (
        <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* Timeline Card */}
          <Card id="tl-t" title={t('c_tl')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {snapshots.length === 0 ? (
                <div style={{ fontSize: '14px', color: 'var(--muted)' }} data-testid="changes-empty">
                  {t('r14_changes_empty')}
                </div>
              ) : (
                snapshots.map((snap) => (
                  <div
                    key={snap.id}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px 14px',
                      alignItems: 'baseline',
                    }}
                  >
                    <Glyph type="ok" />
                    <span className="m" style={{ fontSize: '12px', color: 'var(--muted)', flex: '0 0 120px' }}>
                      {t(snap.timeAgo)}
                    </span>
                    <span className="m" style={{ fontSize: '13px', fontWeight: 600, flex: '0 0 52px' }}>
                      {snap.id}
                    </span>
                    <span style={{ flex: '1 1 280px' }}>{t(snap.summary)}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t(snap.approvedBy)}</span>
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Grid Backups & Breaker */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))',
              gap: '20px',
              alignItems: 'start',
            }}
          >
            {/* Backups & Undo */}
            <Card id="bk-t" title={t('c_bk')}>
              <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_bkd')}</div>
              {snapshots.length === 0 ? (
                <div style={{ fontSize: '14px', color: 'var(--muted)' }} data-testid="changes-empty">
                  {t('r14_changes_empty')}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '14px' }}>
                    <thead>
                      <tr>
                        <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                          {t('c_bh1')}
                        </th>
                        <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                          {t('c_bh2')}
                        </th>
                        <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                          {t('c_bh3')}
                        </th>
                        <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                          {t('c_bh4')}
                        </th>
                        <th scope="col" style={{ textAlign: 'right', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 0', borderBottom: '1.5px solid var(--line)' }}>
                          &nbsp;
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshots.map((snap) => (
                        <tr key={snap.id}>
                          <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                            <span className="m">{snap.id}</span>
                          </td>
                          <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                            {snap.target}
                          </td>
                          <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                            {t(snap.timeAgo)}
                          </td>
                          <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                            {snap.size}
                          </td>
                          <td style={{ padding: '12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top', textAlign: 'right' }}>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                setRollbackSnapshot({
                                  id: snap.id,
                                  target: snap.target,
                                  when: t(snap.timeAgo),
                                  size: snap.size,
                                })
                              }
                              style={{ minHeight: '36px', padding: '0 12px', fontSize: '13px' }}
                            >
                              {t('c_undo')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_bkn')}</div>
            </Card>

            {/* Safety Breaker */}
            <Card id="cb-t" title={t('c_cb')}>
              {/* R19-1 (AT-155): this card used to print a breaker state and
                  counters that nothing measured ("state: closed · consecutive
                  failures: 0/3 · max_change_ratio: 12%/50%") and a "Normal.
                  RouterSync is allowed to write." line with a check glyph. The
                  S1 view-model carries no breaker state, so the card explains
                  the rule and states that the state was not measured. */}
              <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('c_cb2')}</div>
              <div className="m" style={{ fontSize: '12px', color: 'var(--muted)' }}>
                {t('r19_cb_state_unknown')}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Rollback Preview Modal (spec 34.3 dry-run) */}
      {rollbackSnapshot && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              background: 'var(--card)',
              borderRadius: '24px',
              padding: '28px',
              maxWidth: '540px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: 'var(--sh)',
              border: '1.5px solid var(--line)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>
              {t('ui0_rollback_preview_title')}
            </h3>
            <div style={{ fontSize: '14px', color: 'var(--muted)' }}>
              {t('ui0_rollback_dryrun_notice')}
            </div>
            <div
              style={{
                background: 'var(--fill)',
                borderRadius: '16px',
                padding: '14px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '13px',
              }}
            >
              <div><b>Snapshot:</b> <span className="m">{rollbackSnapshot.id}</span></div>
              <div><b>{t('c_bh2')}:</b> {rollbackSnapshot.target}</div>
              <div><b>{t('c_bh3')}:</b> {rollbackSnapshot.when}</div>
              <div><b>{t('c_bh4')}:</b> {rollbackSnapshot.size}</div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                fontSize: '13px',
                marginTop: '4px',
              }}
            >
              <input
                type="checkbox"
                data-testid="rollback-confirm-checkbox"
                checked={rollbackConfirmed}
                onChange={(e) => setRollbackConfirmed(e.target.checked)}
              />
              <span>{t('ui0_rollback_checkbox')}</span>
            </label>

            {!isMock && (
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--cor-ink)',
                  background: 'var(--cor-subtle, rgba(239, 68, 68, 0.1))',
                  padding: '8px 12px',
                  borderRadius: '8px',
                }}
              >
                {t('ui0_rollback_daemon_required')}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <Button
                variant="secondary"
                autoFocus
                onClick={() => {
                  setRollbackSnapshot(null);
                  setRollbackConfirmed(false);
                }}
              >
                {t('ui0_rollback_close')}
              </Button>
              <Button
                variant="ink"
                data-testid="rollback-confirm-btn"
                disabled={!isMock || !rollbackConfirmed}
                title={!isMock ? t('ui0_rollback_daemon_required') : undefined}
                onClick={() => {
                  setRollbackSnapshot(null);
                  setRollbackConfirmed(false);
                  setRollbackDone(true);
                }}
              >
                {t('ui0_rollback_confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal Modal Dialog */}
      {showTerminalModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="term-modal-title"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
          }}
        >
          <div
            style={{
              background: 'var(--card)',
              color: 'var(--text)',
              borderRadius: '20px',
              padding: '24px',
              maxWidth: '520px',
              width: '100%',
              boxShadow: 'var(--sh)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <h2 id="term-modal-title" style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>
              {t('cli_run_terminal')}
            </h2>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '14px', lineHeight: 1.5 }}>
              {t('cli_modal_desc')}
            </p>
            <div
              style={{
                background: 'var(--fill)',
                padding: '12px 16px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
              }}
            >
              <code className="m" style={{ fontSize: '13px', fontWeight: 600 }}>
                routersync apply --write
              </code>
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button
                variant="ink"
                onClick={() => {
                  void navigator.clipboard?.writeText('routersync apply --write');
                }}
              >
                {t('cli_copy_cmd')}
              </Button>
              <Button variant="secondary" onClick={() => setShowTerminalModal(false)}>
                {t('b_c')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback Success Note */}
      {rollbackDone && (
        <Note>
          <b>{t('c_ok')}</b> {t('c_ok2')}
        </Note>
      )}
    </div>
  );
};
