import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChroniclePulse } from './ChroniclePulse';
import { ChatEntry, ItemType, Link } from '../types';

const makeChat = (id: string, embedding?: number[], title = id): ChatEntry => ({
  id,
  type: ItemType.CHAT,
  title,
  content: `content of ${id}`,
  summary: `summary of ${id}`,
  tags: [],
  source: 'ChatGPT',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  embedding,
});

const current = makeChat('current', [1, 0, 0], 'Current Chat');
const strong = makeChat('strong', [0.95, 0.05, 0], 'Strong Match');
const weak = makeChat('weak', [0, 1, 0], 'Weak Match');
const archived = makeChat('archived', [1, 0, 0], 'Archived Match');
archived.archived = true;

const allChats = [current, strong, weak, archived];

describe('ChroniclePulse', () => {
  it('renders nothing when the current chat has no embedding', () => {
    const { container } = render(
      <ChroniclePulse
        chat={makeChat('no-emb')}
        allChats={allChats}
        allLinks={[]}
        onSelectChat={vi.fn()}
        onAddLink={vi.fn()}
      />
    );
    expect(container.textContent).toContain('No embedding available');
  });

  it('shows high-scoring matches with a match percentage', () => {
    render(
      <ChroniclePulse
        chat={current}
        allChats={allChats}
        allLinks={[]}
        onSelectChat={vi.fn()}
        onAddLink={vi.fn()}
      />
    );
    expect(screen.getByTestId('chronicle-pulse')).toBeTruthy();
    expect(screen.getByText('Strong Match')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.queryByText('Weak Match')).toBeNull();
    expect(screen.queryByText('Archived Match')).toBeNull();
  });

  it('marks already-linked matches and disables their link button', () => {
    const link: Link = { fromId: 'current', toId: 'strong', type: 'related', createdAt: Date.now() };
    render(
      <ChroniclePulse
        chat={current}
        allChats={allChats}
        allLinks={[link]}
        onSelectChat={vi.fn()}
        onAddLink={vi.fn()}
      />
    );
    const btn = screen.getByTestId('pulse-link-strong') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onAddLink when clicking connect on an unlinked match', () => {
    const onAddLink = vi.fn();
    render(
      <ChroniclePulse
        chat={current}
        allChats={allChats}
        allLinks={[]}
        onSelectChat={vi.fn()}
        onAddLink={onAddLink}
      />
    );
    fireEvent.click(screen.getByTestId('pulse-link-strong'));
    expect(onAddLink).toHaveBeenCalledWith('current', 'strong', 'related');
  });

  it('calls onSelectChat when clicking a match title', () => {
    const onSelectChat = vi.fn();
    render(
      <ChroniclePulse
        chat={current}
        allChats={allChats}
        allLinks={[]}
        onSelectChat={onSelectChat}
        onAddLink={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('pulse-open-strong'));
    expect(onSelectChat).toHaveBeenCalledWith(strong);
  });
});
