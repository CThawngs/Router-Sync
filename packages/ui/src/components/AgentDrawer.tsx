import React, { useState } from 'react';
import { t } from '../i18n';
import { Note } from './Card';
import { Button } from './Button';
import { Glyph } from './Badge';

interface AgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onGoChanges: () => void;
  onGoSettingsAi: () => void;
}

export const AgentDrawer: React.FC<AgentDrawerProps> = ({
  isOpen,
  onClose,
  onGoChanges,
  onGoSettingsAi,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const defaultPrompt = t('ui0_agent_prompt');

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(defaultPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  return (
    <section
      aria-labelledby="ag-d"
      style={{
        boxSizing: 'border-box',
        background: 'var(--card)',
        borderRadius: '24px',
        padding: '24px',
        boxShadow: 'var(--sh)',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        border: '2px solid var(--vio-i)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
        <h2 id="ag-d" style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>
          {t('ag_t')}
        </h2>
        <Button variant="secondary" onClick={onClose} aria-label={t('close')}>
          {t('close')}
        </Button>
      </div>

      <Note>{t('ag_n')}</Note>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
          gap: '14px',
          alignItems: 'start',
        }}
      >
        {/* Bước 1 */}
        <div
          style={{
            background: 'var(--fill)',
            borderRadius: '18px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ fontWeight: 800 }}>
            <span className="m">1</span> {t('ag_s1')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px' }}>
            <span>
              <Glyph type="ok" style={{ marginRight: '6px' }} />
              Claude Code <span style={{ color: 'var(--muted)' }}>{t('ag_on')}</span>
            </span>
            <span>
              <Glyph type="ok" style={{ marginRight: '6px' }} />
              OpenCode <span style={{ color: 'var(--muted)' }}>{t('ag_on')}</span>
            </span>
            <span>
              <Glyph type="unk" style={{ marginRight: '6px' }} />
              Hermes Agent <span style={{ color: 'var(--muted)' }}>{t('ag_off')}</span>
            </span>
          </div>
          <Button variant="secondary" onClick={onGoSettingsAi} style={{ alignSelf: 'flex-start', marginTop: '6px' }}>
            {t('ag_reg')}
          </Button>
        </div>

        {/* Bước 2 */}
        <div
          style={{
            background: 'var(--fill)',
            borderRadius: '18px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ fontWeight: 800 }}>
            <span className="m">2</span> {t('ag_s2')}
          </div>
          <div
            className="m"
            style={{
              boxSizing: 'border-box',
              background: 'var(--ink)',
              color: 'var(--on-ink)',
              borderRadius: '14px',
              padding: '12px 14px',
              fontSize: '12px',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {defaultPrompt}
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' }}>
            <Button variant="secondary" onClick={handleCopy}>
              {t('ag_copy')}
            </Button>
            {copied && (
              <span role="status" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--grn-g)' }}>
                <Glyph type="ok" style={{ marginRight: '4px' }} />
                {t('ag_copied')}
              </span>
            )}
          </div>
        </div>

        {/* Bước 3 */}
        <div
          style={{
            background: 'var(--fill)',
            borderRadius: '18px',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ fontWeight: 800 }}>
            <span className="m">3</span> {t('ag_s3')}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text)' }}>{t('ag_s3d')}</div>
          <Button variant="secondary" onClick={onGoChanges} style={{ alignSelf: 'flex-start', marginTop: '6px' }}>
            {t('ag_go')}
          </Button>
        </div>
      </div>

      <Note>{t('ag_n2')}</Note>
    </section>
  );
};
