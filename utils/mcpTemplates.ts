
export const PACKAGE_JSON = JSON.stringify({
  "name": "chronicle-mcp-server",
  "version": "1.1.0",
  "description": "MCP Server for your Chronicle AI Archive",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0"
  }
}, null, 2);

export const SERVER_JS = `#!/usr/bin/env node
/**
 * Chronicle MCP Server
 * A Model Context Protocol implementation to expose your personal AI archive.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'chronicle-db.json');

// --- Data Layer ---
let chats = [];

function loadData() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      chats = JSON.parse(data);
      console.error(\`[Chronicle] Loaded \${chats.length} conversations.\`);
    } else {
      console.error('[Chronicle] ERROR: chronicle-db.json not found in server directory.');
    }
  } catch (error) {
    console.error('[Chronicle] ERROR loading database:', error);
  }
}

// --- Vector Math for Semantic Search ---
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Initialize
loadData();

const server = new Server(
  { name: 'chronicle-mcp-server', version: '1.1.0' },
  { capabilities: { resources: {}, tools: {} } }
);

// --- Resources: Allows LLMs to see a list of all chats as files ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: chats.map(chat => ({
      uri: \`chronicle://chats/\${chat.id}\`,
      name: chat.title,
      description: chat.summary,
      mimeType: 'text/markdown',
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const id = url.pathname.replace(/^\\//, '');
  const chat = chats.find(c => c.id === id);

  if (!chat) throw new Error(\`Chat \${id} not found\`);

  const md = \`# \${chat.title}
**Date:** \${new Date(chat.createdAt).toLocaleDateString()}
**Source:** \${chat.source}
**Tags:** \${chat.tags.join(', ')}

## Summary
\${chat.summary}

## Transcript
\${chat.content}
\`;

  return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: md }] };
});

// --- Tools: Functional entry points for the LLM ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_archive',
        description: 'Search conversations by keywords in title, summary, or tags.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term or keyword' },
          },
          required: ['query'],
        },
      },
      {
        name: 'semantic_search',
        description: 'Find conversations conceptually similar to a specific chat ID using vector embeddings.',
        inputSchema: {
          type: 'object',
          properties: {
            targetId: { type: 'string', description: 'ID of the chat to find similar results for' },
            limit: { type: 'number', description: 'Number of results (default 5)' }
          },
          required: ['targetId'],
        },
      },
      {
        name: 'list_recent_chats',
        description: 'Get a list of the most recent archived conversations.',
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'number', description: 'Number of chats to return' },
          },
        },
      },
      {
        name: 'list_tags',
        description: 'List all unique tags used across the archive.',
        inputSchema: { type: 'object', properties: {} },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'search_archive':
      const q = args.query.toLowerCase();
      const results = chats.filter(c => 
        c.title.toLowerCase().includes(q) || 
        c.summary.toLowerCase().includes(q) ||
        c.tags.some(t => t.toLowerCase().includes(q))
      ).slice(0, 10);
      return { content: [{ type: 'text', text: JSON.stringify(results.map(r => ({ id: r.id, title: r.title, summary: r.summary })), null, 2) }] };

    case 'semantic_search':
      const target = chats.find(c => c.id === args.targetId);
      if (!target || !target.embedding) return { isError: true, content: [{ type: 'text', text: 'Target chat not found or has no vector data.' }] };
      
      const scored = chats
        .filter(c => c.id !== target.id && c.embedding)
        .map(c => ({ id: c.id, title: c.title, summary: c.summary, score: cosineSimilarity(target.embedding, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, args.limit || 5);
      return { content: [{ type: 'text', text: JSON.stringify(scored, null, 2) }] };

    case 'list_recent_chats':
      const recent = chats.slice(0, args.count || 5).map(r => ({ id: r.id, title: r.title, date: new Date(r.createdAt).toISOString() }));
      return { content: [{ type: 'text', text: JSON.stringify(recent, null, 2) }] };

    case 'list_tags':
      const tags = [...new Set(chats.flatMap(c => c.tags))].sort();
      return { content: [{ type: 'text', text: tags.join(', ') }] };

    default:
      throw new Error(\`Unknown tool: \${name}\`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[Chronicle] MCP Server Started');
`;
