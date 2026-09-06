
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ChatEntry, SourceType, Settings, AIProvider } from '../types';
import { SearchIcon, XIcon, TagIcon, DatabaseIcon, TerminalIcon, ActivityIcon, RefreshIcon, NetworkIcon, BoltIcon, ArrowLeftIcon } from './Icons';
import { ChatCard } from './ChatCard';
import { generateEmbedding } from '../services/geminiService';
import { cosineSimilarity } from '../utils/vectorUtils';

interface AdvancedSearchProps {
  chats: ChatEntry[];
  settings: Settings;
  onSelectChat: (chat: ChatEntry) => void;
  onTagClick: (tag: string) => void;
  onClose: () => void;
}

export const AdvancedSearch: React.FC<AdvancedSearchProps> = ({ 
  chats, 
  settings, 
  onSelectChat, 
  onTagClick,
  onClose 
}) => {
  const [query, setQuery] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [minLength, setMinLength] = useState(0);
  const [isSemantic, setIsSemantic] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [semanticScores, setSemanticScores] = useState<Record<string, number>>({});
  const [hasSearchedSemantic, setHasSearchedSemantic] = useState(false);
  const [searchPulse, setSearchPulse] = useState(false);
  
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    chats.forEach(c => c.tags.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [chats]);

  const sources = Object.values(SourceType);

  const performSemanticSearch = async (searchTerm: string) => {
    if (!searchTerm.trim()) {
      setSemanticScores({});
      setHasSearchedSemantic(false);
      return;
    }

    setIsSearching(true);
    setHasSearchedSemantic(true);
    try {
      const queryEmbedding = await generateEmbedding(searchTerm, settings);
      if (queryEmbedding) {
        const scores: Record<string, number> = {};
        chats.forEach(chat => {
          if (chat.embedding) {
            scores[chat.id] = cosineSimilarity(queryEmbedding, chat.embedding);
          }
        });
        setSemanticScores(scores);
      }
    } catch (e) {
      console.error("Semantic search failed", e);
    } finally {
      setIsSearching(false);
    }
  };

  const handleManualSearch = () => {
    // Clear debounce
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    if (isSemantic) {
      performSemanticSearch(query);
    } else {
      // For standard search, provide visual feedback that the "Run" was acknowledged
      setSearchPulse(true);
      setTimeout(() => setSearchPulse(false), 600);
    }
  };

  // Switch modes logic
  useEffect(() => {
    if (!isSemantic) {
      setSemanticScores({});
      setHasSearchedSemantic(false);
    }
  }, [isSemantic]);

  // Optional: Auto-search semantic if user pauses for a while
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    
    if (isSemantic && query.length > 5) {
      searchTimerRef.current = setTimeout(() => {
        performSemanticSearch(query);
      }, 1500);
    }
    
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, isSemantic]);

  const filteredResults = useMemo(() => {
    let results = chats;

    // 1. Text Query (Standard) - Checks Title, Summary, and Full Content
    if (query && !isSemantic) {
      const q = query.toLowerCase();
      results = results.filter(c => 
        c.title.toLowerCase().includes(q) || 
        c.summary.toLowerCase().includes(q) || 
        c.content.toLowerCase().includes(q)
      );
    }

    // 2. Sources Filter
    if (selectedSources.length > 0) {
      results = results.filter(c => selectedSources.includes(c.source));
    }

    // 3. Tags Filter
    if (selectedTags.length > 0) {
      results = results.filter(c => selectedTags.every(t => c.tags.includes(t)));
    }

    // 4. Dates Filter
    if (dateStart) {
      const start = new Date(dateStart).getTime();
      results = results.filter(c => c.createdAt >= start);
    }
    if (dateEnd) {
      const end = new Date(dateEnd).getTime() + 86400000;
      results = results.filter(c => c.createdAt <= end);
    }

    // 5. Length Filter
    if (minLength > 0) {
      results = results.filter(c => minLength === 10000 ? c.content.length >= 10000 : c.content.length >= minLength);
    }

    // 6. Semantic Re-sorting & Filtering
    if (isSemantic && hasSearchedSemantic) {
      if (Object.keys(semanticScores).length > 0) {
        results = results
          .filter(c => semanticScores[c.id] !== undefined)
          .sort((a, b) => (semanticScores[b.id] || 0) - (semanticScores[a.id] || 0));
      } else {
        // If we've searched but found nothing (e.g. no embeddings in DB), show empty
        return [];
      }
    } else if (!isSemantic) {
      results = [...results].sort((a, b) => b.createdAt - a.createdAt);
    } else {
      // In Semantic mode but haven't searched yet? 
      // Return empty so user is encouraged to press "Run Search"
      return [];
    }

    return results;
  }, [chats, query, selectedSources, selectedTags, dateStart, dateEnd, minLength, isSemantic, semanticScores, hasSearchedSemantic]);

  const resetFilters = () => {
    setQuery('');
    setSelectedSources([]);
    setSelectedTags([]);
    setDateStart('');
    setDateEnd('');
    setMinLength(0);
    setIsSemantic(false);
    setSemanticScores({});
    setHasSearchedSemantic(false);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-50 dark:bg-stone-950 overflow-hidden animate-in fade-in duration-300">
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        
        {/* Sidebar Controls */}
        <aside className="w-full md:w-80 bg-white dark:bg-stone-900 border-r border-sandstone dark:border-stone-800 flex flex-col shrink-0 z-10">
          <div className="p-6 border-b border-sandstone dark:border-stone-800 flex flex-col gap-4">
            <button 
              onClick={onClose}
              className="flex items-center gap-2 text-[10px] font-black text-moss-brown hover:text-earth-dark dark:hover:text-white uppercase tracking-widest transition-colors mb-2"
            >
              <ArrowLeftIcon className="w-3 h-3" />
              Back to Archive
            </button>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black text-earth-dark dark:text-white uppercase tracking-widest flex items-center gap-2">
                <BoltIcon className="w-4 h-4 text-lime-600" />
                Parameters
              </h2>
              <button onClick={resetFilters} className="text-[10px] font-black text-terracotta hover:underline uppercase">Reset All</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin">
            <div>
              <label className="block text-[10px] font-black text-moss-brown uppercase tracking-widest mb-4">Origin Sources</label>
              <div className="flex flex-wrap gap-2">
                {sources.map(src => (
                  <button
                    key={src}
                    onClick={() => setSelectedSources(prev => prev.includes(src) ? prev.filter(s => s !== src) : [...prev, src])}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black border transition-all ${
                      selectedSources.includes(src) ? 'bg-sage-green border-sage-green text-white shadow-md' : 'bg-paper dark:bg-stone-800 border-sandstone dark:border-stone-700 text-stone-600 dark:text-stone-400'
                    }`}
                  >
                    {src}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-black text-moss-brown uppercase tracking-widest mb-4">Content Volume</label>
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] font-bold text-moss-brown">{minLength}+ chars</span>
              </div>
              <input 
                type="range" min="0" max="10000" step="500" value={minLength}
                onChange={(e) => setMinLength(parseInt(e.target.value))}
                className="w-full h-1.5 bg-sandstone/30 dark:bg-stone-800 rounded-full appearance-none cursor-pointer accent-sage-green"
              />
            </div>

            <div>
              <label className="block text-[10px] font-black text-moss-brown uppercase tracking-widest mb-4">Conceptual Filter</label>
              <div className="flex flex-wrap gap-1.5">
                {availableTags.slice(0, 40).map(tag => (
                  <button
                    key={tag}
                    onClick={() => setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])}
                    className={`px-2 py-1 rounded-md text-[9px] font-black uppercase border transition-all ${
                      selectedTags.includes(tag) ? 'bg-[#DBAA89] border-[#DBAA89] text-white' : 'bg-warm-beige/30 dark:bg-stone-800 border-sandstone/30 dark:border-stone-700 text-earth-dark'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Main Search Results Area */}
        <main className="flex-1 flex flex-col overflow-hidden bg-paper dark:bg-stone-950">
          
          <div className="h-16 flex items-center justify-between px-8 bg-white dark:bg-stone-900 border-b border-sandstone dark:border-stone-800 shrink-0">
             <div className="flex items-center gap-2">
                <SearchIcon className="w-4 h-4 text-lime-600" />
                <h1 className="text-sm font-black text-earth-dark dark:text-white uppercase tracking-widest">Deep Archive Search</h1>
             </div>
             <button onClick={onClose} className="p-2 text-moss-brown hover:text-earth-dark transition-colors"><XIcon /></button>
          </div>

          <div className="p-8 border-b border-sandstone dark:border-stone-800 bg-slate-50/50 dark:bg-stone-950/50">
            <div className="max-w-4xl mx-auto space-y-4">
              <div className="relative flex items-center gap-4">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-0 pl-6 flex items-center text-lime-600"><SearchIcon /></div>
                  <input 
                    type="text"
                    placeholder={isSemantic ? "Describe a concept or topic..." : "Search title, summary, or full content..."}
                    className="w-full bg-white dark:bg-stone-800 border-2 border-sandstone/30 dark:border-stone-700 rounded-2xl py-5 pl-14 pr-32 text-lg font-bold shadow-xl outline-none focus:border-sage-green transition-all"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleManualSearch()}
                  />
                  <div className="absolute inset-y-0 right-4 flex items-center gap-2">
                    <button 
                      onClick={() => setIsSemantic(!isSemantic)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all border ${isSemantic ? 'bg-lime-600 border-lime-600 text-white shadow-lg' : 'bg-slate-100 text-slate-500'}`}
                    >
                      <NetworkIcon className="w-3 h-3" /> Semantic
                    </button>
                  </div>
                </div>
                <button 
                  onClick={handleManualSearch}
                  disabled={isSearching}
                  className={`bg-sage-green hover:bg-[#929475] text-white px-8 py-5 rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl transition-all active:scale-95 flex items-center gap-2 ${isSearching ? 'opacity-70 cursor-wait' : ''}`}
                >
                  {isSearching ? <RefreshIcon className="w-4 h-4 animate-spin" /> : 'Run Search'}
                </button>
              </div>
              
              <div className="flex items-center justify-between px-2">
                 <p className="text-[10px] font-bold text-moss-brown uppercase tracking-widest">
                   {isSemantic ? 'Conceptual Analysis Mode' : 'Keyword Pattern Matching Mode'}
                 </p>
                 {isSemantic && (
                   <span className="text-[10px] font-black text-lime-600 bg-lime-50 px-2 py-0.5 rounded">AI POWERED</span>
                 )}
              </div>
            </div>
          </div>

          <div className={`flex-1 overflow-y-auto p-8 relative transition-opacity duration-300 ${searchPulse ? 'opacity-50' : 'opacity-100'}`}>
            {isSearching && (
              <div className="absolute inset-0 bg-white/40 backdrop-blur-[2px] z-20 flex items-center justify-center">
                 <div className="bg-white p-6 rounded-2xl shadow-2xl border border-sandstone flex flex-col items-center gap-4 animate-in zoom-in">
                    <RefreshIcon className="w-8 h-8 text-lime-600 animate-spin" />
                    <p className="text-xs font-black text-earth-dark uppercase tracking-widest">Analyzing Neural Vectors...</p>
                 </div>
              </div>
            )}
            
            <div className="max-w-4xl mx-auto">
              <div className="mb-8 flex items-center justify-between border-b border-sandstone/20 pb-4">
                <h3 className="text-[11px] font-black text-moss-brown uppercase tracking-widest">
                  {isSemantic && !hasSearchedSemantic ? 'Neural map ready' : `${filteredResults.length} Matched Conversations`}
                </h3>
              </div>

              {filteredResults.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-20">
                  {filteredResults.map(chat => (
                    <div key={chat.id} className="relative">
                       {isSemantic && semanticScores[chat.id] !== undefined && (
                         <div className="absolute -top-2 -right-2 z-10 bg-lime-500 text-white text-[9px] font-black px-2 py-0.5 rounded shadow-lg">
                           {Math.round(semanticScores[chat.id] * 100)}% Match
                         </div>
                       )}
                       <ChatCard chat={chat} onClick={() => onSelectChat(chat)} onTagClick={onTagClick} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-32 text-center">
                  <DatabaseIcon className="w-16 h-16 text-sandstone/30 mb-6" />
                  <h4 className="text-xl font-bold text-earth-dark mb-2">
                    {isSemantic && !hasSearchedSemantic ? 'Deep AI Search is Ready' : 'The archive remains silent.'}
                  </h4>
                  <p className="text-moss-brown text-sm italic max-w-sm mx-auto">
                    {isSemantic && !hasSearchedSemantic 
                      ? 'In Semantic mode, your query is analyzed conceptually. Enter a topic and press "Run Search" to see conceptual matches.' 
                      : 'No logs match these parameters. Try expanding your content volume or changing your query.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
