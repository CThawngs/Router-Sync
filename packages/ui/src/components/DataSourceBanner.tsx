import React from 'react';
import { t } from '../i18n';
import type { DataSource } from '../api/dataSource';

/**
 * R16-2.1: the global "where do these numbers come from" strip.
 *
 * It is driven by the client state (see `api/dataSource.ts`), not by a
 * hard-coded JSX string, so it can never claim "live" while the app is
 * showing sample data, and it can never stay silent while the daemon is
 * unreachable.
 */
export const DataSourceBanner: React.FC<{ source: DataSource }> = ({ source }) => {
  if (source === 'live') return null;

  const isSample = source === 'sample';

  return (
    <div
      role="status"
      data-testid={isSample ? 'data-source-sample' : 'data-source-unreachable'}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: '8px',
        padding: '10px 16px',
        borderRadius: '16px',
        border: `1px solid ${isSample ? 'var(--yel)' : 'var(--cor-t)'}`,
        background: isSample ? 'var(--fill)' : 'var(--cor-t)',
        color: 'var(--text)',
        fontSize: '13px',
      }}
    >
      <strong style={{ fontWeight: 800 }}>
        {isSample ? t('ds_sample_title') : t('ds_unreachable_title')}
      </strong>
      <span style={{ color: 'var(--muted)' }}>
        {isSample ? t('ds_sample_body') : t('ds_unreachable_body')}
      </span>
    </div>
  );
};
