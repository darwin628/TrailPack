import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "trailpack.auth.token.v1";
const LIST_KEY = "trailpack.active.list.v1";
const API_BASE = import.meta.env.VITE_API_BASE || "";
const CUSTOM_CATEGORY_VALUE = "__custom__";
const DEFAULT_CATEGORY = "默认分类";
const LEGACY_UNCATEGORIZED = "未分类";

function normalizeCategoryName(category) {
  const text = String(category || "").trim();
  if (!text) return DEFAULT_CATEGORY;
  if (text === LEGACY_UNCATEGORIZED) return DEFAULT_CATEGORY;
  return text;
}

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

function carriedItemTotal(item) {
  return item.type === "worn" ? 0 : itemTotal(item);
}

function groupByCategory(items) {
  return items.reduce((acc, item) => {
    const category = normalizeCategoryName(item.category);
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {});
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
  const [itemTypePendingId, setItemTypePendingId] = useState(0);
  const [itemWeightPendingId, setItemWeightPendingId] = useState(0);
  const [editingWeightItemId, setEditingWeightItemId] = useState(0);
  const [weightDrafts, setWeightDrafts] = useState({});
  const [dragPayload, setDragPayload] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState("");
  const [categoryEditPending, setCategoryEditPending] = useState(false);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [editingCategoryValue, setEditingCategoryValue] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [inputDialog, setInputDialog] = useState(null);
  const [appError, setAppError] = useState("");

  const [form, setForm] = useState({
    name: "",
    description: "",
    weight: "",
    qty: "1",
  });

  function beginDrag(e, payload) {
    try {
      e.dataTransfer.setData("application/x-trailpack", JSON.stringify(payload));
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore: fallback to in-memory payload only
    }
    setDragPayload(payload);
    document.body.classList.add("dragging");
  }

  function finishDrag() {
    setDragPayload(null);
    setDragOverCategory("");
    document.body.classList.remove("dragging");
  }

  function resolveDragPayload(e) {
    if (dragPayload) return dragPayload;
    try {
      const raw =
        e.dataTransfer.getData("application/x-trailpack") ||
        e.dataTransfer.getData("text/plain") ||
        "";
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.kind || !parsed.id) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function openConfirmDialog(config) {
    setConfirmDialog(config);
  }

  function openInputDialog(config) {
    setInputDialog({
      ...config,
      value: config.initialValue || "",
    });
  }

  async function onConfirmDialogSubmit() {
    if (!confirmDialog?.onConfirm) return;
    setDialogBusy(true);
    try {
      await confirmDialog.onConfirm();
      setConfirmDialog(null);
    } finally {
      setDialogBusy(false);
    }
  }

  async function onInputDialogSubmit() {
    if (!inputDialog?.onSubmit) return;
    const value = String(inputDialog.value || "").trim();
    if (!value) return;

    setDialogBusy(true);
    try {
      await inputDialog.onSubmit(value);
      setInputDialog(null);
    } finally {
      setDialogBusy(false);
    }
  }

  const grouped = useMemo(() => groupByCategory(items), [items]);

  const currentList = useMemo(() => {
    return lists.find((it) => Number(it.id) === Number(activeListId)) || null;
  }, [lists, activeListId]);

  const categoryOptions = useMemo(() => {
    const merged = new Set();
    for (const category of categoryCatalog) {
      const text = normalizeCategoryName(category);
      if (text) merged.add(text);
    }
    for (const item of items) {
      const category = normalizeCategoryName(item.category);
      if (category) merged.add(category);
    }
    if (!merged.size) merged.add(DEFAULT_CATEGORY);
    return Array.from(merged);
  }, [categoryCatalog, items]);

  const visibleCategories = useMemo(() => {
    const merged = [...(categoryCatalog || []), ...Object.keys(grouped)];
    const seen = new Set();
    const result = [];
    for (const raw of merged) {
      const cat = normalizeCategoryName(raw);
      if (!cat || seen.has(cat)) continue;
      seen.add(cat);
      result.push(cat);
    }
    if (!result.length) result.push(DEFAULT_CATEGORY);
    return result;
  }, [categoryCatalog, grouped]);

  async function refreshCategories(authToken = token) {
    if (!authToken) return;
    const data = await api("/api/categories", {}, authToken);
    setCategoryCatalog((prev) => Array.from(new Set([...(prev || []), ...(data.categories || [])])));
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
    const total = items.reduce((sum, item) => sum + carriedItemTotal(item), 0);
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
        const weight = list.reduce((sum, item) => sum + carriedItemTotal(item), 0);
        return { category, weight, pct: (weight / total) * 100 };
      })
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight);
  }, [grouped, items.length, totals.total]);

  const filteredGears = useMemo(() => {
    const q = gearQuery.trim().toLowerCase();
    if (!q) return gears;
    return gears.filter((gear) => {
      return (
        String(gear.name || "").toLowerCase().includes(q) ||
        String(gear.description || "").toLowerCase().includes(q)
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

  async function doDeleteCurrentList() {
    if (!activeListId) return;

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

  function onDeleteCurrentList() {
    if (!activeListId) return;
    openConfirmDialog({
      title: "删除当前清单？",
      message: "确认删除当前行程清单及其装备？",
      confirmText: "删除",
      onConfirm: doDeleteCurrentList,
    });
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

  async function doCloneCurrentList(name) {
    if (!activeListId || !currentList) return;
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

  function onCloneCurrentList() {
    if (!activeListId || !currentList) return;
    openInputDialog({
      title: "复制当前清单",
      label: "请输入复制后清单名称",
      confirmText: "确定",
      initialValue: `${currentList.name} (复制)`,
      onSubmit: doCloneCurrentList,
    });
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
    const description = String(form.description || "").trim().slice(0, 80);
    if (!name || weight <= 0 || qty <= 0) return;

    try {
      const data = await api(
        "/api/items",
        {
          method: "POST",
          body: JSON.stringify({
            listId: activeListId,
            name,
            description,
            category: visibleCategories[0] || DEFAULT_CATEGORY,
            weight,
            qty,
          }),
        },
        token
      );
      setItems((prev) => [data.item, ...prev]);
      await refreshCategories();
      await refreshGears();
      setForm((prev) => ({ ...prev, name: "", description: "", weight: "", qty: "1" }));
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

  async function doClearAll() {
    if (!activeListId) return;
    if (!items.length) return;

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

  function clearAll() {
    if (!activeListId || !items.length) return;
    openConfirmDialog({
      title: "清空当前清单？",
      message: "确认清空当前行程清单装备？",
      confirmText: "清空",
      onConfirm: doClearAll,
    });
  }

  async function onToggleItemType(item, nextType) {
    if (!item?.id) return;
    setAppError("");
    setItemTypePendingId(item.id);
    try {
      const data = await api(
        `/api/items/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ type: nextType }),
        },
        token
      );
      setItems((prev) => prev.map((it) => (it.id === item.id ? data.item : it)));
      await refreshGears();
    } catch (err) {
      setAppError(err.message || "更新装备标记失败");
    } finally {
      setItemTypePendingId(0);
    }
  }

  async function onChangeItemCategory(item, nextCategory) {
    if (!item?.id) return;
    const category = String(nextCategory || "").trim();
    if (!category || category === item.category) return;
    setAppError("");
    try {
      const data = await api(
        `/api/items/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ category }),
        },
        token
      );
      setItems((prev) => prev.map((it) => (it.id === item.id ? data.item : it)));
      await refreshCategories();
      await refreshGears(activeListId);
    } catch (err) {
      setAppError(err.message || "更新分类失败");
    }
  }

  async function onDropItemToCategory(itemId, category) {
    const item = items.find((it) => it.id === itemId);
    if (!item) return;
    await onChangeItemCategory(item, category);
  }

  async function onDropGearToCategory(gearId, category) {
    const gear = gears.find((it) => it.id === gearId);
    if (!gear) return;
    await onAddGearToCurrentList(gear, category);
  }

  async function onRenameCategory(category, nextRawValue) {
    const currentCategory = normalizeCategoryName(category);
    const nextCategory = normalizeCategoryName(String(nextRawValue || "").trim().slice(0, 20));
    if (!nextCategory || nextCategory === currentCategory) return;

    const exists = visibleCategories.some(
      (cat) => normalizeCategoryName(cat) === nextCategory && normalizeCategoryName(cat) !== currentCategory
    );
    if (exists) {
      setAppError("该分类名称已存在，请换一个名称");
      return;
    }

    const targets = items.filter(
      (it) => normalizeCategoryName(it.category) === currentCategory
    );

    setAppError("");
    setCategoryEditPending(true);
    try {
      if (targets.length) {
        await Promise.all(
          targets.map((it) =>
            api(
              `/api/items/${it.id}`,
              {
                method: "PATCH",
                body: JSON.stringify({ category: nextCategory }),
              },
              token
            )
          )
        );
        await fetchItemsForList(activeListId);
        await refreshCategories();
        await refreshGears(activeListId);
      }
      setCategoryCatalog((prev) => {
        const base = (prev || []).map((cat) =>
          normalizeCategoryName(cat) === currentCategory ? nextCategory : normalizeCategoryName(cat)
        );
        if (!base.includes(nextCategory)) base.push(nextCategory);
        return Array.from(new Set(base));
      });
    } catch (err) {
      setAppError(err.message || "重命名分类失败");
    } finally {
      setCategoryEditPending(false);
      setEditingCategoryName("");
      setEditingCategoryValue("");
    }
  }

  async function doDeleteCategory(category) {
    if (!category) return;
    const targets = items.filter(
      (it) => normalizeCategoryName(it.category) === normalizeCategoryName(category)
    );
    const otherCategories = visibleCategories.filter((cat) => cat !== normalizeCategoryName(category));
    const fallbackCategory =
      otherCategories[0] || (normalizeCategoryName(category) === DEFAULT_CATEGORY ? "新分类" : DEFAULT_CATEGORY);

    setAppError("");
    setCategoryEditPending(true);
    try {
      if (targets.length) {
        await Promise.all(
          targets.map((it) =>
            api(
              `/api/items/${it.id}`,
              {
                method: "PATCH",
                body: JSON.stringify({ category: fallbackCategory }),
              },
              token
            )
          )
        );
      }
      setCategoryCatalog((prev) => {
        const next = (prev || [])
          .map((cat) => normalizeCategoryName(cat))
          .filter((cat) => cat !== normalizeCategoryName(category));
        if (targets.length && !next.includes(fallbackCategory)) next.push(fallbackCategory);
        return Array.from(new Set(next));
      });
      if (targets.length) {
        await fetchItemsForList(activeListId);
        await refreshCategories();
        await refreshGears(activeListId);
      }
    } catch (err) {
      setAppError(err.message || "删除分类失败");
    } finally {
      setCategoryEditPending(false);
      setEditingCategoryName("");
      setEditingCategoryValue("");
    }
  }

  function onDeleteCategory(category) {
    if (!category) return;
    openConfirmDialog({
      title: "删除分类？",
      message: `将删除分类「${category}」并保留其装备`,
      confirmText: "删除分类",
      onConfirm: async () => doDeleteCategory(category),
    });
  }

  function onStartRenameCategory(category) {
    setEditingCategoryName(category);
    setEditingCategoryValue(category);
  }

  function onCancelRenameCategory() {
    setEditingCategoryName("");
    setEditingCategoryValue("");
  }

  function onAddCategoryOnly() {
    openInputDialog({
      title: "添加新分类",
      label: "输入新分类名称",
      confirmText: "添加",
      initialValue: "",
      onSubmit: async (value) => {
        const next = normalizeCategoryName(String(value || "").trim().slice(0, 20));
        if (!next) {
          setAppError("分类名称不能为空");
          return;
        }
        const exists = visibleCategories.includes(next);
        if (exists) {
          setAppError("该分类已存在");
          return;
        }
        setAppError("");
        setCategoryCatalog((prev) => [...(prev || []), next]);
      },
    });
  }

  async function onSaveItemDescription(item, value) {
    if (!item?.id) return;
    const description = String(value || "").trim().slice(0, 80);

    setAppError("");
    try {
      const data = await api(
        `/api/items/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ description }),
        },
        token
      );
      setItems((prev) => prev.map((it) => (it.id === item.id ? data.item : it)));
      await refreshGears(activeListId);
    } catch (err) {
      setAppError(err.message || "更新描述失败");
    }
  }

  function getWeightDraft(item) {
    const draft = weightDrafts[item.id];
    if (draft === undefined || draft === null || draft === "") return String(item.weight);
    return String(draft);
  }

  function onStartEditItemWeight(item) {
    setWeightDrafts((prev) => ({ ...prev, [item.id]: String(item.weight) }));
    setEditingWeightItemId(item.id);
  }

  async function onSaveItemWeight(item) {
    const nextWeight = Math.round(Number(getWeightDraft(item)));
    if (!Number.isFinite(nextWeight) || nextWeight <= 0) {
      setAppError("重量必须大于 0");
      return;
    }
    if (nextWeight === Number(item.weight)) {
      setEditingWeightItemId(0);
      setWeightDrafts((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    setAppError("");
    setItemWeightPendingId(item.id);
    try {
      await api(
        `/api/items/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ weight: nextWeight }),
        },
        token
      );
      await fetchItemsForList(activeListId);
      await refreshGears(activeListId);
      setWeightDrafts((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    } catch (err) {
      setAppError(err.message || "更新重量失败");
    } finally {
      setItemWeightPendingId(0);
      setEditingWeightItemId(0);
    }
  }

  async function onAddGearToCurrentList(gear, targetCategory = "") {
    if (!activeListId) return;
    setAppError("");
    try {
      let createdItem = (await api(
        `/api/gears/${gear.id}/add-to-list`,
        {
          method: "POST",
          body: JSON.stringify({ listId: activeListId, qty: gear.defaultQty }),
        },
        token
      )).item;

      if (targetCategory && targetCategory !== createdItem.category) {
        const patched = await api(
          `/api/items/${createdItem.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ category: targetCategory }),
          },
          token
        );
        createdItem = patched.item;
      }

      setItems((prev) => [createdItem, ...prev.filter((it) => it.id !== createdItem.id)]);
      await refreshCategories();
      await refreshGears();
    } catch (err) {
      setAppError(err.message || "加入当前清单失败");
    }
  }

  async function onDeleteGear(gear) {
    if (!gear?.id) return;
    openConfirmDialog({
      title: "删除装备？",
      message: `确认从“我的全部装备”删除「${gear.name}」？`,
      confirmText: "删除",
      onConfirm: async () => {
        setAppError("");
        try {
          await api(`/api/gears/${gear.id}`, { method: "DELETE" }, token);
          setGears((prev) => prev.filter((g) => g.id !== gear.id));
          await refreshCategories();
        } catch (err) {
          setAppError(err.message || "删除装备失败");
        }
      },
    });
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
              当前正在编辑: {currentList ? currentList.name : "未选择"}
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
              选择清单
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

              <label>
                装备描述（可选）
                <input
                  maxLength={80}
                  placeholder="例如：IPhone 14 Pro / 绿联 20000mAh"
                  value={form.description}
                  onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                />
              </label>

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
                <span className="muted">共 {gears.length} 件</span>
              </div>
              <label className="gear-search">
                搜索装备
                <input
                  placeholder="输入名称或描述，例如：睡袋 / 10000mAh"
                  value={gearQuery}
                  onChange={(e) => setGearQuery(e.target.value)}
                />
              </label>
              <div className="gear-list">
                {!filteredGears.length && <p className="empty">没有匹配装备。</p>}
                {filteredGears.map((gear) => (
                  <article
                    className="gear-item"
                    key={gear.id}
                    draggable
                    onDragStart={(e) => beginDrag(e, { kind: "gear", id: gear.id })}
                    onDragEnd={finishDrag}
                  >
                    <div>
                      <p className="item-name">{gear.name}</p>
                      <p className="item-meta">
                        {gear.description ? `${gear.description} · ` : ""}
                        {gear.defaultQty} x {gear.weight}g
                      </p>
                      <p className="item-meta drag-tip">拖动到右侧目标分类可加入清单</p>
                    </div>
                    <div className="gear-item-right">
                      <button
                        type="button"
                        className="ghost danger-ghost gear-delete-btn"
                        onClick={() => onDeleteGear(gear)}
                      >
                        删除
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
              <div className="panel-actions">
                <button type="button" className="ghost" onClick={onAddCategoryOnly}>添加新分类</button>
                <button type="button" className="ghost" onClick={clearAll}>清空当前清单</button>
              </div>
            </div>

            <div className="groups">
              {!items.length && !categoryCatalog.length && <p className="empty">当前清单还没有装备，先添加一件试试。</p>}
              {visibleCategories.map((category) => {
                const list = grouped[category] || [];
                const total = list.reduce((sum, item) => sum + carriedItemTotal(item), 0);
                return (
                  <section
                    className={`group ${dragOverCategory === category ? "drop-active" : ""}`}
                    key={category}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const payload = resolveDragPayload(e);
                      if (payload) setDragOverCategory(category);
                    }}
                    onDragLeave={() => {
                      if (dragOverCategory === category) setDragOverCategory("");
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      const payload = resolveDragPayload(e);
                      if (!payload) return;
                      if (payload.kind === "item") {
                        await onDropItemToCategory(payload.id, category);
                      } else if (payload.kind === "gear") {
                        await onDropGearToCategory(payload.id, category);
                      }
                      finishDrag();
                    }}
                  >
                    <div className="group-head">
                      <div className="group-title-wrap">
                        {editingCategoryName === category ? (
                          <div className="group-title-edit">
                            <input
                              value={editingCategoryValue}
                              maxLength={20}
                              onChange={(e) => setEditingCategoryValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  onRenameCategory(category, editingCategoryValue);
                                }
                                if (e.key === "Escape") onCancelRenameCategory();
                              }}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="group-edit-btn"
                              title="保存"
                              onClick={() => onRenameCategory(category, editingCategoryValue)}
                              disabled={categoryEditPending}
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              className="group-edit-btn"
                              title="取消"
                              onClick={onCancelRenameCategory}
                              disabled={categoryEditPending}
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <>
                            <span>{category}</span>
                            <button
                              type="button"
                              className="group-edit-btn"
                              title="重命名分类"
                              onClick={() => onStartRenameCategory(category)}
                              disabled={categoryEditPending}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="group-edit-btn group-delete-btn"
                              title="删除分类"
                              onClick={() => onDeleteCategory(category)}
                              disabled={categoryEditPending}
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                      <span>{formatG(total)}</span>
                    </div>
                    {!list.length && <p className="empty">空分类，拖动装备到这里</p>}
                    {list.map((item) => (
                      <article
                        className="item"
                        key={item.id}
                        tabIndex={0}
                        draggable
                        onDragStart={(e) => beginDrag(e, { kind: "item", id: item.id })}
                        onDragEnd={finishDrag}
                      >
                        <div>
                          <p className="item-name">{item.name}</p>
                          <input
                            className={`item-desc-input ${item.description ? "filled" : "empty"}`}
                            value={item.description || ""}
                            maxLength={80}
                            placeholder="添加描述（可选）"
                            onChange={(e) =>
                              setItems((prev) =>
                                prev.map((it) => (it.id === item.id ? { ...it, description: e.target.value } : it))
                              )
                            }
                            onBlur={(e) => onSaveItemDescription(item, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                onSaveItemDescription(item, e.currentTarget.value);
                              }
                            }}
                          />
                          <p className="item-meta">数量: {item.qty}</p>
                          <p className="item-meta drag-tip">拖动到目标分类即可归类</p>
                          <div className="item-markers">
                            <button
                              type="button"
                              className={`marker-btn ${item.type === "worn" ? "active worn" : ""}`}
                              onClick={() => onToggleItemType(item, item.type === "worn" ? "base" : "worn")}
                              disabled={itemTypePendingId === item.id}
                            >
                              穿戴
                            </button>
                            <button
                              type="button"
                              className={`marker-btn ${item.type === "consumable" ? "active consumable" : ""}`}
                              onClick={() =>
                                onToggleItemType(item, item.type === "consumable" ? "base" : "consumable")
                              }
                              disabled={itemTypePendingId === item.id}
                            >
                              消耗品
                            </button>
                          </div>
                        </div>
                        <div className="item-right">
                          <div className="item-weight-edit">
                            {editingWeightItemId === item.id ? (
                              <>
                                <input
                                  type="number"
                                  min="1"
                                  step="1"
                                  value={getWeightDraft(item)}
                                  onChange={(e) =>
                                    setWeightDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
                                  }
                                  onBlur={() => onSaveItemWeight(item)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      onSaveItemWeight(item);
                                    }
                                  }}
                                  autoFocus
                                  disabled={itemWeightPendingId === item.id}
                                />
                                <span>g</span>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="weight-trigger"
                                onClick={() => onStartEditItemWeight(item)}
                                disabled={itemWeightPendingId === item.id}
                                title="点击修改重量"
                              >
                                {item.weight}g
                              </button>
                            )}
                          </div>
                          {item.type === "worn" && <strong className="item-weight">不计入总重</strong>}
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
      {(confirmDialog || inputDialog) && (
        <div className="modal-mask">
          <section className="modal-card">
            <h3>{confirmDialog?.title || inputDialog?.title}</h3>
            {confirmDialog?.message && <p className="muted">{confirmDialog.message}</p>}
            {inputDialog && (
              <label className="modal-input">
                {inputDialog.label}
                <input
                  value={inputDialog.value}
                  onChange={(e) => setInputDialog((prev) => ({ ...prev, value: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onInputDialogSubmit();
                    }
                    if (e.key === "Escape") setInputDialog(null);
                  }}
                  autoFocus
                />
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setConfirmDialog(null);
                  setInputDialog(null);
                }}
                disabled={dialogBusy}
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmDialog ? onConfirmDialogSubmit : onInputDialogSubmit}
                disabled={dialogBusy}
              >
                {confirmDialog?.confirmText || inputDialog?.confirmText || "确定"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
