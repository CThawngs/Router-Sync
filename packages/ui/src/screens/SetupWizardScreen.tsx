import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useApi, type ApiClient } from '../api';
import type { SetupPreviewViewModel } from '../api/types';

/**
 * R17-2: the setup wizard is a pure function of its preview view-model.
 *
 * The R16 wizard printed four fixed numbers (86 / 2 / 0 / 0), two router
 * addresses and one config path as if it had detected them. They are claims
 * about this machine, so they now come from `SetupPreviewViewModel`; with no
 * preview (the S1 daemon has no such route) the wizard shows a dashed
 * "needs P3a" frame and no number at all.
 */
interface SetupWizardScreenProps {
  onFinish?: () => void;
  onSkip?: () => void;
  preview?: SetupPreviewViewModel | undefined;
  api?: ApiClient | undefined;
}

const UNMEASURED = '—';

export const SetupWizardScreen: React.FC<SetupWizardScreenProps> = ({
  onFinish,
  onSkip,
  preview: previewProp,
  api: apiProp,
}) => {
  const { t } = useI18n();
  const contextApi = useApi();
  const api = apiProp ?? contextApi;
  const [preview, setPreview] = useState<SetupPreviewViewModel | undefined>(previewProp);

  useEffect(() => {
    if (previewProp !== undefined) {
      setPreview(previewProp);
      return;
    }
    let active = true;
    api
      .getSetupPreview()
      .then((data) => {
        if (active) setPreview(data);
      })
      .catch(() => {
        if (active) setPreview(undefined);
      });
    return () => {
      active = false;
    };
  }, [previewProp, api]);

  const previewSource = preview?.meta?.source;
  const previewUnavailable = previewSource === 'unavailable';
  // R18-4 (AT-154): the illustrated walkthrough ("found 3 places", "first scan
  // done", the ticks next to each target) is SAMPLE content. It may only be
  // painted when the payload says so; with live or unavailable data every step
  // has to say what it actually measured, which here is nothing.
  const isSample = previewSource === 'sample';
  const previewValue = (value: number | undefined): string =>
    typeof value === 'number' ? String(value) : UNMEASURED;
  /** A detected address / path, or a dash. Never a guessed one. */
  const detectedValue = (id: string): string => {
    const found = preview?.detections?.find((item) => item.id === id);
    return found?.value ?? UNMEASURED;
  };
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [providerType, setProviderType] = useState('OpenRouter');
  const [keySource, setKeySource] = useState<'paste' | 'env' | 'router'>('paste');
  const [verifiedKey, setVerifiedKey] = useState(false);
  // R18-4: nothing is pre-selected. A pre-ticked row read as "detected on your
  // machine"; with no detection there is nothing to pre-tick. Sample content
  // re-selects the three demo targets once its payload arrives.
  const [selectedTargets, setSelectedTargets] = useState({
    omni: false,
    nine: false,
    oc: false,
  });

  useEffect(() => {
    if (previewSource === 'sample') {
      setSelectedTargets({ omni: true, nine: true, oc: true });
    }
  }, [previewSource]);
  const [approvalMode, setApprovalMode] = useState<'manual' | 'low' | 'auto'>('manual');

  const toggleTarget = (id: 'omni' | 'nine' | 'oc') => {
    setSelectedTargets((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }} data-testid="setup-wizard-screen">
      {/* Header */}
      <div style={{ maxWidth: '820px' }}>
        <h1 style={{ margin: '0 0 6px 0', fontSize: '32px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          {t('w_h')}
        </h1>
        <p style={{ margin: 0, fontSize: '15px', lineHeight: 1.5, color: 'var(--muted)' }}>
          {t('w_sub')}
        </p>
      </div>

      {/* Stepper Pills */}
      <div role="list" aria-label={t('w_steps')} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {[
          { n: 1, label: t('w_t1') },
          { n: 2, label: t('w_t2') },
          { n: 3, label: t('w_t3') },
          { n: 4, label: t('w_t4') },
        ].map((s) => {
          const isCurrent = step === s.n;
          const isDone = step > s.n;
          return (
            <div
              key={s.n}
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
                padding: '8px 18px 8px 8px',
                borderRadius: '999px',
                background: isCurrent ? 'var(--ink)' : 'var(--fill)',
                color: isCurrent ? 'var(--on-ink)' : isDone ? 'var(--text)' : 'var(--muted)',
                fontWeight: 700,
                fontSize: '14px',
              }}
            >
              <span
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: isCurrent ? 'var(--blue)' : isDone ? 'var(--grn)' : 'var(--line)',
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                }}
              >
                {isSample && isDone ? '✓' : s.n}
              </span>
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>

      {/* Step 1: Add first provider */}
      {step === 1 && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="wizard-step-1"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('w_1')}</h2>

          <div>
            <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '14px' }}>{t('w_1a')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {['OpenAI', 'Anthropic', 'Gemini', 'OpenRouter', 'Groq', 'Mistral', 'Ollama (local)', t('p_custom')].map((p) => {
                const on = providerType === p;
                return (
                  <button
                    key={p}
                    onClick={() => setProviderType(p)}
                    className="btn"
                    style={{
                      borderRadius: '999px',
                      padding: '8px 16px',
                      fontWeight: 600,
                      fontSize: '14px',
                      border: 0,
                      cursor: 'pointer',
                      background: on ? 'var(--ink)' : 'var(--fill)',
                      color: on ? 'var(--on-ink)' : 'var(--text)',
                    }}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--muted)' }}>{t('w_1n')}</div>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: '8px', fontSize: '14px' }}>{t('w_1b')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                    <span aria-hidden="true" style={{ flex: '0 0 18px', width: '18px', height: '18px', borderRadius: '50%', border: `2px solid ${on ? 'var(--blue)' : 'var(--dash)'}`, boxSizing: 'border-box', marginTop: '3px', background: on ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent' }} />
                    <span>
                      <span style={{ fontWeight: 700, display: 'block' }}>{opt.label}</span>
                      <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{opt.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
            <button
              onClick={() => setVerifiedKey(true)}
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
            {verifiedKey && isSample && (
              <span style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--grn-i)', fontWeight: 600 }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--grn)' }} />
                <span>{t('w_1ok')}</span>
              </span>
            )}
          </div>
        </section>
      )}

      {/* Step 2: Choose targets */}
      {step === 2 && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="wizard-step-2"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('w_2')}</h2>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)', lineHeight: 1.5 }}>
            {isSample ? t('w_2d') : t('r18_wizard_targets_unknown')}
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            <button
              onClick={() => toggleTarget('omni')}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 600,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 18px',
                borderRadius: '999px',
                border: `1.5px solid ${selectedTargets.omni ? 'var(--blue)' : 'var(--line)'}`,
                cursor: 'pointer',
                background: selectedTargets.omni ? 'var(--blue-sel)' : 'transparent',
                color: 'var(--text)',
              }}
            >
              {selectedTargets.omni ? '◼ ' : '◻ '}OmniRoute
            </button>
            <button
              onClick={() => toggleTarget('nine')}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 600,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 18px',
                borderRadius: '999px',
                border: `1.5px solid ${selectedTargets.nine ? 'var(--blue)' : 'var(--line)'}`,
                cursor: 'pointer',
                background: selectedTargets.nine ? 'var(--blue-sel)' : 'transparent',
                color: 'var(--text)',
              }}
            >
              {selectedTargets.nine ? '◼ ' : '◻ '}9Router
            </button>
            <button
              onClick={() => toggleTarget('oc')}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 600,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 18px',
                borderRadius: '999px',
                border: `1.5px solid ${selectedTargets.oc ? 'var(--blue)' : 'var(--line)'}`,
                cursor: 'pointer',
                background: selectedTargets.oc ? 'var(--blue-sel)' : 'transparent',
                color: 'var(--text)',
              }}
            >
              {selectedTargets.oc ? '◼ ' : '◻ '}OpenCode
            </button>
          </div>

          {previewUnavailable ? (
            <div
              data-testid="wizard-detections-unavailable"
              style={{ background: 'var(--fill)', border: '1.5px dashed var(--dash)', borderRadius: '16px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', color: 'var(--muted)' }}
            >
              <strong style={{ color: 'var(--text)' }}>{t('s1_needs_p3a')}</strong>
              <span>{t('w_detections_unavailable')}</span>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b>OmniRoute</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid="wizard-target-omniroute">
                  {detectedValue('omniroute')} · {t('w_2a')}
                </span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b>9Router</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid="wizard-target-9router">
                  {detectedValue('9router')} · {t('w_2a')}
                </span>
              </div>
              <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <b>OpenCode</b>
                <span style={{ fontSize: '13px', color: 'var(--muted)' }} data-testid="wizard-target-opencode">
                  {detectedValue('opencode')} · {t('w_2b')}
                </span>
              </div>
            </div>
          )}

          <div style={{ background: 'var(--fill)', borderRadius: '18px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <b>{t('w_2c')}</b>
            <span style={{ fontSize: '14px', color: 'var(--muted)', lineHeight: 1.4 }}>{t('w_2cd')}</span>
          </div>
        </section>
      )}

      {/* Step 3: Automation level */}
      {step === 3 && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="wizard-step-3"
        >
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{t('w_3')}</h2>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)' }}>{t('w_3d')}</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                  <span aria-hidden="true" style={{ flex: '0 0 18px', width: '18px', height: '18px', borderRadius: '50%', border: `2px solid ${on ? 'var(--blue)' : 'var(--dash)'}`, boxSizing: 'border-box', marginTop: '3px', background: on ? 'radial-gradient(var(--blue) 45%, transparent 50%)' : 'transparent' }} />
                  <span>
                    <span style={{ fontWeight: 700, display: 'block' }}>{opt.label}</span>
                    <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{opt.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', fontSize: '13px', color: 'var(--muted)' }}>
            {t('w_3n')}
          </div>

          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', color: 'var(--muted)' }}>
            <li>{t('w_3a')}</li>
            <li>{t('w_3b')}</li>
          </ul>
        </section>
      )}

      {/* Step 4: Preview what RouterSync would do */}
      {step === 4 && (
        <section
          style={{
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: '24px',
            padding: '24px',
            boxShadow: 'var(--sh-card)',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
          data-testid="wizard-step-4"
        >
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center', background: 'var(--grn-t)', borderRadius: '18px', padding: '18px 20px' }}>
            <span
              aria-hidden="true"
              style={{
                flex: '0 0 40px',
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'var(--grn)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '20px',
              }}
            >
              {isSample ? '✓' : '·'}
            </span>
            <div>
              {/* R18-4: "First scan done" is an illustration, not a
                  measurement. With live or unavailable data the card says that
                  no scan has run, and the preview frame under it explains why. */}
              <div style={{ fontWeight: 800, fontSize: '18px', color: 'var(--grn-i)' }}>
                {isSample ? t('w_4a') : t('r18_wizard_step4_unknown')}
              </div>
              <div style={{ fontSize: '14px', color: 'var(--muted)' }}>
                {isSample ? t('w_4b') : t('w_preview_unavailable')}
              </div>
            </div>
          </div>

          {previewUnavailable && (
            <div
              data-testid="wizard-preview-unavailable"
              style={{ background: 'var(--fill)', border: '1.5px dashed var(--dash)', borderRadius: '16px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', color: 'var(--muted)' }}
            >
              <strong style={{ color: 'var(--text)' }}>{t('s1_needs_p3a')}</strong>
              <span>{t('w_preview_unavailable')}</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted)' }}>{t('w_4c')}</span>
              <span style={{ fontSize: '30px', fontWeight: 800 }} data-testid="wizard-preview-models">
                {previewValue(preview?.modelsFound)}
              </span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted)' }}>{t('w_4d')}</span>
              <span style={{ fontSize: '30px', fontWeight: 800 }} data-testid="wizard-preview-combos">
                {previewValue(preview?.combosSuggested)}
              </span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted)' }}>{t('w_4e')}</span>
              <span style={{ fontSize: '30px', fontWeight: 800 }} data-testid="wizard-preview-billable">
                {previewValue(preview?.billableRequests)}
              </span>
            </div>
            <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted)' }}>{t('w_4f')}</span>
              <span style={{ fontSize: '30px', fontWeight: 800 }} data-testid="wizard-preview-written">
                {previewValue(preview?.writtenToConfig)}
              </span>
            </div>
          </div>

          <div style={{ background: 'var(--fill)', borderRadius: '16px', padding: '14px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.5 }}>
            {t('w_4g')}
          </div>
        </section>
      )}

      {/* Nav footer */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          {step > 1 && (
            <button
              onClick={() => setStep((prev) => (prev > 1 ? ((prev - 1) as any) : prev))}
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
              {t('w_back')}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
          {onSkip && (
            <button
              onClick={onSkip}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                minHeight: '44px',
                padding: '0 12px',
                border: 0,
                background: 'transparent',
                color: 'var(--link)',
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
            >
              {t('w_skip')}
            </button>
          )}

          {step < 4 ? (
            <button
              onClick={() => setStep((prev) => (prev < 4 ? ((prev + 1) as any) : prev))}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 24px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: 'var(--ink)',
                color: 'var(--on-ink)',
              }}
            >
              {t('w_next')}
            </button>
          ) : (
            <button
              onClick={onFinish}
              className="btn"
              style={{
                font: 'inherit',
                fontWeight: 700,
                fontSize: '14px',
                minHeight: '44px',
                padding: '0 24px',
                borderRadius: '999px',
                border: 0,
                cursor: 'pointer',
                background: 'var(--ink)',
                color: 'var(--on-ink)',
              }}
            >
              {t('w_fin')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
