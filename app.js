// === 1. KHỞI TẠO FIREBASE ===
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, push, onChildAdded, onChildRemoved, get, query, orderByChild, orderByKey, startAfter } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

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
const PRODUCTIVITY_KEY = "warehouse_productivity_v1";
const HANDOVER_KEY = "warehouse_handover_v1";
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
let lastSyncTs = parseInt(localStorage.getItem("warehouse_last_sync_ts") || "0");

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
let cancelReturnCacheLoaded = false;
let productivitySession = null; // { startTime, fullTime, partTime, sessionDate }
let handoverCache = {};
let closedBatchCarrierFilter = "all";
let productivityLiveTimer = null;
let scanMsgTimer = null;
let idbSaveTimer = null;
let scanRenderTimer = null;

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
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = localDateStr(cutoff);
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.lowerBound(cutoffStr);
    const req = idb.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll(range);
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

function setProgress(percent, text) {
  const bar = document.getElementById("loadingBar");
  const pct = document.getElementById("loadingPercent");
  const txt = document.getElementById("loadingText");
  if (bar) bar.style.width = percent + "%";
  if (pct) pct.textContent = percent + "%";
  if (txt) txt.textContent = text;
}

function hideLoading() {
  const overlay = document.getElementById("loadingOverlay");
  if (!overlay) return;
  setProgress(100, "Hoàn tất!");
  // Mở khóa input scan sau khi data đã sẵn sàng
  if (orderInput) orderInput.disabled = false;
  const orderInput2El = document.getElementById("orderInput2");
  if (orderInput2El) orderInput2El.disabled = false;
  setTimeout(() => {
    overlay.style.transition = "opacity 0.4s ease";
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 400);
  }, 300);
}

async function init() {
  // Xóa dữ liệu cũ khỏi localStorage (đã chuyển sang IndexedDB) để Firebase có chỗ lưu trạng thái kết nối
  localStorage.removeItem("warehouse_scan_data_v1");
  localStorage.removeItem("warehouse_active_batches_v1");

  document.getElementById("singleDate").value = todayStr();
  loadCancelledToTextarea();
  bindEvents();
  switchPage("scanPage");

  // Khôi phục session ca làm nếu có (local trước, Firebase fallback cho máy khác)
  try { const s = localStorage.getItem("warehouse_active_session"); if (s) productivitySession = JSON.parse(s); } catch(e) {}
  if (productivitySession && productivitySession.owner) {
    // Chỉ owner mới sync lên Firebase — tránh máy khác ghi đè session của owner
    const { owner: _o0, _pending: _p0, ...sessionForFb0 } = productivitySession;
    set(ref(db, `${PRODUCTIVITY_KEY}/currentSession`), sessionForFb0).catch(() => {});
  } else {
    // Không phải owner hoặc chưa có session → lấy từ Firebase (luôn mới nhất)
    try {
      const snap = await get(ref(db, `${PRODUCTIVITY_KEY}/currentSession`));
      if (snap.exists()) {
        productivitySession = snap.val();
        localStorage.setItem("warehouse_active_session", JSON.stringify(productivitySession));
      } else {
        productivitySession = null;
        localStorage.removeItem("warehouse_active_session");
      }
    } catch(e) {}
  }

  // Khóa input scan cho đến khi load xong — tránh quét trùng do data chưa sẵn sàng
  const orderInput2El = document.getElementById("orderInput2");
  if (orderInput) orderInput.disabled = true;
  if (orderInput2El) orderInput2El.disabled = true;

  // 1. Load từ IndexedDB trước (nhanh, không cần mạng)
  setProgress(10, "Đọc dữ liệu cục bộ...");
  await idbLoadAll();
  setProgress(20, "Dọn dữ liệu cũ...");
  // 2. Xóa dữ liệu cũ hơn 120 ngày
  await idbDeleteOld(120);
  // 2b. Đặt lịch reset ngày lúc 00:00 (đổi listener Firebase, reset filter)
  scheduleMidnightReset();

  // 3. Fetch song song các ngày chưa có trong IDB
  try {
    const missingDays = [];
    for (let i = 1; i <= 10; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = localDateStr(d);
      if (!scanDataCache[dateStr]) missingDays.push(dateStr);
    }
    if (missingDays.length > 0) {
      setProgress(20, `Đang tải dữ liệu... (0/${missingDays.length})`);
      let loaded = 0;
      await Promise.all(missingDays.map(async date => {
        try {
          const snapshot = await get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`));
          if (snapshot.exists()) {
            const day = firebaseDayToLocal(snapshot.val(), date);
            scanDataCache[date] = day;
            idbSaveDay(day);
          }
        } catch(e) {}
        loaded++;
        setProgress(20 + Math.round((loaded / missingDays.length) * 50), `Đang tải dữ liệu... (${loaded}/${missingDays.length})`);
      }));
    }
  } catch (err) {
    console.error("Lỗi tải Firebase:", err);
  }

  // 4. Fetch hôm nay từ Firebase, throttle 5 phút/lần để tránh tốn bandwidth khi refresh liên tục
  setProgress(72, "Tải dữ liệu hôm nay...");
  const todayFetchKey = `lastTodayFetch_${todayStr()}`;
  const lastTodayFetch = parseInt(sessionStorage.getItem(todayFetchKey) || "0");
  if (Date.now() - lastTodayFetch > 5 * 60 * 1000) {
    try {
      const snap = await get(ref(db, `${FIREBASE_SCAN_KEY}/${todayStr()}`));
      if (snap.exists()) {
        const firebaseDay = firebaseDayToLocal(snap.val(), todayStr());
        const localDay = scanDataCache[todayStr()] || { date: todayStr(), orders: [] };
        const localKeys = new Set(localDay.orders.map(o => `${o.code}|${o.time}`));
        firebaseDay.orders.forEach(o => {
          if (!localKeys.has(`${o.code}|${o.time}`)) localDay.orders.push(o);
        });
        scanDataCache[todayStr()] = localDay;
        idbSaveDay(localDay);
      }
      sessionStorage.setItem(todayFetchKey, String(Date.now()));
    } catch(e) {}
  }

  // 4b. Merge hôm qua + hôm kia từ Firebase — tránh IDB stale giữa các trình duyệt
  for (const i of [1, 2]) {
    const rd = new Date();
    rd.setDate(rd.getDate() - i);
    const rds = localDateStr(rd);
    const rKey = `lastMerge_${rds}`;
    if (!sessionStorage.getItem(rKey)) {
      try {
        const snap = await get(ref(db, `${FIREBASE_SCAN_KEY}/${rds}`));
        if (snap.exists()) {
          const fbDay = firebaseDayToLocal(snap.val(), rds);
          const localDay = scanDataCache[rds] || { date: rds, orders: [] };
          const localKeys = new Set(localDay.orders.map(o => `${o.code}|${o.time}`));
          fbDay.orders.forEach(o => {
            if (!localKeys.has(`${o.code}|${o.time}`)) localDay.orders.push(o);
          });
          scanDataCache[rds] = localDay;
          idbSaveDay(localDay);
        }
        sessionStorage.setItem(rKey, "1");
      } catch(e) {}
    }
  }

  setProgress(85, "Hiển thị dữ liệu...");
  renderAll();
  renderBatches("1");
  renderBatches("2");

  setProgress(95, "Kết nối realtime...");
  subscribeToTodayScan();
  syncLocalToFirebase(); // Đẩy dữ liệu offline cũ lên Firebase (chạy nền)
  window.addEventListener("online", syncLocalToFirebase); // Sync ngay khi có mạng lại

  // Tải danh sách đơn hủy 1 lần/giờ — không cần real-time listener
  const canceledFetchKey = "lastCanceledFetch";
  const lastCanceledFetch = parseInt(sessionStorage.getItem(canceledFetchKey) || "0");
  if (Date.now() - lastCanceledFetch > 60 * 60 * 1000) {
    get(ref(db, CANCELED_KEY)).then(snapshot => {
      if (snapshot.exists()) {
        localStorage.setItem(CANCELED_KEY, JSON.stringify(snapshot.val()));
        loadCancelledToTextarea();
      }
      sessionStorage.setItem(canceledFetchKey, String(Date.now()));
    }).catch(() => {});
  }

  // Closed batches: startAfter lastKey để không tải lại toàn bộ lịch sử
  const cb1LastKey = localStorage.getItem(CLOSED_BATCH_KEY + "_lk");
  const cb1Query = cb1LastKey
    ? query(ref(db, CLOSED_BATCH_KEY), orderByKey(), startAfter(cb1LastKey))
    : ref(db, CLOSED_BATCH_KEY);
  onChildAdded(cb1Query, (snapshot) => {
    const b = snapshot.val();
    if (!b || !b.id || !b.carrier) return;
    localStorage.setItem(CLOSED_BATCH_KEY + "_lk", snapshot.key);
    const alreadyLocal = closedBatches.some(x => x.id === b.id && x.carrier === b.carrier);
    if (!alreadyLocal) {
      closedBatches.push(b);
      localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
    }
    if (activeBatches[b.carrier]?.id === b.id) {
      delete activeBatches[b.carrier];
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      renderBatches("1");
    }
  });

  // Active batches: onChildAdded/Removed — chỉ nhận delta, không tải lại toàn bộ
  onChildAdded(ref(db, ACTIVE_BATCH_KEY), (snapshot) => {
    const carrier = snapshot.key;
    const batch = snapshot.val();
    if (!batch || !batch.id) return;
    const closedIds = new Set(closedBatches.map(b => b.id));
    if (!activeBatches[carrier] && !closedIds.has(batch.id)) {
      activeBatches[carrier] = batch;
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      renderBatches("1");
    }
  }, (err) => console.error("❌ Lỗi sync xe:", err));
  onChildRemoved(ref(db, ACTIVE_BATCH_KEY), (snapshot) => {
    const carrier = snapshot.key;
    if (activeBatches[carrier]) {
      delete activeBatches[carrier];
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
      renderBatches("1");
    }
  });

  // Station 2 - closed batches: startAfter lastKey
  const cb2LastKey = localStorage.getItem(CLOSED_BATCH_KEY_2 + "_lk");
  const cb2Query = cb2LastKey
    ? query(ref(db, CLOSED_BATCH_KEY_2), orderByKey(), startAfter(cb2LastKey))
    : ref(db, CLOSED_BATCH_KEY_2);
  onChildAdded(cb2Query, (snapshot) => {
    const b = snapshot.val();
    if (!b || !b.id || !b.carrier) return;
    localStorage.setItem(CLOSED_BATCH_KEY_2 + "_lk", snapshot.key);
    const alreadyLocal = closedBatches2.some(x => x.id === b.id && x.carrier === b.carrier);
    if (!alreadyLocal) {
      closedBatches2.push(b);
      localStorage.setItem(CLOSED_BATCH_KEY_2, JSON.stringify(closedBatches2));
    }
    if (activeBatches2[b.carrier]?.id === b.id) {
      delete activeBatches2[b.carrier];
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
      renderBatches("2");
    }
  });

  // Station 2 - active batches: onChildAdded/Removed — chỉ nhận delta
  onChildAdded(ref(db, ACTIVE_BATCH_KEY_2), (snapshot) => {
    const carrier = snapshot.key;
    const batch = snapshot.val();
    if (!batch || !batch.id) return;
    const closedIds = new Set(closedBatches2.map(b => b.id));
    if (!activeBatches2[carrier] && !closedIds.has(batch.id)) {
      activeBatches2[carrier] = batch;
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
      renderBatches("2");
    }
  }, (err) => console.error("❌ Lỗi sync xe 2:", err));
  onChildRemoved(ref(db, ACTIVE_BATCH_KEY_2), (snapshot) => {
    const carrier = snapshot.key;
    if (activeBatches2[carrier]) {
      delete activeBatches2[carrier];
      localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY_2, JSON.stringify(activeBatches2));
      renderBatches("2");
    }
  });

  hideLoading();
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

  setupBarcodeInput(document.getElementById("orderInput2"), (code) => {
    handleScan(code, "2");
    setTimeout(() => document.getElementById("orderInput2")?.focus(), 0);
  });

  document.getElementById("singleDate")?.addEventListener("change", async () => {
    const date = document.getElementById("singleDate").value;
    if (date && !scanDataCache[date]) await ensureDatesInCache(date, date);
    currentFilter.fromTime = document.getElementById("fromTime")?.value || null;
    currentFilter.toTime = document.getElementById("toTime")?.value || null;
    renderAll();
  });
  document.getElementById("fromTime")?.addEventListener("change", () => {
    currentFilter.fromTime = document.getElementById("fromTime").value || null;
    renderAll();
  });
  document.getElementById("toTime")?.addEventListener("change", () => {
    currentFilter.toTime = document.getElementById("toTime").value || null;
    renderAll();
  });
  document.getElementById("clearTimeBtn")?.addEventListener("click", () => {
    document.getElementById("fromTime").value = "";
    document.getElementById("toTime").value = "";
    currentFilter.fromTime = null;
    currentFilter.toTime = null;
    renderAll();
  });

  setupBarcodeInput(orderInput, (code) => { handleScan(code); focusOrderInput(); });

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

  document.getElementById("applyFilterBtn")?.addEventListener("click", async () => {
    const f = document.getElementById("fromDate").value;
    const t = document.getElementById("toDate").value;
    if (f && t) {
      currentFilter = { mode: "range", fromDate: f, toDate: t, fromTime: document.getElementById("fromTime").value || null, toTime: document.getElementById("toTime").value || null };
      await ensureDatesInCache(f, t);
      renderAll();
    } else alert("Vui lòng chọn cả Từ ngày và Đến ngày!");
  });

  document.getElementById("resetFilterBtn")?.addEventListener("click", () => {
    const today = todayStr();
    document.getElementById("singleDate").value = today;
    document.getElementById("fromDate").value = "";
    document.getElementById("toDate").value = "";
    document.getElementById("fromTime").value = "";
    document.getElementById("toTime").value = "";
    currentFilter = { mode: "single", singleDate: today };
    renderAll();
  });

  const historyFetchedDates = new Map(); // date → timestamp, tự hết hạn sau 5 phút
  const loadHistoryDate = async (date) => {
    if (!date) return;
    const btn = document.getElementById("historyDateLoadBtn");
    const lastFetch = historyFetchedDates.get(date) || 0;
    if (Date.now() - lastFetch > 5 * 60 * 1000) {
      if (btn) { btn.disabled = true; btn.textContent = "⏳ Đang tải..."; }
      try {
        const snapshot = await get(ref(db, `${FIREBASE_SCAN_KEY}/${date}`));
        if (snapshot.exists()) {
          const firebaseDay = firebaseDayToLocal(snapshot.val(), date);
          const localDay = scanDataCache[date] || { date, orders: [] };
          const localKeys = new Set(localDay.orders.map(o => `${o.code}|${o.time}`));
          firebaseDay.orders.forEach(o => {
            if (!localKeys.has(`${o.code}|${o.time}`)) localDay.orders.push(o);
          });
          scanDataCache[date] = localDay;
          idbSaveDay(localDay);
        }
        historyFetchedDates.set(date, Date.now());
      } catch (err) { console.error("Lỗi tải ngày:", err); }
      if (btn) { btn.disabled = false; btn.textContent = "📂 Xem"; }
    }
    renderHistoryTable(getDayOrders(date), `Lịch sử ngày ${date}`);
    renderClosedBatches(date);
  };

  document.getElementById("historyDateLoadBtn")?.addEventListener("click", () => {
    loadHistoryDate(historyDatePicker?.value);
  });
  historyDatePicker?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadHistoryDate(historyDatePicker.value);
  });

  document.getElementById("handoverDateLoadBtn")?.addEventListener("click", () => {
    const date = document.getElementById("handoverDatePicker")?.value;
    if (date) loadHandoverHistory(date);
  });
  document.getElementById("handoverDatePicker")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const date = document.getElementById("handoverDatePicker").value;
      if (date) loadHandoverHistory(date);
    }
  });

  const doHistorySearch = async () => {
    const raw = historySearchInput?.value.trim();
    if (!raw) {
      const date = historyDatePicker?.value;
      if (date) renderHistoryTable(getDayOrders(date), `Lịch sử ngày ${date}`);
      else renderHistoryTable([], "Vui lòng chọn ngày");
      return;
    }
    const terms = raw.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    if (terms.length === 0) return;
    renderHistoryTable([], "Đang tìm kiếm...");
    let results = [];
    const cachedKeys = new Set();
    Object.keys(scanDataCache).forEach(date => {
      (scanDataCache[date].orders || []).forEach(o => {
        if (o && terms.some(t => o.code.toLowerCase().includes(t))) {
          results.push(o);
          cachedKeys.add(`${o.code}|${o.time}`);
        }
      });
    });
    const idbResults = await idbSearchOrders(terms);
    idbResults.forEach(o => {
      if (!cachedKeys.has(`${o.code}|${o.time}`)) results.push(o);
    });
    renderHistoryTable(results, `Kết quả tìm kiếm: ${terms.join(", ")}`);
  };

  historySearchInput?.addEventListener("keydown", e => { if (e.key === "Enter") doHistorySearch(); });
  document.getElementById("historySearchBtn")?.addEventListener("click", doHistorySearch);

  document.getElementById("selectAllBatches")?.addEventListener("change", (e) => {
    document.querySelectorAll(".batch-checkbox").forEach(cb => cb.checked = e.target.checked);
  });

  document.getElementById("downloadSelectedBatchesBtn")?.addEventListener("click", async () => {
    const selected = [...document.querySelectorAll(".batch-checkbox:checked")];
    if (selected.length === 0) return alert("Vui lòng chọn ít nhất 1 xe!");
    const rows = [];
    for (const cb of selected) {
      const { id, carrier, date, createddate } = cb.dataset;
      const fromDate = createddate || date;
      await ensureDatesInCache(fromDate, date);
      const orders = Object.values(scanDataCache)
        .filter(day => day.date >= fromDate && day.date <= date)
        .flatMap(day => day.orders || [])
        .filter(o => o.batchId === id && o.carrier === carrier && o.status === STATUS.SUCCESS);
      orders.forEach(o => rows.push({ "Lô/Xe": o.batchId, "DVVC": o.carrier, "Thời gian": formatTime(o.time), "Mã đơn": o.code }));
    }
    exportOrdersToExcel(rows, `BanGiao_NhieuXe_${todayStr()}.xlsx`);
  });

  document.getElementById("exportSelectedDateBtn").onclick = () => {
    if (!historySortedOrders.length) return alert("Không có dữ liệu để xuất!");
    const rows = historySortedOrders.map(o => ({
      "Thời gian": formatTime(o.time),
      "Mã đơn": o.code,
      "DVVC": o.carrier,
      "Lô/Xe": o.batchId || "-",
      "Trạng thái": statusLabel[o.status]
    }));
    exportOrdersToExcel(rows, "bao_cao_kho_tong.xlsx");
  };

  document.getElementById("startScanCameraBtn")?.addEventListener("click", () => startScanPageCamera("1"));
  document.getElementById("startScanCameraBtn2")?.addEventListener("click", () => startScanPageCamera("2"));

  // Tắt camera khi chuyển tab
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isCameraRunning) stopCameraScanner();
    if (document.hidden && isScanCameraRunning) stopScanPageCamera();
  });


  bindCancelScanEvents();
  bindProductivityEvents();
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
    const inputEl = station === "2" ? document.getElementById("orderInput2") : orderInput;
    if (inputEl) { inputEl.disabled = true; inputEl.value = ""; }
    const modal = document.getElementById("noCarrierModal");
    if (modal) {
      const detail = document.getElementById("noCarrierDetail");
      if (detail) detail.textContent = `Vui lòng tạo xe cho [${carrier.toUpperCase()}] trước khi quét tiếp!`;
      modal.style.display = "flex";
      document.getElementById("noCarrierBtn").onclick = () => {
        modal.style.display = "none";
        if (inputEl) { inputEl.disabled = false; inputEl.focus(); }
      };
    }
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
    const batchInfo = duplicateOriginal.batchId ? ` — Lô: ${duplicateOriginal.batchId}` : "";
    showMessage(`⚠️ TRÙNG ĐƠN — Đã quét lúc ${formatTime(duplicateOriginal.time)} (${daysText})${batchInfo}`, "warning", station);
    playTone("warning");
    // Khóa input và bắt xác nhận trước khi quét tiếp
    const inputEl = station === "2" ? document.getElementById("orderInput2") : orderInput;
    if (inputEl) { inputEl.disabled = true; inputEl.value = ""; }
    const modal = document.getElementById("dupConfirmModal");
    if (modal) {
      const detail = document.getElementById("dupConfirmDetail");
      if (detail) {
        const batchText = duplicateOriginal.batchId ? `\nLô/Xe: ${duplicateOriginal.batchId}` : "";
        detail.textContent = `Mã: ${code}\nĐã quét lúc: ${formatTime(duplicateOriginal.time)} (${daysText})${batchText}`;
        detail.style.whiteSpace = "pre-line";
      }
      modal.style.display = "flex";
      document.getElementById("dupConfirmBtn").onclick = () => {
        modal.style.display = "none";
        if (inputEl) { inputEl.disabled = false; inputEl.focus(); }
      };
    }
  } else {
    status = STATUS.SUCCESS;
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success", station);
    playTone("success");
  }

  const newOrder = { code, status, carrier, time: now, batchId: activeBatch ? activeBatch.id : "", station };
  day.orders.push(newOrder);
  scanDataCache[date] = day;
  saveAllData(date, day, newOrder);
  clearTimeout(scanRenderTimer);
  scanRenderTimer = setTimeout(() => {
    renderAll();
    renderBatches("1");
    renderBatches("2");
  }, 300);
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
    // Lấy tất cả lần quét của những mã bị trùng (cả SUCCESS lẫn DUPLICATE)
    const dupCodes = new Set(dOrders.map(o => o.code));
    const allDupOrders = filteredOrders.filter(o => dupCodes.has(o.code));

    // Thêm toàn bộ lịch sử các ngày khác (tối đa 10 ngày trong cache)
    const currentDate = currentFilter.singleDate;
    Object.keys(scanDataCache)
      .filter(d => d !== currentDate)
      .sort().reverse()
      .slice(0, 10)
      .forEach(dateKey => {
        (scanDataCache[dateKey]?.orders || []).forEach(o => {
          if (dupCodes.has(o.code)) allDupOrders.push(o);
        });
      });

    renderHistoryTable(allDupOrders, `Danh sách ĐƠN TRÙNG ngày ${currentFilter.singleDate}`, true);
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

const rowBg = { [STATUS.SUCCESS]: "#f0fdf4", [STATUS.DUPLICATE]: "#fde047", [STATUS.CANCELED]: "#fef2f2" };

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
    tr.style.background = rowBg[o.status] || "";
    const stationLabel = o.station === "2" ? " <span style='font-size:11px;color:#7c3aed;font-weight:bold;'>(Quét 2)</span>" : " <span style='font-size:11px;color:#2563eb;font-weight:bold;'>(Quét 1)</span>";
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${escHtml(o.code)}</td><td>${escHtml(o.carrier)}</td><td>${escHtml(o.batchId || '-')}${stationLabel}</td><td>${statusLabel[o.status]}</td>`;
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
      ? `<strong style="color:#dc2626;">${escHtml(batch.id)}</strong><br><span style="font-size:13px;color:#dc2626;">⚠️ ${escHtml(carrier)} — tạo ngày ${batch.createdDate}</span>`
      : `<strong style="color:blue;">${escHtml(batch.id)}</strong><br><span style="font-size:13px;">${escHtml(carrier)}</span>`;
    const tdCount = document.createElement("td");
    tdCount.style.cssText = "font-size:18px;color:#e11d48;font-weight:bold;";
    const fromDate = batch.createdDate || todayStr();
    const realCount = Object.values(scanDataCache)
      .filter(day => day.date >= fromDate && day.date <= todayStr())
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

window.closeBatch = async function(carrier, station = "1") {
  const batches = station === "2" ? activeBatches2 : activeBatches;
  const batch = batches[carrier];
  if (!batch) { alert(`Lỗi: Không tìm thấy xe cho [${carrier}]. Vui lòng tải lại trang.`); return; }
  if (!confirm(`Bạn có chắc chắn muốn CHỐT xe [${batch.id}] của [${carrier}] không?`)) return;

  const fromDate = batch.createdDate || todayStr();
  // Đảm bảo đủ dữ liệu từ Firebase trước khi đếm — tránh thiếu đơn từ máy khác
  await ensureDatesInCache(fromDate, todayStr());
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
    push(ref(db, CLOSED_BATCH_KEY_2), closedEntry).catch(err => console.error("Lỗi sync closed2:", err));
    set(ref(db, `${ACTIVE_BATCH_KEY_2}/${carrier}`), null).catch(err => console.error("Lỗi xóa active2:", err));
  } else {
    closedBatches = closedBatches.filter(b => !(b.id === batch.id && b.carrier === carrier));
    closedBatches.push(closedEntry);
    localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
    delete activeBatches[carrier];
    localStorage.setItem(ACTIVE_BATCH_LOCAL_KEY, JSON.stringify(activeBatches));
    push(ref(db, CLOSED_BATCH_KEY), closedEntry).catch(err => console.error("Lỗi sync closed:", err));
    set(ref(db, `${ACTIVE_BATCH_KEY}/${carrier}`), null).catch(err => console.error("Lỗi xóa active:", err));
  }

  renderBatches(station);
  const historyDate = document.getElementById("historyDatePicker");
  if (historyDate?.value === todayStr()) renderClosedBatches(todayStr());
  focusOrderInput();
}

async function renderClosedBatches(dateStr) {
  const body = document.getElementById("closedBatchesBody");
  const downloadBtn = document.getElementById("downloadSelectedBatchesBtn");
  const selectAll = document.getElementById("selectAllBatches");
  if (!body) return;

  // Load trạng thái bàn giao từ Firebase — đọc hôm nay + hôm qua vì bàn giao thường trong 2 ngày
  try {
    const today = todayStr();
    const yesterday = localDateStr(new Date(Date.now() - 86400000));
    const [s1, s2] = await Promise.all([
      get(ref(db, `${HANDOVER_KEY}/${today}`)),
      get(ref(db, `${HANDOVER_KEY}/${yesterday}`))
    ]);
    handoverCache = { ...(s1.exists() ? s1.val() : {}), ...(s2.exists() ? s2.val() : {}) };
  } catch(e) { handoverCache = {}; }

  // Bind filter buttons
  document.querySelectorAll(".dvvc-filter-btn").forEach(btn => {
    btn.onclick = () => {
      closedBatchCarrierFilter = btn.dataset.dvvc;
      document.querySelectorAll(".dvvc-filter-btn").forEach(b => {
        const active = b.dataset.dvvc === closedBatchCarrierFilter;
        b.style.background = active ? "#10b981" : "#fff";
        b.style.color = active ? "#fff" : "#374151";
        b.style.borderColor = active ? "#10b981" : "#94a3b8";
      });
      renderClosedBatches(dateStr);
    };
  });

  let batchesForDate = [...closedBatches, ...closedBatches2].filter(b => b.date === dateStr);
  if (closedBatchCarrierFilter !== "all") batchesForDate = batchesForDate.filter(b => b.carrier === closedBatchCarrierFilter);

  body.innerHTML = "";
  if (downloadBtn) downloadBtn.style.display = "none";
  if (selectAll) selectAll.checked = false;
  if (batchesForDate.length === 0) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;">Không có xe nào được chốt trong ngày này</td></tr>`;
    return;
  }
  if (downloadBtn) downloadBtn.style.display = "inline-block";
  [...batchesForDate].reverse().forEach(b => {
    const handover = Object.values(handoverCache).find(h => h.batchId === b.id && h.carrier === b.carrier);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="batch-checkbox" data-id="${escHtml(b.id)}" data-carrier="${escHtml(b.carrier)}" data-date="${b.date}" data-createddate="${b.createdDate || b.date}"></td>
      <td><strong>${escHtml(b.carrier)}</strong></td>
      <td style="color:blue;font-weight:bold;">${escHtml(b.id)}</td>
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
    pdfBtn.style.cssText = "background:#7c3aed;color:white;padding:6px 12px;border:none;border-radius:4px;cursor:pointer;margin-right:6px;";
    pdfBtn.onclick = () => exportBatchPDF(b.id, b.carrier, b.date, b.createdDate || b.date);

    // Nút Đã Bàn Giao
    const bgBtn = document.createElement("button");
    if (handover) {
      const d = new Date(handover.time);
      const label = `✅ BG lúc ${d.toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})} ${d.toLocaleDateString("vi-VN")}`;
      bgBtn.textContent = label;
      bgBtn.style.cssText = "background:#dcfce7;color:#15803d;padding:6px 12px;border:1.5px solid #86efac;border-radius:4px;cursor:default;font-weight:600;";
      bgBtn.disabled = true;
    } else {
      bgBtn.textContent = "🤝 Đã Bàn Giao";
      bgBtn.style.cssText = "background:#f0fdf4;color:#16a34a;padding:6px 12px;border:1.5px solid #86efac;border-radius:4px;cursor:pointer;font-weight:600;";
      bgBtn.onclick = async () => {
        if (!confirm(`Xác nhận bàn giao lô ${b.id} (${b.carrier})?`)) return;
        const handoverDate = todayStr();
        const record = { batchId: b.id, carrier: b.carrier, closedDate: dateStr, time: new Date().toISOString() };
        try {
          await push(ref(db, `${HANDOVER_KEY}/${handoverDate}`), record);
          handoverCache[record.time] = record;
          const d = new Date(record.time);
          bgBtn.textContent = `✅ BG lúc ${d.toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})} ${d.toLocaleDateString("vi-VN")}`;
          bgBtn.style.cssText = "background:#dcfce7;color:#15803d;padding:6px 12px;border:1.5px solid #86efac;border-radius:4px;cursor:default;font-weight:600;";
          bgBtn.disabled = true;
        } catch(e) { alert("Lỗi lưu bàn giao, thử lại!"); }
      };
    }

    actionTd.appendChild(dlBtn);
    actionTd.appendChild(pdfBtn);
    actionTd.appendChild(bgBtn);
    body.appendChild(tr);
  });
}

window.downloadBatch = async function(batchId, carrier, dateStr, createdDate) {
  const fromDate = createdDate || dateStr;
  await ensureDatesInCache(fromDate, dateStr);
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

const HISTORY_PAGE_SIZE = 100;
let historySortedOrders = [];
let historyGroupByCode = false;
let historyShownCount = 0;

function renderHistoryTable(orders, title, groupByCode = false) {
  historyDetailBody.innerHTML = "";
  historyTitle.innerHTML = `${title} <br> <span style="color:#ee4d2d;font-size:20px;font-weight:bold;">📊 TỔNG CỘNG: ${orders.length} ĐƠN</span>`;

  historySortedOrders = groupByCode
    ? [...orders].sort((a, b) => a.code.localeCompare(b.code))
    : [...orders].reverse();
  historyGroupByCode = groupByCode;
  historyShownCount = 0;
  appendHistoryRows();
}

function appendHistoryRows() {
  const palette = ["#fde68a","#bbf7d0","#bfdbfe","#fecaca","#ddd6fe","#fed7aa","#a7f3d0","#fda4af","#e9d5ff","#99f6e4"];
  const codeColorMap = {};
  let colorIdx = 0;

  // Remove existing load-more button if any
  document.getElementById("historyLoadMoreBtn")?.remove();

  const slice = historySortedOrders.slice(historyShownCount, historyShownCount + HISTORY_PAGE_SIZE);
  slice.forEach(o => {
    const tr = document.createElement("tr");
    if (historyGroupByCode) {
      if (!(o.code in codeColorMap)) codeColorMap[o.code] = palette[colorIdx++ % palette.length];
      tr.style.background = codeColorMap[o.code];
    } else {
      tr.className = statusClass[o.status];
    }
    const stationLabel = o.station === "2" ? " <span style='font-size:11px;color:#7c3aed;font-weight:bold;'>(Quét 2)</span>" : " <span style='font-size:11px;color:#2563eb;font-weight:bold;'>(Quét 1)</span>";
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${escHtml(o.code)}</td><td>${escHtml(o.carrier)}</td><td>${escHtml(o.batchId || '-')}${stationLabel}</td><td>${statusLabel[o.status]}</td>`;
    historyDetailBody.appendChild(tr);
  });
  historyShownCount += slice.length;

  const remaining = historySortedOrders.length - historyShownCount;
  if (remaining > 0) {
    const btn = document.createElement("tr");
    btn.id = "historyLoadMoreBtn";
    btn.innerHTML = `<td colspan="5" style="text-align:center;padding:12px;">
      <button style="background:#ee4d2d;color:white;border:none;border-radius:6px;padding:8px 24px;font-size:14px;font-weight:bold;cursor:pointer;">
        Xem thêm ${Math.min(remaining, HISTORY_PAGE_SIZE)} đơn (còn ${remaining})
      </button></td>`;
    btn.querySelector("button").onclick = appendHistoryRows;
    historyDetailBody.appendChild(btn);
  }
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
  const rawOrders = (Array.isArray(raw) ? raw : Object.values(raw)).filter(o => o && o.code && o.time);
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
  // Debounce IDB 1 giây — tránh ghi lại 10k đơn mỗi lần quét cuối ngày
  clearTimeout(idbSaveTimer);
  idbSaveTimer = setTimeout(() => idbSaveDay(dayData).catch(e => console.error("IDB save error:", e)), 1000);
  if (dayData.orders.length === 1) set(ref(db, `${FIREBASE_SCAN_KEY}/${date}/date`), date).catch(() => {});
  push(ref(db, `${FIREBASE_SCAN_KEY}/${date}/orders`), newOrder).catch(e => console.error("Firebase push error:", e));
}

async function idbSearchOrders(terms) {
  const idb = await openIDB();
  return new Promise(resolve => {
    const results = [];
    const req = idb.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        (cursor.value?.orders || []).forEach(o => {
          if (o && terms.some(t => o.code.toLowerCase().includes(t))) results.push(o);
        });
        cursor.continue();
      } else resolve(results);
    };
    req.onerror = () => resolve([]);
  });
}

async function ensureDatesInCache(fromDate, toDate) {
  const d = new Date(fromDate);
  while (localDateStr(d) <= toDate) {
    const ds = localDateStr(d);
    if (!scanDataCache[ds]) {
      try {
        const snap = await get(ref(db, `${FIREBASE_SCAN_KEY}/${ds}`));
        scanDataCache[ds] = snap.exists() ? firebaseDayToLocal(snap.val(), ds) : { date: ds, orders: [] };
        if (snap.exists()) idbSaveDay(scanDataCache[ds]);
      } catch(e) {}
    }
    d.setDate(d.getDate() + 1);
  }
}

function initTimeSelects() {
  const p = n => String(n).padStart(2, "0");
  const from = document.getElementById("fromTime");
  const to = document.getElementById("toTime");
  if (!from || !to) return;
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      from.innerHTML += `<option value="${p(h)}:${p(m)}">${p(h)}:${p(m)}</option>`;
      const em = m === 0 ? 29 : 59;
      to.innerHTML += `<option value="${p(h)}:${p(em)}">${p(h)}:${p(em)}</option>`;
    }
  }
}

function getDayOrders(date) { return scanDataCache[date]?.orders || []; }
function getTodayOrdersByStation(date, station) {
  const orders = getDayOrders(date);
  if (station === "2") return orders.filter(o => o.station === "2");
  return orders.filter(o => !o.station || o.station === "1");
}

function parseTimeInput(val) {
  if (!val) return null;
  const m = val.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]), min = parseInt(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function getOrdersByFilter(filter) {
  const dates = Object.keys(scanDataCache);
  let selectedDates = filter.mode === "range" && filter.fromDate && filter.toDate
    ? dates.filter(d => d >= filter.fromDate && d <= filter.toDate)
    : dates.filter(d => d === filter.singleDate);
  let orders = selectedDates.flatMap(d => scanDataCache[d]?.orders || []);
  const from = parseTimeInput(filter.fromTime);
  const to = parseTimeInput(filter.toTime);
  if (from !== null || to !== null) {
    orders = orders.filter(o => {
      const d = new Date(o.time);
      const hm = d.getHours() * 60 + d.getMinutes();
      if (from !== null && hm < from) return false;
      if (to !== null && hm > to) return false;
      return true;
    });
  }
  return orders;
}

function detectCarrier(code) {
  const upper = code.toUpperCase();
  if (upper.startsWith("8")) return "J&T";
  if (upper.startsWith("SPX")) return "Shopee Express";
  if (upper.startsWith("G")) return "GHN";
  if (upper.startsWith("VTP")) return "Viettel Post";
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
  if (pageId === "dashboardPage") { renderAll(); renderProductivitySection(); }
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
function saveCancelledSet(list) { const unique = [...new Set(list)]; localStorage.setItem(CANCELED_KEY, JSON.stringify(unique)); set(ref(db, CANCELED_KEY), unique).catch(err => console.error("Lỗi lưu đơn hủy:", err)); }
function loadCancelledToTextarea() { cancelledInput.value = [...getCancelledSet()].join("\n"); loadCancelledCount(); }
function loadCancelledCount() { cancelledCount.textContent = getCancelledSet().size; }
function normalizeCodes(text) { return text.split(/\r?\n/).map(x => x.trim()).filter(Boolean); }

// Loại bỏ dấu tiếng Việt (fallback khi gõ tay)
function normalizeBarcode(raw) {
  return raw.trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toUpperCase();
}

// Đọc từ e.code (mã phím vật lý) — không bị Unikey/Telex can thiệp
// Barcode scanner luôn dùng layout US QWERTY
const _BARCODE_KEY_MAP = (() => {
  const m = {};
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(c => { m['Key' + c] = c; });
  '0123456789'.split('').forEach((c, i) => { m['Digit' + i] = c; m['Numpad' + i] = c; });
  Object.assign(m, { Minus: '-', Period: '.', Slash: '/' });
  return m;
})();

function setupBarcodeInput(inputEl, onScan) {
  if (!inputEl) return;
  let buf = '';
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      const code = buf || normalizeBarcode(inputEl.value);
      buf = '';
      inputEl.value = '';
      if (code) onScan(code);
    } else if (e.code === 'Backspace') {
      buf = buf.slice(0, -1);
    } else if (_BARCODE_KEY_MAP[e.code] !== undefined) {
      buf += _BARCODE_KEY_MAP[e.code];
    }
  });
  // Clear buffer khi blur (mất focus) hoặc focus (re-enable sau trùng đơn)
  inputEl.addEventListener('blur', () => { buf = ''; });
  inputEl.addEventListener('focus', () => { buf = ''; });
}
function showMessage(text, type, station = "1") {
  const msgEl = station === "2" ? document.getElementById("scanMessage2") : scanMessage;
  if (msgEl) { msgEl.className = `message ${type}`; msgEl.textContent = text; }
  const camMsg = document.getElementById("scanCamMsgEl");
  if (camMsg) {
    camMsg.style.display = "block";
    camMsg.style.background = type === "success" ? "#f0fdf4" : type === "warning" ? "#fefce8" : "#fef2f2";
    camMsg.style.color = type === "success" ? "#15803d" : type === "warning" ? "#a16207" : "#b91c1c";
    camMsg.style.fontSize = "20px";
    camMsg.style.padding = "14px 16px";
    camMsg.style.whiteSpace = "pre-line";
    camMsg.textContent = text;
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

// AudioContext — phát âm thanh trong async callback (iOS camera)
let audioCtx = null;
const audioBuffers = {};

async function ensureAudioContext() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    for (const [key, url] of [["success","di.wav"],["warning","dontrung.wav"],["error","donhuy.wav"]]) {
      if (audioBuffers[key]) continue;
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      audioBuffers[key] = await audioCtx.decodeAudioData(buf);
    }
  } catch(e) {}
}

function playWithCtx(kind) {
  if (!audioCtx || !audioBuffers[kind]) return false;
  try {
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffers[kind];
    src.connect(audioCtx.destination);
    src.start();
    return true;
  } catch(e) { return false; }
}

function playTone(kind, speakText, volume = 1.0) {
  if (playWithCtx(kind)) {
    if (speakText) setTimeout(() => speak(speakText), 300);
    return;
  }
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

function subscribeToTodayScan() {
  if (unsubscribeTodayScan) unsubscribeTodayScan();
  const todayKey = todayStr();
  const localOrders = scanDataCache[todayKey]?.orders || [];
  const lastTime = localOrders.length
    ? localOrders.reduce((max, o) => (o.time > max ? o.time : max), "")
    : "";
  const ordersRef = ref(db, `${FIREBASE_SCAN_KEY}/${todayKey}/orders`);
  // Trừ 30 phút để bù lệch đồng hồ giữa các máy — duplicate sẽ bị lọc bởi alreadyExists
  const bufferedTime = lastTime
    ? new Date(new Date(lastTime).getTime() - 30 * 60 * 1000).toISOString()
    : "";
  const ordersQuery = bufferedTime
    ? query(ordersRef, orderByChild("time"), startAfter(bufferedTime))
    : ordersRef;
  let renderTimer = null;
  unsubscribeTodayScan = onChildAdded(ordersQuery, (snapshot) => {
    const order = snapshot.val();
    if (!order || !order.code || !order.time) return;
    const localDay = scanDataCache[todayKey] || { date: todayKey, orders: [] };
    const alreadyExists = localDay.orders.some(o => o.code === order.code && o.time === order.time);
    if (!alreadyExists) {
      localDay.orders.push(order);
      scanDataCache[todayKey] = localDay;
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => {
        idbSaveDay(localDay);
        renderBatches("1");
        renderBatches("2");
        renderTodayList(getTodayOrdersByStation(todayKey, "1"), "todayScannedBody", "loadMoreTodayBtn", showAllTodayOrders, () => { showAllTodayOrders = true; });
        renderTodayList(getTodayOrdersByStation(todayKey, "2"), "todayScannedBody2", "loadMoreTodayBtn2", showAllTodayOrders2, () => { showAllTodayOrders2 = true; });
      }, 300);
    }
  });
}

function scheduleMidnightReset() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  // +3 giây buffer để đơn quét lúc 23:59:59 kịp được ghi trước khi reset
  setTimeout(() => {
    subscribeToTodayScan();
    const newDay = todayStr();
    document.getElementById("singleDate").value = newDay;
    currentFilter = { mode: "single", singleDate: newDay };
    showAllTodayOrders = false;
    showAllTodayOrders2 = false;
    scheduleMidnightReset();
  }, nextMidnight - now + 3000);
}

// === SYNC OFFLINE DATA LÊN FIREBASE ===
// So sánh IDB local vs Firebase, ngày nào local nhiều hơn thì đẩy lên
// Throttle 30 phút, persist qua localStorage để không reset khi reload trang
async function syncLocalToFirebase() {
  const now = Date.now();
  if (now - lastSyncTs < 30 * 60 * 1000) return;
  const prevSyncTs = lastSyncTs;
  lastSyncTs = now;
  localStorage.setItem("warehouse_last_sync_ts", String(lastSyncTs));

  const dates = Object.keys(scanDataCache)
    .filter(d => d < todayStr() && (scanDataCache[d]?.orders?.length || 0) > 0)
    .sort().reverse().slice(0, now - prevSyncTs > 24 * 60 * 60 * 1000 ? 7 : 2);
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
      }
    });
  } catch (e) {
    console.error("Lỗi syncLocalToFirebase:", e);
  }
}

// === TRA CỨU ĐƠN HỦY XE ===
async function findOrderInBatch(code) {
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
  // Fallback: tìm thẳng trong IDB nếu cache chưa có
  if (!foundOrder) {
    const idbResults = await idbSearchOrders([code.toLowerCase()]);
    const hit = idbResults.find(o => o.code === code && o.status === STATUS.SUCCESS);
    if (hit) {
      foundOrder = hit;
      foundDate = localDateStr(new Date(hit.time));
      // Load ngày đó vào cache để dùng tiếp
      if (!scanDataCache[foundDate]) {
        try {
          const snap = await get(ref(db, `${FIREBASE_SCAN_KEY}/${foundDate}`));
          if (snap.exists()) { scanDataCache[foundDate] = firebaseDayToLocal(snap.val(), foundDate); }
        } catch(e) {}
      }
    }
  }
  if (!foundOrder) return { found: false, code };

  const { batchId, carrier } = foundOrder;
  if (!batchId) return { found: true, code, batchId: "-", carrier, stt: "-", total: "-" };

  const closedBatch = [...closedBatches, ...closedBatches2].find(b => b.id === batchId && b.carrier === carrier);
  const activeBatch = (activeBatches[carrier]?.id === batchId ? activeBatches[carrier] : null)
    || (activeBatches2[carrier]?.id === batchId ? activeBatches2[carrier] : null);
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

async function handleCancelScan(code) {
  if (!code) return;
  if (cancelScanList.some(r => r.code === code)) {
    showCancelScanMsg(`⚠️ Mã ${code} đã quét rồi!`, "#f59e0b");
    return;
  }
  const result = await findOrderInBatch(code);
  cancelScanList.unshift(result);
  renderCancelScanResults();
  updateCamCount();
  saveCancelReturn(true);
  if (result.found) {
    const sttText = result.stt !== "-" ? `STT ${result.stt}/${result.total}` : "";
    const batchText = result.batchId !== "-" ? `Lô: ${result.batchId}` : "";
    const extra = [batchText, sttText].filter(Boolean).join(" — ");
    showCancelScanMsg(`✅ ${code}${extra ? "\n" + extra : ""}`, "#10b981");
    playTone("success");
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
    el.style.whiteSpace = "pre-line";
    el.style.fontSize = "20px";
    el.style.padding = "14px 16px";
    el.textContent = text;
  }
  const camMsg = document.getElementById("camMsgEl");
  if (camMsg) {
    camMsg.style.display = "block";
    camMsg.style.background = color + "20";
    camMsg.style.color = color;
    camMsg.style.whiteSpace = "pre-line";
    camMsg.style.fontSize = "20px";
    camMsg.style.padding = "14px 16px";
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
  setupBarcodeInput(document.getElementById("cancelScanInput"), handleCancelScan);
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
    loadAndRenderCancelReturns(e.target.value).catch(err => console.error("Lỗi load cancel returns:", err));
  });

  document.getElementById("cancelReturnSearchBtn")?.addEventListener("click", async () => {
    const raw = document.getElementById("cancelReturnSearchInput")?.value.trim();
    const resultWrap = document.getElementById("cancelReturnSearchResult");
    if (!raw || !resultWrap) return;

    const codes = new Set(raw.split(/[\n,\s]+/).map(c => c.trim().toUpperCase()).filter(Boolean));
    if (codes.size === 0) return;

    resultWrap.style.display = "block";
    resultWrap.innerHTML = `<p style="color:#64748b;font-size:13px;">⏳ Đang tìm ${codes.size} mã...</p>`;

    // Fetch toàn bộ lịch sử cancel return 1 lần duy nhất trong session
    if (!cancelReturnCacheLoaded) {
      resultWrap.innerHTML = `<p style="color:#64748b;font-size:13px;">⏳ Đang tải toàn bộ lịch sử đơn hủy...</p>`;
      try {
        const snap = await get(ref(db, CANCEL_RETURN_KEY));
        if (snap.exists()) {
          const allData = snap.val();
          Object.entries(allData).forEach(([date, data]) => {
            cancelReturnCache[date] = data;
          });
        }
      } catch(e) {}
      cancelReturnCacheLoaded = true;
    }

    // Tìm trong toàn bộ cache
    const found = [];
    const foundCodes = new Set();
    Object.entries(cancelReturnCache).forEach(([date, data]) => {
      parseCancelReturnData(data).forEach(o => {
        if (codes.has((o.code || "").toUpperCase())) {
          found.push({ ...o, date });
          foundCodes.add((o.code || "").toUpperCase());
        }
      });
    });

    // Mã không tìm thấy
    const notFound = [...codes].filter(c => !foundCodes.has(c));

    // Render kết quả
    let html = `<p style="font-weight:bold;margin:0 0 8px;color:#1e293b;">Kết quả: ${found.length} tìm thấy / ${notFound.length} không thấy</p>`;
    if (found.length > 0) {
      html += `<table style="font-size:13px;width:100%;border-collapse:collapse;margin-bottom:10px;">
        <thead><tr style="background:#fef2f2;">
          <th style="padding:6px 8px;text-align:left;">Mã đơn</th>
          <th style="padding:6px 8px;">Ngày</th>
          <th style="padding:6px 8px;">Lô/Xe</th>
          <th style="padding:6px 8px;">DVVC</th>
          <th style="padding:6px 8px;">STT biên bản</th>
        </tr></thead><tbody>`;
      found.forEach(o => {
        const sttText = o.found === false ? '❌ Không tìm thấy' : `${o.stt} / ${o.total}`;
        html += `<tr style="border-bottom:1px solid #fee2e2;">
          <td style="padding:6px 8px;font-weight:bold;">${escHtml(o.code)}</td>
          <td style="padding:6px 8px;text-align:center;">${o.date || '-'}</td>
          <td style="padding:6px 8px;text-align:center;color:#2563eb;font-weight:bold;">${escHtml(o.batchId || '-')}</td>
          <td style="padding:6px 8px;text-align:center;">${escHtml(o.carrier || '-')}</td>
          <td style="padding:6px 8px;text-align:center;color:#dc2626;font-weight:bold;">${escHtml(String(sttText))}</td>
        </tr>`;
      });
      html += `</tbody></table>`;
    }
    if (notFound.length > 0) {
      html += `<div style="background:#fef9c3;border-radius:6px;padding:8px 12px;font-size:13px;">
        <b>❌ Không tìm thấy trong 30 ngày gần nhất:</b><br>
        <span style="color:#92400e;">${notFound.map(c => escHtml(c)).join(', ')}</span>
      </div>`;
    }
    resultWrap.innerHTML = html;
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
  ensureAudioContext();

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
    { fps: 25, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(h * 0.5) }), videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
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

// Đọc cả format cũ {orders:[]} và format mới {[code]: entry} — backward compatible
function parseCancelReturnData(raw) {
  if (!raw) return [];
  const map = new Map();
  const ordersRaw = raw.orders;
  const ordersArr = Array.isArray(ordersRaw) ? ordersRaw : (ordersRaw && typeof ordersRaw === 'object' ? Object.values(ordersRaw) : []);
  ordersArr.forEach(o => { if (o?.code) map.set(o.code, o); });
  Object.entries(raw).forEach(([k, v]) => {
    if (k !== 'date' && k !== 'orders' && v?.code) map.set(v.code, v);
  });
  return [...map.values()];
}

async function saveCancelReturn(silent = false) {
  const toSave = cancelScanList;
  if (toSave.length === 0) { if (!silent) alert("Chưa có đơn nào để lưu!"); return; }
  const date = todayStr();
  const now = new Date().toISOString();
  // Fetch từ Firebase trước nếu cache chưa có
  if (!cancelReturnCache[date]) {
    try {
      const snap = await get(ref(db, `${CANCEL_RETURN_KEY}/${date}`));
      if (snap.exists()) cancelReturnCache[date] = snap.val();
    } catch (e) {}
  }
  const existing = parseCancelReturnData(cancelReturnCache[date]);
  const existingFoundCodes = new Set(existing.filter(o => o.found !== false).map(o => o.code));
  const existingNotFoundCodes = new Set(existing.filter(o => o.found === false).map(o => o.code));
  const newEntries = toSave.filter(r => {
    if (existingFoundCodes.has(r.code)) return false;
    if (existingNotFoundCodes.has(r.code) && r.found === false) return false;
    return true;
  }).map(r => ({ code: r.code, found: r.found !== false, batchId: r.batchId || "-", carrier: r.carrier || "-", stt: r.stt || "-", total: r.total || "-", time: now }));
  if (newEntries.length === 0) { if (!silent) showCancelScanMsg("⚠️ Tất cả đơn đã được lưu trước đó!", "#f59e0b"); return; }
  // Ghi từng đơn theo code riêng — 2 điện thoại không đè nhau khi ghi cùng lúc
  if (!cancelReturnCache[date]) cancelReturnCache[date] = {};
  try {
    await Promise.all(newEntries.map(e => {
      cancelReturnCache[date][e.code] = e;
      return set(ref(db, `${CANCEL_RETURN_KEY}/${date}/${e.code}`), e);
    }));
    if (!silent) showCancelScanMsg(`✅ Đã lưu ${newEntries.length} đơn hủy ngày ${date}`, "#10b981");
    const picker = document.getElementById("cancelReturnDatePicker");
    if (picker?.value === date) loadAndRenderCancelReturns(date);
  } catch (err) {
    if (!silent) showCancelScanMsg("❌ Lỗi lưu Firebase, vui lòng thử lại!", "#ef4444");
  }
}

async function loadAndRenderCancelReturns(date) {
  const body = document.getElementById("cancelReturnBody");
  const title = document.getElementById("cancelReturnTitle");
  const filterEl = document.getElementById("cancelReturnCarrierFilter");
  if (!body || !title) return;
  if (!cancelReturnCache[date]) {
    try {
      const snap = await get(ref(db, `${CANCEL_RETURN_KEY}/${date}`));
      if (snap.exists()) cancelReturnCache[date] = snap.val();
    } catch (e) {}
  }
  const orders = parseCancelReturnData(cancelReturnCache[date]);
  const NOT_FOUND_KEY = "__notfound__";
  const carriers = [...new Set(orders.filter(o => o.found !== false && o.carrier && o.carrier !== '-').map(o => o.carrier))].sort();
  const hasNotFound = orders.some(o => o.found === false);
  const allKeys = [...carriers, ...(hasNotFound ? [NOT_FOUND_KEY] : [])];
  let selectedCarriers = new Set(allKeys);

  const exportBtn = document.getElementById("exportCancelReturnBtn");

  function renderTable() {
    const showNotFound = selectedCarriers.has(NOT_FOUND_KEY);
    const filtered = orders.filter(o =>
      o.found === false ? showNotFound : selectedCarriers.has(o.carrier)
    );
    title.textContent = orders.length === 0
      ? "Không có đơn hủy trả về trong ngày này"
      : `Đơn Hủy Trả Về: ${filtered.length} đơn${filtered.length < orders.length ? ` / ${orders.length} tổng` : ""}`;
    if (exportBtn) {
      exportBtn.style.display = filtered.length > 0 ? "inline-block" : "none";
      exportBtn.onclick = () => {
        exportOrdersToExcel(
          filtered.map((o, i) => ({
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
    if (filtered.length === 0) {
      body.innerHTML = `<tr><td colspan="6" style="text-align:center;">${orders.length === 0 ? "Không có đơn hủy trả về trong ngày này" : "Không có đơn nào khớp với bộ lọc"}</td></tr>`;
      return;
    }
    filtered.forEach((o, i) => {
      const tr = document.createElement("tr");
      tr.style.background = o.found === false ? "#fef2f2" : "";
      const timeStr = o.time ? formatTime(o.time) : "-";
      tr.innerHTML = o.found === false
        ? `<td>${i + 1}</td><td>${timeStr}</td><td><b>${o.code}</b></td><td colspan="3" style="color:#ef4444;">❌ Không tìm thấy trong 10 ngày gần nhất</td>`
        : `<td>${i + 1}</td><td>${timeStr}</td><td><b>${o.code}</b></td><td style="color:blue;font-weight:bold;">${o.batchId}</td><td>${o.carrier}</td><td style="color:#e11d48;font-weight:bold;">STT ${o.stt} <span style="color:#64748b;font-size:12px;font-weight:normal;">/ ${o.total} đơn</span></td>`;
      body.appendChild(tr);
    });
  }

  if (filterEl) {
    filterEl.innerHTML = "";
    const showFilter = allKeys.length > 1;
    if (showFilter) {
      filterEl.style.display = "flex";
      const chipStyle = (active, isNF = false) =>
        `padding:5px 14px;border:none;border-radius:20px;cursor:pointer;font-size:13px;font-weight:bold;transition:all .15s;background:${active ? (isNF ? '#ef4444' : '#10b981') : '#e2e8f0'};color:${active ? 'white' : '#475569'};`;
      const allBtn = document.createElement("button");
      allBtn.textContent = "Tất cả";
      allBtn.style.cssText = chipStyle(true);
      allBtn.onclick = () => {
        selectedCarriers = new Set(allKeys);
        filterEl.querySelectorAll("[data-carrier]").forEach(b => {
          const isNF = b.dataset.carrier === NOT_FOUND_KEY;
          b.style.cssText = chipStyle(true, isNF);
        });
        allBtn.style.cssText = chipStyle(true);
        renderTable();
      };
      filterEl.appendChild(allBtn);
      allKeys.forEach(c => {
        const isNF = c === NOT_FOUND_KEY;
        const btn = document.createElement("button");
        btn.dataset.carrier = c;
        btn.textContent = isNF ? "Không xác định" : c;
        btn.style.cssText = chipStyle(true, isNF);
        btn.onclick = () => {
          if (selectedCarriers.has(c)) selectedCarriers.delete(c); else selectedCarriers.add(c);
          btn.style.cssText = chipStyle(selectedCarriers.has(c), isNF);
          allBtn.style.cssText = chipStyle(selectedCarriers.size === allKeys.length);
          renderTable();
        };
        filterEl.appendChild(btn);
      });
    } else {
      filterEl.style.display = "none";
    }
  }

  renderTable();
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

  ensureAudioContext();
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
    { fps: 25, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(h * 0.5) }), videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
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
      <p style="margin:0 0 14px;font-size:13px;color:#888;">Xe: <b>${escHtml(batchId)}</b> &bull; ${escHtml(carrier)} &bull; ${dateStr} &bull; <b>${orders.length} đơn</b></p>
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

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// === ĐO SẢN LƯỢNG CA LÀM ===
function renderProductivitySection() {
  const setup = document.getElementById("prodSetup");
  const form = document.getElementById("prodForm");
  const live = document.getElementById("prodLive");
  const summary = document.getElementById("prodSummary");
  if (!setup) return;
  clearInterval(productivityLiveTimer);
  productivityLiveTimer = null;
  if (!productivitySession) {
    setup.style.display = "block";
    form.style.display = "none";
    live.style.display = "none";
    if (summary) summary.style.display = "none";
  } else if (productivitySession._pending) {
    setup.style.display = "none";
    form.style.display = "none";
    live.style.display = "none";
    if (summary) summary.style.display = "block";
  } else {
    setup.style.display = "none";
    form.style.display = "none";
    live.style.display = "block";
    if (summary) summary.style.display = "none";
    const { fullTime, partTime } = productivitySession;
    const staffEl = document.getElementById("liveStaff");
    const staffDetail = document.getElementById("liveStaffDetail");
    if (staffEl) staffEl.textContent = fullTime + partTime;
    if (staffDetail) staffDetail.textContent = `CT: ${fullTime} / TV: ${partTime}`;
    updateProductivityLive();
    productivityLiveTimer = setInterval(updateProductivityLive, 10000);
  }
}

function updateProductivityLive() {
  if (!productivitySession) return;
  const { startTime, plannedEndTime, sessionDate } = productivitySession;
  const startTs = new Date(startTime).getTime();

  // Tự kết thúc và tự lưu khi đến giờ đã đặt
  if (plannedEndTime && !productivitySession._pending) {
    if (Date.now() >= new Date(plannedEndTime).getTime()) {
      clearInterval(productivityLiveTimer);
      productivityLiveTimer = null;
      autoEndAndSaveProductivity();
      return;
    }
  }

  const nowTs = Date.now();
  const upperTs = plannedEndTime ? Math.min(new Date(plannedEndTime).getTime(), nowTs) : nowTs;
  const elapsed = upperTs - startTs;
  const h = Math.floor(elapsed / 3600000);
  const m = Math.floor((elapsed % 3600000) / 60000);
  const elapsedEl = document.getElementById("liveElapsed");
  if (elapsedEl) elapsedEl.textContent = `${h}h ${m}m`;
  const dayOrders = scanDataCache[sessionDate]?.orders || [];
  const count = dayOrders.filter(o => { const t = new Date(o.time).getTime(); return o.status === STATUS.SUCCESS && t >= startTs && t <= upperTs; }).length;
  const totalStaff = productivitySession.fullTime + productivitySession.partTime;
  const avg = totalStaff > 0 ? (count / totalStaff).toFixed(1) : "0";
  const ordersEl = document.getElementById("liveOrders");
  const avgEl = document.getElementById("liveAvg");
  if (ordersEl) ordersEl.textContent = count;
  if (avgEl) avgEl.textContent = avg;
}

function bindProductivityEvents() {
  document.getElementById("prodStartBtn")?.addEventListener("click", () => {
    document.getElementById("prodSetup").style.display = "none";
    document.getElementById("prodForm").style.display = "block";
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    document.getElementById("sessionStartTime").value = `${hh}:${mm}`;
    document.getElementById("sessionEndTime").value = "";
    document.getElementById("sessionFullTime").value = "";
    document.getElementById("sessionPartTime").value = "";
  });

  document.getElementById("prodCancelFormBtn")?.addEventListener("click", () => {
    document.getElementById("prodForm").style.display = "none";
    if (productivitySession) {
      document.getElementById("prodLive").style.display = "block";
      updateProductivityLive();
      productivityLiveTimer = setInterval(updateProductivityLive, 10000);
    } else {
      document.getElementById("prodSetup").style.display = "block";
    }
  });

  document.getElementById("prodConfirmBtn")?.addEventListener("click", () => {
    const startVal = document.getElementById("sessionStartTime").value.trim();
    const endVal = document.getElementById("sessionEndTime").value.trim();
    const fullTime = parseInt(document.getElementById("sessionFullTime").value) || 0;
    const partTime = parseInt(document.getElementById("sessionPartTime").value) || 0;
    if (!startVal || !/^\d{1,2}:\d{2}$/.test(startVal)) return alert("Vui lòng nhập giờ bắt đầu đúng định dạng (VD: 08:00)!");
    if (fullTime + partTime === 0) return alert("Vui lòng nhập số nhân viên!");
    const today = todayStr();
    const [sh, sm] = startVal.split(":").map(Number);
    const startTime = new Date(`${today}T${String(sh).padStart(2,"0")}:${String(sm).padStart(2,"0")}:00`).toISOString();
    let plannedEndTime = null;
    if (endVal && /^\d{1,2}:\d{2}$/.test(endVal)) {
      const [eh, em] = endVal.split(":").map(Number);
      plannedEndTime = new Date(`${today}T${String(eh).padStart(2,"0")}:${String(em).padStart(2,"0")}:00`).toISOString();
    }
    const wasOwner = !productivitySession || productivitySession.owner === true;
    productivitySession = { startTime, plannedEndTime, fullTime, partTime, sessionDate: today, owner: wasOwner };
    localStorage.setItem("warehouse_active_session", JSON.stringify(productivitySession));
    const { owner: _o1, ...sessionForFb1 } = productivitySession;
    set(ref(db, `${PRODUCTIVITY_KEY}/currentSession`), sessionForFb1).catch(() => {});
    renderProductivitySection();
  });

  document.getElementById("prodEndBtn")?.addEventListener("click", () => {
    if (!productivitySession) return;
    clearInterval(productivityLiveTimer);
    productivityLiveTimer = null;
    const { startTime, plannedEndTime, sessionDate, fullTime, partTime } = productivitySession;
    const startTs = new Date(startTime).getTime();
    const endTs = plannedEndTime ? new Date(plannedEndTime).getTime() : Date.now();
    const dayOrders = scanDataCache[sessionDate]?.orders || [];
    const totalOrders = dayOrders.filter(o => { const t = new Date(o.time).getTime(); return o.status === STATUS.SUCCESS && t >= startTs && t <= endTs; }).length;
    const totalStaff = fullTime + partTime;
    const avgOrders = totalStaff > 0 ? parseFloat((totalOrders / totalStaff).toFixed(1)) : 0;
    const elapsed = endTs - startTs;
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const startLabel = new Date(startTime).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const endLabel = new Date(endTs).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

    const content = document.getElementById("prodSummaryContent");
    if (content) content.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
        <div style="background:#f5f3ff;border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:#7c3aed;font-weight:bold;">THỜI GIAN</div>
          <div style="font-size:18px;font-weight:bold;color:#7c3aed;">${h}h ${m}m</div>
          <div style="font-size:11px;color:#94a3b8;">${startLabel} → ${endLabel}</div>
        </div>
        <div style="background:#f0fdf4;border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:#16a34a;font-weight:bold;">TỔNG ĐƠN</div>
          <div style="font-size:22px;font-weight:bold;color:#16a34a;">${totalOrders}</div>
        </div>
        <div style="background:#eff6ff;border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:#2563eb;font-weight:bold;">NHÂN VIÊN</div>
          <div style="font-size:22px;font-weight:bold;color:#2563eb;">${totalStaff}</div>
          <div style="font-size:11px;color:#94a3b8;">CT: ${fullTime} / TV: ${partTime}</div>
        </div>
        <div style="background:#fff7ed;border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:11px;color:#ea580c;font-weight:bold;">TB ĐƠN / NGƯỜI</div>
          <div style="font-size:28px;font-weight:bold;color:#ea580c;">${avgOrders}</div>
        </div>
      </div>`;

    productivitySession._pending = { endTime: new Date(endTs).toISOString(), totalOrders, avgOrders, elapsed };
    localStorage.setItem("warehouse_active_session", JSON.stringify(productivitySession));
    document.getElementById("prodLive").style.display = "none";
    document.getElementById("prodSummary").style.display = "block";
  });

  document.getElementById("prodEditBtn")?.addEventListener("click", () => {
    if (!productivitySession) return;
    clearInterval(productivityLiveTimer);
    productivityLiveTimer = null;
    const { startTime, plannedEndTime, fullTime, partTime } = productivitySession;
    const sd = new Date(startTime);
    document.getElementById("sessionStartTime").value =
      `${String(sd.getHours()).padStart(2,"0")}:${String(sd.getMinutes()).padStart(2,"0")}`;
    if (plannedEndTime) {
      const ed = new Date(plannedEndTime);
      document.getElementById("sessionEndTime").value =
        `${String(ed.getHours()).padStart(2,"0")}:${String(ed.getMinutes()).padStart(2,"0")}`;
    } else {
      document.getElementById("sessionEndTime").value = "";
    }
    document.getElementById("sessionFullTime").value = fullTime;
    document.getElementById("sessionPartTime").value = partTime;
    document.getElementById("prodLive").style.display = "none";
    document.getElementById("prodForm").style.display = "block";
  });

  document.getElementById("prodCancelSummaryBtn")?.addEventListener("click", () => {
    delete productivitySession._pending;
    localStorage.setItem("warehouse_active_session", JSON.stringify(productivitySession));
    const { owner: _o2, _pending: _p2, ...sessionForFb2 } = productivitySession;
    set(ref(db, `${PRODUCTIVITY_KEY}/currentSession`), sessionForFb2).catch(() => {});
    renderProductivitySection();
  });

  document.getElementById("prodSaveBtn")?.addEventListener("click", async () => {
    if (!productivitySession?._pending) return;
    if (!productivitySession.owner) return;
    const { startTime, sessionDate, fullTime, partTime, _pending } = productivitySession;
    const report = {
      date: sessionDate,
      startTime,
      endTime: _pending.endTime,
      fullTime,
      partTime,
      totalStaff: fullTime + partTime,
      totalOrders: _pending.totalOrders,
      avgOrders: _pending.avgOrders,
      elapsed: _pending.elapsed,
      savedAt: new Date().toISOString()
    };
    const btn = document.getElementById("prodSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Đang lưu..."; }
    try {
      await push(ref(db, `${PRODUCTIVITY_KEY}/${sessionDate}`), report);
      await set(ref(db, `${PRODUCTIVITY_KEY}/currentSession`), null);
      localStorage.removeItem("warehouse_active_session");
      productivitySession = null;
      document.getElementById("prodSummary").style.display = "none";
      document.getElementById("prodSetup").style.display = "block";
      const picker = document.getElementById("reportDatePicker");
      if (picker) { picker.value = sessionDate; loadProductivityReports(sessionDate); }
      alert("✅ Đã lưu báo cáo sản lượng!");
    } catch(e) {
      alert("❌ Lỗi lưu báo cáo, vui lòng thử lại!");
      if (btn) { btn.disabled = false; btn.textContent = "💾 Lưu Báo Cáo"; }
    }
  });

  document.getElementById("loadReportsBtn")?.addEventListener("click", () => {
    const date = document.getElementById("reportDatePicker")?.value;
    if (!date) return alert("Vui lòng chọn ngày!");
    loadProductivityReports(date);
  });
}

async function autoEndAndSaveProductivity() {
  if (!productivitySession) return;
  if (!productivitySession.owner) {
    // Máy này chỉ xem — xóa session local, không lưu
    productivitySession = null;
    localStorage.removeItem("warehouse_active_session");
    renderProductivitySection();
    return;
  }
  const { startTime, plannedEndTime, sessionDate, fullTime, partTime } = productivitySession;
  const startTs = new Date(startTime).getTime();
  const endTs = new Date(plannedEndTime).getTime();
  const dayOrders = scanDataCache[sessionDate]?.orders || [];
  const totalOrders = dayOrders.filter(o => { const t = new Date(o.time).getTime(); return o.status === STATUS.SUCCESS && t >= startTs && t <= endTs; }).length;
  const totalStaff = fullTime + partTime;
  const avgOrders = totalStaff > 0 ? parseFloat((totalOrders / totalStaff).toFixed(1)) : 0;
  const elapsed = endTs - startTs;
  const report = {
    date: sessionDate,
    startTime,
    endTime: new Date(endTs).toISOString(),
    fullTime,
    partTime,
    totalStaff,
    totalOrders,
    avgOrders,
    elapsed,
    savedAt: new Date().toISOString()
  };
  try {
    await push(ref(db, `${PRODUCTIVITY_KEY}/${sessionDate}`), report);
    await set(ref(db, `${PRODUCTIVITY_KEY}/currentSession`), null);
    localStorage.removeItem("warehouse_active_session");
    productivitySession = null;
    renderProductivitySection();
    const picker = document.getElementById("reportDatePicker");
    if (picker) { picker.value = sessionDate; loadProductivityReports(sessionDate); }
  } catch(e) {
    console.error("Lỗi tự lưu:", e);
  }
}

async function loadProductivityReports(date) {
  const body = document.getElementById("reportsBody");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;">⏳ Đang tải...</td></tr>`;
  try {
    const snap = await get(ref(db, `${PRODUCTIVITY_KEY}/${date}`));
    if (!snap.exists()) {
      body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;">Không có báo cáo ngày ${date}</td></tr>`;
      return;
    }
    const reports = Object.values(snap.val()).sort((a, b) => (a.startTime > b.startTime ? 1 : -1));
    body.innerHTML = "";
    reports.forEach(r => {
      const startLabel = new Date(r.startTime).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const endLabel = new Date(r.endTime).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const el = r.elapsed ?? (new Date(r.endTime) - new Date(r.startTime));
      const h = Math.floor(el / 3600000);
      const m = Math.floor((el % 3600000) / 60000);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.date}</td>
        <td style="text-align:center;">${startLabel}</td>
        <td style="text-align:center;">${endLabel}</td>
        <td style="text-align:center;">${r.fullTime}</td>
        <td style="text-align:center;">${r.partTime}</td>
        <td style="text-align:center;font-weight:bold;">${r.totalStaff}</td>
        <td style="text-align:center;color:#16a34a;font-weight:bold;">${r.totalOrders}</td>
        <td style="text-align:center;color:#ea580c;font-weight:bold;font-size:16px;">${r.avgOrders}</td>
        <td style="text-align:center;">${h}h ${m}m</td>`;
      body.appendChild(tr);
    });
  } catch(e) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ef4444;">Lỗi tải báo cáo</td></tr>`;
  }
}

let handoverCarrierFilter = "all";
let handoverRecordsCache = []; // lưu để filter không cần fetch lại

async function loadHandoverHistory(date) {
  const body = document.getElementById("handoverHistoryBody");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;">⏳ Đang tải...</td></tr>`;

  // Bind filter buttons
  document.querySelectorAll(".ho-filter-btn").forEach(btn => {
    btn.onclick = () => {
      handoverCarrierFilter = btn.dataset.dvvc;
      document.querySelectorAll(".ho-filter-btn").forEach(b => {
        const active = b.dataset.dvvc === handoverCarrierFilter;
        b.style.background = active ? "#d97706" : "#fff";
        b.style.color = active ? "#fff" : "#374151";
        b.style.borderColor = active ? "#d97706" : "#94a3b8";
      });
      renderHandoverRows();
    };
  });

  try {
    const datesToFetch = [date];
    for (let i = 1; i <= 7; i++) {
      datesToFetch.push(localDateStr(new Date(new Date(date).getTime() - i * 86400000)));
    }
    const snaps = await Promise.all(datesToFetch.map(d => get(ref(db, `${HANDOVER_KEY}/${d}`))));
    handoverRecordsCache = snaps
      .flatMap(s => s.exists() ? Object.values(s.val()) : [])
      .filter(r => localDateStr(new Date(r.time)) === date)
      .sort((a, b) => a.time > b.time ? 1 : -1);
    renderHandoverRows();
  } catch(e) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#ef4444;">Lỗi tải dữ liệu</td></tr>`;
  }
}

function renderHandoverRows() {
  const body = document.getElementById("handoverHistoryBody");
  const dlAllBtn = document.getElementById("downloadSelectedHandoverBtn");
  const selectAll = document.getElementById("selectAllHandover");
  if (!body) return;

  let records = handoverRecordsCache;
  if (handoverCarrierFilter !== "all") records = records.filter(r => r.carrier === handoverCarrierFilter);

  if (records.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;">Không có bàn giao nào</td></tr>`;
    if (dlAllBtn) dlAllBtn.style.display = "none";
    if (selectAll) selectAll.checked = false;
    return;
  }
  if (dlAllBtn) dlAllBtn.style.display = "inline-block";

  body.innerHTML = "";
  records.forEach(r => {
    const batch = [...closedBatches, ...closedBatches2].find(b => b.id === r.batchId && b.carrier === r.carrier);
    const count = batch ? batch.count : "—";
    const closedDate = r.closedDate || r.date || (batch ? batch.date : "—");
    const createdDate = batch?.createdDate || closedDate;
    const timeLabel = new Date(r.time).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="ho-checkbox" data-id="${escHtml(r.batchId)}" data-carrier="${escHtml(r.carrier)}" data-closeddate="${closedDate}" data-createddate="${createdDate}"></td>
      <td><strong>${escHtml(r.carrier)}</strong></td>
      <td style="color:#2563eb;font-weight:bold;">${escHtml(r.batchId)}</td>
      <td style="color:#10b981;font-weight:bold;">${count}</td>
      <td>${closedDate}</td>
      <td style="color:#d97706;font-weight:600;">${timeLabel}</td>
      <td></td>
    `;
    const dlBtn = document.createElement("button");
    dlBtn.textContent = "📥 Tải về";
    dlBtn.style.cssText = "background:#3b82f6;color:white;padding:5px 12px;border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    dlBtn.onclick = () => downloadBatch(r.batchId, r.carrier, closedDate, createdDate);
    tr.lastElementChild.appendChild(dlBtn);
    body.appendChild(tr);
  });

  // Select all checkbox
  if (selectAll) {
    selectAll.onchange = () => {
      document.querySelectorAll(".ho-checkbox").forEach(cb => cb.checked = selectAll.checked);
    };
  }

  // Bulk download button — gom tất cả vào 1 file (giống lịch sử chốt xe)
  if (dlAllBtn) {
    dlAllBtn.onclick = async () => {
      const checked = [...document.querySelectorAll(".ho-checkbox:checked")];
      if (checked.length === 0) return alert("Chưa chọn xe nào!");
      dlAllBtn.disabled = true; dlAllBtn.textContent = "⏳ Đang tải...";
      const rows = [];
      for (const cb of checked) {
        const { id, carrier, closeddate, createddate } = cb.dataset;
        const fromDate = createddate || closeddate;
        await ensureDatesInCache(fromDate, closeddate);
        const orders = Object.values(scanDataCache)
          .filter(day => day.date >= fromDate && day.date <= closeddate)
          .flatMap(day => day.orders || [])
          .filter(o => o.batchId === id && o.carrier === carrier && o.status === STATUS.SUCCESS);
        orders.forEach(o => rows.push({ "Lô/Xe": o.batchId, "DVVC": o.carrier, "Ngày chốt": closeddate, "Thời gian": formatTime(o.time), "Mã đơn": o.code }));
      }
      if (rows.length > 0) exportOrdersToExcel(rows, `BanGiao_${todayStr()}.xlsx`);
      else alert("Không tìm thấy đơn nào cho các xe đã chọn!");
      dlAllBtn.disabled = false; dlAllBtn.textContent = "📥 Tải các xe đã chọn";
    };
  }
}

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
      if (o) rows += `<td class="stt">${i+g+1}</td><td class="code">${escHtml(o.code)}</td>`;
      else    rows += `<td></td><td></td>`;
    }
    rows += "</tr>";
  }
  const addrLine  = addr  ? `<div class="info-addr">Địa chỉ: ${escHtml(addr)}</div>` : "";
  const phoneLine = phone ? `<div class="info-addr">Điện thoại: ${escHtml(phone)}</div>` : "";
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Biên Bản - ${escHtml(batchId)}</title>
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
  <td class="l"><div class="lbl">ĐƠN VỊ GỬI HÀNG</div><div class="val">${escHtml(shop)}</div>${addrLine}${phoneLine}</td>
  <td class="r"><div class="lbl">ĐƠN VỊ TIẾP NHẬN</div>
    <div class="val">ĐVVC: ${escHtml(carrier)}</div>
    <div class="val">Lô/Xe: ${escHtml(batchId)}</div>
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
