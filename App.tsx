
import React, { useState, useEffect, useMemo } from 'react';
import { ChatEntry, SourceType, AppState, Settings, Theme, AIProvider, ViewMode, ItemType, Link, CaptureData, FoundationCaptureState, SourceFileState } from './types';
import { Sidebar } from './components/Sidebar';
import { SearchIcon, PlusIcon, DatabaseIcon, SettingsIcon, XIcon, ChartIcon, NetworkIcon, ActivityIcon, BoltIcon } from './components/Icons';
import { UploadModal, SourceFileRef, AttachmentRef } from './components/UploadModal';
import { ChatViewer } from './components/ChatViewer';
import { SettingsModal } from './components/SettingsModal';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { RightSidebar } from './components/RightSidebar';
import { AdvancedSearch } from './components/AdvancedSearch';
import { buildChatIngestPayload } from './utils/foundationCapture';
import { foundationContentHash, normalizeUrl } from './utils/chatDedup';

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
      clearDatabase: () => Promise<boolean>;
      addLink: (fromId: string, toId: string, type?: string) => Promise<boolean>;
      removeLink: (fromId: string, toId: string) => Promise<boolean>;
      loadLinks: () => Promise<Link[]>;
      captureChatToFoundation: (payload: any) => Promise<{
        ok: boolean;
        status?: number;
        id?: string;
        insertedNew?: boolean;
        providerConversationId?: string;
        ingestedAt?: string;
        error?: string;
        details?: string[];
      }>;
      captureSourceFileToFoundation: (file: { path: string; filename: string; mimeType: string }) => Promise<{
        ok: boolean;
        hash: string;
        remoteHash?: string;
        identical?: boolean;
        size: number;
        status?: number;
        ingestObjectId?: string;
        reused?: boolean;
        mirrored?: boolean;
        error?: string;
      }>;
      uploadAttachmentToFoundation: (file: { path?: string; dataUrl?: string; filename: string; mimeType: string }) => Promise<{
        ok: boolean;
        status?: number;
        attachment?: { id: string; filename?: string; mimeType?: string; size?: number; url?: string };
        error?: string;
      }>;
      getPathForFile: (file: File) => string;
      analyzeContent: (args: { content: string; imageMimeType?: string; preferredModel?: string }) => Promise<{ ok: boolean; metadata?: { summary: string; tags: string[]; suggestedTitle: string }; error?: string }>;
      generateEmbedding: (args: { text: string }) => Promise<{ ok: boolean; embedding?: number[]; error?: string }>;
      fetchModels: () => Promise<{ ok: boolean; models?: string[]; error?: string }>;
      exportChats: (chats: any[], format: string) => Promise<{success: boolean, path?: string, error?: string, cancelled?: boolean}>;
      importChats: (existingIds: string[]) => Promise<{success: boolean, chats: any[], skipped: number, missing?: string[], error?: string, cancelled?: boolean}>;
      sendNotification: (title: string, body: string) => void;
      setMinimizeToTray: (enabled: boolean) => Promise<boolean>;
      platform: string;
      onChatIngested?: (callback: (payload: { id: string; action: string; title?: string }) => void) => () => void;
    };
  }
}

const DEFAULT_SETTINGS: Settings = {
  theme: Theme.LIGHT,
  aiProvider: AIProvider.GEMINI,
  preferredModel: 'gemini-flash-latest',
  customEndpoint: 'http://localhost:1234/v1/chat/completions',
  relatedChatsLimit: 9,
  availableModels: [],
  userAvatar: undefined,
  userName: '',
  minimizeToTray: false
};

type ImportNotice = { kind: 'duplicate' | 'updated'; title: string } | null;


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
    showArchived: false,
    searchFilters: {
        sources: [],
        dateStart: '',
        dateEnd: '',
        minLength: 0,
        isSemantic: false,
        type: 'all'
    }
  });

  const [importNotice, setImportNotice] = useState<ImportNotice>(null);

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
  // A chat arrived via the ingest listener (plugin door) while the app was
  // running: reload from the database so the archive view shows it without a
  // restart. The listener wrote the row; the renderer just re-reads.
  useEffect(() => {
    if (!window.electronAPI?.onChatIngested) return;
    const unsubscribe = window.electronAPI.onChatIngested(async () => {
      const chats = await window.electronAPI!.loadDatabase() || [];
      setState(prev => ({
        ...prev,
        chats,
        // Het open gesprek wijst na elke ingest naar de verse rij; wordt die
        // niet gevonden, dan blijft de huidige staan.
        viewingChat: prev.viewingChat
          ? chats.find(c => c.id === prev.viewingChat!.id) ?? prev.viewingChat
          : null,
      }));
    });
    return unsubscribe;
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
    // De main-process beslist of minimaliseren naar het systeemvak gaat; die
    // keuze leeft hier in localStorage, dus geef hem bij elke wijziging door.
    window.electronAPI?.setMinimizeToTray?.(state.settings.minimizeToTray ?? false);
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

  const setFoundationState = (id: string, foundation: FoundationCaptureState) => {
    setState(prev => ({
      ...prev,
      chats: prev.chats.map(c => (c.id === id ? { ...c, foundation } : c)),
      viewingChat: prev.viewingChat?.id === id ? { ...prev.viewingChat, foundation } : prev.viewingChat,
    }));
  };

  const setSourceFileState = (id: string, sourceFile: SourceFileState) => {
    setState(prev => ({
      ...prev,
      chats: prev.chats.map(c => (c.id === id ? { ...c, sourceFile } : c)),
      viewingChat: prev.viewingChat?.id === id ? { ...prev.viewingChat, sourceFile } : prev.viewingChat,
    }));
  };

  // Mirrors the original file locally and sends the same bytes to Foundation
  // (the owner). A failure leaves the mirror note on the entry for a retry.
  const captureSourceFile = async (chat: ChatEntry, ref: SourceFileRef) => {
    if (!window.electronAPI?.captureSourceFileToFoundation) return;
    const result = await window.electronAPI.captureSourceFileToFoundation(ref);
    if (result.ok) {
      setSourceFileState(chat.id, {
        hash: result.hash,
        size: result.size,
        filename: ref.filename,
        mimeType: ref.mimeType,
        path: ref.path,
        status: 'sent',
        identical: result.identical,
        ingestObjectId: result.ingestObjectId,
        at: Date.now(),
      });
    } else {
      setSourceFileState(chat.id, {
        hash: result.hash || '',
        size: result.size || 0,
        filename: ref.filename,
        mimeType: ref.mimeType,
        path: ref.path,
        status: 'failed',
        error: result.error || 'source file capture failed',
        at: Date.now(),
      });
    }
  };

  const setCapture = (id: string, capture: CaptureData) => {
    setState(prev => ({
      ...prev,
      chats: prev.chats.map(c => (c.id === id ? { ...c, capture } : c)),
      viewingChat: prev.viewingChat?.id === id ? { ...prev.viewingChat, capture } : prev.viewingChat,
    }));
  };

  // Sends one chat's raw capture to Foundation and records the delivery status
  // on the entry. Never throws: a failure here becomes a retryable state, it
  // can never undo the archive write that already happened.
  const captureToFoundation = async (chat: ChatEntry, attachmentRefs: AttachmentRef[] = []) => {
    if (!chat.capture || !window.electronAPI?.captureChatToFoundation) return;

    // First upload the images that belong to this conversation (same source
    // only), so the chat payload can reference them. A failed image is dropped,
    // never blocking the chat itself.
    let capture = chat.capture;
    if (attachmentRefs.length && window.electronAPI?.uploadAttachmentToFoundation) {
      const uploaded: NonNullable<CaptureData['attachments']> = [];
      for (const ref of attachmentRefs) {
        const up = await window.electronAPI.uploadAttachmentToFoundation(ref);
        if (up.ok && up.attachment?.id) uploaded.push(up.attachment);
      }
      capture = { ...capture, attachments: uploaded };
      setCapture(chat.id, capture);
    }

    let payload;
    try {
      payload = buildChatIngestPayload({
        content: chat.content,
        title: chat.title,
        sourceProvider: capture.sourceProvider,
        url: capture.url,
        occurredAt: capture.occurredAt,
        turns: capture.turns,
        attachments: capture.attachments,
      });
    } catch (err: any) {
      setFoundationState(chat.id, { status: 'failed', error: err?.message || 'invalid capture payload', at: Date.now() });
      return;
    }
    const result = await window.electronAPI.captureChatToFoundation(payload);
    if (result.ok) {
      setFoundationState(chat.id, {
        status: 'sent',
        providerConversationId: result.providerConversationId,
        id: result.id,
        at: Date.now(),
      });
    } else {
      setFoundationState(chat.id, {
        status: 'failed',
        error: result.details?.length ? result.details.join('; ') : (result.error || 'capture failed'),
        at: Date.now(),
      });
    }
  };

  const handleUpload = (content: string, source: string, title: string, summary: string, tags: string[], fileName: string, embedding?: number[], assets?: string[], capture?: CaptureData, sourceFileRef?: SourceFileRef, attachmentRefs?: AttachmentRef[], silent = false): 'added' | 'updated' | 'duplicate' => {
    const now = Date.now();
    const contentHash = foundationContentHash(content);
    // The conversation's own moment (carried by the export as capture.occurredAt)
    // becomes the archive date, so an import shows on its real date instead of
    // the day it was imported. Falls back to now when the source has no time.
    const occurredMs = capture?.occurredAt ? Date.parse(capture.occurredAt) : NaN;
    const occurredAt = Number.isFinite(occurredMs) ? occurredMs : now;

    // Dedup: is this conversation already in the archive? Exact URL first,
    // content hash as the fallback for URL-less sources (utils/chatDedup).
    const existing = state.chats.find(c => {
      const urlMatch = capture?.url && c.capture?.url && normalizeUrl(c.capture.url) === normalizeUrl(capture.url);
      const hashMatch = (c.contentHash || foundationContentHash(c.content)) === contentHash;
      return urlMatch || hashMatch;
    });

    if (existing) {
      const identical = (existing.contentHash || foundationContentHash(existing.content)) === contentHash;
      if (identical) {
        // Same chat, same content: do not import a duplicate.
        if (!silent) setImportNotice({ kind: 'duplicate', title: existing.title });
        return 'duplicate';
      }
      // Same chat, grown or changed: update in place, then re-capture so Gaia
      // sees the newer version too.
      const updated: ChatEntry = {
        ...existing,
        title: title || existing.title,
        content, summary: summary || existing.summary, tags, source,
        embedding, assets,
        capture: capture ? { ...existing.capture, ...capture } : existing.capture,
        contentHash,
        fileName,
        sourceFile: sourceFileRef
          ? { hash: '', size: 0, filename: sourceFileRef.filename, mimeType: sourceFileRef.mimeType, path: sourceFileRef.path, status: 'pending', at: now }
          : existing.sourceFile,
        foundation: capture ? { status: 'pending', at: now } : existing.foundation,
        updatedAt: now,
      };
      setState(prev => ({ ...prev, chats: prev.chats.map(c => c.id === existing.id ? updated : c), isUploading: false, viewingChat: updated, viewMode: 'archive' }));
      if (!silent) setImportNotice({ kind: 'updated', title: updated.title });
      if (sourceFileRef) void captureSourceFile(updated, sourceFileRef);
      if (capture) void captureToFoundation(updated, attachmentRefs);
      return 'updated';
    }

    const newChat: ChatEntry = {
      id: Math.random().toString(36).substr(2, 9),
      type: ItemType.CHAT,
      title, content, summary, tags, source, 
      createdAt: occurredAt, 
      updatedAt: occurredAt,
      fileName, embedding, assets,
      capture,
      contentHash,
      foundation: capture ? { status: 'pending', at: now } : undefined,
      sourceFile: sourceFileRef ? { hash: '', size: 0, filename: sourceFileRef.filename, mimeType: sourceFileRef.mimeType, path: sourceFileRef.path, status: 'pending', at: now } : undefined,
    };
    // Archive first. Persistence of the entry never waits on the capture steps.
    setState(prev => ({ ...prev, chats: [newChat, ...prev.chats], isUploading: false, viewingChat: newChat, viewMode: 'archive' }));
    // Then, in order: the original file (the proof), then the raw chat with any
    // images that belong to it.
    if (sourceFileRef) void captureSourceFile(newChat, sourceFileRef);
    if (capture) void captureToFoundation(newChat, attachmentRefs);
    return 'added';
  };

  // Bulk import from the native (Electron) picker: one entry per conversation,
  // each run through the same dedup + Foundation-capture path as any upload.
  // Silent: the per-chat toast is replaced by one summary in the settings modal.
  const handleNativeImport = (chats: any[]) => {
    const summary = { added: 0, updated: 0, duplicate: 0 };
    for (const chat of chats) {
      const outcome = handleUpload(
        chat.content,
        chat.source,
        chat.title,
        chat.summary || '',
        chat.tags || [],
        chat.fileName || chat.title,
        chat.embedding,
        chat.assets,
        chat.capture,
        undefined,
        undefined,
        true
      );
      summary[outcome]++;
    }
    return summary;
  };

  const handleRetryCapture = (chat: ChatEntry) => {
    void captureToFoundation(chat);
  };

  const handleRetrySourceFile = (chat: ChatEntry) => {
    if (!chat.sourceFile?.path) return;
    void captureSourceFile(chat, {
      path: chat.sourceFile.path,
      filename: chat.sourceFile.filename || chat.fileName || 'export',
      mimeType: chat.sourceFile.mimeType || 'application/octet-stream',
    });
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

  const handleClearAll = async () => {
    // Delete for real before clearing the view, otherwise the rows reload on the
    // next launch and the archive looks like it was never wiped.
    if (window.electronAPI?.clearDatabase) {
      await window.electronAPI.clearDatabase();
    }
    setState(prev => ({ ...prev, chats: [], viewingChat: null, links: [] }));
  };

  // Archiving hides a chat from the active archive but keeps it in Chronicle
  // (and in Gaia). It never deletes the row and never touches the Foundation
  // observation — see capture-chronicle.md.
  const handleArchive = (id: string) => setState(prev => ({
    ...prev,
    chats: prev.chats.map(c => c.id === id ? { ...c, archived: true, updatedAt: Date.now() } : c),
    viewingChat: prev.viewingChat?.id === id ? null : prev.viewingChat,
  }));
  const handleRestore = (id: string) => setState(prev => ({
    ...prev,
    chats: prev.chats.map(c => c.id === id ? { ...c, archived: false, updatedAt: Date.now() } : c),
  }));
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
        const matchesArchived = state.showArchived ? !!chat.archived : !chat.archived;

        return matchesSearch && matchesTags && matchesType && matchesSource && matchesDateStart && matchesDateEnd && matchesArchived;
    });
  }, [state.chats, state.searchQuery, state.selectedTags, state.selectedType, state.selectedSource, state.searchFilters.dateStart, state.searchFilters.dateEnd, state.showArchived]);

  const relatedChats = useMemo(() => {
      const tags = state.relatedTags || [];
      return tags.length === 0 ? [] : [...state.chats].filter(chat => tags.every(t => chat.tags.includes(t)));
  }, [state.chats, state.relatedTags]);

  const isMacOS = window.electronAPI?.platform === 'darwin';

  return (
    <div className={`flex flex-col h-screen bg-paper dark:bg-stone-950 text-earth-dark dark:text-stone-100 transition-colors duration-300 overflow-hidden ${isMacOS ? 'pt-4' : ''}`}>
      
      <header className={`h-16 shrink-0 bg-warm-beige dark:bg-stone-900/90 backdrop-blur-md border-b border-sandstone dark:border-stone-800 flex items-center justify-between px-6 z-50 ${isMacOS ? 'pl-20' : ''}`}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setState(prev => ({ ...prev, viewMode: 'dashboard', viewingChat: null }))}>
          <div className="bg-[#394239] p-2 rounded-xl shadow-lg shadow-[#394239]/20 text-white">
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
                className="flex items-center gap-2 bg-[#394239] hover:bg-[#2C362C] text-white px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm"
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
              showArchived={state.showArchived}
              onShowArchivedChange={(show) => setState(prev => ({ ...prev, showArchived: show }))}
            />

            <main className="flex-1 bg-paper dark:bg-stone-950 relative overflow-hidden">
              {state.viewingChat ? (
                <ChatViewer 
                  chat={state.viewingChat} 
                  allChats={state.chats}
                  allLinks={state.links}
                  onClose={() => setState(prev => ({ ...prev, viewingChat: null, viewMode: prev.returnToMindMap ? 'mindmap' : 'archive', returnToMindMap: false }))}
                  onArchive={handleArchive}
                  onRestore={handleRestore}
                  onUpdate={handleUpdate}
                  onSelectChat={handleSelectChat}
                  onAddLink={handleAddLink}
                  onRemoveLink={handleRemoveLink}
                  onTagClick={handleTagClick}
                  settings={state.settings}
                  returnToMindMap={state.returnToMindMap}
                  activeRelatedTags={state.relatedTags}
                  onRetryCapture={handleRetryCapture}
                  onRetrySourceFile={handleRetrySourceFile}
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

      {importNotice && (
        <div className="fixed bottom-6 right-6 z-[80] max-w-sm">
          <div className={`flex items-start gap-3 p-4 rounded-2xl shadow-2xl border text-xs font-bold ${
            importNotice.kind === 'duplicate'
              ? 'bg-white dark:bg-stone-900 border-sandstone/40 text-earth-dark dark:text-stone-200'
              : 'bg-sage-green/10 border-sage-green/40 text-sage-green'
          }`}>
            <span className="flex-1">
              {importNotice.kind === 'duplicate'
                ? <>Already in your archive — not imported again: <span className="not-italic">"{importNotice.title}"</span></>
                : <>Updated existing chat (grew since last import): <span className="not-italic">"{importNotice.title}"</span></>}
            </span>
            <button onClick={() => setImportNotice(null)} className="text-moss-brown hover:text-earth-dark shrink-0" aria-label="Dismiss">
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

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
          onNativeImport={handleNativeImport}
        />
      )}
    </div>
  );
};

export default App;
