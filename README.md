# Chronicle AI Archive

A native desktop app (Electron + React) for archiving, searching and exploring AI chat logs. Chats from multiple sources (ChatGPT, Claude, Gemini, Qwen, Local LLM, Other) can be imported, auto-summarized and tagged via Gemini, and stored in PostgreSQL with embeddings for semantic search. Ships with an MCP server (`chronicle-mcp-server`) exposing the archive as tools.

## Prerequisites

- Node.js
- PostgreSQL running locally (or use Docker via `npm run db:up`)

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set your Gemini API key in `.env.local`:

   ```
   API_KEY=<your-gemini-api-key>
   ```

   Get a key at [Google AI Studio](https://aistudio.google.com/apikey).

3. Build and start the desktop app:

   ```bash
   npm start
   ```

   `npm start` runs `vite build` followed by `electron .`.

For frontend development with hot reload, run the Vite dev server and point Electron at it:

```bash
npm run dev
VITE_DEV_SERVER_URL=http://localhost:5173 npm start
```

## Database (PostgreSQL)

Chats are stored in a local PostgreSQL database (`ai_chat_archive` by default). On first launch the app creates the database and schema automatically, so a fresh local PostgreSQL install needs no manual setup.

- Connection string: `DATABASE_URL` env var, default
  `postgresql://postgres:postgres@localhost:5432/ai_chat_archive`
- The PostgreSQL server must be running and reachable with those credentials.
- The pgvector extension is **not** required; embeddings are stored as
  `double precision[]` arrays and similarity is computed in the app.

## Scripts

| Command | Description |
| --- | --- |
| `npm start` | Build the frontend and launch the Electron app |
| `npm run dev` | Start the Vite dev server |
| `npm test` | Run tests (Vitest) |
| `npm run build` | Package installers with electron-builder |
| `npm run db:up` | Start PostgreSQL via Docker Compose |
| `npm run db:down` | Stop the PostgreSQL container |
| `npm run db:reset` | Reset the database (removes all data) |
| `npm run db:logs` | Follow PostgreSQL logs |
| `npm run migrate` | Run database migrations |
