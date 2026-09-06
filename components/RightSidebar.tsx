
import React from 'react';
import { ChatEntry } from '../types';
import { ChatCard } from './ChatCard';
import { XIcon, TagIcon } from './Icons';

interface RightSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  selectedTags: string[];
  onRemoveTag: (tag: string) => void;
  filteredChats: ChatEntry[];
  onSelectChat: (chat: ChatEntry) => void;
  onTagClick: (tag: string) => void;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({
  isOpen,
  onClose,
  selectedTags,
  onRemoveTag,
  filteredChats,
  onSelectChat,
  onTagClick
}) => {
  return (
    <>
      <div 
        className={`fixed inset-y-0 right-0 w-80 md:w-96 bg-paper dark:bg-stone-900 border-l border-sandstone dark:border-stone-800 shadow-2xl transform transition-transform duration-300 ease-in-out z-50 flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-sandstone dark:border-stone-800 bg-paper dark:bg-stone-900">
           <div className="flex items-center gap-2 text-earth-dark dark:text-white font-bold">
              <div className="bg-sage-green/20 p-1.5 rounded-lg text-sage-green">
                 <TagIcon />
              </div>
              <h3>Related Chats</h3>
           </div>
           <button onClick={onClose} className="text-moss-brown hover:text-earth-dark dark:hover:text-white transition-colors">
              <XIcon />
           </button>
        </div>

        <div className="p-4 bg-sandstone/10 dark:bg-stone-800/30 border-b border-sandstone dark:border-stone-800">
           <div className="flex justify-between items-center mb-2">
              <p className="text-[10px] uppercase font-bold text-moss-brown tracking-widest">Active Filters</p>
              {selectedTags.length > 0 && (
                  <button onClick={onClose} className="text-[10px] text-sage-green hover:underline">Done</button>
              )}
           </div>
           <div className="flex flex-wrap gap-2">
              {selectedTags.length === 0 && (
                  <span className="text-xs text-stone-400 italic">Click a tag in any chat to filter...</span>
              )}
              {selectedTags.map(tag => (
                  <button 
                    key={tag}
                    onClick={() => onRemoveTag(tag)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sage-green text-white text-xs font-bold shadow-sm hover:bg-red-500 transition-colors group animate-in fade-in zoom-in duration-200"
                  >
                    {tag}
                    <XIcon className="h-3 w-3" />
                  </button>
              ))}
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-paper dark:bg-stone-950">
            {filteredChats.map(chat => (
                <div key={chat.id} className="scale-95 origin-top w-full"> 
                    <ChatCard 
                        chat={chat}
                        onClick={() => onSelectChat(chat)}
                        onTagClick={onTagClick}
                    />
                </div>
            ))}
            {filteredChats.length === 0 && selectedTags.length > 0 && (
                <div className="text-center py-10 text-stone-400 text-sm italic">
                   No chats contain all these tags.
                </div>
            )}
        </div>
      </div>
    </>
  );
};
