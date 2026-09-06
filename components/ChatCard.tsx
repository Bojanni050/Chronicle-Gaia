
import React from 'react';
import { ChatEntry, SourceType, ItemType } from '../types';
import { TagIcon, MessageIcon, PencilIcon, OpenAIIcon, ClaudeIcon, GeminiIcon, TerminalIcon } from './Icons';

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
    if (s.includes('local') || s.includes('qwen') || s.includes('llama')) return <TerminalIcon className="w-2.5 h-2.5" />;
    
    return <MessageIcon className="w-2.5 h-2.5" />;
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className={`p-1 rounded-md ${isNote ? 'bg-amber-100 text-amber-600' : 'bg-lime-100 text-lime-600'}`}>
        {renderIcon()}
      </div>
      <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${isNote ? 'bg-amber-50/50 border-amber-200/50 text-amber-700' : 'bg-sandstone/20 border-sandstone/40 text-earth-dark/70'} dark:bg-stone-800 dark:border-stone-600`}>
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
      className={`relative p-5 rounded-2xl cursor-pointer transition-all duration-300 group overflow-hidden border-2 ${
          isActive 
            ? isNote 
                ? 'bg-amber-50/40 border-amber-400 dark:bg-amber-900/20 dark:border-amber-700 shadow-lg' 
                : 'bg-sage-green/10 border-sage-green dark:bg-sage-green/20 dark:border-sage-green shadow-lg'
            : isNote 
                ? 'bg-[#FFFDF5] border-dashed border-amber-300 dark:bg-stone-900 dark:border-amber-900/40 hover:bg-[#FFF9E0] shadow-sm' 
                : 'bg-white border-solid border-sandstone/40 dark:bg-stone-900 dark:border-stone-800 hover:border-sage-green/50 shadow-sm'
      }`}
    >
      {/* Side Color Strip */}
      <div className={`absolute left-0 top-0 bottom-0 w-1.5 transition-colors ${
        isActive 
          ? isNote ? 'bg-amber-500' : 'bg-sage-green' 
          : isNote ? 'bg-amber-200' : 'bg-sandstone/30'
      }`}></div>

      <div className="flex justify-between items-start mb-2 pl-2">
         <h3 className={`text-sm font-bold line-clamp-2 leading-tight ${isActive ? 'text-earth-dark dark:text-white' : 'text-earth-dark/90 dark:text-stone-200'} ${isNote ? 'font-serif italic' : 'font-sans'}`}>
            {chat.title}
         </h3>
      </div>
      
      <div className="flex items-center justify-between mb-3 pl-2">
         <SourceBadge source={chat.source} type={chat.type || ItemType.CHAT} />
         <span className="text-[10px] text-moss-brown dark:text-stone-500 font-mono font-bold">{dateStr}</span>
      </div>

      <p className={`text-xs mb-4 line-clamp-2 pl-2 leading-relaxed ${isNote ? 'text-amber-800/80 dark:text-stone-400 font-serif italic' : 'text-earth-dark/70 dark:text-stone-400 font-sans'}`}>
        {chat.summary}
      </p>
      
      <div className="flex flex-wrap gap-1.5 pl-2">
        {chat.tags.slice(0, 3).map(tag => {
          const isFiltering = activeRelatedTags.includes(tag);
          return (
            <button 
              key={tag} 
              onClick={(e) => { e.stopPropagation(); onTagClick(tag); }}
              className={`text-[9px] font-black px-2 py-0.5 rounded-md border transition-all uppercase tracking-wider ${
                isFiltering 
                  ? isNote ? 'bg-amber-600 text-white border-amber-600' : 'bg-sage-green text-white border-sage-green' 
                  : isNote
                    ? 'bg-amber-100/50 text-amber-700/70 border-amber-200/50 hover:bg-amber-200/50'
                    : 'bg-sandstone/10 text-earth-dark/60 border-sandstone/20 hover:bg-sage-green/20'
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
};
