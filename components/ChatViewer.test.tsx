
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatViewer } from './ChatViewer';
import { ItemType, AIProvider, Theme } from '../types';

const mockChat = {
  id: 'test-123',
  type: ItemType.CHAT,
  title: 'Quantum Engineering Log',
  content: 'User: Hello\n\nAssistant: Hi there',
  summary: 'A test discussion about quantum mechanics',
  tags: ['physics', 'demo'],
  source: 'ChatGPT',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockSettings = {
  theme: Theme.LIGHT,
  aiProvider: AIProvider.GEMINI,
  preferredModel: 'gemini-3-flash-preview',
  customEndpoint: '',
  relatedChatsLimit: 5,
  availableModels: [],
};

const defaultProps = {
  chat: mockChat,
  allChats: [mockChat],
  allLinks: [],
  onClose: vi.fn(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onUpdate: vi.fn(),
  onSelectChat: vi.fn(),
  onAddLink: vi.fn(),
  onRemoveLink: vi.fn(),
  settings: mockSettings,
  onTagClick: vi.fn(),
};

describe('ChatViewer Component', () => {
  it('renders chat title and source correctly', () => {
    render(<ChatViewer {...defaultProps} />);
    expect(screen.getByText('Quantum Engineering Log')).toBeInTheDocument();
    expect(screen.getByText(/chatgpt channel/i)).toBeInTheDocument();
  });

  it('renders the summary abstract', () => {
    render(<ChatViewer {...defaultProps} />);
    expect(screen.getByText('A test discussion about quantum mechanics')).toBeInTheDocument();
  });

  it('displays tags as interactive buttons', () => {
    render(<ChatViewer {...defaultProps} />);
    const tagButton = screen.getByText('physics');
    expect(tagButton).toBeInTheDocument();
    
    fireEvent.click(tagButton);
    expect(defaultProps.onTagClick).toHaveBeenCalledWith('physics');
  });

  it('renders the conversation turns', () => {
    render(<ChatViewer {...defaultProps} />);
    // "User Channel" and "Assistant Channel" (derived from logic)
    expect(screen.getByText(/author/i)).toBeInTheDocument(); // Default name for User
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there')).toBeInTheDocument();
  });

  it('shows visual asset section when assets are provided', () => {
    const chatWithAssets = { ...mockChat, assets: ['data:image/png;base64,123'] };
    render(<ChatViewer {...defaultProps} chat={chatWithAssets} />);
    expect(screen.getByText(/integrated visual assets/i)).toBeInTheDocument();
  });

  it('enters edit mode and allows changing the title', () => {
    render(<ChatViewer {...defaultProps} />);
    const editButton = screen.getByTitle('Edit');
    fireEvent.click(editButton);
    
    const titleInput = screen.getByDisplayValue('Quantum Engineering Log');
    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(titleInput).toHaveValue('New Title');
  });

  it('adds a manual tag in edit mode and saves it', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Edit'));

    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: '  Gaia: Hypothesis ' } });
    fireEvent.click(screen.getByText('Add'));
    fireEvent.click(screen.getByText('Commit Synthesis'));

    const updated = defaultProps.onUpdate.mock.calls.at(-1)?.[0];
    expect(updated.tags).toEqual(['physics', 'demo', 'gaia:hypothesis']);
  });

  it('does not add an empty or duplicate tag', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Edit'));

    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: '   ' } });
    expect(screen.getByText('Add')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: 'Physics' } });
    fireEvent.click(screen.getByText('Add'));
    fireEvent.click(screen.getByText('Commit Synthesis'));

    const updated = defaultProps.onUpdate.mock.calls.at(-1)?.[0];
    expect(updated.tags).toEqual(['physics', 'demo']);
  });

  it('removes a tag in edit mode', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Edit'));

    fireEvent.click(screen.getByLabelText('Remove tag physics'));
    fireEvent.click(screen.getByText('Commit Synthesis'));

    const updated = defaultProps.onUpdate.mock.calls.at(-1)?.[0];
    expect(updated.tags).toEqual(['demo']);
  });

  it('restores the original tags when discarding', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);
    fireEvent.click(screen.getByTitle('Edit'));

    fireEvent.click(screen.getByLabelText('Remove tag physics'));
    fireEvent.click(screen.getByText('Discard'));
    fireEvent.click(screen.getByTitle('Edit'));

    expect(screen.getByText('physics')).toBeInTheDocument();
    expect(defaultProps.onUpdate).not.toHaveBeenCalled();
  });

  it('adds a tag straight from the object view without edit mode', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: 'Archive: Inbox' } });
    fireEvent.click(screen.getByText('Add'));

    expect(defaultProps.onUpdate).toHaveBeenCalledTimes(1);
    expect(defaultProps.onUpdate.mock.calls[0][0].tags).toEqual(['physics', 'demo', 'archive:inbox']);
    expect(screen.queryByLabelText('New tag')).not.toBeInTheDocument();
  });

  it('closes the quick-add field on Escape without saving', () => {
    defaultProps.onUpdate.mockClear();
    render(<ChatViewer {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    fireEvent.change(screen.getByLabelText('New tag'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByLabelText('New tag'), { key: 'Escape' });

    expect(screen.queryByLabelText('New tag')).not.toBeInTheDocument();
    expect(defaultProps.onUpdate).not.toHaveBeenCalled();
  });
});
