import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || "trailpack-dev-secret-change-me";
const dbPath = process.env.DB_PATH || "./server/trailpack.db";
const corsOrigin = process.env.CORS_ORIGIN || "*";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    weight INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",") }));
app.use(express.json());

function normalizeEmail(email = "") {
  return email.trim().toLowerCase();
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: "7d" });
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "未登录" });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.post("/api/auth/register", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password || "";

  if (!email || !password) {
    return res.status(400).json({ error: "邮箱和密码不能为空" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "密码至少 6 位" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return res.status(409).json({ error: "该邮箱已注册" });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email, passwordHash);

  const user = { id: result.lastInsertRowid, email };
  const token = signToken(user);
  return res.status(201).json({ token, user });
});

app.post("/api/auth/login", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password || "";

  if (!email || !password) {
    return res.status(400).json({ error: "邮箱和密码不能为空" });
  }

  const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
  if (!user) {
    return res.status(401).json({ error: "邮箱或密码错误" });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "邮箱或密码错误" });
  }

  const token = signToken(user);
  return res.json({ token, user: { id: user.id, email: user.email } });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(req.user.sub);
  if (!user) return res.status(401).json({ error: "用户不存在" });
  return res.json({ user });
});

app.get("/api/items", authRequired, (req, res) => {
  const items = db
    .prepare(
      "SELECT id, name, category, type, weight, qty FROM items WHERE user_id = ? ORDER BY id DESC"
    )
    .all(req.user.sub);
  res.json({ items });
});

app.post("/api/items", authRequired, (req, res) => {
  const name = String(req.body?.name || "").trim();
  const category = String(req.body?.category || "").trim();
  const type = String(req.body?.type || "").trim();
  const weight = Number(req.body?.weight);
  const qty = Number(req.body?.qty);

  if (!name || !category || !type) {
    return res.status(400).json({ error: "请填写完整装备信息" });
  }
  if (!["base", "worn", "consumable"].includes(type)) {
    return res.status(400).json({ error: "装备类型不正确" });
  }
  if (!Number.isFinite(weight) || !Number.isFinite(qty) || weight <= 0 || qty <= 0) {
    return res.status(400).json({ error: "重量和数量必须大于 0" });
  }

  const result = db
    .prepare(
      "INSERT INTO items (user_id, name, category, type, weight, qty) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(req.user.sub, name, category, type, Math.round(weight), Math.round(qty));

  const item = db
    .prepare("SELECT id, name, category, type, weight, qty FROM items WHERE id = ?")
    .get(result.lastInsertRowid);

  return res.status(201).json({ item });
});

app.delete("/api/items/:id", authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "无效的装备 id" });
  }

  const result = db.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").run(id, req.user.sub);
  if (!result.changes) {
    return res.status(404).json({ error: "装备不存在" });
  }

  return res.json({ ok: true });
});

app.delete("/api/items", authRequired, (req, res) => {
  const result = db.prepare("DELETE FROM items WHERE user_id = ?").run(req.user.sub);
  return res.json({ ok: true, deleted: result.changes });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../dist");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`TrailPack server running at http://localhost:${port}`);
});
