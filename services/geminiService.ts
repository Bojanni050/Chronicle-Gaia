
import { Settings, AIProvider } from "../types";

export interface ChatMetadata {
  summary: string;
  tags: string[];
  suggestedTitle: string;
}

/**
 * The Gemini API key stays in the Electron main process. These calls go over
 * IPC (window.electronAPI) so the key is never referenced here and can never be
 * baked into the client bundle. In a plain browser (no Electron bridge) there
 * is no key, so the calls report failure honestly instead of pretending.
 */

const hasBridge = () => typeof window !== 'undefined' && !!(window as any).electronAPI?.analyzeContent;

/**
 * Fetches available models from the configured provider.
 */
export const fetchAvailableModels = async (settings: Settings): Promise<string[]> => {
  const { aiProvider, customEndpoint } = settings;

  if (aiProvider === AIProvider.GEMINI) {
    if (!hasBridge()) return ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"];
    const result = await (window as any).electronAPI.fetchModels();
    if (!result.ok) throw new Error(result.error || 'failed to fetch models');
    return result.models;
  }

  if (aiProvider === AIProvider.OPENAI || aiProvider === AIProvider.MISTRAL || aiProvider === AIProvider.LMSTUDIO) {
    let url = "";
    const headers: HeadersInit = {};

    if (aiProvider === AIProvider.OPENAI) {
      url = "https://api.openai.com/v1/models";
    } else if (aiProvider === AIProvider.MISTRAL) {
      url = "https://api.mistral.ai/v1/models";
    } else if (aiProvider === AIProvider.LMSTUDIO) {
      let base = customEndpoint.trim().replace(/\/+$/, "");
      base = base.replace(/\/chat\/completions$/, "").replace(/\/completions$/, "").replace(/\/models$/, "");
      url = base.includes('/v1/') ? `${base}/models` : `${base}/v1/models`;
    }

    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`${aiProvider} returned status ${response.status}. Ensure the server is running and CORS is enabled.`);
    }
    const data = await response.json();
    if (data.data && Array.isArray(data.data)) return data.data.map((m: any) => m.id);
    return [];
  }

  if (aiProvider === AIProvider.ANTHROPIC) {
    return [
      "claude-3-5-sonnet-20240620",
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307"
    ];
  }
  return [];
};

/**
 * Generates a vector embedding for the provided text (via the main process).
 */
export const generateEmbedding = async (text: string, settings: Settings): Promise<number[] | undefined> => {
  if (settings.aiProvider !== AIProvider.GEMINI) return undefined;
  if (!hasBridge()) return undefined;
  const result = await (window as any).electronAPI.generateEmbedding({ text });
  return result.ok ? result.embedding : undefined;
};

/**
 * Analyzes content (text or image) and generates metadata (via the main process).
 */
export const analyzeContent = async (
  content: string,
  settings: Settings,
  imageMimeType?: string
): Promise<ChatMetadata> => {
  if (!hasBridge()) {
    throw new Error('Gemini enrichment requires the desktop app (no API bridge available)');
  }
  const result = await (window as any).electronAPI.analyzeContent({
    content,
    imageMimeType,
    preferredModel: settings.preferredModel,
  });
  if (!result.ok) throw new Error(result.error || 'content analysis failed');
  return result.metadata;
};

// Maintain compatibility for older call sites
export const analyzeChatContent = (content: string, settings: Settings) => analyzeContent(content, settings);
