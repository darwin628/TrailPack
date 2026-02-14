import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "trailpack.auth.token.v1";
const LIST_KEY = "trailpack.active.list.v1";
const API_BASE = import.meta.env.VITE_API_BASE || "";
const CUSTOM_CATEGORY_VALUE = "__custom__";

const defaultCategories = [
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
  if (!res.ok) throw new Error(payload.error || "请求失败");
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
  const [lists, setLists] = useState([]);
  const [activeListId, setActiveListId] = useState(0);
  const [items, setItems] = useState([]);
  const [gears, setGears] = useState([]);
  const [categoryCatalog, setCategoryCatalog] = useState([]);
  const [authChecking, setAuthChecking] = useState(true);

  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "", confirmPassword: "" });
  const [resetForm, setResetForm] = useState({ email: "", code: "", newPassword: "", confirmPassword: "" });
  const [resetStep, setResetStep] = useState("request");

  const [listForm, setListForm] = useState({ name: "" });
  const [gearQuery, setGearQuery] = useState("");

  const [authError, setAuthError] = useState("");
  const [authInfo, setAuthInfo] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [listPending, setListPending] = useState(false);
  const [appError, setAppError] = useState("");

  const [form, setForm] = useState({
    name: "",
    category: defaultCategories[0],
    type: "base",
    weight: "",
    qty: "1",
  });

  const grouped = useMemo(() => groupByCategory(items), [items]);

  const currentList = useMemo(() => {
    return lists.find((it) => Number(it.id) === Number(activeListId)) || null;
  }, [lists, activeListId]);

  const categoryOptions = useMemo(() => {
    const merged = new Set(defaultCategories);
    for (const category of categoryCatalog) {
      const text = String(category || "").trim();
      if (text) merged.add(text);
    }
    for (const item of items) {
      const category = String(item.category || "").trim();
      if (category) merged.add(category);
    }
    const current = String(form.category || "").trim();
    if (current) merged.add(current);
    return Array.from(merged);
  }, [categoryCatalog, items, form.category]);

  async function refreshCategories(authToken = token) {
    if (!authToken) return;
    const data = await api("/api/categories", {}, authToken);
    setCategoryCatalog(data.categories || []);
  }

  async function refreshGears(listId = activeListId, authToken = token) {
    if (!authToken || !listId) {
      setGears([]);
      return;
    }
    const data = await api(`/api/gears?listId=${listId}`, {}, authToken);
    setGears(data.gears || []);
  }

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

  const filteredGears = useMemo(() => {
    const q = gearQuery.trim().toLowerCase();
    if (!q) return gears;
    return gears.filter((gear) => {
      return (
        String(gear.name || "").toLowerCase().includes(q) ||
        String(gear.category || "").toLowerCase().includes(q)
      );
    });
  }, [gears, gearQuery]);

  async function fetchItemsForList(listId, authToken = token) {
    if (!listId) {
      setItems([]);
      return;
    }
    const data = await api(`/api/items?listId=${listId}`, {}, authToken);
    const resolvedId = Number(data.activeListId || listId);
    setItems(data.items || []);
    setActiveListId(resolvedId);
    localStorage.setItem(LIST_KEY, String(resolvedId));
  }

  useEffect(() => {
    async function bootstrap() {
      if (!token) {
        setAuthChecking(false);
        return;
      }

      try {
        const [meData, listData] = await Promise.all([
          api("/api/auth/me", {}, token),
          api("/api/lists", {}, token),
          refreshCategories(token),
        ]);
        setSession(meData.user);

        const nextLists = listData.lists || [];
        setLists(nextLists);

        const remembered = Number(localStorage.getItem(LIST_KEY) || 0);
        const matched = nextLists.find((it) => Number(it.id) === remembered);
        const firstId = Number(matched?.id || listData.defaultListId || nextLists[0]?.id || 0);

        if (firstId) {
          await fetchItemsForList(firstId, token);
          await refreshGears(firstId, token);
        } else {
          setItems([]);
          setGears([]);
        }
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(LIST_KEY);
        setToken("");
        setSession(null);
        setLists([]);
        setActiveListId(0);
        setItems([]);
        setGears([]);
        setCategoryCatalog([]);
      } finally {
        setAuthChecking(false);
      }
    }

    bootstrap();
  }, [token]);

  function switchAuthMode(mode) {
    setAuthMode(mode);
    setAuthError("");
    setAuthInfo("");
    if (mode === "forgot") {
      setResetStep("request");
      setResetForm((prev) => ({ ...prev, code: "", newPassword: "", confirmPassword: "" }));
    }
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");
    setAuthInfo("");
    setAuthPending(true);

    try {
      const email = normalizeEmail(authForm.email);
      const password = authForm.password;

      if (!email || !password) throw new Error("请输入邮箱和密码");
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

  async function onRequestResetCode(e) {
    e.preventDefault();
    setAuthError("");
    setAuthInfo("");
    setAuthPending(true);

    try {
      const email = normalizeEmail(resetForm.email);
      if (!email) throw new Error("请输入邮箱");

      const data = await api("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });

      let message = data.message || "如果邮箱存在，已发送重置码。";
      if (data.resetCode) message += ` 测试重置码: ${data.resetCode}`;

      setAuthInfo(message);
      setResetStep("reset");
      setResetForm((prev) => ({ ...prev, email, code: "", newPassword: "", confirmPassword: "" }));
    } catch (err) {
      setAuthError(err.message || "发送重置码失败");
    } finally {
      setAuthPending(false);
    }
  }

  async function onResetPassword(e) {
    e.preventDefault();
    setAuthError("");
    setAuthInfo("");
    setAuthPending(true);

    try {
      const email = normalizeEmail(resetForm.email);
      const code = resetForm.code.trim();
      const newPassword = resetForm.newPassword;

      if (!email || !code || !newPassword) throw new Error("请填写完整信息");
      if (newPassword.length < 6) throw new Error("新密码至少 6 位");
      if (newPassword !== resetForm.confirmPassword) throw new Error("两次新密码不一致");

      const data = await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ email, code, newPassword }),
      });

      setAuthInfo(data.message || "密码已重置，请登录");
      setAuthMode("login");
      setAuthForm((prev) => ({ ...prev, email, password: "", confirmPassword: "" }));
      setResetStep("request");
      setResetForm({ email: "", code: "", newPassword: "", confirmPassword: "" });
    } catch (err) {
      setAuthError(err.message || "重置密码失败");
    } finally {
      setAuthPending(false);
    }
  }

  async function onCreateList(e) {
    e.preventDefault();
    setAppError("");
    setListPending(true);
    try {
      const name = listForm.name.trim();
      if (!name) throw new Error("请输入清单名称");

      const data = await api(
        "/api/lists",
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
        token
      );

      setLists(data.lists || []);
      setListForm({ name: "" });
      const nextId = Number(data.list?.id || 0);
      await fetchItemsForList(nextId);
      await refreshGears(nextId);
    } catch (err) {
      setAppError(err.message || "创建清单失败");
    } finally {
      setListPending(false);
    }
  }

  async function onDeleteCurrentList() {
    if (!activeListId) return;
    if (!window.confirm("确认删除当前行程清单及其装备？")) return;

    setAppError("");
    setListPending(true);
    try {
      const data = await api(`/api/lists/${activeListId}`, { method: "DELETE" }, token);
      setLists(data.lists || []);
      const nextId = Number(data.activeListId || data.lists?.[0]?.id || 0);
      if (nextId) {
        await fetchItemsForList(nextId);
        await refreshGears(nextId);
      } else {
        setActiveListId(0);
        setItems([]);
        setGears([]);
      }
    } catch (err) {
      setAppError(err.message || "删除清单失败");
    } finally {
      setListPending(false);
    }
  }

  async function onSwitchList(nextId) {
    if (!nextId || Number(nextId) === Number(activeListId)) return;
    setAppError("");
    try {
      await fetchItemsForList(Number(nextId));
      await refreshGears(Number(nextId));
    } catch (err) {
      setAppError(err.message || "切换清单失败");
    }
  }

  async function onCloneCurrentList() {
    if (!activeListId || !currentList) return;

    const input = window.prompt("请输入复制后清单名称", `${currentList.name} (复制)`);
    if (input === null) return;
    const name = input.trim();
    if (!name) {
      setAppError("清单名称不能为空");
      return;
    }

    setAppError("");
    setListPending(true);
    try {
      const data = await api(
        `/api/lists/${activeListId}/clone`,
        {
          method: "POST",
          body: JSON.stringify({ name }),
        },
        token
      );
      setLists(data.lists || []);
      await fetchItemsForList(Number(data.list?.id || 0));
      await refreshGears(Number(data.list?.id || 0));
    } catch (err) {
      setAppError(err.message || "复制清单失败");
    } finally {
      setListPending(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LIST_KEY);
    setToken("");
    setSession(null);
    setLists([]);
    setActiveListId(0);
    setItems([]);
    setGears([]);
    setCategoryCatalog([]);
    setAppError("");
  }

  async function onSubmit(e) {
    e.preventDefault();
    setAppError("");

    if (!activeListId) {
      setAppError("请先创建并选择一个行程清单");
      return;
    }

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
            listId: activeListId,
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
      await refreshCategories();
      await refreshGears();
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
      await refreshCategories();
      await refreshGears();
    } catch (err) {
      setAppError(err.message || "删除失败");
    }
  }

  async function clearAll() {
    if (!activeListId) return;
    if (!items.length) return;
    if (!window.confirm("确认清空当前行程清单装备？")) return;

    setAppError("");
    try {
      await api(`/api/items?listId=${activeListId}`, { method: "DELETE" }, token);
      setItems([]);
      await refreshCategories();
      await refreshGears();
    } catch (err) {
      setAppError(err.message || "清空失败");
    }
  }

  async function onAddGearToCurrentList(gear) {
    if (!activeListId) return;
    setAppError("");
    try {
      const data = await api(
        `/api/gears/${gear.id}/add-to-list`,
        {
          method: "POST",
          body: JSON.stringify({ listId: activeListId, qty: gear.defaultQty }),
        },
        token
      );
      setItems((prev) => [data.item, ...prev]);
      await refreshGears();
    } catch (err) {
      setAppError(err.message || "加入当前清单失败");
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
            <p className="muted">支持多个目的地的独立装备清单。</p>

            <div className="auth-tabs auth-tabs-3">
              <button type="button" className={`tab ${authMode === "login" ? "active" : ""}`} onClick={() => switchAuthMode("login")}>登录</button>
              <button type="button" className={`tab ${authMode === "register" ? "active" : ""}`} onClick={() => switchAuthMode("register")}>注册</button>
              <button type="button" className={`tab ${authMode === "forgot" ? "active" : ""}`} onClick={() => switchAuthMode("forgot")}>忘记密码</button>
            </div>

            {(authMode === "login" || authMode === "register") && (
              <form className="item-form" onSubmit={onAuthSubmit}>
                <label>
                  邮箱
                  <input type="email" autoComplete="email" required value={authForm.email} onChange={(e) => setAuthForm((prev) => ({ ...prev, email: e.target.value }))} />
                </label>
                <label>
                  密码
                  <input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} required value={authForm.password} onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))} />
                </label>

                {authMode === "register" && (
                  <label>
                    确认密码
                    <input type="password" autoComplete="new-password" required value={authForm.confirmPassword} onChange={(e) => setAuthForm((prev) => ({ ...prev, confirmPassword: e.target.value }))} />
                  </label>
                )}

                {authError && <p className="auth-error">{authError}</p>}
                {authInfo && <p className="auth-info">{authInfo}</p>}

                <button type="submit" disabled={authPending}>
                  {authPending ? "处理中..." : authMode === "login" ? "登录" : "创建账号"}
                </button>
              </form>
            )}

            {authMode === "forgot" && resetStep === "request" && (
              <form className="item-form" onSubmit={onRequestResetCode}>
                <label>
                  注册邮箱
                  <input type="email" autoComplete="email" required value={resetForm.email} onChange={(e) => setResetForm((prev) => ({ ...prev, email: e.target.value }))} />
                </label>

                {authError && <p className="auth-error">{authError}</p>}
                {authInfo && <p className="auth-info">{authInfo}</p>}

                <button type="submit" disabled={authPending}>{authPending ? "处理中..." : "发送重置码"}</button>
              </form>
            )}

            {authMode === "forgot" && resetStep === "reset" && (
              <form className="item-form" onSubmit={onResetPassword}>
                <label>
                  邮箱
                  <input type="email" autoComplete="email" required value={resetForm.email} onChange={(e) => setResetForm((prev) => ({ ...prev, email: e.target.value }))} />
                </label>
                <label>
                  6位重置码
                  <input inputMode="numeric" pattern="[0-9]{6}" required value={resetForm.code} onChange={(e) => setResetForm((prev) => ({ ...prev, code: e.target.value }))} />
                </label>
                <label>
                  新密码
                  <input type="password" autoComplete="new-password" required value={resetForm.newPassword} onChange={(e) => setResetForm((prev) => ({ ...prev, newPassword: e.target.value }))} />
                </label>
                <label>
                  确认新密码
                  <input type="password" autoComplete="new-password" required value={resetForm.confirmPassword} onChange={(e) => setResetForm((prev) => ({ ...prev, confirmPassword: e.target.value }))} />
                </label>

                {authError && <p className="auth-error">{authError}</p>}
                {authInfo && <p className="auth-info">{authInfo}</p>}

                <div className="auth-actions">
                  <button type="button" className="ghost" onClick={() => setResetStep("request")}>重新获取重置码</button>
                  <button type="submit" disabled={authPending}>{authPending ? "处理中..." : "重置密码"}</button>
                </div>
              </form>
            )}
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
            <h1>多目的地装备清单</h1>
            <p className="muted">为不同路线维护独立装备清单，重量统计互不干扰。</p>
            <p className="muted user-pill">当前用户: {session.email}</p>
            <p className="active-list-badge">
              当前清单: {currentList ? currentList.name : "未选择"}
            </p>
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
          </div>
          <div className="hero-actions">
            <button type="button" className="ghost" onClick={logout}>退出登录</button>
          </div>
        </header>

        <section className="list-manager card">
          <div className="list-manager-head">
            <div>
              <h2>行程清单</h2>
              <p className="muted">切换和复制行程清单</p>
            </div>
            <div className="list-actions">
              <button type="button" className="ghost" onClick={onCloneCurrentList} disabled={listPending || !activeListId}>复制当前清单</button>
              <button type="button" className="ghost" onClick={onDeleteCurrentList} disabled={listPending || !activeListId}>删除当前清单</button>
            </div>
          </div>

          <div className="list-manager-grid">
            <label>
              当前清单
              <select value={activeListId || ""} onChange={(e) => onSwitchList(Number(e.target.value))}>
                {lists.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              新清单名称
              <input value={listForm.name} maxLength={40} placeholder="例如：川西 4 日徒步" onChange={(e) => setListForm((prev) => ({ ...prev, name: e.target.value }))} />
            </label>
            <button type="button" onClick={onCreateList} disabled={listPending}>{listPending ? "处理中..." : "创建新清单"}</button>
          </div>

          {currentList && (
            <p className="current-list-tip">
              当前正在编辑: <strong>{currentList.name}</strong>
            </p>
          )}
        </section>

        {appError && <p className="app-error">{appError}</p>}

        <section className="layout">
          <section className="left-panel card">
            <h2>添加装备</h2>
            <form className="item-form" onSubmit={onSubmit}>
              <label>
                名称
                <input required maxLength={40} placeholder="例如：帐篷" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
              </label>

              <div className="row">
                <label className="category-field">
                  分类
                  <select
                    value={categoryOptions.includes(form.category) ? form.category : CUSTOM_CATEGORY_VALUE}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next !== CUSTOM_CATEGORY_VALUE) {
                        setForm((prev) => ({ ...prev, category: next }));
                        return;
                      }

                      const custom = window.prompt("输入新分类名称", "");
                      if (!custom) return;
                      const name = custom.trim().slice(0, 20);
                      if (!name) return;

                      setCategoryCatalog((prev) => (prev.includes(name) ? prev : [...prev, name]));
                      setForm((prev) => ({ ...prev, category: name }));
                    }}
                  >
                    {categoryOptions.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                    <option value={CUSTOM_CATEGORY_VALUE}>+ 新建分类...</option>
                  </select>
                </label>
                <label>
                  类型
                  <select value={form.type} onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}>
                    <option value="base">基础装备</option>
                    <option value="worn">穿戴</option>
                    <option value="consumable">消耗品</option>
                  </select>
                </label>
              </div>

              <div className="row">
                <label>
                  单件重量(g)
                  <input type="number" min="1" step="1" required value={form.weight} onChange={(e) => setForm((prev) => ({ ...prev, weight: e.target.value }))} />
                </label>
                <label>
                  数量
                  <input type="number" min="1" step="1" required value={form.qty} onChange={(e) => setForm((prev) => ({ ...prev, qty: e.target.value }))} />
                </label>
              </div>

              <button type="submit" disabled={!activeListId}>添加到当前清单</button>
            </form>

            <div className="my-gear-inline">
              <div className="panel-head">
                <h2>我的全部装备</h2>
                <span className="muted">已在当前清单: {gears.filter((g) => g.inCurrentList).length} / {gears.length}</span>
              </div>
              <label className="gear-search">
                搜索装备
                <input
                  placeholder="输入名称或分类，例如：睡袋 / 炊具"
                  value={gearQuery}
                  onChange={(e) => setGearQuery(e.target.value)}
                />
              </label>
              <div className="gear-list">
                {!filteredGears.length && <p className="empty">没有匹配装备。</p>}
                {filteredGears.map((gear) => (
                  <article className="gear-item" key={gear.id}>
                    <div>
                      <p className="item-name">{gear.name}</p>
                      <p className="item-meta">{gear.category} · {typeLabel(gear.type)} · {gear.defaultQty} x {gear.weight}g</p>
                    </div>
                    <div className="gear-item-right">
                      <span className={`gear-state ${gear.inCurrentList ? "in" : "out"}`}>
                        {gear.inCurrentList ? "已在当前清单" : "未加入当前清单"}
                      </span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onAddGearToCurrentList(gear)}
                        disabled={gear.inCurrentList || !activeListId}
                      >
                        加入
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section className="right-panel card">
            <div className="panel-head">
              <h2>装备清单</h2>
              <button type="button" className="ghost" onClick={clearAll}>清空当前清单</button>
            </div>

            <div className="groups">
              {!items.length && <p className="empty">当前清单还没有装备，先添加一件试试。</p>}
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
                          <p className="item-meta">{typeLabel(item.type)} · {item.qty} x {item.weight}g</p>
                        </div>
                        <div className="item-right">
                          <strong className="item-weight">{formatG(itemTotal(item))}</strong>
                          <button type="button" className="delete-btn" onClick={() => removeItem(item.id)} title="删除">✕</button>
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
                  <span>{formatG(entry.weight)} ({entry.pct.toFixed(1)}%)</span>
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
