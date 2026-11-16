import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  variant?: 'ink' | 'outline' | 'gradient' | 'secondary' | 'pause';
  style?: React.CSSProperties;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'ink',
  style,
  className = '',
  ...props
}) => {
  const baseStyle: React.CSSProperties = {
    font: 'inherit',
    fontWeight: 700,
    borderRadius: '999px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    transition: 'filter 0.15s ease, transform 0.15s ease',
  };

  let variantStyle: React.CSSProperties = {};
  switch (variant) {
    case 'ink':
      variantStyle = {
        minHeight: '48px',
        padding: '0 24px',
        border: 0,
        background: 'var(--ink)',
        color: 'var(--on-ink)',
      };
      break;
    case 'outline':
      variantStyle = {
        minHeight: '48px',
        padding: '0 22px',
        border: '2px solid var(--ink)',
        background: 'transparent',
        color: 'var(--text)',
      };
      break;
    case 'gradient':
      variantStyle = {
        minHeight: '48px',
        padding: '0 20px',
        border: 0,
        background: 'linear-gradient(135deg, #7C4DEB, #3A5FEA)',
        color: '#FFFFFF',
      };
      break;
    case 'secondary':
      variantStyle = {
        fontSize: '13px',
        minHeight: '44px',
        padding: '0 16px',
        border: '1.5px solid var(--line)',
        background: 'var(--card)',
        color: 'var(--text)',
      };
      break;
    case 'pause':
      variantStyle = {
        minHeight: '48px',
        padding: '0 20px',
        border: '2px solid var(--yel)',
        background: 'var(--yel-t)',
        color: 'var(--yel-i)',
      };
      break;
  }

  return (
    <button
      className={`btn ${className}`}
      style={{ ...baseStyle, ...variantStyle, ...style }}
      {...props}
    >
      {children}
    </button>
  );
};
