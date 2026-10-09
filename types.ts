
export enum SourceType {
  CHATGPT = 'ChatGPT',
  CLAUDE = 'Claude',
  GEMINI = 'Gemini',
  MISTRAL = 'Mistral',
  QWEN = 'Qwen',
  LOCAL = 'Local LLM',
  OTHER = 'Other',
  MANUAL = 'Manual'
}

export enum ItemType {
  CHAT = 'chat',
  NOTE = 'note'
}

export enum Theme {
  LIGHT = 'light',
  DARK = 'dark',
  SYSTEM = 'system'
}

export enum AIProvider {
  GEMINI = 'Gemini',
  OPENAI = 'OpenAI',
  ANTHROPIC = 'Anthropic',
  MISTRAL = 'Mistral',
  LMSTUDIO = 'LM Studio'
}

/**
 * Manual link between two entries
 */
export interface Link {
  fromId: string;
  toId: string;
  type?: string;
  createdAt: number;
}

/**
 * Raw chat data preserved from the import, destined for Foundation exactly as
 * it is. Derived data (summary/tags/embedding) never enters this shape — see
 * Gaia-Documentation/capture-chronicle.md.
 */
export interface CaptureTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface CaptureData {
  sourceProvider?: string;
  url?: string;
  occurredAt?: string;
  turns?: CaptureTurn[];
  /** Attachments already uploaded to Foundation, referenced on the chat. */
  attachments?: Array<{ id: string; filename?: string; mimeType?: string; size?: number; url?: string }>;
}

export type SourceFileStatus = 'pending' | 'sent' | 'failed';

/**
 * The original file a chat was parsed from. Foundation owns it; Chronicle keeps
 * an identical byte-for-byte copy. Tracked separately from the chat capture
 * because it is a distinct thing (the file), not a field of the chat.
 */
export interface SourceFileState {
  hash: string;
  size: number;
  filename?: string;
  mimeType?: string;
  path?: string; // local path, for re-sending
  status: SourceFileStatus;
  identical?: boolean; // Chronicle's hash === Foundation's hash
  ingestObjectId?: string;
  error?: string;
  at?: number;
}

export type FoundationCaptureStatus = 'pending' | 'sent' | 'failed';

/** Local bookkeeping of whether this chat reached Foundation. Never sent. */
export interface FoundationCaptureState {
  status: FoundationCaptureStatus;
  providerConversationId?: string;
  id?: string;
  error?: string;
  at?: number;
}

/**
 * Core Entry in the Archive (can be a Chat or a Note)
 */
export interface ChatEntry {
  id: string;
  type: ItemType; // 'chat' or 'note'
  title: string;
  content: string;
  summary: string;
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
  fileName?: string;
  embedding?: number[]; 
  assets?: string[]; // Base64 encoded image strings or URIs
  capture?: CaptureData; // raw capture fields kept for (re)sending to Foundation
  foundation?: FoundationCaptureState; // delivery status of the capture step
  sourceFile?: SourceFileState; // state of the original file (blob) for this import
  /**
   * Removed from the active archive but kept in Chronicle (and in Gaia). Hiding
   * is local; it never touches the Foundation observation. See
   * Gaia-Documentation/capture-chronicle.md ("Deleting from the archive does
   * not delete from Gaia").
   */
  archived?: boolean;
  /**
   * Foundation's content hash of this chat's transcript, computed at import so
   * a re-import can be recognised without re-deriving it. See utils/chatDedup.
   */
  contentHash?: string;
}

/**
 * Light-weight version for search results and listings
 */
export type ChatSummary = Pick<ChatEntry, 'id' | 'title' | 'summary' | 'source' | 'createdAt' | 'type'>;

export interface Settings {
  theme: Theme;
  aiProvider: AIProvider;
  preferredModel: string;
  customEndpoint: string;
  relatedChatsLimit: number;
  availableModels: string[];
  userAvatar?: string;
  userName?: string;
  /** Verberg het venster naar het systeemvak bij minimaliseren. */
  minimizeToTray: boolean;
}

export type ViewMode = 'dashboard' | 'archive' | 'mindmap' | 'search';

export interface AppState {
  chats: ChatEntry[];
  links: Link[];
  searchQuery: string;
  selectedSource: SourceType | 'All';
  selectedTags: string[];
  selectedType: ItemType | 'all';
  
  relatedTags: string[]; 
  isRightPanelOpen: boolean;

  viewMode: ViewMode;
  isUploading: boolean;
  isSettingsOpen: boolean;
  viewingChat: ChatEntry | null;
  settings: Settings;
  returnToMindMap: boolean;
  showArchived: boolean;

  searchFilters: {
    sources: string[];
    dateStart: string;
    dateEnd: string;
    minLength: number;
    isSemantic: boolean;
    type: ItemType | 'all';
  };
}

export interface DateRange {
  start?: string;
  end?: string;
}

export interface SearchArchiveArgs {
  query: string;
}

export interface FilterChatsArgs {
  date_range?: DateRange;
  sources?: string[];
  tags?: string[];
  min_length?: number;
  type?: ItemType;
}
