import React from 'react';
import { Card } from '../components/Card';
import { t } from '../i18n';

interface PlaceholderProps {
  titleKey: string;
  descKey: string;
}

export const ScreenPlaceholder: React.FC<PlaceholderProps> = ({ titleKey, descKey }) => {
  return (
    <Card id="ph-card" title={t(titleKey)}>
      <p style={{ color: 'var(--muted)', fontSize: '16px' }}>{t(descKey)}</p>
      <div
        style={{
          padding: '40px 20px',
          background: 'var(--fill)',
          borderRadius: '16px',
          textAlign: 'center',
          color: 'var(--muted)',
        }}
      >
        <span style={{ fontWeight: 700 }}>{t('ui0_placeholder_notice')}</span>
      </div>
    </Card>
  );
};
