import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi, type ApiClient } from '../api';
import type { ResponseMeta, TargetViewModel } from '../api/types';

/**
 * R14-1: TargetsScreen is a pure function of the view-model.
 *
 * Every chip, row and number below comes from a `TargetViewModel` field.
 * There is no hard-coded target, tier, count or "verified / live" claim in
 * this file any more: the daemon S1 measures only a subset, and the screen
 * shows "—" for everything it does not measure.
 */

interface TargetsScreenProps {
  viewMode?: 'simple' | 'detail';
  targets?: TargetViewModel[] | undefined;
  api?: ApiClient | undefined;
}

const UNMEASURED = '—';

function collectionSource(list: TargetViewModel[] | undefined): ResponseMeta['source'] | undefined {
  if (!list || list.length === 0) return undefined;
  const arrMeta = (list as unknown as { meta?: ResponseMeta }).meta;
  return arrMeta?.source ?? list[0]?.meta?.source;
}

/**
 * R16-3.1: the measured reachability of a router.
 *
 * Returns the probe level ("up" / "down" / "unknown") and, when the daemon
 * measured an HTTP status, the status too ("up · 200"). No probe block at all
 * -> undefined -> the screen renders the unmeasured mark "—".
 */
function probeValueOf(
  target: TargetViewModel,
  translate: (key: string) => string
): string | undefined {
  const probe = target.probe;
  if (!probe) return undefined;
  // R18-5.1: the payload carries a machine enum ('up' / 'down' / 'unknown').
  // Printing it straight put a raw English token in the middle of a Vietnamese
  // sentence. The enum now goes through the translation catalog; the HTTP
  // status stays the measured number it is.
  const reach = translate(`r18_reach_${probe.reachability}`);
  return probe.httpStatus === undefined ? reach : `${reach} · ${probe.httpStatus}`;
}

export const TargetsScreen: React.FC<TargetsScreenProps> = ({
  viewMode = 'simple',
  targets: targetsProp,
  api: apiProp,
}) => {
  const { t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [targets, setTargets] = useState<TargetViewModel[] | undefined>(targetsProp);

  useEffect(() => {
    if (targetsProp !== undefined) {
      setTargets(targetsProp);
      return;
    }
    let active = true;
    api
      .getTargets()
      .then((data) => {
        if (active) setTargets(data);
      })
      .catch(() => {
        if (active) setTargets([]);
      });
    return () => {
      active = false;
    };
  }, [targetsProp, api]);

  const source = collectionSource(targets);
  const isSample = source === 'sample';

  const readBackLabel = (level: TargetViewModel['readBackLevel']): string => {
    if (level === 'full') return t('r14_readback_full');
    if (level === 'db-only' || level === 'db-only (degraded)') return t('r14_readback_db_only');
    if (level === 'existence-only') return t('r14_readback_existence');
    return t('s1_not_measured');
  };

  /**
   * R16-3.1: a measured STRING is a value too.
   *
   * The old code sent every non-numeric string to the "not measured" branch
   * (`Number('up')` is NaN), so the measured reachability was rendered as "—".
   * Now: a number renders as a number, a non-empty string renders as itself,
   * and only undefined / null / '' render the unmeasured mark.
   */
  const renderValue = (value: number | string | undefined) => {
    const measured =
      typeof value === 'number'
        ? Number.isFinite(value)
        : typeof value === 'string' && value.trim() !== '';
    if (!measured) {
      return (
        <span
          style={{ textAlign: 'right', fontWeight: 600, fontSize: '14px', color: 'var(--muted)', cursor: 'help' }}
          title={t('s1_not_measured')}
          data-testid="unmeasured-count"
        >
          {UNMEASURED}
        </span>
      );
    }
    return <span style={{ textAlign: 'right', fontWeight: 600, fontSize: '14px' }}>{String(value)}</span>;
  };

  const renderReadBackChip = (target: TargetViewModel) => {
    const level = target.readBackLevel;
    if (!level) {
      return (
        <span
          style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}
          data-testid="readback-chip"
        >
          {UNMEASURED} · {t('s1_not_measured')}
        </span>
      );
    }
    return (
      <span
        style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}
        data-testid="readback-chip"
        data-level={level}
      >
        {readBackLabel(level)}
      </span>
    );
  };

  const renderApplyChip = (target: TargetViewModel) => {
    const applyState = target.applyState;
    if (!applyState) {
      return (
        <span
          style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}
          data-testid="apply-chip"
        >
          {UNMEASURED} · {t('s1_not_measured')}
        </span>
      );
    }
    const isVerified = applyState === 'verified';
    // R19-2.3: 'unwritten' is a NEW value of the enum (DECISIONS 2026-10-18-01).
    // It goes through the catalog like every other value, and the machine
    // token stays in `data-apply-state` instead of the visible text.
    const isUnwritten = applyState === 'unwritten';
    const applyLabel = isVerified
      ? t('r14_apply_verified')
      : isUnwritten
        ? t('r19_apply_unwritten')
        : t('r14_apply_written_pending_reload');
    return (
      <span
        style={{
          padding: '4px 10px',
          borderRadius: '999px',
          fontSize: '12px',
          fontWeight: 600,
          background: isVerified ? 'var(--grn-t)' : 'var(--yel-t)',
          color: isVerified ? 'var(--grn-i)' : 'var(--yel-i)',
        }}
        data-testid="apply-chip"
        data-apply-state={applyState}
      >
        {applyLabel}
        {isUnwritten ? null : (
          <>
            {' · '}
            <span className="m">{applyState}</span>
          </>
        )}
      </span>
    );
  };

  const renderTierChip = (target: TargetViewModel) => {
    const tier = target.integrationTier;
    if (!tier) return null;
    return (
      <span
        style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}
        data-testid="tier-chip"
      >
        {t('r14_target_tier')} · <span className="m">{tier}</span>
      </span>
    );
  };

  const renderRow = (label: string, value: number | string | undefined, testId?: string) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 16px', padding: '10px 0', borderTop: '1.5px dashed var(--line)' }}>
      <span style={{ color: 'var(--muted)', fontSize: '14px' }}>{label}</span>
      {testId ? <span data-testid={testId}>{renderValue(value)}</span> : renderValue(value)}
    </div>
  );

  const renderTargetCard = (target: TargetViewModel) => (
    <section
      key={target.id}
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
      data-testid={`target-card-${target.id}`}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '22px', fontWeight: 800 }}>{target.name}</span>
          <span style={{ fontSize: '13px', color: 'var(--muted)' }} className="m">
            {target.addressOrPath}
          </span>
        </div>
        <span
          style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--fill)', color: 'var(--muted)' }}
          data-testid="target-mode-chip"
        >
          {t('t_mode')} · <span className="m">{target.mode ?? UNMEASURED}</span>
        </span>
      </div>

      {target.cloudSyncWarning === true && (
        <div style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '10px 14px', fontSize: '13px' }}>
          {t('t_9w')}
        </div>
      )}

      {target.policyCappedReason && (
        <div
          style={{
            background: 'var(--fill)',
            borderLeft: '4px solid var(--yel)',
            borderRadius: '12px',
            padding: '12px 14px',
            fontSize: '13px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
          data-testid="policy-cap-callout"
        >
          <span style={{ fontWeight: 700, color: 'var(--yel-i)' }}>▲ {t('ui0_d26_nine_cap_title')}</span>
          <span style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{t(target.policyCappedReason)}</span>
          <span style={{ color: 'var(--muted)', lineHeight: 1.4 }}>{t('ui0_d26_nine_cap_desc')}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        <span
          style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, background: 'var(--blue-sel)', color: 'var(--blue)' }}
          data-testid="supports-combos-chip"
        >
          {target.supportsCombos ? t('t_cc') : t('t_nc')}
        </span>
        {renderReadBackChip(target)}
        {renderApplyChip(target)}
        {renderTierChip(target)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {renderRow(t('t_r1'), target.providersSynced, 'providers-synced-count')}
        {renderRow(t('r14_target_combo_managed'), target.db?.combosManaged, 'combos-managed-count')}
        {renderRow(t('r14_target_combo_adopted'), target.db?.combosAdopted, 'combos-adopted-count')}
        {renderRow(t('r14_target_probe'), probeValueOf(target, t), 'target-probe-value')}
      </div>

      {viewMode === 'detail' && (
        <div style={{ fontSize: '12px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
          {target.integrationNotes ? t(target.integrationNotes) : UNMEASURED}
        </div>
      )}
    </section>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="targets-screen">
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 20px', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ maxWidth: '780px' }}>
          <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            {t('t_h')}
          </h1>
          <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
            {t('t_sub')}
          </p>
        </div>
        <div>
          <button
            type="button"
            data-testid="target-add-btn"
            disabled
            aria-describedby="target-add-disabled-reason"
            title={t('t_add_disabled_reason')}
            className="btn"
            style={{
              font: 'inherit',
              fontWeight: 700,
              fontSize: '14px',
              minHeight: '44px',
              padding: '0 20px',
              borderRadius: '999px',
              border: '1.5px solid var(--line)',
              cursor: 'not-allowed',
              background: 'transparent',
              color: 'var(--muted)',
              opacity: 0.6,
            }}
          >
            {t('t_add')}
          </button>
          <div
            id="target-add-disabled-reason"
            style={{
              fontSize: '12px',
              color: 'var(--muted)',
              marginTop: '6px',
              maxWidth: '240px',
            }}
          >
            {t('t_add_disabled_reason')}
          </div>
        </div>
      </div>

      {isSample && (
        <div
          data-testid="sample-badge"
          style={{ background: 'var(--yel-t)', color: 'var(--yel-i)', borderRadius: '14px', padding: '10px 16px', fontSize: '13px' }}
        >
          <b>{t('r14_sample_badge')}</b> — {t('r14_sample_badge_desc')}
        </div>
      )}

      {/* Summary chip: how many targets the VM reports */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        <div
          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '999px', background: 'var(--fill)', fontSize: '14px', fontWeight: 600 }}
          data-testid="targets-count-chip"
        >
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }}></span>
          <span>{t('r14_targets_count', { count: targets?.length ?? UNMEASURED })}</span>
        </div>
      </div>

      {/* Target cards: one card per target reported by the VM */}
      {targets && targets.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '20px' }}>
          {targets.map(renderTargetCard)}
        </div>
      ) : (
        <div
          data-testid="targets-empty-state"
          style={{
            background: 'var(--fill)',
            border: '1.5px dashed var(--dash)',
            borderRadius: '16px',
            padding: '24px',
            color: 'var(--muted)',
            fontSize: '14px',
          }}
        >
          {t('r14_targets_empty')}
        </div>
      )}

      {/* Bottom Sections: What targets + Safety rules */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '20px' }}>
        {/* What targets can you add */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('t_wh')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <b>{t('t_w1')}</b>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>9Router, OmniRoute ({t('t_w1b')})</span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <b>{t('t_w2')}</b>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>OpenCode, Hermes Agent, OpenClaw</span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <b>{t('t_w3')}</b>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('t_w3b')}</span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <b>{t('t_w4')}</b>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>JSON, YAML, TOML</span>
            </div>
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted)', lineHeight: 1.4 }}>
            {t('t_wn')}
          </p>
        </section>

        {/* Target safety rules */}
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
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('t_rl')}</h2>
          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', color: 'var(--muted)' }}>
            <li>{t('t_s1')}</li>
            <li>{t('t_s2')}</li>
            <li>{t('t_s3')}</li>
            <li>{t('t_s4')}</li>
          </ul>
        </section>
      </div>
    </div>
  );
};
