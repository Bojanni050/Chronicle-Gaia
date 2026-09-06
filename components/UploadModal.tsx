
import React, { useState, useRef } from 'react';
import { SourceType, Settings, ItemType } from '../types';
import { XIcon, FileIcon, RefreshIcon, BoltIcon, PlusIcon } from './Icons';
import { analyzeContent, generateEmbedding } from '../services/geminiService';
import { convertJsonToTranscript } from '../utils/chatUtils';

interface UploadModalProps {
  onClose: () => void;
  onUpload: (content: string, source: string, title: string, summary: string, tags: string[], fileName: string, embedding?: number[], assets?: string[]) => void;
  settings: Settings;
}

interface ProcessResult {
  fileName: string;
  success: boolean;
  error?: string;
  isImage?: boolean;
  data?: {
    content: string;
    title: string;
    summary: string;
    tags: string[];
    embedding?: number[];
    assets?: string[];
  };
}

type ModalStep = 'upload' | 'review';

export const UploadModal: React.FC<UploadModalProps> = ({ onClose, onUpload, settings }) => {
  const [step, setStep] = useState<ModalStep>('upload');
  const [source, setSource] = useState<SourceType>(SourceType.CHATGPT);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<ProcessResult[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File): Promise<ProcessResult> => {
    const isImage = file.type.startsWith('image/');
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

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

        const metadata = await analyzeContent(base64, settings, file.type);
        const vector = await generateEmbedding(metadata.summary + " " + metadata.suggestedTitle, settings);

        return {
          fileName: file.name,
          success: true,
          isImage: true,
          data: {
            content: `[Visual Asset: ${file.name}]\n\n${metadata.summary}`,
            title: metadata.suggestedTitle,
            summary: metadata.summary,
            tags: [...metadata.tags, 'visual'],
            embedding: vector,
            assets: [`data:${file.type};base64,${base64}`]
          }
        };
      } else {
        const text = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.readAsText(file);
        });

        let finalContent = text;
        if (extension === '.json') {
          const transcript = convertJsonToTranscript(JSON.parse(text));
          if (!transcript) throw new Error("Invalid chat structure");
          finalContent = transcript;
        }

        const metadata = await analyzeContent(finalContent, settings);
        const vector = await generateEmbedding(finalContent + "\n" + metadata.summary, settings);

        return {
          fileName: file.name,
          success: true,
          data: {
            content: finalContent,
            title: metadata.suggestedTitle,
            summary: metadata.summary,
            tags: metadata.tags,
            embedding: vector
          }
        };
      }
    } catch (err: any) {
      return { fileName: file.name, success: false, error: err.message || "Processing failed" };
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
      processedResults.push(res);
    }

    setResults(processedResults);
    setIsProcessing(false);
    setStep('review');
  };

  const handleFinalize = () => {
    results.forEach(res => {
      if (res.success && res.data) {
        onUpload(
          res.data.content, 
          source, 
          res.data.title, 
          res.data.summary, 
          res.data.tags, 
          res.fileName, 
          res.data.embedding,
          res.data.assets
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
