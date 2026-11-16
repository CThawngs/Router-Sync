import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CombosScreen } from '../src/screens/CombosScreen';
import { MockApi } from '../src/api/mock';

describe('CombosScreen Component (CP2)', () => {
  it('renders View Combos tab with 4 combo pickers, ladder steps, simulator, and desired vs actual table', async () => {
    const onNavigate = vi.fn();
    const api = new MockApi();
    render(<CombosScreen onNavigate={onNavigate} api={api} />);

    // Header & Tab check
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Combo|Combos/);
    expect(screen.getByRole('tab', { name: /Xem combo|View combos/ })).toHaveAttribute('aria-selected', 'true');

    // The 4 prototype combos now come from the VM (MockApi), not from a
    // hard-coded picker in the screen.
    await waitFor(() => {
      expect(screen.getAllByText('coding-fast').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('free-all').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('smart-cascade').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('my-old-combo').length).toBeGreaterThanOrEqual(1);

    // Default ladder (first combo of the VM: coding-fast)
    await waitFor(() => {
      expect(screen.getAllByText('kite-code-3').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('lumen-flash-2').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nova-chat-1').length).toBeGreaterThanOrEqual(1);

    // Simulator interactive toggling
    expect(screen.getByText(/Mọi model đều khỏe|All models are healthy/)).toBeInTheDocument();
    const kiteFailBtn = screen.getByRole('radio', { name: /kite-code-3 hỏng|kite-code-3 fails/ });
    fireEvent.click(kiteFailBtn);
    expect(screen.getAllByText(/lumen-flash-2/).length).toBeGreaterThanOrEqual(1);

    // Desired vs actual table
    expect(screen.getByText(/Mong muốn so với thực tế|Desired vs actual/)).toBeInTheDocument();
  });

  it('switches between combo picker tabs and updates ladder', async () => {
    const onNavigate = vi.fn();
    const api = new MockApi();
    render(<CombosScreen onNavigate={onNavigate} api={api} />);

    await waitFor(() => {
      expect(screen.getAllByText('coding-fast').length).toBeGreaterThanOrEqual(1);
    });

    // Click free-all combo
    const freeAllBtn = screen.getByRole('tab', { name: /^free-all/ });
    fireEvent.click(freeAllBtn);

    // Verify the free-all steps of the VM appear (the ladder follows the VM)
    await waitFor(() => {
      expect(screen.getAllByText('lumen-flash-2').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('lumen-dense-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('acme-chat-3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nova-vision-1').length).toBeGreaterThanOrEqual(1);
  });

  it('switches to builder tab, toggles filters and recipes, and opens YAML modal', async () => {
    const onNavigate = vi.fn();
    const api = new MockApi();
    render(<CombosScreen onNavigate={onNavigate} api={api} />);

    await waitFor(() => {
      expect(screen.getAllByText('coding-fast').length).toBeGreaterThanOrEqual(1);
    });

    // Switch to Builder tab
    const buildTab = screen.getByRole('tab', { name: /Tạo hoặc sửa|Create or edit/ });
    fireEvent.click(buildTab);
    expect(buildTab).toHaveAttribute('aria-selected', 'true');

    // Recipes exist
    expect(screen.getByText(/Free & mạnh nhất trước|Free and strongest/)).toBeInTheDocument();
    expect(screen.getByText(/Code nhanh|Fast coding/)).toBeInTheDocument();

    // Live preview count starts at 5
    expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1);

    // Toggle vision trait filter
    const visionBtn = screen.getByRole('button', { name: /\+ Có vision|Has vision/ });
    fireEvent.click(visionBtn);

    // Click recipe "Needs vision"
    const visionRecipe = screen.getByText(/Cần vision|Needs vision/);
    fireEvent.click(visionRecipe);

    // Open YAML modal
    const yamlBtn = screen.getByRole('button', { name: /Xem như YAML|View as YAML/ });
    fireEvent.click(yamlBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Cấu hình Combo dạng YAML|Combo configuration as YAML/)).toBeInTheDocument();

    // Close YAML modal
    const closeBtn = screen.getByRole('button', { name: /Đóng|Close/ });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
