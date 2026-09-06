
import React, { useMemo, useState } from 'react';
import { ChatEntry, SourceType } from '../types';
import { XIcon, NetworkIcon, MessageIcon, ActivityIcon, ChartIcon, TagIcon, ChevronRightIcon, PlusIcon, DatabaseIcon, OpenAIIcon, ClaudeIcon, GeminiIcon, TerminalIcon } from './Icons';
import { MindMap } from './MindMap';
import { ChatCard } from './ChatCard';

interface AnalyticsDashboardProps {
  chats: ChatEntry[];
  onClose: () => void;
  onSelectChat: (chat: ChatEntry, fromMindMap?: boolean) => void;
  onImport?: () => void;
  onArchive?: () => void;
  onNetwork?: () => void;
  onTagClick?: (tag: string) => void;
  initialView?: 'dashboard' | 'mindmap';
}

type TimeRange = '7days' | '30days' | 'all';

const getSourceIcon = (source: string) => {
  const s = source.toLowerCase();
  if (s.includes('chatgpt')) return <OpenAIIcon className="w-4 h-4 text-emerald-500" />;
  if (s.includes('claude')) return <ClaudeIcon className="w-4 h-4 text-orange-400" />;
  if (s.includes('gemini')) return <GeminiIcon className="w-4 h-4 text-blue-500" />;
  return <TerminalIcon className="w-4 h-4 text-slate-400" />;
};

export const AnalyticsDashboard: React.FC<AnalyticsDashboardProps> = ({ 
  chats, 
  onClose, 
  onSelectChat, 
  onImport, 
  onArchive, 
  onNetwork,
  onTagClick,
  initialView = 'dashboard' 
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [showMindMap, setShowMindMap] = useState(initialView === 'mindmap');
  const [expandActivity, setExpandActivity] = useState(false);
  const [expandTags, setExpandTags] = useState(false);

  const filteredChats = useMemo(() => {
    if (timeRange === 'all') return chats;
    const now = Date.now();
    const days = timeRange === '7days' ? 7 : 30;
    const limit = now - days * 24 * 60 * 60 * 1000;
    return chats.filter(c => c.createdAt >= limit);
  }, [chats, timeRange]);

  const stats = useMemo(() => {
    const totalChats = filteredChats.length;
    let totalMessages = 0;
    filteredChats.forEach(chat => {
      const messageBlocks = chat.content.split(/\n\n|User:|Assistant:|ChatGPT:|Claude:|Gemini:/);
      totalMessages += messageBlocks.filter(b => b.trim().length > 0).length || 1;
    });
    const avgMessages = totalChats > 0 ? Math.round(totalMessages / totalChats) : 0;
    const sourceCounts: Record<string, number> = {};
    filteredChats.forEach(c => { sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1; });
    const mostUsedAI = Object.entries(sourceCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || 'N/A';
    const activity: Record<string, { count: number; msgs: number }> = {};
    filteredChats.forEach(c => {
      const date = new Date(c.createdAt).toLocaleDateString('en-GB');
      if (!activity[date]) activity[date] = { count: 0, msgs: 0 };
      activity[date].count++;
    });
    const tagCounts: Record<string, number> = {};
    filteredChats.forEach(c => { c.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
    const sortedTags = Object.entries(tagCounts).sort((a, b) => (b[1] as number) - (a[1] as number));
    const recentChats = [...filteredChats].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    return { totalChats, totalMessages, avgMessages, mostUsedAI, sourceCounts, activity: Object.entries(activity).sort().reverse(), sortedTags, recentChats };
  }, [filteredChats]);

  const maxActivity = Math.max(...stats.activity.map(a => a[1].count), 1);

  if (showMindMap) {
    return (
      <MindMap 
        chats={chats} 
        onClose={() => {
           if (onNetwork) onClose(); 
           setShowMindMap(false);
        }} 
        onSelectChat={(chat) => {
          onSelectChat(chat, true);
          setShowMindMap(false);
        }}
      />
    );
  }

  const displayedActivity = expandActivity ? stats.activity : stats.activity.slice(0, 15);
  const displayedTags = expandTags ? stats.sortedTags : stats.sortedTags.slice(0, 16);

  return (
    <div className="flex-1 bg-slate-50 dark:bg-slate-950 flex flex-col overflow-y-auto animate-in fade-in duration-300">
      {/* Hero Navigation Area */}
      <div className="bg-[#F3E8DA] dark:bg-slate-900 border-b border-sandstone dark:border-slate-800 py-16 px-6 md:px-12 w-full">
        <div className="max-w-[1800px] mx-auto flex flex-col md:flex-row items-center justify-between gap-12">
          <div className="flex-1 text-center md:text-left">
            <h2 className="text-5xl font-black text-earth-dark dark:text-white mb-6 font-sans tracking-tight leading-tight">Your Personal <span className="text-lime-600">AI Intelligence Hub</span></h2>
            <p className="text-moss-brown dark:text-slate-400 text-xl font-serif italic max-w-2xl leading-relaxed">
              Curating and analyzing {chats.length} distinct conversations across your digital landscape. Chronicle is your decentralized memory engine.
            </p>
          </div>
          <div className="flex flex-wrap justify-center md:justify-end gap-6 shrink-0">
             <button onClick={onImport} className="flex items-center gap-4 bg-[#DBAA89] hover:bg-[#c69879] text-white px-8 py-5 rounded-[2rem] font-bold shadow-2xl transition-all transform hover:-translate-y-2 active:scale-95">
                <PlusIcon /> <span className="text-lg">Import Chat</span>
             </button>
             <button onClick={onArchive} className="flex items-center gap-4 bg-[#A9AB88] hover:bg-[#929475] text-white px-8 py-5 rounded-[2rem] font-bold shadow-2xl transition-all transform hover:-translate-y-2 active:scale-95">
                <DatabaseIcon /> <span className="text-lg">Archive</span>
             </button>
             <button onClick={onNetwork || (() => setShowMindMap(true))} className="flex items-center gap-4 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-earth-dark dark:text-white border border-sandstone dark:border-slate-700 px-8 py-5 rounded-[2rem] font-bold shadow-2xl transition-all transform hover:-translate-y-2 active:scale-95">
                <NetworkIcon /> <span className="text-lg">Neural Graph</span>
             </button>
          </div>
        </div>
      </div>

      <div className="max-w-[1800px] mx-auto w-full p-6 md:p-12 space-y-16">
        {/* Time Range Selector */}
        <div className="flex gap-2 p-1 bg-slate-200 dark:bg-slate-800 rounded-2xl w-fit font-sans border border-slate-300 dark:border-slate-700">
          {(['7days', '30days', 'all'] as TimeRange[]).map(r => (
            <button key={r} onClick={() => setTimeRange(r)} className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${timeRange === r ? 'bg-white dark:bg-slate-700 shadow-md text-[#A9AB88] dark:text-lime-400' : 'text-slate-500 hover:text-slate-700'}`}>
              {r === 'all' ? 'All History' : r === '7days' ? 'Last 7 Days' : 'Last 30 Days'}
            </button>
          ))}
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 font-sans">
          <StatCard label="Archived Chats" value={stats.totalChats} icon={<MessageIcon />} color="text-lime-500" />
          <StatCard label="Total Messages" value={stats.totalMessages} icon={<ActivityIcon />} color="text-orange-500" />
          <StatCard label="Interaction Frequency" value={`${stats.avgMessages} turns`} icon={<NetworkIcon />} color="text-blue-500" />
          <StatCard label="Preferred Engine" value={stats.mostUsedAI} icon={<ChartIcon />} color="text-purple-500" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-12 font-sans">
          {/* Recent Additions */}
          <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none">
            <h3 className="flex items-center gap-3 text-sm font-black text-slate-400 uppercase tracking-widest mb-10">
              <MessageIcon /> Recent Additions
            </h3>
            <div className="space-y-6">
              {stats.recentChats.map(chat => (
                <ChatCard key={chat.id} chat={chat} onClick={() => onSelectChat(chat)} onTagClick={(tag) => onTagClick?.(tag)} isActive={false} />
              ))}
            </div>
          </div>

          {/* Activity Over Time */}
          <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none">
            <h3 className="flex items-center justify-between gap-3 text-sm font-black text-slate-400 uppercase tracking-widest mb-10">
              <div className="flex items-center gap-3"><ActivityIcon /> Archive Pulse</div>
              {stats.activity.length > 15 && (
                <button onClick={() => setExpandActivity(!expandActivity)} className="text-[10px] bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full font-black text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                  {expandActivity ? 'Show Less' : 'Full Pulse'}
                </button>
              )}
            </h3>
            <div className="space-y-8">
              {displayedActivity.map(([date, data]) => (
                <div key={date} className="relative">
                  <div className="flex justify-between items-end mb-3 text-sm">
                    <span className="text-slate-500 font-black tracking-tight">{date}</span>
                    <span className="font-black text-slate-900 dark:text-white px-2 py-0.5 rounded-md bg-lime-50 dark:bg-lime-900/20 text-lime-600">{data.count} chats</span>
                  </div>
                  <div className="h-2.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-lime-500 rounded-full transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(132,204,22,0.4)]" style={{ width: `${(data.count / maxActivity) * 100}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Neural Concepts (Updated to match Screenshot) */}
          <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none">
            <h3 className="flex items-center justify-between gap-3 text-sm font-black text-slate-400 uppercase tracking-widest mb-10">
              <div className="flex items-center gap-3">
                <TagIcon /> Neural Concepts
              </div>
              {stats.sortedTags.length > 16 && (
                <button 
                  onClick={() => setExpandTags(!expandTags)} 
                  className="text-[10px] bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full font-black text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 uppercase tracking-wider"
                >
                  {expandTags ? 'Show Less' : 'Show All'}
                </button>
              )}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {displayedTags.map(([tag, count]) => (
                <button 
                  key={tag} 
                  onClick={() => onTagClick?.(tag)}
                  className="flex items-center justify-between px-4 py-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 hover:border-lime-500/30 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all shadow-sm group text-left"
                >
                  <span className="text-sm font-black text-slate-700 dark:text-slate-200 group-hover:text-lime-600 truncate">{tag}</span>
                  <span className="flex items-center justify-center min-w-[24px] h-6 text-[10px] font-black text-slate-400 bg-slate-50 dark:bg-slate-900 rounded-md border border-slate-100 dark:border-slate-800 ml-2 shrink-0">
                    {count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* AI Usage Distribution */}
        <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-xl">
          <h3 className="flex items-center gap-3 text-sm font-black text-slate-400 uppercase tracking-widest mb-10">
            <ChartIcon /> Intelligence Origin Distribution
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12">
            {Object.entries(stats.sourceCounts).map(([source, count]) => {
              const percentage = Math.round((Number(count) / stats.totalChats) * 100);
              return (
                <div key={source} className="group">
                  <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-xl group-hover:scale-110 transition-transform">
                        {getSourceIcon(source)}
                      </div>
                      <span className="text-slate-800 dark:text-slate-200 font-black text-lg">{source}</span>
                    </div>
                    <span className="text-slate-500 font-bold bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-lg text-xs">{count} sessions ({percentage}%)</span>
                  </div>
                  <div className="h-3 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700">
                    <div className="h-full bg-sage-green rounded-full shadow-inner transition-all duration-700" style={{ width: `${percentage}%` }}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      
      <footer className="w-full py-12 px-6 text-center text-moss-brown border-t border-sandstone/20 mt-12">
        <div className="flex items-center justify-center gap-2 mb-2">
          <DatabaseIcon />
          <span className="font-black tracking-tight text-earth-dark dark:text-white uppercase text-xs">Chronicle Intelligence Engine</span>
        </div>
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase">Private • Secure • Decentralized</p>
      </footer>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: string | number; icon: React.ReactNode; color: string }> = ({ label, value, icon, color }) => (
  <div className="bg-white dark:bg-slate-900 p-10 rounded-[2.5rem] border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none flex flex-col gap-6 hover:shadow-2xl transition-all transform hover:-translate-y-1">
    <div className={`p-4 w-fit rounded-[1.5rem] bg-slate-50 dark:bg-slate-800 ${color} shadow-inner`}>{icon}</div>
    <div>
      <p className="text-[11px] font-black text-slate-400 uppercase tracking-[0.15em] mb-2">{label}</p>
      <p className="text-4xl font-black text-slate-900 dark:text-white truncate tracking-tighter">{value}</p>
    </div>
  </div>
);
