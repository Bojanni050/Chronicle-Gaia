
import React, { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { ChatEntry, SourceType } from '../types';
import { buildTagEdges } from '../utils/neuralGraph';
import { ZoomInIcon, ZoomOutIcon, RefreshIcon, NetworkIcon, ArrowLeftIcon } from './Icons';

interface MindMapProps {
  chats: ChatEntry[];
  onClose: () => void;
  onSelectChat: (chat: ChatEntry) => void;
}

const SOURCE_COLORS: Record<string, string> = {
  [SourceType.CHATGPT]: '#22c55e', // green-500
  [SourceType.CLAUDE]: '#f97316', // orange-500
  [SourceType.GEMINI]: '#3b82f6', // blue-500
  [SourceType.MISTRAL]: '#f59e0b', // amber-500
  [SourceType.QWEN]: '#6366f1',   // indigo-500
  [SourceType.LOCAL]: '#a855f7', // purple-500
  [SourceType.OTHER]: '#a8a29e', // stone-400
  'Default': '#78716c'
};

const isDarkMode = () =>
  document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;

// Time the force layout may run before it is stopped to free the CPU. Scales with the archive.
const layoutDuration = (nodeCount: number) => Math.min(20000, 4000 + nodeCount * 10);

export const MindMap: React.FC<MindMapProps> = ({ chats, onClose, onSelectChat }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [layouting, setLayouting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Imperative handles used by the toolbar buttons and the render reducers.
  const sigmaRef = useRef<Sigma | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const chatsById = useRef<Map<string, ChatEntry>>(new Map());

  selectedRef.current = selectedId;

  const startLayout = () => {
    const layout = layoutRef.current;
    const graph = sigmaRef.current?.getGraph();
    if (!layout || !graph) return;
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layout.start();
    setLayouting(true);
    layoutTimer.current = setTimeout(() => {
      layout.stop();
      setLayouting(false);
    }, layoutDuration(graph.order));
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setReady(false);
    setSelectedId(null);

    let sigma: Sigma | null = null;
    let layout: FA2Layout | null = null;
    let cancelled = false;

    // Build after the first paint so the page (with its loading indicator) shows
    // immediately instead of the UI freezing while the graph is prepared.
    const buildTimer = setTimeout(() => {
      if (cancelled) return;
      const dark = isDarkMode();
      const graph = new Graph({ type: 'undirected', multi: false });
      chatsById.current = new Map(chats.map(c => [c.id, c]));

      chats.forEach((chat, i) => {
        const angle = i * 2.399963; // golden angle spiral gives the layout an even start
        const radius = 10 * Math.sqrt(i + 1);
        graph.addNode(chat.id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          size: 3 + Math.min(chat.tags.length, 5) * 0.7,
          color: SOURCE_COLORS[chat.source] || SOURCE_COLORS['Default'],
          label: chat.title.length > 40 ? chat.title.slice(0, 39) + '…' : chat.title,
        });
      });
      for (const edge of buildTagEdges(chats)) {
        graph.addEdge(chats[edge.source].id, chats[edge.target].id, { weight: edge.weight, size: 0.6 });
      }

      const dimColor = dark ? 'rgba(120,113,108,0.35)' : 'rgba(168,162,158,0.45)';
      const edgeColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
      const edgeFocusColor = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';

      sigma = new Sigma(graph, container, {
        renderEdgeLabels: false,
        hideEdgesOnMove: graph.size > 3000,
        labelFont: '"Manrope", sans-serif',
        labelWeight: '600',
        labelSize: 12,
        labelColor: { color: dark ? '#e7e5e4' : '#292524' },
        labelRenderedSizeThreshold: 7, // labels appear as you zoom in, so thousands of nodes stay readable
        labelDensity: 0.6,
        defaultEdgeColor: edgeColor,
        minCameraRatio: 0.03,
        maxCameraRatio: 8,
        // The default hover draws a white label box that clashes with dark mode; the focus
        // highlight from the reducers below replaces it.
        defaultDrawNodeHover: () => {},
        nodeReducer: (node, data) => {
          const focus = hoveredRef.current ?? selectedRef.current;
          if (!focus) return data;
          if (node === focus) return { ...data, forceLabel: true, zIndex: 2, size: data.size * 1.4 };
          if (graph.hasEdge(node, focus)) return { ...data, forceLabel: true, zIndex: 1 };
          return { ...data, color: dimColor, label: null, zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          const focus = hoveredRef.current ?? selectedRef.current;
          if (!focus) return data;
          return graph.hasExtremity(edge, focus)
            ? { ...data, color: edgeFocusColor, size: 1.2, zIndex: 1 }
            : { ...data, hidden: true };
        },
        zIndex: true,
      });
      sigmaRef.current = sigma;

      sigma.on('enterNode', ({ node }) => {
        hoveredRef.current = node;
        container.style.cursor = 'pointer';
        sigma?.refresh({ skipIndexation: true });
      });
      sigma.on('leaveNode', () => {
        hoveredRef.current = null;
        container.style.cursor = '';
        sigma?.refresh({ skipIndexation: true });
      });
      sigma.on('clickNode', ({ node }) => {
        setSelectedId(node);
        selectedRef.current = node;
        sigma?.refresh({ skipIndexation: true });
      });
      sigma.on('clickStage', () => {
        setSelectedId(null);
        selectedRef.current = null;
        sigma?.refresh({ skipIndexation: true });
      });

      // Drag a node: pin it for the layout while held, move it with the mouse, and keep the camera still.
      let dragged: string | null = null;
      sigma.on('downNode', ({ node }) => {
        dragged = node;
        graph.setNodeAttribute(node, 'fixed', true);
        if (sigma && !sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      });
      sigma.getMouseCaptor().on('mousemovebody', (e) => {
        if (!dragged || !sigma) return;
        const pos = sigma.viewportToGraph(e);
        graph.setNodeAttribute(dragged, 'x', pos.x);
        graph.setNodeAttribute(dragged, 'y', pos.y);
        e.preventSigmaDefault();
        e.original.preventDefault();
        e.original.stopPropagation();
      });
      const release = () => {
        if (dragged) graph.removeNodeAttribute(dragged, 'fixed');
        dragged = null;
      };
      sigma.getMouseCaptor().on('mouseup', release);
      sigma.getMouseCaptor().on('mouseleave' as any, release);

      // Force layout runs in a Web Worker so the UI stays responsive.
      if (graph.order > 1) {
        const settings = forceAtlas2.inferSettings(graph);
        layout = new FA2Layout(graph, {
          settings: { ...settings, barnesHutOptimize: graph.order > 400, slowDown: 2 },
        });
        layoutRef.current = layout;
        startLayout();
      }
      setReady(true);
    }, 30);

    return () => {
      cancelled = true;
      clearTimeout(buildTimer);
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
      layout?.kill();
      sigma?.kill();
      layoutRef.current = null;
      sigmaRef.current = null;
      hoveredRef.current = null;
    };
  }, [chats]);

  // Keep the highlight in sync when the selection changes from the React side (popup Close).
  useEffect(() => { sigmaRef.current?.refresh({ skipIndexation: true }); }, [selectedId]);

  const selectedChat = selectedId ? chatsById.current.get(selectedId) ?? null : null;
  const camera = () => sigmaRef.current?.getCamera();

  return (
    <div className="absolute inset-0 z-20 bg-slate-50 dark:bg-slate-950 flex flex-col animate-in fade-in zoom-in duration-200">
      <header className="relative bg-slate-900 border-b border-slate-700 p-4 flex items-center justify-between shadow-md z-20">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg shadow-lg shadow-blue-500/50 text-white">
            <NetworkIcon />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white font-sans">Concept Neural Map</h1>
            <p className="text-[10px] text-slate-400 font-mono">{chats.length} chats · WebGL force graph</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
            <button
                onClick={onClose}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg transition-colors border border-slate-600 font-semibold text-sm shadow-sm"
            >
                <ArrowLeftIcon />
                Back
            </button>
        </div>
      </header>

      <div className="flex-1 w-full relative bg-slate-100 dark:bg-[#0b1120] overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" />

        {layouting && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 shadow-sm">
                <div className="w-3 h-3 rounded-full border-2 border-sage-green/30 border-t-sage-green animate-spin" />
                Indelen…
            </div>
        )}

        <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10">
            <button onClick={() => camera()?.animatedZoom({ duration: 200 })} title="Zoom in" className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomInIcon />
            </button>
            <button onClick={() => camera()?.animatedUnzoom({ duration: 200 })} title="Zoom out" className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomOutIcon />
            </button>
            <button onClick={() => camera()?.animatedReset({ duration: 300 })} title="Terug naar overzicht" className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <RefreshIcon />
            </button>
            <button onClick={startLayout} title="Opnieuw indelen" className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <NetworkIcon />
            </button>
        </div>

        {!ready && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-100/80 dark:bg-slate-950/80 backdrop-blur-sm">
                <div className="w-8 h-8 rounded-full border-2 border-sage-green/30 border-t-sage-green animate-spin" />
                <p className="text-sm font-semibold text-moss-brown dark:text-stone-300">Neural map opbouwen…</p>
                <p className="text-xs text-moss-brown/70 dark:text-stone-500">{chats.length} chats</p>
            </div>
        )}

        {selectedChat && (
            <div className="absolute z-20 bottom-6 left-6 w-80 bg-white dark:bg-slate-900 rounded-xl shadow-md border border-slate-200 dark:border-slate-700 animate-in fade-in zoom-in-95 duration-200">
                <div className="h-1.5 w-full rounded-t-xl" style={{ backgroundColor: SOURCE_COLORS[selectedChat.source] || SOURCE_COLORS['Default'] }}></div>
                <div className="p-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block font-sans">{selectedChat.source}</span>
                    <h3 className="font-bold text-slate-900 dark:text-white mb-2 leading-tight font-sans">{selectedChat.title}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-4">"{selectedChat.summary}"</p>
                    <div className="flex gap-2">
                         <button
                            onClick={() => onSelectChat(selectedChat)}
                            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 rounded-lg shadow-sm transition-all"
                        >
                            Open Chat
                        </button>
                        <button
                            onClick={() => setSelectedId(null)}
                            className="px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-lg transition-all"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
};
