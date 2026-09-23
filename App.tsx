
import React, { useState, useEffect, useMemo } from 'react';
import { ChatEntry, SourceType, AppState, Settings, Theme, AIProvider, ViewMode, ItemType, Link } from './types';
import { Sidebar } from './components/Sidebar';
import { SearchIcon, PlusIcon, DatabaseIcon, SettingsIcon, XIcon, ChartIcon, NetworkIcon, ActivityIcon, BoltIcon } from './components/Icons';
import { UploadModal } from './components/UploadModal';
import { ChatViewer } from './components/ChatViewer';
import { SettingsModal } from './components/SettingsModal';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { RightSidebar } from './components/RightSidebar';
import { AdvancedSearch } from './components/AdvancedSearch';

const STORAGE_KEY = 'chronicle_chats_v1';
const LINKS_KEY = 'chronicle_links_v1';
const SETTINGS_KEY = 'chronicle_settings_v1';

declare global {
  interface Window {
    chronicleAPI: any;
    electronAPI?: {
      isNative: boolean;
      getAppPath: () => Promise<string>;
      getExecutablePath: () => Promise<string>;
      saveDatabase: (data: any) => Promise<boolean>;
      loadDatabase: () => Promise<any>;
      addLink: (fromId: string, toId: string, type?: string) => Promise<boolean>;
      removeLink: (fromId: string, toId: string) => Promise<boolean>;
      loadLinks: () => Promise<Link[]>;
      exportChats: (chats: any[], format: string) => Promise<{success: boolean, path?: string, error?: string, cancelled?: boolean}>;
      importChats: (existingIds: string[]) => Promise<{success: boolean, chats: any[], skipped: number, error?: string, cancelled?: boolean}>;
      sendNotification: (title: string, body: string) => void;
      platform: string;
    };
  }
}

const DEFAULT_SETTINGS: Settings = {
  theme: Theme.LIGHT,
  aiProvider: AIProvider.GEMINI,
  preferredModel: 'gemini-3-flash-preview',
  customEndpoint: 'http://localhost:1234/v1/chat/completions',
  relatedChatsLimit: 9,
  availableModels: [],
  userAvatar: undefined,
  userName: ''
};


const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    chats: [],
    links: [],
    searchQuery: '',
    selectedSource: 'All',
    selectedTags: [],
    selectedType: 'all',
    relatedTags: [],
    isRightPanelOpen: false,
    isUploading: false,
    isSettingsOpen: false,
    viewMode: 'dashboard',
    viewingChat: null,
    settings: DEFAULT_SETTINGS,
    returnToMindMap: false,
    searchFilters: {
        sources: [],
        dateStart: '',
        dateEnd: '',
        minLength: 0,
        isSemantic: false,
        type: 'all'
    }
  });

  useEffect(() => {
    const initApp = async () => {
      let initialChats: ChatEntry[] = [];
      let initialLinks: Link[] = [];
      let initialSettings = DEFAULT_SETTINGS;

      if (window.electronAPI) {
        initialChats = await window.electronAPI.loadDatabase() || [];
        initialLinks = await window.electronAPI.loadLinks() || [];
        const savedSettings = localStorage.getItem(SETTINGS_KEY);
        if (savedSettings) initialSettings = JSON.parse(savedSettings);
      } else {
        const savedChats = localStorage.getItem(STORAGE_KEY);
        const savedLinks = localStorage.getItem(LINKS_KEY);
        const savedSettings = localStorage.getItem(SETTINGS_KEY);
        if (savedChats) initialChats = JSON.parse(savedChats);
        if (savedLinks) initialLinks = JSON.parse(savedLinks);
        if (savedSettings) initialSettings = JSON.parse(savedSettings);
      }

      setState(prev => ({
        ...prev,
        chats: initialChats,
        links: initialLinks,
        settings: initialSettings
      }));
    };
    initApp();
  }, []);

  useEffect(() => {
    const applyTheme = (theme: Theme) => {
      const root = window.document.documentElement;
      let effectiveTheme = theme;
      if (theme === Theme.SYSTEM) {
        effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? Theme.DARK : Theme.LIGHT;
      }
      if (effectiveTheme === Theme.DARK) {
        root.classList.add('dark');
        root.style.backgroundColor = '#1c1917';
      } else {
        root.classList.remove('dark');
        root.style.backgroundColor = '#fefef9';
      }
    };
    applyTheme(state.settings.theme);
  }, [state.settings.theme]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.saveDatabase(state.chats);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats));
    }
  }, [state.chats]);

  useEffect(() => {
    if (!window.electronAPI) {
      localStorage.setItem(LINKS_KEY, JSON.stringify(state.links));
    }
  }, [state.links]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }, [state.settings]);

  const handleAddLink = async (fromId: string, toId: string, type?: string) => {
    const newLink: Link = { fromId, toId, type: type || 'related', createdAt: Date.now() };
    if (window.electronAPI) {
      await window.electronAPI.addLink(fromId, toId, newLink.type);
    }
    setState(prev => ({ ...prev, links: [...prev.links, newLink] }));
  };

  const handleRemoveLink = async (fromId: string, toId: string) => {
    if (window.electronAPI) {
      await window.electronAPI.removeLink(fromId, toId);
    }
    setState(prev => ({
      ...prev,
      links: prev.links.filter(l => 
        !(l.fromId === fromId && l.toId === toId) && 
        !(l.fromId === toId && l.toId === fromId)
      )
    }));
  };

  const handleUpload = (content: string, source: string, title: string, summary: string, tags: string[], fileName: string, embedding?: number[], assets?: string[]) => {
    const newChat: ChatEntry = {
      id: Math.random().toString(36).substr(2, 9),
      type: ItemType.CHAT,
      title, content, summary, tags, source, 
      createdAt: Date.now(), 
      updatedAt: Date.now(),
      fileName, embedding, assets
    };
    setState(prev => ({ ...prev, chats: [newChat, ...prev.chats], isUploading: false, viewingChat: newChat, viewMode: 'archive' }));
  };

  const handleCreateNote = () => {
    const newNote: ChatEntry = {
      id: Math.random().toString(36).substr(2, 9),
      type: ItemType.NOTE,
      title: 'New Synthesis Note',
      content: 'Start writing your synthesis here...',
      summary: 'Draft note created manually.',
      tags: ['synthesis'],
      source: SourceType.MANUAL,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      embedding: undefined
    };
    setState(prev => ({ 
      ...prev, 
      chats: [newNote, ...prev.chats], 
      viewingChat: newNote, 
      viewMode: 'archive',
      selectedType: ItemType.NOTE 
    }));
  };

  const handleClearAll = () => {
    setState(prev => ({ ...prev, chats: [], viewingChat: null, links: [] }));
  };

  const handleDelete = (id: string) => setState(prev => ({ ...prev, chats: prev.chats.filter(c => c.id !== id), viewingChat: prev.viewingChat?.id === id ? null : prev.viewingChat, links: prev.links.filter(l => l.fromId !== id && l.toId !== id) }));
  const handleUpdate = (updatedChat: ChatEntry) => setState(prev => ({ ...prev, chats: prev.chats.map(c => c.id === updatedChat.id ? { ...updatedChat, updatedAt: Date.now() } : c), viewingChat: prev.viewingChat?.id === updatedChat.id ? updatedChat : prev.viewingChat }));
  const handleSelectChat = (chat: ChatEntry, fromMindMap: boolean = false) => setState(prev => ({ ...prev, viewingChat: chat, returnToMindMap: fromMindMap, viewMode: 'archive', isRightPanelOpen: false }));
  
  const toggleTag = (tag: string) => {
    if (tag === 'All') { setState(prev => ({ ...prev, selectedTags: [] })); return; }
    setState(prev => ({ ...prev, selectedTags: prev.selectedTags.includes(tag) ? prev.selectedTags.filter(t => t !== tag) : [...prev.selectedTags, tag] }));
  };

  const handleTagClick = (tag: string) => {
    if (state.viewMode === 'dashboard' || state.viewMode === 'search') {
      setState(prev => ({ ...prev, selectedTags: [tag], viewMode: 'archive' }));
    } else {
      setState(prev => {
          const currentRelated = prev.relatedTags || [];
          const isAlreadyActive = currentRelated.includes(tag);
          const newRelated = isAlreadyActive ? currentRelated.filter(t => t !== tag) : [...currentRelated, tag];
          return { ...prev, relatedTags: newRelated, isRightPanelOpen: true };
      });
    }
  };

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    state.chats.forEach(chat => chat.tags.forEach(tag => tags.add(tag)));
    return Array.from(tags).sort();
  }, [state.chats]);

  const filteredChats = useMemo(() => {
    const searchStr = state.searchQuery.toLowerCase();
    return [...state.chats].sort((a, b) => b.createdAt - a.createdAt).filter(chat => {
        const matchesSearch = searchStr === '' || chat.title.toLowerCase().includes(searchStr) || chat.summary.toLowerCase().includes(searchStr) || chat.content.toLowerCase().includes(searchStr);
        const matchesTags = state.selectedTags.length === 0 || state.selectedTags.every(tag => chat.tags.includes(tag));
        const matchesType = state.selectedType === 'all' || chat.type === state.selectedType;
        const matchesSource = state.selectedSource === 'All' || chat.source === state.selectedSource;
        const matchesDateStart = !state.searchFilters.dateStart || chat.createdAt >= new Date(state.searchFilters.dateStart).getTime();
        const matchesDateEnd = !state.searchFilters.dateEnd || chat.createdAt <= new Date(state.searchFilters.dateEnd).getTime() + 86400000;

        return matchesSearch && matchesTags && matchesType && matchesSource && matchesDateStart && matchesDateEnd;
    });
  }, [state.chats, state.searchQuery, state.selectedTags, state.selectedType, state.selectedSource, state.searchFilters.dateStart, state.searchFilters.dateEnd]);

  const relatedChats = useMemo(() => {
      const tags = state.relatedTags || [];
      return tags.length === 0 ? [] : [...state.chats].filter(chat => tags.every(t => chat.tags.includes(t)));
  }, [state.chats, state.relatedTags]);

  const isMacOS = window.electronAPI?.platform === 'darwin';

  return (
    <div className={`flex flex-col h-screen bg-paper dark:bg-stone-950 text-earth-dark dark:text-stone-100 transition-colors duration-300 overflow-hidden ${isMacOS ? 'pt-4' : ''}`}>
      
      <header className={`h-16 shrink-0 bg-warm-beige dark:bg-stone-900/90 backdrop-blur-md border-b border-sandstone dark:border-stone-800 flex items-center justify-between px-6 z-50 ${isMacOS ? 'pl-20' : ''}`}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setState(prev => ({ ...prev, viewMode: 'dashboard', viewingChat: null }))}>
          <div className="bg-lime-500 p-2 rounded-xl shadow-lg shadow-lime-500/20 text-white">
            <DatabaseIcon />
          </div>
          <div className="flex flex-col">
            <h1 className="text-xl font-bold tracking-tight text-earth-dark dark:text-white font-sans leading-none">Chronicle</h1>
            <p className="text-[10px] text-moss-brown dark:text-stone-500 font-medium uppercase tracking-widest">Archive & Synthesis</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
            <button 
                onClick={() => setState(prev => ({ ...prev, viewMode: 'dashboard' }))}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold transition-all ${state.viewMode === 'dashboard' ? 'bg-[#A9AB88] text-white shadow-sm' : 'hover:bg-sandstone/20 text-stone-600 dark:text-stone-400'}`}
            >
                <ChartIcon /> Insights
            </button>
            <button 
                onClick={() => setState(prev => ({ ...prev, viewMode: 'archive' }))}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold transition-all ${state.viewMode === 'archive' ? 'bg-[#A9AB88] text-white shadow-sm' : 'hover:bg-sandstone/20 text-stone-600 dark:text-stone-400'}`}
            >
                <DatabaseIcon /> Knowledge Base
            </button>
            <button 
                onClick={() => setState(prev => ({ ...prev, viewMode: 'search' }))}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold transition-all ${state.viewMode === 'search' ? 'bg-[#A9AB88] text-white shadow-sm' : 'hover:bg-sandstone/20 text-stone-600 dark:text-stone-400'}`}
            >
                <SearchIcon className="w-4 h-4" /> Power Search
            </button>
            <div className="h-6 w-px bg-sandstone dark:bg-stone-800 mx-1"></div>
            <button 
                onClick={handleCreateNote}
                className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm"
            >
                <ActivityIcon className="w-3.5 h-3.5" /> New Note
            </button>
            <button 
                onClick={() => setState(prev => ({ ...prev, isUploading: true }))}
                className="flex items-center gap-2 bg-[#DBAA89] hover:bg-[#c69879] text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm"
            >
                <PlusIcon /> Import Log
            </button>
            <button 
                onClick={() => setState(prev => ({ ...prev, isSettingsOpen: true }))}
                className="p-2 text-stone-500 hover:text-earth-dark transition-colors"
            >
                <SettingsIcon />
            </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {state.viewMode === 'dashboard' ? (
          <AnalyticsDashboard 
            chats={state.chats}
            onClose={() => setState(prev => ({ ...prev, viewMode: 'archive' }))}
            onSelectChat={handleSelectChat}
            onImport={() => setState(prev => ({ ...prev, isUploading: true }))}
            onArchive={() => setState(prev => ({ ...prev, viewMode: 'archive' }))}
            onNetwork={() => setState(prev => ({ ...prev, viewMode: 'mindmap' }))}
            onTagClick={handleTagClick}
            initialView="dashboard"
          />
        ) : state.viewMode === 'mindmap' ? (
          <AnalyticsDashboard 
            chats={state.chats}
            onClose={() => setState(prev => ({ ...prev, viewMode: 'dashboard' }))}
            onSelectChat={handleSelectChat}
            onTagClick={handleTagClick}
            initialView="mindmap"
          />
        ) : state.viewMode === 'search' ? (
          <AdvancedSearch 
            chats={state.chats}
            settings={state.settings}
            onSelectChat={handleSelectChat}
            onTagClick={handleTagClick}
            onClose={() => setState(prev => ({ ...prev, viewMode: 'archive' }))}
          />
        ) : (
          <>
            <Sidebar 
              availableTags={availableTags}
              selectedTags={state.selectedTags}
              onTagToggle={toggleTag}
              onTagClick={handleTagClick}
              filteredChats={filteredChats}
              onSelectChat={handleSelectChat}
              currentChatId={state.viewingChat?.id}
              searchQuery={state.searchQuery}
              setSearchQuery={(q) => setState(prev => ({ ...prev, searchQuery: q }))}
              selectedType={state.selectedType}
              onTypeChange={(t) => setState(prev => ({ ...prev, selectedType: t }))}
              selectedSource={state.selectedSource}
              onSourceChange={(s) => setState(prev => ({ ...prev, selectedSource: s }))}
              dateStart={state.searchFilters.dateStart}
              dateEnd={state.searchFilters.dateEnd}
              onDateRangeChange={(start, end) => setState(prev => ({ ...prev, searchFilters: { ...prev.searchFilters, dateStart: start, dateEnd: end } }))}
              activeRelatedTags={state.relatedTags}
            />

            <main className="flex-1 bg-paper dark:bg-stone-950 relative overflow-hidden">
              {state.viewingChat ? (
                <ChatViewer 
                  chat={state.viewingChat} 
                  allChats={state.chats}
                  allLinks={state.links}
                  onClose={() => setState(prev => ({ ...prev, viewingChat: null, viewMode: prev.returnToMindMap ? 'mindmap' : 'archive', returnToMindMap: false }))}
                  onDelete={handleDelete}
                  onUpdate={handleUpdate}
                  onSelectChat={handleSelectChat}
                  onAddLink={handleAddLink}
                  onRemoveLink={handleRemoveLink}
                  onTagClick={handleTagClick}
                  settings={state.settings}
                  returnToMindMap={state.returnToMindMap}
                  activeRelatedTags={state.relatedTags}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center p-8">
                   <div className="w-24 h-24 bg-sandstone/20 dark:bg-stone-800 rounded-full flex items-center justify-center mb-6 text-moss-brown"><DatabaseIcon /></div>
                   <h2 className="text-2xl font-bold text-earth-dark dark:text-white mb-2">Knowledge Base</h2>
                   <p className="text-moss-brown dark:text-stone-400 max-w-md">Your centralized intelligence archive. Use the filters to switch between raw Chat Logs and personal Synthesis Notes.</p>
                </div>
              )}
            </main>
            
            <RightSidebar 
                isOpen={state.isRightPanelOpen}
                onClose={() => setState(prev => ({ ...prev, isRightPanelOpen: false }))}
                selectedTags={state.relatedTags || []}
                onRemoveTag={(t) => setState(prev => ({ ...prev, relatedTags: prev.relatedTags.filter(rt => rt !== t) }))}
                filteredChats={relatedChats}
                onSelectChat={handleSelectChat}
                onTagClick={handleTagClick}
            />
          </>
        )}
      </div>

      {state.isUploading && (
        <UploadModal 
          onClose={() => setState(prev => ({ ...prev, isUploading: false }))} 
          onUpload={handleUpload}
          settings={state.settings}
        />
      )}

      {state.isSettingsOpen && (
        <SettingsModal 
          settings={state.settings}
          onClose={() => setState(prev => ({ ...prev, isSettingsOpen: false }))}
          onSave={(settings) => setState(prev => ({ ...prev, settings }))}
          onBackup={() => {}} 
          onClearAll={handleClearAll}
        />
      )}
    </div>
  );
};

export default App;
