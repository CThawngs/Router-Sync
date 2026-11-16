import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { ScreenId } from './Sidebar';

export interface TourStep {
  id: string;
  targetSelector: string | null;
  titleKey: string;
  descKey: string;
  descKeyMock?: string;
  descKeyLive?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'intro',
    targetSelector: null,
    titleKey: 'tour_s1_title',
    descKey: 'tour_s1_desc',
  },
  {
    id: 'nav',
    targetSelector: '[data-tour="nav"]',
    titleKey: 'tour_s2_title',
    descKey: 'tour_s2_desc',
  },
  {
    id: 'banner',
    targetSelector: '[data-tour="hero"]',
    titleKey: 'tour_s3_title',
    descKey: 'tour_s3_desc',
  },
  {
    id: 'tiles',
    targetSelector: '[data-tour="tiles"]',
    titleKey: 'tour_s4_title',
    descKey: 'tour_s4_desc',
    descKeyMock: 'tour_s4_desc_mock',
    descKeyLive: 'tour_s4_desc_live',
  },
  {
    id: 'changes',
    targetSelector: '[data-tour="nav-changes"]',
    titleKey: 'tour_s5_title',
    descKey: 'tour_s5_desc',
    descKeyMock: 'tour_s5_desc_mock',
    descKeyLive: 'tour_s5_desc_live',
  },
  {
    id: 'targets',
    targetSelector: '[data-tour="nav-targets"]',
    titleKey: 'tour_s6_title',
    descKey: 'tour_s6_desc',
  },
  {
    id: 'emergency',
    targetSelector: '[data-tour="emergency"]',
    titleKey: 'tour_s7_title',
    descKey: 'tour_s7_desc',
  },
  {
    id: 'controls',
    targetSelector: '[data-tour="controls"]',
    titleKey: 'tour_s8_title',
    descKey: 'tour_s8_desc',
  },
  {
    id: 'complete',
    targetSelector: null,
    titleKey: 'tour_s9_title',
    descKey: 'tour_s9_desc',
  },
];

export interface TourModalProps {
  isOpen: boolean;
  isMock: boolean;
  onClose: () => void;
  onNavigate?: (screen: ScreenId) => void;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

interface TooltipPlacement {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  width: number;
}

export const TourModal: React.FC<TourModalProps> = ({
  isOpen,
  isMock,
  onClose,
  onNavigate,
}) => {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<TooltipPlacement | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const step = TOUR_STEPS[currentIndex] ?? TOUR_STEPS[0];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === TOUR_STEPS.length - 1;

  // Detect prefers-reduced-motion
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setPrefersReducedMotion(mq.matches);
      const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
      mq.addEventListener?.('change', handler);
      return () => mq.removeEventListener?.('change', handler);
    }
  }, []);

  // Update target rect and tooltip placement
  const updateTargetPosition = () => {
    if (!step?.targetSelector) {
      setTargetRect(null);
      setTooltipPlacement(null);
      return;
    }

    const el = document.querySelector<HTMLElement>(step.targetSelector);
    if (!el) {
      setTargetRect(null);
      setTooltipPlacement(null);
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setTargetRect(null);
      setTooltipPlacement(null);
      return;
    }

    const pad = 8;
    setTargetRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      right: rect.right,
    });

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardWidth = Math.min(440, vw - 32);
    const cardEstHeight = 240;

    const spaceBelow = vh - (rect.bottom + pad);
    const spaceAbove = rect.top - pad;
    const spaceRight = vw - (rect.right + pad);
    const spaceLeft = rect.left - pad;

    let placement: TooltipPlacement;
    if (spaceBelow >= cardEstHeight + 16) {
      const left = Math.max(16, Math.min(rect.left, vw - cardWidth - 16));
      placement = {
        top: rect.bottom + pad + 12,
        left,
        width: cardWidth,
      };
    } else if (spaceAbove >= cardEstHeight + 16) {
      const left = Math.max(16, Math.min(rect.left, vw - cardWidth - 16));
      placement = {
        bottom: vh - (rect.top - pad) + 12,
        left,
        width: cardWidth,
      };
    } else if (spaceRight >= cardWidth + 16) {
      const top = Math.max(16, Math.min(rect.top, vh - cardEstHeight - 16));
      placement = {
        top,
        left: rect.right + pad + 12,
        width: cardWidth,
      };
    } else if (spaceLeft >= cardWidth + 16) {
      const top = Math.max(16, Math.min(rect.top, vh - cardEstHeight - 16));
      placement = {
        top,
        right: vw - (rect.left - pad) + 12,
        width: cardWidth,
      };
    } else {
      placement = { width: cardWidth };
    }

    setTooltipPlacement(placement);
  };

  // Scroll target into view & update positions
  useEffect(() => {
    if (!isOpen) return;

    if (step?.targetSelector) {
      const el = document.querySelector<HTMLElement>(step.targetSelector);
      if (el && typeof el.scrollIntoView === 'function') {
        try {
          el.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'nearest',
            inline: 'nearest',
          });
        } catch {
          // ignore scroll errors
        }
      }
    }

    updateTargetPosition();
    const rafId = requestAnimationFrame(updateTargetPosition);
    return () => cancelAnimationFrame(rafId);
  }, [isOpen, currentIndex, prefersReducedMotion]);

  // Window resize & scroll listener with requestAnimationFrame
  useEffect(() => {
    if (!isOpen) return;

    let rafId: number | null = null;
    const handleUpdate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        updateTargetPosition();
      });
    };

    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [isOpen, currentIndex]);

  // Save triggering element and manage focus
  useEffect(() => {
    if (!isOpen) return;
    triggerRef.current = document.activeElement as HTMLElement | null;

    const timer = setTimeout(() => {
      if (modalRef.current) {
        const nextBtn =
          modalRef.current.querySelector<HTMLElement>('[data-testid="tour-next-btn"]') ??
          modalRef.current.querySelector<HTMLElement>('[data-testid="tour-finish-btn"]') ??
          modalRef.current.querySelector<HTMLElement>('button');
        if (nextBtn) {
          nextBtn.focus();
        } else {
          modalRef.current.focus();
        }
      }
    }, 10);

    return () => {
      clearTimeout(timer);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, currentIndex]);

  // Keyboard navigation & focus trapping
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentIndex((prev) => Math.min(prev + 1, TOUR_STEPS.length - 1));
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (e.key === 'Tab') {
        if (!modalRef.current) return;
        const focusable = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !step) return null;

  const descKey = (() => {
    if (isMock && step.descKeyMock) return step.descKeyMock;
    if (!isMock && step.descKeyLive) return step.descKeyLive;
    return step.descKey;
  })();

  const hasSpotlight = targetRect !== null && tooltipPlacement !== null;
  const stepRatioKey = `tour_step_${currentIndex + 1}_9`;

  return (
    <div
      className={`rs-tour-backdrop ${hasSpotlight ? 'rs-tour-spotlight-active' : ''}`}
      data-testid="tour-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: hasSpotlight ? 'transparent' : 'rgba(0, 0, 0, 0.65)',
        display: hasSpotlight ? 'block' : 'flex',
        alignItems: hasSpotlight ? undefined : 'center',
        justifyContent: hasSpotlight ? undefined : 'center',
        padding: hasSpotlight ? 0 : '16px',
        zIndex: 10000,
        pointerEvents: 'auto',
      }}
    >
      {/* Screen reader live region */}
      <div
        aria-live="polite"
        data-testid="tour-aria-live"
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {t('tour_step_announcement', {
          current: currentIndex + 1,
          total: TOUR_STEPS.length,
          title: t(step.titleKey),
        })}
      </div>

      {/* Spotlight ring cutout */}
      {hasSpotlight && (
        <div
          className="rs-tour-spotlight"
          data-testid="tour-spotlight-ring"
          style={{
            position: 'fixed',
            top: Math.max(0, targetRect.top - 8),
            left: Math.max(0, targetRect.left - 8),
            width: targetRect.width + 16,
            height: targetRect.height + 16,
            borderRadius: '16px',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
            border: '2px solid rgba(255, 255, 255, 0.9)',
            pointerEvents: 'none',
            zIndex: 10000,
            transition: prefersReducedMotion ? 'none' : 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        />
      )}

      {/* Tour card / tooltip */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-modal-title"
        aria-describedby="tour-modal-desc"
        className="rs-tour-modal"
        data-testid="tour-modal"
        data-step-id={step.id}
        tabIndex={-1}
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          border: '1.5px solid var(--line)',
          borderRadius: '24px',
          boxShadow: 'var(--sh)',
          width: '100%',
          maxWidth: hasSpotlight && tooltipPlacement?.width ? `${tooltipPlacement.width}px` : '480px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          position: hasSpotlight ? 'fixed' : 'relative',
          top: hasSpotlight && tooltipPlacement?.top !== undefined ? `${tooltipPlacement.top}px` : undefined,
          left: hasSpotlight && tooltipPlacement?.left !== undefined ? `${tooltipPlacement.left}px` : undefined,
          right: hasSpotlight && tooltipPlacement?.right !== undefined ? `${tooltipPlacement.right}px` : undefined,
          bottom: hasSpotlight && tooltipPlacement?.bottom !== undefined ? `${tooltipPlacement.bottom}px` : undefined,
          zIndex: 10002,
          transition: prefersReducedMotion ? 'none' : 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header bar: counter and close button */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span
              data-testid="tour-step-counter"
              style={{
                fontSize: '13px',
                fontWeight: 700,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {t(stepRatioKey)}
            </span>
            {/* Visual step dots */}
            <div
              aria-hidden="true"
              style={{
                display: 'flex',
                gap: '6px',
                alignItems: 'center',
              }}
            >
              {TOUR_STEPS.map((_, idx) => (
                <div
                  key={idx}
                  style={{
                    width: idx === currentIndex ? '16px' : '6px',
                    height: '6px',
                    borderRadius: '999px',
                    background:
                      idx === currentIndex ? 'var(--ink)' : 'var(--line)',
                    transition: prefersReducedMotion ? 'none' : 'all 0.2s ease',
                  }}
                />
              ))}
            </div>
          </div>

          <button
            type="button"
            data-testid="tour-close-btn"
            onClick={onClose}
            aria-label={t('tour_close')}
            className="btn"
            style={{
              border: '1px solid var(--line)',
              background: 'var(--fill)',
              color: 'var(--muted)',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {/* Content body */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <h2
            id="tour-modal-title"
            style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
            }}
          >
            {t(step.titleKey)}
          </h2>
          <p
            id="tour-modal-desc"
            style={{
              margin: 0,
              fontSize: '14px',
              lineHeight: 1.6,
              color: 'var(--muted)',
            }}
          >
            {t(descKey)}
          </p>
        </div>

        {/* Footer controls */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            paddingTop: '6px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <button
            type="button"
            data-testid="tour-skip-btn"
            onClick={onClose}
            className="btn"
            style={{
              background: 'transparent',
              border: 0,
              color: 'var(--muted)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              padding: '6px 10px',
            }}
          >
            {t('tour_skip')}
          </button>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              data-testid="tour-prev-btn"
              disabled={isFirst}
              aria-describedby={isFirst ? 'tour-prev-disabled-reason' : undefined}
              onClick={() => setCurrentIndex((prev) => Math.max(prev - 1, 0))}
              className="btn"
              style={{
                background: 'var(--fill)',
                border: '1px solid var(--line)',
                color: isFirst ? 'var(--line)' : 'var(--text)',
                borderRadius: '999px',
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isFirst ? 'not-allowed' : 'pointer',
                opacity: isFirst ? 0.5 : 1,
              }}
            >
              {t('tour_prev')}
            </button>
            <span
              id="tour-prev-disabled-reason"
              style={{ display: isFirst ? 'inline' : 'none', fontSize: '11px', color: 'var(--muted)' }}
            >
              {t('tour_first_step_disabled')}
            </span>

            {isLast && onNavigate && (
              <button
                type="button"
                data-testid="tour-guide-btn"
                onClick={() => {
                  onClose();
                  onNavigate('guide');
                }}
                className="btn"
                style={{
                  background: 'var(--fill)',
                  border: '1px solid var(--line)',
                  color: 'var(--text)',
                  borderRadius: '999px',
                  padding: '6px 14px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {t('tour_open_guide')}
              </button>
            )}

            {isLast ? (
              <button
                type="button"
                data-testid="tour-finish-btn"
                onClick={onClose}
                className="btn"
                style={{
                  background: 'var(--ink)',
                  border: 0,
                  color: 'var(--on-ink)',
                  borderRadius: '999px',
                  padding: '6px 18px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {t('tour_finish')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="tour-next-btn"
                onClick={() => setCurrentIndex((prev) => Math.min(prev + 1, TOUR_STEPS.length - 1))}
                className="btn"
                style={{
                  background: 'var(--ink)',
                  border: 0,
                  color: 'var(--on-ink)',
                  borderRadius: '999px',
                  padding: '6px 18px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {t('tour_next')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
