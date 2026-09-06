
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
  onDelete: vi.fn(),
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
    expect(screen.getByText('ChatGPT CHANNEL')).toBeInTheDocument();
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
    expect(screen.getByText('AUTHOR')).toBeInTheDocument(); // Default name for User
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there')).toBeInTheDocument();
  });

  it('shows visual asset section when assets are provided', () => {
    const chatWithAssets = { ...mockChat, assets: ['data:image/png;base64,123'] };
    render(<ChatViewer {...defaultProps} chat={chatWithAssets} />);
    expect(screen.getByText('INTEGRATED VISUAL ASSETS')).toBeInTheDocument();
  });

  it('enters edit mode and allows changing the title', () => {
    render(<ChatViewer {...defaultProps} />);
    const editButton = screen.getByTitle(/Edit/i || /Edit Icon/i) || screen.getAllByRole('button')[1];
    fireEvent.click(editButton);
    
    const titleInput = screen.getByDisplayValue('Quantum Engineering Log');
    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(titleInput).toHaveValue('New Title');
  });
});
