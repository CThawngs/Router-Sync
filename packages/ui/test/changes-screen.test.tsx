import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangesScreen } from '../src/screens/ChangesScreen';

describe('ChangesScreen Component (CP2)', () => {
  it('renders pending approval tab with gate proposal #a41f and all 5 actions', async () => {
    const onNavigate = vi.fn();
    render(<ChangesScreen onNavigate={onNavigate} />);

    // Header & Tab check
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Thay đổi|Changes/);
    expect(screen.getByRole('tab', { name: /Chờ duyệt|Waiting for approval/ })).toHaveAttribute('aria-selected', 'true');

    // The plan comes from the view-model (MockApi), so the screen loads it async.
    await waitFor(() => {
      expect(screen.getAllByText('acme-coder-2').length).toBeGreaterThanOrEqual(1);
    });

    // Gate section check
    expect(screen.getByRole('heading', { level: 2, name: /Đề xuất #a41f|Proposal #a41f/ })).toBeInTheDocument();

    // 5 summary tiles
    const summaryTiles = screen.getAllByTestId('summary-tile');
    expect(summaryTiles).toHaveLength(5);

    // 5 actions (model ids come from the plan view-model)
    expect(screen.getAllByText('acme-coder-2').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('acme-chat-4').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('lumen-flash-2').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('nova-chat-1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('coding-fast').length).toBeGreaterThanOrEqual(1);

    // Agent source tag (from the plan view-model)
    expect(screen.getAllByText(/OpenCode/).length).toBeGreaterThanOrEqual(1);

    // Diff section: the unified diff of the plan view-model
    const diff = screen.getByTestId('plan-diff');
    expect(diff.textContent).toContain('omniroute · combos · "coding-fast"');
    expect(diff.textContent).toContain('9router · provider_models');

    // Risk legend
    expect(screen.getByText(/Mức rủi ro nghĩa là gì|What do the risk levels mean/)).toBeInTheDocument();
  });

  it('handles approve and reject mock actions', async () => {
    const onNavigate = vi.fn();
    render(<ChangesScreen onNavigate={onNavigate} />);

    await waitFor(() => {
      expect(screen.getAllByText('acme-coder-2').length).toBeGreaterThanOrEqual(1);
    });

    // Click Approve
    const approveBtn = screen.getByRole('button', { name: /Duyệt và áp dụng|Approve and apply/ });
    fireEvent.click(approveBtn);

    expect(screen.getByText(/Đã duyệt \(dữ liệu mẫu\)|Approved \(sample data\)/)).toBeInTheDocument();

    // Click Reject
    const rejectBtn = screen.getByRole('button', { name: /Từ chối|Reject/ });
    fireEvent.click(rejectBtn);

    expect(screen.getByText(/Đã từ chối|Rejected/)).toBeInTheDocument();
  });

  it('switches to history tab and opens rollback preview modal', async () => {
    const onNavigate = vi.fn();
    render(<ChangesScreen onNavigate={onNavigate} />);

    await waitFor(() => {
      expect(screen.getAllByText('acme-coder-2').length).toBeGreaterThanOrEqual(1);
    });

    // Switch to history tab
    const historyTab = screen.getByRole('tab', { name: /Lịch sử và hoàn tác|History and undo/ });
    fireEvent.click(historyTab);

    expect(historyTab).toHaveAttribute('aria-selected', 'true');

    // Check timeline items (snapshot ids come from the snapshot view-model)
    await waitFor(() => {
      expect(screen.getAllByText('snap_yesterday_2114').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('snap_2days_ago').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('snap_4days_ago').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('snap_6days_ago').length).toBeGreaterThanOrEqual(1);

    // Check backups table undo buttons
    const undoButtons = screen.getAllByRole('button', { name: /Hoàn tác|Undo/ });
    expect(undoButtons.length).toBeGreaterThanOrEqual(3);

    // Click first undo button to open rollback preview modal
    fireEvent.click(undoButtons[0]!);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Xem trước hoàn tác snapshot \(dry-run\)|Snapshot undo preview/)).toBeInTheDocument();

    // Check confirmation checkbox per spec 34.3 dry-run safety
    const confirmCheckbox = screen.getByTestId('rollback-confirm-checkbox');
    fireEvent.click(confirmCheckbox);

    // Confirm rollback
    const confirmBtn = screen.getByRole('button', { name: /Xác nhận hoàn tác|Confirm undo/ });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    // Modal closed and success note shown
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Đã duyệt \(dữ liệu mẫu\)|Approved \(sample data\)/)).toBeInTheDocument();
  });
});
