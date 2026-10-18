
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChatEntry, SourceType } from '../types';
import { ZoomInIcon, ZoomOutIcon, RefreshIcon, NetworkIcon, ArrowLeftIcon } from './Icons';

interface MindMapProps {
  chats: ChatEntry[];
  onClose: () => void;
  onSelectChat: (chat: ChatEntry) => void;
}

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  chat: ChatEntry;
}

interface Link {
  source: Node;
  target: Node;
  strength: number;
}

const SOURCE_COLORS: Record<string, string> = {
  [SourceType.CHATGPT]: '#22c55e', // green-500
  [SourceType.CLAUDE]: '#f97316', // orange-500
  [SourceType.GEMINI]: '#3b82f6', // blue-500
  [SourceType.MISTRAL]: '#f59e0b', // amber-500
  [SourceType.QWEN]: '#6366f1',   // indigo-500 (Distinct color for Qwen)
  [SourceType.LOCAL]: '#a855f7', // purple-500
  [SourceType.OTHER]: '#a8a29e', // stone-400
  'Default': '#78716c'
};

// Tuning. Links are built from an inverted tag index and tags that (almost) every
// chat carries (e.g. "imported") are skipped: they link everything to everything,
// cost O(n²) links and say nothing about how chats relate.
const MAX_TAG_FREQUENCY = 0.15;
const MAX_LINKS_PER_NODE = 6;
const REPULSION = 2500;
const REPULSION_CUTOFF = 300; // beyond this the force is negligible; also the grid cell size
const SPRING_LENGTH = 200;
const DAMPING = 0.9;
const CENTER_GRAVITY = 0.0002;
const MAX_VELOCITY = 12;
const SLEEP_ENERGY = 0.02; // average speed² below which the simulation stops

const buildLinks = (nodes: Node[]): Link[] => {
  const limit = Math.max(10, Math.floor(nodes.length * MAX_TAG_FREQUENCY));
  const byTag = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    for (const t of new Set(n.chat.tags.map(t => t.toLowerCase()))) {
      const list = byTag.get(t);
      if (list) list.push(i); else byTag.set(t, [i]);
    }
  });

  const shared = new Map<number, number>(); // pair key -> shared tag count
  const stride = nodes.length;
  for (const members of byTag.values()) {
    if (members.length < 2 || members.length > limit) continue;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const key = members[a] * stride + members[b];
        shared.set(key, (shared.get(key) || 0) + 1);
      }
    }
  }

  // Keep each node's strongest connections only.
  const perNode: { key: number; count: number }[][] = nodes.map(() => []);
  for (const [key, count] of shared) {
    perNode[Math.floor(key / stride)].push({ key, count });
    perNode[key % stride].push({ key, count });
  }
  const keep = new Set<number>();
  for (const list of perNode) {
    list.sort((a, b) => b.count - a.count);
    for (const e of list.slice(0, MAX_LINKS_PER_NODE)) keep.add(e.key);
  }

  const links: Link[] = [];
  for (const key of keep) {
    links.push({
      source: nodes[Math.floor(key / stride)],
      target: nodes[key % stride],
      strength: Math.min((shared.get(key) || 1) * 0.1, 1),
    });
  }
  return links;
};

const fitScaleFor = (count: number, width: number, height: number) => {
  const maxRadius = 30 * Math.sqrt(count) + 40; // matches the initial spiral
  const fit = (Math.min(width, height) / 2) / (maxRadius * 1.1);
  return Math.min(Math.max(fit, 0.2), 0.8);
};

export const MindMap: React.FC<MindMapProps> = ({ chats, onClose, onSelectChat }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 0.5 });
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const hasCentered = useRef(false);

  // Track mouse down position to distinguish clicks from drags
  const dragStartPos = useRef({ x: 0, y: 0 });

  const simulationRef = useRef<{
    nodes: Node[];
    links: Link[];
    running: boolean;
    dragNode: Node | null;
  }>({ nodes: [], links: [], running: false, dragNode: null });

  // The render loop reads view state from refs so it never has to restart on
  // hover/zoom/pan; it only runs while the simulation moves or a redraw is pending.
  const viewRef = useRef({ transform, hoveredNode, selectedNode });
  viewRef.current = { transform, hoveredNode, selectedNode };
  const frameRef = useRef<number | null>(null);
  const tickRef = useRef<() => void>(() => {});

  const requestFrame = useCallback(() => {
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => tickRef.current());
  }, []);

  // Initialize simulation data
  useEffect(() => {
    // Build after the first paint so the page (with its loading indicator) shows
    // immediately instead of the UI freezing while the graph is prepared.
    setReady(false);
    const timer = setTimeout(() => {
    // sqrt spiral: even density, and a start radius that scales with sqrt(n), not n
    const nodes: Node[] = chats.map((chat, i) => {
      const angle = i * 2.399963; // golden angle
      const radius = 30 * Math.sqrt(i + 1);
      return {
        id: chat.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        radius: 12 + Math.min(chat.tags.length, 5) * 2,
        color: SOURCE_COLORS[chat.source] || SOURCE_COLORS['Default'],
        chat,
      };
    });
    simulationRef.current = { nodes, links: buildLinks(nodes), running: true, dragNode: null };
    setReady(true);
    requestFrame();
    }, 30);
    return () => clearTimeout(timer);
  }, [chats, requestFrame]);

  // Handle resize
  useEffect(() => {
    if (!containerRef.current) return;

    const updateSize = () => {
      if (containerRef.current && canvasRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        canvasRef.current.width = clientWidth;
        canvasRef.current.height = clientHeight;

        if (!hasCentered.current && clientWidth > 0 && clientHeight > 0) {
          setTransform({ x: clientWidth / 2, y: clientHeight / 2, k: fitScaleFor(chats.length, clientWidth, clientHeight) });
          hasCentered.current = true;
        }
        requestFrame();
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [chats.length, requestFrame]);

  const step = () => {
    const sim = simulationRef.current;
    const { nodes, links, dragNode } = sim;

    // Repulsion via a uniform grid: only neighbouring cells are compared (~O(n))
    // instead of every pair (O(n²)). Cells are keyed by a string-free integer pair.
    const grid = new Map<string, Node[]>();
    const cellKey = (cx: number, cy: number) => cx + ',' + cy;
    const cellOf = (n: Node) => [Math.floor(n.x / REPULSION_CUTOFF), Math.floor(n.y / REPULSION_CUTOFF)];
    for (const n of nodes) {
      const [cx, cy] = cellOf(n);
      const key = cellKey(cx, cy);
      const cell = grid.get(key);
      if (cell) cell.push(n); else grid.set(key, [n]);
    }
    const cutoffSq = REPULSION_CUTOFF * REPULSION_CUTOFF;
    const repel = (a: Node, b: Node) => {
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq >= cutoffSq) return;
      if (distSq < 0.1) {
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        distSq = dx * dx + dy * dy + 0.1;
      }
      const dist = Math.sqrt(distSq);
      const force = REPULSION / (distSq + 500);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (a !== dragNode) { a.vx += fx; a.vy += fy; }
      if (b !== dragNode) { b.vx -= fx; b.vy -= fy; }
    };
    // Each pair is visited once: inside a cell (i<j) plus 4 "forward" neighbour cells.
    const forward = [[1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [key, own] of grid) {
      const [cx, cy] = key.split(',').map(Number);
      for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) repel(own[i], own[j]);
      for (const [ox, oy] of forward) {
        const other = grid.get(cellKey(cx + ox, cy + oy));
        if (other) for (const a of own) for (const b of other) repel(a, b);
      }
    }

    // Attraction (links)
    for (const { source, target, strength } of links) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) continue;
      const force = (dist - SPRING_LENGTH) * strength * 0.02;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (source !== dragNode) { source.vx += fx; source.vy += fy; }
      if (target !== dragNode) { target.vx -= fx; target.vy -= fy; }
    }

    // Integrate
    let energy = 0;
    for (const node of nodes) {
      if (node === dragNode) continue;
      node.vx -= node.x * CENTER_GRAVITY;
      node.vy -= node.y * CENTER_GRAVITY;
      node.vx *= DAMPING;
      node.vy *= DAMPING;

      const vSq = node.vx * node.vx + node.vy * node.vy;
      if (vSq > MAX_VELOCITY * MAX_VELOCITY) {
        const v = Math.sqrt(vSq);
        node.vx = (node.vx / v) * MAX_VELOCITY;
        node.vy = (node.vy / v) * MAX_VELOCITY;
      }
      node.x += node.vx;
      node.y += node.vy;

      if (isNaN(node.x) || isNaN(node.y)) {
        node.x = (Math.random() - 0.5) * 100;
        node.y = (Math.random() - 0.5) * 100;
        node.vx = 0;
        node.vy = 0;
      }
      energy += node.vx * node.vx + node.vy * node.vy;
    }

    // Settled: stop simulating (and therefore stop redrawing) until something wakes it.
    if (!dragNode && nodes.length > 0 && energy / nodes.length < SLEEP_ENERGY) sim.running = false;
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const { width, height } = canvas;
    const { transform: { x: tx, y: ty, k }, hoveredNode, selectedNode } = viewRef.current;
    const isDark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(k, k);

    const { nodes, links } = simulationRef.current;

    // Visible world rectangle, for culling
    const margin = 60;
    const minX = -tx / k - margin, maxX = (width - tx) / k + margin;
    const minY = -ty / k - margin, maxY = (height - ty) / k + margin;

    ctx.beginPath();
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 2 / k;
    for (const { source, target } of links) {
      if ((source.x < minX && target.x < minX) || (source.x > maxX && target.x > maxX) ||
          (source.y < minY && target.y < minY) || (source.y > maxY && target.y > maxY)) continue;
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
    }
    ctx.stroke();

    // Plain nodes: batched per colour, no shadows or gradients (those dominated frame time).
    const byColor = new Map<string, Node[]>();
    const special: Node[] = [];
    for (const node of nodes) {
      if (node.x < minX || node.x > maxX || node.y < minY || node.y > maxY) continue;
      if ((selectedNode && node.id === selectedNode.id) || (hoveredNode && node.id === hoveredNode.id) || k > 1.0) {
        special.push(node);
        continue;
      }
      const list = byColor.get(node.color);
      if (list) list.push(node); else byColor.set(node.color, [node]);
    }
    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = '#fff';
    for (const [color, list] of byColor) {
      ctx.beginPath();
      for (const n of list) {
        ctx.moveTo(n.x + n.radius, n.y);
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      }
      ctx.fillStyle = color;
      ctx.fill();
      ctx.stroke();
    }

    // Detailed nodes: selected, hovered, or everything visible when zoomed in
    for (const node of special) {
      const isSelected = !!selectedNode && node.id === selectedNode.id;
      const isHovered = !!hoveredNode && node.id === hoveredNode.id;
      const drawRadius = isSelected ? node.radius * 1.3 : (isHovered ? node.radius * 1.15 : node.radius);

      ctx.shadowColor = isSelected || isHovered ? node.color : 'rgba(0,0,0,0.2)';
      ctx.shadowBlur = isSelected || isHovered ? 20 : 5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, drawRadius, 0, Math.PI * 2);
      ctx.fillStyle = node.color;
      ctx.fill();

      const gradient = ctx.createRadialGradient(node.x - drawRadius * 0.3, node.y - drawRadius * 0.3, drawRadius * 0.1, node.x, node.y, drawRadius);
      gradient.addColorStop(0, 'rgba(255,255,255,0.4)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = (isSelected ? 3 : 1.5) / k;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      if (isSelected || isHovered || k > 1.0) {
        const fontSize = isSelected ? 14 / k : 12 / k;
        ctx.font = `bold ${fontSize}px "Merriweather Sans", sans-serif`;
        const labelText = node.chat.title.length > 25 ? node.chat.title.substring(0, 24) + '…' : node.chat.title;
        const metrics = ctx.measureText(labelText);
        const paddingX = 8 / k;
        const paddingY = 4 / k;
        const boxW = metrics.width + paddingX * 2;
        const boxH = fontSize + paddingY * 2;
        const boxX = node.x - boxW / 2;
        const boxY = node.y + drawRadius + (10 / k);

        ctx.fillStyle = isDark ? 'rgba(28, 25, 23, 0.85)' : 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 6 / k); else ctx.rect(boxX, boxY, boxW, boxH);
        ctx.fill();

        ctx.lineWidth = 1 / k;
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
        ctx.stroke();

        ctx.fillStyle = isDark ? '#fff' : '#292524';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(labelText, node.x, boxY + boxH / 2);
      }
    }

    ctx.restore();
  };

  // One frame: step the physics while awake, always draw, and schedule the next
  // frame only while the simulation is still moving.
  tickRef.current = () => {
    frameRef.current = null;
    if (simulationRef.current.running) step();
    draw();
    if (simulationRef.current.running) requestFrame();
  };

  // Redraw when view state changes (zoom, pan, hover, selection)
  useEffect(() => { requestFrame(); }, [transform, hoveredNode, selectedNode, requestFrame]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const wake = () => { simulationRef.current.running = true; requestFrame(); };

  // Interaction logic
  const getMousePos = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - rect.left - transform.x) / transform.k, y: (e.clientY - rect.top - transform.y) / transform.k };
  };

  const findNodeAt = (x: number, y: number): Node | undefined => {
    const { nodes } = simulationRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = n.radius + (5 / transform.k);
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return undefined;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    const { x, y } = getMousePos(e);
    const node = findNodeAt(x, y);

    if (node) {
      simulationRef.current.dragNode = node;
      setIsDragging(true);
      setSelectedNode(node);
      wake();
    } else {
      setIsDragging(true); // panning
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getMousePos(e);

    if (isDragging) {
      const dragNode = simulationRef.current.dragNode;
      if (dragNode) {
        dragNode.x = x;
        dragNode.y = y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        wake();
      } else {
        setTransform(prev => ({ ...prev, x: prev.x + e.movementX, y: prev.y + e.movementY }));
      }
    } else {
      const node = findNodeAt(x, y) || null;
      // Only touch state when the hovered node actually changes (avoids a re-render per mouse move)
      setHoveredNode(prev => (prev === node ? prev : node));
      if (canvasRef.current) canvasRef.current.style.cursor = node ? 'pointer' : 'grab';
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    simulationRef.current.dragNode = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    wake(); // let the graph settle after a drag
  };

  const handleClick = (e: React.MouseEvent) => {
    const dist = Math.hypot(e.clientX - dragStartPos.current.x, e.clientY - dragStartPos.current.y);
    if (dist > 5) return; // dragged, not clicked
    const { x, y } = getMousePos(e);
    if (!findNodeAt(x, y)) setSelectedNode(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    const zoomIntensity = 0.001 * e.deltaY;
    setTransform(prev => ({ ...prev, k: Math.min(Math.max(0.1, prev.k - zoomIntensity), 5) }));
  };

  const handleRecenter = () => {
    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      setTransform({ x: clientWidth / 2, y: clientHeight / 2, k: fitScaleFor(chats.length, clientWidth, clientHeight) });
    }
  };

  return (
    <div className="absolute inset-0 z-20 bg-slate-50 dark:bg-slate-950 flex flex-col animate-in fade-in zoom-in duration-200">
      <header className="relative bg-slate-900 border-b border-slate-700 p-4 flex items-center justify-between shadow-md z-20">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg shadow-lg shadow-blue-500/50 text-white">
            <NetworkIcon />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white font-sans">Concept Neural Map</h1>
            <p className="text-[10px] text-slate-400 font-mono">Interactive Force Graph</p>
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

      <div
        ref={containerRef}
        className="flex-1 w-full relative cursor-grab active:cursor-grabbing bg-slate-100 dark:bg-[#0b1120] overflow-hidden"
        style={{ backgroundImage: 'radial-gradient(circle at center, rgba(51, 65, 85, 0.1) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onWheel={handleWheel}
          className="block w-full h-full"
        />

        <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10">
            <button onClick={() => setTransform(p => ({...p, k: Math.min(p.k * 1.2, 5)}))} className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomInIcon />
            </button>
            <button onClick={() => setTransform(p => ({...p, k: Math.max(p.k * 0.8, 0.1)}))} className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomOutIcon />
            </button>
            <button onClick={handleRecenter} className="bg-white dark:bg-slate-800 p-2 rounded-full shadow-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <RefreshIcon />
            </button>
        </div>

        {!ready && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-slate-100/80 dark:bg-slate-950/80 backdrop-blur-sm">
                <div className="w-8 h-8 rounded-full border-2 border-sage-green/30 border-t-sage-green animate-spin" />
                <p className="text-sm font-semibold text-moss-brown dark:text-stone-300">Neural map opbouwen…</p>
                <p className="text-xs text-moss-brown/70 dark:text-stone-500">{chats.length} chats</p>
            </div>
        )}

        {selectedNode && (
            <div
                className="absolute z-20 w-80 bg-white dark:bg-slate-900 rounded-xl shadow-md border border-slate-200 dark:border-slate-700 animate-in fade-in zoom-in-95 duration-200"
                style={{
                    left: selectedNode.x * transform.k + transform.x,
                    top: selectedNode.y * transform.k + transform.y + selectedNode.radius * transform.k + 20,
                    transform: 'translate(-50%, 0)'
                }}
            >
                <div className="h-1.5 w-full rounded-t-xl" style={{ backgroundColor: selectedNode.color }}></div>
                <div className="p-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1 block font-sans">{selectedNode.chat.source}</span>
                    <h3 className="font-bold text-slate-900 dark:text-white mb-2 leading-tight font-sans">{selectedNode.chat.title}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-4">"{selectedNode.chat.summary}"</p>
                    <div className="flex gap-2">
                         <button
                            onClick={() => onSelectChat(selectedNode.chat)}
                            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 rounded-lg shadow-sm transition-all"
                        >
                            Open Chat
                        </button>
                        <button
                            onClick={() => setSelectedNode(null)}
                            className="px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-lg transition-all"
                        >
                            Close
                        </button>
                    </div>
                </div>
                <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white dark:bg-slate-900 border-t border-l border-slate-200 dark:border-slate-700 rotate-45 transform"></div>
            </div>
        )}
      </div>
    </div>
  );
};
