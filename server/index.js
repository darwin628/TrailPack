import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { Pool } from "pg";

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || "trailpack-dev-secret-change-me";
const dbPath = process.env.DB_PATH || "./server/trailpack.db";
const corsOrigin = process.env.CORS_ORIGIN || "*";
const databaseUrl = process.env.DATABASE_URL || "";

async function createDbClient() {
  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        weight INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    return {
      driver: "postgres",
      close: () => pool.end(),
      getUserByEmail: async (email) => {
        const { rows } = await pool.query(
          "SELECT id, email, password_hash FROM users WHERE email = $1 LIMIT 1",
          [email]
        );
        return rows[0] || null;
      },
      getUserById: async (id) => {
        const { rows } = await pool.query("SELECT id, email FROM users WHERE id = $1 LIMIT 1", [id]);
        return rows[0] || null;
      },
      createUser: async (email, passwordHash) => {
        const { rows } = await pool.query(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
          [email, passwordHash]
        );
        return rows[0];
      },
      listItems: async (userId) => {
        const { rows } = await pool.query(
          "SELECT id, name, category, type, weight, qty FROM items WHERE user_id = $1 ORDER BY id DESC",
          [userId]
        );
        return rows;
      },
      createItem: async (userId, item) => {
        const { rows } = await pool.query(
          "INSERT INTO items (user_id, name, category, type, weight, qty) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, category, type, weight, qty",
          [userId, item.name, item.category, item.type, item.weight, item.qty]
        );
        return rows[0];
      },
      deleteItem: async (id, userId) => {
        const result = await pool.query("DELETE FROM items WHERE id = $1 AND user_id = $2", [id, userId]);
        return result.rowCount;
      },
      clearItems: async (userId) => {
        const result = await pool.query("DELETE FROM items WHERE user_id = $1", [userId]);
        return result.rowCount;
      },
    };
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
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

  return {
    driver: "sqlite",
    close: () => sqlite.close(),
    getUserByEmail: async (email) => {
      return (
        sqlite.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email) || null
      );
    },
    getUserById: async (id) => {
      return sqlite.prepare("SELECT id, email FROM users WHERE id = ?").get(id) || null;
    },
    createUser: async (email, passwordHash) => {
      const result = sqlite
        .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
        .run(email, passwordHash);
      return { id: Number(result.lastInsertRowid), email };
    },
    listItems: async (userId) => {
      return sqlite
        .prepare(
          "SELECT id, name, category, type, weight, qty FROM items WHERE user_id = ? ORDER BY id DESC"
        )
        .all(userId);
    },
    createItem: async (userId, item) => {
      const result = sqlite
        .prepare(
          "INSERT INTO items (user_id, name, category, type, weight, qty) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(userId, item.name, item.category, item.type, item.weight, item.qty);
      return sqlite
        .prepare("SELECT id, name, category, type, weight, qty FROM items WHERE id = ?")
        .get(result.lastInsertRowid);
    },
    deleteItem: async (id, userId) => {
      const result = sqlite.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").run(id, userId);
      return result.changes;
    },
    clearItems: async (userId) => {
      const result = sqlite.prepare("DELETE FROM items WHERE user_id = ?").run(userId);
      return result.changes;
    },
  };
}

function normalizeEmail(email = "") {
  return email.trim().toLowerCase();
}

function signToken(user) {
  return jwt.sign({ sub: Number(user.id), email: user.email }, jwtSecret, { expiresIn: "7d" });
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

async function main() {
  const db = await createDbClient();

  app.use(cors({ origin: corsOrigin === "*" ? true : corsOrigin.split(",") }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString(), db: db.driver });
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password || "";

      if (!email || !password) {
        return res.status(400).json({ error: "邮箱和密码不能为空" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "密码至少 6 位" });
      }

      const existing = await db.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ error: "该邮箱已注册" });
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      const user = await db.createUser(email, passwordHash);
      const token = signToken(user);
      return res.status(201).json({ token, user });
    } catch {
      return res.status(500).json({ error: "注册失败" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password || "";

      if (!email || !password) {
        return res.status(400).json({ error: "邮箱和密码不能为空" });
      }

      const user = await db.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: "邮箱或密码错误" });
      }

      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "邮箱或密码错误" });
      }

      const token = signToken(user);
      return res.json({ token, user: { id: Number(user.id), email: user.email } });
    } catch {
      return res.status(500).json({ error: "登录失败" });
    }
  });

  app.get("/api/auth/me", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const user = await db.getUserById(userId);
      if (!user) return res.status(401).json({ error: "用户不存在" });
      return res.json({ user: { id: Number(user.id), email: user.email } });
    } catch {
      return res.status(500).json({ error: "获取用户失败" });
    }
  });

  app.get("/api/items", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const items = await db.listItems(userId);
      return res.json({ items });
    } catch {
      return res.status(500).json({ error: "获取清单失败" });
    }
  });

  app.post("/api/items", authRequired, async (req, res) => {
    try {
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

      const userId = Number(req.user.sub);
      const item = await db.createItem(userId, {
        name,
        category,
        type,
        weight: Math.round(weight),
        qty: Math.round(qty),
      });

      return res.status(201).json({ item });
    } catch {
      return res.status(500).json({ error: "添加装备失败" });
    }
  });

  app.delete("/api/items/:id", authRequired, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "无效的装备 id" });
      }

      const userId = Number(req.user.sub);
      const changes = await db.deleteItem(id, userId);
      if (!changes) {
        return res.status(404).json({ error: "装备不存在" });
      }

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: "删除装备失败" });
    }
  });

  app.delete("/api/items", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const deleted = await db.clearItems(userId);
      return res.json({ ok: true, deleted });
    } catch {
      return res.status(500).json({ error: "清空失败" });
    }
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

  const server = app.listen(port, () => {
    console.log(`TrailPack server running at http://localhost:${port} (db: ${db.driver})`);
  });

  process.on("SIGINT", async () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error("Server failed to start", err);
  process.exit(1);
});
