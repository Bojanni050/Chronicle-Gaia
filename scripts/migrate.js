
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

async function migrate() {
  console.log('Starting migration to PostgreSQL...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Updating "chats" table with assets column...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'chat',
        title TEXT,
        content TEXT,
        summary TEXT,
        tags JSONB,
        source TEXT,
        createdAt BIGINT,
        updatedAt BIGINT,
        fileName TEXT,
        embedding double precision[],
        assets JSONB DEFAULT '[]'
      )
    `);

    // Check if column exists, add if missing (for existing databases)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='assets') THEN
          ALTER TABLE chats ADD COLUMN assets JSONB DEFAULT '[]';
        END IF;
      END $$;
    `);

    console.log('Checking "links" table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        link_type TEXT,
        created_at BIGINT,
        UNIQUE(from_id, to_id)
      )
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
