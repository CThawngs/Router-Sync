import React from 'react';

interface CardProps {
  children: React.ReactNode;
  id?: string;
  title?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  role?: string;
  ariaLabelledBy?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  id,
  title,
  className = '',
  style,
  role,
  ariaLabelledBy,
}) => {
  return (
    <section
      id={id}
      role={role}
      aria-labelledby={ariaLabelledBy || (title ? `${id}-title` : undefined)}
      className={className}
      style={{
        boxSizing: 'border-box',
        background: 'var(--card)',
        borderRadius: '24px',
        padding: '24px',
        boxShadow: 'var(--sh)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        minWidth: 0,
        ...style,
      }}
    >
      {title && (
        <h2
          id={ariaLabelledBy || (id ? `${id}-title` : undefined)}
          style={{
            margin: 0,
            fontSize: '20px',
            fontWeight: 800,
            letterSpacing: '-0.01em',
            color: 'var(--text)',
          }}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
};

export const Note: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
        background: 'var(--blue-t)',
        borderRadius: '16px',
        padding: '12px 16px',
        fontSize: '14px',
        color: 'var(--text)',
        ...style,
      }}
    >
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
          marginTop: '2px',
        }}
      >
        i
      </span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
};

export const WarnNote: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        gap: '10px',
        alignItems: 'flex-start',
        background: 'var(--yel-t)',
        border: '1px solid var(--yel)',
        borderRadius: '16px',
        padding: '12px 16px',
        fontSize: '14px',
        color: 'var(--text)',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        className="m"
        style={{
          flex: '0 0 18px',
          height: '18px',
          borderRadius: '50%',
          background: 'var(--yel)',
          color: '#14131F',
          fontSize: '12px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: '2px',
        }}
      >
        !
      </span>
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
};
