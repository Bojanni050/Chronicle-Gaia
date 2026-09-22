<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/a81b79b2-96ff-4636-a7fe-a185dbdc7d7c

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Database (PostgreSQL)

The app stores chats in a local PostgreSQL database (`ai_chat_archive` by
default). On first launch it creates the database and schema automatically, so a
fresh local PostgreSQL install needs no manual setup.

- Connection string: `DATABASE_URL` env var, default
  `postgresql://postgres:postgres@localhost:5432/ai_chat_archive`
- The PostgreSQL server must be running and reachable with those credentials.
- The pgvector extension is **not** required; embeddings are stored as
  `double precision[]` arrays and similarity is computed in the app.
