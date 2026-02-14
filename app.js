const STORAGE_KEY = "trailpack.items.v1";

const form = document.getElementById("itemForm");
const groupsEl = document.getElementById("groups");
const chartEl = document.getElementById("chart");
const baseWeightEl = document.getElementById("baseWeight");
const totalWeightEl = document.getElementById("totalWeight");
const clearBtn = document.getElementById("clearBtn");
const itemTpl = document.getElementById("itemTpl");

const state = {
  items: loadItems(),
};

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function formatG(value) {
  return `${Math.round(value).toLocaleString("zh-CN")} g`;
}

function itemTotal(item) {
  return item.weight * item.qty;
}

function computeTotals(items) {
  const total = items.reduce((sum, it) => sum + itemTotal(it), 0);
  const base = items
    .filter((it) => it.type === "base")
    .reduce((sum, it) => sum + itemTotal(it), 0);
  return { total, base };
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

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function renderList() {
  groupsEl.innerHTML = "";

  if (!state.items.length) {
    groupsEl.innerHTML = '<p class="empty">还没有装备，先添加一件试试。</p>';
    return;
  }

  const grouped = groupByCategory(state.items);

  Object.entries(grouped).forEach(([category, items]) => {
    const total = items.reduce((sum, it) => sum + itemTotal(it), 0);

    const group = document.createElement("section");
    group.className = "group";

    const head = document.createElement("div");
    head.className = "group-head";
    head.innerHTML = `<span>${category}</span><span>${formatG(total)}</span>`;
    group.appendChild(head);

    items.forEach((item) => {
      const node = itemTpl.content.firstElementChild.cloneNode(true);
      node.querySelector(".item-name").textContent = item.name;
      node.querySelector(".item-meta").textContent = `${typeLabel(item.type)} · ${item.qty} x ${item.weight}g`;
      node.querySelector(".item-weight").textContent = formatG(itemTotal(item));
      node.querySelector(".delete-btn").addEventListener("click", () => {
        state.items = state.items.filter((it) => it.id !== item.id);
        saveItems();
        renderAll();
      });
      group.appendChild(node);
    });

    groupsEl.appendChild(group);
  });
}

function renderChart() {
  chartEl.innerHTML = "";
  if (!state.items.length) {
    chartEl.innerHTML = '<p class="empty">添加装备后会显示分类占比。</p>';
    return;
  }

  const grouped = groupByCategory(state.items);
  const total = state.items.reduce((sum, it) => sum + itemTotal(it), 0);

  Object.entries(grouped)
    .map(([category, items]) => ({
      category,
      total: items.reduce((sum, it) => sum + itemTotal(it), 0),
    }))
    .sort((a, b) => b.total - a.total)
    .forEach((entry) => {
      const pct = (entry.total / total) * 100;
      const row = document.createElement("div");
      row.className = "chart-row";
      row.innerHTML = `
        <div class="chart-meta">
          <span>${entry.category}</span>
          <span>${formatG(entry.total)} (${pct.toFixed(1)}%)</span>
        </div>
        <div class="bar"><span style="width:${pct}%;"></span></div>
      `;
      chartEl.appendChild(row);
    });
}

function renderTotals() {
  const totals = computeTotals(state.items);
  baseWeightEl.textContent = formatG(totals.base);
  totalWeightEl.textContent = formatG(totals.total);
}

function renderAll() {
  renderList();
  renderChart();
  renderTotals();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const fd = new FormData(form);
  const item = {
    id: uid(),
    name: fd.get("name").toString().trim(),
    category: fd.get("category").toString(),
    type: fd.get("type").toString(),
    weight: Number(fd.get("weight")),
    qty: Number(fd.get("qty")),
  };

  if (!item.name || item.weight <= 0 || item.qty <= 0) return;

  state.items.push(item);
  saveItems();
  renderAll();
  form.reset();
  document.getElementById("qty").value = "1";
  document.getElementById("name").focus();
});

clearBtn.addEventListener("click", () => {
  if (!state.items.length) return;
  const ok = window.confirm("确认清空全部装备？");
  if (!ok) return;
  state.items = [];
  saveItems();
  renderAll();
});

renderAll();
