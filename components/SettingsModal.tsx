
import React, { useState, useRef, useEffect } from 'react';
import { Settings, Theme, AIProvider } from '../types';
import { XIcon, ActivityIcon, FileIcon, DatabaseIcon, PlusIcon, TerminalIcon, RefreshIcon } from './Icons';
import { fetchAvailableModels } from '../services/geminiService';
import { PACKAGE_JSON, SERVER_JS } from '../utils/mcpTemplates';
import { MCPStatus } from './MCPStatus';

interface SettingsModalProps {
  settings: Settings;
  onClose: () => void;
  onSave: (settings: Settings) => void;
  onAddDemo: () => void;
  onRemoveDemo: () => void;
  onBackup: () => void;
  onClearAll: () => void;
  onNativeImport?: (chats: any[]) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings, 
  onClose, 
  onSave, 
  onAddDemo, 
  onRemoveDemo,
  onBackup,
  onClearAll,
  onNativeImport
}) => {
  const [localSettings, setLocalSettings] = useState<Settings>(settings);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<'general' | 'ai' | 'mcp'>('general');
  const [exePath, setExePath] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getExecutablePath().then(setExePath);
    }
  }, []);

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  const handleConnect = async () => {
    setIsFetchingModels(true);
    setFetchError(null);
    try {
      const models = await fetchAvailableModels(localSettings);
      setLocalSettings(prev => ({
        ...prev,
        availableModels: models,
        preferredModel: models.length > 0 ? models[0] : prev.preferredModel
      }));
    } catch (err: any) {
      setFetchError(`Connection failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        alert("Image too large. Maximum size is 2MB.");
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setLocalSettings({ ...localSettings, userAvatar: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleNativeImport = async () => {
    if (!window.electronAPI) return;
    const existingIds = JSON.parse(localStorage.getItem('chronicle_chats_v1') || '[]').map((c: any) => c.id);
    const result = await window.electronAPI.importChats(existingIds);
    if (result.success && result.chats.length > 0) {
      onNativeImport?.(result.chats);
      alert(`Successfully imported ${result.chats.length} chats! (Skipped ${result.skipped} duplicates)`);
    } else if (result.success) {
      alert("No new conversations found to import.");
    } else if (result.error) {
      alert(`Import error: ${result.error}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto">
      <div className="bg-warm-beige dark:bg-slate-900 border border-sandstone dark:border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col my-8 relative overflow-hidden font-sans">
        
        {showClearConfirm && (
          <div className="absolute inset-0 z-[70] bg-warm-beige/95 dark:bg-slate-900/95 flex flex-col items-center justify-center p-8 rounded-2xl animate-in fade-in duration-200 text-center">
            <div className="bg-red-500/10 p-4 rounded-full text-red-600 mb-6"><XIcon /></div>
            <h3 className="text-xl font-bold text-earth-dark dark:text-white mb-2">Wipe Entire Archive?</h3>
            <p className="text-moss-brown dark:text-slate-400 mb-8 max-w-xs">This action is permanent. Create a backup first?</p>
            <div className="flex flex-col w-full gap-3">
              <button onClick={onBackup} className="w-full bg-sage-green text-white py-3 rounded-xl font-bold shadow-lg flex items-center justify-center gap-2"><DatabaseIcon /> Backup Archive</button>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setShowClearConfirm(false)} className="bg-white dark:bg-slate-800 text-earth-dark dark:text-slate-200 py-3 rounded-xl font-bold transition-all">Cancel</button>
                <button onClick={() => { onClearAll(); setShowClearConfirm(false); }} className="bg-terracotta text-white py-3 rounded-xl font-bold transition-all">Yes, Delete All</button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center p-6 border-b border-sandstone dark:border-slate-800">
          <h2 className="text-xl font-bold text-earth-dark dark:text-white">Chronicle Preferences</h2>
          <button onClick={onClose} className="text-moss-brown hover:text-earth-dark dark:hover:text-white transition-colors"><XIcon /></button>
        </div>

        <div className="flex bg-sandstone/10 dark:bg-slate-800/50 p-1 border-b border-sandstone dark:border-slate-800">
          <button onClick={() => setActiveTab('general')} className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider transition-all rounded-lg ${activeTab === 'general' ? 'bg-white dark:bg-slate-700 text-earth-dark dark:text-white shadow-sm' : 'text-moss-brown'}`}>General</button>
          <button onClick={() => setActiveTab('ai')} className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider transition-all rounded-lg ${activeTab === 'ai' ? 'bg-white dark:bg-slate-700 text-earth-dark dark:text-white shadow-sm' : 'text-moss-brown'}`}>AI Engine</button>
          <button onClick={() => setActiveTab('mcp')} className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider transition-all rounded-lg ${activeTab === 'mcp' ? 'bg-white dark:bg-slate-700 text-earth-dark dark:text-white shadow-sm' : 'text-moss-brown'}`}>MCP & Status</button>
        </div>

        <div className="p-8 space-y-8 max-h-[60vh] overflow-y-auto">
          {activeTab === 'general' && (
            <>
              <section>
                <label className="block text-[10px] font-bold text-moss-brown mb-4 uppercase tracking-widest">User Profile</label>
                <div className="flex items-center gap-6">
                  <div className="w-20 h-20 rounded-full bg-sandstone/20 dark:bg-slate-800 border-2 border-dashed border-sandstone dark:border-slate-700 flex items-center justify-center overflow-hidden cursor-pointer hover:border-sage-green group relative" onClick={() => fileInputRef.current?.click()}>
                    {localSettings.userAvatar ? <img src={localSettings.userAvatar} className="w-full h-full object-cover" alt="User Avatar" /> : <PlusIcon />}
                    <input type="file" ref={fileInputRef} className="hidden" onChange={handleAvatarUpload} />
                  </div>
                  <input 
                    type="text" 
                    value={localSettings.userName || ''} 
                    onChange={(e) => setLocalSettings({...localSettings, userName: e.target.value})}
                    placeholder="Your Name"
                    className="flex-1 bg-white dark:bg-slate-900 border border-sandstone dark:border-slate-700 rounded-xl px-4 py-3 text-lg font-bold outline-none focus:ring-2 focus:ring-sage-green"
                  />
                </div>
              </section>

              <section>
                <label className="block text-[10px] font-bold text-moss-brown mb-4 uppercase tracking-widest">Appearance</label>
                <div className="grid grid-cols-3 gap-3">
                  {(['light', 'dark', 'system'] as Theme[]).map((t) => (
                    <button key={t} onClick={() => setLocalSettings({ ...localSettings, theme: t })} className={`py-3 rounded-xl text-xs font-bold border transition-all ${localSettings.theme === t ? 'bg-sage-green border-sage-green text-white shadow-md' : 'bg-white dark:bg-slate-800 border-sandstone dark:border-slate-700 text-moss-brown'}`}>
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <label className="block text-[10px] font-bold text-moss-brown mb-4 uppercase tracking-widest">Data Management</label>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={onAddDemo} className="flex items-center justify-center gap-2 py-3 bg-white dark:bg-slate-800 border border-sandstone dark:border-slate-700 rounded-xl text-xs font-bold hover:bg-sandstone/10">Add Demo</button>
                  <button onClick={onRemoveDemo} className="flex items-center justify-center gap-2 py-3 bg-white dark:bg-slate-800 border border-sandstone dark:border-slate-700 rounded-xl text-xs font-bold hover:bg-sandstone/10">Remove Demo</button>
                  {window.electronAPI && (
                    <button onClick={handleNativeImport} className="col-span-2 flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl text-xs font-bold shadow-lg">Native Bulk Import (GPT/Claude)</button>
                  )}
                  <button onClick={onBackup} className="col-span-2 flex items-center justify-center gap-2 py-3 bg-sage-green text-white rounded-xl text-xs font-bold shadow-lg">Export Archive (Native/JSON)</button>
                  <button onClick={() => setShowClearConfirm(true)} className="col-span-2 flex items-center justify-center gap-2 py-3 text-terracotta text-xs font-bold hover:underline">Wipe All Data</button>
                </div>
              </section>
            </>
          )}

          {activeTab === 'ai' && (
            <section className="space-y-6 text-left">
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl">
                 <p className="text-[10px] font-black text-blue-600 dark:text-blue-400 uppercase tracking-widest mb-1">Security & Governance</p>
                 <p className="text-[11px] text-blue-800 dark:text-blue-300 italic">This instance is configured via system-level environment variables. Personal API keys are never stored in the browser's persistent storage.</p>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-moss-brown mb-4 uppercase tracking-widest">Provider Context</label>
                <div className="grid grid-cols-2 gap-2">
                  {[AIProvider.GEMINI, AIProvider.LMSTUDIO].map((p) => (
                    <button key={p} onClick={() => setLocalSettings({...localSettings, aiProvider: p})} className={`py-2 rounded-lg text-[10px] font-black border transition-all ${localSettings.aiProvider === p ? 'bg-sage-green border-sage-green text-white' : 'bg-white dark:bg-slate-800 border-sandstone dark:border-slate-700 text-moss-brown'}`}>{p}</button>
                  ))}
                </div>
              </div>

              <div className="bg-sandstone/5 dark:bg-slate-800/30 p-6 rounded-2xl border border-sandstone/20 space-y-4">
                <button onClick={handleConnect} disabled={isFetchingModels} className="w-full py-2 bg-white dark:bg-slate-700 rounded-lg text-xs font-bold border border-sandstone flex items-center justify-center gap-2 shadow-sm">
                  {isFetchingModels ? <RefreshIcon className="animate-spin" /> : 'Synchronize Model Registry'}
                </button>
                {fetchError && <p className="text-[10px] text-red-500 font-bold">{fetchError}</p>}
                <select value={localSettings.preferredModel} onChange={(e) => setLocalSettings({...localSettings, preferredModel: e.target.value})} className="w-full bg-white dark:bg-slate-900 border border-sandstone rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-sage-green">
                  {localSettings.availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                  {localSettings.availableModels.length === 0 && <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>}
                </select>
              </div>
            </section>
          )}

          {activeTab === 'mcp' && (
            <MCPStatus 
              isNative={!!window.electronAPI} 
              exePath={exePath} 
            />
          )}
        </div>

        <div className="p-6 bg-paper dark:bg-slate-900 border-t border-sandstone dark:border-slate-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2 text-sm font-semibold text-moss-brown hover:text-earth-dark">Cancel</button>
          <button onClick={handleSave} className="bg-sage-green text-white px-8 py-2.5 rounded-xl font-bold shadow-xl active:scale-95 transition-all">Update Preferences</button>
        </div>
      </div>
    </div>
  );
};
