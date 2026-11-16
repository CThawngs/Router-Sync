import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ProvidersScreen } from '../src/screens/ProvidersScreen';
import { ModelsScreen } from '../src/screens/ModelsScreen';
import { AgentsScreen } from '../src/screens/AgentsScreen';
import { HttpApi } from '../src/api/http';
import { MockApi } from '../src/api/mock';
import { setLanguage, t, hasTranslation } from '../src/i18n';
import type { ModelViewModel, ProviderViewModel } from '../src/api/types';
import type { ApiClient } from '../src/api/client';

afterEach(() => {
  cleanup();
  setLanguage('vi');
  vi.restoreAllMocks();
});

const sampleProvider: ProviderViewModel = {
  id: 'openrouter',
  name: 'OpenRouter',
  modelsCount: 457,
  keySource: 'env_var',
  keySourceLabel: 'ENV: OPENROUTER_API_KEY',
  freeQuotaToday: 'Unlimited',
  lastScan: '2026-10-29 10:00:00',
  status: 'active',
  autoAddNew: true,
  autoRemoveGone: false,
};

const sampleModels: ModelViewModel[] = [
  {
    id: 'm-new',
    canonicalId: 'm-new',
    provider: 'openrouter',
    priceKind: 'free_forever',
    priceText: 'Free',
    context: '128k',
    score: 95,
    status: 'new',
    hasVision: 'no',
    aliases: [],
    whereUsed: ['test-combo'],
    scoreExplanation: 'Score explanation',
  },
  {
    id: 'm-due',
    canonicalId: 'm-due',
    provider: 'openrouter',
    priceKind: 'metered',
    priceText: '$1/M',
    context: '64k',
    score: 80,
    status: 'due_removal',
    hasVision: 'yes',
    aliases: [],
    whereUsed: [],
    scoreExplanation: 'Score explanation',
  },
  {
    id: 'm-removed',
    canonicalId: 'm-removed',
    provider: 'openrouter',
    priceKind: 'metered',
    priceText: '$2/M',
    context: '32k',
    score: 70,
    status: 'removed' as ModelViewModel['status'],
    hasVision: 'no',
    aliases: [],
    whereUsed: [],
    scoreExplanation: 'Score explanation',
  },
];

describe('Track UI: Providers and Models integration', () => {
  it('renders "Chạy theo dõi" button on Providers screen', async () => {
    setLanguage('vi');
    await act(async () => {
      render(<ProvidersScreen providers={[sampleProvider]} />);
    });
    const btn = screen.getByRole('button', { name: 'Chạy theo dõi' });
    expect(btn).toBeInTheDocument();
  });

  it('copies track watch command to clipboard when "Chạy theo dõi" is clicked', async () => {
    setLanguage('vi');
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    await act(async () => {
      render(<ProvidersScreen providers={[sampleProvider]} />);
    });
    const btn = screen.getByRole('button', { name: 'Chạy theo dõi' });
    fireEvent.click(btn);

    expect(writeTextMock).toHaveBeenCalledWith('routersync track watch');
    expect(screen.getByText(/routersync track watch/)).toBeInTheDocument();
  });

  it('renders "Lần quét gần nhất" field on provider cards', async () => {
    setLanguage('vi');
    await act(async () => {
      render(<ProvidersScreen providers={[sampleProvider]} />);
    });
    expect(screen.getByText('Lần quét gần nhất')).toBeInTheDocument();
    expect(screen.getByTestId('provider-last-scan').textContent).toBe('2026-10-29 10:00:00');
  });

  it('renders model tracking lifecycle badges: Mới phát hiện, Sắp bị loại, Bị loại', async () => {
    setLanguage('vi');
    await act(async () => {
      render(<ModelsScreen models={sampleModels} />);
    });
    expect(screen.getAllByText(/Mới phát hiện/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sắp bị loại/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bị loại/).length).toBeGreaterThan(0);
  });

  it('renders track status banner on ProvidersScreen when api returns tracking status', async () => {
    const mockClient = {
      isMock: vi.fn().mockReturnValue(false),
      getTrackStatus: vi.fn().mockResolvedValue({
        running: false,
        providerCount: 3,
        trackedCount: 2,
        totalModels: 45,
      }),
      getProviders: vi.fn().mockResolvedValue([sampleProvider]),
    } as unknown as ApiClient;

    await act(async () => {
      render(<ProvidersScreen api={mockClient} />);
    });
    const banner = screen.getByTestId('track-status-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('2/3');
    expect(banner.textContent).toContain('45');
  });

  it('renders track status banner on ModelsScreen with provider and model counts', async () => {
    const mockClient = {
      isMock: vi.fn().mockReturnValue(false),
      getTrackStatus: vi.fn().mockResolvedValue({
        running: false,
        providerCount: 5,
        trackedCount: 4,
        totalModels: 120,
      }),
      getTrackEvents: vi.fn().mockResolvedValue({ events: [] }),
      getModels: vi.fn().mockResolvedValue(sampleModels),
      getUnmatchedNames: vi.fn().mockResolvedValue([]),
      getUnknownTraits: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;

    await act(async () => {
      render(<ModelsScreen api={mockClient} />);
    });
    const banner = screen.getByTestId('track-status-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('4/5');
    expect(banner.textContent).toContain('120');
  });

  it('renders track events count badge on ModelsScreen when events exist', async () => {
    const mockClient = {
      isMock: vi.fn().mockReturnValue(false),
      getTrackStatus: vi.fn().mockResolvedValue({
        running: false,
        providerCount: 2,
        trackedCount: 2,
        totalModels: 10,
      }),
      getTrackEvents: vi.fn().mockResolvedValue({
        events: [
          { timestamp: '2026-10-30T00:00:00Z', type: 'model_added', provider: 'nvidia', models: ['m1'] },
          { timestamp: '2026-10-30T01:00:00Z', type: 'model_removed', provider: 'nvidia', models: ['m2'] },
        ],
      }),
      getModels: vi.fn().mockResolvedValue(sampleModels),
      getUnmatchedNames: vi.fn().mockResolvedValue([]),
      getUnknownTraits: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;

    await act(async () => {
      render(<ModelsScreen api={mockClient} />);
    });
    const badge = screen.getByTestId('track-events-count');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('2');
  });

  it('does not render track events badge on ModelsScreen when events are empty', async () => {
    const mockClient = {
      isMock: vi.fn().mockReturnValue(false),
      getTrackStatus: vi.fn().mockResolvedValue({
        running: false,
        providerCount: 2,
        trackedCount: 2,
        totalModels: 10,
      }),
      getTrackEvents: vi.fn().mockResolvedValue({ events: [] }),
      getModels: vi.fn().mockResolvedValue(sampleModels),
      getUnmatchedNames: vi.fn().mockResolvedValue([]),
      getUnknownTraits: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;

    await act(async () => {
      render(<ModelsScreen api={mockClient} />);
    });
    expect(screen.queryByTestId('track-events-count')).toBeNull();
  });

  it('renders connected MCP clients banner on AgentsScreen when clients exist', async () => {
    const mockClient = {
      getMcpClients: vi.fn().mockResolvedValue({
        clients: [
          { name: 'claude-code', version: '1.2.3', connectedAt: '2026-10-30T00:00:00Z' },
          { name: 'codex', version: '2.0.0', connectedAt: '2026-10-30T01:00:00Z' },
        ],
      }),
    } as unknown as ApiClient;

    await act(async () => {
      render(<AgentsScreen api={mockClient} />);
    });
    expect(screen.getByTestId('mcp-clients-banner')).toBeInTheDocument();
    expect(screen.getAllByTestId('mcp-client-item').length).toBe(2);
  });

  it('renders MCP client name and version correctly on AgentsScreen', async () => {
    const mockClient = {
      getMcpClients: vi.fn().mockResolvedValue({
        clients: [
          { name: 'hermes-agent', version: '0.9.1' },
        ],
      }),
    } as unknown as ApiClient;

    await act(async () => {
      render(<AgentsScreen api={mockClient} />);
    });
    const item = screen.getByTestId('mcp-client-item');
    expect(item.textContent).toContain('hermes-agent');
    expect(item.textContent).toContain('v0.9.1');
  });

  it('does not render MCP clients banner on AgentsScreen when client list is empty', async () => {
    const mockClient = {
      getMcpClients: vi.fn().mockResolvedValue({ clients: [] }),
    } as unknown as ApiClient;

    await act(async () => {
      render(<AgentsScreen api={mockClient} />);
    });
    expect(screen.queryByTestId('mcp-clients-banner')).toBeNull();
  });

  it('HttpApi has getTrackStatus method defined', () => {
    const api = new HttpApi('http://127.0.0.1:3128');
    expect(typeof api.getTrackStatus).toBe('function');
  });

  it('HttpApi has getTrackEvents method defined', () => {
    const api = new HttpApi('http://127.0.0.1:3128');
    expect(typeof api.getTrackEvents).toBe('function');
  });

  it('HttpApi has getMcpClients method defined', () => {
    const api = new HttpApi('http://127.0.0.1:3128');
    expect(typeof api.getMcpClients).toBe('function');
  });

  it('MockApi returns track status with zero-token counts', async () => {
    const mock = new MockApi();
    const status = await mock.getTrackStatus();
    expect(status.providerCount).toBeGreaterThan(0);
    expect(status.trackedCount).toBeGreaterThan(0);
    expect(status.totalModels).toBeGreaterThan(0);
  });

  it('MockApi returns track events containing model added entries', async () => {
    const mock = new MockApi();
    const events = await mock.getTrackEvents();
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events[0]?.type).toBe('model_added');
  });

  it('MockApi returns default connected MCP clients', async () => {
    const mock = new MockApi();
    const res = await mock.getMcpClients();
    expect(res.clients.length).toBeGreaterThan(0);
    expect(res.clients[0]?.name).toBe('claude-code');
  });

  it('i18n contains tracking and agent banner keys in both vi and en', () => {
    setLanguage('vi');
    expect(hasTranslation('track_banner_title')).toBe(true);
    expect(hasTranslation('agents_connected_banner')).toBe(true);
    expect(t('track_banner_title')).toContain('Tự động theo dõi');

    setLanguage('en');
    expect(hasTranslation('track_banner_title')).toBe(true);
    expect(hasTranslation('agents_connected_banner')).toBe(true);
    expect(t('track_banner_title')).toContain('Auto-tracking');
  });
});

