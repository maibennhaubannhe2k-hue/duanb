// === 1. KHỞI TẠO FIREBASE ===
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-app.js";
import { getDatabase, ref, set, onValue } from "https://www.gstatic.com/firebasejs/10.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAPoSYAdw5T4fpVyOg44hBHQjNQ74sr0RU",
  authDomain: "quanlykho-eb445.firebaseapp.com",
  databaseURL: "https://quanlykho-eb445-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "quanlykho-eb445",
  storageBucket: "quanlykho-eb445.firebasestorage.app",
  messagingSenderId: "284368709466",
  appId: "1:284368709466:web:20bc45240af14136f13563"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// === 2. CẤU HÌNH BIẾN TOÀN CỤC ===
const STORAGE_KEY = "warehouse_scan_data_v1";
const CANCELED_KEY = "warehouse_cancelled_orders_v1";

const STATUS = { SUCCESS: "SUCCESS", DUPLICATE: "DUPLICATE", CANCELED: "CANCELED" };
const statusLabel = { [STATUS.SUCCESS]: "THÀNH CÔNG", [STATUS.DUPLICATE]: "ĐƠN TRÙNG", [STATUS.CANCELED]: "ĐƠN HỦY" };
const statusClass = { [STATUS.SUCCESS]: "row-success", [STATUS.DUPLICATE]: "row-warning", [STATUS.CANCELED]: "row-error" };

let currentFilter = { mode: "single", singleDate: todayStr() };
let carrierChart = null;
let activePage = "scanPage";

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

// === 3. KHỞI CHẠY HỆ THỐNG ===
init();

function init() {
  document.getElementById("singleDate").value = todayStr();
  loadCancelledToTextarea();
  bindEvents();
  switchPage("scanPage");
  renderAll();
  
  // Đồng bộ Firebase
  onValue(ref(db, STORAGE_KEY), (snapshot) => {
    const data = snapshot.val();
    if (data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      renderAll(); 
    }
  });

  onValue(ref(db, CANCELED_KEY), (snapshot) => {
    const data = snapshot.val();
    if (data) {
      localStorage.setItem(CANCELED_KEY, JSON.stringify(data));
      loadCancelledToTextarea();
    }
  });
}

// === 4. XỬ LÝ SỰ KIỆN (EVENTS) ===
function bindEvents() {
  document.querySelectorAll(".page-tab").forEach((tab) => {
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

  document.getElementById("saveCancelledBtn").addEventListener("click", () => {
    const lines = normalizeCodes(cancelledInput.value);
    saveCancelledSet(lines);
    showMessage("Đã lưu danh sách đơn hủy", "warning");
    playTone("warning");
  });

  // Sự kiện chọn ngày trong History
  if (historyDatePicker) {
    historyDatePicker.addEventListener("change", (e) => {
        const date = e.target.value;
        const orders = getDayOrders(date);
        renderHistoryTable(orders, `Lịch sử ngày ${date}`);
    });
  }

  // Sự kiện Kính lúp (Tìm kiếm)
  if (historySearchInput) {
    historySearchInput.addEventListener("input", (e) => {
        const term = e.target.value.toLowerCase().trim();
        if (term.length > 0 && term.length < 3) return;
        
        const allData = getAllData();
        let results = [];
        Object.keys(allData).forEach(date => {
            const match = allData[date].orders.filter(o => o.code.toLowerCase().includes(term));
            results = results.concat(match);
        });
        renderHistoryTable(results, term ? `Kết quả tìm kiếm cho: ${term}` : "Vui lòng chọn ngày");
    });
  }

  // Xuất Excel từ bảng đang hiển thị
  document.getElementById("exportSelectedDateBtn").onclick = () => {
    const rows = [];
    document.querySelectorAll("#historyDetailBody tr").forEach(tr => {
        const tds = tr.querySelectorAll("td");
        if(tds.length > 0) rows.push({ "Thời gian": tds[0].innerText, "Mã đơn": tds[1].innerText, "DVVC": tds[2].innerText, "Trạng thái": tds[3].innerText });
    });
    exportOrdersToExcel(rows, "bao_cao_kho.xlsx");
  };
}

// === 5. XỬ LÝ QUÉT MÃ (MAIN LOGIC) ===
function handleScan(code) {
  if (!code) return;
  const date = todayStr();
  const now = new Date().toISOString();
  const carrier = detectCarrier(code);
  const all = getAllData();
  const canceledSet = getCancelledSet();
  const day = all[date] || { date, orders: [] };

  let status;
  if (canceledSet.has(code)) {
    status = STATUS.CANCELED;
    showMessage("❌ ĐƠN HỦY - KHÔNG ĐÓNG GÓI", "error");
    playTone("error");
    setTimeout(() => speak("Đơn hủy"), 400); 
  } else if (day.orders.some((o) => o.code === code)) {
    status = STATUS.DUPLICATE;
    showMessage("⚠️ ĐƠN NÀY ĐÃ QUÉT RỒI", "warning");
    playTone("warning");
    setTimeout(() => speak("Đơn trùng"), 400);
  } else {
    status = STATUS.SUCCESS;
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success");
    playTone("success"); // Chỉ kêu "Ting"
  }

  day.orders.push({ code, status, carrier, time: now });
  all[date] = day;
  saveAllData(all);
  renderAll();
}

// === 6. HIỂN THỊ GIAO DIỆN (RENDER) ===
function renderAll() {
  const allData = getAllData();
  const filteredOrders = getOrdersByFilter(currentFilter);
  
  // Dashboard Metrics
  totalOrders.textContent = filteredOrders.length;
  validOrders.textContent = filteredOrders.filter(o => o.status === STATUS.SUCCESS).length;
  
  const cOrders = filteredOrders.filter(o => o.status === STATUS.CANCELED);
  cancelledOrders.textContent = cOrders.length;
  
  const dOrders = filteredOrders.filter(o => o.status === STATUS.DUPLICATE);
  duplicateOrders.textContent = dOrders.length;

  // Bấm vào số lượng đơn hủy ở Dashboard
  cancelledOrders.parentElement.onclick = () => {
    switchPage("historyPage");
    renderHistoryTable(cOrders, "Danh sách ĐƠN HỦY đang lọc");
  };
  
  // Bấm vào số lượng đơn trùng ở Dashboard
  duplicateOrders.parentElement.onclick = () => {
    switchPage("historyPage");
    renderHistoryTable(dOrders, "Danh sách ĐƠN TRÙNG đang lọc");
  };

  renderCarrierTable(filteredOrders);
  renderChart(filteredOrders);
  renderTodayList(getDayOrders(todayStr()));
  loadCancelledCount();
}

function renderHistoryTable(orders, title) {
  historyDetailBody.innerHTML = "";
  const displayOrders = [...orders].reverse();
  
  historyTitle.innerHTML = `${title} <br> <span style="color: #ee4d2d; font-size: 20px; font-weight: bold;">📊 TỔNG CỘNG: ${orders.length} ĐƠN</span>`;

  displayOrders.forEach((o) => {
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
    (successMap["J&T"] || []).length,
    (successMap["Shopee Express"] || []).length,
    (successMap["GHN"] || []).length,
    (successMap["Viettel Post"] || []).length,
    (successMap["Khac"] || []).length,
    orders.filter(o => o.status === STATUS.CANCELED).length,
    orders.filter(o => o.status === STATUS.DUPLICATE).length
  ];

  const ctx = document.getElementById("carrierChart");
  if (carrierChart) carrierChart.destroy();
  carrierChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Số lượng",
        data,
        backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#64748b", "#ef4444", "#eab308"],
      }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

// === CÁC HÀM HỖ TRỢ (HELPERS) ===
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
  return orders.reduce((acc, o) => {
    acc[o.carrier] = acc[o.carrier] || [];
    acc[o.carrier].push(o);
    return acc;
  }, {});
}

function getOrdersByFilter(f) {
  const all = getAllData();
  return (all[f.singleDate]?.orders || []);
}

function getDayOrders(date) { return getAllData()[date]?.orders || []; }
function getAllData() { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
function saveAllData(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); set(ref(db, STORAGE_KEY), data); }
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
  const audioUrls = {
    success: "", // Tiếng Ting
    warning: "https://assets.mixkit.co/active_storage/sfx/950/950-preview.mp3", 
    error: "https://assets.mixkit.co/active_storage/sfx/997/997-preview.mp3" 
  };
  new Audio(audioUrls[kind]).play().catch(() => {});
}

function speak(text) {
  if ('speechSynthesis' in window) {
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'vi-VN';
    msg.rate = 1.1;
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
    tr.innerHTML = `<td>${c}</td><td>${list.length}</td><td><button onclick="exportOrdersToExcel([], 'temp.xlsx')" class="export-carrier-btn" data-carrier="${c}">Tải đơn</button></td>`;
    body.appendChild(tr);
  });
  // Gán lại sự kiện tải đơn cho từng nhà vận chuyển
  body.querySelectorAll(".export-carrier-btn").forEach(btn => {
    btn.onclick = () => {
      const c = btn.dataset.carrier;
      const list = map[c] || [];
      exportOrdersToExcel(list.map(o => ({ "Mã đơn": o.code, "Thời gian": formatTime(o.time) })), `don_${c}.xlsx`);
    };
  });
}

function renderTodayList(orders) {
  const body = document.getElementById("todayScannedBody");
  body.innerHTML = "";
  [...orders].reverse().forEach(o => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${statusLabel[o.status]}</td>`;
    body.appendChild(tr);
  });
}