
import React, { useEffect, useRef, useState } from 'react';
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
  [SourceType.QWEN]: '#6366f1',   // indigo-500 (Distinct color for Qwen)
  [SourceType.LOCAL]: '#a855f7', // purple-500
  [SourceType.OTHER]: '#94a3b8', // slate-400
  'Default': '#64748b'
};

export const MindMap: React.FC<MindMapProps> = ({ chats, onClose, onSelectChat }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 0.5 }); 
  const [hoveredNode, setHoveredNode] = useState<Node | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const hasCentered = useRef(false);
  
  // Track mouse down position to distinguish clicks from drags
  const dragStartPos = useRef({ x: 0, y: 0 });

  const simulationRef = useRef<{
    nodes: Node[];
    links: Link[];
    running: boolean;
    dragNode: Node | null;
  }>({ nodes: [], links: [], running: false, dragNode: null });

  // Initialize Simulation Data
  useEffect(() => {
    // Spread nodes out in a phyllotaxis spiral to ensure good initial distribution
    const nodes: Node[] = chats.map((chat, i) => {
      const angle = i * 0.5; // Spiral angle
      const radius = 10 + 15 * i; // Increasing radius
      return {
        id: chat.id,
        x: Math.cos(angle) * radius, 
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        radius: 12 + Math.min(chat.tags.length, 5) * 2,
        color: SOURCE_COLORS[chat.source] || SOURCE_COLORS['Default'],
        chat
      };
    });

    const links: Link[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const source = nodes[i];
        const target = nodes[j];
        const sourceTags = new Set(source.chat.tags.map(t => t.toLowerCase()));
        const sharedTags = target.chat.tags.filter(t => sourceTags.has(t.toLowerCase()));
        
        if (sharedTags.length > 0) {
          links.push({
            source,
            target,
            strength: Math.min(sharedTags.length * 0.1, 1) 
          });
        }
      }
    }

    simulationRef.current = { nodes, links, running: true, dragNode: null };
    // Reset centered flag when data changes to re-calc optimal fit if needed, 
    // though usually we only center on mount. 
    // Let's keep existing center if data updates to avoid jumping.
  }, [chats]);

  // Handle Resize correctly
  useEffect(() => {
    if (!containerRef.current) return;

    const updateSize = () => {
      if (containerRef.current && canvasRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        canvasRef.current.width = clientWidth;
        canvasRef.current.height = clientHeight;
        
        // Center the view if this is the first sizing
        if (!hasCentered.current && clientWidth > 0 && clientHeight > 0) {
            // Dynamic Zoom Calculation
            const maxRadius = 20 + 15 * chats.length; // Approximate bounds radius
            const minDim = Math.min(clientWidth, clientHeight);
            const fitScale = (minDim / 2) / (maxRadius * 1.1); // 10% margin
            
            // Clamp scale: min 0.2 (don't get too small), max 0.8 (don't get too huge for few nodes)
            const initialK = Math.min(Math.max(fitScale, 0.2), 0.8);

            setTransform({ x: clientWidth / 2, y: clientHeight / 2, k: initialK });
            hasCentered.current = true;
        }

        simulationRef.current.running = true;
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [chats.length]);

  // Simulation Loop
  useEffect(() => {
    let animationFrameId: number;

    const tick = () => {
      const { nodes, links, dragNode } = simulationRef.current;
      
      if (simulationRef.current.running) {
        // TUNED PHYSICS PARAMETERS
        const repulsion = 2500; // Strong enough to separate, not explode
        const springLength = 200; // Comfortable distance for links
        const damping = 0.9; // Stable damping
        const centerGravity = 0.0002; // Very weak pull to center
        const maxVelocity = 12; // Cap speed to prevent explosion

        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let distSq = dx * dx + dy * dy;
                
                // Prevent zero division / exact overlap
                if (distSq < 0.1) { 
                    dx = (Math.random() - 0.5); 
                    dy = (Math.random() - 0.5);
                    distSq = dx*dx + dy*dy + 0.1;
                }
                
                const dist = Math.sqrt(distSq);
                
                // Repel
                const force = repulsion / (distSq + 500); // Add constant to soften close-range forces
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                
                if (a !== dragNode) { a.vx += fx; a.vy += fy; }
                if (b !== dragNode) { b.vx -= fx; b.vy -= fy; }
            }
        }

        // Attraction (Links)
        for (const link of links) {
            const { source, target, strength } = link;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist === 0) continue;

            const displacement = dist - springLength;
            const force = displacement * strength * 0.02; // Spring constant
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            
            if (source !== dragNode) { source.vx += fx; source.vy += fy; }
            if (target !== dragNode) { target.vx -= fx; target.vy -= fy; }
        }

        // Apply Forces, Damping & Constraints
        for (const node of nodes) {
            if (node === dragNode) continue;
            
            // Central Gravity
            node.vx -= node.x * centerGravity;
            node.vy -= node.y * centerGravity;

            // Damping
            node.vx *= damping;
            node.vy *= damping;
            
            // Velocity Clamping (Stability Check)
            const vSq = node.vx * node.vx + node.vy * node.vy;
            if (vSq > maxVelocity * maxVelocity) {
                const v = Math.sqrt(vSq);
                node.vx = (node.vx / v) * maxVelocity;
                node.vy = (node.vy / v) * maxVelocity;
            }

            // Move
            node.x += node.vx;
            node.y += node.vy;

            // NaN Safety Reset
            if (isNaN(node.x) || isNaN(node.y)) {
                node.x = (Math.random() - 0.5) * 100;
                node.y = (Math.random() - 0.5) * 100;
                node.vx = 0;
                node.vy = 0;
            }
        }
      }

      draw();
      animationFrameId = requestAnimationFrame(tick);
    };

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { width, height } = canvas;
      const { x: tx, y: ty, k } = transform;
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

      // Safe clear
      ctx.clearRect(0, 0, width, height);
      
      ctx.save();
      ctx.translate(tx, ty); 
      ctx.scale(k, k);

      const { nodes, links } = simulationRef.current;

      // Draw Links
      ctx.beginPath();
      ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 2 / k; 
      for (const link of links) {
        ctx.moveTo(link.source.x, link.source.y);
        ctx.lineTo(link.target.x, link.target.y);
      }
      ctx.stroke();

      // Draw Nodes
      for (const node of nodes) {
        const isSelected = selectedNode && node.id === selectedNode.id;
        const isHovered = hoveredNode && node.id === hoveredNode.id;
        
        const baseRadius = node.radius;
        const drawRadius = isSelected ? baseRadius * 1.3 : (isHovered ? baseRadius * 1.15 : baseRadius);
        
        // Shadow/Glow
        if (isSelected || isHovered) {
            ctx.shadowColor = node.color;
            ctx.shadowBlur = 20;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.2)';
            ctx.shadowBlur = 5;
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, drawRadius, 0, Math.PI * 2);
        ctx.fillStyle = node.color;
        ctx.fill();
        
        // Inner highlight for 3D effect
        const gradient = ctx.createRadialGradient(
            node.x - drawRadius * 0.3, 
            node.y - drawRadius * 0.3, 
            drawRadius * 0.1, 
            node.x, 
            node.y, 
            drawRadius
        );
        gradient.addColorStop(0, 'rgba(255,255,255,0.4)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.shadowBlur = 0; // Reset shadow for stroke/text

        // Border
        ctx.lineWidth = (isSelected ? 3 : 1.5) / k;
        ctx.strokeStyle = isDark ? '#fff' : '#fff';
        ctx.stroke();

        // Label (Only show if hovered, selected, or zoomed in)
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

            // Label Background
            ctx.fillStyle = isDark ? 'rgba(15, 23, 42, 0.85)' : 'rgba(255, 255, 255, 0.85)';
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(boxX, boxY, boxW, boxH, 6 / k);
            } else {
              ctx.rect(boxX, boxY, boxW, boxH);
            }
            ctx.fill();
            
            // Label Border
            ctx.lineWidth = 1 / k;
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
            ctx.stroke();

            // Text
            ctx.fillStyle = isDark ? '#fff' : '#1e293b';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(labelText, node.x, boxY + boxH / 2);
        }
      }

      ctx.restore();
    };

    animationFrameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [transform, hoveredNode, selectedNode, chats, isDragging]);

  // Interaction Logic
  const getMousePos = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - transform.x) / transform.k;
    const y = (e.clientY - rect.top - transform.y) / transform.k;
    return { x, y };
  };

  const findNodeAt = (x: number, y: number): Node | undefined => {
    // Search in reverse to click top nodes first
    for (let i = simulationRef.current.nodes.length - 1; i >= 0; i--) {
        const n = simulationRef.current.nodes[i];
        const dist = Math.sqrt((n.x - x) ** 2 + (n.y - y) ** 2);
        if (dist <= n.radius + (5 / transform.k)) return n;
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
      simulationRef.current.running = true;
    } else {
      setIsDragging(true); // Panning
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getMousePos(e);

    if (isDragging) {
      if (simulationRef.current.dragNode) {
        simulationRef.current.dragNode.x = x;
        simulationRef.current.dragNode.y = y;
        simulationRef.current.dragNode.vx = 0;
        simulationRef.current.dragNode.vy = 0;
        simulationRef.current.running = true;
      } else {
        setTransform(prev => ({
          ...prev,
          x: prev.x + e.movementX,
          y: prev.y + e.movementY
        }));
      }
    } else {
        const node = findNodeAt(x, y);
        setHoveredNode(node || null);
        if (canvasRef.current) {
            canvasRef.current.style.cursor = node ? 'pointer' : 'grab';
        }
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    simulationRef.current.dragNode = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
  };

  const handleClick = (e: React.MouseEvent) => {
    const dist = Math.hypot(e.clientX - dragStartPos.current.x, e.clientY - dragStartPos.current.y);
    if (dist > 5) return; // Dragged, not clicked

    const { x, y } = getMousePos(e);
    const node = findNodeAt(x, y);
    if (!node) {
        setSelectedNode(null);
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    const zoomIntensity = 0.001 * e.deltaY;
    const newK = Math.min(Math.max(0.1, transform.k - zoomIntensity), 5);
    setTransform(prev => ({ ...prev, k: newK }));
  };

  // Helper to re-center explicitly
  const handleRecenter = () => {
     if(containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        // Re-calculate optimal zoom
        const maxRadius = 20 + 15 * chats.length;
        const minDim = Math.min(clientWidth, clientHeight);
        const fitScale = (minDim / 2) / (maxRadius * 1.1); 
        const initialK = Math.min(Math.max(fitScale, 0.2), 0.8);
        setTransform({x: clientWidth/2, y: clientHeight/2, k: initialK});
     }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-slate-50 dark:bg-slate-950 flex flex-col animate-in fade-in zoom-in duration-200">
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
            <button onClick={() => setTransform(p => ({...p, k: Math.min(p.k * 1.2, 5)}))} className="bg-white dark:bg-slate-800 p-3 rounded-full shadow-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomInIcon />
            </button>
            <button onClick={() => setTransform(p => ({...p, k: Math.max(p.k * 0.8, 0.1)}))} className="bg-white dark:bg-slate-800 p-3 rounded-full shadow-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <ZoomOutIcon />
            </button>
            <button onClick={handleRecenter} className="bg-white dark:bg-slate-800 p-3 rounded-full shadow-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-blue-500 transition-all">
                <RefreshIcon />
            </button>
        </div>

        {selectedNode && (
            <div 
                className="absolute z-20 w-80 bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 animate-in fade-in zoom-in-95 duration-200"
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
                            className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold py-2 rounded-lg shadow-md transition-all"
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
