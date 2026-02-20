import Database from 'better-sqlite3';

const dbFile = process.env.DB_FILE || './data/paytaksi.sqlite';

export function getDb() {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  return db;
}
