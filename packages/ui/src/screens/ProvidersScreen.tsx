import React, { useEffect, useState } from 'react';
import { hasTranslation, useI18n } from '../i18n';
import { useApi, type ApiClient, type TrackStatusResponse } from '../api';
import type { ProviderViewModel, ResponseMeta } from '../api/types';
import { Button } from '../components/Button';

/**
 * R17-1: ProvidersScreen is a pure function of the view-model.
 *
 * The R16 screen hard-coded six prototype cards and their numbers (models,
 * quota, scan age, lifecycle lines). None of that survives here: a card is
 * painted only from a `ProviderViewModel`, and the three collection states are
 * kept apart:
 *
 *  - `sample`      -> the prototype cards, with the "sample data" badge;
 *  - `unavailable` -> a dashed "needs P3a" frame, no card and no number;
 *  - `live`        -> the reported cards, or an empty state (which is not the
 *                     same thing as "needs P3a").
 */
interface ProvidersScreenProps {
  viewMode?: 'simple' | 'detail';
  providers?: ProviderViewModel[] | undefined;
  api?: ApiClient | undefined;
}

const UNMEASURED = '—';

/** The collection envelope, or the first element's own meta (daemon shapes). */
function collectionSource(
  list: ProviderViewModel[] | undefined
): ResponseMeta['source'] | undefined {
  if (!list) return undefined;
  // The envelope of an EMPTY collection still says why it is empty: that is
  // the difference between "measured: no provider" and "not measured".
  const arrMeta = (list as unknown as { meta?: ResponseMeta }).meta;
  if (arrMeta?.source) return arrMeta.source;
  if (list.length === 0) return undefined;
  return list[0]?.meta?.source;
}

export const ProvidersScreen: React.FC<ProvidersScreenProps> = ({
  viewMode = 'simple',
  providers: providersProp,
  api: apiProp,
}) => {
  const { t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [showAdd, setShowAdd] = useState(false);
  const [selectedType, setSelectedType] = useState('OpenRouter');
  const [keySource, setKeySource] = useState<'paste' | 'env' | 'router'>('paste');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [providersState, setProviders] = useState<ProviderViewModel[] | undefined>(providersProp);
  const [trackStatus, setTrackStatus] = useState<TrackStatusResponse | null>(null);

  /**
   * Local overrides of the two per-provider toggles. The INITIAL value is the
   * one the view-model reports (`autoAddNew` / `autoRemoveGone`); an override
   * only exists after the owner clicked the switch.
   */
  const [toggles, setToggles] = useState<Record<string, { add?: boolean; remove?: boolean }>>({});

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
    if (providersProp !== undefined) {
      setProviders(providersProp);
      return () => {
        active = false;
      };
    }
    api
      .getProviders()
      .then((data) => {
        if (active) setProviders(data);
      })
      .catch(() => {
        if (active) setProviders([]);
      });
    return () => {
      active = false;
    };
  }, [providersProp, api]);

  /**
   * R17-1: the three collection states.
   *
   *  - `unavailable` -> the daemon answered "not measured": a dashed frame,
   *    no provider card and no number.
   *  - `sample`      -> prototype content, and the badge says so.
   *  - `live`        -> what the daemon reported.
   */
  const providers = providersState ?? [];
  const source = collectionSource(providersState);
  const isSample = source === 'sample';
  const isUnavailable = source === 'unavailable';

  const toggleSwitch = (providerId: string, field: 'add' | 'remove', next: boolean) => {
    setToggles((prev) => ({
      ...prev,
      [providerId]: {
        ...prev[providerId],
        [field]: next,
      },
    }));
  };

  const handleCheckKey = () => {
    setStatusMsg(t('w_1ok'));
  };

  const labelOf = (value: string | undefined): string => {
    if (!value) return UNMEASURED;
    // A view-model string is either a translation key (sample content) or a
    // value the daemon really read. `hasTranslation` decides, so the screen
    // never prints a raw key and never translates measured data.
    return hasTranslation(value) ? t(value) : value;
  };

  const toggleValue = (provider: ProviderViewModel, field: 'add' | 'remove'): boolean => {
    const override = toggles[provider.id]?.[field];
    if (typeof override === 'boolean') return override;
    return field === 'add' ? provider.autoAddNew : provider.autoRemoveGone;
  };

  const modelsValueOf = (provider: ProviderViewModel): string => {
    if (provider.status === 'no_list_api') {
      return typeof provider.manualCount === 'number'
        ? t('p_manual', { count: provider.manualCount })
        : UNMEASURED;
    }
    if (provider.status === 'key_error' && typeof provider.retainedCount === 'number') {
      return t('p_keep', { count: provider.retainedCount });
    }
    return typeof provider.modelsCount === 'number' ? String(provider.modelsCount) : UNMEASURED;
  };

  const statusStyle: Record<ProviderViewModel['status'], { dot: string; bg: string; fg: string; labelKey: string }> = {
    active: { dot: 'var(--grn)', bg: 'var(--grn-t)', fg: 'var(--grn-i)', labelKey: 'p_st_ok' },
    key_error: { dot: 'var(--cor)', bg: 'var(--cor-t)', fg: 'var(--cor-i)', labelKey: 'p_st_bad' },
    no_list_api: { dot: 'var(--dash)', bg: 'var(--fill)', fg: 'var(--muted)', labelKey: 'p_st_unk' },
  };

  const renderSwitch = (provider: ProviderViewModel, field: 'add' | 'remove', labelKey: string) => {
    const on = toggleValue(provider, field);
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ fontSize: '14px' }}>{t(labelKey)}</span>
        <button
          role="switch"
          aria-checked={on}
          aria-label={`${t(labelKey)} · ${provider.name}`}
          onClick={() => toggleSwitch(provider.id, field, !on)}
          className="btn"
          style={{
            width: '44px',
            height: '24px',
            borderRadius: '999px',
            border: 0,
            cursor: 'pointer',
            padding: 0,
            background: on ? 'var(--blue)' : 'var(--dash)',
            position: 'relative',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '3px',
              left: '3px',
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              background: '#fff',
              transition: 'transform 0.15s ease',
              transform: on ? 'translateX(20px)' : 'translateX(0)',
            }}
          />
        </button>
      </div>
    );
  };

  const renderProviderCard = (provider: ProviderViewModel) => {
    const style = statusStyle[provider.status];
    const quota = provider.quota;
    return (
      <section
        key={provider.id}
        data-testid={`provider-card-${provider.id}`}
        data-provider-id={provider.id}
        data-provider-status={provider.status}
        style={{
          background: 'var(--card)',
          border: provider.status === 'key_error' ? '1.5px solid var(--cor)' : '1px solid var(--line)',
          borderRadius: '24px',
          padding: '24px',
          boxShadow: 'var(--sh-card)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 12px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', minWidth: 0 }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: style.dot }}></span>
            <span className="m" style={{ fontSize: '20px', fontWeight: 800 }}>{provider.name}</span>
          </div>
          <span
            data-testid="provider-status"
            style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, background: style.bg, color: style.fg }}
          >
            {t(style.labelKey)}
          </span>
        </div>

        {provider.priceKindKey && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            <span style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--text)' }}>
              {t(provider.priceKindKey)}
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: '14px' }}>
          <span style={{ color: 'var(--muted)' }}>{t('p_l_models')}</span>
          <span data-testid="provider-models">{modelsValueOf(provider)}</span>
          <span style={{ color: 'var(--muted)' }}>{t('p_l_key')}</span>
          <span>{labelOf(provider.keySourceLabel)}</span>
          <span style={{ color: 'var(--muted)' }}>{t('p_l_scan')}</span>
          <span data-testid="provider-last-scan">{labelOf(provider.lastScan)}</span>
        </div>

        {quota && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 700 }}>
              <span className="m" data-testid="provider-quota-used">{quota.used}</span>
              <span className="m" data-testid="provider-quota-limit">{quota.limit}</span>
            </div>
            <div style={{ height: '8px', borderRadius: '4px', background: 'var(--track)', overflow: 'hidden', marginTop: '4px' }}>
              <div
                style={{
                  width: `${quota.limit > 0 ? Math.round((quota.used / quota.limit) * 100) : 0}%`,
                  height: '100%',
                  background: 'var(--grn)',
                }}
              />
            </div>
          </div>
        )}

        {provider.notice && (
          <div
            style={{
              background: provider.status === 'active' ? 'var(--fill)' : provider.status === 'key_error' ? 'var(--yel-t)' : 'var(--fill)',
              color: provider.status === 'key_error' ? 'var(--yel-i)' : 'inherit',
              borderRadius: '14px',
              padding: '10px 14px',
              fontSize: '13px',
            }}
          >
            {labelOf(provider.notice)}
          </div>
        )}

        {provider.status === 'key_error' ? (
          <div>
            <Button variant="ink" onClick={() => setShowAdd(true)}>
              {t('p_upd')}
            </Button>
          </div>
        ) : provider.status === 'no_list_api' ? (
          <div>
            <Button variant="secondary" onClick={() => setShowAdd(true)}>
              {t('p_addm')}
            </Button>
          </div>
        ) : (
          <div style={{ borderTop: '1.5px dashed var(--line)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {renderSwitch(provider, 'add', 'p_t1')}
            {renderSwitch(provider, 'remove', 'p_t2')}
          </div>
        )}

        {viewMode === 'detail' && provider.detail && (
          <div style={{ fontSize: '12px', color: 'var(--muted)' }} className="m">
            {provider.detail}
          </div>
        )}
      </section>
    );
  };
  const presetTypes = [
    'OpenAI',
    'Anthropic',
    'Gemini',
    'OpenRouter',
    'Groq',
    'Mistral',
    'Ollama (local)',
    t('p_custom'),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="providers-screen">
      {/* Page Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 20px', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ maxWidth: '780px' }}>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            {t('p_h')}
          </h1>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('p_sub')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText('routersync track watch');
              setStatusMsg('routersync track watch');
            }}
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
            {t('p_run_track')}
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="btn"
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '14px',
              minHeight: '44px',
              padding: '0 20px',
              borderRadius: '999px',
              border: 0,
              cursor: 'pointer',
              background: 'var(--ink)',
              color: 'var(--on-ink)',
            }}
          >
            {t('p_add')}
          </button>
        </div>
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
          <span>{t('track_tracking_count')} {trackStatus.trackedCount}/{trackStatus.providerCount}</span>
          <span>{t('track_models_total')} {trackStatus.totalModels}</span>
        </div>
      )}

      {statusMsg && (
        <div data-testid="status-msg" style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--grn-i)', fontWeight: 600, background: 'var(--grn-t)', padding: '10px 16px', borderRadius: '14px', fontSize: '13px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Add Provider Drawer Panel */}
      {showAdd && (
        <section
          style={{
            background: 'var(--card)',
            border: '1.5px solid var(--blue)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="add-provider-panel"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('p_adt')}</h2>

          {/* 1. Pick a type */}
          <div>
            <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '14px' }}>{t('p_ad1')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {presetTypes.map((type) => {
                const isSelected = selectedType === type;
                return (
                  <button
                    key={type}
                    onClick={() => setSelectedType(type)}
                    className="btn"
                    style={{
                      borderRadius: '999px',
                      padding: '8px 16px',
                      fontWeight: 600,
                      fontSize: '14px',
                      border: 0,
                      cursor: 'pointer',
                      background: isSelected ? 'var(--ink)' : 'var(--fill)',
                      color: isSelected ? 'var(--on-ink)' : 'var(--text)',
                    }}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--muted)' }}>{t('p_ad1n')}</div>
          </div>

          {/* 2. Key source */}
          <div>
            <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '14px' }}>{t('p_ad2')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                { id: 'paste' as const, label: t('p_k1'), desc: t('p_k1d') },
                { id: 'env' as const, label: t('p_k2'), desc: t('p_k2d') },
                { id: 'router' as const, label: t('p_k3'), desc: t('p_k3d') },
              ].map((opt) => {
                const on = keySource === opt.id;
                return (
                  <label
                    key={opt.id}
                    onClick={() => setKeySource(opt.id)}
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
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
            <button
              onClick={handleCheckKey}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 20px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: 'var(--ink)',
                color: 'var(--on-ink)',
              }}
            >
              {t('p_ad3')}
            </button>
            <button
              onClick={() => setShowAdd(false)}
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
              {t('p_ad4')}
            </button>
            <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('p_ad5')}</span>
          </div>

          {statusMsg && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--grn-i)', fontWeight: 600 }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
              <span>{statusMsg}</span>
            </div>
          )}
        </section>
      )}

      {/* R17-1: three different states, never one.
          - `sample`     -> the prototype cards, with the sample badge;
          - `unavailable`-> a dashed "needs P3a" frame, no card, no number;
          - `live`       -> the cards the daemon reported, or an empty state
                            (which is NOT the same thing as "needs P3a"). */}
      {isSample && (
        <div
          data-testid="sample-badge"
          style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '10px 16px', fontSize: '13px' }}
        >
          <b>{t('r14_sample_badge')}</b> — {t('r14_sample_badge_desc')}
        </div>
      )}

      {isUnavailable ? (
        <div
          data-testid="providers-unavailable"
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
          <span>{t('p_unavailable_desc')}</span>
        </div>
      ) : (
        <>
          {/* Summary chips: counts of the providers the view-model carries. */}
          {providers.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }} data-testid="providers-summary">
              {[
                { key: 'active', dot: 'var(--grn)', labelKey: 'p_c1' },
                { key: 'key_error', dot: 'var(--cor)', labelKey: 'p_c2' },
                { key: 'no_list_api', dot: 'var(--dash)', labelKey: 'p_c3' },
              ].map((chip) => (
                <div
                  key={chip.key}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '999px', background: 'var(--fill)', fontSize: '14px', fontWeight: 600 }}
                >
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: chip.dot }}></span>
                  <span>
                    {t(chip.labelKey, {
                      count: providers.filter((p) => p.status === chip.key).length,
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}

          {providers.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '20px' }}>
              {providers.map(renderProviderCard)}
            </div>
          ) : (
            <div
              data-testid="providers-empty-state"
              style={{
                background: 'var(--fill)',
                border: '1.5px dashed var(--dash)',
                borderRadius: '16px',
                padding: '24px',
                color: 'var(--muted)',
                fontSize: '14px',
              }}
            >
              {t('p_empty')}
            </div>
          )}
        </>
      )}
      {/* Bottom Grid: Lifecycle & Key Safety */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
        {/* Lifecycle States */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('p_lf')}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {[t('p_lf1'), t('p_lf2'), t('p_lf3'), t('p_lf4')].map((step, i, arr) => (
              <React.Fragment key={step}>
                <span style={{ background: 'var(--fill)', borderRadius: '999px', padding: '6px 16px', fontWeight: 600, fontSize: '14px' }}>
                  {step}
                </span>
                {i < arr.length - 1 && <span aria-hidden="true" style={{ color: 'var(--faint)' }}>→</span>}
              </React.Fragment>
            ))}
          </div>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('p_lf5')}
          </p>
        </section>

        {/* Key Storage Rules */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('p_ky')}</h2>
          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', color: 'var(--muted)' }}>
            <li>{t('p_ky1')}</li>
            <li>{t('p_ky2')}</li>
            <li>{t('p_ky3')}</li>
          </ul>
        </section>
      </div>
    </div>
  );
};
