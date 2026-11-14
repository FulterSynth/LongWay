import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, child, update, onValue, off, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { MiniGameManager, sfx } from "./minigames.js";

const APP_VERSION = "2.0.0";
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 30000;
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const LEADERBOARD_LIMIT = 100;

// ===== КОНСТАНТИ ГРИ =====
const JOBS = [
    { name: "Стажер", pay: 1, xpNeeded: 500, taskClicks: 10, taskReward: 5, creditLimit: 500 },
    { name: "Оператор підтримки", pay: 3, xpNeeded: 1500, taskClicks: 15, taskReward: 18, creditLimit: 1500 },
    { name: "Junior QA", pay: 8, xpNeeded: 4000, taskClicks: 22, taskReward: 60, creditLimit: 4000 },
    { name: "Junior Developer", pay: 20, xpNeeded: 10000, taskClicks: 30, taskReward: 180, creditLimit: 10000 },
    { name: "Middle Developer", pay: 50, xpNeeded: 25000, taskClicks: 40, taskReward: 500, creditLimit: 25000 },
    { name: "Senior Developer", pay: 120, xpNeeded: 60000, taskClicks: 55, taskReward: 1500, creditLimit: 60000 },
    { name: "Team Lead", pay: 300, xpNeeded: 150000, taskClicks: 75, taskReward: 4500, creditLimit: 150000 },
    { name: "Tech Lead", pay: 700, xpNeeded: 400000, taskClicks: 100, taskReward: 12000, creditLimit: 400000 },
    { name: "CTO", pay: 1500, xpNeeded: 0, taskClicks: 140, taskReward: 35000, creditLimit: 1000000 }
];

const COURSES = [
    { id: "basics", name: "Основи програмування", price: 800, durationMs: 3600000, boost: 10 },
    { id: "algorithms", name: "Алгоритми та структури даних", price: 3500, durationMs: 10800000, boost: 15 },
    { id: "cleancode", name: "Clean Code (книга)", price: 9000, durationMs: 18000000, boost: 20 },
    { id: "sysdesign", name: "Системний дизайн", price: 22000, durationMs: 28800000, boost: 25 },
    { id: "leadership", name: "Лідерство і менеджмент", price: 45000, durationMs: 43200000, boost: 30 },
    { id: "architecture", name: "Архітектура високих навантажень", price: 90000, durationMs: 64800000, boost: 40 }
];

// ===== ДАНІ МАПИ =====
const MAP_W = 900, MAP_H = 560;
const BASE_PLOT_PRICE = 500;

const MAP_BUILDINGS = [
    { id: "bank", name: "Банк", icon: "🏦", cls: "bank", x: 380, y: 230, w: 140, h: 100, sub: "Кредити" },
    { id: "corp", name: "КовельКорп", icon: "🏢", cls: "corp", x: 380, y: 30, w: 140, h: 90, sub: "Робота" }
];

const MAP_PLOTS_BASE = [
    { id: 0, name: "A1", x: 20, y: 30, w: 120, h: 110 },
    { id: 1, name: "A2", x: 20, y: 160, w: 120, h: 90 },
    { id: 2, name: "A3", x: 20, y: 270, w: 120, h: 120 },
    { id: 3, name: "A4", x: 20, y: 410, w: 120, h: 120 },
    { id: 4, name: "B1", x: 160, y: 30, w: 100, h: 140 },
    { id: 5, name: "B2", x: 160, y: 190, w: 100, h: 160 },
    { id: 6, name: "B3", x: 160, y: 370, w: 100, h: 160 },
    { id: 7, name: "C1", x: 280, y: 30, w: 90, h: 90 },
    { id: 8, name: "C2", x: 280, y: 140, w: 90, h: 80 },
    { id: 9, name: "C3", x: 280, y: 350, w: 90, h: 90 },
    { id: 10, name: "C4", x: 280, y: 450, w: 90, h: 80 },
    { id: 11, name: "D1", x: 540, y: 30, w: 130, h: 130 },
    { id: 12, name: "D2", x: 540, y: 180, w: 130, h: 160 },
    { id: 13, name: "D3", x: 540, y: 360, w: 130, h: 170 },
    { id: 14, name: "E1", x: 690, y: 30, w: 180, h: 240 },
    { id: 15, name: "E2", x: 690, y: 290, w: 180, h: 240 }
];

function plotCenter(p) { return { cx: p.x + p.w / 2, cy: p.y + p.h / 2 }; }

function getBuildingProximityBonus(plot) {
    let bonus = 0;
    MAP_BUILDINGS.forEach(b => {
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        const pcx = plot.x + plot.w / 2, pcy = plot.y + plot.h / 2;
        const d = Math.sqrt((bcx - pcx) ** 2 + (bcy - pcy) ** 2);
        if (d < 120) bonus += 40;
        else if (d < 200) bonus += 20;
        else if (d < 300) bonus += 10;
    });
    return bonus;
}

function getDensityBonus(plot) {
    const c = plotCenter(plot);
    let count = 0;
    MAP_PLOTS_BASE.forEach(other => {
        if (other.id === plot.id) return;
        const oc = plotCenter(other);
        const d = Math.sqrt((c.cx - oc.cx) ** 2 + (c.cy - oc.cy) ** 2);
        if (d < 160) count++;
    });
    return count * 5;
}

function getPlotNeighbors(plotId) {
    const a = MAP_PLOTS_BASE.find(p => p.id === plotId);
    if (!a) return [];
    const ca = plotCenter(a);
    return MAP_PLOTS_BASE.filter(b => {
        if (b.id === plotId) return false;
        const cb = plotCenter(b);
        const dx = ca.cx - cb.cx, dy = ca.cy - cb.cy;
        return Math.sqrt(dx * dx + dy * dy) < 160;
    }).map(b => b.id);
}

function countOwnedNeighbors(plotId, owners) {
    return getPlotNeighbors(plotId).filter(id => owners && owners[id]).length;
}

function calcPlotPrice(plot, owners) {
    const proximity = getBuildingProximityBonus(plot);
    const density = getDensityBonus(plot);
    const neighbors = countOwnedNeighbors(plot.id, owners);
    const neighborBonus = neighbors * 10;
    const totalMultiplier = 1 + (proximity + density + neighborBonus) / 100;
    return Math.floor(BASE_PLOT_PRICE * totalMultiplier);
}

const firebaseConfig = {
    apiKey: "AIzaSyDGltUohufVAc-FMIbO1sIvpd6xWSiaKdU",
    authDomain: "uniquestone.firebaseapp.com",
    databaseURL: "https://uniquestone-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "uniquestone",
    storageBucket: "uniquestone.firebasestorage.app",
    messagingSenderId: "114557024409",
    appId: "1:114557024409:web:23f1e0ad213e9cf7d2e008",
    measurementId: "G-TZ6SZXTJTF"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ===== СТАН =====
let currentUser = "";
let authMode = "login";
let gameState = {
    coins: 0, jobIndex: 0, xp: 0,
    taskProgress: 0, taskActive: false,
    activeCourseId: null, courseStartTime: 0,
    completedCourses: [], xpBoost: 0,
    credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 }
};
let sharedPlots = {};
let mapListener = null;
let selectedPlotId = null;
let saveTimer = null, heartbeatTimer = null, courseTimerInterval = null, dataListener = null, creditTimerInterval = null;
let isSaving = false, currentPage = "work";

// ===== МЕНЕДЖЕР МІНІ-ІГОР =====
const miniGames = new MiniGameManager(
    { window: "mg-window", icon: "mg-icon", title: "mg-title", badge: "mg-badge", body: "mg-body" },
    {
        onStep: (fraction) => {
            const job = getCurrentJob();
            const xpGain = Math.max(1, job.taskClicks * fraction) * (1 + gameState.xpBoost / 100);
            gameState.xp += xpGain;
            gameState.taskProgress = Math.min(job.taskClicks, gameState.taskProgress + job.taskClicks * fraction);
            renderStats();
            renderTask();
        },
        onComplete: () => {
            const job = getCurrentJob();
            gameState.coins += job.taskReward;
            gameState.taskActive = false;
            gameState.taskProgress = 0;
            renderStats();
            renderTask();
            updateWorkButtonState();
            saveGame();
            setGameStatus("Задачу закрито! +" + formatNumber(job.taskReward));
            showDialog("Задачу виконано!", "+" + formatNumberFull(job.taskReward) + " монет", "💰");
        },
        onStatus: (msg) => setGameStatus(msg)
    }
);

window.toggleSound = function () {
    sfx.muted = !sfx.muted;
    $("sound-toggle-btn").textContent = sfx.muted ? "🔇" : "🔊";
};

// ===== УТИЛІТИ =====
function $(id) { return document.getElementById(id); }
function formatNumber(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return Math.floor(n).toString();
}
function formatNumberFull(n) { return Math.floor(n).toLocaleString("uk-UA"); }
function formatTimeAgo(ts) {
    if (!ts) return "—";
    const d = Date.now() - ts;
    if (d < 60000) return "щойно";
    if (d < 3600000) return Math.floor(d / 60000) + " хв тому";
    if (d < 86400000) return Math.floor(d / 3600000) + " год тому";
    return Math.floor(d / 86400000) + " дн тому";
}
function formatDuration(ms) {
    if (ms <= 0) return "0:00:00";
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}
async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function colorFromName(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return `hsl(${h},65%,55%)`;
}

// ===== ДІАЛОГ =====
window.showDialog = (title, text, icon) => {
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-icon").textContent = icon || "ℹ️";
    $("dialog-overlay").classList.add("active");
};
window.closeDialog = () => $("dialog-overlay").classList.remove("active");

// ===== AUTH =====
window.switchAuthTab = (tab) => {
    authMode = tab;
    $("tab-login").classList.toggle("active", tab === "login");
    $("tab-register").classList.toggle("active", tab === "register");
    $("confirm-row").style.display = tab === "register" ? "flex" : "none";
    $("auth-submit").textContent = tab === "login" ? "Увійти" : "Зареєструватись";
    $("auth-switch-link").textContent = tab === "login" ? "Ще немає акаунта? Зареєструватись" : "Вже є акаунт? Увійти";
    $("auth-error").classList.remove("show"); $("auth-info").classList.remove("show");
};
window.toggleAuthMode = () => switchAuthTab(authMode === "login" ? "register" : "login");
function showError(msg) {
    $("auth-error").textContent = msg; $("auth-error").classList.add("show"); $("auth-info").classList.remove("show");
}
function setStatus(msg) { $("auth-status").textContent = msg; }
function setGameStatus(msg) { $("game-status").textContent = msg; }

window.handleAuth = async function () {
    const username = $("auth-username").value.trim();
    const password = $("auth-password").value;
    const password2 = $("auth-password2").value;
    const btn = $("auth-submit");
    if (!username || !password) return showError("Заповніть усі поля!");
    if (username.length < 3) return showError("Логін мінімум 3 символи!");
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return showError("Логін: лише латиниця, цифри, _");
    if (password.length < 4) return showError("Пароль мінімум 4 символи!");
    if (authMode === "register" && password !== password2) return showError("Паролі не співпадають!");

    btn.disabled = true; setStatus("Обробка...");
    try {
        const hash = await sha256(password);
        const snap = await get(child(ref(db), `users/${username}`));
        if (authMode === "register") {
            if (snap.exists()) return showError("Такий користувач вже існує!");
            await set(ref(db, `users/${username}`), {
                password: hash, createdAt: Date.now(), lastOnline: Date.now(),
                clicker: {
                    coins: 0, jobIndex: 0, xp: 0, taskProgress: 0, taskActive: false,
                    activeCourseId: null, courseStartTime: 0, completedCourses: [], xpBoost: 0,
                    credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 }
                }
            });
            currentUser = username;
            try { localStorage.setItem("w95_user", username); localStorage.setItem("w95_hash", hash); } catch (e) {}
            setStatus("Акаунт створено"); startGame();
        } else {
            if (!snap.exists()) return showError("Користувача не знайдено!");
            if (snap.val().password !== hash) return showError("Невірний пароль!");
            currentUser = username;
            try { localStorage.setItem("w95_user", username); localStorage.setItem("w95_hash", hash); } catch (e) {}
            try { await update(ref(db, `users/${username}`), { lastOnline: Date.now() }); } catch (e) {}
            setStatus("Вхід виконано"); startGame();
        }
    } catch (e) { showError("Помилка: " + e.message); setStatus("Помилка"); }
    finally { btn.disabled = false; }
};
["auth-username", "auth-password", "auth-password2"].forEach(id => {
    const el = $(id); if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") handleAuth(); });
});

// ===== СТАРТ / ЗАВАНТАЖЕННЯ =====
async function startGame() {
    $("auth-window").style.display = "none";
    $("game-screen").classList.add("active");
    $("stat-user").textContent = currentUser;
    $("game-title").textContent = "Win95 Work — " + currentUser;
    await loadGame();
    startLiveSync();
    startMapSync();
    checkCourseCompletion();
    renderAll();
    switchPage("work");
    if (saveTimer) clearInterval(saveTimer);
    saveTimer = setInterval(saveGame, SAVE_INTERVAL_MS);
    startHeartbeat();
    startCourseTimer();
    startCreditTimer();
    setGameStatus("Вітаємо, " + currentUser + "!");
}

async function loadGame() {
    try {
        const snap = await get(child(ref(db), `users/${currentUser}/clicker`));
        if (snap.exists()) {
            const d = snap.val();
            gameState = {
                coins: Number(d.coins) || 0,
                jobIndex: Math.min(Number(d.jobIndex) || 0, JOBS.length - 1),
                xp: Number(d.xp) || 0,
                taskProgress: Number(d.taskProgress) || 0,
                taskActive: Boolean(d.taskActive),
                activeCourseId: d.activeCourseId || null,
                courseStartTime: Number(d.courseStartTime) || 0,
                completedCourses: Array.isArray(d.completedCourses) ? d.completedCourses : [],
                xpBoost: Number(d.xpBoost) || 0,
                credit: d.credit || { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 }
            };
        }
        recalculateBoost();
    } catch (e) { showDialog("Помилка", "Не вдалося завантажити: " + e.message, "⚠️"); }
}

function startLiveSync() {
    if (dataListener) { off(dataListener); dataListener = null; }
    dataListener = onValue(ref(db, `users/${currentUser}/clicker`), snap => {
        if (!snap.exists()) return;
        const d = snap.val();
        gameState.coins = Number(d.coins) || 0;
        gameState.jobIndex = Math.min(Number(d.jobIndex) || 0, JOBS.length - 1);
        gameState.xp = Number(d.xp) || 0;
        if (!miniGames.isRunning()) {
            gameState.taskProgress = Number(d.taskProgress) || 0;
            gameState.taskActive = Boolean(d.taskActive);
        }
        gameState.activeCourseId = d.activeCourseId || null;
        gameState.courseStartTime = Number(d.courseStartTime) || 0;
        gameState.completedCourses = Array.isArray(d.completedCourses) ? d.completedCourses : [];
        gameState.xpBoost = Number(d.xpBoost) || 0;
        gameState.credit = d.credit || { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
        recalculateBoost();
        checkCourseCompletion();
        renderAll();
    });
}

function startMapSync() {
    if (mapListener) { off(mapListener); mapListener = null; }
    mapListener = onValue(ref(db, "plots"), snap => {
        sharedPlots = snap.exists() ? snap.val() : {};
        renderMap();
        if (selectedPlotId !== null) showMapInfo(selectedPlotId);
    });
}

function recalculateBoost() {
    let b = 0;
    gameState.completedCourses.forEach(id => { const c = COURSES.find(x => x.id === id); if (c) b += c.boost; });
    gameState.xpBoost = b;
}

async function saveGame() {
    if (!currentUser) return;
    if (isSaving) { await new Promise(r => setTimeout(r, 200)); if (isSaving) return; }
    isSaving = true;
    try {
        await update(ref(db, `users/${currentUser}/clicker`), {
            coins: gameState.coins, jobIndex: gameState.jobIndex, xp: gameState.xp,
            taskProgress: gameState.taskProgress, taskActive: gameState.taskActive,
            activeCourseId: gameState.activeCourseId, courseStartTime: gameState.courseStartTime,
            completedCourses: gameState.completedCourses, xpBoost: gameState.xpBoost,
            credit: gameState.credit
        });
        const now = new Date();
        $("save-status").textContent = "💾 " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");
    } catch (e) { $("save-status").textContent = "⚠ Помилка"; }
    finally { isSaving = false; }
}

// ===== КУРСИ =====
function getCurrentJob() { return JOBS[gameState.jobIndex] || JOBS[0]; }
function isCourseRunning() { return !!gameState.activeCourseId; }
function getRemainingCourseMs() {
    if (!gameState.activeCourseId) return 0;
    const c = COURSES.find(x => x.id === gameState.activeCourseId);
    if (!c) return 0;
    return Math.max(0, c.durationMs - (Date.now() - gameState.courseStartTime));
}
function checkCourseCompletion() {
    if (!gameState.activeCourseId) return;
    if (getRemainingCourseMs() <= 0) {
        const c = COURSES.find(x => x.id === gameState.activeCourseId);
        if (c && !gameState.completedCourses.includes(c.id)) {
            gameState.completedCourses.push(c.id);
            recalculateBoost();
        }
        gameState.activeCourseId = null;
        gameState.courseStartTime = 0;
        setGameStatus("Курс завершено!");
        showDialog("Курс завершено!", (c ? c.name : "Курс") + "\n+" + (c ? c.boost : 0) + "% XP", "🎓");
        saveGame();
    }
}

// ===== КРЕДИТИ =====
function isBankBlocked() {
    return gameState.credit && gameState.credit.amount > 0 && gameState.credit.overdue;
}
function getCreditLimit() {
    const jobLimit = getCurrentJob().creditLimit || 0;
    const balanceLimit = Math.floor(gameState.coins * 0.5);
    return Math.max(jobLimit, balanceLimit);
}
window.takeCredit = async function () {
    if (gameState.credit.amount > 0) return showDialog("Кредит уже є", "Спочатку погасіть поточний борг.", "⚠️");
    const limit = getCreditLimit();
    if (limit <= 0) return showDialog("Ліміт 0", "Заробіть більше або підвищіть посаду.", "💸");
    const now = Date.now();
    gameState.credit = { amount: limit, takenAt: now, dueAt: now + 30 * 60 * 1000, overdue: false, lastPenaltyAt: 0 };
    gameState.coins += limit;
    renderAll(); saveGame();
    setGameStatus("Кредит взято: +" + formatNumber(limit));
    showDialog("Кредит взято!", "Сума: " + formatNumberFull(limit) + "\nПовернути до: +30 хв", "🏦");
};
window.repayCredit = async function () {
    const debt = gameState.credit.amount;
    if (debt <= 0) return;
    if (gameState.coins < debt) return showDialog("Недостатньо монет", "Потрібно " + formatNumberFull(debt) + " для погашення.", "💸");
    gameState.coins -= debt;
    gameState.credit = { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
    renderAll(); saveGame();
    setGameStatus("Кредит погашено");
    showDialog("Кредит погашено!", "Борг закрито.", "✅");
};
function checkCreditPenalties() {
    const c = gameState.credit;
    if (!c || c.amount <= 0) return;
    const now = Date.now();
    if (now < c.dueAt) return;
    if (!c.overdue) { c.overdue = true; c.lastPenaltyAt = now; setGameStatus("Кредит прострочено!"); }
    if (now - c.lastPenaltyAt >= 5 * 60 * 1000) {
        const penalty = Math.floor(c.amount * 0.1);
        c.amount += penalty;
        c.lastPenaltyAt = now;
        renderAll(); saveGame();
        setGameStatus("Штраф за прострочку: +" + formatNumber(penalty) + " до боргу");
    }
}
function startCreditTimer() {
    if (creditTimerInterval) clearInterval(creditTimerInterval);
    creditTimerInterval = setInterval(() => {
        checkCreditPenalties();
        if (currentPage === "bank") renderBank();
    }, 5000);
}

// ===== РЕНДЕР =====
function renderAll() {
    renderStats(); renderTask(); renderJobsList(); renderShop();
    renderMap(); renderBank(); updateWorkButtonState();
}
function renderStats() {
    const job = getCurrentJob();
    $("stat-coins").textContent = formatNumber(gameState.coins);
    $("stat-job").textContent = job.name;
    $("stat-xp").textContent = formatNumber(gameState.xp);
    $("stat-boost").textContent = gameState.xpBoost + "%";
    $("big-coins").textContent = formatNumberFull(gameState.coins);
    const needed = job.xpNeeded || 1;
    const pct = job.xpNeeded === 0 ? 100 : Math.min(100, (gameState.xp / needed) * 100);
    $("xp-bar").style.width = pct + "%";
    $("xp-text").textContent = job.xpNeeded === 0 ? "Макс. рівень" : formatNumber(gameState.xp) + " / " + formatNumber(needed);
    $("promote-btn").classList.toggle("show", job.xpNeeded > 0 && gameState.xp >= job.xpNeeded);
}
function renderTask() {
    const job = getCurrentJob();
    const needed = job.taskClicks;
    const prog = gameState.taskActive ? Math.floor(gameState.taskProgress) : 0;
    $("task-bar").style.width = (needed > 0 ? Math.min(100, (gameState.taskProgress / needed) * 100) : 0) + "%";
    $("task-text").textContent = prog + " / " + needed;
    $("task-reward").textContent = "Нагорода: " + formatNumberFull(job.taskReward) + " 💰";
    $("task-title").textContent = gameState.taskActive ? "Поточна задача (" + job.name + ")" : "Задача не почата";
}
function updateWorkButtonState() {
    const btn = $("big-click"), label = $("big-click-label"), blocker = $("course-blocker");
    if (isBankBlocked()) {
        miniGames.stop();
        btn.style.display = "flex";
        btn.disabled = true; label.textContent = "🚫 БОРГ";
        blocker.classList.remove("show"); return;
    }
    if (isCourseRunning()) {
        miniGames.stop();
        btn.style.display = "flex";
        btn.disabled = true; label.textContent = "КУРС У ПРОЦЕСІ";
        blocker.classList.add("show");
        $("course-blocker-timer").textContent = "Залишилось: " + formatDuration(getRemainingCourseMs());
    } else {
        blocker.classList.remove("show");
        if (miniGames.isRunning()) {
            btn.style.display = "none";
        } else {
            btn.style.display = "flex";
            btn.disabled = false;
            label.textContent = gameState.taskActive ? "ПРОДОВЖИТИ ЗАДАЧУ" : "ПОЧАТИ ЗАДАЧУ";
        }
    }
}
function renderJobsList() {
    let html = "";
    JOBS.forEach((job, i) => {
        const isCurrent = i === gameState.jobIndex, isLocked = i > gameState.jobIndex;
        const status = isCurrent ? "← зараз" : (isLocked ? "🔒" : "✓");
        html += `<div class="job-row${isCurrent ? " current" : ""}${isLocked ? " locked" : ""}">
            <span class="job-name">${i + 1}. ${job.name}</span>
            <span class="job-pay">+${formatNumber(job.taskReward)}</span>
            <span class="job-status">${status}</span></div>`;
    });
    $("jobs-list").innerHTML = html;
}
function renderShop() {
    let html = "";
    COURSES.forEach(c => {
        const done = gameState.completedCourses.includes(c.id);
        const active = gameState.activeCourseId === c.id;
        const can = !done && !active && !gameState.activeCourseId && gameState.coins >= c.price;
        let status = done ? `<span style="color:#008000;font-weight:bold">✓ Пройдено (+${c.boost}%)</span>` :
            active ? `<span class="course-timer">Залишилось: ${formatDuration(getRemainingCourseMs())}</span>` :
                `<button class="btn" ${can ? "" : "disabled"} onclick="buyCourse('${c.id}')">Купити (${formatNumber(c.price)})</button>`;
        html += `<div class="shop-item${done ? " completed" : ""}${active ? " active-course" : ""}">
            <div class="shop-item-header"><span class="shop-item-name">${c.name}</span><span class="shop-item-boost">+${c.boost}% XP</span></div>
            <div class="shop-item-info">Тривалість: ${Math.round(c.durationMs / 3600000)} год</div>
            <div class="shop-item-actions">${status}</div></div>`;
    });
    $("shop-list").innerHTML = html;
}
function renderMap() {
    const plotsLayer = $("map-plots"), bldLayer = $("map-buildings");
    let html = "";
    MAP_PLOTS_BASE.forEach(p => {
        const owned = sharedPlots[p.id];
        const price = calcPlotPrice(p, sharedPlots);
        const canAfford = gameState.coins >= price && !owned;
        const cls = owned
            ? (owned.owner === currentUser ? "owned-self" : "owned-other")
            : (canAfford ? "" : "locked");
        const selected = selectedPlotId === p.id ? " selected" : "";
        let style = `left:${p.x / MAP_W * 100}%;top:${p.y / MAP_H * 100}%;width:${p.w / MAP_W * 100}%;height:${p.h / MAP_H * 100}%`;
        if (owned && owned.owner !== currentUser) style += `;background:${colorFromName(owned.owner)}`;
        const inner = owned
            ? `<div class="plot-owner">${escapeHtml(owned.owner)}</div>`
            : `<div class="plot-name">${p.name}</div><div class="plot-price">${formatNumber(price)}</div>`;
        html += `<div class="map-plot ${cls}${selected}" style="${style}" onclick="selectPlot(${p.id})">${inner}</div>`;
    });
    plotsLayer.innerHTML = html;
    let bHtml = "";
    MAP_BUILDINGS.forEach(b => {
        bHtml += `<div class="map-building ${b.cls}" style="left:${b.x / MAP_W * 100}%;top:${b.y / MAP_H * 100}%;width:${b.w / MAP_W * 100}%;height:${b.h / MAP_H * 100}%" onclick="clickBuilding('${b.id}')">
            <div class="bld-icon">${b.icon}</div><div class="bld-name">${b.name}</div><div class="bld-sub">${b.sub}</div></div>`;
    });
    bldLayer.innerHTML = bHtml;
}
window.selectPlot = function (plotId) {
    selectedPlotId = plotId;
    renderMap();
    showMapInfo(plotId);
};
function showMapInfo(plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    if (!p) return;
    $("map-info-panel").classList.add("show");
    const owned = sharedPlots[plotId];
    const price = calcPlotPrice(p, sharedPlots);
    const proximity = getBuildingProximityBonus(p);
    const density = getDensityBonus(p);
    const neighbors = countOwnedNeighbors(plotId, sharedPlots);
    const bonusText = [];
    if (proximity > 0) bonusText.push(`поруч будівлі +${proximity}%`);
    if (density > 0) bonusText.push(`густота +${density}%`);
    if (neighbors > 0) bonusText.push(`сусідів ${neighbors} (+${neighbors * 10}%)`);
    $("info-name").textContent = p.name;
    $("info-owner").textContent = owned ? owned.owner : "—";
    $("info-price").textContent = owned ? "—" : formatNumberFull(price);
    $("info-bonus").textContent = bonusText.length ? bonusText.join(", ") : "немає";
    const buyBtn = $("info-buy-btn");
    if (owned) { buyBtn.textContent = owned.owner === currentUser ? "Ваша ділянка" : "Зайнято"; buyBtn.disabled = true; }
    else if (gameState.coins < price) { buyBtn.textContent = "Недостатньо монет"; buyBtn.disabled = true; }
    else { buyBtn.textContent = "Купити (" + formatNumber(price) + ")"; buyBtn.disabled = false; }
}
window.closeMapInfo = function () {
    selectedPlotId = null;
    $("map-info-panel").classList.remove("show");
    renderMap();
};
window.buySelectedPlot = async function () {
    if (selectedPlotId === null) return;
    const p = MAP_PLOTS_BASE.find(x => x.id === selectedPlotId);
    if (!p) return;
    if (sharedPlots[selectedPlotId]) return showDialog("Зайнято", "Ділянка вже куплена.", "⚠️");
    const price = calcPlotPrice(p, sharedPlots);
    if (gameState.coins < price) return showDialog("Недостатньо коштів", "Потрібно " + formatNumberFull(price), "💸");
    try {
        const result = await runTransaction(ref(db, `plots/${selectedPlotId}`), (current) => {
            if (current === null) return { owner: currentUser, price: price, boughtAt: Date.now() };
            return;
        });
        if (!result.committed) return showDialog("Не встигли", "Хтось купив цю ділянку раніше.", "⚠️");
        gameState.coins -= price;
        renderAll(); saveGame();
        setGameStatus("Ділянку куплено: " + p.name);
        showDialog("Ділянку куплено!", p.name + "\nза " + formatNumberFull(price), "🗺️");
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};
window.clickBuilding = function (id) {
    if (id === "bank") switchPage("bank");
    else if (id === "corp") {
        showDialog("КовельКорп", "Тут працюють усі гравці.\nПерейти до роботи?", "🏢");
        setTimeout(() => {
            const dialogBody = document.querySelector(".dialog .btn-row");
            if (dialogBody && !dialogBody.querySelector(".goto-work")) {
                const btn = document.createElement("button");
                btn.className = "btn goto-work";
                btn.textContent = "Працювати";
                btn.onclick = () => { closeDialog(); switchPage("work"); };
                dialogBody.insertBefore(btn, dialogBody.firstChild);
            }
        }, 0);
    }
};
function renderBank() {
    const c = gameState.credit;
    const blocked = isBankBlocked();
    $("bank-blocked").classList.toggle("show", blocked);
    $("bank-warning").classList.toggle("show", c.amount > 0 && c.overdue);
    const limit = getCreditLimit();
    $("credit-limit").textContent = "до " + formatNumberFull(limit);
    if (c.amount > 0) {
        $("credit-card-info").style.display = "none";
        $("credit-active-card").style.display = "block";
        $("credit-debt").textContent = formatNumberFull(c.amount) + " 💰";
        const remaining = c.dueAt - Date.now();
        if (remaining > 0) $("credit-due-text").textContent = "Повернути через: " + formatDuration(remaining);
        else $("credit-due-text").textContent = "⚠️ Прострочено на " + formatDuration(Date.now() - c.dueAt) + "! +10% до боргу кожні 5 хв.";
        const total = c.amount + Math.floor(c.amount * 0.05);
        $("credit-debt-fill").style.width = Math.min(100, (gameState.coins / total) * 100) + "%";
        $("credit-debt-text").textContent = formatNumber(gameState.coins) + " / " + formatNumber(total);
        $("credit-repay-btn").textContent = "Погасити (" + formatNumber(c.amount) + ")";
        $("credit-repay-btn").disabled = gameState.coins < c.amount;
    } else {
        $("credit-card-info").style.display = "block";
        $("credit-active-card").style.display = "none";
        $("credit-info-text").textContent =
            "Ліміт: 50% балансу або за посадою (що більше).\n" +
            "Відсоток: 5%. Термін: 30 хв.\n" +
            "Прострочка: +10% до боргу кожні 5 хв, блокування роботи.";
        $("credit-take-btn").disabled = limit <= 0;
    }
}

window.startTaskOrShowStatus = function () {
    if (!currentUser || isCourseRunning() || isBankBlocked()) return;
    sfx.click();
    gameState.taskActive = true;
    gameState.taskProgress = 0;
    renderTask();
    miniGames.startRandom(gameState.jobIndex);
    updateWorkButtonState();
    setGameStatus("Задачу розпочато!");
};

window.doPromote = function () {
    const job = getCurrentJob();
    if (job.xpNeeded <= 0 || gameState.xp < job.xpNeeded) return;
    miniGames.stop();
    gameState.xp -= job.xpNeeded;
    gameState.jobIndex = Math.min(gameState.jobIndex + 1, JOBS.length - 1);
    gameState.taskActive = false; gameState.taskProgress = 0;
    sfx.win();
    renderAll();
    setGameStatus("Підвищення! " + getCurrentJob().name);
    showDialog("Підвищення!", "Ви стали: " + getCurrentJob().name, "🎉");
};

window.buyCourse = async function (id) {
    if (isCourseRunning()) return showDialog("Неможливо", "Спочатку закінчіть поточний курс!", "⚠️");
    const c = COURSES.find(x => x.id === id);
    if (!c || gameState.completedCourses.includes(id)) return;
    if (gameState.coins < c.price) return showDialog("Недостатньо коштів", "Потрібно " + formatNumberFull(c.price), "💸");
    miniGames.stop();
    gameState.coins -= c.price;
    gameState.activeCourseId = c.id;
    gameState.courseStartTime = Date.now();
    gameState.taskActive = false; gameState.taskProgress = 0;
    renderAll(); startCourseTimer();
    try { isSaving = false; await saveGame(); setGameStatus("Курс розпочато"); showDialog("Курс розпочато!", c.name, "📚"); }
    catch (e) { showDialog("Помилка", "Не вдалося зберегти", "⚠️"); }
};
function startCourseTimer() {
    if (courseTimerInterval) clearInterval(courseTimerInterval);
    courseTimerInterval = setInterval(() => {
        checkCourseCompletion();
        if (isCourseRunning()) { updateWorkButtonState(); if (currentPage === "shop") renderShop(); }
        else { clearInterval(courseTimerInterval); courseTimerInterval = null; renderAll(); }
    }, 1000);
}
window.switchPage = function (page) {
    currentPage = page;
    if (page !== "work" && miniGames.isRunning()) {
        miniGames.stop();
        gameState.taskActive = false;
        gameState.taskProgress = 0;
        renderTask();
        updateWorkButtonState();
    }
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".tab-strip .tab").forEach(t => t.classList.remove("active"));
    const pe = $("page-" + page); if (pe) pe.classList.add("active");
    const tabId = (page === "bank") ? "tabnav-work" : "tabnav-" + page;
    const te = $(tabId); if (te) te.classList.add("active");
    if (page === "leaderboard") { loadLeaderboard(); loadOnline(); }
    if (page === "shop") renderShop();
    if (page === "map") renderMap();
    if (page === "bank") renderBank();
};

// ===== HEARTBEAT =====
function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}
async function sendHeartbeat() {
    if (!currentUser) return;
    try { await update(ref(db, `users/${currentUser}`), { lastOnline: Date.now() }); } catch (e) {}
}

// ===== ЛІДЕРБОРД =====
window.loadLeaderboard = async function () {
    const listEl = $("lb-list"), myRankEl = $("lb-my-rank");
    listEl.innerHTML = '<div class="lb-loading">Завантаження...</div>'; myRankEl.textContent = "—";
    try {
        const snap = await get(child(ref(db), "users"));
        if (!snap.exists()) { listEl.innerHTML = '<div class="lb-empty">Ще немає гравців</div>'; return; }
        const list = Object.entries(snap.val()).map(([name, d]) => ({ name, coins: d?.clicker?.coins || 0 }));
        list.sort((a, b) => b.coins - a.coins);
        let html = "";
        list.slice(0, LEADERBOARD_LIMIT).forEach((u, i) => {
            const rank = i + 1, rc = rank === 1 ? "top1" : rank === 2 ? "top2" : rank === 3 ? "top3" : "";
            const self = u.name === currentUser;
            const medal = rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : "";
            html += `<div class="lb-row${self ? " self" : ""}"><span class="lb-rank ${rc}">${medal}${rank}</span>
                <span class="lb-name">${escapeHtml(u.name)}</span><span class="lb-coins">${formatNumberFull(u.coins)}</span></div>`;
        });
        listEl.innerHTML = html;
        const idx = list.findIndex(u => u.name === currentUser);
        myRankEl.textContent = idx >= 0 ? `Ваше місце: #${idx + 1} з ${list.length}` : "Вас немає в списку";
    } catch (e) { listEl.innerHTML = '<div class="lb-empty">Помилка</div>'; }
};

// ===== ОНЛАЙН =====
window.loadOnline = async function () {
    const listEl = $("online-list"), countEl = $("online-count");
    listEl.innerHTML = '<div class="lb-loading">Завантаження...</div>'; countEl.textContent = "—";
    try {
        const snap = await get(child(ref(db), "users"));
        if (!snap.exists()) { listEl.innerHTML = '<div class="lb-empty">Немає гравців</div>'; countEl.textContent = "0 онлайн"; return; }
        const now = Date.now();
        const online = Object.entries(snap.val())
            .map(([name, d]) => ({ name, coins: d?.clicker?.coins || 0, lastOnline: Number(d?.lastOnline) || 0, online: (now - (Number(d?.lastOnline) || 0)) < ONLINE_THRESHOLD_MS }))
            .filter(u => u.online)
            .sort((a, b) => a.name === currentUser ? -1 : b.name === currentUser ? 1 : b.lastOnline - a.lastOnline);
        if (!online.length) { listEl.innerHTML = '<div class="lb-empty">Нікого немає онлайн</div>'; countEl.textContent = "0 онлайн"; return; }
        let html = "";
        online.forEach(u => {
            const self = u.name === currentUser;
            html += `<div class="online-row${self ? " self" : ""}"><span class="online-dot"></span>
                <span class="lb-name">${escapeHtml(u.name)}${self ? " (ви)" : ""}</span>
                <span class="lb-coins">${formatNumberFull(u.coins)}</span>
                <span class="muted" style="min-width:70px;text-align:right">${formatTimeAgo(u.lastOnline)}</span></div>`;
        });
        listEl.innerHTML = html; countEl.textContent = online.length + " онлайн";
    } catch (e) { listEl.innerHTML = '<div class="lb-empty">Помилка</div>'; }
};

// ===== LOGOUT =====
window.logout = async function () {
    if (!currentUser) return;
    miniGames.stop();
    await saveGame();
    try { await update(ref(db, `users/${currentUser}`), { lastOnline: Date.now() }); } catch (e) {}
    try { localStorage.removeItem("w95_user"); localStorage.removeItem("w95_hash"); } catch (e) {}
    if (saveTimer) clearInterval(saveTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (courseTimerInterval) clearInterval(courseTimerInterval);
    if (creditTimerInterval) clearInterval(creditTimerInterval);
    if (dataListener) { off(dataListener); dataListener = null; }
    if (mapListener) { off(mapListener); mapListener = null; }
    currentUser = "";
    gameState = { coins: 0, jobIndex: 0, xp: 0, taskProgress: 0, taskActive: false, activeCourseId: null, courseStartTime: 0, completedCourses: [], xpBoost: 0, credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 } };
    sharedPlots = {}; selectedPlotId = null;
    $("game-screen").classList.remove("active");
    $("auth-window").style.display = "flex";
    $("auth-username").value = $("auth-password").value = $("auth-password2").value = "";
    switchAuthTab("login"); setStatus("Вихід виконано");
};

// ===== BEFOREUNLOAD =====
window.addEventListener("beforeunload", () => {
    if (currentUser) {
        try {
            update(ref(db, `users/${currentUser}/clicker`), {
                coins: gameState.coins, jobIndex: gameState.jobIndex, xp: gameState.xp,
                taskProgress: gameState.taskProgress, taskActive: gameState.taskActive,
                activeCourseId: gameState.activeCourseId, courseStartTime: gameState.courseStartTime,
                completedCourses: gameState.completedCourses, xpBoost: gameState.xpBoost,
                credit: gameState.credit
            });
            update(ref(db, `users/${currentUser}`), { lastOnline: Date.now() });
        } catch (e) {}
    }
});

// ===== AUTO LOGIN =====
(async function autoLogin() {
    try {
        const u = localStorage.getItem("w95_user"), h = localStorage.getItem("w95_hash");
        if (!u || !h) return;
        const snap = await get(child(ref(db), `users/${u}`));
        if (snap.exists() && snap.val().password === h) {
            currentUser = u;
            try { await update(ref(db, `users/${u}`), { lastOnline: Date.now() }); } catch (e) {}
            startGame();
        } else { localStorage.removeItem("w95_user"); localStorage.removeItem("w95_hash"); }
    } catch (e) {}
})();

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
    switchAuthTab("login");
    $("auth-username").focus();
    console.log("%cWin95 Work v" + APP_VERSION, "color:#000080;font-weight:bold;font-family:monospace");
});
