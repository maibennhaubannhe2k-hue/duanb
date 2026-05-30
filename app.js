// === 1. KHỞI TẠO FIREBASE ===
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, push, onValue, onChildAdded, get } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

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
const CANCEL_RETURN_KEY = "warehouse_cancel_return_v1";
const ACTIVE_BATCH_KEY_2 = "warehouse_active_batches_s2_v1";
const ACTIVE_BATCH_LOCAL_KEY_2 = "warehouse_active_batches_s2_local";
const CLOSED_BATCH_KEY_2 = "warehouse_closed_batches_s2_v1";

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
let lastSyncTs = 0;

// Tra cứu đơn hủy xe
let cancelScanList = [];
let html5QrScanner = null;
let isCameraRunning = false;
let lastCamCode = "";
let lastCamTime = 0;

// Camera quét đơn chính
let isScanCameraRunning = false;
let html5QrScannerMain = null;
let lastScanCamCode = "";
let lastScanCamTime = 0;
let cancelReturnCache = {};
let scanMsgTimer = null;

// Cache trong RAM — toàn bộ code đọc từ đây (sync), ghi xuống IDB + Firebase (async)
let scanDataCache = {};
let activeBatches = JSON.parse(localStorage.getItem(ACTIVE_BATCH_LOCAL_KEY)) || {};
let closedBatches = JSON.parse(localStorage.getItem(CLOSED_BATCH_KEY)) || [];
let activeBatches2 = JSON.parse(localStorage.getItem(ACTIVE_BATCH_LOCAL_KEY_2)) || {};
let closedBatches2 = JSON.parse(localStorage.getItem(CLOSED_BATCH_KEY_2)) || [];
let showAllTodayOrders2 = false;

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
      const dirty = [];
      req.result.forEach(item => {
        if (!item || !item.date) return;
        const origLen = item.orders?.length || 0;
        if (origLen > 0) {
          const seen = new Set();
          item.orders = item.orders.filter(o => {
            const key = `${o.code}|${o.time}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (item.orders.length < origLen) dirty.push(item);
        }
        scanDataCache[item.date] = item;
      });
      resolve();
      dirty.forEach(day => idbSaveDay(day));
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
    for (let i = 1; i <= 45; i++) {
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
  renderBatches("1");
  renderBatches("2");

  subscribeToTodayScan();
  syncLocalToFirebase(); // Đẩy dữ liệu offline cũ lên Firebase (chạy nền)

  onValue(ref(db, `${CANCEL_RETURN_KEY}/${todayStr()}`), (snapshot) => {
    if (snapshot.exists()) cancelReturnCache[todayStr()] = snapshot.val();
  });

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
    if (addedClosed || removedActive) renderBatches("1");
  });

  // Active batches: chỉ THÊM xe mới từ Firebase (thiết bị khác tạo)
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
      renderBatches("1");
    }
  }, (err) => console.error("❌ Lỗi sync xe:", err));

  // Station 2 - closed batches
  onValue(ref(db, CLOSED_BATCH_KEY_2), (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    const fromFirebase = Array.isArray(data) ? data : Object.values(data);
    const localKeys = new Set(closedBatches2.map(b => `${b.id}|${b.carrier}`));
    let addedClosed = false, removedActive = false;
    fromFirebase.forEach(b => {
      if (!localKeys.has(`${b.id}|${b.carrier}`)) { closedBatches2.push(b); addedClosed = true; }
      if (activeBatches2[b.carrier]?.id === b.id) { delete activeBatches2[b.carrier]; removedActive = true; }
    });
    if (addedClosed) localStorage.setItem(CLOSED_BATCH_KEY_2, JSON.stringify(closedBatches2));
    if (removedActive) localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
    if (addedClosed || removedActive) renderBatches("2");
  });

  // Station 2 - active batches
  onValue(ref(db, ACTIVE_BATCH_KEY_2), (snapshot) => {
    const firebaseBatches = snapshot.val() || {};
    const closedIds = new Set(closedBatches2.map(b => b.id));
    let changed = false;
    Object.keys(firebaseBatches).forEach(carrier => {
      const batch = firebaseBatches[carrier];
      if (!activeBatches2[carrier] && !closedIds.has(batch.id)) {
        activeBatches2[carrier] = batch;
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
      renderBatches("2");
    }
  }, (err) => console.error("❌ Lỗi sync xe 2:", err));
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
      const nameUsed = Object.values(activeBatches).some(b => b.id === name) || Object.values(activeBatches2).some(b => b.id === name) || closedBatches.some(b => b.id === name) || closedBatches2.some(b => b.id === name);
      if (nameUsed) return alert(`Tên xe [${name}] đã được dùng trước đó! Vui lòng đặt tên khác.`);
      const newBatch = { id: name, count: 0, createdDate: todayStr() };
      activeBatches[carrier] = newBatch;
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), newBatch)
        .catch(err => console.error("Lỗi tạo xe:", err));
      document.getElementById("batchName").value = "";
      renderBatches("1");
      focusOrderInput();
    });
  }

  const createBatchBtn2 = document.getElementById("createBatchBtn2");
  if (createBatchBtn2) {
    createBatchBtn2.addEventListener("click", () => {
      const carrier = document.getElementById("batchCarrier2").value;
      const name = document.getElementById("batchName2").value.trim();
      if (!name) return alert("Vui lòng nhập tên xe/lô!");
      if (activeBatches2[carrier]) return alert(`Đang có xe [${activeBatches2[carrier].id}] mở cho [${carrier}] rồi! Vui lòng CHỐT XE trước khi tạo mới.`);
      const nameUsed = Object.values(activeBatches).some(b => b.id === name) || Object.values(activeBatches2).some(b => b.id === name) || closedBatches.some(b => b.id === name) || closedBatches2.some(b => b.id === name);
      if (nameUsed) return alert(`Tên xe [${name}] đã được dùng trước đó! Vui lòng đặt tên khác.`);
      const newBatch = { id: name, count: 0, createdDate: todayStr() };
      activeBatches2[carrier] = newBatch;
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
      set(ref(db, `${ACTIVE_BATCH_KEY_2}/${carrier}`), newBatch).catch(err => console.error("Lỗi tạo xe 2:", err));
      document.getElementById("batchName2").value = "";
      renderBatches("2");
      setTimeout(() => document.getElementById("orderInput2")?.focus(), 0);
    });
  }

  document.getElementById("orderInput2")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const input2 = document.getElementById("orderInput2");
      handleScan(input2.value.trim(), "2");
      input2.value = "";
      setTimeout(() => input2.focus(), 0);
    }
  });

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
      results = results.concat((scanDataCache[date].orders || []).filter(o => o && terms.some(t => o.code.toLowerCase().includes(t))));
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

  document.getElementById("startScanCameraBtn")?.addEventListener("click", () => startScanPageCamera("1"));
  document.getElementById("startScanCameraBtn2")?.addEventListener("click", () => startScanPageCamera("2"));

  // Tắt camera khi chuyển tab
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isCameraRunning) stopCameraScanner();
    if (document.hidden && isScanCameraRunning) stopScanPageCamera();
  });

  // Sync offline data khi mạng vừa kết nối lại
  onValue(ref(db, ".info/connected"), (snapshot) => {
    if (snapshot.val() === true) syncLocalToFirebase();
  });

  bindCancelScanEvents();
}

// === 6. QUÉT MÃ ===
function handleScan(code, station = "1") {
  if (!code) return;
  const date = todayStr();
  const now = new Date().toISOString();
  const carrier = detectCarrier(code);
  const canceledSet = getCancelledSet();

  const batches = station === "2" ? activeBatches2 : activeBatches;
  const activeBatch = batches[carrier];

  if (activeBatch && activeBatch.createdDate && activeBatch.createdDate < date) {
    showMessage(`⚠️ XE [${activeBatch.id}] CỦA [${carrier}] CHƯA CHỐT TỪ NGÀY ${activeBatch.createdDate}\nVui lòng chốt xe này trước!`, "warning", station);
    playTone("error");
    return;
  }

  if (!canceledSet.has(code) && !activeBatch) {
    showMessage(`❌ CHƯA TẠO XE CHO [${carrier.toUpperCase()}]`, "error", station);
    playTone("error", `Chưa tạo xe ${carrier}`);
    return;
  }

  let duplicateOriginal = null;
  for (let i = 0; i < 10; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dayData = scanDataCache[localDateStr(d)];
    if (dayData) {
      const found = dayData.orders.find(o => o.code === code && o.status === STATUS.SUCCESS);
      if (found) { duplicateOriginal = found; break; }
    }
  }
  const isDuplicate = duplicateOriginal !== null;

  const day = scanDataCache[date] || { date, orders: [] };
  let status;

  if (canceledSet.has(code)) {
    status = STATUS.CANCELED;
    showMessage("❌ ĐƠN HỦY - DỪNG LẠI", "error", station);
    playTone("error", "Đơn hủy");
  } else if (isDuplicate) {
    status = STATUS.DUPLICATE;
    const diffDays = Math.floor((Date.now() - new Date(duplicateOriginal.time)) / 86400000);
    const daysText = diffDays === 0 ? "hôm nay" : `${diffDays} ngày trước`;
    showMessage(`⚠️ TRÙNG ĐƠN — Đã quét lúc ${formatTime(duplicateOriginal.time)} (${daysText})`, "warning", station);
    playTone("warning");
  } else {
    status = STATUS.SUCCESS;
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success", station);
    playTone("success");
  }

  const newOrder = { code, status, carrier, time: now, batchId: activeBatch ? activeBatch.id : "", station };
  day.orders.push(newOrder);
  scanDataCache[date] = day;
  saveAllData(date, day, newOrder);
  renderAll();
  renderBatches("1");
  renderBatches("2");
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
  renderTodayList(getTodayOrdersByStation(todayStr(), "1"), "todayScannedBody", "loadMoreTodayBtn", showAllTodayOrders, () => { showAllTodayOrders = true; });
  renderTodayList(getTodayOrdersByStation(todayStr(), "2"), "todayScannedBody2", "loadMoreTodayBtn2", showAllTodayOrders2, () => { showAllTodayOrders2 = true; });
  loadCancelledCount();
  if (activePage === "scanPage") focusOrderInput();
  if (activePage === "scanPage2") setTimeout(() => document.getElementById("orderInput2")?.focus(), 0);
}

function renderTodayList(orders, bodyId = "todayScannedBody", loadMoreId = "loadMoreTodayBtn", showAllFlag = false, onShowAll = null) {
  const body = document.getElementById(bodyId);
  const btn = document.getElementById(loadMoreId);
  if (!body) return;
  body.innerHTML = "";
  const reversed = [...orders].reverse();
  const limit = showAllFlag ? reversed.length : 100;
  reversed.slice(0, limit).forEach(o => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${o.batchId || '-'}</td><td>${statusLabel[o.status]}</td>`;
    body.appendChild(tr);
  });
  if (btn) {
    if (reversed.length > 100 && !showAllFlag) {
      btn.style.display = "block";
      btn.textContent = `⬇️ Xem tất cả (Còn ẩn ${reversed.length - 100} đơn)`;
      btn.onclick = () => { if (onShowAll) onShowAll(); renderTodayList(orders, bodyId, loadMoreId, true, onShowAll); };
    } else {
      btn.style.display = "none";
    }
  }
}

function renderBatches(station = "1") {
  const bodyId = station === "2" ? "activeBatchesBody2" : "activeBatchesBody";
  const body = document.getElementById(bodyId);
  if (!body) return;
  const batches = station === "2" ? activeBatches2 : activeBatches;
  body.innerHTML = "";
  const keys = Object.keys(batches);
  if (keys.length === 0) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;">Chưa có xe</td></tr>`;
    return;
  }
  keys.forEach(carrier => {
    const batch = batches[carrier];
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
    btn.onclick = () => closeBatch(carrier, station);
    tdAction.appendChild(btn);
    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tr.appendChild(tdAction);
    body.appendChild(tr);
  });
}

window.closeBatch = function(carrier, station = "1") {
  const batches = station === "2" ? activeBatches2 : activeBatches;
  const batch = batches[carrier];
  if (!batch) { alert(`Lỗi: Không tìm thấy xe cho [${carrier}]. Vui lòng tải lại trang.`); return; }
  if (!confirm(`Bạn có chắc chắn muốn CHỐT xe [${batch.id}] của [${carrier}] không?`)) return;

  const fromDate = batch.createdDate || todayStr();
  const realCount = Object.values(scanDataCache)
    .filter(day => day.date >= fromDate && day.date <= todayStr())
    .flatMap(day => day.orders || [])
    .filter(o => o.batchId === batch.id && o.carrier === carrier && o.status === STATUS.SUCCESS)
    .length;

  const closedEntry = { id: batch.id, carrier, count: realCount, date: todayStr(), createdDate: fromDate };

  if (station === "2") {
    closedBatches2 = closedBatches2.filter(b => !(b.id === batch.id && b.carrier === carrier));
    closedBatches2.push(closedEntry);
    localStorage.setItem(CLOSED_BATCH_KEY_2, JSON.stringify(closedBatches2));
    delete activeBatches2[carrier];
    localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
    setTimeout(() => {
      set(ref(db, CLOSED_BATCH_KEY_2), closedBatches2).catch(err => console.error("Lỗi sync closed2:", err));
      set(ref(db, `${ACTIVE_BATCH_KEY_2}/${carrier}`), null).catch(err => console.error("Lỗi xóa active2:", err));
    }, 0);
  } else {
    closedBatches = closedBatches.filter(b => !(b.id === batch.id && b.carrier === carrier));
    closedBatches.push(closedEntry);
    localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
    delete activeBatches[carrier];
    localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
    setTimeout(() => {
      set(ref(db, CLOSED_BATCH_KEY), closedBatches).catch(err => console.error("Lỗi sync closed:", err));
      set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), null).catch(err => console.error("Lỗi xóa active:", err));
    }, 0);
  }

  renderBatches(station);
  const historyDate = document.getElementById("historyDatePicker");
  if (historyDate?.value === todayStr()) renderClosedBatches(todayStr());
  focusOrderInput();
}

function renderClosedBatches(dateStr) {
  const body = document.getElementById("closedBatchesBody");
  const downloadBtn = document.getElementById("downloadSelectedBatchesBtn");
  const selectAll = document.getElementById("selectAllBatches");
  if (!body) return;
  const batchesForDate = [...closedBatches, ...closedBatches2].filter(b => b.date === dateStr);
  body.innerHTML = "";
  if (downloadBtn) downloadBtn.style.display = "none";
  if (selectAll) selectAll.checked = false;
  if (batchesForDate.length === 0) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;">Không có xe nào được chốt trong ngày này</td></tr>`;
    return;
  }
  if (downloadBtn) downloadBtn.style.display = "inline-block";
  [...batchesForDate].reverse().forEach(b => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="batch-checkbox" data-id="${b.id}" data-carrier="${b.carrier}" data-date="${b.date}" data-createddate="${b.createdDate || b.date}"></td>
      <td><strong>${b.carrier}</strong></td>
      <td style="color:blue;font-weight:bold;">${b.id}</td>
      <td style="font-size:16px;font-weight:bold;color:#10b981;">${b.count} <span style="font-size:12px;color:#64748b;font-weight:normal;">(Khớp Excel)</span></td>
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
  const rawOrders = (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean);
  const seen = new Set();
  const orders = rawOrders.filter(o => {
    const key = `${o.code}|${o.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { date: fbDay.date || date, orders };
}

function saveAllData(date, dayData, newOrder) {
  idbSaveDay(dayData);
  if (dayData.orders.length === 1) set(ref(db, `${FIREBASE_SCAN_KEY}/${date}/date`), date);
  push(ref(db, `${FIREBASE_SCAN_KEY}/${date}/orders`), newOrder);
}

function getDayOrders(date) { return scanDataCache[date]?.orders || []; }
function getTodayOrdersByStation(date, station) {
  const orders = getDayOrders(date);
  if (station === "2") return orders.filter(o => o.station === "2");
  return orders.filter(o => !o.station || o.station === "1");
}

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
  if (pageId !== "cancelScanPage" && isCameraRunning) stopCameraScanner();
  if (pageId !== "scanPage" && pageId !== "scanPage2" && isScanCameraRunning) stopScanPageCamera();
  activePage = pageId;
  document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("active", p.id === pageId));
  document.querySelectorAll(".page-tab").forEach(t => t.classList.toggle("active", t.dataset.page === pageId));
  if (pageId === "scanPage") focusOrderInput();
  if (pageId === "scanPage2") setTimeout(() => document.getElementById("orderInput2")?.focus(), 0);
  if (pageId === "dashboardPage") renderAll();
  if (pageId === "cancelScanPage") setTimeout(() => document.getElementById("cancelScanInput")?.focus(), 0);
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
function showMessage(text, type, station = "1") {
  const msgEl = station === "2" ? document.getElementById("scanMessage2") : scanMessage;
  if (msgEl) { msgEl.className = `message ${type}`; msgEl.textContent = text; }
  const camMsg = document.getElementById("scanCamMsgEl");
  if (camMsg) {
    camMsg.style.display = "block";
    camMsg.style.background = type === "success" ? "#f0fdf4" : type === "warning" ? "#fefce8" : "#fef2f2";
    camMsg.style.color = type === "success" ? "#15803d" : type === "warning" ? "#a16207" : "#b91c1c";
    camMsg.textContent = text;
    setTimeout(() => { if (camMsg) camMsg.style.display = "none"; }, 2500);
  }
}
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

function playTone(kind, speakText, volume = 1.0) {
  const audio = audioCache[kind];
  if (!audio) { if (speakText) speak(speakText); return; }
  audio.currentTime = 0;
  audio.volume = volume;
  audio.onended = speakText ? () => speak(speakText) : null;
  audio.play().catch(() => { if (speakText) speak(speakText); });
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
let isBatchPushing = false;

function subscribeToTodayScan() {
  if (unsubscribeTodayScan) unsubscribeTodayScan();
  const todayKey = todayStr();
  unsubscribeTodayScan = onChildAdded(ref(db, `${FIREBASE_SCAN_KEY}/${todayKey}/orders`), (snapshot) => {
    const order = snapshot.val();
    if (!order || !order.code || !order.time) return;
    const localDay = scanDataCache[todayKey] || { date: todayKey, orders: [] };
    const alreadyExists = localDay.orders.some(o => o.code === order.code && o.time === order.time);
    if (!alreadyExists) {
      localDay.orders.push(order);
      scanDataCache[todayKey] = localDay;
      idbSaveDay(localDay);
      renderBatches("1");
      renderBatches("2");
      renderTodayList(getTodayOrdersByStation(todayKey, "1"), "todayScannedBody", "loadMoreTodayBtn", showAllTodayOrders, () => { showAllTodayOrders = true; });
      renderTodayList(getTodayOrdersByStation(todayKey, "2"), "todayScannedBody2", "loadMoreTodayBtn2", showAllTodayOrders2, () => { showAllTodayOrders2 = true; });
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
    showAllTodayOrders2 = false;
    scheduleMidnightReset();
  }, nextMidnight - now);
}

// === SYNC OFFLINE DATA LÊN FIREBASE ===
// So sánh IDB local vs Firebase, ngày nào local nhiều hơn thì đẩy lên
// Throttle 5 phút để tránh gọi liên tục khi chuyển tab
async function syncLocalToFirebase() {
  if (Date.now() - lastSyncTs < 5 * 60 * 1000) return;
  lastSyncTs = Date.now();

  const dates = Object.keys(scanDataCache)
    .filter(d => (scanDataCache[d]?.orders?.length || 0) > 0)
    .sort().reverse().slice(0, 30);
  if (dates.length === 0) return;

  try {
    const snapshots = await Promise.all(
      dates.map(d => get(ref(db, `${FIREBASE_SCAN_KEY}/${d}`)).catch(() => null))
    );
    snapshots.forEach((snap, i) => {
      const date = dates[i];
      const localOrders = scanDataCache[date]?.orders || [];
      const firebaseOrders = snap?.exists() ? (firebaseDayToLocal(snap.val(), date)?.orders || []) : [];
      const fbKeys = new Set(firebaseOrders.map(o => `${o.code}|${o.time}`));
      const missing = localOrders.filter(o => !fbKeys.has(`${o.code}|${o.time}`));
      if (missing.length > 0) {
        missing.forEach(o => push(ref(db, `${FIREBASE_SCAN_KEY}/${date}/orders`), o)
          .catch(e => console.error(`Lỗi sync ${date}:`, e)));
        console.log(`[Sync] ${date}: push ${missing.length} đơn còn thiếu`);
      }
    });
  } catch (e) {
    console.error("Lỗi syncLocalToFirebase:", e);
  }
}

// === TRA CỨU ĐƠN HỦY XE ===
function findOrderInBatch(code) {
  let foundOrder = null;
  let foundDate = null;
  for (let i = 0; i < 10; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateStr = localDateStr(d);
    const dayData = scanDataCache[dateStr];
    if (!dayData) continue;
    const order = dayData.orders.find(o => o.code === code && o.status === STATUS.SUCCESS);
    if (order) { foundOrder = order; foundDate = dateStr; break; }
  }
  if (!foundOrder) return { found: false, code };

  const { batchId, carrier } = foundOrder;
  if (!batchId) return { found: true, code, batchId: "-", carrier, stt: "-", total: "-" };

  const closedBatch = closedBatches.find(b => b.id === batchId && b.carrier === carrier);
  const activeBatch = activeBatches[carrier]?.id === batchId ? activeBatches[carrier] : null;
  const batch = closedBatch || activeBatch;
  const fromDate = batch?.createdDate || foundDate;
  const toDate = closedBatch?.date || todayStr();

  const batchOrders = Object.values(scanDataCache)
    .filter(day => day.date >= fromDate && day.date <= toDate)
    .flatMap(day => day.orders || [])
    .filter(o => o.batchId === batchId && o.carrier === carrier && o.status === STATUS.SUCCESS);

  const stt = batchOrders.findIndex(o => o.code === code) + 1;
  return { found: true, code, batchId, carrier, stt, total: batchOrders.length };
}

function handleCancelScan(code) {
  if (!code) return;
  if (cancelScanList.some(r => r.code === code)) {
    showCancelScanMsg(`⚠️ Mã ${code} đã quét rồi!`, "#f59e0b");
    return;
  }
  const result = findOrderInBatch(code);
  cancelScanList.unshift(result);
  renderCancelScanResults();
  updateCamCount();
  saveCancelReturn(true);
  if (result.found) {
    showCancelScanMsg(`✅ Đã quét thành công: ${code}`, "#10b981");
    playTone("success");
    clearTimeout(scanMsgTimer);
    scanMsgTimer = setTimeout(() => {
      const el = document.getElementById("cancelScanMessage");
      if (el) el.style.display = "none";
      const camMsg = document.getElementById("camMsgEl");
      if (camMsg) camMsg.style.display = "none";
    }, 1500);
  } else {
    showCancelScanMsg(`❌ Không tìm thấy mã ${code} trong 10 ngày gần nhất`, "#ef4444");
    playTone("error");
  }
}

function showCancelScanMsg(text, color) {
  const el = document.getElementById("cancelScanMessage");
  if (el) {
    el.style.display = "block";
    el.style.background = color + "20";
    el.style.color = color;
    el.style.border = `1px solid ${color}`;
    el.textContent = text;
  }
  const camMsg = document.getElementById("camMsgEl");
  if (camMsg) {
    camMsg.style.display = "block";
    camMsg.style.background = color + "20";
    camMsg.style.color = color;
    camMsg.textContent = text;
  }
}

function renderCancelScanResults() {
  const wrap = document.getElementById("cancelScanResultsWrap");
  const body = document.getElementById("cancelScanBody");
  const count = document.getElementById("cancelScanCount");
  if (!wrap || !body) return;
  if (cancelScanList.length === 0) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  count.textContent = cancelScanList.length;
  body.innerHTML = "";
  cancelScanList.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.style.background = r.found ? "" : "#fef2f2";
    tr.innerHTML = r.found
      ? `<td>${i + 1}</td><td><b>${r.code}</b></td><td style="color:blue;font-weight:bold;">${r.batchId}</td><td>${r.carrier}</td><td style="color:#e11d48;font-weight:bold;font-size:16px;">STT ${r.stt} <span style="color:#64748b;font-size:12px;font-weight:normal;">/ ${r.total} đơn</span></td>`
      : `<td>${i + 1}</td><td><b>${r.code}</b></td><td colspan="3" style="color:#ef4444;">❌ Không tìm thấy trong 10 ngày gần nhất</td>`;
    body.appendChild(tr);
  });
}

function bindCancelScanEvents() {
  const input = document.getElementById("cancelScanInput");
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCancelScan(input.value.trim());
      input.value = "";
    }
  });
  document.getElementById("cancelScanClearBtn")?.addEventListener("click", () => {
    cancelScanList = [];
    renderCancelScanResults();
    const msg = document.getElementById("cancelScanMessage");
    if (msg) msg.style.display = "none";
  });
  document.getElementById("startCameraBtn")?.addEventListener("click", startCameraScanner);
  document.getElementById("stopCameraBtn")?.addEventListener("click", stopCameraScanner);
  document.getElementById("saveCancelReturnBtn")?.addEventListener("click", saveCancelReturn);
  document.getElementById("cancelReturnDatePicker")?.addEventListener("change", (e) => {
    loadAndRenderCancelReturns(e.target.value);
  });
}

function updateCamCount() {
  const el = document.getElementById("camScanCount");
  if (el) el.textContent = `${cancelScanList.length} đơn`;
}

function startCameraScanner() {
  if (isCameraRunning) return;
  if (typeof Html5Qrcode === "undefined") { alert("Thư viện camera chưa tải, vui lòng thử lại!"); return; }

  // Tạo modal fullscreen
  const modal = document.createElement("div");
  modal.id = "cameraModal";
  modal.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:9999;display:flex;flex-direction:column;";
  modal.innerHTML = `
    <div style="background:#7c3aed;color:white;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
      <span style="font-weight:bold;font-size:17px;">📷 Quét Mã Đơn Hủy</span>
      <span id="camScanCount" style="background:rgba(0,0,0,0.4);padding:4px 14px;border-radius:20px;font-size:15px;font-weight:bold;">0 đơn</span>
    </div>
    <div id="cameraModalReader" style="flex:1;position:relative;background:#000;overflow:hidden;"></div>
    <div id="camMsgEl" style="display:none;padding:10px 16px;font-weight:bold;font-size:15px;text-align:center;flex-shrink:0;"></div>
    <div style="background:#0f172a;padding:12px 16px;display:flex;flex-direction:column;gap:8px;flex-shrink:0;">
      <button id="camStopBtn" style="background:#f59e0b;color:white;font-weight:bold;padding:14px;border:none;border-radius:10px;font-size:16px;width:100%;cursor:pointer;">⏹ Dừng Camera</button>
      <button id="camClearBtn" style="background:transparent;color:#94a3b8;padding:10px;border:1px solid #334155;border-radius:10px;font-size:14px;width:100%;cursor:pointer;">🗑 Xóa tất cả mã đã quét</button>
    </div>
  `;
  document.body.appendChild(modal);
  updateCamCount();
  // Unlock audio trên iOS (phải chạy trong user gesture)
  Object.values(audioCache).forEach(a => {
    a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
  });

  document.getElementById("camStopBtn").addEventListener("click", stopCameraScanner);
  document.getElementById("camClearBtn").addEventListener("click", () => {
    cancelScanList = [];
    renderCancelScanResults();
    updateCamCount();
    const msg = document.getElementById("cancelScanMessage");
    if (msg) msg.style.display = "none";
  });

  const readerEl = document.getElementById("cameraModalReader");
  const videoObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === "VIDEO") {
          node.setAttribute("playsinline", "");
          node.setAttribute("webkit-playsinline", "");
          node.setAttribute("x-webkit-airplay", "deny");
          node.disablePictureInPicture = true;
          videoObserver.disconnect();
        }
      }
    }
  });
  videoObserver.observe(readerEl, { childList: true, subtree: true });

  html5QrScanner = new Html5Qrcode("cameraModalReader", {
    formatsToSupport: [0, 3, 5, 9, 10],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  });
  html5QrScanner.start(
    { facingMode: "environment" },
    { fps: 25, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(h * 0.35) }), videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    (decodedText) => {
      const now = Date.now();
      if (decodedText === lastCamCode && now - lastCamTime < 2000) return;
      lastCamCode = decodedText;
      lastCamTime = now;
      handleCancelScan(decodedText.trim());
    },
    () => {}
  ).then(() => {
    isCameraRunning = true;
    document.getElementById("startCameraBtn").style.display = "none";
    const overlay = document.createElement("div");
    overlay.id = "scanLineOverlay";
    overlay.className = "scan-line-overlay";
    overlay.innerHTML = '<div class="scan-line"></div>';
    readerEl.appendChild(overlay);
  }).catch(err => {
    document.getElementById("cameraModal")?.remove();
    alert("Không thể bật camera: " + err);
  });
}

function stopCameraScanner() {
  const cleanup = () => {
    isCameraRunning = false;
    html5QrScanner = null;
    document.getElementById("cameraModal")?.remove();
    const s = document.getElementById("startCameraBtn");
    if (s) s.style.display = "inline-block";
  };
  if (!html5QrScanner) { cleanup(); return; }
  html5QrScanner.stop().then(cleanup).catch(cleanup);
}

async function saveCancelReturn(silent = false) {
  const toSave = cancelScanList;
  if (toSave.length === 0) { if (!silent) alert("Chưa có đơn nào để lưu!"); return; }
  const date = todayStr();
  const now = new Date().toISOString();
  // Fetch từ Firebase trước nếu cache chưa có — tránh ghi đè dữ liệu cũ
  if (!cancelReturnCache[date]) {
    try {
      const snap = await get(ref(db, `${CANCEL_RETURN_KEY}/${date}`));
      if (snap.exists()) cancelReturnCache[date] = snap.val();
    } catch (e) {}
  }
  const existing = cancelReturnCache[date]?.orders || [];
  const existingCodes = new Set(existing.map(o => o.code));
  const newEntries = toSave.filter(r => !existingCodes.has(r.code))
    .map(r => ({ code: r.code, found: r.found !== false, batchId: r.batchId || "-", carrier: r.carrier || "-", stt: r.stt || "-", total: r.total || "-", time: now }));
  if (newEntries.length === 0) { if (!silent) showCancelScanMsg("⚠️ Tất cả đơn đã được lưu trước đó!", "#f59e0b"); return; }
  const merged = [...existing, ...newEntries];
  cancelReturnCache[date] = { date, orders: merged };
  try {
    await set(ref(db, `${CANCEL_RETURN_KEY}/${date}`), { date, orders: merged });
    if (!silent) showCancelScanMsg(`✅ Đã lưu ${newEntries.length} đơn hủy ngày ${date}`, "#10b981");
  } catch (err) {
    if (!silent) showCancelScanMsg("❌ Lỗi lưu Firebase, vui lòng thử lại!", "#ef4444");
  }
}

async function loadAndRenderCancelReturns(date) {
  const body = document.getElementById("cancelReturnBody");
  const title = document.getElementById("cancelReturnTitle");
  if (!body || !title) return;
  if (!cancelReturnCache[date]) {
    try {
      const snap = await get(ref(db, `${CANCEL_RETURN_KEY}/${date}`));
      if (snap.exists()) cancelReturnCache[date] = snap.val();
    } catch (e) {}
  }
  const orders = cancelReturnCache[date]?.orders || [];
  title.textContent = `Đơn Hủy Trả Về: ${orders.length} đơn`;
  const exportBtn = document.getElementById("exportCancelReturnBtn");
  if (exportBtn) {
    exportBtn.style.display = orders.length > 0 ? "inline-block" : "none";
    exportBtn.onclick = () => {
      exportOrdersToExcel(
        orders.map((o, i) => ({
          "#": i + 1,
          "Thời gian": o.time ? formatTime(o.time) : "-",
          "Mã đơn": o.code,
          "Lô/Xe": o.found === false ? "Không tìm thấy" : o.batchId,
          "DVVC": o.found === false ? "-" : o.carrier,
          "STT trong biên bản": o.found === false ? "-" : o.stt,
          "Tổng đơn xe": o.found === false ? "-" : o.total
        })),
        `DonHuyTraVe_${date}.xlsx`
      );
    };
  }
  body.innerHTML = "";
  if (orders.length === 0) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;">Không có đơn hủy trả về trong ngày này</td></tr>`;
    return;
  }
  orders.forEach((o, i) => {
    const tr = document.createElement("tr");
    tr.style.background = o.found === false ? "#fef2f2" : "";
    const timeStr = o.time ? formatTime(o.time) : "-";
    tr.innerHTML = o.found === false
      ? `<td>${i + 1}</td><td>${timeStr}</td><td><b>${o.code}</b></td><td colspan="3" style="color:#ef4444;">❌ Không tìm thấy trong 10 ngày gần nhất</td>`
      : `<td>${i + 1}</td><td>${timeStr}</td><td><b>${o.code}</b></td><td style="color:blue;font-weight:bold;">${o.batchId}</td><td>${o.carrier}</td><td style="color:#e11d48;font-weight:bold;">STT ${o.stt} <span style="color:#64748b;font-size:12px;font-weight:normal;">/ ${o.total} đơn</span></td>`;
    body.appendChild(tr);
  });
}

// === CAMERA QUÉT ĐƠN CHÍNH ===
function startScanPageCamera(station = "1") {
  if (isScanCameraRunning) return;
  if (typeof Html5Qrcode === "undefined") { alert("Thư viện camera chưa tải!"); return; }

  const modal = document.createElement("div");
  modal.id = "scanCameraModal";
  modal.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:9999;display:flex;flex-direction:column;";
  modal.innerHTML = `
    <div style="background:#10b981;color:white;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
      <span style="font-weight:bold;font-size:17px;">📷 Quét Đơn</span>
      <span id="scanCamCount" style="background:rgba(0,0,0,0.4);padding:4px 14px;border-radius:20px;font-size:15px;font-weight:bold;">0 đơn</span>
    </div>
    <div id="scanCameraModalReader" style="flex:1;position:relative;background:#000;overflow:hidden;"></div>
    <div id="scanCamMsgEl" style="display:none;padding:10px 16px;font-weight:bold;font-size:15px;text-align:center;flex-shrink:0;white-space:pre-line;"></div>
    <div style="background:#0f172a;padding:12px 16px;flex-shrink:0;">
      <button id="scanCamStopBtn" style="background:#ef4444;color:white;font-weight:bold;padding:14px;border:none;border-radius:10px;font-size:16px;width:100%;cursor:pointer;">⏹ Dừng Camera</button>
    </div>
  `;
  document.body.appendChild(modal);

  const updateCount = () => {
    const el = document.getElementById("scanCamCount");
    if (el) el.textContent = `${getTodayOrdersByStation(todayStr(), station).length} đơn`;
  };
  updateCount();

  document.getElementById("scanCamStopBtn").addEventListener("click", stopScanPageCamera);

  Object.values(audioCache).forEach(a => {
    a.muted = true;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
  });

  const readerEl = document.getElementById("scanCameraModalReader");
  const videoObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeName === "VIDEO") {
          node.setAttribute("playsinline", "");
          node.setAttribute("webkit-playsinline", "");
          node.setAttribute("x-webkit-airplay", "deny");
          node.disablePictureInPicture = true;
          videoObserver.disconnect();
        }
      }
    }
  });
  videoObserver.observe(readerEl, { childList: true, subtree: true });

  html5QrScannerMain = new Html5Qrcode("scanCameraModalReader", {
    formatsToSupport: [0, 3, 5, 9, 10],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  });
  html5QrScannerMain.start(
    { facingMode: "environment" },
    { fps: 25, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(h * 0.35) }), videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    (decodedText) => {
      const now = Date.now();
      if (decodedText === lastScanCamCode && now - lastScanCamTime < 2000) return;
      lastScanCamCode = decodedText;
      lastScanCamTime = now;
      handleScan(decodedText.trim(), station);
      updateCount();
    },
    () => {}
  ).then(() => {
    isScanCameraRunning = true;
    const overlay = document.createElement("div");
    overlay.className = "scan-line-overlay";
    overlay.innerHTML = '<div class="scan-line"></div>';
    readerEl.appendChild(overlay);
  }).catch(err => {
    document.getElementById("scanCameraModal")?.remove();
    alert("Không thể bật camera: " + err);
  });
}

function stopScanPageCamera() {
  const cleanup = () => {
    isScanCameraRunning = false;
    html5QrScannerMain = null;
    document.getElementById("scanCameraModal")?.remove();
  };
  if (!html5QrScannerMain) { cleanup(); return; }
  html5QrScannerMain.stop().then(cleanup).catch(cleanup);
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
