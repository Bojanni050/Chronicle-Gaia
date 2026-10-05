
import React, { useState, useRef } from 'react';
import { SourceType, Settings, ItemType, CaptureData, CaptureTurn } from '../types';
import { XIcon, FileIcon, RefreshIcon, BoltIcon, PlusIcon } from './Icons';
import { analyzeContent, generateEmbedding, ChatMetadata } from '../services/geminiService';
import { turnsFromTranscript, toSourceProvider } from '../utils/foundationCapture';
import { parseConversationJson, parseClaudeExport, ParsedConversation } from '../utils/sourceParsers';

interface UploadModalProps {
  onClose: () => void;
  onUpload: (content: string, source: string, title: string, summary: string, tags: string[], fileName: string, embedding?: number[], assets?: string[], capture?: CaptureData, sourceFile?: SourceFileRef) => void;
  settings: Settings;
}

/**
 * The original file this import came from, kept so the caller can mirror it and
 * send it to Foundation (the owner). `path` is the real filesystem path, only
 * obtainable in Electron via getPathForFile.
 */
export interface SourceFileRef {
  path: string;
  filename: string;
  mimeType: string;
}

interface ProcessResult {
  fileName: string;
  success: boolean;
  error?: string;
  isImage?: boolean;
  sourceFile?: SourceFileRef;
  data?: {
    content: string;
    title: string;
    summary: string;
    tags: string[];
    embedding?: number[];
    assets?: string[];
    turns?: CaptureTurn[];
    url?: string;
    occurredAt?: string;
    sourceProvider?: string;
  };
}

// Enrichment (AI summary/tags/embedding) is best-effort: it feeds the archive's
// derived layer, and a failing Gemini call must never block the archive write
// or the capture step that follows it. On failure we archive without it.
const fallbackMetadata = (content: string, fileName: string): ChatMetadata => ({
  summary: '',
  tags: [],
  suggestedTitle:
    fileName.replace(/\.[^.]+$/, '') ||
    content.split('\n').find((line) => line.trim())?.slice(0, 80) ||
    'Untitled',
});

const enrichContent = async (
  content: string,
  settings: Settings,
  fileName: string,
  imageMimeType?: string,
): Promise<ChatMetadata> => {
  try {
    return await analyzeContent(content, settings, imageMimeType);
  } catch (err) {
    console.warn('[Chronicle] Enrichment failed; archiving without AI metadata:', err);
    return fallbackMetadata(content, fileName);
  }
};

const safeEmbedding = async (text: string, settings: Settings): Promise<number[] | undefined> => {
  try {
    return await generateEmbedding(text, settings);
  } catch (err) {
    console.warn('[Chronicle] Embedding failed; continuing without it:', err);
    return undefined;
  }
};

type ModalStep = 'upload' | 'review';

export const UploadModal: React.FC<UploadModalProps> = ({ onClose, onUpload, settings }) => {
  const [step, setStep] = useState<ModalStep>('upload');
  const [source, setSource] = useState<SourceType>(SourceType.CHATGPT);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<ProcessResult[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Turns an already-parsed conversation (from an export shape) into a review
  // result. Enrichment is best-effort; the raw capture fields ride along.
  const resultFromConversation = async (
    fileName: string,
    conv: ParsedConversation,
    provider: string,
  ): Promise<ProcessResult> => {
    const metadata = await enrichContent(conv.content, settings, fileName);
    const vector = await safeEmbedding(conv.content + "\n" + metadata.summary, settings);
    return {
      fileName,
      success: true,
      data: {
        content: conv.content,
        title: conv.title || metadata.suggestedTitle,
        summary: metadata.summary,
        tags: metadata.tags,
        embedding: vector,
        turns: conv.turns,
        url: conv.url,
        occurredAt: conv.occurredAt ? new Date(conv.occurredAt).toISOString() : undefined,
        sourceProvider: conv.sourceProvider || provider,
      },
    };
  };

  // One file can hold one conversation or many (a Claude export holds all of
  // them). Each conversation becomes its own archive entry and capture.
  const processFile = async (file: File): Promise<ProcessResult[]> => {
    const isImage = file.type.startsWith('image/');
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

    // The real path of the file, so the original can be mirrored byte-for-byte
    // and sent to Foundation. Absent in a plain browser (no Electron bridge).
    const sourceFile: SourceFileRef | undefined = window.electronAPI?.getPathForFile
      ? (() => {
          try {
            const p = window.electronAPI.getPathForFile(file);
            return p ? { path: p, filename: file.name, mimeType: file.type || 'application/octet-stream' } : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    try {
      if (isImage) {
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const result = e.target?.result as string;
            resolve(result.split(',')[1]);
          };
          reader.readAsDataURL(file);
        });

        const metadata = await enrichContent(base64, settings, file.name, file.type);
        const vector = await safeEmbedding(metadata.summary + " " + metadata.suggestedTitle, settings);

        return [{
          fileName: file.name,
          success: true,
          isImage: true,
          sourceFile,
          data: {
            content: `[Visual Asset: ${file.name}]\n\n${metadata.summary}`,
            title: metadata.suggestedTitle,
            summary: metadata.summary,
            tags: [...metadata.tags, 'visual'],
            embedding: vector,
            assets: [`data:${file.type};base64,${base64}`]
          }
        }];
      }

      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsText(file);
      });

      // A JSON export: parse its real structure for turns/url/provider.
      if (extension === '.json') {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error('Invalid JSON');
        }
        const claude = parseClaudeExport(json);
        const parsed = claude.length > 0 ? claude.map((c) => [file.name, c] as const) : [[file.name, parseConversationJson(json)] as const];
        const results: ProcessResult[] = [];
        let index = 1;
        for (const [name, conv] of parsed) {
          if (!conv) continue;
          const label = parsed.length > 1 ? `${name} (${index})` : name;
          const r = await resultFromConversation(label, conv, toSourceProvider(source) || 'other');
          results.push({ ...r, sourceFile });
          index++;
        }
        if (results.length === 0) throw new Error('Invalid chat structure');
        return results;
      }

      // Plain text / markdown: split into turns from the transcript.
      const finalContent = text;
      const metadata = await enrichContent(finalContent, settings, file.name);
      const vector = await safeEmbedding(finalContent + "\n" + metadata.summary, settings);
      return [{
        fileName: file.name,
        success: true,
        sourceFile,
        data: {
          content: finalContent,
          title: metadata.suggestedTitle,
          summary: metadata.summary,
          tags: metadata.tags,
          embedding: vector,
          turns: turnsFromTranscript(finalContent)
        }
      }];
    } catch (err: any) {
      return [{ fileName: file.name, success: false, error: err.message || "Processing failed" }];
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: files.length });

    const fileArray = Array.from(files) as File[];
    const processedResults: ProcessResult[] = [];

    for (let i = 0; i < fileArray.length; i++) {
      setProcessingProgress({ current: i + 1, total: fileArray.length });
      const res = await processFile(fileArray[i]);
      processedResults.push(...res);
    }

    setResults(processedResults);
    setIsProcessing(false);
    setStep('review');
  };

  const handleFinalize = () => {
    results.forEach(res => {
      if (res.success && res.data) {
        // Only chats are captured to Foundation. An imported image is a visual
        // asset, not a chat; it stays in the archive.
        const capture: CaptureData | undefined = res.isImage
          ? undefined
          : {
              sourceProvider: res.data.sourceProvider || toSourceProvider(source),
              ...(res.data.url ? { url: res.data.url } : {}),
              ...(res.data.occurredAt ? { occurredAt: res.data.occurredAt } : {}),
              ...(res.data.turns && res.data.turns.length ? { turns: res.data.turns } : {}),
            };
        onUpload(
          res.data.content, 
          source, 
          res.data.title, 
          res.data.summary, 
          res.data.tags, 
          res.fileName, 
          res.data.embedding,
          res.data.assets,
          capture,
          res.sourceFile
        );
      }
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="bg-warm-beige dark:bg-slate-900 border border-sandstone dark:border-slate-700 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
        <div className="flex justify-between items-center p-6 border-b border-sandstone dark:border-slate-800">
          <div className="flex flex-col">
            <h2 className="text-xl font-black text-earth-dark dark:text-white uppercase tracking-tight">
              {step === 'upload' ? 'Intelligence Import' : 'Synthesis Summary'}
            </h2>
            <p className="text-[10px] text-moss-brown uppercase font-bold tracking-widest">Supports Logs & Visual Assets</p>
          </div>
          <button onClick={onClose} className="text-moss-brown hover:text-earth-dark transition-colors p-2">
            <XIcon />
          </button>
        </div>

        <div className="p-8 overflow-y-auto scrollbar-thin">
          {step === 'upload' && (
            <>
              <div className="mb-8">
                <label className="block text-[10px] font-black text-moss-brown uppercase tracking-widest mb-4">Memory Origin</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {Object.values(SourceType).map((src) => (
                    <button
                      key={src}
                      onClick={() => setSource(src)}
                      className={`px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider border transition-all ${
                        source === src ? 'bg-sage-green border-sage-green text-white shadow-lg' : 'bg-white dark:bg-slate-800 border-sandstone dark:border-slate-700 text-moss-brown'
                      }`}
                    >
                      {src}
                    </button>
                  ))}
                </div>
              </div>

              <div 
                onClick={() => !isProcessing && fileInputRef.current?.click()}
                className={`group border-2 border-dashed rounded-3xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 ${
                  isProcessing ? 'bg-sage-green/5 border-sage-green' : 'border-sandstone dark:border-slate-700 hover:border-sage-green hover:bg-sage-green/5'
                }`}
              >
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  onChange={handleFileChange} 
                  accept=".md,.markdown,.txt,.json,image/*" 
                  multiple 
                />
                
                {isProcessing ? (
                  <div className="text-center">
                    <RefreshIcon className="w-12 h-12 text-sage-green animate-spin mx-auto mb-6" />
                    <p className="text-earth-dark dark:text-white font-black text-lg uppercase tracking-tight">Decoding Inputs</p>
                    <p className="text-sage-green font-bold text-sm mt-2">{processingProgress.current} / {processingProgress.total}</p>
                  </div>
                ) : (
                  <>
                    <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-xl group-hover:scale-110 transition-transform mb-6 text-sage-green">
                      <FileIcon className="w-8 h-8" />
                    </div>
                    <p className="text-earth-dark dark:text-slate-300 font-black text-lg uppercase tracking-tight">Select Memories</p>
                    <p className="text-xs text-moss-brown mt-2 font-serif italic text-center max-w-xs">Drop chat logs or images. AI will summarize and tag them automatically.</p>
                  </>
                )}
              </div>
            </>
          )}

          {step === 'review' && (
            <div className="space-y-4">
              {results.map((res, i) => (
                <div key={i} className="flex items-center gap-4 p-4 bg-white/50 dark:bg-slate-800/50 rounded-2xl border border-sandstone/20">
                  {res.isImage && res.data?.assets?.[0] ? (
                    <img src={res.data.assets[0]} className="w-12 h-12 rounded-lg object-cover shadow-sm" alt="Thumbnail" />
                  ) : (
                    <div className={`p-3 rounded-lg ${res.success ? 'bg-sage-green/20 text-sage-green' : 'bg-red-500/20 text-red-500'}`}>
                      <BoltIcon className="w-5 h-5" />
                    </div>
                  )}
                  <div className="flex-1 truncate">
                    <p className="text-xs font-black text-earth-dark dark:text-slate-200 truncate">{res.fileName}</p>
                    <p className="text-[10px] text-moss-brown truncate">{res.success ? res.data?.title : res.error}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 bg-paper dark:bg-slate-900 border-t border-sandstone dark:border-slate-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-6 py-2.5 text-xs font-black text-moss-brown uppercase tracking-widest">Cancel</button>
          {step === 'review' && (
            <button 
              onClick={handleFinalize} 
              className="bg-sage-green text-white px-8 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest shadow-xl"
            >
              Commit to Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
