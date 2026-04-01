const STORAGE_KEY = "warehouse_scan_data_v1";
const CANCELED_KEY = "warehouse_cancelled_orders_v1";
const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

const STATUS = {
  SUCCESS: "SUCCESS",
  DUPLICATE: "DUPLICATE",
  CANCELED: "CANCELED",
};

const statusLabel = {
  [STATUS.SUCCESS]: "QUET_THANH_CONG",
  [STATUS.DUPLICATE]: "DA_QUET_TRUOC_DO",
  [STATUS.CANCELED]: "DON_HUY",
};

const statusClass = {
  [STATUS.SUCCESS]: "row-success",
  [STATUS.DUPLICATE]: "row-warning",
  [STATUS.CANCELED]: "row-error",
};

let selectedHistoryDate = null;
let currentFilter = { mode: "single", singleDate: todayStr(), fromDate: "", toDate: "" };
let carrierChart = null;
let activePage = "scanPage";
let db = null;
let useCloud = false;
let cloudCancelledSet = new Set();
let currentDayUnsubscribe = null;
let daysUnsubscribe = null;

const orderInput = document.getElementById("orderInput");
const scanMessage = document.getElementById("scanMessage");
const cancelledInput = document.getElementById("cancelledInput");
const cancelledCount = document.getElementById("cancelledCount");
const saveCancelledBtn = document.getElementById("saveCancelledBtn");
const clearCancelledBtn = document.getElementById("clearCancelledBtn");

const singleDate = document.getElementById("singleDate");
const fromDate = document.getElementById("fromDate");
const toDate = document.getElementById("toDate");
const applyFilterBtn = document.getElementById("applyFilterBtn");
const resetFilterBtn = document.getElementById("resetFilterBtn");
const filterInfo = document.getElementById("filterInfo");

const totalOrders = document.getElementById("totalOrders");
const validOrders = document.getElementById("validOrders");
const cancelledOrders = document.getElementById("cancelledOrders");
const duplicateOrders = document.getElementById("duplicateOrders");
const carrierTableBody = document.getElementById("carrierTableBody");
const todayScannedBody = document.getElementById("todayScannedBody");

const historyDates = document.getElementById("historyDates");
const historyTitle = document.getElementById("historyTitle");
const historyDetailBody = document.getElementById("historyDetailBody");
const exportSelectedDateBtn = document.getElementById("exportSelectedDateBtn");
const pageTabs = document.querySelectorAll(".page-tab");
const appPages = document.querySelectorAll(".app-page");

init();

async function init() {
  singleDate.value = todayStr();
  loadCancelledToTextarea();
  bindEvents();
  switchPage("scanPage");
  initDataSource();
  bindRealtimeListeners();
  renderAll();
}

function bindEvents() {
  pageTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchPage(tab.dataset.page));
  });

  orderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(orderInput.value.trim());
      orderInput.value = "";
      focusOrderInput();
    }
  });

  saveCancelledBtn.addEventListener("click", async () => {
    const lines = normalizeCodes(cancelledInput.value);
    await saveCancelledSet(lines);
    await loadCancelledToTextarea();
    showMessage("Danh sách đơn hủy đã lưu", "warning");
    playTone("warning");
  });

  clearCancelledBtn.addEventListener("click", async () => {
    await saveCancelledSet([]);
    await loadCancelledToTextarea();
    showMessage("Đã xóa danh sách đơn hủy", "warning");
    playTone("warning");
  });

  applyFilterBtn.addEventListener("click", () => {
    const s = singleDate.value;
    const f = fromDate.value;
    const t = toDate.value;
    if (f && t) {
      currentFilter = { mode: "range", singleDate: "", fromDate: f, toDate: t };
    } else {
      currentFilter = { mode: "single", singleDate: s || todayStr(), fromDate: "", toDate: "" };
    }
    void renderAll();
  });

  resetFilterBtn.addEventListener("click", () => {
    singleDate.value = todayStr();
    fromDate.value = "";
    toDate.value = "";
    currentFilter = { mode: "single", singleDate: todayStr(), fromDate: "", toDate: "" };
    void renderAll();
  });

  exportSelectedDateBtn.addEventListener("click", async () => {
    if (!selectedHistoryDate) {
      alert("Vui lòng chọn ngày trong History.");
      return;
    }
    const dayOrders = await getDayOrders(selectedHistoryDate);
    exportOrdersToExcel(dayOrders, `orders_${selectedHistoryDate}.xlsx`);
  });
}

async function handleScan(code) {
  if (!code) return;
  const date = todayStr();
  const now = new Date().toISOString();
  const carrier = detectCarrier(code);
  const canceledSet = await getCancelledSet();
  const dayOrders = await getDayOrders(date);

  let status;
  if (canceledSet.has(code)) {
    status = STATUS.CANCELED;
    showMessage("❌ DON HUY - KHONG DUOC XU LY", "error");
    playTone("error");
  } else if (dayOrders.some((o) => o.code === code)) {
    status = STATUS.DUPLICATE;
    showMessage("⚠️ DA QUET TRUOC DO", "warning");
    playTone("warning");
  } else {
    status = STATUS.SUCCESS;
    showMessage(`✅ QUET THANH CONG\nMa: ${code}\nDVVC: ${carrier}`, "success");
    playTone("success");
  }

  await addOrder(date, { code, status, carrier, time: now });
  await renderAll();
}

function detectCarrier(code) {
  if (code.startsWith("8")) return "J&T";
  if (code.startsWith("SPX")) return "Shopee Express";
  if (code.startsWith("G")) return "GHN";
  if (code.startsWith("VTP")) return "Viettel Post";
  return "Khac";
}

async function renderAll() {
  const filteredOrders = await getOrdersByFilter(currentFilter);
  const todayOrders = await getDayOrders(todayStr());

  renderFilterInfo();
  renderMetrics(filteredOrders);
  renderCarrierTable(filteredOrders);
  renderChart(filteredOrders);
  renderTodayList(todayOrders);
  await renderHistoryDates();
  await renderHistoryDetails();
  await loadCancelledCount();
  if (activePage === "scanPage") {
    focusOrderInput();
  }
}

function switchPage(pageId) {
  activePage = pageId;
  appPages.forEach((page) => page.classList.toggle("active", page.id === pageId));
  pageTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.page === pageId));
  if (activePage === "scanPage") {
    focusOrderInput();
  }
}

function renderFilterInfo() {
  if (currentFilter.mode === "range") {
    filterInfo.textContent = `Dang loc tu ${currentFilter.fromDate} den ${currentFilter.toDate}`;
  } else {
    filterInfo.textContent = `Dang xem ngay: ${currentFilter.singleDate}`;
  }
}

function renderMetrics(orders) {
  totalOrders.textContent = String(orders.length);
  validOrders.textContent = String(orders.filter((o) => o.status === STATUS.SUCCESS).length);
  cancelledOrders.textContent = String(orders.filter((o) => o.status === STATUS.CANCELED).length);
  duplicateOrders.textContent = String(orders.filter((o) => o.status === STATUS.DUPLICATE).length);
}

function renderCarrierTable(orders) {
  const map = groupByCarrier(orders.filter((o) => o.status === STATUS.SUCCESS));
  const carriers = ["J&T", "Shopee Express", "GHN", "Viettel Post", "Khac"];
  carrierTableBody.innerHTML = "";
  carriers.forEach((carrier) => {
    const list = map[carrier] || [];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${carrier}</td>
      <td>${list.length}</td>
      <td><button data-carrier="${carrier}" class="export-carrier-btn">Tai danh sach</button></td>
    `;
    carrierTableBody.appendChild(tr);
  });

  document.querySelectorAll(".export-carrier-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const carrier = btn.dataset.carrier;
      const list = map[carrier] || [];
      exportOrdersToExcel(list, `orders_${carrier.replace(/\s+/g, "_")}.xlsx`);
    });
  });
}

function renderChart(orders) {
  const map = groupByCarrier(orders.filter((o) => o.status === STATUS.SUCCESS));
  const labels = ["J&T", "Shopee Express", "GHN", "Viettel Post", "Khac"];
  const data = labels.map((k) => (map[k] || []).length);
  const ctx = document.getElementById("carrierChart");

  if (carrierChart) {
    carrierChart.destroy();
  }

  carrierChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "So luong don hop le",
        data,
        backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#64748b"],
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    },
  });
}

function renderTodayList(orders) {
  todayScannedBody.innerHTML = "";
  orders.slice().reverse().forEach((o) => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `
      <td>${formatTime(o.time)}</td>
      <td>${o.code}</td>
      <td>${o.carrier}</td>
      <td>${statusLabel[o.status]}</td>
    `;
    todayScannedBody.appendChild(tr);
  });
}

function renderHistoryDates() {
  const dates = await getAllDates();
  historyDates.innerHTML = "";
  dates.forEach((d) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = d;
    if (selectedHistoryDate === d) btn.classList.add("active");
    btn.addEventListener("click", () => {
      selectedHistoryDate = d;
      void renderHistoryDates();
      void renderHistoryDetails();
    });
    li.appendChild(btn);
    historyDates.appendChild(li);
  });
}

async function renderHistoryDetails() {
  historyDetailBody.innerHTML = "";
  if (!selectedHistoryDate) {
    historyTitle.textContent = "Chua chon ngay";
    return;
  }
  const orders = await getDayOrders(selectedHistoryDate);
  historyTitle.textContent = `Chi tiet ngay ${selectedHistoryDate}`;
  orders.forEach((o) => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `
      <td>${formatTime(o.time)}</td>
      <td>${o.code}</td>
      <td>${o.carrier}</td>
      <td>${statusLabel[o.status]}</td>
    `;
    historyDetailBody.appendChild(tr);
  });
}

function exportOrdersToExcel(orders, fileName) {
  if (!orders.length) {
    alert("Khong co du lieu de xuat.");
    return;
  }
  const rows = orders.map((o) => ({
    "Order Code": o.code,
    "Carrier": o.carrier,
    "Time": formatTime(o.time),
    "Status": statusLabel[o.status],
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  XLSX.writeFile(wb, fileName);
}

function groupByCarrier(orders) {
  return orders.reduce((acc, o) => {
    if (!acc[o.carrier]) acc[o.carrier] = [];
    acc[o.carrier].push(o);
    return acc;
  }, {});
}

async function getOrdersByFilter(filter) {
  const dates = await getAllDates();
  let selectedDates = [];
  if (filter.mode === "range" && filter.fromDate && filter.toDate) {
    selectedDates = dates.filter((d) => d >= filter.fromDate && d <= filter.toDate);
  } else {
    selectedDates = dates.filter((d) => d === filter.singleDate);
  }
  const grouped = await Promise.all(selectedDates.map((d) => getDayOrders(d)));
  return grouped.flat();
}

async function getDayOrders(date) {
  if (!useCloud) {
    const all = getAllData();
    return all[date]?.orders || [];
  }
  const snap = await db.collection("days").doc(date).collection("orders").orderBy("time", "asc").get();
  return snap.docs.map((doc) => doc.data());
}

function getAllData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveAllData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

async function getCancelledSet() {
  if (!useCloud) {
    const raw = localStorage.getItem(CANCELED_KEY);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      return new Set(arr);
    } catch (e) {
      return new Set();
    }
  }
  return cloudCancelledSet;
}

async function saveCancelledSet(list) {
  const unique = [...new Set(list)];
  if (!useCloud) {
    localStorage.setItem(CANCELED_KEY, JSON.stringify(unique));
    return;
  }
  await db.collection("configs").doc("cancelledOrders").set({
    codes: unique,
    updatedAt: new Date().toISOString(),
  });
}

async function loadCancelledToTextarea() {
  const set = [...(await getCancelledSet())];
  cancelledInput.value = set.join("\n");
  await loadCancelledCount();
}

async function loadCancelledCount() {
  cancelledCount.textContent = String((await getCancelledSet()).size);
}

function normalizeCodes(text) {
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function showMessage(text, type) {
  scanMessage.className = "message";
  scanMessage.classList.add(type);
  scanMessage.textContent = text;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("vi-VN");
}

function focusOrderInput() {
  setTimeout(() => orderInput.focus(), 0);
}

function initDataSource() {
  if (!window.firebase) return;
  const hasConfig = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.appId;
  if (!hasConfig) return;
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
  useCloud = true;
}

function bindRealtimeListeners() {
  if (!useCloud) return;
  const today = todayStr();

  currentDayUnsubscribe = db.collection("days").doc(today).collection("orders").onSnapshot(() => {
    void renderAll();
  });

  daysUnsubscribe = db.collection("days").onSnapshot(() => {
    void renderAll();
  });

  db.collection("configs").doc("cancelledOrders").onSnapshot((doc) => {
    const data = doc.data() || {};
    cloudCancelledSet = new Set(data.codes || []);
    cancelledInput.value = [...cloudCancelledSet].join("\n");
    cancelledCount.textContent = String(cloudCancelledSet.size);
  });
}

async function addOrder(date, order) {
  if (!useCloud) {
    const all = getAllData();
    const day = all[date] || { date, orders: [] };
    day.orders.push(order);
    all[date] = day;
    saveAllData(all);
    return;
  }
  await db.collection("days").doc(date).set({ date, updatedAt: new Date().toISOString() }, { merge: true });
  await db.collection("days").doc(date).collection("orders").add(order);
}

async function getAllDates() {
  if (!useCloud) {
    return Object.keys(getAllData()).sort((a, b) => (a > b ? -1 : 1));
  }
  const snap = await db.collection("days").get();
  return snap.docs.map((d) => d.id).sort((a, b) => (a > b ? -1 : 1));
}

function playTone(kind) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);

  if (kind === "success") oscillator.frequency.value = 880;
  else if (kind === "warning") oscillator.frequency.value = 500;
  else oscillator.frequency.value = 220;

  oscillator.type = "sine";
  gainNode.gain.value = 0.08;
  oscillator.start();
  oscillator.stop(context.currentTime + 0.08);
}
