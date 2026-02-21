import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mountRoutes } from './routes.js';
import { getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

// ensure DB folder
const dbFile = process.env.DB_FILE || './data/paytaksi.sqlite';
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

// migrate once on boot
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
getDb().exec(schema);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Tiny in-memory hooks. In production, replace with Redis/pubsub.
const notify = {
  broadcastNewOrder: null,
  orderAccepted: null,
  orderStatus: null,
  chat: null
};

mountRoutes(app, notify);

app.listen(PORT, () => {
  console.log(`✅ PayTaksi backend running on :${PORT}`);
});

// Export notify so bots can import if you run monolith (optional)
export { notify };
