import React from 'react';

interface IconProps {
  name: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, size = 22, className = '', style }) => {
  const getPath = () => {
    switch (name) {
      case 'overview':
        return <path d="M3 12h4l3-7 4 14 3-7h4" />;
      case 'changes':
        return <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 14l2 2 4-4" />;
      case 'combos':
        return <path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" />;
      case 'providers':
        return (
          <>
            <circle cx="8" cy="15" r="4" />
            <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
          </>
        );
      case 'targets':
        return <path d="M4 12h11M11 6l6 6-6 6M20 4v16" />;
      case 'models':
        return <path d="M4 6h16M4 12h16M4 18h10" />;
      case 'health':
        return <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z" />;
      case 'agents':
        return (
          <>
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <circle cx="12" cy="5" r="2" />
            <path d="M12 7v4M8 16h.01M16 16h.01" />
          </>
        );
      case 'guide':
        return <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM4 21V5M9 8h6M9 12h6" />;
      case 'settings':
        return (
          <>
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </>
        );
      case 'check':
        return <path d="M5 12.5l4.5 4.5L19 7.5" />;
      case 'sun':
        return (
          <>
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7" />
          </>
        );
      case 'moon':
        return <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z" />;
      case 'close':
        return <path d="M18 6L6 18M6 6l12 12" />;
      case 'menu':
        return <path d="M4 6h16M4 12h16M4 18h16" />;
      default:
        return null;
    }
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      style={{
        flex: `0 0 ${size}px`,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...style,
      }}
    >
      {getPath()}
    </svg>
  );
};
