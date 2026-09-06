
import { GoogleGenAI, Type } from "@google/genai";
import { Settings, AIProvider } from "../types";

export interface ChatMetadata {
  summary: string;
  tags: string[];
  suggestedTitle: string;
}

/**
 * Helper to clean and format local endpoints for different API paths.
 */
const getBaseUrl = (provider: AIProvider, endpoint: string): string => {
  if (provider !== AIProvider.LMSTUDIO) return "";
  
  // Remove trailing slashes and common subpaths to get the base
  let base = endpoint.trim().replace(/\/+$/, "");
  base = base.replace(/\/chat\/completions$/, "");
  base = base.replace(/\/completions$/, "");
  base = base.replace(/\/models$/, "");
  return base;
};

/**
 * Fetches available models from the configured provider.
 */
export const fetchAvailableModels = async (settings: Settings): Promise<string[]> => {
  const { aiProvider, customEndpoint } = settings;

  try {
    if (aiProvider === AIProvider.GEMINI) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.API_KEY}`);
      if (!response.ok) throw new Error(`Google API responded with status ${response.status}`);
      const data = await response.json();
      if (data.models) {
        return data.models
          .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => m.name.replace('models/', ''));
      }
      return ["gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash-lite-latest"];
    }

    if (aiProvider === AIProvider.OPENAI || aiProvider === AIProvider.MISTRAL || aiProvider === AIProvider.LMSTUDIO) {
      let url = "";
      const headers: HeadersInit = {};
      
      // Removed settings-based API key injection. 
      // This environment strictly uses pre-configured process.env.API_KEY where applicable.

      if (aiProvider === AIProvider.OPENAI) {
        url = "https://api.openai.com/v1/models";
      } else if (aiProvider === AIProvider.MISTRAL) {
        url = "https://api.mistral.ai/v1/models";
      } else if (aiProvider === AIProvider.LMSTUDIO) {
        const base = getBaseUrl(aiProvider, customEndpoint);
        url = `${base}/models`;
        if (!url.includes('/v1/')) {
           url = `${base}/v1/models`;
        }
      }

      const response = await fetch(url, {
        method: "GET",
        headers
      });
      
      if (!response.ok) {
        throw new Error(`${aiProvider} returned status ${response.status}. Ensure the server is running and CORS is enabled.`);
      }

      const data = await response.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m: any) => m.id);
      }
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
  } catch (error: any) {
    console.error(`Failed to fetch models for ${aiProvider}:`, error);
    throw error;
  }
  return [];
};

/**
 * Generates a vector embedding for the provided text.
 */
export const generateEmbedding = async (text: string, settings: Settings): Promise<number[] | undefined> => {
  if (settings.aiProvider === AIProvider.GEMINI) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const model = "text-embedding-004";
      const response = await ai.models.embedContent({
        model: model,
        content: { parts: [{ text: text.substring(0, 9000) }] }
      });
      return response.embedding?.values;
    } catch (error) {
      console.warn("Failed to generate embedding with Gemini:", error);
      return undefined;
    }
  }
  return undefined;
};

/**
 * Analyzes content (text or image) and generates metadata.
 */
export const analyzeContent = async (
  content: string, 
  settings: Settings,
  imageMimeType?: string
): Promise<ChatMetadata> => {
  const { preferredModel } = settings;
  const isImage = !!imageMimeType;
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = isImage 
    ? "Describe this image in detail for a searchable digital archive. Provide a suggested title, a summary, and relevant tags."
    : "Summarize this AI conversation, suggest a title and tags.";

  const contentPart = isImage 
    ? { inlineData: { data: content, mimeType: imageMimeType } }
    : { text: content.substring(0, 10000) };

  const systemInstruction = `You are a professional digital archivist. 
    Return a JSON object with:
    1. "summary": A clear, high-level, one-sentence summary.
    2. "tags": An array of 3-6 relevant, lowercase, single-word tags.
    3. "suggestedTitle": A short descriptive title.`;

  try {
    const response = await ai.models.generateContent({
      model: isImage ? 'gemini-3-flash-preview' : (preferredModel || "gemini-3-flash-preview"),
      contents: { parts: [contentPart, { text: prompt }] },
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedTitle: { type: Type.STRING }
          },
          required: ["summary", "tags", "suggestedTitle"],
        },
      },
    });
    return JSON.parse(response.text || "{}");
  } catch (error) {
    console.error("Content analysis failed:", error);
    throw error;
  }
};

// Maintain compatibility for older call sites
export const analyzeChatContent = (content: string, settings: Settings) => analyzeContent(content, settings);
