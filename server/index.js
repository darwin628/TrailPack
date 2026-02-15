import "dotenv/config";
import crypto from "node:crypto";
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
const exposeResetCode = process.env.EXPOSE_RESET_CODE === "true" || process.env.NODE_ENV !== "production";
const resendApiKey = process.env.RESEND_API_KEY || "";
const mailFrom = process.env.MAIL_FROM || "";
const appUrl = process.env.APP_URL || "";
const defaultListName = "默认行程";
const defaultSeedItems = [
  { name: "双人帐篷", category: "睡眠系统", type: "base", weight: 1280, qty: 1 },
  { name: "羽绒睡袋", category: "睡眠系统", type: "base", weight: 920, qty: 1 },
  { name: "冲锋衣", category: "衣物", type: "worn", weight: 460, qty: 1 },
  { name: "炉头+气罐", category: "炊具", type: "base", weight: 380, qty: 1 },
  { name: "头灯", category: "电子设备", type: "base", weight: 95, qty: 1 },
  { name: "能量胶", category: "其他", type: "consumable", weight: 45, qty: 6 },
];

function hashResetCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function makeResetCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendResetCodeEmail(toEmail, resetCode) {
  if (!resendApiKey || !mailFrom) return { ok: false, reason: "not_configured" };

  const safeAppUrl = appUrl ? `<p>你也可以直接访问：<a href="${appUrl}">${appUrl}</a></p>` : "";
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#1e2a26;">
      <h2>TrailPack 密码重置</h2>
      <p>你正在重置 TrailPack 账号密码。</p>
      <p>你的 6 位重置码是：</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0;">${resetCode}</p>
      <p>重置码 15 分钟内有效，请勿泄露给他人。</p>
      ${safeAppUrl}
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: mailFrom,
      to: [toEmail],
      subject: "TrailPack 密码重置码",
      html,
    }),
  });

  if (!response.ok) {
    const reason = await response.text().catch(() => "unknown");
    console.error("Failed to send reset email:", reason);
    return { ok: false, reason: "provider_error" };
  }

  return { ok: true };
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
  if (!token) return res.status(401).json({ error: "未登录" });

  try {
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

async function createPostgresDb() {
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
    CREATE TABLE IF NOT EXISTS pack_lists (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      destination TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      list_id BIGINT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS list_id BIGINT");
  await pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gear_library (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL,
      default_qty INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, name, category, type, weight)
    );
  `);
  await pool.query("ALTER TABLE gear_library ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");

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

    createPasswordReset: async (email) => {
      const userRes = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email]);
      const user = userRes.rows[0];
      if (!user) return null;

      const code = makeResetCode();
      await pool.query(
        "INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')",
        [user.id, hashResetCode(code)]
      );
      return code;
    },

    resetPasswordWithCode: async (email, code, passwordHash) => {
      const userRes = await pool.query("SELECT id FROM users WHERE email = $1 LIMIT 1", [email]);
      const user = userRes.rows[0];
      if (!user) return false;

      const resetRes = await pool.query(
        "SELECT id FROM password_resets WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
        [user.id, hashResetCode(code)]
      );
      if (!resetRes.rows[0]) return false;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, user.id]);
        await client.query("UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
        await client.query("COMMIT");
        return true;
      } catch {
        await client.query("ROLLBACK");
        return false;
      } finally {
        client.release();
      }
    },

    ensureDefaultList: async (userId) => {
      const existing = await pool.query(
        "SELECT id, name FROM pack_lists WHERE user_id = $1 ORDER BY id ASC LIMIT 1",
        [userId]
      );

      let list = existing.rows[0];
      if (!list) {
        const inserted = await pool.query(
          "INSERT INTO pack_lists (user_id, name, destination) VALUES ($1, $2, $3) RETURNING id, name",
          [userId, defaultListName, ""]
        );
        list = inserted.rows[0];

        for (const item of defaultSeedItems) {
          await pool.query(
            `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, name, category, type, weight)
             DO UPDATE SET default_qty = EXCLUDED.default_qty`,
            [userId, item.name, "", item.category, item.type, item.weight, item.qty]
          );
          await pool.query(
            "INSERT INTO items (user_id, list_id, name, description, category, type, weight, qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [userId, list.id, item.name, "", item.category, item.type, item.weight, item.qty]
          );
        }
      }

      await pool.query("UPDATE items SET list_id = $1 WHERE user_id = $2 AND list_id IS NULL", [list.id, userId]);
      return list;
    },

    listPackLists: async (userId) => {
      const { rows } = await pool.query(
        "SELECT id, name FROM pack_lists WHERE user_id = $1 ORDER BY id ASC",
        [userId]
      );
      return rows;
    },

    getPackListById: async (userId, listId) => {
      const { rows } = await pool.query(
        "SELECT id, name FROM pack_lists WHERE user_id = $1 AND id = $2 LIMIT 1",
        [userId, listId]
      );
      return rows[0] || null;
    },

    createPackList: async (userId, name) => {
      const { rows } = await pool.query(
        "INSERT INTO pack_lists (user_id, name, destination) VALUES ($1, $2, $3) RETURNING id, name",
        [userId, name, ""]
      );
      return rows[0];
    },

    clonePackList: async (userId, sourceListId, name) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const created = await client.query(
          "INSERT INTO pack_lists (user_id, name, destination) VALUES ($1, $2, $3) RETURNING id, name",
          [userId, name, ""]
        );
        const newList = created.rows[0];

        await client.query(
          "INSERT INTO items (user_id, list_id, name, category, type, weight, qty) SELECT user_id, $1, name, category, type, weight, qty FROM items WHERE user_id = $2 AND list_id = $3",
          [newList.id, userId, sourceListId]
        );

        await client.query("COMMIT");
        return newList;
      } catch {
        await client.query("ROLLBACK");
        throw new Error("clone_failed");
      } finally {
        client.release();
      }
    },

    countPackLists: async (userId) => {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM pack_lists WHERE user_id = $1", [userId]);
      return rows[0]?.c || 0;
    },

    deletePackList: async (userId, listId) => {
      await pool.query("DELETE FROM items WHERE user_id = $1 AND list_id = $2", [userId, listId]);
      const result = await pool.query("DELETE FROM pack_lists WHERE user_id = $1 AND id = $2", [userId, listId]);
      return result.rowCount;
    },

    listItems: async (userId, listId) => {
      const { rows } = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE user_id = $1 AND list_id = $2 ORDER BY id DESC",
        [userId, listId]
      );
      return rows;
    },

    createItem: async (userId, listId, item) => {
      const { rows } = await pool.query(
        "INSERT INTO items (user_id, list_id, name, description, category, type, weight, qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, description, category, type, weight, qty",
        [userId, listId, item.name, item.description || "", item.category, item.type, item.weight, item.qty]
      );
      return rows[0];
    },

    getItemById: async (id, userId) => {
      const { rows } = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE id = $1 AND user_id = $2 LIMIT 1",
        [id, userId]
      );
      return rows[0] || null;
    },

    updateItemType: async (id, userId, type) => {
      const { rows } = await pool.query(
        "UPDATE items SET type = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name, description, category, type, weight, qty",
        [type, id, userId]
      );
      return rows[0] || null;
    },

    updateItemCategory: async (id, userId, category) => {
      const { rows } = await pool.query(
        "UPDATE items SET category = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name, description, category, type, weight, qty",
        [category, id, userId]
      );
      return rows[0] || null;
    },

    updateItemDescriptionAndSync: async (id, userId, description) => {
      const current = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE id = $1 AND user_id = $2 LIMIT 1",
        [id, userId]
      );
      const item = current.rows[0];
      if (!item) return null;

      await pool.query(
        "UPDATE items SET description = $1 WHERE user_id = $2 AND name = $3 AND type = $4 AND weight = $5",
        [description, userId, item.name, item.type, item.weight]
      );
      await pool.query(
        "UPDATE gear_library SET description = $1 WHERE user_id = $2 AND name = $3 AND type = $4 AND weight = $5",
        [description, userId, item.name, item.type, item.weight]
      );

      const updated = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE id = $1 AND user_id = $2 LIMIT 1",
        [id, userId]
      );
      return updated.rows[0] || null;
    },

    updateItemWeightAndSync: async (id, userId, weight) => {
      const current = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE id = $1 AND user_id = $2 LIMIT 1",
        [id, userId]
      );
      const item = current.rows[0];
      if (!item) return null;

      if (Number(item.weight) === Number(weight)) return item;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE items SET weight = $1 WHERE user_id = $2 AND name = $3 AND category = $4 AND type = $5 AND weight = $6",
          [weight, userId, item.name, item.category, item.type, item.weight]
        );

        const merged = await client.query(
          `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, name, category, type, weight)
           DO UPDATE SET default_qty = GREATEST(gear_library.default_qty, EXCLUDED.default_qty), description = EXCLUDED.description
           RETURNING id`,
          [userId, item.name, item.description || "", item.category, item.type, weight, item.qty]
        );
        if (merged.rows[0]?.id) {
          await client.query(
            "DELETE FROM gear_library WHERE user_id = $1 AND name = $2 AND category = $3 AND type = $4 AND weight = $5 AND id <> $6",
            [userId, item.name, item.category, item.type, item.weight, merged.rows[0].id]
          );
        } else {
          await client.query(
            "DELETE FROM gear_library WHERE user_id = $1 AND name = $2 AND category = $3 AND type = $4 AND weight = $5",
            [userId, item.name, item.category, item.type, item.weight]
          );
        }

        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        throw new Error("sync_weight_failed");
      } finally {
        client.release();
      }

      const updated = await pool.query(
        "SELECT id, name, description, category, type, weight, qty FROM items WHERE id = $1 AND user_id = $2 LIMIT 1",
        [id, userId]
      );
      return updated.rows[0] || null;
    },

    deleteItem: async (id, userId) => {
      const result = await pool.query("DELETE FROM items WHERE id = $1 AND user_id = $2", [id, userId]);
      return result.rowCount;
    },

    clearItems: async (userId, listId) => {
      const result = await pool.query("DELETE FROM items WHERE user_id = $1 AND list_id = $2", [userId, listId]);
      return result.rowCount;
    },

    listCategories: async (userId) => {
      const { rows } = await pool.query(
        "SELECT DISTINCT category FROM items WHERE user_id = $1 AND category IS NOT NULL AND category <> '' ORDER BY category ASC",
        [userId]
      );
      return rows.map((r) => r.category);
    },

    upsertGear: async (userId, gear) => {
      const { rows } = await pool.query(
        `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, name, category, type, weight)
         DO UPDATE SET default_qty = EXCLUDED.default_qty, description = EXCLUDED.description
         RETURNING id, name, description, category, type, weight, default_qty`,
        [userId, gear.name, gear.description || "", gear.category, gear.type, gear.weight, gear.defaultQty]
      );
      return rows[0];
    },

    listGears: async (userId, listId) => {
      const { rows } = await pool.query(
        `SELECT
           g.id, g.name, g.description, g.category, g.type, g.weight, g.default_qty AS "defaultQty",
           EXISTS (
             SELECT 1 FROM items i
             WHERE i.user_id = g.user_id
               AND i.list_id = $2
               AND i.name = g.name
               AND i.category = g.category
               AND i.type = g.type
               AND i.weight = g.weight
           ) AS "inCurrentList"
         FROM gear_library g
         WHERE g.user_id = $1
         ORDER BY g.name ASC`,
        [userId, listId]
      );
      return rows;
    },

    getGearById: async (userId, gearId) => {
      const { rows } = await pool.query(
        "SELECT id, name, description, category, type, weight, default_qty AS \"defaultQty\" FROM gear_library WHERE user_id = $1 AND id = $2 LIMIT 1",
        [userId, gearId]
      );
      return rows[0] || null;
    },

    deleteGearById: async (userId, gearId) => {
      const result = await pool.query("DELETE FROM gear_library WHERE user_id = $1 AND id = $2", [userId, gearId]);
      return result.rowCount;
    },
  };
}

function sqliteHasColumn(sqlite, table, column) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function createSqliteDb() {
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

    CREATE TABLE IF NOT EXISTS pack_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      destination TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gear_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      type TEXT NOT NULL,
      weight INTEGER NOT NULL,
      default_qty INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name, category, type, weight),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  if (!sqliteHasColumn(sqlite, "items", "list_id")) {
    sqlite.exec("ALTER TABLE items ADD COLUMN list_id INTEGER");
  }
  if (!sqliteHasColumn(sqlite, "items", "description")) {
    sqlite.exec("ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!sqliteHasColumn(sqlite, "gear_library", "description")) {
    sqlite.exec("ALTER TABLE gear_library ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

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

    createPasswordReset: async (email) => {
      const user = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (!user) return null;

      const code = makeResetCode();
      sqlite
        .prepare(
          "INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))"
        )
        .run(user.id, hashResetCode(code));
      return code;
    },

    resetPasswordWithCode: async (email, code, passwordHash) => {
      const user = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (!user) return false;

      const reset = sqlite
        .prepare(
          "SELECT id FROM password_resets WHERE user_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
        )
        .get(user.id, hashResetCode(code));
      if (!reset) return false;

      const tx = sqlite.transaction(() => {
        sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
        sqlite
          .prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL")
          .run(user.id);
      });
      tx();
      return true;
    },

    ensureDefaultList: async (userId) => {
      let list = sqlite.prepare("SELECT id, name FROM pack_lists WHERE user_id = ? ORDER BY id ASC LIMIT 1").get(userId);

      if (!list) {
        const result = sqlite
          .prepare("INSERT INTO pack_lists (user_id, name, destination) VALUES (?, ?, ?)")
          .run(userId, defaultListName, "");
        list = { id: Number(result.lastInsertRowid), name: defaultListName };

        const insertSeedItem = sqlite.prepare(
          "INSERT INTO items (user_id, list_id, name, description, category, type, weight, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        );
        const upsertSeedGear = sqlite.prepare(
          `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, name, category, type, weight) DO UPDATE SET default_qty = excluded.default_qty`
        );
        for (const item of defaultSeedItems) {
          upsertSeedGear.run(userId, item.name, "", item.category, item.type, item.weight, item.qty);
          insertSeedItem.run(userId, list.id, item.name, "", item.category, item.type, item.weight, item.qty);
        }
      }

      sqlite.prepare("UPDATE items SET list_id = ? WHERE user_id = ? AND list_id IS NULL").run(list.id, userId);
      return list;
    },

    listPackLists: async (userId) => {
      return sqlite
        .prepare("SELECT id, name FROM pack_lists WHERE user_id = ? ORDER BY id ASC")
        .all(userId);
    },

    getPackListById: async (userId, listId) => {
      return (
        sqlite
          .prepare("SELECT id, name FROM pack_lists WHERE user_id = ? AND id = ?")
          .get(userId, listId) || null
      );
    },

    createPackList: async (userId, name) => {
      const result = sqlite
        .prepare("INSERT INTO pack_lists (user_id, name, destination) VALUES (?, ?, ?)")
        .run(userId, name, "");
      return { id: Number(result.lastInsertRowid), name };
    },

    clonePackList: async (userId, sourceListId, name) => {
      const insertList = sqlite.prepare("INSERT INTO pack_lists (user_id, name, destination) VALUES (?, ?, ?)");
      const copyItems = sqlite.prepare(
        "INSERT INTO items (user_id, list_id, name, description, category, type, weight, qty) SELECT user_id, ?, name, description, category, type, weight, qty FROM items WHERE user_id = ? AND list_id = ?"
      );

      const tx = sqlite.transaction(() => {
        const result = insertList.run(userId, name, "");
        const newListId = Number(result.lastInsertRowid);
        copyItems.run(newListId, userId, sourceListId);
        return { id: newListId, name };
      });

      return tx();
    },

    countPackLists: async (userId) => {
      const row = sqlite.prepare("SELECT COUNT(*) AS c FROM pack_lists WHERE user_id = ?").get(userId);
      return row?.c || 0;
    },

    deletePackList: async (userId, listId) => {
      sqlite.prepare("DELETE FROM items WHERE user_id = ? AND list_id = ?").run(userId, listId);
      const result = sqlite.prepare("DELETE FROM pack_lists WHERE user_id = ? AND id = ?").run(userId, listId);
      return result.changes;
    },

    listItems: async (userId, listId) => {
      return sqlite
        .prepare(
          "SELECT id, name, description, category, type, weight, qty FROM items WHERE user_id = ? AND list_id = ? ORDER BY id DESC"
        )
        .all(userId, listId);
    },

    createItem: async (userId, listId, item) => {
      const result = sqlite
        .prepare(
          "INSERT INTO items (user_id, list_id, name, description, category, type, weight, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(userId, listId, item.name, item.description || "", item.category, item.type, item.weight, item.qty);
      return sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ?")
        .get(result.lastInsertRowid);
    },

    getItemById: async (id, userId) => {
      return (
        sqlite
          .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ? AND user_id = ?")
          .get(id, userId) || null
      );
    },

    updateItemType: async (id, userId, type) => {
      const result = sqlite
        .prepare("UPDATE items SET type = ? WHERE id = ? AND user_id = ?")
        .run(type, id, userId);
      if (!result.changes) return null;
      return sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ?")
        .get(id);
    },

    updateItemCategory: async (id, userId, category) => {
      const result = sqlite
        .prepare("UPDATE items SET category = ? WHERE id = ? AND user_id = ?")
        .run(category, id, userId);
      if (!result.changes) return null;
      return sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ?")
        .get(id);
    },

    updateItemDescriptionAndSync: async (id, userId, description) => {
      const item = sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ? AND user_id = ?")
        .get(id, userId);
      if (!item) return null;

      sqlite
        .prepare(
          "UPDATE items SET description = ? WHERE user_id = ? AND name = ? AND type = ? AND weight = ?"
        )
        .run(description, userId, item.name, item.type, item.weight);
      sqlite
        .prepare(
          "UPDATE gear_library SET description = ? WHERE user_id = ? AND name = ? AND type = ? AND weight = ?"
        )
        .run(description, userId, item.name, item.type, item.weight);

      return sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ? AND user_id = ?")
        .get(id, userId);
    },

    updateItemWeightAndSync: async (id, userId, weight) => {
      const item = sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ? AND user_id = ?")
        .get(id, userId);
      if (!item) return null;

      if (Number(item.weight) === Number(weight)) return item;

      const tx = sqlite.transaction(() => {
        sqlite
          .prepare(
            "UPDATE items SET weight = ? WHERE user_id = ? AND name = ? AND category = ? AND type = ? AND weight = ?"
          )
          .run(weight, userId, item.name, item.category, item.type, item.weight);

        const existing = sqlite
          .prepare(
            "SELECT id FROM gear_library WHERE user_id = ? AND name = ? AND category = ? AND type = ? AND weight = ? LIMIT 1"
          )
          .get(userId, item.name, item.category, item.type, weight);

        if (!existing) {
          sqlite
            .prepare(
              `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, name, category, type, weight) DO UPDATE SET default_qty = MAX(default_qty, excluded.default_qty), description = excluded.description`
            )
            .run(userId, item.name, item.description || "", item.category, item.type, weight, item.qty);
        }

        sqlite
          .prepare(
            "DELETE FROM gear_library WHERE user_id = ? AND name = ? AND category = ? AND type = ? AND weight = ?"
          )
          .run(userId, item.name, item.category, item.type, item.weight);
      });
      tx();

      return sqlite
        .prepare("SELECT id, name, description, category, type, weight, qty FROM items WHERE id = ? AND user_id = ?")
        .get(id, userId);
    },

    deleteItem: async (id, userId) => {
      const result = sqlite.prepare("DELETE FROM items WHERE id = ? AND user_id = ?").run(id, userId);
      return result.changes;
    },

    clearItems: async (userId, listId) => {
      const result = sqlite.prepare("DELETE FROM items WHERE user_id = ? AND list_id = ?").run(userId, listId);
      return result.changes;
    },

    listCategories: async (userId) => {
      const rows = sqlite
        .prepare(
          "SELECT DISTINCT category FROM items WHERE user_id = ? AND category IS NOT NULL AND TRIM(category) <> '' ORDER BY category ASC"
        )
        .all(userId);
      return rows.map((r) => r.category);
    },

    upsertGear: async (userId, gear) => {
      sqlite
        .prepare(
          `INSERT INTO gear_library (user_id, name, description, category, type, weight, default_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, name, category, type, weight) DO UPDATE SET default_qty = excluded.default_qty, description = excluded.description`
        )
        .run(userId, gear.name, gear.description || "", gear.category, gear.type, gear.weight, gear.defaultQty);

      return (
        sqlite
          .prepare(
            "SELECT id, name, description, category, type, weight, default_qty AS defaultQty FROM gear_library WHERE user_id = ? AND name = ? AND category = ? AND type = ? AND weight = ?"
          )
          .get(userId, gear.name, gear.category, gear.type, gear.weight) || null
      );
    },

    listGears: async (userId, listId) => {
      return sqlite
        .prepare(
          `SELECT
             g.id, g.name, g.description, g.category, g.type, g.weight, g.default_qty AS defaultQty,
             EXISTS (
               SELECT 1 FROM items i
               WHERE i.user_id = g.user_id
                 AND i.list_id = ?
                 AND i.name = g.name
                 AND i.category = g.category
                 AND i.type = g.type
                 AND i.weight = g.weight
             ) AS inCurrentList
           FROM gear_library g
           WHERE g.user_id = ?
           ORDER BY g.name ASC`
        )
        .all(listId, userId)
        .map((row) => ({ ...row, inCurrentList: Boolean(row.inCurrentList) }));
    },

    getGearById: async (userId, gearId) => {
      return (
        sqlite
          .prepare(
            "SELECT id, name, description, category, type, weight, default_qty AS defaultQty FROM gear_library WHERE user_id = ? AND id = ?"
          )
          .get(userId, gearId) || null
      );
    },

    deleteGearById: async (userId, gearId) => {
      const result = sqlite.prepare("DELETE FROM gear_library WHERE user_id = ? AND id = ?").run(userId, gearId);
      return result.changes;
    },
  };
}

async function createDbClient() {
  return databaseUrl ? createPostgresDb() : createSqliteDb();
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

      if (!email || !password) return res.status(400).json({ error: "邮箱和密码不能为空" });
      if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });

      const existing = await db.getUserByEmail(email);
      if (existing) return res.status(409).json({ error: "该邮箱已注册" });

      const user = await db.createUser(email, bcrypt.hashSync(password, 10));
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

      if (!email || !password) return res.status(400).json({ error: "邮箱和密码不能为空" });

      const user = await db.getUserByEmail(email);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: "邮箱或密码错误" });
      }

      const token = signToken(user);
      return res.json({ token, user: { id: Number(user.id), email: user.email } });
    } catch {
      return res.status(500).json({ error: "登录失败" });
    }
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: "请输入邮箱" });

      const resetCode = await db.createPasswordReset(email);
      const message = "如果该邮箱已注册，我们已发送重置码（有效期 15 分钟）";

      if (resetCode && !exposeResetCode) {
        const mailResult = await sendResetCodeEmail(email, resetCode);
        if (!mailResult.ok && mailResult.reason === "not_configured") {
          return res.status(500).json({ error: "服务端未配置邮件发送，请联系管理员" });
        }
        if (!mailResult.ok) {
          return res.status(500).json({ error: "重置邮件发送失败，请稍后重试" });
        }
      }

      if (resetCode && exposeResetCode) return res.json({ ok: true, message, resetCode });
      return res.json({ ok: true, message });
    } catch {
      return res.status(500).json({ error: "发送重置码失败" });
    }
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const code = String(req.body?.code || "").trim();
      const newPassword = req.body?.newPassword || "";

      if (!email || !code || !newPassword) return res.status(400).json({ error: "请填写完整信息" });
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "重置码应为 6 位数字" });
      if (newPassword.length < 6) return res.status(400).json({ error: "新密码至少 6 位" });

      const ok = await db.resetPasswordWithCode(email, code, bcrypt.hashSync(newPassword, 10));
      if (!ok) return res.status(400).json({ error: "重置码无效或已过期" });

      return res.json({ ok: true, message: "密码已重置，请使用新密码登录" });
    } catch {
      return res.status(500).json({ error: "重置密码失败" });
    }
  });

  app.get("/api/auth/me", authRequired, async (req, res) => {
    try {
      const user = await db.getUserById(Number(req.user.sub));
      if (!user) return res.status(401).json({ error: "用户不存在" });
      return res.json({ user: { id: Number(user.id), email: user.email } });
    } catch {
      return res.status(500).json({ error: "获取用户失败" });
    }
  });

  app.get("/api/lists", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const defaultList = await db.ensureDefaultList(userId);
      const lists = await db.listPackLists(userId);
      return res.json({ lists, defaultListId: Number(defaultList.id) });
    } catch {
      return res.status(500).json({ error: "获取行程清单失败" });
    }
  });

  app.get("/api/categories", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const categories = await db.listCategories(userId);
      return res.json({ categories });
    } catch {
      return res.status(500).json({ error: "获取分类失败" });
    }
  });

  app.get("/api/gears", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const defaultList = await db.ensureDefaultList(userId);
      const listId = Number(req.query?.listId || defaultList.id);
      const gears = await db.listGears(userId, listId);
      return res.json({ gears });
    } catch {
      return res.status(500).json({ error: "获取装备库失败" });
    }
  });

  app.post("/api/gears", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const name = String(req.body?.name || "").trim();
      const description = String(req.body?.description || "").trim().slice(0, 80);
      const category = String(req.body?.category || "").trim();
      const type = String(req.body?.type || "").trim();
      const weight = Number(req.body?.weight);
      const defaultQty = Number(req.body?.defaultQty || 1);

      if (!name || !category || !type) return res.status(400).json({ error: "请填写完整装备信息" });
      if (!["base", "worn", "consumable"].includes(type)) return res.status(400).json({ error: "装备类型不正确" });
      if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(defaultQty) || defaultQty <= 0) {
        return res.status(400).json({ error: "重量和数量必须大于 0" });
      }

      const gear = await db.upsertGear(userId, {
        name,
        description,
        category,
        type,
        weight: Math.round(weight),
        defaultQty: Math.round(defaultQty),
      });

      return res.status(201).json({ gear });
    } catch {
      return res.status(500).json({ error: "保存我的装备失败" });
    }
  });

  app.post("/api/gears/:id/add-to-list", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const gearId = Number(req.params.id);
      const listId = Number(req.body?.listId);
      const qty = Number(req.body?.qty || 0);
      if (!Number.isInteger(gearId) || gearId <= 0) return res.status(400).json({ error: "无效装备 id" });
      if (!Number.isInteger(listId) || listId <= 0) return res.status(400).json({ error: "无效清单 id" });

      const list = await db.getPackListById(userId, listId);
      if (!list) return res.status(404).json({ error: "清单不存在" });

      const gear = await db.getGearById(userId, gearId);
      if (!gear) return res.status(404).json({ error: "装备不存在" });

      const item = await db.createItem(userId, listId, {
        name: gear.name,
        description: gear.description || "",
        category: gear.category,
        type: gear.type,
        weight: gear.weight,
        qty: Math.max(1, Math.round(qty || gear.defaultQty || 1)),
      });
      return res.status(201).json({ item });
    } catch {
      return res.status(500).json({ error: "加入清单失败" });
    }
  });

  app.delete("/api/gears/:id", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const gearId = Number(req.params.id);
      if (!Number.isInteger(gearId) || gearId <= 0) return res.status(400).json({ error: "无效装备 id" });

      const changes = await db.deleteGearById(userId, gearId);
      if (!changes) return res.status(404).json({ error: "装备不存在" });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: "删除装备失败" });
    }
  });

  app.post("/api/lists", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "清单名称不能为空" });

      const list = await db.createPackList(userId, name.slice(0, 40));
      const lists = await db.listPackLists(userId);
      return res.status(201).json({ list, lists });
    } catch {
      return res.status(500).json({ error: "创建清单失败" });
    }
  });

  app.post("/api/lists/:id/clone", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const sourceListId = Number(req.params.id);
      if (!Number.isInteger(sourceListId) || sourceListId <= 0) {
        return res.status(400).json({ error: "无效清单 id" });
      }

      const sourceList = await db.getPackListById(userId, sourceListId);
      if (!sourceList) return res.status(404).json({ error: "源清单不存在" });

      const customName = String(req.body?.name || "").trim();
      const cloneName = (customName || `${sourceList.name} (复制)`).slice(0, 40);
      const list = await db.clonePackList(userId, sourceListId, cloneName);
      const lists = await db.listPackLists(userId);
      return res.status(201).json({ list, lists });
    } catch {
      return res.status(500).json({ error: "复制清单失败" });
    }
  });

  app.delete("/api/lists/:id", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const listId = Number(req.params.id);
      if (!Number.isInteger(listId) || listId <= 0) return res.status(400).json({ error: "无效清单 id" });

      const count = await db.countPackLists(userId);
      if (count <= 1) return res.status(400).json({ error: "至少保留一个行程清单" });

      const changes = await db.deletePackList(userId, listId);
      if (!changes) return res.status(404).json({ error: "清单不存在" });

      const lists = await db.listPackLists(userId);
      return res.json({ ok: true, lists, activeListId: Number(lists[0]?.id || 0) });
    } catch {
      return res.status(500).json({ error: "删除清单失败" });
    }
  });

  app.get("/api/items", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const defaultList = await db.ensureDefaultList(userId);

      let listId = Number(req.query?.listId || defaultList.id);
      if (!Number.isInteger(listId) || listId <= 0) listId = Number(defaultList.id);

      const list = await db.getPackListById(userId, listId);
      if (!list) return res.status(404).json({ error: "清单不存在" });

      const items = await db.listItems(userId, listId);
      return res.json({ items, activeListId: listId });
    } catch {
      return res.status(500).json({ error: "获取清单失败" });
    }
  });

  app.post("/api/items", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const listId = Number(req.body?.listId);
      const name = String(req.body?.name || "").trim();
      const description = String(req.body?.description || "").trim();
      const category = String(req.body?.category || "未分类").trim();
      const type = String(req.body?.type || "base").trim();
      const weight = Number(req.body?.weight);
      const qty = Number(req.body?.qty);

      if (!Number.isInteger(listId) || listId <= 0) return res.status(400).json({ error: "请选择有效清单" });
      if (!name || !category || !type) return res.status(400).json({ error: "请填写完整装备信息" });
      if (!["base", "worn", "consumable"].includes(type)) return res.status(400).json({ error: "装备类型不正确" });
      if (!Number.isFinite(weight) || !Number.isFinite(qty) || weight <= 0 || qty <= 0) {
        return res.status(400).json({ error: "重量和数量必须大于 0" });
      }

      const list = await db.getPackListById(userId, listId);
      if (!list) return res.status(404).json({ error: "清单不存在" });

      await db.upsertGear(userId, {
        name,
        description,
        category,
        type,
        weight: Math.round(weight),
        defaultQty: Math.round(qty),
      });

      const item = await db.createItem(userId, listId, {
        name,
        description,
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
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的装备 id" });

      const changes = await db.deleteItem(id, Number(req.user.sub));
      if (!changes) return res.status(404).json({ error: "装备不存在" });

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: "删除装备失败" });
    }
  });

  app.patch("/api/items/:id", authRequired, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的装备 id" });

      const hasType = req.body && Object.prototype.hasOwnProperty.call(req.body, "type");
      const hasWeight = req.body && Object.prototype.hasOwnProperty.call(req.body, "weight");
      const hasCategory = req.body && Object.prototype.hasOwnProperty.call(req.body, "category");
      const hasDescription = req.body && Object.prototype.hasOwnProperty.call(req.body, "description");
      if (!hasType && !hasWeight && !hasCategory && !hasDescription) {
        return res.status(400).json({ error: "请提供需要更新的字段" });
      }

      const userId = Number(req.user.sub);
      let item = await db.getItemById(id, userId);
      if (!item) return res.status(404).json({ error: "装备不存在" });

      if (hasType) {
        const type = String(req.body?.type || "").trim();
        if (!["base", "worn", "consumable"].includes(type)) {
          return res.status(400).json({ error: "装备类型不正确" });
        }
        item = await db.updateItemType(id, userId, type);
        if (!item) return res.status(404).json({ error: "装备不存在" });
      }

      if (hasWeight) {
        const weight = Math.round(Number(req.body?.weight));
        if (!Number.isFinite(weight) || weight <= 0) {
          return res.status(400).json({ error: "重量必须大于 0" });
        }
        item = await db.updateItemWeightAndSync(id, userId, weight);
      }

      if (hasCategory) {
        const category = String(req.body?.category || "").trim();
        if (!category) return res.status(400).json({ error: "分类不能为空" });
        item = await db.updateItemCategory(id, userId, category.slice(0, 20));
      }

      if (hasDescription) {
        const description = String(req.body?.description || "").trim().slice(0, 80);
        item = await db.updateItemDescriptionAndSync(id, userId, description);
      }

      if (!item) return res.status(404).json({ error: "装备不存在" });
      return res.json({ item });
    } catch {
      return res.status(500).json({ error: "更新装备失败" });
    }
  });

  app.delete("/api/items", authRequired, async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const listId = Number(req.query?.listId);
      if (!Number.isInteger(listId) || listId <= 0) return res.status(400).json({ error: "请选择有效清单" });

      const list = await db.getPackListById(userId, listId);
      if (!list) return res.status(404).json({ error: "清单不存在" });

      const deleted = await db.clearItems(userId, listId);
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
