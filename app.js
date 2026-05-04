// === 1. KHỞI TẠO FIREBASE ===
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, push, onValue, get } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

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
const ACTIVE_BATCH_LOCAL_KEY = "warehouse_active_batches_local";
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
let activeBatches = JSON.parse(localStorage.getItem(ACTIVE_BATCH_LOCAL_KEY)) || {};
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
let idbInstance = null;

function openIDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: "date" });
    };
    req.onsuccess = e => { idbInstance = e.target.result; resolve(idbInstance); };
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
  const cutoffStr = localDateStr(cutoff);
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
  // 2. Xóa dữ liệu cũ hơn 120 ngày
  await idbDeleteOld(120);
  // 2b. Đặt lịch reset ngày lúc 00:00 (đổi listener Firebase, reset filter)
  scheduleMidnightReset();

  // 3. Chỉ fetch ngày chưa có trong IDB (hôm nay do onValue lo, bỏ qua)
  try {
    const missingDays = [];
    for (let i = 1; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = localDateStr(d);
      if (!scanDataCache[dateStr]) missingDays.push(dateStr);
    }
    if (missingDays.length > 0) {
      const results = await Promise.all(missingDays.map(date => get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`))));
      results.forEach((snapshot, i) => {
        if (snapshot.exists()) {
          const day = firebaseDayToLocal(snapshot.val(), missingDays[i]);
          scanDataCache[missingDays[i]] = day;
          idbSaveDay(day);
        }
      });
    }
  } catch (err) {
    console.error("Lỗi tải Firebase:", err);
  }

  renderAll();
  renderBatches();

  subscribeToTodayScan();

  onValue(ref(db, CANCELED_KEY), (snapshot) => {
    const data = snapshot.val();
    if (data) {
      localStorage.setItem(CANCELED_KEY, JSON.stringify(data));
      loadCancelledToTextarea();
    }
  });

  // Closed batches: chỉ THÊM từ Firebase, không bao giờ xóa entry local
  // Nếu thiết bị khác chốt xe → xóa khỏi activeBatches local
  onValue(ref(db, CLOSED_BATCH_KEY), (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    const fromFirebase = Array.isArray(data) ? data : Object.values(data);
    const localKeys = new Set(closedBatches.map(b => `${b.id}|${b.carrier}`));
    let addedClosed = false;
    let removedActive = false;
    fromFirebase.forEach(b => {
      if (!localKeys.has(`${b.id}|${b.carrier}`)) {
        closedBatches.push(b);
        addedClosed = true;
      }
      // Nếu xe đã chốt vẫn đang hiện trong activeBatches → xóa đi
      if (activeBatches[b.carrier]?.id === b.id) {
        delete activeBatches[b.carrier];
        removedActive = true;
      }
    });
    if (addedClosed) localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
    if (removedActive) localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
    if (addedClosed || removedActive) renderBatches();
  });

  // Active batches: chỉ THÊM xe mới từ Firebase (thiết bị khác tạo)
  // Không bao giờ xóa xe đang có local — chỉ closeBatch() mới được xóa
  onValue(ref(db, ACTIVE_BATCH_KEY), (snapshot) => {
    const firebaseBatches = snapshot.val() || {};
    const closedIds = new Set(closedBatches.map(b => b.id));
    let changed = false;
    Object.keys(firebaseBatches).forEach(carrier => {
      const batch = firebaseBatches[carrier];
      if (!activeBatches[carrier] && !closedIds.has(batch.id)) {
        activeBatches[carrier] = batch;
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      renderBatches();
    }
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
      const newBatch = { id: name, count: 0, createdDate: todayStr() };
      activeBatches[carrier] = newBatch;
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), newBatch)
        .catch(err => console.error("Lỗi tạo xe:", err));
      document.getElementById("batchName").value = "";
      renderBatches();
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
    if (date < localDateStr(cutoff) && !scanDataCache[date]) {
      try {
        const snapshot = await get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`));
        if (snapshot.exists()) {
          const day = firebaseDayToLocal(snapshot.val(), date);
          scanDataCache[date] = day;
          idbSaveDay(day);
        }
      } catch (err) { console.error("Lỗi tải ngày cũ:", err); }
    }
    renderHistoryTable(getDayOrders(date), `Lịch sử ngày ${date}`);
    renderClosedBatches(date);
  });

  historySearchInput?.addEventListener("input", (e) => {
    const raw = e.target.value.trim();
    if (!raw) {
      const date = historyDatePicker?.value;
      if (date) renderHistoryTable(getDayOrders(date), `Lịch sử ngày ${date}`);
      else renderHistoryTable([], "Vui lòng chọn ngày");
      return;
    }
    const terms = raw.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    if (terms.length === 0) return;
    let results = [];
    Object.keys(scanDataCache).forEach(date => {
      results = results.concat(scanDataCache[date].orders.filter(o => terms.some(t => o.code.toLowerCase().includes(t))));
    });
    renderHistoryTable(results, `Kết quả tìm kiếm: ${terms.join(", ")}`);
  });

  document.getElementById("selectAllBatches")?.addEventListener("change", (e) => {
    document.querySelectorAll(".batch-checkbox").forEach(cb => cb.checked = e.target.checked);
  });

  document.getElementById("downloadSelectedBatchesBtn")?.addEventListener("click", () => {
    const selected = [...document.querySelectorAll(".batch-checkbox:checked")];
    if (selected.length === 0) return alert("Vui lòng chọn ít nhất 1 xe!");
    const rows = [];
    selected.forEach(cb => {
      const { id, carrier, date, createddate } = cb.dataset;
      const fromDate = createddate || date;
      const orders = Object.values(scanDataCache)
        .filter(day => day.date >= fromDate && day.date <= date)
        .flatMap(day => day.orders || [])
        .filter(o => o.batchId === id && o.carrier === carrier && o.status === STATUS.SUCCESS);
      orders.forEach(o => rows.push({ "Lô/Xe": o.batchId, "DVVC": o.carrier, "Thời gian": formatTime(o.time), "Mã đơn": o.code }));
    });
    exportOrdersToExcel(rows, `BanGiao_NhieuXe_${todayStr()}.xlsx`);
  });

  document.getElementById("exportSelectedDateBtn").onclick = () => {
    const rows = [];
    document.querySelectorAll("#historyDetailBody tr").forEach(tr => {
      const tds = tr.querySelectorAll("td");
      if (tds.length > 0) rows.push({ "Thời gian": tds[0].innerText, "Mã đơn": tds[1].innerText, "DVVC": tds[2].innerText, "Lô/Xe": tds[3].innerText, "Trạng thái": tds[4].innerText });
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

  // Chặn quét nếu xe của carrier này chưa chốt từ ngày hôm trước
  if (activeBatch && activeBatch.createdDate && activeBatch.createdDate < date) {
    showMessage(`⚠️ XE [${activeBatch.id}] CỦA [${carrier}] CHƯA CHỐT TỪ NGÀY ${activeBatch.createdDate}\nVui lòng chốt xe này trước!`, "warning");
    playTone("error");
    return;
  }

  if (!canceledSet.has(code) && !activeBatch) {
    showMessage(`❌ CHƯA TẠO XE CHO [${carrier.toUpperCase()}]`, "error");
    playTone("error");
    setTimeout(() => speak(`Chưa tạo xe ${carrier}`), 400);
    return;
  }

  const last5Days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    last5Days.push(localDateStr(d));
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
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success");
    playTone("success");
  }

  const newOrder = { code, status, carrier, time: now, batchId: activeBatch ? activeBatch.id : "" };
  day.orders.push(newOrder);
  scanDataCache[date] = day;
  saveAllData(date, day, newOrder);
  renderAll();
  renderBatches();
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

  if (activePage === "dashboardPage") {
    renderCarrierTable(filteredOrders);
    renderChart(filteredOrders);
  }
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
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${o.batchId || '-'}</td><td>${statusLabel[o.status]}</td>`;
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

    const isStale = batch.createdDate && batch.createdDate < todayStr();
    if (isStale) tr.style.background = "#fff7ed";

    const tdName = document.createElement("td");
    tdName.innerHTML = isStale
      ? `<strong style="color:#dc2626;">${batch.id}</strong><br><span style="font-size:13px;color:#dc2626;">⚠️ ${carrier} — tạo ngày ${batch.createdDate}</span>`
      : `<strong style="color:blue;">${batch.id}</strong><br><span style="font-size:13px;">${carrier}</span>`;

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
  if (!batch) {
    alert(`Lỗi: Không tìm thấy xe cho [${carrier}]. Vui lòng tải lại trang.`);
    return;
  }
  if (!confirm(`Bạn có chắc chắn muốn CHỐT xe [${batch.id}] của [${carrier}] không?`)) return;

  const fromDate = batch.createdDate || todayStr();
  const realCount = Object.values(scanDataCache)
    .filter(day => day.date >= fromDate && day.date <= todayStr())
    .flatMap(day => day.orders || [])
    .filter(o => o.batchId === batch.id && o.carrier === carrier && o.status === STATUS.SUCCESS)
    .length;

  const closedEntry = { id: batch.id, carrier, count: realCount, date: todayStr(), createdDate: fromDate };

  // 1. Cập nhật local state ngay lập tức (TRƯỚC khi gọi Firebase)
  closedBatches = closedBatches.filter(b => !(b.id === batch.id && b.carrier === carrier));
  closedBatches.push(closedEntry);
  localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));

  delete activeBatches[carrier];
  localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));

  // 2. Cập nhật UI ngay lập tức (TRƯỚC khi gọi Firebase)
  renderBatches();
  const historyDate = document.getElementById("historyDatePicker");
  if (historyDate?.value === todayStr()) renderClosedBatches(todayStr());
  focusOrderInput();

  // 3. Đồng bộ Firebase async (không ảnh hưởng local đã chốt)
  setTimeout(() => {
    set(ref(db, CLOSED_BATCH_KEY), closedBatches).catch(err => console.error("Lỗi sync closed:", err));
    set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), null).catch(err => console.error("Lỗi xóa active:", err));
  }, 0);
}

function renderClosedBatches(dateStr) {
  const body = document.getElementById("closedBatchesBody");
  const downloadBtn = document.getElementById("downloadSelectedBatchesBtn");
  const selectAll = document.getElementById("selectAllBatches");
  if (!body) return;
  const batchesForDate = closedBatches.filter(b => b.date === dateStr);
  body.innerHTML = "";
  if (downloadBtn) downloadBtn.style.display = "none";
  if (selectAll) selectAll.checked = false;
  if (batchesForDate.length === 0) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;">Không có xe nào được chốt trong ngày này</td></tr>`;
    return;
  }
  if (downloadBtn) downloadBtn.style.display = "inline-block";
  [...batchesForDate].reverse().forEach(b => {
    const fromDate = b.createdDate || b.date;
    const exactCount = Object.values(scanDataCache)
      .filter(day => day.date >= fromDate && day.date <= b.date)
      .flatMap(day => day.orders || [])
      .filter(o => o.batchId === b.id && o.carrier === b.carrier && o.status === STATUS.SUCCESS).length;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="batch-checkbox" data-id="${b.id}" data-carrier="${b.carrier}" data-date="${b.date}" data-createddate="${b.createdDate || b.date}"></td>
      <td><strong>${b.carrier}</strong></td>
      <td style="color:blue;font-weight:bold;">${b.id}</td>
      <td style="font-size:16px;font-weight:bold;color:#10b981;">${exactCount} <span style="font-size:12px;color:#64748b;font-weight:normal;">(Khớp Excel)</span></td>
      <td style="white-space:nowrap;"></td>
    `;
    const actionTd = tr.lastElementChild;
    const dlBtn = document.createElement("button");
    dlBtn.textContent = "📥 Tải File Xe Này";
    dlBtn.style.cssText = "background:#3b82f6;color:white;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;margin-right:6px;";
    dlBtn.onclick = () => downloadBatch(b.id, b.carrier, b.date, b.createdDate || b.date);
    const pdfBtn = document.createElement("button");
    pdfBtn.textContent = "📄 Biên Bản";
    pdfBtn.style.cssText = "background:#7c3aed;color:white;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;";
    pdfBtn.onclick = () => exportBatchPDF(b.id, b.carrier, b.date, b.createdDate || b.date);
    actionTd.appendChild(dlBtn);
    actionTd.appendChild(pdfBtn);
    body.appendChild(tr);
  });
}

window.downloadBatch = function(batchId, carrier, dateStr, createdDate) {
  const fromDate = createdDate || dateStr;
  const batchOrders = Object.values(scanDataCache)
    .filter(day => day.date >= fromDate && day.date <= dateStr)
    .flatMap(day => day.orders || [])
    .filter(o => o.batchId === batchId && o.carrier === carrier && o.status === STATUS.SUCCESS);
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
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${o.batchId || '-'}</td><td>${statusLabel[o.status]}</td>`;
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
function firebaseDayToLocal(fbDay, date) {
  if (!fbDay) return null;
  const raw = fbDay.orders || {};
  const orders = Array.isArray(raw) ? raw : Object.values(raw);
  return { date: fbDay.date || date, orders };
}

function saveAllData(date, dayData, newOrder) {
  idbSaveDay(dayData);
  if (newOrder) {
    if (dayData.orders.length === 1) set(ref(db, `${FIREBASE_SCAN_KEY}/${date}/date`), date);
    push(ref(db, `${FIREBASE_SCAN_KEY}/${date}/orders`), newOrder);
  } else {
    set(ref(db, `${FIREBASE_SCAN_KEY}/${date}`), dayData);
  }
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
  activePage = pageId;
  document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("active", p.id === pageId));
  document.querySelectorAll(".page-tab").forEach(t => t.classList.toggle("active", t.dataset.page === pageId));
  if (pageId === "scanPage") focusOrderInput();
  if (pageId === "dashboardPage") renderAll();
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
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayStr() { return localDateStr(); }
function formatTime(iso) { return new Date(iso).toLocaleString("vi-VN"); }
function focusOrderInput() { setTimeout(() => orderInput.focus(), 0); }

const audioCache = {
  success: new Audio("di.wav"),
  warning: new Audio("dontrung.wav"),
  error: new Audio("donhuy.wav")
};

function playTone(kind) {
  const audio = audioCache[kind];
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

const utterance = ('speechSynthesis' in window) ? new SpeechSynthesisUtterance() : null;
if (utterance) { utterance.lang = 'vi-VN'; utterance.rate = 1.1; }

function speak(text) {
  if (!utterance) return;
  window.speechSynthesis.cancel();
  utterance.text = text;
  window.speechSynthesis.speak(utterance);
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

let unsubscribeTodayScan = null;

function subscribeToTodayScan() {
  if (unsubscribeTodayScan) unsubscribeTodayScan();
  unsubscribeTodayScan = onValue(ref(db, `${FIREBASE_SCAN_KEY}/${todayStr()}`), (snapshot) => {
    const localDay = scanDataCache[todayStr()];
    const localCount = localDay?.orders?.length || 0;
    const firebaseDay = snapshot.exists() ? firebaseDayToLocal(snapshot.val(), todayStr()) : null;
    const firebaseCount = firebaseDay?.orders?.length || 0;

    if (firebaseCount > localCount) {
      // Firebase nhiều hơn → kéo về (thiết bị khác quét hoặc vừa reconnect)
      scanDataCache[todayStr()] = firebaseDay;
      idbSaveDay(firebaseDay);
      renderBatches();
      renderTodayList(getDayOrders(todayStr()));
    } else if (localCount > firebaseCount && localDay) {
      // Local nhiều hơn → đẩy lên (đơn quét lúc offline chưa sync)
      set(ref(db, `${FIREBASE_SCAN_KEY}/${todayStr()}`), localDay)
        .catch(err => console.error("Lỗi đẩy đơn offline lên Firebase:", err));
    }
  });
}

function scheduleMidnightReset() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  setTimeout(() => {
    subscribeToTodayScan();
    const newDay = todayStr();
    document.getElementById("singleDate").value = newDay;
    currentFilter = { mode: "single", singleDate: newDay };
    showAllTodayOrders = false;
    scheduleMidnightReset();
  }, nextMidnight - now);
}

// === XUẤT BIÊN BẢN PDF ===
window.exportBatchPDF = function(batchId, carrier, dateStr, createdDate) {
  const fromDate = createdDate || dateStr;
  const orders = Object.values(scanDataCache)
    .filter(day => day.date >= fromDate && day.date <= dateStr)
    .flatMap(day => day.orders || [])
    .filter(o => o.batchId === batchId && o.carrier === carrier && o.status === STATUS.SUCCESS);
  if (orders.length === 0) { alert("Không có đơn hàng hợp lệ trong xe này!"); return; }

  const saved = JSON.parse(localStorage.getItem("pdf_shop_info") || "{}");
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `
    <div style="background:white;padding:24px;border-radius:12px;width:420px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <h3 style="margin:0 0 4px;font-size:16px;">📄 Xuất Biên Bản Bàn Giao</h3>
      <p style="margin:0 0 14px;font-size:13px;color:#888;">Xe: <b>${batchId}</b> &bull; ${carrier} &bull; ${dateStr} &bull; <b>${orders.length} đơn</b></p>
      <label style="font-size:12px;font-weight:bold;color:#555;display:block;margin-bottom:3px;">Tên Shop *</label>
      <input id="pdf-shop" type="text" value="${saved.shop || ""}" placeholder="Tên shop của bạn..."
        style="width:100%;padding:8px 10px;border:1.5px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px;margin-bottom:10px;">
      <label style="font-size:12px;font-weight:bold;color:#555;display:block;margin-bottom:3px;">Địa chỉ kho</label>
      <input id="pdf-addr" type="text" value="${saved.addr || ""}" placeholder="Địa chỉ..."
        style="width:100%;padding:8px 10px;border:1.5px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px;margin-bottom:10px;">
      <label style="font-size:12px;font-weight:bold;color:#555;display:block;margin-bottom:3px;">Điện thoại</label>
      <input id="pdf-phone" type="text" value="${saved.phone || ""}" placeholder="Số điện thoại..."
        style="width:100%;padding:8px 10px;border:1.5px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:14px;margin-bottom:16px;">
      <div style="display:flex;gap:8px;">
        <button id="pdf-cancel-btn" style="flex:1;padding:10px;border:1.5px solid #ddd;border-radius:6px;background:white;cursor:pointer;font-size:14px;">Hủy</button>
        <button id="pdf-ok-btn" style="flex:2;padding:10px;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">📄 Tạo Biên Bản</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("pdf-shop").focus();
  document.getElementById("pdf-cancel-btn").onclick = () => document.body.removeChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) document.body.removeChild(overlay); });
  document.getElementById("pdf-ok-btn").onclick = () => {
    const shop = document.getElementById("pdf-shop").value.trim();
    if (!shop) { document.getElementById("pdf-shop").style.borderColor = "red"; document.getElementById("pdf-shop").focus(); return; }
    const addr = document.getElementById("pdf-addr").value.trim();
    const phone = document.getElementById("pdf-phone").value.trim();
    localStorage.setItem("pdf_shop_info", JSON.stringify({ shop, addr, phone }));
    document.body.removeChild(overlay);
    printBienBan(shop, addr, phone, batchId, carrier, dateStr, orders);
  };
};

function printBienBan(shop, addr, phone, batchId, carrier, dateStr, orders) {
  const now = new Date().toLocaleString("vi-VN");
  const sysId = `#${Math.floor(100000 + Math.random() * 900000)}`;
  const total = orders.length;
  const COLS = 4;
  let rows = "";
  for (let i = 0; i < orders.length; i += COLS) {
    rows += "<tr>";
    for (let g = 0; g < COLS; g++) {
      const o = orders[i + g];
      if (o) rows += `<td class="stt">${i+g+1}</td><td class="code">${o.code}</td>`;
      else    rows += `<td></td><td></td>`;
    }
    rows += "</tr>";
  }
  const addrLine  = addr  ? `<div class="info-addr">Địa chỉ: ${addr}</div>` : "";
  const phoneLine = phone ? `<div class="info-addr">Điện thoại: ${phone}</div>` : "";
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Biên Bản - ${batchId}</title>
<style>
  @page{size:A4;margin:8mm}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;font-size:9pt;color:#000;background:#fff}
  .title{text-align:center;font-size:15pt;font-weight:bold;margin-bottom:3px}
  .subtitle{text-align:center;font-size:7pt;color:#888;margin-bottom:4px}
  hr{border:none;border-top:1.5px solid #4472C4;margin-bottom:5px}
  .info{width:100%;border-collapse:collapse;margin-bottom:5px}
  .info td{border:.5px solid #ccc;padding:5px 7px;vertical-align:top}
  .info .l{background:#F8F9FF;width:52%}
  .info .r{background:#F0F4FF;width:48%}
  .lbl{font-size:7pt;color:#666;margin-bottom:3px}
  .val{font-weight:bold;font-size:9pt;margin-bottom:2px}
  .info-addr{color:#3366CC;font-size:8pt;margin-top:1px}
  .badge{background:#1a1a1a;color:#fff;text-align:center;font-weight:bold;font-size:10pt;padding:5px 6px;border-radius:4px;margin-top:7px}
  .ct{width:100%;border-collapse:collapse;margin-bottom:5px}
  .ct th{background:#4472C4;color:#fff;font-weight:bold;font-size:7pt;text-align:center;padding:3px 2px;border:.3px solid #aaa}
  .ct td{font-size:8pt;padding:2px 3px;border:.3px solid #ccc}
  .ct tr:nth-child(even) td{background:#F0F4FF}
  .stt{text-align:center;color:#999;width:7mm}
  .code{font-weight:bold}
  .sig{width:100%;border-collapse:collapse}
  .sig td{border:.5px solid #ccc;padding:5px 6px;text-align:center;width:33.33%}
  .sg{background:#FFF8F0}.sm{background:#fff;font-size:6pt;color:#999;vertical-align:middle}.sr{background:#F0FFF0}
  .sh{font-weight:bold;font-size:8pt;margin-bottom:2px}
  .ss{font-size:7pt;color:#888}
  .sl{margin-top:22px;font-size:8pt;color:#555}
  @media print{button{display:none}}
</style></head><body>
<div class="title">BIÊN BẢN BÀN GIAO VẬN ĐƠN</div>
<div class="subtitle">In vào: ${now} &bull; ID: ${sysId}</div>
<hr>
<table class="info"><tr>
  <td class="l"><div class="lbl">ĐƠN VỊ GỬI HÀNG</div><div class="val">${shop}</div>${addrLine}${phoneLine}</td>
  <td class="r"><div class="lbl">ĐƠN VỊ TIẾP NHẬN</div>
    <div class="val">ĐVVC: ${carrier}</div>
    <div class="val">Lô/Xe: ${batchId}</div>
    <div class="val">Ngày: ${dateStr}</div>
    <div class="badge">TỔNG SỐ: ${total} ĐƠN HÀNG</div></td>
</tr></table>
<table class="ct"><thead><tr>
  <th>STT</th><th>MÃ VẬN ĐƠN</th><th>STT</th><th>MÃ VẬN ĐƠN</th>
  <th>STT</th><th>MÃ VẬN ĐƠN</th><th>STT</th><th>MÃ VẬN ĐƠN</th>
</tr></thead><tbody>${rows}</tbody></table>
<table class="sig"><tr>
  <td class="sg"><div class="sh">BÊN GIAO</div><div class="ss">(Ký, ghi rõ họ tên)</div><div class="sl">.................................</div></td>
  <td class="sm">In vào: ${now}<br>${sysId}</td>
  <td class="sr"><div class="sh">BÊN NHẬN</div><div class="ss">(Ký, ghi rõ họ tên)</div><div class="sl">.................................</div></td>
</tr></table>
<script>window.onload=()=>window.print();<\/script>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) { alert("Trình duyệt chặn popup! Vui lòng cho phép popup và thử lại."); return; }
  w.document.write(html);
  w.document.close();
}
