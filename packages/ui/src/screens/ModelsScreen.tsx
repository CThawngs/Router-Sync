import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi, ModelViewModel, UnmatchedNameItem, UnknownTraitItem, TrackStatusResponse, TrackEventsResponse, MaintainPlanResponse } from '../api';
import type { ApiClient } from '../api/client';
import type { ResponseMeta } from '../api/types';

interface ModelsScreenProps {
  viewMode?: 'simple' | 'detail';
  models?: ModelViewModel[] | undefined;
  unmatchedNames?: UnmatchedNameItem[] | undefined;
  unknownTraits?: UnknownTraitItem[] | undefined;
  /** R17-0.3: injected client (a test can say "this is the live daemon"). */
  api?: ApiClient | undefined;
}

/**
 * R14 (DECISIONS 2026-10-17-12 item 6): a screen is a pure function of its
 * view-model. Nothing here invents a model name, a number or a status; the
 * prototype sample content lives in packages/ui/src/api/mock.ts only.
 */
const PRICE_KEY: Record<ModelViewModel['priceKind'], string> = {
  free_forever: 'pk_forever',
  free_tier: 'pk_tier',
  subscription: 'pk_sub',
  metered: 'pk_metered',
  unknown: 'pk_unknown',
};

/** A model needs a human decision: due for removal, paused, or unknown trait. */
const needsReview = (m: ModelViewModel): boolean =>
  m.status === 'due_removal' || m.status === 'paused' || m.hasVision === 'unknown';

export const ModelsScreen: React.FC<ModelsScreenProps> = ({
  viewMode = 'simple',
  models: modelsProp,
  unmatchedNames: unmatchedProp,
  unknownTraits: traitsProp,
  api: apiProp,
}) => {
  const { t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [models, setModels] = useState<ModelViewModel[]>([]);
  /** R17-0.3: false until the collection has actually been read. */
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [unmatchedNames, setUnmatchedNames] = useState<UnmatchedNameItem[]>([]);
  const [unknownTraits, setUnknownTraits] = useState<UnknownTraitItem[]>([]);
  const [activeTab, setActiveTab] = useState<'list' | 'sources' | 'review'>('list');
  const [filter, setFilter] = useState<'all' | 'free' | 'vision' | 'review'>('all');
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [actionDoneMsg, setActionDoneMsg] = useState<string | null>(null);
  const [trackStatus, setTrackStatus] = useState<TrackStatusResponse | null>(null);
  const [trackEvents, setTrackEvents] = useState<TrackEventsResponse | null>(null);
  const [maintainPlan, setMaintainPlan] = useState<MaintainPlanResponse | null>(null);

  useEffect(() => {
    let active = true;
    if (typeof api.getMaintainPlan === 'function') {
      api
        .getMaintainPlan()
        .then((data) => {
          if (active) setMaintainPlan(data);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    let active = true;
    if (typeof api.getTrackStatus === 'function') {
      api
        .getTrackStatus()
        .then((data) => {
          if (active) setTrackStatus(data);
        })
        .catch(() => {});
    }
    if (typeof api.getTrackEvents === 'function') {
      api
        .getTrackEvents()
        .then((data) => {
          if (active) setTrackEvents(data);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (modelsProp !== undefined) {
      setModels(modelsProp);
      setModelsLoaded(true);
      return;
    }
    setModelsLoaded(false);
    let active = true;
    api
      .getModels()
      .then((data) => {
        if (active) {
          setModels(data);
          setModelsLoaded(true);
        }
      })
      .catch(() => {
        if (active) setModelsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [modelsProp, api]);

  useEffect(() => {
    if (unmatchedProp !== undefined) {
      setUnmatchedNames(unmatchedProp);
      return;
    }
    let active = true;
    api
      .getUnmatchedNames()
      .then((data) => {
        if (active) setUnmatchedNames(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [unmatchedProp, api]);

  useEffect(() => {
    if (traitsProp !== undefined) {
      setUnknownTraits(traitsProp);
      return;
    }
    let active = true;
    api
      .getUnknownTraits()
      .then((data) => {
        if (active) setUnknownTraits(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [traitsProp, api]);

  // The default selection is the first model of the loaded list.
  const selectedModel = models.find((m) => m.id === selectedModelId) ?? models[0];

  const filteredModels = models.filter((m) => {
    if (filter === 'free') return m.priceKind === 'free_forever' || m.priceKind === 'free_tier';
    if (filter === 'vision') return m.hasVision === 'yes';
    if (filter === 'review') return needsReview(m);
    return true;
  });

  const reviewModels = models.filter(needsReview);

  /**
   * R17-0.3: the model collection's own envelope.
   *
   * `/models` answers `unavailable` in the S1 slice, and a measured-but-empty
   * answer is not the same thing as zero models. Both used to render a hard
   * "0". Now they render "—" and a dashed "needs P3a" frame, because nothing
   * was measured.
   */
  const modelsSource = (models as unknown as { meta?: ResponseMeta }).meta?.source;
  const modelsUnavailable = modelsSource === 'unavailable';
  const modelsNotMeasured =
    modelsLoaded &&
    !api.isMock() &&
    (modelsUnavailable || (modelsSource !== 'sample' && models.length === 0));

  // The badge counts the two review queues that have a view-model.
  const reviewQueueCount = unmatchedNames.length + unknownTraits.length;
  const reviewBadge = modelsNotMeasured ? '—' : String(reviewQueueCount);

  const getStatusBadge = (status: ModelViewModel['status'] | 'removed') => {
    switch (status) {
      case 'new':
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--blue)', fontWeight: 600 }}>✦ {t('m_s_new') || 'Mới phát hiện'}</span>;
      case 'due_removal':
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--yel)', fontWeight: 600 }}>▲ {t('m_s_gone') || 'Sắp bị loại'}</span>;
      case 'removed':
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--cor)', fontWeight: 600 }}>✕ {t('m_s_removed') || 'Bị loại'}</span>;
      case 'paused':
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--muted)', fontWeight: 600 }}>● {t('m_s_paused')}</span>;
      case 'degraded':
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--yel)', fontWeight: 600 }}>▲ {t('m_s_deg')}</span>;
      default:
        return <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', color: 'var(--grn-i)', fontWeight: 600 }}>● {t('m_s_ok')}</span>;
    }
  };

  const getStatusText = (status: ModelViewModel['status'] | 'removed') => {
    switch (status) {
      case 'new':
        return t('m_s_new') || 'Mới phát hiện';
      case 'due_removal':
        return t('m_s_gone') || 'Sắp bị loại';
      case 'removed':
        return t('m_s_removed') || 'Bị loại';
      case 'paused':
        return t('m_s_paused');
      case 'degraded':
        return t('m_s_deg');
      default:
        return t('m_s_ok');
    }
  };

  const renderPriceTag = (kind: ModelViewModel['priceKind']) => {
    const labelKey = PRICE_KEY[kind];
    return (
      <span style={{ padding: '3px 8px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--text)' }}>
        {t(labelKey)}
      </span>
    );
  };

  const renderVision = (v: ModelViewModel['hasVision']) => {
    if (v === 'yes') return <span style={{ color: 'var(--grn-i)', fontWeight: 600 }}>● {t('m_v1')}</span>;
    if (v === 'no') return <span style={{ color: 'var(--cor-i)', fontWeight: 600 }}>✕ {t('m_v0')}</span>;
    return <span style={{ color: 'var(--muted)', fontWeight: 600 }}>? {t('m_vu')}</span>;
  };

  // The localized overlay wins when a key exists for this model id, otherwise
  // the view-model value is shown as-is.
  const getModelScoreExpl = (m: ModelViewModel) => {
    const key = `m_expl_${m.id.replace(/-/g, '_')}`;
    const localized = t(key);
    return localized !== key ? localized : m.scoreExplanation;
  };

  const getModelWhere = (m: ModelViewModel) => {
    const key = `m_where_${m.id.replace(/-/g, '_')}`;
    const localized = t(key);
    return localized !== key ? localized : m.whereUsed.join(', ');
  };

  const getLineage = (m: ModelViewModel) => [m.canonicalId, ...m.aliases].join(' == ');

  const notMeasured = (
    <div style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid="not-measured">
      {t('r14_models_empty')} · {t('s1_not_measured')}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="models-screen">
      {/* Header */}
      <div style={{ maxWidth: '820px' }}>
        <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          {t('m_h')}
        </h1>
        <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
          {t('m_sub')}
        </p>
      </div>

      {/* R49 Track Status Banner */}
      {trackStatus && typeof trackStatus.trackedCount === 'number' && (
        <div
          data-testid="track-status-banner"
          style={{
            padding: '10px 16px',
            borderRadius: '12px',
            background: 'var(--fill)',
            border: '1px solid var(--line)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '14px',
            alignItems: 'center',
            fontSize: '13px',
            color: 'var(--muted)',
          }}
        >
          <span style={{ color: 'var(--blue)', fontWeight: 700 }}>{t('track_banner_title')}</span>
          <span>{t('track_providers_count')} {trackStatus.trackedCount}/{trackStatus.providerCount}</span>
          <span>{t('track_models_total')} {trackStatus.totalModels}</span>
          {Array.isArray(trackEvents?.events) && trackEvents.events.length > 0 && (
            <span data-testid="track-events-count" style={{ color: 'var(--text)' }}>
              {t('track_events_count')} {trackEvents.events.length}
            </span>
          )}
        </div>
      )}

      {/* R51 Panel Thay đổi dự kiến (maintain/plan) - routersync maintain apply --only */}
      <div
        data-testid="maintain-plan-panel"
        style={{
          padding: '16px 20px',
          borderRadius: '16px',
          background: 'var(--fill)',
          border: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text)' }}>
              {t('maintain_plan_title')}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--muted)' }}>
              (GET /api/v1/maintain/plan)
            </span>
          </div>
          {maintainPlan && Array.isArray(maintainPlan.actions) && (
            <span style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 600 }}>
              {maintainPlan.actions.length} {t('maintain_actions_count')}
            </span>
          )}
        </div>

        {maintainPlan?.summary && (
          <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.5 }}>
            {maintainPlan.summary}
          </div>
        )}

        {Array.isArray(maintainPlan?.actions) && maintainPlan.actions.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {maintainPlan.actions.map((act, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: '13px',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>
                  <strong>{act.type}</strong> {act.comboId ? `[${act.comboId}]` : ''} {act.modelId ? `→ ${act.modelId}` : ''}
                </span>
                {act.reason && <span style={{ fontSize: '12px', color: 'var(--faint)' }}>{act.reason}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: 'var(--muted)' }}>
            {t('maintain_no_actions')}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--faint)' }}>{t('maintain_cmd_label')}</span>
          <code style={{ fontSize: '12px', fontFamily: 'monospace', padding: '4px 8px', background: 'var(--card)', borderRadius: '6px', border: '1px solid var(--line)', color: 'var(--text)' }}>
            routersync maintain apply --only
          </code>
        </div>
      </div>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('m_tabs')}
        style={{ display: 'flex', gap: '8px', borderBottom: '1.5px solid var(--line)', paddingBottom: '12px', overflowX: 'auto' }}
      >
        <button
          role="tab"
          aria-selected={activeTab === 'list'}
          onClick={() => {
            setActiveTab('list');
            const h = window.location.hash || '#models';
            window.location.hash = h.includes('tab=l') ? h.replace('tab=l', 'tab=l2') : (h.includes('?') ? h + '&tab=l' : h + '?tab=l');
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
            background: activeTab === 'list' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'list' ? 'var(--on-ink)' : 'var(--muted)',
          }}
        >
          {t('m_tab1')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'sources'}
          onClick={() => {
            setActiveTab('sources');
            const h = window.location.hash || '#models';
            window.location.hash = h.includes('tab=s') ? h.replace('tab=s', 'tab=s2') : (h.includes('?') ? h + '&tab=s' : h + '?tab=s');
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
            background: activeTab === 'sources' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'sources' ? 'var(--on-ink)' : 'var(--muted)',
          }}
        >
          {t('m_tab2')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'review'}
          onClick={() => {
            setActiveTab('review');
            const h = window.location.hash || '#models';
            window.location.hash = h.includes('tab=r') ? h.replace('tab=r', 'tab=r2') : (h.includes('?') ? h + '&tab=r' : h + '?tab=r');
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
            background: activeTab === 'review' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'review' ? 'var(--on-ink)' : 'var(--muted)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>{t('m_tab3')}</span>
          <span
            data-testid="models-review-badge"
            style={{ padding: '1px 7px', borderRadius: '999px', fontSize: '11px', background: activeTab === 'review' ? 'rgba(255,255,255,0.2)' : 'var(--yel-t)', color: activeTab === 'review' ? '#fff' : 'var(--yel-i)' }}
          >
            {reviewBadge}
          </span>
        </button>
      </div>

      {actionDoneMsg && (
        <div style={{ background: 'var(--grn-t)', color: 'var(--grn-i)', borderRadius: '14px', padding: '10px 16px', fontWeight: 600 }}>
          {actionDoneMsg}
        </div>
      )}

      {/* Tab 1: List */}
      {activeTab === 'list' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="models-tab-list">
          {/* Filter Pills */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {[
              { id: 'all' as const, label: t('m_f1') },
              { id: 'free' as const, label: t('m_f2') },
              { id: 'vision' as const, label: t('m_f3') },
              { id: 'review' as const, label: t('m_f4') },
            ].map((f) => {
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setFilter(f.id);
                    const h = window.location.hash || '#models';
                    window.location.hash = h.includes(`f=${f.id}`) ? h.replace(`f=${f.id}`, `f=${f.id}2`) : (h.includes('?') ? h + `&f=${f.id}` : h + `?f=${f.id}`);
                  }}
                  className="btn"
                  style={{
                    borderRadius: '999px',
                    padding: '8px 16px',
                    fontSize: '14px',
                    fontWeight: 600,
                    border: 0,
                    cursor: 'pointer',
                    background: active ? 'var(--ink)' : 'var(--fill)',
                    color: active ? 'var(--on-ink)' : 'var(--text)',
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* R17-0.3: nothing measured -> a dashed frame, never a 0. */}
          {modelsNotMeasured && (
            <div
              data-testid="models-unavailable"
              style={{
                background: 'var(--fill)',
                border: '1.5px dashed var(--dash)',
                borderRadius: '16px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                color: 'var(--muted)',
                fontSize: '14px',
              }}
            >
              <strong style={{ color: 'var(--text)' }}>{t('s1_needs_p3a')}</strong>
              <span>{t('m_unavailable_desc')}</span>
            </div>
          )}

          {/* Table */}
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              overflow: 'hidden',
              boxShadow: 'var(--sh-card)',
            }}
          >
            <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--line)', fontWeight: 800, fontSize: '16px' }}>
              {/* R16-3: the sample caption is only true in sample mode. With
                  the daemon the caption states what the daemon returned, or
                  says that it returned nothing. */}
              {modelsNotMeasured
                ? '—'
                : api.isMock()
                  ? t('m_lt')
                  : models.length > 0
                    ? t('m_lt_live', { count: models.length })
                    : t('m_lt_empty')}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
                <thead>
                  <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '12px', fontWeight: 700 }}>
                    <th style={{ padding: '12px 18px' }}>{t('m_c1')}</th>
                    <th style={{ padding: '12px 18px' }}>{t('m_c2')}</th>
                    <th style={{ padding: '12px 18px' }}>{t('m_c3')}</th>
                    <th style={{ padding: '12px 18px' }}>{t('m_c4')}</th>
                    <th style={{ padding: '12px 18px' }}>Vision</th>
                    <th style={{ padding: '12px 18px' }}>{t('m_c6')}</th>
                    <th style={{ padding: '12px 18px' }}>{t('m_c7')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: '16px 18px', color: 'var(--muted)' }}>
                        {modelsNotMeasured ? t('s1_not_measured') : t('r14_models_empty')}
                      </td>
                    </tr>
                  ) : (
                    filteredModels.map((m) => {
                      const isSelected = selectedModelId === m.id;
                      return (
                        <tr
                          key={m.id}
                          onClick={() => setSelectedModelId(m.id)}
                          style={{
                            borderBottom: '1px solid var(--line)',
                            cursor: 'pointer',
                            background: isSelected ? 'var(--blue-sel)' : 'transparent',
                          }}
                          data-testid={`model-row-${m.id}`}
                        >
                          <td style={{ padding: '14px 18px', fontWeight: 700, color: 'var(--link)', fontFamily: 'var(--font-mono)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>{m.id}</span>
                              {trackEvents?.events.some(
                                (e) =>
                                  e.models?.includes(m.id) ||
                                  e.models?.includes(m.canonicalId) ||
                                  (e.models && e.models.some((em) => em.endsWith(`/${m.id}`)))
                              ) && (
                                <span
                                  data-testid="track-event-badge"
                                  style={{
                                    fontSize: '11px',
                                    padding: '2px 6px',
                                    borderRadius: '6px',
                                    background: 'var(--blue-sel, rgba(37,99,235,0.15))',
                                    color: 'var(--blue)',
                                    fontWeight: 600,
                                  }}
                                >
                                  Theo dõi
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '14px 18px', fontFamily: 'var(--font-mono)' }}>{m.provider}</td>
                          <td style={{ padding: '14px 18px' }}>{renderPriceTag(m.priceKind)}</td>
                          <td style={{ padding: '14px 18px', fontFamily: 'var(--font-mono)' }}>{m.context}</td>
                          <td style={{ padding: '14px 18px' }}>{renderVision(m.hasVision)}</td>
                          <td style={{ padding: '14px 18px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{m.score}</td>
                          <td style={{ padding: '14px 18px' }}>{getStatusBadge(m.status)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '14px 24px', fontSize: '13px', color: 'var(--muted)', background: 'var(--fill)' }}>
              {t('m_ln')}
            </div>
          </div>

          {/* Model Detail Card */}
          {selectedModel && (
            <section
              style={{
                background: 'var(--card)',
                border: '2px solid var(--blue)',
                borderRadius: '24px',
                padding: '24px',
                boxShadow: 'var(--sh-card)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
              }}
              data-testid="model-detail-card"
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                  {selectedModel.id}
                </h2>
                <span style={{ color: 'var(--muted)', fontSize: '14px' }}>{getModelScoreExpl(selectedModel)}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <b style={{ fontSize: '14px' }}>{t('m_d1')}</b>
                  <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)' }}>{getLineage(selectedModel)}</span>
                  <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('m_d1n')}</span>
                </div>
                <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <b style={{ fontSize: '14px' }}>{t('m_d2')}</b>
                  <span style={{ fontSize: '14px' }}>{getModelWhere(selectedModel)}</span>
                </div>
                <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <b style={{ fontSize: '14px' }}>{t('m_d3')}</b>
                  <span style={{ fontSize: '14px' }}>{getModelScoreExpl(selectedModel)}</span>
                  <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('m_d3n')}</span>
                </div>
              </div>

              {/* Lifecycle flow */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <b style={{ fontSize: '14px' }}>{t('m_d4')}</b>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                  {[t('m_lc1'), t('m_lc2'), t('m_lc3'), t('m_lc4')].map((s, i, arr) => (
                    <React.Fragment key={s}>
                      <span style={{ borderRadius: '999px', padding: '6px 14px', fontWeight: 600, fontSize: '13px', background: 'var(--fill)' }}>
                        {s}
                      </span>
                      {i < arr.length - 1 && <span aria-hidden="true" style={{ color: 'var(--faint)' }}>→</span>}
                    </React.Fragment>
                  ))}
                </div>
                <div style={{ fontSize: '14px' }}>
                  {t('m_d5')}{' '}
                  <b>{getStatusText(selectedModel.status)}</b>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                  {t('m_d6')}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* Tab 2: Sources and scores */}
      {activeTab === 'sources' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="models-tab-sources">
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
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('m_srt')}</h2>
            <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)', lineHeight: 1.5 }}>
              {t('m_srn')}
            </p>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
                <thead>
                  <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '12px', fontWeight: 700 }}>
                    <th style={{ padding: '12px 14px' }}></th>
                    <th style={{ padding: '12px 14px' }}>{t('m_sh1')}</th>
                    <th style={{ padding: '12px 14px' }}>{t('m_sh2')}</th>
                    <th style={{ padding: '12px 14px' }}>{t('m_sh3')}</th>
                    <th style={{ padding: '12px 14px' }}>{t('m_sh4')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { tier: 'L1', name: t('m_sr1'), used: t('m_sr1d'), cost: '0', rel: t('m_hi') },
                    { tier: 'L2', name: t('m_sr2'), used: t('m_sr2d'), cost: '0', rel: t('m_mid') },
                    { tier: 'L3', name: t('m_sr3'), used: t('m_sr3d'), cost: '0', rel: t('m_low') },
                    { tier: 'L4', name: t('m_sr4'), used: t('m_sr4d'), cost: '0', rel: t('m_mh') },
                    { tier: 'L5', name: t('m_sr5'), used: t('m_sr5d'), cost: t('m_off'), rel: t('m_low1') },
                    { tier: 'L6', name: t('m_sr6'), used: t('m_sr6d'), cost: '0', rel: t('m_hi') },
                  ].map((row) => (
                    <tr key={row.tier} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '12px 14px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{row.tier}</td>
                      <td style={{ padding: '12px 14px', fontWeight: 600 }}>{row.name}</td>
                      <td style={{ padding: '12px 14px', color: 'var(--muted)' }}>{row.used}</td>
                      <td style={{ padding: '12px 14px' }}>{row.cost}</td>
                      <td style={{ padding: '12px 14px' }}>{row.rel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {viewMode === 'detail' && (
              <div style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {t('m_srv')}
              </div>
            )}
          </section>

          {/* Evidence + Budget Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            {/* Evidence Calculation */}
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
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_ev')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>
                {t('m_evd')}
              </p>
              {/* R14: the S1 daemon measures no evidence rows yet - no invented table. */}
              {notMeasured}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                <span style={{ fontSize: '32px', fontWeight: 800 }}>—</span>
                <span style={{ color: 'var(--muted)', fontSize: '14px' }}>{t('m_evr')}</span>
              </div>
              {models.some((m) => m.isDisputed) && (
                <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '12px 14px', fontSize: '13px' }}>
                  <b>{t('m_dis')}</b> {t('m_dis2')}
                </div>
              )}
            </section>

            {/* Research Budget */}
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
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_rb')}</h2>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', color: 'var(--muted)' }}>
                <li>{t('m_rb1')}</li>
                <li>{t('m_rb2')}</li>
                <li>{t('m_rb3')}</li>
              </ul>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: 'var(--muted)' }}>
                  <span>{t('m_rb4')}</span>
                  <span style={{ fontWeight: 700 }}>—</span>
                </div>
                {notMeasured}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Tab 3: Review Queue */}
      {activeTab === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="models-tab-review">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
            {/* Unmatched model names */}
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
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_um')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('m_umd')}</p>
              {unmatchedNames.length === 0 ? (
                notMeasured
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                        <th style={{ padding: '8px 12px' }}>{t('m_uh1')}</th>
                        <th style={{ padding: '8px 12px' }}>{t('m_uh2')}</th>
                        <th style={{ padding: '8px 12px' }}>{t('m_uh3')}</th>
                        <th style={{ padding: '8px 12px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {unmatchedNames.map((item) => (
                        <tr key={item.id} style={{ borderBottom: '1px solid var(--line)' }} data-testid={`unmatched-row-${item.id}`}>
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>{item.seenName}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{item.suspectedModel || t('m_unk2')}</span>
                            <div style={{ marginTop: '4px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', background: 'var(--blue-sel)', color: 'var(--blue)' }}>
                                {t(item.sourceText)}
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '10px 12px' }}>{t(item.confidence)}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                onClick={() => setActionDoneMsg(`${t(item.suspectedModel ? 'm_yes' : 'm_new')}: ${item.seenName}`)}
                                className="btn"
                                style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', border: 0, cursor: 'pointer', background: 'var(--ink)', color: 'var(--on-ink)' }}
                              >
                                {t(item.suspectedModel ? 'm_yes' : 'm_new')}
                              </button>
                              <button
                                onClick={() => setActionDoneMsg(`${t(item.suspectedModel ? 'm_no' : 'm_ign')}: ${item.seenName}`)}
                                className="btn"
                                style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                              >
                                {t(item.suspectedModel ? 'm_no' : 'm_ign')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>
                {t('m_umag')}
              </p>
            </section>

            {/* Unknown traits */}
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
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_uq')}</h2>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('m_uqd')}</p>
              {unknownTraits.length === 0 ? (
                notMeasured
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                        <th style={{ padding: '8px 12px' }}>{t('m_qh1')}</th>
                        <th style={{ padding: '8px 12px' }}>{t('m_qh2')}</th>
                        <th style={{ padding: '8px 12px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {unknownTraits.map((item) => (
                        <tr key={item.id} style={{ borderBottom: '1px solid var(--line)' }} data-testid={`unknown-trait-row-${item.id}`}>
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>{item.modelId}</td>
                          <td style={{ padding: '10px 12px' }}>{item.unknownTrait}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                              <button
                                onClick={() => setActionDoneMsg(`${t('m_has')}: ${item.modelId}`)}
                                className="btn"
                                style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', border: 0, cursor: 'pointer', background: 'var(--ink)', color: 'var(--on-ink)' }}
                              >
                                {t('m_has')}
                              </button>
                              <button
                                onClick={() => setActionDoneMsg(`${t('m_hasnt')}: ${item.modelId}`)}
                                className="btn"
                                style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                              >
                                {t('m_hasnt')}
                              </button>
                              <button
                                onClick={() => setActionDoneMsg(`${t('m_ver')}: ${item.modelId}`)}
                                className="btn"
                                style={{ font: 'inherit', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', border: '1px solid var(--line)', cursor: 'pointer', background: 'transparent' }}
                              >
                                {t('m_ver')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)', lineHeight: 1.4 }}>
                {t('m_uqn')}
              </p>
            </section>
          </div>

          {/* Models that need a human decision */}
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
            data-testid="models-review-queue"
          >
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_f4')}</h2>
            {reviewModels.length === 0 ? (
              notMeasured
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: 'var(--fill)', color: 'var(--muted)', fontSize: '11px', fontWeight: 700 }}>
                      <th style={{ padding: '8px 12px' }}>{t('m_c1')}</th>
                      <th style={{ padding: '8px 12px' }}>{t('m_c2')}</th>
                      <th style={{ padding: '8px 12px' }}>Vision</th>
                      <th style={{ padding: '8px 12px' }}>{t('m_c7')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewModels.map((m) => (
                      <tr
                        key={m.id}
                        onClick={() => {
                          setSelectedModelId(m.id);
                          setActiveTab('list');
                        }}
                        style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
                        data-testid={`model-review-row-${m.id}`}
                      >
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>{m.id}</td>
                        <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>{m.provider}</td>
                        <td style={{ padding: '10px 12px' }}>{renderVision(m.hasVision)}</td>
                        <td style={{ padding: '10px 12px' }}>{getStatusBadge(m.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* User Traits */}
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
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('m_ut')}</h2>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)' }}>{t('m_utd')}</p>
            {/* R14: user traits have no view-model in the ApiClient contract yet. */}
            {notMeasured}
            <div>
              <button
                onClick={() => setActionDoneMsg(t('m_utadd'))}
                className="btn"
                style={{
                  font: 'inherit',
                  fontWeight: 700,
                  fontSize: '13px',
                  minHeight: '40px',
                  padding: '0 18px',
                  borderRadius: '999px',
                  border: '1.5px solid var(--line)',
                  cursor: 'pointer',
                  background: 'transparent',
                  color: 'var(--text)',
                }}
              >
                {t('m_utadd')}
              </button>
            </div>
            {viewMode === 'detail' && (
              <div style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {t('m_utn')}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
