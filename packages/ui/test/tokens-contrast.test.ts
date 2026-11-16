import { describe, it, expect } from 'vitest';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [r, g, b];
}

function getLuminance(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * (a[0] ?? 0) + 0.7152 * (a[1] ?? 0) + 0.0722 * (a[2] ?? 0);
}

function getContrastRatio(hex1: string, hex2: string): number {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const l1 = getLuminance(r1, g1, b1);
  const l2 = getLuminance(r2, g2, b2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Design Tokens Contrast Verification (AT-117, AT-72, AT-76)', () => {
  // Light theme tokens
  const light = {
    bg: '#F4F4FA',
    card: '#FFFFFF',
    fill: '#F1F1F8',
    text: '#14131F',
    muted: '#5B5A6B',
    ink: '#14131F',
    onInk: '#FFFFFF',
    blue: '#3D6BFF',
    link: '#2A52D6',
  };

  // Dark theme tokens
  const dark = {
    bg: '#0B0A14',
    card: '#171630',
    fill: '#222141',
    text: '#F3F2FB',
    muted: '#A9A8C4',
    ink: '#F3F2FB',
    onInk: '#14131F',
    link: '#9DB5FF',
  };

  it('Light Theme: ensures primary text on background, card, and fill has contrast >= 4.5:1', () => {
    const textOnBg = getContrastRatio(light.text, light.bg);
    const textOnCard = getContrastRatio(light.text, light.card);
    const textOnFill = getContrastRatio(light.text, light.fill);

    expect(textOnBg).toBeGreaterThanOrEqual(4.5);
    expect(textOnCard).toBeGreaterThanOrEqual(4.5);
    expect(textOnFill).toBeGreaterThanOrEqual(4.5);
  });

  it('Light Theme: ensures on-ink on ink has contrast >= 4.5:1', () => {
    const onInkOnInk = getContrastRatio(light.onInk, light.ink);
    expect(onInkOnInk).toBeGreaterThanOrEqual(4.5);
  });

  it('Dark Theme: ensures primary text on background, card, and fill has contrast >= 4.5:1', () => {
    const textOnBg = getContrastRatio(dark.text, dark.bg);
    const textOnCard = getContrastRatio(dark.text, dark.card);
    const textOnFill = getContrastRatio(dark.text, dark.fill);

    expect(textOnBg).toBeGreaterThanOrEqual(4.5);
    expect(textOnCard).toBeGreaterThanOrEqual(4.5);
    expect(textOnFill).toBeGreaterThanOrEqual(4.5);
  });

  it('Dark Theme: ensures on-ink on ink has contrast >= 4.5:1', () => {
    const onInkOnInk = getContrastRatio(dark.onInk, dark.ink);
    expect(onInkOnInk).toBeGreaterThanOrEqual(4.5);
  });

  it('Dark Theme: ensures link text has contrast >= 4.5:1 against card', () => {
    const linkOnCard = getContrastRatio(dark.link, dark.card);
    expect(linkOnCard).toBeGreaterThanOrEqual(4.5);
  });
});
