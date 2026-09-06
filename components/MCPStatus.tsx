
import React from 'react';
import { TerminalIcon, RefreshIcon, DatabaseIcon, SearchIcon, TagIcon, NetworkIcon, ActivityIcon, MessageIcon } from './Icons';

interface MCPStatusProps {
  isNative: boolean;
  exePath: string;
}

const MCP_TOOLS = [
  { name: 'search_archive', icon: <SearchIcon />, desc: 'Keyword search across titles, summaries, and tags.' },
  { name: 'semantic_search', icon: <NetworkIcon />, desc: 'Concept-based similarity search using vector embeddings.' },
  { name: 'hybrid_search', icon: <RefreshIcon />, desc: 'Advanced combined lexical and semantic search.' },
  { name: 'filter_chats', icon: <ActivityIcon />, desc: 'Advanced filtering by date, source, length, and tags.' },
  { name: 'get_recent_chats', icon: <MessageIcon />, desc: 'Retrieve the latest conversation logs.' },
  { name: 'list_tags', icon: <TagIcon />, desc: 'List all unique conceptual tags in the database.' },
  { name: 'get_chat_by_id', icon: <DatabaseIcon />, desc: 'Fetch full transcript and metadata for a specific ID.' },
];

export const MCPStatus: React.FC<MCPStatusProps> = ({ isNative, exePath }) => {
  const mcpConfig = JSON.stringify({
    "mcpServers": {
      "chronicle": {
        "command": exePath || "chronicle",
        "args": ["--mcp"],
        "env": {}
      }
    }
  }, null, 2);

  const handleCopyConfig = () => {
    navigator.clipboard.writeText(mcpConfig);
    alert("Claude Desktop configuration template copied to clipboard!");
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500 text-left">
      {/* Status Header */}
      <div className="flex flex-col gap-4 p-6 rounded-2xl bg-white dark:bg-slate-800 border border-sandstone dark:border-slate-700 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl ${isNative ? 'bg-green-500/10 text-green-600' : 'bg-blue-500/10 text-blue-600'}`}>
              <TerminalIcon />
            </div>
            <div>
              <h3 className="text-sm font-black text-earth-dark dark:text-white uppercase tracking-tight">Intelligence Bridge (MCP)</h3>
              <p className="text-[10px] text-moss-brown font-bold uppercase tracking-widest">Model Context Protocol Integration</p>
            </div>
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
             <div className={`w-2 h-2 rounded-full ${isNative ? 'bg-green-500 animate-pulse' : 'bg-blue-500'}`}></div>
             <span className="text-[10px] font-black text-slate-600 dark:text-slate-400">
                {isNative ? 'SERVER RUNNING' : 'WEB RELAY MODE'}
             </span>
          </div>
        </div>
        <p className="text-xs text-moss-brown dark:text-slate-400 font-serif italic leading-relaxed">
          The Model Context Protocol allows AI agents like Claude Desktop to search and read your personal archive directly from their chat interface.
        </p>
      </div>

      {/* Tools Section */}
      <div className="space-y-4">
        <h4 className="text-[10px] font-black text-moss-brown uppercase tracking-widest pl-1">Exposed Capabilities</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="flex gap-3 p-4 bg-white dark:bg-slate-800/50 border border-sandstone/30 dark:border-slate-800 rounded-xl hover:border-sage-green/50 transition-colors group">
              <div className="text-moss-brown group-hover:text-sage-green transition-colors shrink-0">
                {tool.icon}
              </div>
              <div>
                <p className="text-xs font-black text-earth-dark dark:text-slate-200 font-mono mb-0.5">{tool.name}</p>
                <p className="text-[10px] text-moss-brown dark:text-slate-500 leading-tight">{tool.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Configuration Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between pl-1">
          <h4 className="text-[10px] font-black text-moss-brown uppercase tracking-widest">Claude Desktop Configuration</h4>
          <button 
            onClick={handleCopyConfig}
            className="text-[10px] font-black text-sage-green hover:underline flex items-center gap-1"
          >
            Copy JSON Template
          </button>
        </div>
        <div className="relative group">
          <pre className="bg-slate-950 text-blue-400 p-6 rounded-2xl border border-slate-800 font-mono text-[11px] leading-relaxed overflow-x-auto shadow-inner">
            {mcpConfig}
          </pre>
          <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
             <div className="bg-slate-800 text-slate-400 text-[9px] px-2 py-1 rounded border border-slate-700">Read Only</div>
          </div>
        </div>
        <div className="p-4 bg-sandstone/10 dark:bg-slate-800/30 rounded-xl border border-sandstone/20">
           <p className="text-[10px] text-earth-dark/70 dark:text-slate-400 leading-relaxed font-sans italic">
             <b>Setup:</b> Paste the above into your <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (MacOS) 
             or <code>%APPDATA%/Claude/claude_desktop_config.json</code> (Windows) and restart Claude.
           </p>
        </div>
      </div>
    </div>
  );
};
