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

// === 2. CẤU HÌNH BIẾN TOÀN CỤC ===
const STORAGE_KEY = "warehouse_scan_data_v1";
const CANCELED_KEY = "warehouse_cancelled_orders_v1";
const BATCH_KEY = "warehouse_active_batches_v1"; 
const CLOSED_BATCH_KEY = "warehouse_closed_batches_v1"; 

const STATUS = { SUCCESS: "SUCCESS", DUPLICATE: "DUPLICATE", CANCELED: "CANCELED" };
const statusLabel = { [STATUS.SUCCESS]: "THÀNH CÔNG", [STATUS.DUPLICATE]: "ĐƠN TRÙNG", [STATUS.CANCELED]: "ĐƠN HỦY" };
const statusClass = { [STATUS.SUCCESS]: "row-success", [STATUS.DUPLICATE]: "row-warning", [STATUS.CANCELED]: "row-error" };

let currentFilter = { mode: "single", singleDate: todayStr() };
let carrierChart = null;
let activePage = "scanPage";
let showAllTodayOrders = false; // Biến kiểm soát hiển thị 100 đơn

let activeBatches = JSON.parse(localStorage.getItem(BATCH_KEY)) || {};
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

// === 3. KHỞI CHẠY HỆ THỐNG ===
init();

async function init() {
  document.getElementById("singleDate").value = todayStr();
  loadCancelledToTextarea();
  bindEvents();
  switchPage("scanPage");
  
  // Firebase GET Data quét (1 lần)
  try {
    const snapshot = await get(ref(db, STORAGE_KEY));
    if (snapshot.exists()) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.val()));
    }
  } catch (error) {
    console.error("Lỗi tải dữ liệu:", error);
  }
  
  renderAll(); 
  renderBatches();

  // Firebase Realtime
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
}

// === 4. XỬ LÝ SỰ KIỆN ===
function bindEvents() {
  document.querySelectorAll(".page-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchPage(tab.dataset.page));
  });

  // Tạo xe
  const createBatchBtn = document.getElementById("createBatchBtn");
  if (createBatchBtn) {
    createBatchBtn.addEventListener("click", () => {
      const carrier = document.getElementById("batchCarrier").value;
      const name = document.getElementById("batchName").value.trim();
      
      if (!name) return alert("Vui lòng nhập tên xe/lô!");
      if (activeBatches[carrier]) return alert(`Đang có xe [${activeBatches[carrier].id}] mở cho [${carrier}] rồi! Vui lòng CHỐT XE trước khi tạo mới.`);

      activeBatches[carrier] = { id: name, count: 0 };
      localStorage.setItem(BATCH_KEY, JSON.stringify(activeBatches));
      renderBatches();
      document.getElementById("batchName").value = ""; 
    });
  }

  const singleDateInput = document.getElementById("singleDate");
  if (singleDateInput) {
    singleDateInput.addEventListener("change", () => { renderAll(); });
  }

  // Quét Enter
  orderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(orderInput.value.trim());
      orderInput.value = "";
      focusOrderInput();
    }
  });

  // Lưu và xóa đơn hủy
  document.getElementById("saveCancelledBtn").addEventListener("click", () => {
    const lines = normalizeCodes(cancelledInput.value);
    saveCancelledSet(lines);
    showMessage("Đã lưu danh sách đơn hủy", "warning");
    playTone("warning");
  });

  const clearCancelledBtn = document.getElementById("clearCancelledBtn");
  if (clearCancelledBtn) {
    clearCancelledBtn.addEventListener("click", () => {
      if (confirm("⚠️ Bạn có chắc chắn muốn xóa TOÀN BỘ danh sách đơn hủy không?")) {
        cancelledInput.value = "";
        saveCancelledSet([]);
        showMessage("Đã xóa sạch danh sách đơn hủy", "success");
      }
    });
  }

  // Bộ lọc ngày
  const applyFilterBtn = document.getElementById("applyFilterBtn");
  if (applyFilterBtn) {
    applyFilterBtn.addEventListener("click", () => {
      const f = document.getElementById("fromDate").value;
      const t = document.getElementById("toDate").value;
      if (f && t) {
        currentFilter = { mode: "range", fromDate: f, toDate: t };
        renderAll(); 
      } else {
        alert("Vui lòng chọn cả Từ ngày và Đến ngày!");
      }
    });
  }

  const resetFilterBtn = document.getElementById("resetFilterBtn");
  if (resetFilterBtn) {
    resetFilterBtn.addEventListener("click", () => {
      const today = todayStr();
      document.getElementById("singleDate").value = today; 
      document.getElementById("fromDate").value = ""; 
      document.getElementById("toDate").value = "";   
      currentFilter = { mode: "single", singleDate: today };
      renderAll();
    });
  }

  // History Events
  if (historyDatePicker) {
    historyDatePicker.addEventListener("change", (e) => {
        const date = e.target.value;
        const orders = getDayOrders(date);
        renderHistoryTable(orders, `Lịch sử ngày ${date}`);
        renderClosedBatches(date); 
    });
  }

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

  document.getElementById("exportSelectedDateBtn").onclick = () => {
    const rows = [];
    document.querySelectorAll("#historyDetailBody tr").forEach(tr => {
        const tds = tr.querySelectorAll("td");
        if(tds.length > 0) rows.push({ "Thời gian": tds[0].innerText, "Mã đơn": tds[1].innerText, "DVVC": tds[2].innerText, "Trạng thái": tds[3].innerText });
    });
    exportOrdersToExcel(rows, "bao_cao_kho_tong.xlsx");
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
  
  // KIỂM TRA XE BÀN GIAO
  if (!activeBatches[carrier] && !canceledSet.has(code)) {
    showMessage(`❌ CHƯA TẠO XE CHO [${carrier.toUpperCase()}]`, "error");
    playTone("error");
    setTimeout(() => speak(`Chưa tạo xe ${carrier}`), 400);
    return; 
  }

  // KIỂM TRA TRÙNG 5 NGÀY
  const last5Days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    last5Days.push(d.toISOString().slice(0, 10));
  }

  const isDuplicateIn5Days = last5Days.some(dStr => {
    const dayData = all[dStr];
    return dayData && dayData.orders.some(o => o.code === code && o.status === STATUS.SUCCESS);
  });

  const day = all[date] || { date, orders: [] };
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
    // === ĐƠN THÀNH CÔNG ===
    status = STATUS.SUCCESS;
    activeBatches[carrier].count++; 
    localStorage.setItem(BATCH_KEY, JSON.stringify(activeBatches));
    renderBatches(); 
    showMessage(`✅ THÀNH CÔNG: ${code}`, "success");
    // LƯU Ý: Đã tắt playTone("success") theo yêu cầu để đỡ ồn
  }

  const currentBatchId = activeBatches[carrier] ? activeBatches[carrier].id : "";
  day.orders.push({ code, status, carrier, time: now, batchId: currentBatchId });
  
  all[date] = day;
  saveAllData(all);
  renderAll();
}

// === 6. HIỂN THỊ GIAO DIỆN (RENDER) ===
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

// --- HIỂN THỊ 100 ĐƠN GẦN NHẤT ---
function renderTodayList(orders) {
  const body = document.getElementById("todayScannedBody");
  const btn = document.getElementById("loadMoreTodayBtn");
  if (!body) return;
  body.innerHTML = "";

  const reversed = [...orders].reverse();
  const limit = showAllTodayOrders ? reversed.length : 100; // Giới hạn 100
  const displayOrders = reversed.slice(0, limit);

  displayOrders.forEach(o => {
    const tr = document.createElement("tr");
    tr.className = statusClass[o.status];
    tr.innerHTML = `<td>${formatTime(o.time)}</td><td>${o.code}</td><td>${o.carrier}</td><td>${statusLabel[o.status]}</td>`;
    body.appendChild(tr);
  });

  // Nút xem thêm
  if (btn) {
    if (reversed.length > 100 && !showAllTodayOrders) {
      btn.style.display = "block";
      btn.textContent = `⬇️ Xem tất cả (Còn ẩn ${reversed.length - 100} đơn để chống giật lag)`;
      btn.onclick = () => { 
        showAllTodayOrders = true; 
        renderTodayList(orders); // Render lại khi bấm xem tất cả
      };
    } else {
      btn.style.display = "none";
    }
  }
}

// --- QUẢN LÝ XE ĐANG MỞ ---
function renderBatches() {
  const body = document.getElementById("activeBatchesBody");
  if (!body) return;
  body.innerHTML = "";
  
  const carriers = Object.keys(activeBatches);
  if (carriers.length === 0) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;">Chưa có xe</td></tr>`;
    return;
  }

  carriers.forEach(carrier => {
    const batch = activeBatches[carrier];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong style="color: blue;">${batch.id}</strong><br><span style="font-size: 13px;">${carrier}</span></td>
      <td style="font-size: 18px; color: #e11d48; font-weight: bold;">${batch.count}</td>
      <td><button onclick="closeBatch('${carrier}')" style="background: #10b981; color: white; padding: 6px 10px; border: none; border-radius: 4px; cursor: pointer;">✅ Chốt</button></td>
    `;
    body.appendChild(tr);
  });
}

// --- XỬ LÝ CHỐT XE (Vào lịch sử) ---
window.closeBatch = function(carrier) {
  const batchId = activeBatches[carrier].id;
  const count = activeBatches[carrier].count;
  
  if (!confirm(`Bạn có chắc chắn muốn CHỐT xe [${batchId}] của [${carrier}] không?`)) return;

  closedBatches.push({ id: batchId, carrier: carrier, count: count, date: todayStr() });
  localStorage.setItem(CLOSED_BATCH_KEY, JSON.stringify(closedBatches));
  set(ref(db, CLOSED_BATCH_KEY), closedBatches);

  delete activeBatches[carrier];
  localStorage.setItem(BATCH_KEY, JSON.stringify(activeBatches));
  
  renderBatches(); 
  focusOrderInput();

  const historyDate = document.getElementById("historyDatePicker");
  if (historyDate && historyDate.value === todayStr()) {
     renderClosedBatches(todayStr());
  }
}

// --- HÀM VẼ BẢNG LỊCH SỬ XE ---
// --- HÀM VẼ BẢNG LỊCH SỬ XE (ĐÃ TỐI ƯU ĐẾM THỰC TẾ) ---
function renderClosedBatches(dateStr) {
  const body = document.getElementById("closedBatchesBody");
  if (!body) return;
  
  const batchesForDate = closedBatches.filter(b => b.date === dateStr);
  body.innerHTML = "";
  
  if (batchesForDate.length === 0) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;">Không có xe nào được chốt trong ngày này</td></tr>`;
    return;
  }

  // 1. Kéo toàn bộ dữ liệu gốc của ngày hôm đó ra để đối soát
  const allOrders = getAllData()[dateStr]?.orders || [];

  [...batchesForDate].reverse().forEach(b => {
    // 2. ÉP ĐẾM THỰC TẾ: Đếm đúng số lượng đơn trong dữ liệu gốc khớp với xe này
    const exactCount = allOrders.filter(o => 
      o.batchId === b.id && 
      o.carrier === b.carrier && 
      o.status === STATUS.SUCCESS
    ).length;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${b.carrier}</strong></td>
      <td style="color: blue; font-weight: bold;">${b.id}</td>
      <td style="font-size: 16px; font-weight: bold; color: #10b981;">
        ${exactCount} <span style="font-size: 12px; color: #64748b; font-weight: normal;">(Khớp Excel)</span>
      </td>
      <td><button onclick="downloadBatch('${b.id}', '${b.carrier}', '${b.date}')" style="background: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer;">📥 Tải File Xe Này</button></td>
    `;
    body.appendChild(tr);
  });
}

// --- HÀM TẢI FILE EXCEL CHO 1 XE CỤ THỂ ---
window.downloadBatch = function(batchId, carrier, dateStr) {
  const allOrders = getAllData()[dateStr]?.orders || [];
  const batchOrders = allOrders.filter(o => o.batchId === batchId && o.carrier === carrier && o.status === STATUS.SUCCESS);

  if (batchOrders.length > 0) {
    const rows = batchOrders.map(o => ({ 
      "Lô/Xe": o.batchId, "Thời gian": formatTime(o.time), "Mã đơn": o.code, "DVVC": o.carrier 
    }));
    exportOrdersToExcel(rows, `BanGiao_${carrier}_${batchId}_${dateStr}.xlsx`);
  } else {
    alert("Lỗi: Không tìm thấy dữ liệu đơn hàng cho xe này!");
  }
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
    data: { labels, datasets: [{ label: "Số lượng", data, backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#64748b", "#ef4444", "#eab308"] }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

// === CÁC HÀM HỖ TRỢ ===
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

function getOrdersByFilter(filter) {
  const all = getAllData();
  const dates = Object.keys(all);
  let selectedDates = [];

  if (filter.mode === "range" && filter.fromDate && filter.toDate) {
    selectedDates = dates.filter((d) => d >= filter.fromDate && d <= filter.toDate);
  } else {
    selectedDates = dates.filter((d) => d === filter.singleDate);
  }
  return selectedDates.flatMap((d) => all[d].orders || []);
}

function getDayOrders(date) { return getAllData()[date]?.orders || []; }
function getAllData() { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }

function saveAllData(all) { 
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); 
  const today = todayStr();
  if (all[today]) {
    set(ref(db, `${STORAGE_KEY}/${today}`), all[today]);
  }
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
  const audioUrls = {
    // success: "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3",  // Đã tắt
    warning: "https://assets.mixkit.co/active_storage/sfx/950/950-preview.mp3", 
    error: "https://assets.mixkit.co/active_storage/sfx/997/997-preview.mp3" 
  };
  if(audioUrls[kind]) new Audio(audioUrls[kind]).play().catch(() => {});
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
    tr.innerHTML = `<td>${c}</td><td>${list.length}</td><td><button onclick="exportOrdersToExcel([], 'temp.xlsx')" class="export-carrier-btn" data-carrier="${c}">Tải đơn tổng</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll(".export-carrier-btn").forEach(btn => {
    btn.onclick = () => {
      const c = btn.dataset.carrier;
      const list = map[c] || [];
      exportOrdersToExcel(list.map(o => ({ "Mã đơn": o.code, "Thời gian": formatTime(o.time) })), `don_tong_${c}.xlsx`);
    };
  });
}