
import React, { useState, useMemo } from 'react';
import { ChatEntry, ItemType, SourceType } from '../types';
import { SearchIcon, XIcon, MessageIcon, ActivityIcon, PencilIcon, FilterIcon, CalendarIcon, TagIcon, OpenAIIcon, ClaudeIcon, GeminiIcon, TerminalIcon } from './Icons';
import { ChatCard } from './ChatCard';

interface SidebarProps {
  availableTags: string[];
  selectedTags: string[];
  onTagToggle: (tag: string) => void;
  filteredChats: ChatEntry[];
  onSelectChat: (chat: ChatEntry) => void;
  currentChatId?: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onTagClick: (tag: string) => void;
  selectedType: ItemType | 'all';
  onTypeChange: (type: ItemType | 'all') => void;
  selectedSource: SourceType | 'All';
  onSourceChange: (source: SourceType | 'All') => void;
  dateStart: string;
  dateEnd: string;
  onDateRangeChange: (start: string, end: string) => void;
  activeRelatedTags?: string[];
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  availableTags, 
  selectedTags, 
  onTagToggle,
  filteredChats,
  onSelectChat,
  currentChatId,
  searchQuery,
  setSearchQuery,
  onTagClick,
  selectedType,
  onTypeChange,
  selectedSource,
  onSourceChange,
  dateStart,
  dateEnd,
  onDateRangeChange,
  activeRelatedTags = []
}) => {
  const [showQuickFilters, setShowQuickFilters] = useState(false);

  const getSourceIcon = (source: string) => {
    const s = source.toLowerCase();
    if (s.includes('chatgpt')) return <OpenAIIcon className="w-3 h-3 text-emerald-500" />;
    if (s.includes('claude')) return <ClaudeIcon className="w-3 h-3 text-orange-400" />;
    if (s.includes('gemini')) return <GeminiIcon className="w-3 h-3 text-blue-500" />;
    return <TerminalIcon className="w-3 h-3 text-slate-400" />;
  };

  const activeFilters = useMemo(() => {
    const filters = [];
    if (searchQuery.trim()) {
      filters.push({ 
        id: 'query', 
        label: `"${searchQuery}"`, 
        type: 'search', 
        icon: <SearchIcon className="w-2.5 h-2.5" /> 
      });
    }
    if (selectedType !== 'all') {
      filters.push({ 
        id: 'type', 
        label: selectedType === 'chat' ? 'Chat Logs' : 'Synthesis Notes', 
        type: 'type', 
        icon: selectedType === 'chat' ? <MessageIcon className="w-2.5 h-2.5" /> : <PencilIcon className="w-2.5 h-2.5" /> 
      });
    }
    if (selectedSource !== 'All') {
      filters.push({ 
        id: 'source', 
        label: selectedSource, 
        type: 'source', 
        icon: getSourceIcon(selectedSource) 
      });
    }
    if (dateStart || dateEnd) {
      const label = dateStart && dateEnd ? `${dateStart} to ${dateEnd}` : dateStart ? `After ${dateStart}` : `Before ${dateEnd}`;
      filters.push({ 
        id: 'date', 
        label, 
        type: 'date', 
        icon: <CalendarIcon className="w-2.5 h-2.5" /> 
      });
    }
    selectedTags.forEach(tag => {
      filters.push({ 
        id: `tag-${tag}`, 
        label: tag, 
        type: 'tag', 
        value: tag, 
        icon: <TagIcon className="w-2.5 h-2.5" /> 
      });
    });
    return filters;
  }, [searchQuery, selectedType, selectedSource, dateStart, dateEnd, selectedTags]);

  const hasActiveFilters = activeFilters.length > 0;

  const clearFilter = (filter: any) => {
    switch (filter.id) {
      case 'query': setSearchQuery(''); break;
      case 'type': onTypeChange('all'); break;
      case 'source': onSourceChange('All'); break;
      case 'date': onDateRangeChange('', ''); break;
      default: if (filter.type === 'tag') onTagToggle(filter.value);
    }
  };

  const clearAllFilters = () => {
    setSearchQuery('');
    onTypeChange('all');
    onSourceChange('All');
    onDateRangeChange('', '');
    if (selectedTags.length > 0) onTagToggle('All');
  };

  return (
    <aside className="w-80 border-r border-sandstone/40 dark:border-stone-800 bg-white dark:bg-stone-900/50 flex flex-col shrink-0 font-sans backdrop-blur-sm relative transition-all">
      
      {/* Top Search & Filter Header */}
      <div className="p-4 space-y-4 border-b border-sandstone/40 bg-white dark:bg-stone-900 z-10 shadow-sm">
        
        <div className="flex gap-2">
            <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-sage-green">
                  <SearchIcon className="w-3.5 h-3.5" />
                </div>
                <input 
                  type="text"
                  placeholder="Filter memories..."
                  className="w-full bg-slate-50 dark:bg-stone-800 border border-sandstone/30 dark:border-stone-700 rounded-xl py-2 pl-9 pr-3 text-xs font-bold focus:outline-none focus:border-sage-green transition-all text-earth-dark dark:text-white placeholder:text-moss-brown/60"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
            </div>
            <button 
                onClick={() => setShowQuickFilters(!showQuickFilters)}
                className={`p-2 rounded-xl border transition-all ${showQuickFilters ? 'bg-sage-green border-sage-green text-white shadow-md' : 'bg-white dark:bg-stone-800 border-sandstone/30 text-moss-brown hover:border-sage-green'}`}
                title="Quick Filters"
            >
                <FilterIcon className="w-4 h-4" />
            </button>
        </div>

        {/* Quick Filters Panel (Expandable) */}
        {showQuickFilters && (
            <div className="p-4 bg-slate-50 dark:bg-stone-800/40 rounded-xl border border-sandstone/20 space-y-4 animate-in slide-in-from-top-2 duration-200">
                <div>
                    <p className="text-[9px] font-black uppercase text-moss-brown tracking-widest mb-2">Item Type</p>
                    <div className="flex p-1 bg-white dark:bg-stone-900 rounded-lg border border-sandstone/20">
                      {(['all', 'chat', 'note'] as const).map(t => (
                        <button
                          key={t}
                          onClick={() => onTypeChange(t as ItemType | 'all')}
                          className={`flex-1 py-1.5 text-[8px] font-black uppercase tracking-widest transition-all rounded-md ${
                            selectedType === t 
                              ? 'bg-stone-800 dark:bg-stone-700 text-white shadow-sm' 
                              : 'text-moss-brown hover:text-earth-dark'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                </div>

                <div>
                    <p className="text-[9px] font-black uppercase text-moss-brown tracking-widest mb-2">AI Source</p>
                    <select 
                        value={selectedSource}
                        onChange={(e) => onSourceChange(e.target.value as SourceType | 'All')}
                        className="w-full bg-white dark:bg-stone-900 border border-sandstone/20 rounded-lg p-2 text-[10px] font-bold text-earth-dark dark:text-stone-300 outline-none focus:border-sage-green"
                    >
                        <option value="All">All Sources</option>
                        {Object.values(SourceType).map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>

                <div>
                    <p className="text-[9px] font-black uppercase text-moss-brown tracking-widest mb-2">Time Horizon</p>
                    <div className="grid grid-cols-2 gap-2">
                        <input 
                            type="date" 
                            className="bg-white dark:bg-stone-900 border border-sandstone/20 rounded-lg p-1.5 text-[9px] font-bold outline-none focus:border-sage-green"
                            value={dateStart}
                            onChange={(e) => onDateRangeChange(e.target.value, dateEnd)}
                        />
                        <input 
                            type="date" 
                            className="bg-white dark:bg-stone-900 border border-sandstone/20 rounded-lg p-1.5 text-[9px] font-bold outline-none focus:border-sage-green"
                            value={dateEnd}
                            onChange={(e) => onDateRangeChange(dateStart, e.target.value)}
                        />
                    </div>
                </div>
            </div>
        )}
        
        {/* Tag Selection Row */}
        {!showQuickFilters && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide -mx-1 px-1">
                {availableTags.map(tag => {
                    const isActive = selectedTags.includes(tag);
                    return (
                        <button
                            key={tag}
                            onClick={() => onTagToggle(tag)}
                            className={`text-[8px] font-black uppercase tracking-widest px-2.5 py-1.5 rounded-lg whitespace-nowrap transition-all border ${
                                isActive
                                ? 'bg-terracotta border-terracotta text-white shadow-sm'
                                : 'bg-white dark:bg-stone-800 border-sandstone/20 text-moss-brown hover:border-terracotta/40'
                            }`}
                        >
                            {tag}
                        </button>
                    );
                })}
            </div>
        )}
      </div>

      {/* Enhanced Active Filter Chips Section */}
      {hasActiveFilters && (
          <div className="px-4 py-3 bg-[#f3efe8] dark:bg-stone-900 border-b border-sandstone/30 shadow-inner animate-in fade-in slide-in-from-top-1 duration-300">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-[9px] font-black text-moss-brown uppercase tracking-widest flex items-center gap-1.5">
                   <FilterIcon className="w-2.5 h-2.5" />
                   Active Constraints
                </span>
                <button 
                    onClick={clearAllFilters}
                    className="text-[8px] font-black text-terracotta uppercase tracking-tighter hover:underline px-1 py-0.5 rounded hover:bg-terracotta/10 transition-colors"
                >
                    Clear All
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                  {activeFilters.map((f) => (
                      <div 
                        key={f.id} 
                        className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-[9px] font-black uppercase tracking-wider border shadow-sm transition-all animate-in zoom-in-95 ${
                            f.type === 'tag' ? 'bg-[#DBAA89]/10 border-[#DBAA89]/30 text-[#DBAA89]' :
                            f.type === 'search' ? 'bg-sage-green/10 border-sage-green/30 text-sage-green' :
                            f.type === 'source' ? 'bg-white dark:bg-stone-800 border-sandstone/40 text-earth-dark dark:text-stone-300' :
                            'bg-slate-50 dark:bg-stone-800 border-sandstone/30 text-moss-brown'
                        }`}
                      >
                        <span className="shrink-0">{f.icon}</span>
                        <span className="truncate max-w-[120px]">{f.label}</span>
                        <button 
                            onClick={() => clearFilter(f)} 
                            className="ml-0.5 hover:text-red-500 transition-colors shrink-0"
                            title="Remove filter"
                        >
                            <XIcon className="w-2.5 h-2.5" />
                        </button>
                      </div>
                  ))}
              </div>
          </div>
      )}

      {/* Result Meta */}
      <div className="px-5 py-2.5 bg-paper dark:bg-stone-950 border-b border-sandstone/10 flex items-center justify-between">
          <span className="text-[9px] font-black text-moss-brown uppercase tracking-[0.2em]">
            {filteredChats.length} Memories Retained
          </span>
      </div>

      {/* Entry List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-paper dark:bg-stone-950 scrollbar-thin">
        {filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 px-8 text-center opacity-40">
                <div className="w-12 h-12 bg-sandstone/10 rounded-full flex items-center justify-center mb-4 text-sandstone">
                    <SearchIcon className="w-6 h-6" />
                </div>
                <p className="text-[10px] font-black text-earth-dark dark:text-stone-300 uppercase tracking-widest mb-1">Silence</p>
                <p className="text-[9px] text-moss-brown italic leading-relaxed">No traces match these parameters.</p>
            </div>
        ) : (
            filteredChats.map(chat => (
                <ChatCard 
                    key={chat.id}
                    chat={chat}
                    isActive={chat.id === currentChatId}
                    onClick={() => onSelectChat(chat)}
                    onTagClick={onTagClick}
                    activeRelatedTags={activeRelatedTags}
                />
            ))
        )}
      </div>
    </aside>
  );
};
