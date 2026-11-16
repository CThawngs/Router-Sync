import React from 'react';
import { t } from '../i18n';
import { Button } from './Button';
import { Glyph } from './Badge';

interface PausedBannerProps {
  onTogglePause: () => void;
}

export const PausedBanner: React.FC<PausedBannerProps> = ({ onTogglePause }) => {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 16px',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--yel-t2)',
        border: '2px solid var(--yel)',
        borderRadius: '20px',
        padding: '14px 20px',
      }}
    >
      <span style={{ display: 'flex', gap: '10px', alignItems: 'baseline', color: 'var(--text)' }}>
        <Glyph type="warn" />
        <span>
          <b>{t('pz_t')}</b> {t('pz_d')}
        </span>
      </span>
      <Button variant="ink" onClick={onTogglePause} style={{ minHeight: '44px' }}>
        {t('resume')}
      </Button>
    </div>
  );
};

interface SampleBannerProps {
  onStartSetup: () => void;
}

export const SampleBanner: React.FC<SampleBannerProps> = ({ onStartSetup }) => {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px 16px',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--blue-t)',
        borderRadius: '20px',
        padding: '14px 20px',
      }}
    >
      <span style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
        <span
          aria-hidden="true"
          className="m"
          style={{
            flex: '0 0 18px',
            height: '18px',
            borderRadius: '50%',
            background: 'var(--blue)',
            color: '#FFFFFF',
            fontSize: '12px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          i
        </span>
        <span>{t('fb_t')}</span>
      </span>
      <Button variant="secondary" onClick={onStartSetup}>
        {t('fb_b')}
      </Button>
    </div>
  );
};
