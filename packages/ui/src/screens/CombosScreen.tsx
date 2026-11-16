import React, { useState, useMemo, useEffect } from 'react';
import { t } from '../i18n';
import { Card, Note } from '../components/Card';
import { Button } from '../components/Button';
import { Glyph, Tag, type TagKind } from '../components/Badge';
import { ScreenId } from '../components/Sidebar';
import { useApi, ApiClient, ComboViewModel, ResponseMeta } from '../api';
import { SAMPLE_BUILDER_MODELS, SAMPLE_BUILDER_PROVIDERS } from '../api/mock';

/**
 * R14-2: CombosScreen is a pure function of the view-model.
 *
 * The combo picker, the priority ladder and the desired-vs-actual table are
 * built from `combosList` (id, name, ownership, strategy, targets, steps).
 * The prototype builder and its sample model list are rendered ONLY when the
 * collection meta says `sample`; with live data the builder shows a dashed
 * "needs P3b" frame instead.
 */

interface CombosScreenProps {
  onNavigate?: ((screen: ScreenId) => void) | undefined;
  api?: ApiClient | undefined;
  combos?: ComboViewModel[] | undefined;
}

type ComboTab = 'view' | 'build';
type SimState = 'none' | 'kite' | 'both';
type StrategyKey = 'pri' | 'rr' | 'lat';
type Ownership = 'managed' | 'adopted' | 'cascade';

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  managed: 'r14_combo_managed',
  adopted: 'r14_combo_adopted',
  cascade: 'r14_combo_cascade',
};

const OWNERSHIP_KIND: Record<Ownership, TagKind> = {
  managed: 'blue',
  adopted: 'neutral',
  cascade: 'vio',
};

/**
 * R16-3.2: how many ladder steps are drawn before the user asks for more.
 *
 * A real combo carries hundreds of steps; drawing them all at once buried the
 * screen. The ladder starts collapsed at 10 steps and the toggle reveals the
 * rest.
 */
const LADDER_COLLAPSED_STEPS = 10;

function ownershipOf(combo: ComboViewModel): Ownership {
  if (combo.type === 'adopted' || combo.type === 'custom') return 'adopted';
  if (combo.type === 'cascade') return 'cascade';
  return 'managed';
}

function collectionMeta(list: ComboViewModel[] | undefined): ResponseMeta | undefined {
  if (!list) return undefined;
  const arrMeta = (list as unknown as { meta?: ResponseMeta }).meta;
  if (arrMeta) return arrMeta;
  return list[0]?.meta;
}

export const CombosScreen: React.FC<CombosScreenProps> = ({ onNavigate, api, combos }) => {
  const contextApi = useApi();
  const effectiveApi = api ?? contextApi;
  const [combosList, setCombosList] = useState<ComboViewModel[] | undefined>(combos);

  useEffect(() => {
    if (combos !== undefined) {
      setCombosList(combos);
      return;
    }
    if (effectiveApi) {
      let active = true;
      effectiveApi
        .getCombos()
        .then((data) => {
          if (active) setCombosList(data);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }
  }, [combos, effectiveApi]);

  const meta = collectionMeta(combosList);
  const isUnavailable = meta?.source === 'unavailable';
  const isSample = meta?.source === 'sample';
  // R18-1: the collection envelope says, per router, whether its combos were
  // read. When one database is unreadable the readable one still paints, and
  // this list names the router whose combos are missing instead of silently
  // showing a shorter list.
  const unreadableRouters = (meta?.routers
    ? Object.entries(meta.routers).filter(([, v]) => v.source === 'unavailable')
    : []
  ).map(([id]) => id);

  const [activeTab, setActiveTab] = useState<ComboTab>('view');
  const [selectedComboId, setSelectedComboId] = useState<string | undefined>(undefined);
  /** R16-3.2: the ladder starts collapsed and collapses again on every switch. */
  const [ladderExpanded, setLadderExpanded] = useState(false);
  const [simState, setSimState] = useState<SimState>('none');

  // Builder state
  const [strategy, setStrategy] = useState<StrategyKey>('pri');
  const [priceFilters, setPriceFilters] = useState<{
    forever: boolean;
    tier: boolean;
    sub: boolean;
    metered: boolean;
    unknown: boolean;
  }>({
    forever: true,
    tier: true,
    sub: false,
    metered: false,
    unknown: false,
  });
  const [traitVision, setTraitVision] = useState(false);
  const [traitCtx, setTraitCtx] = useState(false);
  const [activeRecipe, setActiveRecipe] = useState<number | null>(0);
  const [showYamlModal, setShowYamlModal] = useState(false);

  const applyRecipe = (index: number) => {
    setActiveRecipe(index);
    if (index === 0) {
      setPriceFilters({ forever: true, tier: true, sub: false, metered: false, unknown: false });
      setTraitVision(false);
      setTraitCtx(false);
    } else if (index === 1) {
      setPriceFilters({ forever: true, tier: true, sub: true, metered: false, unknown: false });
      setTraitVision(false);
      setTraitCtx(false);
    } else if (index === 2) {
      setPriceFilters({ forever: true, tier: true, sub: false, metered: false, unknown: false });
      setTraitVision(true);
      setTraitCtx(false);
    } else if (index === 3) {
      setPriceFilters({ forever: true, tier: true, sub: true, metered: false, unknown: false });
      setTraitVision(false);
      setTraitCtx(false);
    }
  };

  const previewModels = useMemo(() => {
    const size = 5;
    const priceLabels: Record<string, string> = {
      forever: t('pk_forever'),
      tier: t('pk_tier'),
      sub: t('pk_sub'),
      metered: t('pk_metered'),
      unknown: t('pk_unknown'),
    };

    const evaluated = SAMPLE_BUILDER_MODELS.map((m) => {
      let why: string | null = null;
      if (m.flag === 'gone') {
        why = t('ui0_why_gone');
      } else if (m.flag === 'paused') {
        why = t('ui0_why_paused');
      } else if (!priceFilters[m.price]) {
        why = `${t('ui0_why_price_off')} (${priceLabels[m.price]})`;
      } else if (traitVision && m.vis !== true) {
        why = m.vis === null ? t('ui0_why_vis_unk') : t('ui0_why_no_vis');
      } else if (traitCtx && m.ctx < 100) {
        why = t('ui0_why_ctx');
      }
      return { ...m, why };
    });

    const okList = evaluated
      .filter((x) => !x.why)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    okList.forEach((x, i) => {
      if (i >= size) {
        x.why = t('ui0_why_max');
      }
    });

    const included = okList.filter((x) => !x.why);
    const excluded = evaluated.filter((x) => x.why).sort((a, b) => b.score - a.score);

    const ordered = [...included, ...excluded];

    const provSet = new Set(included.map((x) => x.prov));
    const nProvs = provSet.size;

    const isFree = !priceFilters.sub && !priceFilters.metered && !priceFilters.unknown;
    const isCost = priceFilters.metered || priceFilters.unknown;
    const isSub = !isFree && !isCost;

    return {
      ordered,
      included,
      excluded,
      nProvs,
      isFree,
      isCost,
      isSub,
      nOk: included.length >= 2,
      pOk: nProvs >= 2,
    };
  }, [priceFilters, traitVision, traitCtx]);

  const simMessage = useMemo(() => {
    if (simState === 'kite') return t('ui0_sim_kite');
    if (simState === 'both') return t('ui0_sim_both');
    return t('ui0_sim_none');
  }, [simState]);

  const selectedCombo = useMemo(() => {
    if (!combosList || combosList.length === 0) return undefined;
    return combosList.find((c) => c.id === selectedComboId) ?? combosList[0];
  }, [combosList, selectedComboId]);

  // R16-3.2: picking another combo collapses the ladder back to 10 steps.
  const selectedComboKey = selectedCombo?.id;
  useEffect(() => {
    setLadderExpanded(false);
  }, [selectedComboKey]);

  /** The steps of the SELECTED combo (not a union of every combo). */
  const ladderSteps = selectedCombo?.steps ?? [];
  const visibleSteps = ladderExpanded ? ladderSteps : ladderSteps.slice(0, LADDER_COLLAPSED_STEPS);
  const ladderHasMore = ladderSteps.length > LADDER_COLLAPSED_STEPS;

  const renderStepNote = (description: string | undefined, score: number | undefined): string => {
    if (description) {
      const localized = t(description);
      if (localized !== description) return localized;
    }
    if (score !== undefined) return t('r14_step_score', { score });
    return '';
  };

  const renderStepGlyph = (status: string | undefined): 'ok' | 'warn' | 'unk' => {
    if (status === 'ok') return 'ok';
    if (status === 'proposed_remove' || status === 'degraded') return 'warn';
    return 'unk';
  };

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
          {t('b_h')}
        </h1>
        <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: '16px', maxWidth: '720px' }}>
          {t('b_sub')}
        </p>
      </div>

      {isSample && (
        <div
          data-testid="sample-badge"
          style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '10px 16px', fontSize: '13px' }}
        >
          <b>{t('r14_sample_badge')}</b> — {t('r14_sample_badge_desc')}
        </div>
      )}

      {/* Tabs */}
      <div
        role="tablist"
        aria-label={t('b_tabs')}
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
          aria-selected={activeTab === 'view'}
          onClick={() => {
            setActiveTab('view');
            const h = window.location.hash || '#combos';
            window.location.hash = h.includes('tab=v') ? h.replace('tab=v', 'tab=v2') : (h.includes('?') ? h + '&tab=v' : h + '?tab=v');
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
            background: activeTab === 'view' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'view' ? 'var(--on-ink)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {t('b_tab1')}
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'build'}
          onClick={() => {
            setActiveTab('build');
            const h = window.location.hash || '#combos';
            window.location.hash = h.includes('tab=b') ? h.replace('tab=b', 'tab=b2') : (h.includes('?') ? h + '&tab=b' : h + '?tab=b');
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
            background: activeTab === 'build' ? 'var(--ink)' : 'transparent',
            color: activeTab === 'build' ? 'var(--on-ink)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          {t('b_tab2')}
        </button>
      </div>

      {/* View Tab Panel */}
      {activeTab === 'view' && (
        <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {!isUnavailable && unreadableRouters.length > 0 && (
            <div
              data-testid="combos-router-unavailable"
              style={{
                border: '1.5px dashed var(--dash)',
                borderRadius: '16px',
                padding: '14px 16px',
                fontSize: '14px',
                color: 'var(--muted)',
              }}
            >
              {t('r18_combos_router_unreadable', { routers: unreadableRouters.join(', ') })}
            </div>
          )}
          {isUnavailable ? (
            <div
              data-testid="combos-unavailable"
              style={{
                background: 'var(--fill)',
                border: '1.5px dashed var(--dash)',
                borderRadius: '16px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                color: 'var(--muted)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--text)' }}>
                <span>◌</span>
                <span>{t('unavailable')}</span>
              </div>
              <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>
                {t('ui0_combos_unavailable_desc')}
              </p>
            </div>
          ) : combosList && combosList.length === 0 ? (
            <div
              data-testid="combos-empty-state"
              style={{
                background: 'var(--fill)',
                borderRadius: '16px',
                padding: '32px',
                textAlign: 'center',
                color: 'var(--muted)',
              }}
            >
              <p style={{ margin: 0, fontSize: '15px' }}>
                {t('ui0_no_combos_yet')}
              </p>
            </div>
          ) : (
            <>
              {/* Picker cards: one per combo reported by the VM */}
              <div
                role="tablist"
                aria-label={t('b_pick')}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
                  gap: '12px',
                }}
              >
                {combosList?.map((cb) => {
                  const own = ownershipOf(cb);
                  const isSelected = selectedCombo?.id === cb.id;
                  return (
                    <button
                      key={cb.id}
                      role="tab"
                      aria-selected={isSelected}
                      onClick={() => {
                        setSelectedComboId(cb.id);
                        // R16-3.2: the new combo starts collapsed, in the same render.
                        setLadderExpanded(false);
                        const h = window.location.hash || '#combos';
                        window.location.hash = h.includes(`cb=${cb.id}`) ? h.replace(`cb=${cb.id}`, `cb=${cb.id}2`) : (h.includes('?') ? h + `&cb=${cb.id}` : h + `?cb=${cb.id}`);
                      }}
                      data-testid={`combo-picker-${cb.id}`}
                      style={{
                        textAlign: 'left',
                        font: 'inherit',
                        border: `2px solid ${isSelected ? 'var(--blue)' : 'transparent'}`,
                        background: isSelected ? 'var(--blue-sel)' : 'var(--fill)',
                        color: 'var(--text)',
                        borderRadius: '20px',
                        padding: '14px 16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        minWidth: 0,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                        <span className="m" style={{ fontWeight: 700 }}>{cb.name}</span>
                        {/* R18-5.3: one chip, one meaning. "Có sẵn của bạn ·
                            adopted" said the same thing twice and overflowed the
                            card. The translated label is the chip; the machine
                            token stays as a data attribute for tests and agents. */}
                        <Tag kind={OWNERSHIP_KIND[own]}>
                          <span
                            data-testid="combo-ownership"
                            data-ownership={own}
                            style={{ whiteSpace: 'nowrap' }}
                          >
                            {t(OWNERSHIP_LABEL[own])}
                          </span>
                        </Tag>
                      </span>
                      <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
                        {t('r14_combo_strategy')}:{' '}
                        <span className="m" data-testid="combo-strategy">
                          {cb.strategy ?? '—'}
                        </span>
                      </span>
                      <span style={{ fontSize: '13px', color: 'var(--muted)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                        {t('r14_combo_targets')}: <span className="m">{cb.targets.join(', ')}</span>
                      </span>
                      {/* R17-0.4: the measured step count, so the owner can
                          compare this picker with the router dashboard without
                          guessing how many steps the combo really has. */}
                      <span style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid={`combo-picker-steps-${cb.id}`}>
                        {t('r14_combo_steps_count', { count: cb.steps.length })}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Priority Ladder: the steps of the selected combo */}
              <Card id="lad-t" title={t('b_lad')}>
                {selectedCombo ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} data-testid="combo-ladder">
                    {/* R17-0.4: how much of the ladder is on screen right now. */}
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid="combo-ladder-count">
                      {t('b_lad_showing', { shown: visibleSteps.length, total: ladderSteps.length })}
                    </div>
                    {ladderSteps.length === 0 && (
                      <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('r14_combo_no_steps')}</div>
                    )}
                    {visibleSteps.map((step) => (
                      <div
                        key={`${selectedCombo.id}-${step.position}-${step.modelId}`}
                        style={{
                          display: 'flex',
                          gap: '12px',
                          alignItems: 'center',
                          padding: '12px 16px',
                          borderRadius: '16px',
                          background: 'var(--fill)',
                        }}
                        data-testid={`combo-step-${step.position}`}
                      >
                        <span
                          className="m"
                          style={{
                            flex: '0 0 28px',
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: 'var(--blue-t)',
                            color: 'var(--blue-i)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '12px',
                            fontWeight: 700,
                          }}
                        >
                          {step.position}
                        </span>
                        <Glyph type={renderStepGlyph(step.status)} />
                        <span className="m" style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{step.modelId}</span>
                        <span style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--muted)', textAlign: 'right', wordBreak: 'break-word' }}>
                          {renderStepNote(step.description, step.score)}
                        </span>
                      </div>
                    ))}
                    {ladderHasMore && (
                      <button
                        type="button"
                        onClick={() => setLadderExpanded((prev) => !prev)}
                        data-testid="combo-ladder-toggle"
                        className="btn"
                        style={{
                          alignSelf: 'flex-start',
                          font: 'inherit',
                          fontWeight: 700,
                          fontSize: '13px',
                          minHeight: '40px',
                          padding: '0 16px',
                          borderRadius: '999px',
                          border: '1.5px solid var(--line)',
                          background: 'var(--card)',
                          color: 'var(--text)',
                          cursor: 'pointer',
                        }}
                      >
                        {ladderExpanded ? t('b_lad_show_less') : t('b_lad_show_all', { count: ladderSteps.length })}
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('r14_combo_no_steps')}</div>
                )}
              </Card>

              {/* Simulator (prototype only) + Desired vs Actual */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))',
                  gap: '20px',
                  alignItems: 'start',
                }}
              >
                {isSample && (
                  <Card id="sm-t" title={t('b_sim')}>
                    <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_simd')}</div>
                    <div
                      role="radiogroup"
                      aria-label={t('b_simg')}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
                    >
                      {[
                        { key: 'none' as const, label: t('b_sim0') },
                        { key: 'kite' as const, label: t('b_sim1') },
                        { key: 'both' as const, label: t('b_sim2') },
                      ].map((opt) => {
                        const isChecked = simState === opt.key;
                        return (
                          <button
                            key={opt.key}
                            role="radio"
                            aria-checked={isChecked}
                            onClick={() => {
                              setSimState(opt.key);
                              const h = window.location.hash || '#combos';
                              window.location.hash = h.includes(`sim=${opt.key}`) ? h.replace(`sim=${opt.key}`, `sim=${opt.key}2`) : (h.includes('?') ? h + `&sim=${opt.key}` : h + `?sim=${opt.key}`);
                            }}
                            className="btn"
                            style={{
                              font: 'inherit',
                              fontWeight: 600,
                              fontSize: '14px',
                              minHeight: '44px',
                              padding: '0 18px',
                              borderRadius: '999px',
                              border: 0,
                              background: isChecked ? 'var(--ink)' : 'var(--fill)',
                              color: isChecked ? 'var(--on-ink)' : 'var(--muted)',
                              cursor: 'pointer',
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        alignItems: 'baseline',
                        background: 'var(--blue-t)',
                        borderRadius: '16px',
                        padding: '14px 18px',
                      }}
                    >
                      <span aria-hidden="true" style={{ color: 'var(--blue)' }}>◆</span>
                      <span style={{ fontWeight: 600 }}>{simMessage}</span>
                    </div>
                  </Card>
                )}

                {/* Desired vs Actual */}
                <Card id="dv-t" title={t('b_dv')}>
                  <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_dvd')}</div>
                  {selectedCombo && selectedCombo.actualVsDesired && selectedCombo.actualVsDesired.length > 0 ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '14px' }}>
                        <thead>
                          <tr>
                            <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                              {t('b_dh0')}
                            </th>
                            <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                              {t('b_dh1')}
                            </th>
                            <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                              {t('b_dh2')}
                            </th>
                            <th scope="col" style={{ textAlign: 'left', fontSize: '12px', fontWeight: 700, color: 'var(--muted)', padding: '8px 14px 8px 0', borderBottom: '1.5px solid var(--line)', whiteSpace: 'nowrap' }}>
                              {t('b_dh3')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedCombo.actualVsDesired.map((row) => (
                            <tr key={row.position}>
                              <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>{row.position}</td>
                              <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                                <span className="m">{row.actual}</span>
                              </td>
                              <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                                <span className="m">{row.desired}</span>
                              </td>
                              <td style={{ padding: '12px 14px 12px 0', borderTop: '1.5px dashed var(--line)', verticalAlign: 'top' }}>
                                <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                                  <Glyph type={row.status === 'match' ? 'ok' : 'warn'} />
                                  <span>{row.status === 'match' ? t('b_ds1') : t('r14_combo_waiting')}</span>
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--muted)', fontSize: '13px' }} data-testid="combo-no-actual">
                      {t('r14_combo_no_actual')}
                    </div>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => onNavigate?.('changes')}
                    style={{ alignSelf: 'flex-start', minHeight: '36px', padding: '0 14px' }}
                  >
                    {t('b_dvgo')}
                  </Button>
                </Card>
              </div>

              {/* Alias note */}
              <Note>{t('b_al')}</Note>
            </>
          )}
        </div>
      )}

      {/* Builder Tab Panel */}
      {activeTab === 'build' && (
        <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {!isSample ? (
            <div
              data-testid="combos-builder-locked"
              style={{
                background: 'var(--fill)',
                border: '1.5px dashed var(--dash)',
                borderRadius: '16px',
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                color: 'var(--muted)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--text)' }}>
                <span>◌</span>
                <span>{t('r14_combo_builder_locked')}</span>
              </div>
              <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>
                {t('r14_combo_builder_locked_desc')}
              </p>
            </div>
          ) : (
            <>
              {/* Quick Recipes */}
              <Card id="rc-t" title={t('b_rc')}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))',
                    gap: '12px',
                  }}
                >
                  {[
                    { titleKey: 'b_rc1', descKey: 'b_rc1d' },
                    { titleKey: 'b_rc2', descKey: 'b_rc2d' },
                    { titleKey: 'b_rc3', descKey: 'b_rc3d' },
                    { titleKey: 'b_rc4', descKey: 'b_rc4d' },
                  ].map((rc, idx) => {
                    const isActive = activeRecipe === idx;
                    return (
                      <button
                        key={idx}
                        onClick={() => applyRecipe(idx)}
                        style={{
                          textAlign: 'left',
                          font: 'inherit',
                          boxSizing: 'border-box',
                          borderRadius: '18px',
                          padding: '14px 16px',
                          border: `2px solid ${isActive ? 'var(--blue)' : 'transparent'}`,
                          background: isActive ? 'var(--blue-sel)' : 'var(--fill)',
                          color: 'var(--text)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                          cursor: 'pointer',
                        }}
                      >
                        <b>{t(rc.titleKey)}</b>
                        <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t(rc.descKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </Card>

              {/* AI description */}
              <Card id="ai-t" title={t('b_ai')}>
                <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_aid')}</div>
                <div style={{ borderRadius: '16px', background: 'var(--fill)', padding: '14px 18px', color: 'var(--text)' }}>
                  {t('b_aiq')}
                </div>
                <div style={{ borderRadius: '16px', background: 'var(--blue-t)', padding: '14px 18px', fontSize: '14px' }}>
                  <b>{t('b_aie')}</b> {t('b_aie2')}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_ain')}</div>
              </Card>

              {/* Steps 1 & 2 Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))',
                  gap: '20px',
                  alignItems: 'start',
                }}
              >
                {/* Step 1: Strategy */}
                <Card id="s1-t" title={t('b_s1')}>
                  <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_s1d')}</div>
                  <div
                    role="radiogroup"
                    aria-label="Strategy"
                    style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                  >
                    {[
                      { key: 'pri' as const, label: t('b_st1'), desc: t('b_st1d') },
                      { key: 'rr' as const, label: t('b_st2'), desc: t('b_st2d') },
                      { key: 'lat' as const, label: t('b_st3'), desc: t('b_st3d') },
                    ].map((stOpt) => {
                      const isChecked = strategy === stOpt.key;
                      return (
                        <button
                          key={stOpt.key}
                          role="radio"
                          aria-checked={isChecked}
                          onClick={() => setStrategy(stOpt.key)}
                          style={{
                            textAlign: 'left',
                            font: 'inherit',
                            display: 'flex',
                            gap: '12px',
                            alignItems: 'flex-start',
                            padding: '12px 16px',
                            borderRadius: '16px',
                            border: `1.5px solid ${isChecked ? 'var(--blue)' : 'transparent'}`,
                            background: isChecked ? 'var(--blue-sel)' : 'var(--fill)',
                            color: 'var(--text)',
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              flex: '0 0 18px',
                              width: '18px',
                              height: '18px',
                              borderRadius: '50%',
                              border: `2px solid ${isChecked ? 'var(--blue)' : 'var(--dash)'}`,
                              boxSizing: 'border-box',
                              marginTop: '3px',
                              background: isChecked ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent',
                            }}
                          />
                          <span>
                            <span style={{ fontWeight: 700, display: 'block' }}>{stOpt.label}</span>
                            <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{stOpt.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="m" style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    {t('b_s1a')}
                  </div>
                </Card>

                {/* Step 2: Filters */}
                <Card id="s2-t" title={t('b_s2')}>
                  {/* Price Filter */}
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '8px' }}>{t('b_s2a')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {[
                        { key: 'forever' as const, label: t('pk_forever') },
                        { key: 'tier' as const, label: t('pk_tier') },
                        { key: 'sub' as const, label: t('pk_sub') },
                        { key: 'metered' as const, label: t('pk_metered') },
                        { key: 'unknown' as const, label: t('pk_unknown') },
                      ].map((pOpt) => {
                        const isOn = priceFilters[pOpt.key];
                        return (
                          <button
                            key={pOpt.key}
                            aria-pressed={isOn}
                            onClick={() => {
                              setActiveRecipe(null);
                              setPriceFilters((prev) => ({ ...prev, [pOpt.key]: !prev[pOpt.key] }));
                            }}
                            className="btn"
                            style={{
                              font: 'inherit',
                              fontWeight: 600,
                              fontSize: '14px',
                              minHeight: '44px',
                              padding: '0 18px',
                              borderRadius: '999px',
                              border: `1.5px solid ${isOn ? 'var(--blue)' : 'var(--line)'}`,
                              background: isOn ? 'var(--blue-t)' : 'transparent',
                              color: isOn ? 'var(--blue-i)' : 'var(--muted)',
                              cursor: 'pointer',
                            }}
                          >
                            {isOn ? '✓' : '+'} {pOpt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Trait Filter */}
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '8px' }}>{t('b_s2b')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      <button
                        aria-pressed={traitVision}
                        onClick={() => {
                          setActiveRecipe(null);
                          setTraitVision(!traitVision);
                        }}
                        className="btn"
                        style={{
                          font: 'inherit',
                          fontWeight: 600,
                          fontSize: '14px',
                          minHeight: '44px',
                          padding: '0 18px',
                          borderRadius: '999px',
                          border: `1.5px solid ${traitVision ? 'var(--blue)' : 'var(--line)'}`,
                          background: traitVision ? 'var(--blue-t)' : 'transparent',
                          color: traitVision ? 'var(--blue-i)' : 'var(--muted)',
                          cursor: 'pointer',
                        }}
                      >
                        {traitVision ? '✓' : '+'} {t('b_vis')}
                      </button>

                      <button
                        aria-pressed={traitCtx}
                        onClick={() => {
                          setActiveRecipe(null);
                          setTraitCtx(!traitCtx);
                        }}
                        className="btn"
                        style={{
                          font: 'inherit',
                          fontWeight: 600,
                          fontSize: '14px',
                          minHeight: '44px',
                          padding: '0 18px',
                          borderRadius: '999px',
                          border: `1.5px solid ${traitCtx ? 'var(--blue)' : 'var(--line)'}`,
                          background: traitCtx ? 'var(--blue-t)' : 'transparent',
                          color: traitCtx ? 'var(--blue-i)' : 'var(--muted)',
                          cursor: 'pointer',
                        }}
                      >
                        {traitCtx ? '✓' : '+'} {t('b_ctx')}
                      </button>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: '13px', marginTop: '8px' }}>
                      {t('b_s2n')}
                    </div>
                  </div>

                  {/* Providers list */}
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '8px' }}>{t('b_s2c')}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {SAMPLE_BUILDER_PROVIDERS.map((prov) => (
                        <span
                          key={prov}
                          className="m"
                          style={{
                            borderRadius: '999px',
                            padding: '8px 16px',
                            background: 'var(--fill)',
                            fontSize: '13px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          <Glyph type="ok" />
                          <span>{prov}</span>
                        </span>
                      ))}
                      <span
                        className="m"
                        style={{
                          borderRadius: '999px',
                          padding: '8px 16px',
                          border: '1.5px dashed var(--dash)',
                          fontSize: '13px',
                          color: 'var(--muted)',
                        }}
                      >
                        orbit ({t('b_s2d')})
                      </span>
                    </div>
                  </div>

                  <div className="m" style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    {t('b_s2e')}
                  </div>
                </Card>
              </div>

              {/* Step 3: Order and Size */}
              <Card id="s3-t" title={t('b_s3')}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
                    gap: '12px',
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
                    <b>{t('b_o1')}</b>
                    <span>{t('b_o1v')}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('b_o1n')}</span>
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
                    <b>{t('b_o2')}</b>
                    <span className="m" style={{ fontSize: '18px', fontWeight: 800 }}>5</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('b_o2n')}</span>
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
                    <b>{t('b_o3')}</b>
                    <span style={{ color: 'var(--muted)' }}>{t('b_o3v')}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('b_o3n')}</span>
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
                    <b>{t('b_o4')}</b>
                    <span style={{ color: 'var(--muted)' }}>{t('b_o4v')}</span>
                    <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{t('b_o4n')}</span>
                  </div>
                </div>
                <div style={{ color: 'var(--muted)', fontSize: '13px' }}>{t('b_s3n')}</div>
              </Card>

              {/* Live Preview */}
              <Card id="pv-t" title={t('b_pv')}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                  <span style={{ fontSize: '28px', fontWeight: 800 }}>{previewModels.included.length}</span>
                  <span style={{ color: 'var(--muted)' }}>{t('b_pvn')}</span>
                </div>

                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--blue-i, #2563EB)',
                    background: 'var(--blue-t, rgba(37, 99, 235, 0.08))',
                    borderRadius: '10px',
                    padding: '8px 12px',
                    marginTop: '8px',
                  }}
                  data-testid="builder-role-hint"
                >
                  {t('ui0_builder_role_hint').replace(
                    '{role}',
                    strategy === 'pri' ? t('b_st1') : strategy === 'rr' ? t('b_st2') : t('b_st3'),
                  )}
                </div>

                {/* List of evaluated models */}
                <div>
                  {previewModels.ordered.map((m, idx) => {
                    const isIncluded = !m.why;
                    const pos = isIncluded ? idx + 1 : undefined;
                    return (
                      <div
                        key={m.id}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '6px 12px',
                          alignItems: 'baseline',
                          padding: '10px 0',
                          borderTop: '1.5px dashed var(--line)',
                          color: isIncluded ? 'var(--text)' : 'var(--muted)',
                        }}
                      >
                        <span className="m" style={{ flex: '0 0 28px', fontSize: '12px', color: 'var(--muted)' }}>
                          {isIncluded ? `#${pos}` : '—'}
                        </span>
                        <Glyph type={isIncluded ? 'ok' : 'bad'} />
                        <span className="m" style={{ flex: '0 0 150px', fontWeight: 500 }}>
                          {m.id}
                        </span>
                        <span style={{ flex: '1 1 220px', fontSize: '13px', color: 'var(--muted)' }}>
                          {isIncluded
                            ? `${t('ui0_score_detail')
                                .replace('{score}', String(m.score))
                                .replace('{provider}', m.prov)
                                .replace('{price}', t(`pk_${m.price}`))}${m.flag === 'degraded' ? t('ui0_degraded_suffix') : ''}${m.flag === 'new' ? t('ui0_new_suffix') : ''}`
                            : m.why}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Automatic Checks */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    borderTop: '1.5px solid var(--line)',
                    paddingTop: '14px',
                  }}
                >
                  <b>{t('b_ck')}</b>

                  {previewModels.isFree && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="ok" />
                      <span>{t('b_ck1')}</span>
                    </div>
                  )}
                  {previewModels.isSub && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="warn" />
                      <span>{t('b_ck2')}</span>
                    </div>
                  )}
                  {previewModels.isCost && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="bad" />
                      <span>{t('b_ck3')}</span>
                    </div>
                  )}

                  {previewModels.nOk ? (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="ok" />
                      <span>{t('b_ck4')}</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="bad" />
                      <span>{t('b_ck4b')}</span>
                    </div>
                  )}

                  {previewModels.pOk ? (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="ok" />
                      <span>{t('b_ck5')}</span>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                      <Glyph type="warn" />
                      <span>{t('b_ck5b')}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
                    <Glyph type="ok" />
                    <span>{t('b_ck6')}</span>
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                  <Button variant="ink" onClick={() => onNavigate?.('changes')}>
                    {t('b_save')}
                  </Button>
                  <Button variant="secondary" onClick={() => setShowYamlModal(true)}>
                    {t('b_yaml')}
                  </Button>
                  <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
                    {t('b_savn')}
                  </span>
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* YAML Preview Modal */}
      {showYamlModal && (
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
              maxWidth: '600px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: 'var(--sh)',
              border: '1.5px solid var(--line)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>
              {t('ui0_yaml_title')}
            </h3>
            <div
              className="m"
              data-testid="combo-yaml-preview"
              style={{
                boxSizing: 'border-box',
                background: 'var(--ink)',
                color: 'var(--on-ink)',
                borderRadius: '16px',
                padding: '14px 18px',
                fontSize: '13px',
                lineHeight: 1.7,
                overflowX: 'auto',
                whiteSpace: 'pre',
              }}
            >
{`name: custom-preview
role: ${strategy === 'pri' ? 'priority' : strategy === 'rr' ? 'round-robin' : 'latency'}
routers:
  - omniroute
size: ${previewModels.included.length}
constraints:
  freeOnly: ${previewModels.isFree}${traitCtx ? '\n  minContext: 100000' : ''}
pin:
${previewModels.included.map((m) => `  - ${m.prov}/${m.id}`).join('\n')}
`}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
              <Button variant="secondary" onClick={() => setShowYamlModal(false)}>
                {t('ui0_yaml_close')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
