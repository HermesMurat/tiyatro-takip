"use strict";

const APP_VERSION = 3;
const DB_NAME = "sahneTakipDB";
const DB_VERSION = 1;
const STORE_NAME = "app";
const STATE_KEY = "state";
const FALLBACK_KEY = "sahneTakipFallbackV3";
const LEGACY_KEYS = ["sahneProV2", "sahneProRenkli"];
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const DEPARTMENTS = [
  { id: "demir", name: "Demir", color: "#b47b66", ink: "#fff5ef" },
  { id: "marangoz", name: "Marangoz", color: "#8f754e", ink: "#fff8e9" },
  { id: "bezleme", name: "Bezleme", color: "#906c9c", ink: "#fff5ff" },
  { id: "butafor", name: "Butafor", color: "#9d7047", ink: "#fff7ed" },
  { id: "resimleme", name: "Resimleme", color: "#527e7f", ink: "#efffff" },
  { id: "satinalma", name: "Satın Alma", color: "#667e9d", ink: "#f2f7ff" },
  { id: "aksesuar", name: "Aksesuar", color: "#94754d", ink: "#fff8ec" },
  { id: "kostum", name: "Kostüm", color: "#895f78", ink: "#fff3fa" },
  { id: "sahne", name: "Sahne / Montaj", color: "#5e7770", ink: "#f0fff9" },
  { id: "isik-ses", name: "Işık / Ses", color: "#706b9a", ink: "#f7f4ff" },
  { id: "turne", name: "Turne / Lojistik", color: "#6d7d58", ink: "#f7ffef" },
  { id: "diger", name: "Diğer", color: "#6f6b65", ink: "#f8f5f0" }
];

const STATUS = {
  todo: { label: "Yapılacak", short: "Yapılacak" },
  doing: { label: "Üretimde", short: "Üretimde" },
  done: { label: "Tamamlandı", short: "Tamamlandı" }
};

const PRIORITY = {
  urgent: "Acil",
  high: "Yüksek",
  normal: "Normal",
  low: "Düşük"
};

const FILE_CATEGORIES = {
  drawing: "Teknik çizim",
  visual: "Görsel / Fotoğraf",
  budget: "Bütçe / Teklif",
  document: "Belge",
  other: "Diğer"
};

let appData = emptyData();
let activeProdId = null;
let activeTaskId = null;
let editingProductionId = null;
let editingTaskId = null;
let productionFilter = "active";
let activeTab = "board";
let draggedTaskId = null;
let database = null;
let storageMode = "indexeddb";
let undoSnapshot = null;
let saveSequence = Promise.resolve();

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const byId = id => document.getElementById(id);

function emptyData() {
  return { version: APP_VERSION, productions: [], updatedAt: new Date().toISOString() };
}

function uid(prefix = "id") {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function trLower(value) {
  return String(value || "").toLocaleLowerCase("tr-TR");
}

function parseDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDateFromId(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric) || numeric < 1_000_000_000_000) return new Date().toISOString();
  return new Date(numeric).toISOString();
}

function toInputDate(value) {
  const date = parseDate(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDate(value, options = {}) {
  const date = parseDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric", month: options.long ? "long" : "short", year: options.year === false ? undefined : "numeric"
  }).format(date);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function cloneData(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function getDepartment(value) {
  const raw = String(value || "");
  const legacyName = raw.includes("|") ? raw.split("|")[0] : raw;
  const normalized = trLower(legacyName).replaceAll("ı", "i").replaceAll("ş", "s").replaceAll(" ", "").replaceAll("/", "");
  const aliases = {
    demir: "demir", marangoz: "marangoz", kostum: "bezleme", bezleme: "bezleme",
    butafor: "butafor", resimleme: "resimleme", satinalma: "satinalma",
    aksesuar: "aksesuar", sahnemontaj: "sahne", isikses: "isik-ses",
    turnelojistik: "turne", diger: "diger"
  };
  const id = DEPARTMENTS.some(item => item.id === value) ? value : aliases[normalized] || "diger";
  return DEPARTMENTS.find(item => item.id === id) || DEPARTMENTS.at(-1);
}

function normalizeFile(file, fallbackCategory = "visual") {
  if (!file) return null;
  const data = file.data || file.image || "";
  const mime = file.mime || (data.match(/^data:([^;,]+)/)?.[1]) || "application/octet-stream";
  return {
    id: String(file.id || uid("file")),
    name: String(file.name || "Dosya"),
    category: FILE_CATEGORIES[file.category] ? file.category : fallbackCategory,
    mime,
    size: Number(file.size) || estimateDataUrlSize(data),
    data,
    originalName: file.originalName || file.name || "dosya",
    createdAt: file.createdAt || isoDateFromId(file.id)
  };
}

function normalizeTask(task) {
  const attachments = [
    ...(Array.isArray(task.attachments) ? task.attachments : []),
    ...(Array.isArray(task.drawings) ? task.drawings : [])
  ].map(item => normalizeFile(item, "drawing")).filter(Boolean);
  return {
    id: String(task.id || uid("task")),
    name: String(task.name || task.title || "Adsız iş"),
    department: getDepartment(task.department || task.type).id,
    description: String(task.description ?? task.desc ?? ""),
    status: STATUS[task.status] ? task.status : "todo",
    priority: PRIORITY[task.priority] ? task.priority : "normal",
    owner: String(task.owner || ""),
    start: toInputDate(task.start),
    deadline: toInputDate(task.deadline),
    attachments,
    createdAt: task.createdAt || isoDateFromId(task.id),
    updatedAt: task.updatedAt || task.createdAt || isoDateFromId(task.id)
  };
}

function normalizeProduction(prod) {
  const files = [
    ...(Array.isArray(prod.files) ? prod.files : []),
    ...(Array.isArray(prod.drawings) ? prod.drawings : [])
  ].map(item => normalizeFile(item, "visual")).filter(Boolean);
  return {
    id: String(prod.id || uid("prod")),
    name: String(prod.name || "Adsız oyun"),
    director: String(prod.director || ""),
    venue: String(prod.venue || ""),
    premiere: toInputDate(prod.premiere),
    notes: String(prod.notes || ""),
    status: prod.status === "archived" || prod.archived ? "archived" : "active",
    poster: prod.poster || "",
    tasks: (Array.isArray(prod.tasks) ? prod.tasks : []).map(normalizeTask),
    files,
    createdAt: prod.createdAt || isoDateFromId(prod.id),
    updatedAt: prod.updatedAt || prod.createdAt || isoDateFromId(prod.id)
  };
}

function normalizeAppData(raw) {
  const source = raw && typeof raw === "object" ? raw : emptyData();
  return {
    version: APP_VERSION,
    productions: (Array.isArray(source.productions) ? source.productions : []).map(normalizeProduction),
    updatedAt: source.updatedAt || new Date().toISOString()
  };
}

function estimateDataUrlSize(data) {
  if (!data || !data.includes(",")) return 0;
  const base64 = data.split(",")[1] || "";
  return Math.round(base64.length * .75);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB desteklenmiyor"));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Veri alanı açılamadı"));
  });
}

function idbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Kayıt işlemi iptal edildi"));
  });
}

function loadLegacyData() {
  const keys = [FALLBACK_KEY, ...LEGACY_KEYS];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (error) {
      console.warn(`${key} okunamadı`, error);
    }
  }
  return null;
}

async function loadData() {
  try {
    database = await openDatabase();
    const stored = await idbGet(STATE_KEY);
    if (stored) {
      storageMode = "indexeddb";
      return normalizeAppData(stored);
    }
    const legacy = loadLegacyData();
    const migrated = normalizeAppData(legacy || emptyData());
    await idbPut(STATE_KEY, migrated);
    storageMode = "indexeddb";
    if (legacy) showToast("Eski kayıtlar geniş veri alanına taşındı.", "success");
    return migrated;
  } catch (error) {
    console.warn("IndexedDB kullanılamadı, yerel yedek devrede.", error);
    storageMode = "localstorage";
    return normalizeAppData(loadLegacyData() || emptyData());
  }
}

function saveData(options = {}) {
  appData.updatedAt = new Date().toISOString();
  const snapshot = cloneData(appData);
  saveSequence = saveSequence.then(async () => {
    if (storageMode === "indexeddb" && database) {
      await idbPut(STATE_KEY, snapshot);
      return;
    }
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
  }).then(() => {
    updateStorageStatus();
    if (!options.silent) setSaveIndicator(true);
  }).catch(error => {
    console.error(error);
    showToast("Kayıt tamamlanamadı. Hemen bir yedek indirin.", "error", 7000);
    setSaveIndicator(false);
  });
  return saveSequence;
}

function setSaveIndicator(ok) {
  const dot = byId("storage-dot");
  if (!dot) return;
  dot.style.background = ok ? "var(--green)" : "var(--red)";
}

function getActiveProduction() {
  return appData.productions.find(prod => String(prod.id) === String(activeProdId)) || null;
}

function getActiveTask() {
  return getActiveProduction()?.tasks.find(task => String(task.id) === String(activeTaskId)) || null;
}

function getProgress(prod) {
  const total = prod.tasks.length;
  const done = prod.tasks.filter(task => task.status === "done").length;
  return total ? Math.round(done / total * 100) : 0;
}

function deadlineInfo(task) {
  if (!task.deadline) return { label: "", className: "", days: null };
  const target = parseDate(task.deadline);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  if (task.status !== "done" && days < 0) return { label: `${Math.abs(days)} gün gecikti`, className: "overdue", days };
  if (task.status !== "done" && days <= 3) return { label: days === 0 ? "Bugün" : `${days} gün kaldı`, className: "soon", days };
  return { label: formatDate(task.deadline, { year: false }), className: "", days };
}

function isOverdue(task) {
  return task.status !== "done" && deadlineInfo(task).days < 0;
}

function productionSearchMatches(prod, query) {
  if (!query) return { matches: true, tasks: 0, files: 0 };
  const text = trLower([prod.name, prod.director, prod.venue, prod.notes].join(" "));
  const taskMatches = prod.tasks.filter(task =>
    trLower([task.name, task.description, task.owner, getDepartment(task.department).name].join(" ")).includes(query)
  ).length;
  const fileMatches = prod.files.filter(file => trLower([file.name, file.originalName, FILE_CATEGORIES[file.category]].join(" ")).includes(query)).length;
  return { matches: text.includes(query) || taskMatches > 0 || fileMatches > 0, tasks: taskMatches, files: fileMatches };
}

function renderDashboard() {
  const query = trLower(byId("global-search").value.trim());
  const activeProductions = appData.productions.filter(prod => prod.status !== "archived");
  const allTasks = activeProductions.flatMap(prod => prod.tasks);
  const done = allTasks.filter(task => task.status === "done").length;
  byId("stat-productions").textContent = activeProductions.length;
  byId("stat-tasks").textContent = allTasks.length;
  byId("stat-overdue").textContent = allTasks.filter(isOverdue).length;
  byId("stat-progress").textContent = `%${allTasks.length ? Math.round(done / allTasks.length * 100) : 0}`;

  let rows = appData.productions.map(prod => ({ prod, match: productionSearchMatches(prod, query) }))
    .filter(row => row.match.matches)
    .filter(row => productionFilter === "all" || row.prod.status === productionFilter);

  const sort = byId("production-sort").value;
  rows.sort((a, b) => {
    if (sort === "name") return a.prod.name.localeCompare(b.prod.name, "tr");
    if (sort === "premiere") return (a.prod.premiere || "9999").localeCompare(b.prod.premiere || "9999");
    if (sort === "progress") return getProgress(b.prod) - getProgress(a.prod);
    return String(b.prod.updatedAt).localeCompare(String(a.prod.updatedAt));
  });

  byId("production-count").textContent = `${rows.length} oyun`;
  const searchContext = byId("search-context");
  searchContext.classList.toggle("hidden", !query);
  searchContext.textContent = query ? `“${byId("global-search").value.trim()}” için oyun, iş, sorumlu ve dosya adlarında ${rows.length} sonuç.` : "";

  const grid = byId("productions-grid");
  if (!rows.length) {
    const searched = Boolean(query);
    grid.innerHTML = `
      <div class="empty-state">
        <div><span aria-hidden="true">${searched ? "⌕" : "✦"}</span>
          <h3>${searched ? "Eşleşen kayıt bulunamadı" : productionFilter === "archived" ? "Arşiv henüz boş" : "İlk oyunu oluşturun"}</h3>
          <p>${searched ? "Başka bir sözcükle tekrar deneyin." : "Atölye işlerini, terminleri ve dosyaları tek yerde izleyin."}</p>
          ${!searched && productionFilter !== "archived" ? '<button class="button button-primary" type="button" data-action="new-production">Yeni oyun oluştur</button>' : ""}
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = rows.map(({ prod, match }, index) => {
    const progress = getProgress(prod);
    const completed = prod.tasks.filter(task => task.status === "done").length;
    const overdue = prod.tasks.filter(isOverdue).length;
    const cover = prod.poster
      ? `background-image:url("${prod.poster}")`
      : `background-image:linear-gradient(${135 + (index % 4) * 18}deg, #3a3025, #292329 52%, #1a2528)`;
    const metadata = [prod.director, prod.venue, prod.premiere ? formatDate(prod.premiere) : ""].filter(Boolean).join(" · ") || "Üretim bilgileri eklenmedi";
    const matchNote = query && (match.tasks || match.files)
      ? `<p class="match-note">${match.tasks ? `${match.tasks} iş` : ""}${match.tasks && match.files ? " · " : ""}${match.files ? `${match.files} dosya` : ""} eşleşti</p>` : "";
    return `
      <article class="production-card">
        <button class="card-open-button" type="button" data-action="open-production" data-id="${escapeHtml(prod.id)}" aria-label="${escapeHtml(prod.name)} oyununu aç">Aç</button>
        <div class="production-card-cover" style='${cover}'>
          <span class="production-card-state">${prod.status === "archived" ? "ARŞİV" : overdue ? `${overdue} GECİKEN` : "AKTİF"}</span>
          <div class="production-card-menu">
            <button type="button" data-action="quick-edit-production" data-id="${escapeHtml(prod.id)}" aria-label="${escapeHtml(prod.name)} oyununu düzenle">✎</button>
          </div>
        </div>
        <div class="production-card-body">
          <h3>${escapeHtml(prod.name)}</h3>
          <p class="production-card-meta">${escapeHtml(metadata)}</p>
          ${matchNote}
          <div class="production-card-stats"><span>${prod.tasks.length} iş · ${completed} tamamlandı</span><strong>%${progress}</strong></div>
          <div class="progress-track"><span style="width:${progress}%"></span></div>
        </div>
      </article>`;
  }).join("");
}

function showDashboard() {
  activeProdId = null;
  byId("production-view").classList.add("hidden");
  byId("dashboard-view").classList.remove("hidden");
  byId("global-search").closest(".global-search").classList.remove("hidden");
  renderDashboard();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openProduction(id) {
  const prod = appData.productions.find(item => String(item.id) === String(id));
  if (!prod) return;
  activeProdId = prod.id;
  activeTab = "board";
  byId("dashboard-view").classList.add("hidden");
  byId("production-view").classList.remove("hidden");
  byId("global-search").closest(".global-search").classList.add("hidden");
  byId("task-search").value = "";
  byId("department-filter").value = "all";
  byId("priority-filter").value = "all";
  renderProduction();
  switchTab("board");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderProduction() {
  const prod = getActiveProduction();
  if (!prod) return showDashboard();
  const progress = getProgress(prod);
  const completed = prod.tasks.filter(task => task.status === "done").length;
  const overdue = prod.tasks.filter(isOverdue).length;
  const next = prod.tasks
    .filter(task => task.status !== "done" && task.deadline)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
  const hero = byId("production-hero");
  hero.style.backgroundImage = prod.poster
    ? `url("${prod.poster}")`
    : "linear-gradient(135deg,#433528 0%,#292329 48%,#1c292c 100%)";
  byId("production-title").textContent = prod.name;
  byId("production-state-badge").textContent = prod.status === "archived" ? "Arşivde" : "Aktif prodüksiyon";
  byId("production-meta").textContent = [
    prod.director ? `Yönetmen: ${prod.director}` : "",
    prod.venue,
    prod.premiere ? `Prömiyer: ${formatDate(prod.premiere, { long: true })}` : ""
  ].filter(Boolean).join(" · ") || "Yönetmen, sahne ve prömiyer bilgisi eklenmedi";
  byId("hero-progress-bar").style.width = `${progress}%`;
  byId("project-progress").textContent = `%${progress}`;
  byId("project-completed").textContent = `${completed} / ${prod.tasks.length}`;
  byId("project-overdue").textContent = overdue;
  byId("project-next-deadline").textContent = next ? formatDate(next.deadline, { year: false }) : "—";
  byId("file-count-badge").textContent = prod.files.length;
  byId("project-menu").querySelector('[data-action="archive-production"]').textContent =
    prod.status === "archived" ? "Arşivden çıkar" : "Arşive taşı";
  renderTasks();
  renderFiles();
}

function filteredTasks() {
  const prod = getActiveProduction();
  if (!prod) return [];
  const query = trLower(byId("task-search").value.trim());
  const department = byId("department-filter").value;
  const priority = byId("priority-filter").value;
  return prod.tasks.filter(task => {
    const text = trLower([task.name, task.description, task.owner, getDepartment(task.department).name].join(" "));
    return (!query || text.includes(query))
      && (department === "all" || task.department === department)
      && (priority === "all" || task.priority === priority);
  });
}

function taskCard(task) {
  const department = getDepartment(task.department);
  const deadline = deadlineInfo(task);
  return `
    <article class="task-card" draggable="true" data-task-id="${escapeHtml(task.id)}" tabindex="0"
      aria-label="${escapeHtml(task.name)}, ${escapeHtml(STATUS[task.status].label)}">
      <div class="task-card-top">
        <h3>${escapeHtml(task.name)}</h3><span class="priority-mark ${task.priority}" title="${PRIORITY[task.priority]} öncelik"></span>
      </div>
      ${task.owner ? `<p class="task-owner">Sorumlu · ${escapeHtml(task.owner)}</p>` : ""}
      <div class="task-card-meta">
        <span class="department-tag" style="background:${department.color};color:${department.ink}">${escapeHtml(department.name)}</span>
        <div class="task-facts">
          ${task.attachments.length ? `<span title="Dosya sayısı">▧ ${task.attachments.length}</span>` : ""}
          ${deadline.label ? `<span class="deadline ${deadline.className}">${escapeHtml(deadline.label)}</span>` : ""}
        </div>
      </div>
    </article>`;
}

function renderTasks() {
  const tasks = filteredTasks();
  const allCount = getActiveProduction()?.tasks.length || 0;
  byId("filtered-task-count").textContent = tasks.length === allCount ? `${allCount} iş` : `${tasks.length} / ${allCount} iş`;
  byId("kanban-board").innerHTML = Object.entries(STATUS).map(([status, config]) => {
    const statusTasks = tasks.filter(task => task.status === status);
    return `
      <section class="kanban-column">
        <header class="kanban-header">
          <span class="kanban-heading"><i class="status-dot ${status}"></i>${config.label}</span>
          <span class="kanban-count">${statusTasks.length}</span>
        </header>
        <div class="kanban-dropzone" data-drop-status="${status}">
          ${statusTasks.length ? statusTasks.map(taskCard).join("") : '<div class="kanban-empty">Bu sütunda iş yok.</div>'}
        </div>
      </section>`;
  }).join("");

  const body = byId("task-list-body");
  if (!tasks.length) {
    body.innerHTML = '<tr><td class="empty-table" colspan="6">Bu filtrelerle eşleşen iş bulunamadı.</td></tr>';
  } else {
    body.innerHTML = [...tasks].sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999")).map(task => {
      const department = getDepartment(task.department);
      const deadline = deadlineInfo(task);
      return `
        <tr>
          <td>${escapeHtml(task.name)}</td>
          <td><span class="department-tag" style="background:${department.color};color:${department.ink}">${escapeHtml(department.name)}</span></td>
          <td>${escapeHtml(task.owner || "—")}</td>
          <td><span class="deadline ${deadline.className}">${escapeHtml(deadline.label || "—")}</span></td>
          <td>
            <select class="status-select" data-action="table-status" data-id="${escapeHtml(task.id)}" aria-label="${escapeHtml(task.name)} durumunu değiştir">
              ${Object.entries(STATUS).map(([key, value]) => `<option value="${key}" ${key === task.status ? "selected" : ""}>${value.short}</option>`).join("")}
            </select>
          </td>
          <td><button class="table-row-button" type="button" data-action="open-task" data-id="${escapeHtml(task.id)}">Aç</button></td>
        </tr>`;
    }).join("");
  }
}

function getFileGlyph(file) {
  if (file.mime.startsWith("image/")) return "IMG";
  if (file.mime === "application/pdf" || /\.pdf$/i.test(file.originalName)) return "PDF";
  if (/\.(doc|docx)$/i.test(file.originalName)) return "DOC";
  if (/\.(xls|xlsx)$/i.test(file.originalName)) return "XLS";
  if (/\.(dwg|dxf)$/i.test(file.originalName)) return "CAD";
  return "DOS";
}

function renderFiles() {
  const prod = getActiveProduction();
  if (!prod) return;
  const category = byId("file-category-filter").value;
  const files = prod.files.filter(file => category === "all" || file.category === category);
  const grid = byId("files-grid");
  if (!files.length) {
    grid.innerHTML = `
      <div class="empty-state"><div><span aria-hidden="true">▧</span><h3>Dosya bulunamadı</h3>
      <p>Teknik çizimleri, görselleri ve belgeleri bu oyuna ekleyin.</p>
      <button class="button button-primary" type="button" data-action="new-file">Dosya ekle</button></div></div>`;
    return;
  }
  grid.innerHTML = files.map(file => {
    const image = file.mime.startsWith("image/") && file.data
      ? `<img src="${file.data}" alt="">`
      : `<span class="file-glyph">${getFileGlyph(file)}</span>`;
    return `
      <article class="file-card">
        <div class="file-preview">${image}</div>
        <div class="file-card-body">
          <h3 title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</h3>
          <p>${escapeHtml(FILE_CATEGORIES[file.category] || "Dosya")} · ${formatBytes(file.size)}</p>
          <div class="file-card-actions">
            <button type="button" data-action="open-file" data-id="${escapeHtml(file.id)}">Aç</button>
            <a href="${file.data}" download="${escapeHtml(file.originalName || file.name)}">İndir</a>
            <button class="delete-file" type="button" data-action="delete-file" data-id="${escapeHtml(file.id)}" aria-label="Dosyayı sil">×</button>
          </div>
        </div>
      </article>`;
  }).join("");
}

function switchTab(tab) {
  activeTab = tab;
  ["board", "list", "files"].forEach(name => {
    byId(`tab-${name}`).classList.toggle("hidden", name !== tab);
    byId(`tab-${name}-button`).setAttribute("aria-selected", String(name === tab));
  });
  byId("task-toolbar").classList.toggle("hidden", tab === "files");
}

function populateSelects() {
  const options = DEPARTMENTS.map(dep => `<option value="${dep.id}">${escapeHtml(dep.name)}</option>`).join("");
  byId("task-department").innerHTML = `<option value="">Birim seçin</option>${options}`;
  byId("department-filter").innerHTML = `<option value="all">Tüm birimler</option>${options}`;
}

function openProductionDialog(prod = null) {
  editingProductionId = prod?.id || null;
  byId("production-form").reset();
  byId("production-dialog-title").textContent = prod ? "Oyunu düzenle" : "Yeni oyun";
  byId("production-name").value = prod?.name || "";
  byId("production-director").value = prod?.director || "";
  byId("production-venue").value = prod?.venue || "";
  byId("production-premiere").value = prod?.premiere || "";
  byId("production-status").value = prod?.status || "active";
  byId("production-notes").value = prod?.notes || "";
  byId("production-poster-name").textContent = prod?.poster ? "Mevcut görsel korunacak" : "";
  byId("production-dialog").showModal();
  setTimeout(() => byId("production-name").focus(), 40);
}

function openTaskDialog(task = null) {
  if (!getActiveProduction()) return;
  editingTaskId = task?.id || null;
  byId("task-form").reset();
  byId("task-dialog-title").textContent = task ? "İşi düzenle" : "Yeni iş";
  byId("task-name").value = task?.name || "";
  byId("task-department").value = task?.department || "";
  byId("task-status").value = task?.status || "todo";
  byId("task-priority").value = task?.priority || "normal";
  byId("task-owner").value = task?.owner || "";
  byId("task-start").value = task?.start || "";
  byId("task-deadline").value = task?.deadline || "";
  byId("task-description").value = task?.description || "";
  byId("task-attachment-name").textContent = "";
  byId("task-dialog").showModal();
  setTimeout(() => byId("task-name").focus(), 40);
}

function openFileDialog() {
  if (!getActiveProduction()) return;
  byId("file-form").reset();
  byId("file-input-name").textContent = "";
  byId("file-dialog").showModal();
  setTimeout(() => byId("file-name").focus(), 40);
}

function closeDialog(id) {
  const dialog = byId(id);
  if (dialog?.open) dialog.close();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Dosya okunamadı"));
    reader.readAsDataURL(file);
  });
}

async function prepareFile(file, category = "other") {
  if (!file) return null;
  if (file.size > MAX_FILE_SIZE) throw new Error("Dosya 25 MB sınırını aşıyor.");
  let data;
  let mime = file.type || "application/octet-stream";
  if (mime.startsWith("image/")) {
    data = await optimizeImage(file);
    mime = data.match(/^data:([^;,]+)/)?.[1] || mime;
  } else {
    data = await fileToDataUrl(file);
  }
  return normalizeFile({
    id: uid("file"), name: file.name.replace(/\.[^.]+$/, "") || file.name,
    originalName: file.name, category, mime, size: estimateDataUrlSize(data), data,
    createdAt: new Date().toISOString()
  }, category);
}

function optimizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Görsel okunamadı"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Görsel açılamadı"));
      image.onload = () => {
        const max = 1800;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const output = file.type === "image/png" && file.size < 1_500_000 ? "image/png" : "image/jpeg";
        resolve(canvas.toDataURL(output, .84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function submitProduction(event) {
  event.preventDefault();
  const name = byId("production-name").value.trim();
  if (!name) return showToast("Oyun adı zorunludur.", "error");
  const existing = appData.productions.find(prod => String(prod.id) === String(editingProductionId));
  const posterFile = byId("production-poster").files[0];
  let poster = existing?.poster || "";
  try {
    if (posterFile) poster = await optimizeImage(posterFile);
  } catch (error) {
    return showToast(error.message, "error");
  }
  const now = new Date().toISOString();
  if (existing) {
    Object.assign(existing, {
      name, director: byId("production-director").value.trim(), venue: byId("production-venue").value.trim(),
      premiere: byId("production-premiere").value, status: byId("production-status").value,
      notes: byId("production-notes").value.trim(), poster, updatedAt: now
    });
  } else {
    const prod = normalizeProduction({
      id: uid("prod"), name, director: byId("production-director").value.trim(),
      venue: byId("production-venue").value.trim(), premiere: byId("production-premiere").value,
      status: byId("production-status").value, notes: byId("production-notes").value.trim(),
      poster, tasks: [], files: [], createdAt: now, updatedAt: now
    });
    appData.productions.unshift(prod);
  }
  await saveData();
  closeDialog("production-dialog");
  if (activeProdId) renderProduction(); else renderDashboard();
  showToast(existing ? "Oyun bilgileri güncellendi." : "Yeni oyun oluşturuldu.", "success");
}

async function submitTask(event) {
  event.preventDefault();
  const prod = getActiveProduction();
  if (!prod) return;
  const name = byId("task-name").value.trim();
  const department = byId("task-department").value;
  if (!name || !department) return showToast("İş tanımı ve birim zorunludur.", "error");
  const existing = prod.tasks.find(task => String(task.id) === String(editingTaskId));
  const now = new Date().toISOString();
  let attachment = null;
  try {
    attachment = await prepareFile(byId("task-attachment").files[0], "document");
  } catch (error) {
    return showToast(error.message, "error");
  }
  const values = {
    name, department, status: byId("task-status").value, priority: byId("task-priority").value,
    owner: byId("task-owner").value.trim(), start: byId("task-start").value,
    deadline: byId("task-deadline").value, description: byId("task-description").value.trim(), updatedAt: now
  };
  if (existing) {
    Object.assign(existing, values);
    if (attachment) existing.attachments.push(attachment);
  } else {
    prod.tasks.push(normalizeTask({
      id: uid("task"), ...values, attachments: attachment ? [attachment] : [], createdAt: now
    }));
  }
  prod.updatedAt = now;
  await saveData();
  closeDialog("task-dialog");
  renderProduction();
  showToast(existing ? "İş güncellendi." : "İş üretim panosuna eklendi.", "success");
}

async function submitFile(event) {
  event.preventDefault();
  const prod = getActiveProduction();
  const input = byId("file-input");
  const name = byId("file-name").value.trim();
  if (!prod || !input.files[0] || !name) return showToast("Dosya adı ve dosya zorunludur.", "error");
  try {
    const file = await prepareFile(input.files[0], byId("file-category").value);
    file.name = name;
    prod.files.unshift(file);
    prod.updatedAt = new Date().toISOString();
    await saveData();
    closeDialog("file-dialog");
    renderProduction();
    switchTab("files");
    showToast("Dosya teknik arşive eklendi.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openTaskDetail(id) {
  const task = getActiveProduction()?.tasks.find(item => String(item.id) === String(id));
  if (!task) return;
  activeTaskId = task.id;
  const dep = getDepartment(task.department);
  const deadline = deadlineInfo(task);
  const attachments = task.attachments.length
    ? task.attachments.map(file => `
        <div class="attachment-row"><span>${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>
        <a href="${file.data}" download="${escapeHtml(file.originalName || file.name)}">İndir</a></div>`).join("")
    : '<p class="muted">Bu işe iliştirilmiş dosya yok.</p>';
  byId("task-detail-content").innerHTML = `
    <div class="task-detail-head">
      <div class="task-detail-heading">
        <div><p class="eyebrow">İŞ DETAYI</p><h2>${escapeHtml(task.name)}</h2></div>
        <button class="close-button" type="button" data-close-dialog="task-detail-dialog" aria-label="Kapat">×</button>
      </div>
      <div class="task-detail-badges">
        <span class="department-tag" style="background:${dep.color};color:${dep.ink}">${escapeHtml(dep.name)}</span>
        <span class="detail-badge">${escapeHtml(PRIORITY[task.priority])} öncelik</span>
        ${deadline.label ? `<span class="detail-badge deadline ${deadline.className}">${escapeHtml(deadline.label)}</span>` : ""}
      </div>
    </div>
    <div class="task-detail-body">
      <div>
        <p class="task-description">${escapeHtml(task.description || "Bu iş için açıklama eklenmemiş.")}</p>
        <h3 class="detail-section-title">İlişik dosyalar</h3>
        <div class="attachment-list">${attachments}</div>
      </div>
      <aside class="detail-sidebar">
        <div class="detail-fact"><span>Sorumlu</span><strong>${escapeHtml(task.owner || "Belirlenmedi")}</strong></div>
        <div class="detail-fact"><span>Başlangıç</span><strong>${formatDate(task.start)}</strong></div>
        <div class="detail-fact"><span>Termin</span><strong>${formatDate(task.deadline)}</strong></div>
        <h3 class="detail-section-title">Durumu değiştir</h3>
        <div class="status-buttons">
          ${Object.entries(STATUS).map(([key, value]) => `
            <button class="${task.status === key ? "active" : ""}" type="button" data-action="detail-status" data-status="${key}">${value.label}</button>`).join("")}
        </div>
      </aside>
    </div>
    <div class="task-detail-footer">
      <button class="button button-secondary danger-text" type="button" data-action="delete-task">İşi sil</button>
      <button class="button button-primary" type="button" data-action="edit-task">Düzenle</button>
    </div>`;
  const dialog = byId("task-detail-dialog");
  if (!dialog.open) dialog.showModal();
}

async function changeTaskStatus(taskId, status) {
  const task = getActiveProduction()?.tasks.find(item => String(item.id) === String(taskId));
  if (!task || !STATUS[status]) return;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  getActiveProduction().updatedAt = task.updatedAt;
  await saveData();
  renderProduction();
  if (byId("task-detail-dialog").open) openTaskDetail(task.id);
}

function prepareUndo(message) {
  undoSnapshot = cloneData(appData);
  showToast(message, "info", 7000, {
    label: "Geri al",
    callback: async () => {
      appData = normalizeAppData(undoSnapshot);
      undoSnapshot = null;
      await saveData();
      if (activeProdId && getActiveProduction()) renderProduction(); else showDashboard();
      showToast("Silme işlemi geri alındı.", "success");
    }
  });
}

async function deleteTask() {
  const prod = getActiveProduction();
  const task = getActiveTask();
  if (!prod || !task || !confirm(`“${task.name}” işini silmek istiyor musunuz?`)) return;
  const snapshot = cloneData(appData);
  prod.tasks = prod.tasks.filter(item => String(item.id) !== String(task.id));
  await saveData();
  closeDialog("task-detail-dialog");
  renderProduction();
  undoSnapshot = snapshot;
  showToast("İş silindi.", "info", 7000, {
    label: "Geri al", callback: async () => {
      appData = normalizeAppData(undoSnapshot); undoSnapshot = null; await saveData(); renderProduction();
    }
  });
}

async function deleteProduction() {
  const prod = getActiveProduction();
  if (!prod || !confirm(`“${prod.name}” oyununu bütün işleri ve dosyalarıyla silmek istiyor musunuz?`)) return;
  const snapshot = cloneData(appData);
  appData.productions = appData.productions.filter(item => String(item.id) !== String(prod.id));
  await saveData();
  showDashboard();
  undoSnapshot = snapshot;
  showToast("Oyun silindi.", "info", 7000, {
    label: "Geri al", callback: async () => {
      appData = normalizeAppData(undoSnapshot); undoSnapshot = null; await saveData(); renderDashboard();
    }
  });
}

async function deleteFile(id) {
  const prod = getActiveProduction();
  const file = prod?.files.find(item => String(item.id) === String(id));
  if (!file || !confirm(`“${file.name}” dosyasını silmek istiyor musunuz?`)) return;
  const snapshot = cloneData(appData);
  prod.files = prod.files.filter(item => String(item.id) !== String(id));
  await saveData();
  renderProduction();
  undoSnapshot = snapshot;
  showToast("Dosya silindi.", "info", 7000, {
    label: "Geri al", callback: async () => {
      appData = normalizeAppData(undoSnapshot); undoSnapshot = null; await saveData(); renderProduction();
    }
  });
}

function openFile(id) {
  const file = getActiveProduction()?.files.find(item => String(item.id) === String(id));
  if (!file?.data) return showToast("Dosya içeriği bulunamadı.", "error");
  const win = window.open();
  if (!win) return showToast("Dosyayı açmak için açılır pencereye izin verin.", "error");
  win.location.href = file.data;
}

async function toggleArchive() {
  const prod = getActiveProduction();
  if (!prod) return;
  prod.status = prod.status === "archived" ? "active" : "archived";
  prod.updatedAt = new Date().toISOString();
  await saveData();
  renderProduction();
  byId("project-menu").classList.add("hidden");
  showToast(prod.status === "archived" ? "Oyun arşive taşındı." : "Oyun yeniden aktifleştirildi.", "success");
}

function exportData() {
  const payload = {
    format: "sahne-takip-backup",
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data: appData
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `sahne-takip-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Yedek dosyası indirildi.", "success");
}

async function importData(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const candidate = parsed.format === "sahne-takip-backup" ? parsed.data : parsed;
    if (!candidate || !Array.isArray(candidate.productions)) throw new Error("Bu dosya geçerli bir Sahne Takip yedeği değil.");
    if (!confirm(`Yedekte ${candidate.productions.length} oyun var. Mevcut verinin yerine geri yüklensin mi?`)) return;
    appData = normalizeAppData(candidate);
    await saveData();
    showDashboard();
    closeDialog("storage-dialog");
    showToast("Yedek başarıyla geri yüklendi.", "success");
  } catch (error) {
    showToast(error.message || "Yedek açılamadı.", "error", 6000);
  } finally {
    byId("import-input").value = "";
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return showToast("Bu tarayıcı kalıcı depolama iznini desteklemiyor.", "error");
  const granted = await navigator.storage.persist();
  showToast(granted ? "Kalıcı depolama etkinleştirildi." : "Tarayıcı kalıcı depolama izni vermedi.", granted ? "success" : "info", 5500);
  updateStorageStatus();
}

async function updateStorageStatus() {
  const mode = byId("storage-mode");
  const detail = byId("storage-detail");
  const used = byId("storage-used");
  if (!mode || !detail || !used) return;
  mode.textContent = storageMode === "indexeddb" ? "Bu cihazda geniş alanda kayıtlı" : "Sınırlı tarayıcı alanında kayıtlı";
  detail.textContent = storageMode === "indexeddb" ? "Otomatik kayıt etkin" : "Yedek almanız önerilir";
  try {
    const estimate = await navigator.storage?.estimate?.();
    used.textContent = estimate?.usage ? `${formatBytes(estimate.usage)} kullanılıyor` : "Hazır";
  } catch {
    used.textContent = "Hazır";
  }
}

function showToast(message, type = "info", duration = 3500, action = null) {
  const region = byId("toast-region");
  if (!region) {
    console.info(message);
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span aria-hidden="true">${type === "success" ? "✓" : type === "error" ? "!" : "i"}</span><span class="toast-message">${escapeHtml(message)}</span>`;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => { action.callback(); toast.remove(); });
    toast.appendChild(button);
  }
  region.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("tiyatroTakipTheme", next);
  document.querySelector('meta[name="theme-color"]').content = next === "light" ? "#f3efe7" : "#12110f";
}

function bindEvents() {
  document.addEventListener("click", event => {
    const close = event.target.closest("[data-close-dialog]");
    if (close) return closeDialog(close.dataset.closeDialog);
    const taskCardElement = event.target.closest(".task-card");
    if (taskCardElement) return openTaskDetail(taskCardElement.dataset.taskId);
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "dashboard") showDashboard();
    if (action === "new-production") openProductionDialog();
    if (action === "open-production") openProduction(id);
    if (action === "quick-edit-production") openProductionDialog(appData.productions.find(prod => String(prod.id) === String(id)));
    if (action === "edit-production") openProductionDialog(getActiveProduction());
    if (action === "delete-production") deleteProduction();
    if (action === "archive-production") toggleArchive();
    if (action === "new-task") openTaskDialog();
    if (action === "open-task") openTaskDetail(id);
    if (action === "edit-task") { const task = getActiveTask(); closeDialog("task-detail-dialog"); openTaskDialog(task); }
    if (action === "delete-task") deleteTask();
    if (action === "detail-status") changeTaskStatus(activeTaskId, button.dataset.status);
    if (action === "new-file") openFileDialog();
    if (action === "open-file") openFile(id);
    if (action === "delete-file") deleteFile(id);
    if (action === "toggle-theme") toggleTheme();
    if (action === "open-storage") { updateStorageStatus(); byId("storage-dialog").showModal(); }
    if (action === "export-data") exportData();
    if (action === "import-data") byId("import-input").click();
    if (action === "request-persistent-storage") requestPersistentStorage();
    if (action === "print-report") { switchTab("list"); window.print(); }
    if (action === "toggle-project-menu") {
      byId("project-menu").classList.toggle("hidden");
      button.setAttribute("aria-expanded", String(!byId("project-menu").classList.contains("hidden")));
    }
  });

  document.addEventListener("change", event => {
    if (event.target.matches('[data-action="table-status"]')) changeTaskStatus(event.target.dataset.id, event.target.value);
  });

  byId("production-form").addEventListener("submit", submitProduction);
  byId("task-form").addEventListener("submit", submitTask);
  byId("file-form").addEventListener("submit", submitFile);
  byId("global-search").addEventListener("input", renderDashboard);
  byId("production-sort").addEventListener("change", renderDashboard);
  byId("task-search").addEventListener("input", renderTasks);
  byId("department-filter").addEventListener("change", renderTasks);
  byId("priority-filter").addEventListener("change", renderTasks);
  byId("file-category-filter").addEventListener("change", renderFiles);
  byId("import-input").addEventListener("change", event => importData(event.target.files[0]));

  ["production-poster", "task-attachment", "file-input"].forEach(id => {
    byId(id).addEventListener("change", event => {
      const output = id === "production-poster" ? "production-poster-name" : id === "task-attachment" ? "task-attachment-name" : "file-input-name";
      byId(output).textContent = event.target.files[0]?.name || "";
      if (id === "file-input" && event.target.files[0] && !byId("file-name").value) {
        byId("file-name").value = event.target.files[0].name.replace(/\.[^.]+$/, "");
      }
    });
  });

  $$("[data-production-filter]").forEach(button => {
    button.addEventListener("click", () => {
      productionFilter = button.dataset.productionFilter;
      $$("[data-production-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
      renderDashboard();
    });
  });

  $$("[data-tab]").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));

  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (activeProdId) showDashboard();
      byId("global-search").focus();
    }
    const card = event.target.closest?.(".task-card");
    if (card && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openTaskDetail(card.dataset.taskId);
    }
  });

  document.addEventListener("dragstart", event => {
    const card = event.target.closest(".task-card");
    if (!card) return;
    draggedTaskId = card.dataset.taskId;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedTaskId);
  });
  document.addEventListener("dragend", event => {
    event.target.closest(".task-card")?.classList.remove("dragging");
    $$(".kanban-dropzone").forEach(zone => zone.classList.remove("drag-over"));
    draggedTaskId = null;
  });
  document.addEventListener("dragover", event => {
    const zone = event.target.closest(".kanban-dropzone");
    if (!zone) return;
    event.preventDefault();
    zone.classList.add("drag-over");
  });
  document.addEventListener("dragleave", event => {
    const zone = event.target.closest(".kanban-dropzone");
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("drag-over");
  });
  document.addEventListener("drop", event => {
    const zone = event.target.closest(".kanban-dropzone");
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("drag-over");
    const id = draggedTaskId || event.dataTransfer.getData("text/plain");
    changeTaskStatus(id, zone.dataset.dropStatus);
  });

  $$("dialog").forEach(dialog => {
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialog.close();
    });
  });
}

async function init() {
  populateSelects();
  bindEvents();
  appData = await loadData();
  await saveData({ silent: true });
  renderDashboard();
  updateStorageStatus();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js?v=3.0.2", { updateViaCache: "none" })
      .catch(error => console.warn("Çevrimdışı destek başlatılamadı", error));
  }
}

init().catch(error => {
  console.error(error);
  showToast("Uygulama başlatılamadı. Sayfayı yenileyin.", "error", 8000);
});
