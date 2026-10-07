import React, { useMemo } from 'react';
import { ChatEntry, Link } from '../types';
import { findNearestNeighbors } from '../utils/vectorUtils';
import { LinkIcon } from './Icons';

interface PulseMatch {
  chat: ChatEntry;
  score: number;
  alreadyLinked: boolean;
}

interface ChroniclePulseProps {
  chat: ChatEntry;
  allChats: ChatEntry[];
  allLinks: Link[];
  onSelectChat: (chat: ChatEntry) => void;
  onAddLink: (fromId: string, toId: string, type?: string) => void;
}

const MIN_SCORE = 0.55;
const TOP_K = 5;

export const ChroniclePulse: React.FC<ChroniclePulseProps> = ({
  chat,
  allChats,
  allLinks,
  onSelectChat,
  onAddLink,
}) => {
  const matches = useMemo<PulseMatch[]>(() => {
    if (!chat.embedding || chat.embedding.length === 0) return [];
    const neighbors = findNearestNeighbors(
      chat.embedding,
      allChats.filter(c => c.id !== chat.id && !c.archived),
      TOP_K
    );
    return neighbors
      .filter(({ score }) => score >= MIN_SCORE)
      .map(({ item, score }) => ({
        chat: item,
        score,
        alreadyLinked: allLinks.some(
          l =>
            (l.fromId === chat.id && l.toId === item.id) ||
            (l.fromId === item.id && l.toId === chat.id)
        ),
      }));
  }, [chat, allChats, allLinks]);

  if (!chat.embedding || chat.embedding.length === 0) {
    return (
      <div className="my-8 p-4 rounded-xl border border-sandstone bg-[#F2F1EC] dark:bg-stone-800/40">
        <div className="flex items-center gap-2 mb-1">
          <span className="bg-[#B2C9A1]/30 text-[#2C3E21] dark:text-[#B2C9A1] px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest">Chronicle Pulse</span>
        </div>
        <p className="text-xs text-moss-brown">No embedding available for this entry — semantic connections are not yet available.</p>
      </div>
    );
  }

  if (matches.length === 0) {
    return null;
  }

  return (
    <div className="my-8 p-4 rounded-xl border border-[#B2C9A1]/40 bg-[#FBFBF9] dark:bg-stone-900/60" data-testid="chronicle-pulse">
      <div className="flex items-center gap-2 mb-3">
        <span className="bg-[#B2C9A1]/30 text-[#2C3E21] dark:text-[#B2C9A1] px-2 py-0.5 rounded text-[9px] font-black uppercase tracking-widest">Chronicle Pulse</span>
        <span className="text-[10px] text-moss-brown">Automatically found connections</span>
      </div>
      <div className="space-y-2">
        {matches.map(({ chat: related, score, alreadyLinked }) => {
          const pct = Math.round(score * 100);
          return (
            <div
              key={related.id}
              className="flex items-center justify-between gap-3 p-3 rounded-lg border border-sandstone bg-white dark:bg-stone-800 hover:border-[#8A9482] transition-colors shadow-sm"
              data-testid={`pulse-match-${related.id}`}
            >
              <button
                onClick={() => onSelectChat(related)}
                className="flex-1 text-left min-w-0"
                data-testid={`pulse-open-${related.id}`}
              >
                <span className="block text-xs font-semibold text-earth-dark dark:text-white truncate">{related.title}</span>
                <span className="block text-[10px] text-moss-brown truncate">{related.summary}</span>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#B2C9A1]/20 text-[#2C3E21] dark:text-[#B2C9A1]"
                  title={`Semantic match: ${pct}%`}
                >
                  {pct}%
                </span>
                <button
                  onClick={() => onAddLink(chat.id, related.id, 'related')}
                  disabled={alreadyLinked}
                  className={`p-1.5 rounded-lg border transition-colors ${alreadyLinked
                    ? 'border-sandstone text-sage-green cursor-default'
                    : 'border-[#B2C9A1]/50 text-[#2C3E21] dark:text-[#B2C9A1] hover:bg-[#B2C9A1]/20'}`}
                  title={alreadyLinked ? 'Already connected' : 'Connect with this chat'}
                  data-testid={`pulse-link-${related.id}`}
                >
                  <LinkIcon />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
