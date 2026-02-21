const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.sqlite');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new sqlite3.Database(DB_PATH);
  return db;
}

function runSchema(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  return new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function exec(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

module.exports = { openDb, runSchema, exec, get, all, DB_PATH };
