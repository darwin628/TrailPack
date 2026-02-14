import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "trailpack.auth.token.v1";
const API_BASE = import.meta.env.VITE_API_BASE || "";

const categories = [
  "背包系统",
  "睡眠系统",
  "衣物",
  "炊具",
  "电子设备",
  "医疗与安全",
  "其他",
];

async function api(path, options = {}, token) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function formatG(value) {
  return `${Math.round(value).toLocaleString("zh-CN")} g`;
}

function itemTotal(item) {
  return item.weight * item.qty;
}

function groupByCategory(items) {
  return items.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});
}

function typeLabel(type) {
  if (type === "worn") return "穿戴";
  if (type === "consumable") return "消耗品";
  return "基础";
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [session, setSession] = useState(null);
  const [items, setItems] = useState([]);
  const [authChecking, setAuthChecking] = useState(true);

  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "", confirmPassword: "" });
  const [authError, setAuthError] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [appError, setAppError] = useState("");

  const [form, setForm] = useState({
    name: "",
    category: categories[0],
    type: "base",
    weight: "",
    qty: "1",
  });

  useEffect(() => {
    async function bootstrap() {
      if (!token) {
        setAuthChecking(false);
        return;
      }

      try {
        const [meData, itemsData] = await Promise.all([
          api("/api/auth/me", {}, token),
          api("/api/items", {}, token),
        ]);
        setSession(meData.user);
        setItems(itemsData.items || []);
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
        setSession(null);
        setItems([]);
      } finally {
        setAuthChecking(false);
      }
    }

    bootstrap();
  }, [token]);

  const grouped = useMemo(() => groupByCategory(items), [items]);

  const totals = useMemo(() => {
    const total = items.reduce((sum, item) => sum + itemTotal(item), 0);
    const base = items
      .filter((item) => item.type === "base")
      .reduce((sum, item) => sum + itemTotal(item), 0);
    return { total, base };
  }, [items]);

  const chart = useMemo(() => {
    if (!items.length) return [];
    const total = totals.total || 1;
    return Object.entries(grouped)
      .map(([category, list]) => {
        const weight = list.reduce((sum, item) => sum + itemTotal(item), 0);
        return { category, weight, pct: (weight / total) * 100 };
      })
      .sort((a, b) => b.weight - a.weight);
  }, [grouped, items.length, totals.total]);

  async function onAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");
    setAuthPending(true);

    try {
      const email = normalizeEmail(authForm.email);
      const password = authForm.password;

      if (!email || !password) {
        throw new Error("请输入邮箱和密码");
      }
      if (authMode === "register") {
        if (password.length < 6) throw new Error("密码至少 6 位");
        if (password !== authForm.confirmPassword) throw new Error("两次密码输入不一致");
      }

      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const data = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });

      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setSession(data.user);
      setAuthForm({ email: "", password: "", confirmPassword: "" });
    } catch (err) {
      setAuthError(err.message || "登录失败");
    } finally {
      setAuthPending(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setSession(null);
    setItems([]);
    setAppError("");
  }

  async function onSubmit(e) {
    e.preventDefault();
    setAppError("");

    const weight = Number(form.weight);
    const qty = Number(form.qty);
    const name = form.name.trim();
    if (!name || weight <= 0 || qty <= 0) return;

    try {
      const data = await api(
        "/api/items",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            category: form.category,
            type: form.type,
            weight,
            qty,
          }),
        },
        token
      );
      setItems((prev) => [data.item, ...prev]);
      setForm((prev) => ({ ...prev, name: "", weight: "", qty: "1" }));
    } catch (err) {
      setAppError(err.message || "添加失败");
    }
  }

  async function removeItem(id) {
    setAppError("");
    try {
      await api(`/api/items/${id}`, { method: "DELETE" }, token);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setAppError(err.message || "删除失败");
    }
  }

  async function clearAll() {
    if (!items.length) return;
    if (!window.confirm("确认清空全部装备？")) return;
    setAppError("");

    try {
      await api("/api/items", { method: "DELETE" }, token);
      setItems([]);
    } catch (err) {
      setAppError(err.message || "清空失败");
    }
  }

  if (authChecking) {
    return (
      <main className="auth-page">
        <section className="auth-card card">
          <h1>正在加载账号数据...</h1>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <>
        <div className="bg-orb orb-1" />
        <div className="bg-orb orb-2" />

        <main className="auth-page">
          <section className="auth-card card">
            <p className="eyebrow">TrailPack Account</p>
            <h1>登录后管理你的装备清单</h1>
            <p className="muted">现在数据已保存到数据库，不再依赖浏览器本地存储。</p>

            <div className="auth-tabs">
              <button
                type="button"
                className={`tab ${authMode === "login" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
              >
                登录
              </button>
              <button
                type="button"
                className={`tab ${authMode === "register" ? "active" : ""}`}
                onClick={() => {
                  setAuthMode("register");
                  setAuthError("");
                }}
              >
                注册
              </button>
            </div>

            <form className="item-form" onSubmit={onAuthSubmit}>
              <label>
                邮箱
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={authForm.email}
                  onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))}
                />
              </label>

              <label>
                密码
                <input
                  type="password"
                  autoComplete={authMode === "login" ? "current-password" : "new-password"}
                  required
                  value={authForm.password}
                  onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                />
              </label>

              {authMode === "register" && (
                <label>
                  确认密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={authForm.confirmPassword}
                    onChange={(e) =>
                      setAuthForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                    }
                  />
                </label>
              )}

              {authError && <p className="auth-error">{authError}</p>}

              <button type="submit" disabled={authPending}>
                {authPending ? "处理中..." : authMode === "login" ? "登录" : "创建账号"}
              </button>
            </form>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      <div className="bg-orb orb-1" />
      <div className="bg-orb orb-2" />

      <main className="app">
        <header className="hero card">
          <div>
            <p className="eyebrow">TrailPack Planner</p>
            <h1>更优雅的徒步装备清单</h1>
            <p className="muted">像 LighterPack 一样管理重量，但拥有更好的视觉体验与交互。</p>
            <p className="muted user-pill">当前用户: {session.email}</p>
          </div>
          <div className="hero-metrics">
            <div className="metric">
              <span>基础重量</span>
              <strong>{formatG(totals.base)}</strong>
            </div>
            <div className="metric">
              <span>总携带重量</span>
              <strong>{formatG(totals.total)}</strong>
            </div>
            <button type="button" className="ghost" onClick={logout}>
              退出登录
            </button>
          </div>
        </header>

        {appError && <p className="app-error">{appError}</p>}

        <section className="layout">
          <section className="left-panel card">
            <h2>添加装备</h2>
            <form className="item-form" onSubmit={onSubmit}>
              <label>
                名称
                <input
                  required
                  maxLength={40}
                  placeholder="例如：帐篷"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </label>

              <div className="row">
                <label>
                  分类
                  <select
                    value={form.category}
                    onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                  >
                    {categories.map((cat) => (
                      <option key={cat}>{cat}</option>
                    ))}
                  </select>
                </label>

                <label>
                  类型
                  <select
                    value={form.type}
                    onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
                  >
                    <option value="base">基础装备</option>
                    <option value="worn">穿戴</option>
                    <option value="consumable">消耗品</option>
                  </select>
                </label>
              </div>

              <div className="row">
                <label>
                  单件重量(g)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={form.weight}
                    onChange={(e) => setForm((prev) => ({ ...prev, weight: e.target.value }))}
                  />
                </label>

                <label>
                  数量
                  <input
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={form.qty}
                    onChange={(e) => setForm((prev) => ({ ...prev, qty: e.target.value }))}
                  />
                </label>
              </div>

              <button type="submit">添加到清单</button>
            </form>
          </section>

          <section className="right-panel card">
            <div className="panel-head">
              <h2>装备清单</h2>
              <button type="button" className="ghost" onClick={clearAll}>
                清空
              </button>
            </div>

            <div className="groups">
              {!items.length && <p className="empty">还没有装备，先添加一件试试。</p>}
              {Object.entries(grouped).map(([category, list]) => {
                const total = list.reduce((sum, item) => sum + itemTotal(item), 0);
                return (
                  <section className="group" key={category}>
                    <div className="group-head">
                      <span>{category}</span>
                      <span>{formatG(total)}</span>
                    </div>
                    {list.map((item) => (
                      <article className="item" key={item.id}>
                        <div>
                          <p className="item-name">{item.name}</p>
                          <p className="item-meta">
                            {typeLabel(item.type)} · {item.qty} x {item.weight}g
                          </p>
                        </div>
                        <div className="item-right">
                          <strong className="item-weight">{formatG(itemTotal(item))}</strong>
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => removeItem(item.id)}
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </article>
                    ))}
                  </section>
                );
              })}
            </div>
          </section>
        </section>

        <section className="summary card">
          <h2>分类占比</h2>
          <div className="chart">
            {!chart.length && <p className="empty">添加装备后会显示分类占比。</p>}
            {chart.map((entry) => (
              <div className="chart-row" key={entry.category}>
                <div className="chart-meta">
                  <span>{entry.category}</span>
                  <span>
                    {formatG(entry.weight)} ({entry.pct.toFixed(1)}%)
                  </span>
                </div>
                <div className="bar">
                  <span style={{ width: `${entry.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
