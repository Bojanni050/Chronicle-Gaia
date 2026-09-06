
import { Pool } from 'pg';

/**
 * Direct PostgreSQL client configuration.
 * Used for persistent storage of AI chat archives.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

/**
 * Standardized query helper with automatic client release.
 */
export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}
