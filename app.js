// === 1. KHỞI TẠO FIREBASE ===
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, onValue, get } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCTuFzKXtKcsgKrY_IjjGjXoiiPZRqn2o",
  authDomain: "quanlykho1-b89e1.firebaseapp.com",
  projectId: "quanlykho1-b89e1",
  storageBucket: "quanlykho1-b89e1.firebasestorage.app",
  messagingSenderId: "522347757177",
  appId: "1:522347757177:web:69b51d3332f7141264dea8",
  measurementId: "G-VTM2YPZCB4",
  databaseURL: "https://quanlykho1-b89e1-default-rtdb.asia-southeast1.firebasedatabase.app"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// === 2. CẤU HÌNH ===
const FIREBASE_SCAN_KEY = "warehouse_scan_data_v1";
const CANCELED_KEY = "warehouse_cancelled_orders_v1";
const ACTIVE_BATCH_KEY = "warehouse_active_batches_v2";
const CLOSED_BATCH_KEY = "warehouse_closed_batches_v1";

// IndexedDB — lưu đơn hàng không giới hạn dung lượng
const IDB_NAME = "warehouse_db";
const IDB_STORE = "scan_data";

const STATUS = { SUCCESS: "SUCCESS", DUPLICATE: "DUPLICATE", CANCELED: "CANCELED" };
const statusLabel = { [STATUS.SUCCESS]: "THÀNH CÔNG", [STATUS.DUPLICATE]: "ĐƠN TRÙNG", [STATUS.CANCELED]: "ĐƠN HỦY" };
const statusClass = { [STATUS.SUCCESS]: "row-success", [STATUS.DUPLICATE]: "row-warning", [STATUS.CANCELED]: "row-error" };

let currentFilter = { mode: "single", singleDate: todayStr() };
let carrierChart = null;
let activePage = "scanPage";
let showAllTodayOrders = false;

// Cache trong RAM — toàn bộ code đọc từ đây (sync), ghi xuống IDB + Firebase (async)
let scanDataCache = {};
let activeBatches = {};
let closedBatches = JSON.parse(localStorage.getItem(CLOSED_BATCH_KEY)) || [];

// DOM Elements
const orderInput = document.getElementById("orderInput");
const scanMessage = document.getElementById("scanMessage");
const cancelledInput = document.getElementById("cancelledInput");
const cancelledCount = document.getElementById("cancelledCount");
const totalOrders = document.getElementById("totalOrders");
const validOrders = document.getElementById("validOrders");
const cancelledOrders = document.getElementById("cancelledOrders");
const duplicateOrders = document.getElementById("duplicateOrders");
const historyTitle = document.getElementById("historyTitle");
const historyDetailBody = document.getElementById("historyDetailBody");
const historyDatePicker = document.getElementById("historyDatePicker");
const historySearchInput = document.getElementById("historySearchInput");

// === 3. INDEXEDDB WRAPPER ===
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: "date" });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbLoadAll() {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
    req.onsuccess = () => {
      scanDataCache = {};
      req.result.forEach(item => { scanDataCache[item.date] = item; });
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbSaveDay(dayData) {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(dayData);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDeleteOld(keepDays) {
  const idb = await openIDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.key < cutoffStr) cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// === 4. KHỞI CHẠY ===
init();

async function init() {
  // Xóa dữ liệu cũ khỏi localStorage (đã chuyển sang IndexedDB) để Firebase có chỗ lưu trạng thái kết nối
  localStorage.removeItem("warehouse_scan_data_v1");
  localStorage.removeItem("warehouse_active_batches_v1");

  document.getElementById("singleDate").value = todayStr();
  loadCancelledToTextarea();
  bindEvents();
  switchPage("scanPage");

  // 1. Load từ IndexedDB trước (nhanh, không cần mạng)
  await idbLoadAll();
  // 2. Xóa dữ liệu cũ hơn 30 ngày
  await idbDeleteOld(120);

  // 3. Tải 7 ngày gần nhất từ Firebase (đồng bộ dữ liệu các máy khác)
  try {
    const last7Days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      last7Days.push(d.toISOString().slice(0, 10));
    }
    const results = await Promise.all(last7Days.map(date => get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`))));
    results.forEach((snapshot, i) => {
      const date = last7Days[i];
      const localDay = scanDataCache[date];
      const firebaseDay = snapshot.exists() ? snapshot.val() : null;
      const localCount = localDay?.orders?.length || 0;
      const firebaseCount = firebaseDay?.orders?.length || 0;

      if (firebaseCount > localCount) {
        scanDataCache[date] = firebaseDay;
        idbSaveDay(firebaseDay);
      } else if (localCount > firebaseCount && localDay) {
        set(ref(db, `${FIREBASE_SCAN_KEY}/${date}`), localDay);
      }
    });
  } catch (err) {
    console.error("Lỗi tải Firebase:", err);
  }

  renderAll();
  renderBatches();

  onValue(ref(db, CANCELED_KEY), (snapshot) => {
    const data = snapshot.val();
    if (data) {
      localStorage.setItem(CANCELED_KEY, JSON.stringify(data));
      loadCancelledToTextarea();
    }
  });

  onValue(ref(db, CLOSED_BATCH_KEY), (snapshot) => {
    const data = snapshot.val();
    if (data) {
      closedBatches = data;
      localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(data));
    }
  });

  onValue(ref(db, ACTIVE_BATCH_KEY), (snapshot) => {
    console.log("🔄 Xe sync:", snapshot.val());
    activeBatches = snapshot.val() || {};
    renderBatches();
  }, (err) => console.error("❌ Lỗi sync xe:", err));
}

// === 5. SỰ KIỆN ===
function bindEvents() {
  document.querySelectorAll(".page-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchPage(tab.dataset.page));
  });

  const createBatchBtn = document.getElementById("createBatchBtn");
  if (createBatchBtn) {
    createBatchBtn.addEventListener("click", () => {
      const carrier = document.getElementById("batchCarrier").value;
      const name = document.getElementById("batchName").value.trim();
      if (!name) return alert("Vui lòng nhập tên xe/lô!");
      if (activeBatches[carrier]) return alert(`Đang có xe [${activeBatches[carrier].id}] mở cho [${carrier}] rồi! Vui lòng CHỐT XE trước khi tạo mới.`);
      const nameUsed = Object.values(activeBatches).some(b => b.id === name) || closedBatches.some(b => b.id === name);
      if (nameUsed) return alert(`Tên xe [${name}] đã được dùng trước đó! Vui lòng đặt tên khác.`);
      set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), { id: name, count: 0, createdDate: todayStr() })
        .catch(err => console.error("Lỗi tạo xe:", err));
      document.getElementById("batchName").value = "";
      focusOrderInput();
    });
  }

  document.getElementById("singleDate")?.addEventListener("change", () => renderAll());

  orderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(orderInput.value.trim());
      orderInput.value = "";
      focusOrderInput();
    }
  });

  document.getElementById("saveCancelledBtn").addEventListener("click", () => {
    saveCancelledSet(normalizeCodes(cancelledInput.value));
    showMessage("Đã lưu danh sách đơn hủy", "warning");
    playTone("warning");
  });

  document.getElementById("clearCancelledBtn")?.addEventListener("click", () => {
    if (confirm("⚠️ Bạn có chắc chắn muốn xóa TOÀN BỘ danh sách đơn hủy không?")) {
      cancelledInput.value = "";
      saveCancelledSet([]);
      showMessage("Đã xóa sạch danh sách đơn hủy", "success");
    }
  });

  document.getElementById("applyFilterBtn")?.addEventListener("click", () => {
    const f = document.getElementById("fromDate").value;
    const t = document.getElementById("toDate").value;
    if (f && t) { currentFilter = { mode: "range", fromDate: f, toDate: t }; renderAll(); }
    else alert("Vui lòng chọn cả Từ ngày và Đến ngày!");
  });

  document.getElementById("resetFilterBtn")?.addEventListener("click", () => {
    const today = todayStr();
    document.getElementById("singleDate").value = today;
    document.getElementById("fromDate").value = "";
    document.getElementById("toDate").value = "";
    currentFilter = { mode: "single", singleDate: today };
    renderAll();
  });

  historyDatePicker?.addEventListener("change", async (e) => {
    const date = e.target.value;
    // Nếu ngày cũ hơn 7 ngày, thử tải từ Firebase
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    if (date < cutoff.toISOString().slice(0, 10) && !scanDataCache[date]) {
      try {
        const snapshot = await get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`));
        if (snapshot.exists()) {
          scanDataCache[date] = snapshot.val();
          idbSaveDay(snapshot.val());
        }
      } catch (err) { console.error("Lỗi tải ngày cũ:", err); }
    }
    renderHistoryTable(getDayOrders(date), `Lịch sử ngày ${date}`);
    renderClosedBatches(date);
  });

  historySearchInput?.addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase().trim();
    if (term.length > 0 && term.length < 3) return;
    let results = [];
    Object.keys(scanDataCache).forEach(date => {
      results = results.concat(scanDataCache[date].orders.filter(o => o.code.toLowerCase().includes(term)));
    });
    renderHistoryTable(results, term ? `Kết quả tìm kiếm: ${term}` : "Vui lòng chọn ngày");
  });

  document.getElementById("exportSelectedDateBtn").onclick = () => {
    const rows = [];
    document.querySelectorAll("#historyDetailBody tr").forEach(tr => {
      const tds = tr.querySelectorAll("td");
      if (tds.length > 0) rows.push({ "Thời gian": tds[0].innerText, "Mã đơn": tds[1].innerText, "DVVC": tds[2].innerText, "Trạng thái": tds[3].innerText });
    });
    exportOrdersToExcel(rows, "bao_cao_kho_tong.xlsx");
  };
}

// === 6. QUÉT MÃ ===
function handleScan(code) {
  if (!code) return;
  const date = todayStr();
  const now = new Date().toISOString();
  const carrier = detectCarrier(code);
  const canceledSet = getCancelledSet();

  const activeBatch = activeBatches[carrier];

  if (!canceledSet.has(code) && !activeBatch) {
    showMessage(`❌ CHƯA TẠO XE CHO [${carrier.toUpperCase()}]`, "error");
    playTone("error");
    setTimeout(() => speak(`Chưa tạo xe ${carrier}`), 400);
    return;
  }

  const last5Days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last5Days.push(d.toISOString().slice(0, 10));
  }
  const isDuplicateIn5Days = last5Days.some(dStr => {
    const dayData = scanDataCache[dStr];
    return dayData && dayData.orders.some(o => o.code === code && o.status === STATUS.SUCCESS);
  });

  const day = scanDataCache[date] || { date, orders: [] };
  let status;

  if (canceledSet.has(code)) {
    status = STATUS.CANCELED;
    showMessage("❌ ĐƠN HỦY - DỪNG LẠI", "error");
    playTone("error");
    setTimeout(() => speak("Đơn hủy"), 400);
  } else if (isDuplicateIn5Days) {
    status = STATUS.DUPLICATE;
    showMessage("⚠️ TRÙNG ĐƠN (Trong 5 ngày qua)", "warning");
    playTone("warning");
    setTimeout(() => speak("Đơn trùng"), 400);
  } else {
    status = STATUS.SUCCESS;
    activeBatch.count++;
    set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}/count`), activeBatch.count);
    renderBatches();
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success");
  }

  day.orders.push({ code, status, carrier, time: now, batchId: activeBatch ? activeBatch.id : "" });
  scanDataCache[date] = day;
  saveAllData(date, day);
  renderAll();
}

// === 7. RENDER ===
function renderAll() {
  const selectedDate = document.getElementById("singleDate").value || todayStr();
  currentFilter.singleDate = selectedDate;
  const filteredOrders = getOrdersByFilter(currentFilter);

  totalOrders.textContent = filteredOrders.length;
  validOrders.textContent = filteredOrders.filter(o => o.status === STATUS.SUCCESS).length;

  const cOrders = filteredOrders.filter(o => o.status === STATUS.CANCELED);
  cancelledOrders.textContent = cOrders.length;

  const dOrders = filteredOrders.filter(o => o.status === STATUS.DUPLICATE);
  duplicateOrders.textContent = dOrders.length;

  cancelledOrders.parentElement.onclick = () => {
    switchPage("historyPage");
    renderHistoryTable(cOrders, `Danh sách ĐƠN HỦY ngày ${currentFilter.singleDate}`);
  };
  duplicateOrders.parentElement.onclick = () => {
    switchPage("historyPage");
    renderHistoryTable(dOrders, `Danh sách ĐƠN TRÙNG ngày ${currentFilter.singleDate}`);
  };

  renderCarrierTable(filteredOrders);
  renderChart(filteredOrders);
  renderTodayList(getDayOrders(todayStr()));
  loadCancelledCount();
  if (activePage === "scanPage") focusOrderInput();
}

function renderTodayList(orders) {
  const body = document.getElementById("todayScannedBody");
  const btn = document.getElementById("loadMoreTodayBtn");
  if (!body) return;
  body.innerHTML = "";
  const reversed = [...orders].reverse();
  const limit = showAllTodayOrders ? reversed.length : 100;
  reversed.slice(0, limit).forEach(o => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${statusLabel[o.status]}</td>`;
    body.appendChild(tr);
  });
  if (btn) {
    if (reversed.length > 100 && !showAllTodayOrders) {
      btn.style.display = "block";
      btn.textContent = `⬇️ Xem tất cả (Còn ẩn ${reversed.length - 100} đơn)`;
      btn.onclick = () => { showAllTodayOrders = true; renderTodayList(orders); };
    } else {
      btn.style.display = "none";
    }
  }
}

function renderBatches() {
  const body = document.getElementById("activeBatchesBody");
  if (!body) return;
  body.innerHTML = "";
  const keys = Object.keys(activeBatches);
  if (keys.length === 0) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;">Chưa có xe</td></tr>`;
    return;
  }
  keys.forEach(carrier => {
    const batch = activeBatches[carrier];
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.innerHTML = `<strong style="color:blue;">${batch.id}</strong><br><span style="font-size:13px;">${carrier}</span>`;

    const tdCount = document.createElement("td");
    tdCount.style.cssText = "font-size:18px;color:#e11d48;font-weight:bold;";
    const fromDate = batch.createdDate || todayStr();
    const realCount = Object.values(scanDataCache)
      .filter(day => day.date >= fromDate)
      .flatMap(day => day.orders || [])
      .filter(o => o.batchId === batch.id && o.carrier === carrier && o.status === STATUS.SUCCESS)
      .length;
    tdCount.textContent = realCount;

    const tdAction = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "✅ Chốt";
    btn.style.cssText = "background:#10b981;color:white;padding:6px 10px;border:none;border-radius:4px;cursor:pointer;";
    btn.onclick = () => closeBatch(carrier);
    tdAction.appendChild(btn);

    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tr.appendChild(tdAction);
    body.appendChild(tr);
  });
}

window.closeBatch = function(carrier) {
  const batch = activeBatches[carrier];
  if (!batch) return;
  if (!confirm(`Bạn có chắc chắn muốn CHỐT xe [${batch.id}] của [${carrier}] không?`)) return;

  closedBatches.push({ id: batch.id, carrier, count: batch.count, date: todayStr() });
  localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
  set(ref(db, CLOSED_BATCH_KEY), closedBatches);
  set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), null);

  const historyDate = document.getElementById("historyDatePicker");
  if (historyDate?.value === todayStr()) renderClosedBatches(todayStr());
  focusOrderInput();
}

function renderClosedBatches(dateStr) {
  const body = document.getElementById("closedBatchesBody");
  if (!body) return;
  const batchesForDate = closedBatches.filter(b => b.date === dateStr);
  body.innerHTML = "";
  if (batchesForDate.length === 0) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;">Không có xe nào được chốt trong ngày này</td></tr>`;
    return;
  }
  const allOrders = scanDataCache[dateStr]?.orders || [];
  [...batchesForDate].reverse().forEach(b => {
    const exactCount = allOrders.filter(o => o.batchId === b.id && o.carrier === b.carrier && o.status === STATUS.SUCCESS).length;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${b.carrier}</strong></td>
      <td style="color:blue;font-weight:bold;">${b.id}</td>
      <td style="font-size:16px;font-weight:bold;color:#10b981;">${exactCount} <span style="font-size:12px;color:#64748b;font-weight:normal;">(Khớp Excel)</span></td>
      <td><button onclick="downloadBatch('${b.id}','${b.carrier}','${b.date}')" style="background:#3b82f6;color:white;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;">📥 Tải File Xe Này</button></td>
    `;
    body.appendChild(tr);
  });
}

window.downloadBatch = function(batchId, carrier, dateStr) {
  const allOrders = scanDataCache[dateStr]?.orders || [];
  const batchOrders = allOrders.filter(o => o.batchId === batchId && o.carrier === carrier && o.status === STATUS.SUCCESS);
  if (batchOrders.length > 0) {
    exportOrdersToExcel(batchOrders.map(o => ({ "Lô/Xe": o.batchId, "Thời gian": formatTime(o.time), "Mã đơn": o.code, "DVVC": o.carrier })), `BanGiao_${carrier}_${batchId}_${dateStr}.xlsx`);
  } else {
    alert("Lỗi: Không tìm thấy dữ liệu đơn hàng cho xe này!");
  }
}

function renderHistoryTable(orders, title) {
  historyDetailBody.innerHTML = "";
  historyTitle.innerHTML = `${title} <br> <span style="color:#ee4d2d;font-size:20px;font-weight:bold;">📊 TỔNG CỘNG: ${orders.length} ĐƠN</span>`;
  [...orders].reverse().forEach(o => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${statusLabel[o.status]}</td>`;
    historyDetailBody.appendChild(tr);
  });
}

function renderChart(orders) {
  const successMap = groupByCarrier(orders.filter(o => o.status === STATUS.SUCCESS));
  const labels = ["J&T", "Shopee", "GHN", "VTP", "Khác", "ĐƠN HỦY", "ĐƠN TRÙNG"];
  const data = [
    (successMap["J&T"] || []).length, (successMap["Shopee Express"] || []).length,
    (successMap["GHN"] || []).length, (successMap["Viettel Post"] || []).length,
    (successMap["Khac"] || []).length,
    orders.filter(o => o.status === STATUS.CANCELED).length,
    orders.filter(o => o.status === STATUS.DUPLICATE).length
  ];
  const ctx = document.getElementById("carrierChart");
  if (carrierChart) carrierChart.destroy();
  carrierChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label: "Số lượng", data, backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#64748b", "#ef4444", "#eab308"] }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

// === 8. HÀM HỖ TRỢ ===
function getAllData() { return scanDataCache; }

function saveAllData(date, dayData) {
  idbSaveDay(dayData);
  set(ref(db, `${FIREBASE_SCAN_KEY}/${date}`), dayData);
}

function getDayOrders(date) { return scanDataCache[date]?.orders || []; }

function getOrdersByFilter(filter) {
  const dates = Object.keys(scanDataCache);
  let selectedDates = filter.mode === "range" && filter.fromDate && filter.toDate
    ? dates.filter(d => d >= filter.fromDate && d <= filter.toDate)
    : dates.filter(d => d === filter.singleDate);
  return selectedDates.flatMap(d => scanDataCache[d].orders || []);
}

function detectCarrier(code) {
  if (code.startsWith("8")) return "J&T";
  if (code.startsWith("SPX")) return "Shopee Express";
  if (code.startsWith("G")) return "GHN";
  if (code.startsWith("VTP")) return "Viettel Post";
  return "Khac";
}

function switchPage(pageId) {
  document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("active", p.id === pageId));
  document.querySelectorAll(".page-tab").forEach(t => t.classList.toggle("active", t.dataset.page === pageId));
  if (pageId === "scanPage") focusOrderInput();
}

function exportOrdersToExcel(data, fileName) {
  if (!data.length) return alert("Không có dữ liệu để xuất!");
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Báo cáo");
  XLSX.writeFile(wb, fileName);
}

function groupByCarrier(orders) {
  return orders.reduce((acc, o) => { acc[o.carrier] = acc[o.carrier] || []; acc[o.carrier].push(o); return acc; }, {});
}

function getCancelledSet() { return new Set(JSON.parse(localStorage.getItem(CANCELED_KEY)) || []); }
function saveCancelledSet(list) { const unique = [...new Set(list)]; localStorage.setItem(CANCELED_KEY, JSON.stringify(unique)); set(ref(db, CANCELED_KEY), unique); }
function loadCancelledToTextarea() { cancelledInput.value = [...getCancelledSet()].join("\n"); loadCancelledCount(); }
function loadCancelledCount() { cancelledCount.textContent = getCancelledSet().size; }
function normalizeCodes(text) { return text.split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
function showMessage(text, type) { scanMessage.className = `message ${type}`; scanMessage.textContent = text; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function formatTime(iso) { return new Date(iso).toLocaleString("vi-VN"); }
function focusOrderInput() { setTimeout(() => orderInput.focus(), 0); }

function playTone(kind) {
  const urls = { warning: "https://assets.mixkit.co/active_storage/sfx/950/950-preview.mp3", error: "https://assets.mixkit.co/active_storage/sfx/997/997-preview.mp3" };
  if (urls[kind]) new Audio(urls[kind]).play().catch(() => {});
}

function speak(text) {
  if ('speechSynthesis' in window) {
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'vi-VN'; msg.rate = 1.1;
    window.speechSynthesis.speak(msg);
  }
}

function renderCarrierTable(orders) {
  const map = groupByCarrier(orders.filter(o => o.status === STATUS.SUCCESS));
  const carriers = ["J&T", "Shopee Express", "GHN", "Viettel Post", "Khac"];
  const body = document.getElementById("carrierTableBody");
  body.innerHTML = "";
  carriers.forEach(c => {
    const list = map[c] || [];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${c}</td><td>${list.length}</td><td><button class="export-carrier-btn" data-carrier="${c}">Tải đơn tổng</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll(".export-carrier-btn").forEach(btn => {
    btn.onclick = () => {
      const list = map[btn.dataset.carrier] || [];
      exportOrdersToExcel(list.map(o => ({ "Mã đơn": o.code, "Thời gian": formatTime(o.time) })), `don_tong_${btn.dataset.carrier}.xlsx`);
    };
  });
}
