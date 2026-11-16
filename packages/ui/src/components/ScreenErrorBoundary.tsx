import React from 'react';
import { t } from '../i18n';

/**
 * R16-1 (AT-146): one error boundary per screen.
 *
 * A single malformed field used to blank the WHOLE application: the React
 * tree unmounted and the user saw a white page with no way back. Every route
 * is now wrapped in its own boundary, so a screen that cannot render shows a
 * short, honest error card while the sidebar, the top bar and every other
 * screen keep working.
 */

/** Short, stable code the user can quote in a bug report. */
export const SCREEN_ERROR_CODE = 'RS-SCREEN-001';

interface ScreenErrorBoundaryProps {
  /** Screen id, shown in the fallback so the user can say which screen broke. */
  screenId: string;
  children: React.ReactNode;
}

interface ScreenErrorBoundaryState {
  error: Error | null;
}

export class ScreenErrorBoundary extends React.Component<
  ScreenErrorBoundaryProps,
  ScreenErrorBoundaryState
> {
  override state: ScreenErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ScreenErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The diagnostic belongs in the console, not in the user's face.
    console.error(
      `[routersync] screen "${this.props.screenId}" could not render (${SCREEN_ERROR_CODE})`,
      error,
      info.componentStack
    );
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div
          role="alert"
          data-testid="screen-error-fallback"
          data-screen-id={this.props.screenId}
          style={{
            background: 'var(--card)',
            border: '1px solid var(--cor-t)',
            borderRadius: '24px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <strong style={{ fontSize: '16px' }}>{t('err_boundary_title')}</strong>
          <span style={{ color: 'var(--muted)' }}>{t('err_boundary_body')}</span>
          <span className="m" style={{ fontSize: '12px', color: 'var(--faint)' }}>
            {t('err_boundary_code')}: {SCREEN_ERROR_CODE} ({this.props.screenId})
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}
