
import React, { useState, useMemo, useEffect, useRef, Component } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatEntry, Settings, ItemType, Link } from '../types';
import { XIcon, TagIcon, NetworkIcon, MessageIcon, ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, RefreshIcon, PencilIcon, SearchIcon, PlusIcon, BoltIcon } from './Icons';
import { parseChatMessages, Message } from '../utils/chatUtils';
import { ChatCard } from './ChatCard';
import { cosineSimilarity } from '../utils/vectorUtils';

interface ChatViewerProps {
  chat: ChatEntry;
  allChats: ChatEntry[];
  allLinks: Link[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onUpdate: (chat: ChatEntry) => void;
  onSelectChat: (chat: ChatEntry, fromMindMap?: boolean) => void;
  onAddLink: (fromId: string, toId: string, type?: string) => void;
  onRemoveLink: (fromId: string, toId: string) => void;
  settings: Settings;
  returnToMindMap?: boolean;
  onTagClick: (tag: string) => void;
  activeRelatedTags?: string[];
}

const ImageGallery: React.FC<{ assets: string[] }> = ({ assets }) => (
  <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
    {assets.map((asset, idx) => (
      <div key={idx} className="group relative rounded-2xl overflow-hidden border border-sandstone/30 dark:border-stone-800 shadow-lg">
        <img src={asset} className="w-full h-auto object-cover max-h-96 transition-transform group-hover:scale-[1.02]" alt={`Asset ${idx}`} />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
           <a href={asset} download={`asset-${idx}.png`} className="bg-white text-earth-dark px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl">Download Asset</a>
        </div>
      </div>
    ))}
  </div>
);

// Icon components
const EditIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

const TrashIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const SparklesIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
  </svg>
);

const CopyIcon = ({ className = "h-3 w-3" }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
    </svg>
);

const CodeBlock = React.memo(({ children, className }: { children: any; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const codeString = String(children).replace(/\n$/, '');
  const match = /language-(\w+)/.exec(className || '');
  const lang = match ? match[1] : '';

  const handleCopy = () => {
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-6 rounded-lg overflow-hidden bg-[#1c1917] border border-stone-800 shadow-md transition-all">
      <div className="flex items-center justify-between px-4 py-2 bg-[#292524] border-b border-stone-800">
        <span className="text-[10px] font-mono text-stone-400 lowercase tracking-tight">{lang || 'snippet'}</span>
        <button onClick={handleCopy} className="flex items-center gap-1.5 text-[10px] uppercase font-black tracking-widest text-stone-400 hover:text-white transition-colors">
          <CopyIcon /> {copied ? 'Copied' : 'Copy code'}
        </button>
      </div>
      <div className="p-5 overflow-x-auto">
        <pre className="font-mono text-xs md:text-sm leading-relaxed text-stone-200">
          <code>{codeString}</code>
        </pre>
      </div>
    </div>
  );
});

export const MessageContent = React.memo(({ text }: { text: string }) => {
  return (
    <div className="prose dark:prose-invert max-w-none text-base leading-relaxed text-stone-700 dark:text-stone-300">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }: any) {
            const isInline = !className;
            if (isInline) {
              return <code className="bg-sandstone/10 dark:bg-stone-800 px-1.5 py-0.5 rounded text-earth-dark dark:text-stone-200 font-mono text-[0.9em]" {...props}>{children}</code>;
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          p: ({ children }) => <p className="mb-6 font-serif leading-8">{children}</p>,
          h1: ({ children }) => <h1 className="text-2xl font-black mt-8 mb-4 text-stone-900 dark:text-white font-sans uppercase tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-black mt-6 mb-3 text-stone-900 dark:text-white font-sans uppercase tracking-tight">{children}</h2>,
          strong: ({ children }) => <strong className="text-stone-900 dark:text-white font-black">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-6 mb-6 space-y-2">{children}</ul>,
          blockquote: ({ children }) => <blockquote className="border-l-4 border-sage-green/40 pl-6 py-1 italic text-stone-600 dark:text-stone-400 font-serif my-8">{children}</blockquote>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

interface ErrorBoundaryProps { children?: React.ReactNode; }
interface ErrorBoundaryState { hasError: boolean; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError(_error: any): ErrorBoundaryState { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-red-50 dark:bg-red-950/20 border-2 border-dashed border-red-200 rounded-3xl text-center">
          <p className="text-terracotta font-black uppercase text-xs tracking-widest mb-2">Content Synthesis Failure</p>
        </div>
      );
    }
    return this.props.children;
  }
}

const UserMessageBubble: React.FC<{ message: Message; userAvatar?: string; userName?: string }> = ({ message, userAvatar, userName }) => (
  <div className="flex gap-4 mt-8 mb-8 p-6 bg-white dark:bg-stone-800 rounded-2xl border border-sandstone/30 dark:border-stone-700/50 shadow-md group transition-all">
    <div className="w-8 h-8 rounded-lg bg-[#DBAA89] flex items-center justify-center text-white shrink-0">
      {userAvatar ? <img src={userAvatar} className="w-full h-full rounded-lg object-cover" alt="User" /> : <PlusIcon />}
    </div>
    <div className="flex flex-col flex-1">
      <span className="text-xs font-black uppercase tracking-[0.2em] text-sage-green mb-3 opacity-60">{userName || 'Author'}</span>
      <MessageContent text={message.text} />
    </div>
  </div>
);

const AIMessageContent: React.FC<{ message: Message; source: string }> = ({ message, source }) => (
  <div className="mb-12 pl-6 border-l-4 border-sage-green/10">
    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-moss-brown mb-6 block opacity-50">{source} Channel</span>
    <MessageContent text={message.text} />
  </div>
);

export const ChatViewer: React.FC<ChatViewerProps> = ({ 
  chat, allChats, allLinks, onClose, onDelete, onUpdate, onSelectChat, onAddLink, onRemoveLink, settings, returnToMindMap, onTagClick, activeRelatedTags = [] 
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editTitle, setEditTitle] = useState(chat.title);
  const [editSummary, setEditSummary] = useState(chat.summary);
  const [editTags, setEditTags] = useState<string[]>(chat.tags);
  const [editContent, setEditContent] = useState(chat.content);
  const [isDetecting, setIsDetecting] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  
  const isNote = chat.type === ItemType.NOTE;

  useEffect(() => {
    setEditTitle(chat.title);
    setEditSummary(chat.summary);
    setEditTags(chat.tags);
    setEditContent(chat.content);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [chat.id]);

  const parsedMessages = useMemo(() => parseChatMessages(chat.content, chat.createdAt), [chat.content]);

  const handleSave = () => { onUpdate({ ...chat, title: editTitle, summary: editSummary, tags: editTags, content: editContent }); setIsEditing(false); };
  
  const handleAddAsset = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        onUpdate({ ...chat, assets: [...(chat.assets || []), base64] });
      };
      reader.readAsDataURL(file);
    }
  };

  const formattedDate = new Date(chat.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-paper dark:bg-stone-950 relative">
      {showDeleteConfirm && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center p-6 bg-stone-950/80 backdrop-blur-md animate-in fade-in">
          <div className="max-w-md w-full bg-white dark:bg-stone-900 rounded-[2.5rem] p-10 border-2 border-terracotta/20 shadow-2xl text-center space-y-8 animate-in zoom-in">
            <h2 className="text-2xl font-black text-stone-900 dark:text-white uppercase tracking-tight">Destroy Memory?</h2>
            <p className="text-moss-brown font-serif italic text-base leading-relaxed">Permanently excise <span className="text-earth-dark font-bold font-sans not-italic">"{chat.title}"</span>?</p>
            <div className="flex flex-col gap-3">
              <button onClick={() => setShowDeleteConfirm(false)} className="w-full py-4 rounded-2xl bg-slate-50 dark:bg-stone-800 text-moss-brown font-black text-[10px] uppercase tracking-widest border border-sandstone/20">Abort</button>
              <button onClick={() => onDelete(chat.id)} className="w-full py-4 rounded-2xl bg-terracotta text-white font-black text-[10px] uppercase tracking-widest shadow-xl">Confirm Deletion</button>
            </div>
          </div>
        </div>
      )}

      <div className="px-8 py-6 border-b shrink-0 bg-white dark:bg-stone-900 border-sandstone dark:border-stone-800 z-10">
        <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-4 min-h-[32px]">
                <div>
                    {returnToMindMap && (
                        <button onClick={onClose} className={`inline-flex items-center gap-2 px-4 py-2 text-white rounded-lg text-xs font-black uppercase tracking-widest shadow-lg ${isNote ? 'bg-amber-600' : 'bg-sage-green'}`}>
                            <ArrowLeftIcon /> Neural Map
                        </button>
                    )}
                </div>
            </div>
            <div className="flex justify-between items-start mb-2">
                {isEditing ? (
                    <input className="text-2xl font-black bg-white dark:bg-stone-800 border-2 rounded-xl px-4 py-2 text-earth-dark dark:text-white w-full outline-none focus:border-sage-green" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                ) : (
                    <div className="flex items-center gap-4">
                         <div className={`p-3 rounded-2xl text-white ${isNote ? 'bg-amber-500 shadow-amber-500/20' : 'bg-sage-green shadow-sage-green/20'} shadow-xl`}>
                             {isNote ? <PencilIcon className="w-6 h-6" /> : <MessageIcon className="w-6 h-6" />}
                         </div>
                         <div>
                            <h1 className="text-2xl font-black text-stone-900 dark:text-white uppercase tracking-tight">{chat.title}</h1>
                            <div className="flex items-center gap-2 text-[10px] font-black text-moss-brown uppercase tracking-[0.2em] mt-1">
                                <span>{isNote ? 'PERSONAL SYNTHESIS' : chat.source}</span>
                                <span>•</span>
                                <span>{formattedDate}</span>
                            </div>
                         </div>
                    </div>
                )}
                <div className="flex items-center gap-2 ml-4 shrink-0">
                     {isNote && (
                       <button onClick={() => assetInputRef.current?.click()} className="p-2 text-moss-brown hover:text-earth-dark transition-colors bg-white dark:bg-stone-800 rounded-lg border border-sandstone/20" title="Attach Image">
                         <PlusIcon className="w-4 h-4" />
                         <input type="file" ref={assetInputRef} className="hidden" accept="image/*" onChange={handleAddAsset} />
                       </button>
                     )}
                     <button onClick={() => setIsEditing(!isEditing)} className="p-2 text-moss-brown hover:text-earth-dark transition-colors bg-white dark:bg-stone-800 rounded-lg border border-sandstone/20"><EditIcon /></button>
                     <button onClick={() => setShowDeleteConfirm(true)} className="p-2 text-terracotta hover:text-red-600 transition-colors bg-white dark:bg-stone-800 rounded-lg border border-sandstone/20"><TrashIcon /></button>
                </div>
            </div>
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scroll-smooth">
        <ErrorBoundary>
          <div className="max-w-4xl mx-auto px-8 py-10 space-y-12">
              <div className={`border-2 rounded-3xl p-8 relative shadow-sm ${isNote ? 'bg-amber-50/30 border-amber-200' : 'bg-slate-50/50 border-sandstone/30'}`}>
                  <div className={`absolute -top-3 left-8 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest text-white shadow-md ${isNote ? 'bg-amber-500' : 'bg-sage-green'}`}>Abstract</div>
                  <div className="flex gap-4">
                      <div className="flex-1">
                          {isEditing ? (
                              <textarea className="w-full bg-white dark:bg-stone-800 border-2 border-sandstone/30 rounded-xl p-4 text-sm font-serif italic" value={editSummary} onChange={(e) => setEditSummary(e.target.value)} />
                          ) : (
                              <p className="text-base leading-relaxed italic text-stone-700 dark:text-stone-400 font-serif">{chat.summary}</p>
                          )}
                      </div>
                  </div>
              </div>

              <div className="flex flex-wrap gap-2 px-2">
                  {(isEditing ? editTags : chat.tags).map(tag => (
                      <button key={tag} onClick={() => !isEditing && onTagClick(tag)} className={`px-3 py-1.5 rounded-xl border-2 text-[10px] uppercase font-black tracking-widest flex items-center gap-1.5 ${isNote ? 'bg-amber-100 border-amber-200 text-amber-700' : 'bg-sage-green/10 border-sage-green/20 text-sage-green'}`}>
                          <TagIcon className="w-3 h-3" /> {tag}
                      </button>
                  ))}
              </div>

              <div className={`relative transition-all duration-700 ${isNote ? 'bg-[#FFFDF7] dark:bg-stone-900 p-12 rounded-[2rem] shadow-2xl border-2 border-dashed border-amber-200' : ''}`}>
                  {isEditing && isNote ? (
                    <textarea className="w-full min-h-[400px] bg-transparent font-serif leading-relaxed text-lg outline-none" value={editContent} onChange={(e) => setEditContent(e.target.value)} />
                  ) : (
                    <>
                      {isNote ? <MessageContent text={chat.content} /> : parsedMessages.map((msg, idx) => (
                        msg.role === 'user' 
                          ? <UserMessageBubble key={idx} message={msg} userAvatar={settings.userAvatar} userName={settings.userName} />
                          : <AIMessageContent key={idx} message={msg} source={chat.source} />
                      ))}
                      {chat.assets && chat.assets.length > 0 && (
                        <div className="mt-12 pt-8 border-t border-sandstone/20">
                          <h4 className="text-[10px] font-black text-moss-brown uppercase tracking-widest mb-6">Integrated Visual Assets</h4>
                          <ImageGallery assets={chat.assets} />
                        </div>
                      )}
                    </>
                  )}
              </div>

              {isEditing && (
                  <div className="sticky bottom-8 flex gap-3 justify-end animate-in slide-in-from-bottom-4 z-20">
                      <button onClick={() => setIsEditing(false)} className="px-6 py-3 rounded-2xl bg-white text-stone-500 font-black text-[10px] uppercase border border-sandstone/30 shadow-lg">Discard</button>
                      <button onClick={handleSave} className={`px-8 py-3 rounded-2xl text-white font-black text-[10px] uppercase shadow-lg ${isNote ? 'bg-amber-600' : 'bg-sage-green'}`}>Commit Synthesis</button>
                  </div>
              )}
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
};
