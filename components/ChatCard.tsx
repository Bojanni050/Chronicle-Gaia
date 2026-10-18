
import React from 'react';
import { ChatEntry, SourceType, ItemType } from '../types';
import { TagIcon, MessageIcon, PencilIcon, OpenAIIcon, ClaudeIcon, GeminiIcon, MistralIcon, TerminalIcon } from './Icons';

interface ChatCardProps {
  chat: ChatEntry;
  onClick: () => void;
  isActive?: boolean;
  onTagClick: (tag: string) => void;
  activeRelatedTags?: string[];
}

const SourceBadge: React.FC<{ source: string; type: ItemType }> = ({ source, type }) => {
  const isNote = type === ItemType.NOTE;
  
  const renderIcon = () => {
    if (isNote) return <PencilIcon className="w-2.5 h-2.5" />;
    
    const s = source.toLowerCase();
    if (s.includes('chatgpt')) return <OpenAIIcon className="w-2.5 h-2.5" />;
    if (s.includes('claude')) return <ClaudeIcon className="w-2.5 h-2.5" />;
    if (s.includes('gemini')) return <GeminiIcon className="w-2.5 h-2.5" />;
    if (s.includes('mistral')) return <MistralIcon className="w-2.5 h-2.5" />;
    if (s.includes('local') || s.includes('qwen') || s.includes('llama')) return <TerminalIcon className="w-2.5 h-2.5" />;
    
    return <MessageIcon className="w-2.5 h-2.5" />;
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className={`p-1 rounded-md shrink-0 ${isNote ? 'bg-[#D27D66]/15 text-[#D27D66]' : 'bg-[#B2C9A1]/20 text-[#2C3E21]'}`}>
        {renderIcon()}
      </div>
      <span className="text-[10px] font-semibold text-moss-brown dark:text-stone-400">
        {source}
      </span>
    </div>
  );
};

export const ChatCard: React.FC<ChatCardProps> = ({ chat, onClick, isActive, onTagClick, activeRelatedTags = [] }) => {
  const dateStr = new Date(chat.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const isNote = chat.type === ItemType.NOTE;

  return (
    <div
      onClick={onClick}
      className={`relative px-4 py-3.5 cursor-pointer transition-colors group border-b border-sandstone/60 dark:border-stone-800 last:border-b-0 ${
        isActive
          ? 'bg-paper dark:bg-stone-900 rounded-xl border-transparent ring-1 ring-sage-green shadow-sm'
          : 'hover:bg-hover-bg/70 dark:hover:bg-stone-900/60 rounded-xl border-b-sandstone/60'
      }`}
    >
      <h3 className="text-sm font-bold line-clamp-1 leading-snug text-earth-dark dark:text-stone-100 font-sans">
        {chat.title}
      </h3>

      <p className="text-xs mt-1 line-clamp-2 leading-relaxed text-moss-brown dark:text-stone-400">
        {chat.summary}
      </p>

      <div className="flex items-center justify-between mt-2.5 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <SourceBadge source={chat.source} type={chat.type || ItemType.CHAT} />
          {chat.tags.slice(0, 2).map(tag => {
            const isFiltering = activeRelatedTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={(e) => { e.stopPropagation(); onTagClick(tag); }}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-md transition-colors truncate ${
                  isFiltering
                    ? isNote ? 'bg-terracotta text-white' : 'bg-sage-green text-white'
                    : 'bg-tag-bg dark:bg-stone-800 text-moss-brown hover:bg-sage-green/20'
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-moss-brown/80 dark:text-stone-500 shrink-0">{dateStr}</span>
      </div>
    </div>
  );
};
