import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, child, update, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { MiniGameManager, sfx } from "./minigames.js";

const APP_VERSION = "2.4.0";
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 30000;
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const LEADERBOARD_LIMIT = 100;
const RENT_TICK_MS = 60000;
const DEPOSIT_RATE_PER_MIN = 0.03;

// ===== КУРСИ (ПЕРЕПУСТКА ТА ПІДВИЩЕННЯ У КОВЕЛЬКОРП) =====
const COURSES = [
    { id: "basics", name: "Основи програмування", price: 800, durationMs: 3600000, boost: 10, desc: "Обов'язковий курс для вступу в КовельКорп (Стажер / Оператор)" },
    { id: "algorithms", name: "Алгоритми та структури даних", price: 3500, durationMs: 10800000, boost: 15, desc: "Потрібен для звання Junior QA та Junior Developer" },
    { id: "cleancode", name: "Clean Code (книга)", price: 9000, durationMs: 18000000, boost: 20, desc: "Потрібен для звання Middle Developer" },
    { id: "sysdesign", name: "Системний дизайн", price: 22000, durationMs: 28800000, boost: 25, desc: "Потрібен для звання Senior Developer" },
    { id: "leadership", name: "Лідерство і менеджмент", price: 45000, durationMs: 43200000, boost: 30, desc: "Потрібен для звання Team Lead" },
    { id: "architecture", name: "Архітектура високих навантажень", price: 90000, durationMs: 64800000, boost: 40, desc: "Потрібен для звання Tech Lead та CTO" }
];

// ===== КАР'ЄРА КОВЕЛЬКОРП (КОЖНЕ ЗВАННЯ ПОТРЕБУЄ КУРСУ) =====
const JOBS = [
    { name: "Стажер", pay: 1, xpNeeded: 500, taskClicks: 10, taskReward: 5, creditLimit: 15000, reqCourse: "basics" },
    { name: "Оператор підтримки", pay: 3, xpNeeded: 1500, taskClicks: 15, taskReward: 18, creditLimit: 35000, reqCourse: "basics" },
    { name: "Junior QA", pay: 8, xpNeeded: 4000, taskClicks: 22, taskReward: 60, creditLimit: 75000, reqCourse: "algorithms" },
    { name: "Junior Developer", pay: 20, xpNeeded: 10000, taskClicks: 30, taskReward: 180, creditLimit: 150000, reqCourse: "algorithms" },
    { name: "Middle Developer", pay: 50, xpNeeded: 25000, taskClicks: 40, taskReward: 500, creditLimit: 350000, reqCourse: "cleancode" },
    { name: "Senior Developer", pay: 120, xpNeeded: 60000, taskClicks: 55, taskReward: 1500, creditLimit: 800000, reqCourse: "sysdesign" },
    { name: "Team Lead", pay: 300, xpNeeded: 150000, taskClicks: 75, taskReward: 4500, creditLimit: 1800000, reqCourse: "leadership" },
    { name: "Tech Lead", pay: 700, xpNeeded: 400000, taskClicks: 100, taskReward: 12000, creditLimit: 4000000, reqCourse: "architecture" },
    { name: "CTO", pay: 1500, xpNeeded: 0, taskClicks: 140, taskReward: 35000, creditLimit: 10000000, reqCourse: "architecture" }
];

// ===== ОКРЕМА КАР'ЄРА ПРИВАТНОГО СЕКТОРУ (РОБОТА В МАГАЗИНАХ/БІЗНЕСАХ ІНШИХ ГРАВЦІВ) =====
const PRIVATE_JOBS = [
    { name: "Підсобник / Кур'єр", mult: 1.0, xpNeeded: 80, creditLimit: 12000 },
    { name: "Продавець-касир", mult: 1.25, xpNeeded: 250, creditLimit: 25000 },
    { name: "Старший зміни", mult: 1.5, xpNeeded: 700, creditLimit: 60000 },
    { name: "Товарознавець", mult: 1.85, xpNeeded: 1800, creditLimit: 140000 },
    { name: "Керуючий філією", mult: 2.3, xpNeeded: 4500, creditLimit: 350000 },
    { name: "Виконавчий директор мережі", mult: 3.0, xpNeeded: 0, creditLimit: 900000 }
];

// ===== КЛАСИФІКАЦІЯ ЗЕМЛІ ТА ЗАБУДОВА (ЯСКРАВІ КОЛЬОРИ НА МАПІ + КАПІТАЛЬНІ ЦІНИ) =====
const ZONE_INFO = {
    residential: {
        name: "🏡 Житлова зона",
        basePrice: 15000,
        fillFree: "#2ecc71",
        borderFree: "#0b5e28",
        buildings: [
            { id: "kiosk", name: "Магазинчик біля дому", icon: "🏪", cost: 25000, income: 350, defaultWage: 8, clickProfit: 14 },
            { id: "house", name: "Приватний котедж", icon: "🏡", cost: 65000, income: 1050, defaultWage: 18, clickProfit: 32 },
            { id: "apartments", name: "Житлова забудова (ЖК)", icon: "🏢", cost: 160000, income: 2900, defaultWage: 40, clickProfit: 75 }
        ]
    },
    commercial: {
        name: "🏪 Комерційна зона",
        basePrice: 55000,
        fillFree: "#2980ff",
        borderFree: "#003080",
        buildings: [
            { id: "cafe", name: "Піцерія / Кав'ярня", icon: "🍕", cost: 85000, income: 1450, defaultWage: 25, clickProfit: 45 },
            { id: "mall", name: "Торговий центр (ТРЦ)", icon: "🛍️", cost: 240000, income: 4500, defaultWage: 65, clickProfit: 120 },
            { id: "it_hub", name: "IT-Бізнес Центр", icon: "💻", cost: 600000, income: 12500, defaultWage: 160, clickProfit: 300 }
        ]
    },
    industrial: {
        name: "🏭 Промислова зона",
        basePrice: 180000,
        fillFree: "#ff7722",
        borderFree: "#7a2200",
        buildings: [
            { id: "auto_weld", name: "Зварювальний цех і СТО", icon: "🔧", cost: 250000, income: 4800, defaultWage: 75, clickProfit: 140 },
            { id: "logistics", name: "Логістичний термінал", icon: "🚛", cost: 650000, income: 14000, defaultWage: 190, clickProfit: 350 },
            { id: "factory", name: "Завод КовельПром", icon: "🏭", cost: 1500000, income: 38000, defaultWage: 450, clickProfit: 850 }
        ]
    }
};

// ===== ОБМЕЖЕННЯ МАПИ ТІЛЬКИ НА КОВЕЛІ =====
const KOVEL_CENTER = [51.2135, 24.7060];
const KOVEL_BOUNDS = [
    [51.1860, 24.6480],
    [51.2420, 24.7620]
];

// Спеціальні будівлі (винесені на окремий верхній шар Leaflet pane, щоб ніколи не перекривались ділянками)
const MAP_BUILDINGS = [
    { id: "bank", name: "КовельБанк", icon: "🏦", cls: "bank", lat: 51.2121, lng: 24.7102, sub: "Кредити та Депозити" },
    { id: "corp", name: "КовельКорп", icon: "🏢", cls: "corp", lat: 51.2208, lng: 24.7120, sub: "IT-Корпорація" },
    { id: "bohdan", name: "Дім Богдана Поліщука", icon: "👨‍🏭", cls: "bohdan", lat: 51.2226, lng: 24.7392, sub: "Миколайчука, 100" }
];

// ===== 48 ДІЛЯНОК РЕАЛЬНОГО КОВЕЛЯ =====
const MAP_PLOTS_BASE = [
    // --- КОМЕРЦІЙНА ЗОНА (15 ділянок) ---
    { id: 0,  zone: "commercial",  name: "Незалежності (ЦУМ)",       lat: 51.2138, lng: 24.7055, dLat: 0.0010, dLng: 0.0017 },
    { id: 1,  zone: "commercial",  name: "Парк Шевченка (Набережна)",lat: 51.2142, lng: 24.7001, dLat: 0.0011, dLng: 0.0018 },
    { id: 4,  zone: "commercial",  name: "Привокзальна площа",       lat: 51.2220, lng: 24.7152, dLat: 0.0010, dLng: 0.0017 },
    { id: 5,  zone: "commercial",  name: "Автовокзал Ковель",        lat: 51.2194, lng: 24.7082, dLat: 0.0010, dLng: 0.0017 },
    { id: 6,  zone: "commercial",  name: "Бульвар Лесі Українки",    lat: 51.2168, lng: 24.7138, dLat: 0.0010, dLng: 0.0017 },
    { id: 16, zone: "commercial",  name: "Незалежності 73 (Ратуша)", lat: 51.2128, lng: 24.7068, dLat: 0.0009, dLng: 0.0016 },
    { id: 17, zone: "commercial",  name: "Незалежності 101 (Пасаж)", lat: 51.2133, lng: 24.7026, dLat: 0.0010, dLng: 0.0016 },
    { id: 18, zone: "commercial",  name: "Незалежності 140",         lat: 51.2145, lng: 24.6968, dLat: 0.0010, dLng: 0.0017 },
    { id: 19, zone: "commercial",  name: "Театральна площа",         lat: 51.2155, lng: 24.7062, dLat: 0.0010, dLng: 0.0017 },
    { id: 20, zone: "commercial",  name: "Ветеранів (Торгова)",      lat: 51.2182, lng: 24.7105, dLat: 0.0010, dLng: 0.0017 },
    { id: 21, zone: "commercial",  name: "Привокзальний Ринок",      lat: 51.2235, lng: 24.7118, dLat: 0.0010, dLng: 0.0017 },
    { id: 22, zone: "commercial",  name: "Сагайдачного (Центр)",     lat: 51.2198, lng: 24.7042, dLat: 0.0010, dLng: 0.0017 },
    { id: 23, zone: "commercial",  name: "Володимирська 15 (Плаза)", lat: 51.2156, lng: 24.6942, dLat: 0.0010, dLng: 0.0017 },
    { id: 24, zone: "commercial",  name: "Міський Пляж (Турія)",     lat: 51.2165, lng: 24.6995, dLat: 0.0010, dLng: 0.0017 },
    { id: 25, zone: "commercial",  name: "Варшавський Маркет",       lat: 51.2060, lng: 24.6855, dLat: 0.0011, dLng: 0.0019 },

    // --- ПРОМИСЛОВА ЗОНА (11 ділянок) ---
    { id: 9,  zone: "industrial",  name: "Завод Ковельсільмаш",      lat: 51.2047, lng: 24.7203, dLat: 0.0014, dLng: 0.0024 },
    { id: 11, zone: "industrial",  name: "Володимирська 100 (База)", lat: 51.2081, lng: 24.6815, dLat: 0.0014, dLng: 0.0024 },
    { id: 12, zone: "industrial",  name: "Варшавський Промвузол",    lat: 51.2022, lng: 24.6695, dLat: 0.0014, dLng: 0.0024 },
    { id: 13, zone: "industrial",  name: "Володимирська 150 (Митниця)", lat: 51.1992, lng: 24.6765, dLat: 0.0014, dLng: 0.0024 },
    { id: 26, zone: "industrial",  name: "Локомотивне Депо Ковель",  lat: 51.2248, lng: 24.7185, dLat: 0.0014, dLng: 0.0024 },
    { id: 27, zone: "industrial",  name: "Вагонне Депо (Колії)",     lat: 51.2268, lng: 24.7065, dLat: 0.0014, dLng: 0.0024 },
    { id: 28, zone: "industrial",  name: "Брестська Промбаза",       lat: 51.2292, lng: 24.6938, dLat: 0.0014, dLng: 0.0024 },
    { id: 29, zone: "industrial",  name: "Льонозавод (Промзона)",    lat: 51.2135, lng: 24.7425, dLat: 0.0014, dLng: 0.0024 },
    { id: 30, zone: "industrial",  name: "Термінал Ватутіна",        lat: 51.2242, lng: 24.7295, dLat: 0.0014, dLng: 0.0024 },
    { id: 31, zone: "industrial",  name: "Західний Логістик-Парк",   lat: 51.2115, lng: 24.6685, dLat: 0.0014, dLng: 0.0024 },
    { id: 32, zone: "industrial",  name: "Південний Елеватор",       lat: 51.1965, lng: 24.7115, dLat: 0.0014, dLng: 0.0024 },

    // --- ЖИТЛОВА ЗОНА (22 ділянки) ---
    { id: 2,  zone: "residential", name: "Володимирська 5",          lat: 51.2166, lng: 24.6908, dLat: 0.0011, dLng: 0.0019 },
    { id: 3,  zone: "residential", name: "Заріччя (берег Турії)",    lat: 51.2192, lng: 24.6965, dLat: 0.0011, dLng: 0.0019 },
    { id: 7,  zone: "residential", name: "Грушевського 1",           lat: 51.2105, lng: 24.7048, dLat: 0.0011, dLng: 0.0019 },
    { id: 8,  zone: "residential", name: "Черемушки (Центр)",        lat: 51.2087, lng: 24.7140, dLat: 0.0011, dLng: 0.0020 },
    { id: 10, zone: "residential", name: "Коновальця (Квартал)",     lat: 51.2209, lng: 24.7255, dLat: 0.0011, dLng: 0.0020 },
    { id: 14, zone: "residential", name: "Воля-Ковельська",          lat: 51.1945, lng: 24.6992, dLat: 0.0013, dLng: 0.0022 },
    { id: 15, zone: "residential", name: "Набережна Водосховища",    lat: 51.2055, lng: 24.6960, dLat: 0.0012, dLng: 0.0020 },
    { id: 33, zone: "residential", name: "вул. Стуса 17",            lat: 51.2172, lng: 24.7295, dLat: 0.0010, dLng: 0.0018 },
    { id: 34, zone: "residential", name: "вул. Стуса 37",            lat: 51.2181, lng: 24.7332, dLat: 0.0010, dLng: 0.0018 },
    { id: 35, zone: "residential", name: "вул. Стуса 60",            lat: 51.2189, lng: 24.7376, dLat: 0.0010, dLng: 0.0018 },
    { id: 36, zone: "residential", name: "вул. Миколайчука 33",      lat: 51.2209, lng: 24.7298, dLat: 0.0010, dLng: 0.0018 },
    { id: 37, zone: "residential", name: "вул. Миколайчука 75",      lat: 51.2220, lng: 24.7352, dLat: 0.0010, dLng: 0.0018 },
    { id: 38, zone: "residential", name: "вул. Відродження (Пн)",    lat: 51.2152, lng: 24.7235, dLat: 0.0011, dLng: 0.0019 },
    { id: 39, zone: "residential", name: "вул. Відродження (Пд)",    lat: 51.2122, lng: 24.7275, dLat: 0.0011, dLng: 0.0019 },
    { id: 40, zone: "residential", name: "вул. Тараса Боровця",      lat: 51.2140, lng: 24.7185, dLat: 0.0011, dLng: 0.0019 },
    { id: 41, zone: "residential", name: "вул. Грушевського 45",     lat: 51.2072, lng: 24.7175, dLat: 0.0011, dLng: 0.0019 },
    { id: 42, zone: "residential", name: "вул. Олени Пчілки",        lat: 51.2095, lng: 24.6995, dLat: 0.0011, dLng: 0.0019 },
    { id: 43, zone: "residential", name: "вул. Міцкевича",           lat: 51.2182, lng: 24.7008, dLat: 0.0010, dLng: 0.0018 },
    { id: 44, zone: "residential", name: "вул. Модеста Левицького",  lat: 51.2228, lng: 24.6995, dLat: 0.0011, dLng: 0.0019 },
    { id: 45, zone: "residential", name: "вул. Брестська (Житлова)", lat: 51.2252, lng: 24.6968, dLat: 0.0011, dLng: 0.0019 },
    { id: 46, zone: "residential", name: "вул. Ярослава Мудрого",    lat: 51.2130, lng: 24.6880, dLat: 0.0011, dLng: 0.0019 },
    { id: 47, zone: "residential", name: "Друге Ковельське (Пн)",    lat: 51.2285, lng: 24.7215, dLat: 0.0012, dLng: 0.0021 }
];

function geoDistMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * 111320;
    const dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

function getBuildingProximityBonus(plot) {
    let bonus = 0;
    MAP_BUILDINGS.forEach(b => {
        if (b.id === "bohdan") return;
        const d = geoDistMeters(plot.lat, plot.lng, b.lat, b.lng);
        if (d < 450) bonus += 35;
        else if (d < 850) bonus += 15;
        else if (d < 1300) bonus += 5;
    });
    return bonus;
}

function getDensityBonus(plot) {
    let count = 0;
    MAP_PLOTS_BASE.forEach(other => {
        if (other.id === plot.id) return;
        if (geoDistMeters(plot.lat, plot.lng, other.lat, other.lng) < 550) count++;
    });
    return Math.min(30, count * 4);
}

function getPlotNeighbors(plotId) {
    const a = MAP_PLOTS_BASE.find(p => p.id === plotId);
    if (!a) return [];
    return MAP_PLOTS_BASE.filter(b => b.id !== plotId && geoDistMeters(a.lat, a.lng, b.lat, b.lng) < 550).map(b => b.id);
}

function countOwnedNeighbors(plotId, owners) {
    return getPlotNeighbors(plotId).filter(id => owners && owners[id]).length;
}

function calcPlotPrice(plot, owners) {
    const zInfo = ZONE_INFO[plot.zone] || ZONE_INFO.residential;
    const proximity = getBuildingProximityBonus(plot);
    const density = getDensityBonus(plot);
    const neighbors = countOwnedNeighbors(plot.id, owners);
    const neighborBonus = neighbors * 10;
    const totalMultiplier = 1 + (proximity + density + neighborBonus) / 100;
    return Math.floor(zInfo.basePrice * totalMultiplier);
}

function getBuildingDef(zone, buildingId) {
    if (!buildingId) return null;
    const zInfo = ZONE_INFO[zone];
    if (!zInfo) return null;
    return zInfo.buildings.find(b => b.id === buildingId) || null;
}

// Пасивний дохід ділянки: базова ставка + бонус +25% за кожного найнятого робітника!
function getPlotPassiveIncome(plot, ownedData) {
    if (!ownedData) return 0;
    const zInfo = ZONE_INFO[plot.zone] || ZONE_INFO.residential;
    const bld = getBuildingDef(plot.zone, ownedData.building);
    const base = bld ? bld.income : Math.max(25, Math.floor(zInfo.basePrice * 0.005));
    const workersCount = ownedData.workers ? Object.keys(ownedData.workers).length : 0;
    const workerMultiplier = 1 + Math.min(2.0, workersCount * 0.25);
    return Math.floor(base * workerMultiplier);
}

function getTotalPassiveIncomePerMin() {
    if (!currentUser || !sharedPlots) return 0;
    let total = 0;
    MAP_PLOTS_BASE.forEach(p => {
        const owned = sharedPlots[p.id];
        if (owned && owned.owner === currentUser) {
            total += getPlotPassiveIncome(p, owned);
        }
    });
    return total;
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
let activeBankTab = "deposit";
let gameState = {
    coins: 0,
    jobIndex: 0,
    xp: 0,
    privateJobIndex: 0,
    privateXp: 0,
    employer: "none",
    taskProgress: 0,
    taskActive: false,
    activeCourseId: null,
    courseStartTime: 0,
    completedCourses: [],
    xpBoost: 0,
    credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
    deposit: { amount: 0, lastInterestAt: 0, totalEarned: 0 }
};
let sharedPlots = {};
let mapListener = null;
let selectedPlotId = null;
let currentZoneFilter = "all";
let leafletMap = null;
let leafletPlotLayer = null;
let leafletBldLayer = null;
let saveTimer = null, heartbeatTimer = null, courseTimerInterval = null, dataListener = null, creditTimerInterval = null, rentTimerInterval = null;
let isSaving = false, currentPage = "work";

// ===== МЕНЕДЖЕР МІНІ-ІГОР (ДЛЯ КОВЕЛЬКОРП) =====
const miniGames = new MiniGameManager(
    { window: "mg-window", icon: "mg-icon", title: "mg-title", badge: "mg-badge", body: "mg-body" },
    {
        onStep: (fraction) => {
            const job = getCurrentCorpJob();
            const xpGain = Math.max(1, job.taskClicks * fraction) * (1 + gameState.xpBoost / 100);
            gameState.xp += xpGain;
            gameState.taskProgress = Math.min(job.taskClicks, gameState.taskProgress + job.taskClicks * fraction);
            renderStats();
            renderTask();
        },
        onComplete: () => {
            const job = getCurrentCorpJob();
            gameState.coins += job.taskReward;
            gameState.taskActive = false;
            gameState.taskProgress = 0;
            renderStats();
            renderTask();
            updateWorkButtonState();
            saveGame();
            setGameStatus("Задачу в КовельКорп закрито! +" + formatNumber(job.taskReward));
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
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
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
    return `hsl(${h},65%,45%)`;
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
                    coins: 0, jobIndex: 0, xp: 0,
                    privateJobIndex: 0, privateXp: 0, employer: "none",
                    taskProgress: 0, taskActive: false,
                    activeCourseId: null, courseStartTime: 0, completedCourses: [], xpBoost: 0,
                    credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
                    deposit: { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 }
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
    startRentTimer();
    setGameStatus("Вітаємо, " + currentUser + "!");
}

function normalizeEmployerState(d) {
    const completed = Array.isArray(d.completedCourses) ? d.completedCourses : [];
    let emp = d.employer;
    if (!emp) {
        emp = completed.includes("basics") ? "corp" : "none";
    }
    if (emp === "corp" && !completed.includes("basics")) {
        emp = "none";
    }
    return emp;
}

async function loadGame() {
    try {
        const snap = await get(child(ref(db), `users/${currentUser}/clicker`));
        if (snap.exists()) {
            const d = snap.val();
            const completed = Array.isArray(d.completedCourses) ? d.completedCourses : [];
            gameState = {
                coins: Number(d.coins) || 0,
                jobIndex: Math.min(Number(d.jobIndex) || 0, JOBS.length - 1),
                xp: Number(d.xp) || 0,
                privateJobIndex: Math.min(Number(d.privateJobIndex) || 0, PRIVATE_JOBS.length - 1),
                privateXp: Number(d.privateXp) || 0,
                employer: normalizeEmployerState(d),
                taskProgress: Number(d.taskProgress) || 0,
                taskActive: Boolean(d.taskActive),
                activeCourseId: d.activeCourseId || null,
                courseStartTime: Number(d.courseStartTime) || 0,
                completedCourses: completed,
                xpBoost: Number(d.xpBoost) || 0,
                credit: d.credit || { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
                deposit: d.deposit || { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 }
            };
        }
        recalculateBoost();
    } catch (e) { showDialog("Помилка", "Не вдалося завантажити: " + e.message, "⚠️"); }
}

function startLiveSync() {
    if (dataListener) { dataListener(); dataListener = null; }
    dataListener = onValue(ref(db, `users/${currentUser}/clicker`), snap => {
        if (!snap.exists()) return;
        const d = snap.val();
        gameState.coins = Number(d.coins) || 0;
        gameState.jobIndex = Math.min(Number(d.jobIndex) || 0, JOBS.length - 1);
        gameState.xp = Number(d.xp) || 0;
        gameState.privateJobIndex = Math.min(Number(d.privateJobIndex) || 0, PRIVATE_JOBS.length - 1);
        gameState.privateXp = Number(d.privateXp) || 0;
        gameState.completedCourses = Array.isArray(d.completedCourses) ? d.completedCourses : [];
        gameState.employer = normalizeEmployerState(d);
        if (!miniGames.isRunning()) {
            gameState.taskProgress = Number(d.taskProgress) || 0;
            gameState.taskActive = Boolean(d.taskActive);
        }
        gameState.activeCourseId = d.activeCourseId || null;
        gameState.courseStartTime = Number(d.courseStartTime) || 0;
        gameState.xpBoost = Number(d.xpBoost) || 0;
        gameState.credit = d.credit || { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
        gameState.deposit = d.deposit || { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 };
        recalculateBoost();
        checkCourseCompletion();
        renderAll();
    });
}

function startMapSync() {
    if (mapListener) { mapListener(); mapListener = null; }
    mapListener = onValue(ref(db, "plots"), snap => {
        sharedPlots = snap.exists() ? snap.val() : {};
        if (gameState.employer && gameState.employer.startsWith("plot:")) {
            const pid = Number(gameState.employer.split(":")[1]);
            const pData = sharedPlots[pid];
            if (!pData || !pData.building) {
                gameState.employer = "none";
            }
        }
        renderStats();
        renderEmployerBar();
        renderPrivateJobsBoard();
        renderMap();
        if (selectedPlotId !== null) showMapInfo(selectedPlotId);
    });
}

function startRentTimer() {
    if (rentTimerInterval) clearInterval(rentTimerInterval);
    rentTimerInterval = setInterval(() => {
        if (!currentUser || isBankBlocked()) return;
        const income = getTotalPassiveIncomePerMin();
        if (income > 0) {
            gameState.coins += income;
            renderStats();
            if (currentPage === "bank") renderBank();
            saveGame();
            setGameStatus(`Нерухомість у Ковелі принесла +${formatNumberFull(income)} 💰`);
        }
    }, RENT_TICK_MS);
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
            coins: gameState.coins,
            jobIndex: gameState.jobIndex,
            xp: gameState.xp,
            privateJobIndex: gameState.privateJobIndex,
            privateXp: gameState.privateXp,
            employer: gameState.employer,
            taskProgress: gameState.taskProgress,
            taskActive: gameState.taskActive,
            activeCourseId: gameState.activeCourseId,
            courseStartTime: gameState.courseStartTime,
            completedCourses: gameState.completedCourses,
            xpBoost: gameState.xpBoost,
            credit: gameState.credit,
            deposit: gameState.deposit
        });
        const now = new Date();
        $("save-status").textContent = "💾 " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");
    } catch (e) { $("save-status").textContent = "⚠ Помилка"; }
    finally { isSaving = false; }
}

// ===== ПОСАДИ, РОБОТОДАВЦІ ТА КУРСИ =====
function getCurrentCorpJob() { return JOBS[gameState.jobIndex] || JOBS[0]; }
function getCurrentPrivateJob() { return PRIVATE_JOBS[gameState.privateJobIndex] || PRIVATE_JOBS[0]; }
function hasCourse(courseId) { return !courseId || gameState.completedCourses.includes(courseId); }
function getCourseName(courseId) {
    const c = COURSES.find(x => x.id === courseId);
    return c ? c.name : courseId;
}

function getActiveEmployerPlotId() {
    if (!gameState.employer || !gameState.employer.startsWith("plot:")) return null;
    return Number(gameState.employer.split(":")[1]);
}

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
        showDialog("Курс завершено!", (c ? c.name : "Курс") + "\n+" + (c ? c.boost : 0) + "% XP\nТепер вам відкриті нові посади в КовельКорп!", "🎓");
        saveGame();
    }
}

// ===== ПРАЦЕВЛАШТУВАННЯ В КОВЕЛЬКОРП / ПРИВАТНІ БІЗНЕСИ / ЗВІЛЬНЕННЯ =====
window.joinKovelCorp = async function () {
    if (!hasCourse("basics")) {
        return showDialog(
            "Потрібен курс!",
            "Щоб влаштуватися в IT-корпорацію «КовельКорп», необхідно спочатку пройти курс «Основи програмування» у вкладці «🛒 Курси».\n\nПоки ви можете працювати на муніципальному підробітку або влаштуватися в магазин іншого гравця!",
            "🎓"
        );
    }
    const prevPlotId = getActiveEmployerPlotId();
    if (prevPlotId !== null) {
        try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
    }
    miniGames.stop();
    gameState.employer = "corp";
    gameState.taskActive = false;
    gameState.taskProgress = 0;
    sfx.win();
    renderAll();
    saveGame();
    setGameStatus("Ви влаштувались у КовельКорп!");
};

window.hireIntoPlot = async function (plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = sharedPlots[plotId];
    if (!p || !owned || !owned.building) {
        return showDialog("Недоступно", "На цій ділянці ще немає збудованого підприємства.", "⚠️");
    }
    const prevPlotId = getActiveEmployerPlotId();
    if (prevPlotId !== null && prevPlotId !== plotId) {
        try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
    }
    miniGames.stop();
    gameState.employer = "plot:" + plotId;
    gameState.taskActive = false;
    gameState.taskProgress = 0;

    const pJob = getCurrentPrivateJob();
    try {
        await update(ref(db, `plots/${plotId}/workers/${currentUser}`), {
            role: pJob.name,
            level: gameState.privateJobIndex,
            joinedAt: Date.now(),
            lastWorkAt: Date.now()
        });
    } catch (e) {}

    sfx.good();
    renderAll();
    saveGame();
    const bld = getBuildingDef(p.zone, owned.building);
    setGameStatus(`Ви влаштувались у «${bld ? bld.name : p.name}» (${owned.owner})`);
    showDialog(
        "Нова робота!",
        `Підприємство: ${bld ? bld.icon + " " + bld.name : p.name}\nВласник: ${owned.owner}\nВаша посада: ${pJob.name} (множник ЗП ×${pJob.mult})\n\nТут немає міні-ігор — тисніть «ПРАЦЮВАТИ» на вкладці Робота й отримуйте зарплату за кожен клік!`,
        "🏪"
    );
};

window.resignCurrentJob = async function () {
    if (gameState.employer === "none") return;
    const prevPlotId = getActiveEmployerPlotId();
    if (prevPlotId !== null) {
        try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
    }
    miniGames.stop();
    gameState.employer = "none";
    gameState.taskActive = false;
    gameState.taskProgress = 0;
    sfx.click();
    renderAll();
    saveGame();
    setGameStatus("Ви звільнились за власним бажанням.");
    showDialog("Звільнення оформлено", "Ви звільнились із попереднього місця роботи.\nТепер ви можете влаштуватися в магазин іншого гравця або повернутися в КовельКорп.", "🚪");
};

// ===== КЛІК-РОБОТА НА ПРИВАТНОМУ ПІДПРИЄМСТВІ ІНШОГО ГРАВЦЯ =====
async function doPrivateClickWork(plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = sharedPlots[plotId];
    if (!p || !owned || !owned.building) {
        gameState.employer = "none";
        renderAll();
        return;
    }
    const bld = getBuildingDef(p.zone, owned.building);
    const pJob = getCurrentPrivateJob();
    const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 10);
    const desiredPay = Math.max(1, Math.floor(baseWage * pJob.mult));
    const ownerProfitPerClick = Math.max(2, Math.floor((bld ? bld.clickProfit : 15) * (1 + gameState.privateJobIndex * 0.15)));

    let paid = 0;
    let isSelfOwner = owned.owner === currentUser;

    try {
        await runTransaction(ref(db, `plots/${plotId}`), (cur) => {
            if (!cur) return cur;
            const treasury = Number(cur.treasury) || 0;
            if (!isSelfOwner && treasury >= desiredPay) {
                cur.treasury = treasury - desiredPay + ownerProfitPerClick;
                paid = desiredPay;
            } else if (isSelfOwner) {
                cur.treasury = treasury + Math.floor(ownerProfitPerClick * 0.6);
                paid = Math.max(1, Math.floor(ownerProfitPerClick * 0.4));
            } else {
                cur.treasury = treasury + Math.floor(ownerProfitPerClick * 0.5);
                paid = Math.max(1, Math.floor(baseWage * 0.3));
            }
            if (!cur.workers) cur.workers = {};
            const prevClicks = Number(cur.workers[currentUser]?.clicks) || 0;
            cur.workers[currentUser] = {
                role: pJob.name,
                level: gameState.privateJobIndex,
                clicks: prevClicks + 1,
                lastWorkAt: Date.now()
            };
            return cur;
        });
    } catch (e) {
        paid = Math.max(1, Math.floor(baseWage * 0.5));
    }

    sfx.click();
    gameState.coins += paid;
    const xpGain = 1 * (1 + gameState.xpBoost / 100);
    gameState.privateXp += xpGain;
    gameState.taskProgress = (gameState.taskProgress + 1) % 20;
    renderStats();
    renderTask();
    renderEmployerBar();
    setGameStatus(`Зміна у «${bld ? bld.name : p.name}»: +${formatNumberFull(paid)} 💰 (+${xpGain.toFixed(1)} Приватного XP)`);
}

// ===== МУНІЦИПАЛЬНИЙ ПІДРОБІТОК (ДЛЯ НОВАЧКІВ БЕЗ РОБОТИ) =====
function doMunicipalClickWork() {
    sfx.click();
    const pay = 3;
    gameState.coins += pay;
    gameState.privateXp += 1 * (1 + gameState.xpBoost / 100);
    gameState.taskProgress = (gameState.taskProgress + 1) % 10;
    renderStats();
    renderTask();
    setGameStatus(`Муніципальний підробіток: +${pay} 💰 (влаштуйтесь у бізнес гравця або вивчіть «Основи програмування» для КовельКорп!)`);
}

// ===== КЕРУВАННЯ КАСОЮ ТА ЗАРПЛАТОЮ ВЛАСНИКОМ ДІЛЯНКИ =====
window.savePlotWage = async function () {
    if (selectedPlotId === null) return;
    const owned = sharedPlots[selectedPlotId];
    if (!owned || owned.owner !== currentUser) return;
    const val = Math.max(1, Math.min(50000, Math.floor(Number($("owner-wage-input")?.value) || 0)));
    try {
        await update(ref(db, `plots/${selectedPlotId}`), { wage: val });
        sfx.good();
        setGameStatus(`Встановлено нову ставку зарплати: ${formatNumberFull(val)} 💰/клік`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.fundPlotTreasury = async function () {
    if (selectedPlotId === null) return;
    const owned = sharedPlots[selectedPlotId];
    if (!owned || owned.owner !== currentUser) return;
    const val = Math.floor(Number($("owner-fund-input")?.value) || 0);
    if (val <= 0) return showDialog("Введіть суму", "Вкажіть суму монет для поповнення зарплатної каси.", "⚠️");
    if (gameState.coins < val) return showDialog("Недостатньо монет", `У гаманці лише ${formatNumberFull(gameState.coins)} 💰`, "💸");
    try {
        await runTransaction(ref(db, `plots/${selectedPlotId}/treasury`), (cur) => (Number(cur) || 0) + val);
        gameState.coins -= val;
        $("owner-fund-input").value = "";
        sfx.good();
        renderAll(); saveGame();
        setGameStatus(`Касу підприємства поповнено на +${formatNumberFull(val)} 💰`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.withdrawPlotTreasury = async function () {
    if (selectedPlotId === null) return;
    const owned = sharedPlots[selectedPlotId];
    if (!owned || owned.owner !== currentUser) return;
    const curTreasury = Number(owned.treasury) || 0;
    if (curTreasury <= 0) return showDialog("Каса порожня", "У касі підприємства зараз немає монет.", "ℹ️");
    const inputVal = Math.floor(Number($("owner-fund-input")?.value) || 0);
    const takeAmt = inputVal > 0 ? Math.min(curTreasury, inputVal) : curTreasury;
    try {
        await runTransaction(ref(db, `plots/${selectedPlotId}/treasury`), (cur) => Math.max(0, (Number(cur) || 0) - takeAmt));
        gameState.coins += takeAmt;
        $("owner-fund-input").value = "";
        sfx.win();
        renderAll(); saveGame();
        setGameStatus(`Знято з каси підприємства: +${formatNumberFull(takeAmt)} 💰`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

// ===== БАНК WIN95: ДЕПОЗИТИ ТА КРЕДИТИ =====
window.switchBankTab = function (tab) {
    activeBankTab = tab;
    $("btab-deposit").classList.toggle("active", tab === "deposit");
    $("btab-credit").classList.toggle("active", tab === "credit");
    $("bank-panel-deposit").style.display = tab === "deposit" ? "flex" : "none";
    $("bank-panel-credit").style.display = tab === "credit" ? "flex" : "none";
    renderBank();
};

window.setDepositQuickAmount = function (fraction) {
    const amt = Math.floor(gameState.coins * fraction);
    $("dep-amount-input").value = amt > 0 ? amt : "";
};

window.depositMoney = function () {
    const val = Math.floor(Number($("dep-amount-input").value) || 0);
    if (val <= 0) return showDialog("Помилка", "Введіть суму для поповнення депозиту.", "⚠️");
    if (gameState.coins < val) return showDialog("Недостатньо монет", "У гаманці лише " + formatNumberFull(gameState.coins) + " 💰", "💸");

    if (!gameState.deposit) gameState.deposit = { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 };
    if (gameState.deposit.amount === 0) gameState.deposit.lastInterestAt = Date.now();
    gameState.coins -= val;
    gameState.deposit.amount += val;
    $("dep-amount-input").value = "";
    sfx.good();
    renderAll(); saveGame();
    setGameStatus(`Покладено на депозит: +${formatNumberFull(val)} 💰`);
};

window.withdrawDeposit = function (all = false) {
    if (!gameState.deposit || gameState.deposit.amount <= 0) {
        return showDialog("Депозит порожній", "На вашому депозитному рахунку немає коштів.", "ℹ️");
    }
    const val = all ? gameState.deposit.amount : Math.floor(Number($("dep-amount-input").value) || 0);
    if (val <= 0) return showDialog("Помилка", "Введіть суму для зняття або натисніть «Зняти весь депозит».", "⚠️");
    if (val > gameState.deposit.amount) return showDialog("Недостатньо на депозиті", "Доступно на депозиті: " + formatNumberFull(gameState.deposit.amount) + " 💰", "⚠️");

    gameState.deposit.amount -= val;
    gameState.coins += val;
    $("dep-amount-input").value = "";
    sfx.win();
    renderAll(); saveGame();
    setGameStatus(`Знято з депозиту: +${formatNumberFull(val)} 💰`);
};

function checkDepositInterest() {
    const dep = gameState.deposit;
    if (!dep || dep.amount <= 0) return;
    const now = Date.now();
    if (!dep.lastInterestAt) { dep.lastInterestAt = now; return; }
    const elapsed = now - dep.lastInterestAt;
    if (elapsed >= 60000) {
        const mins = Math.min(60, Math.floor(elapsed / 60000));
        let earnedTotal = 0;
        for (let i = 0; i < mins; i++) {
            const gain = Math.max(1, Math.floor(dep.amount * DEPOSIT_RATE_PER_MIN));
            dep.amount += gain;
            earnedTotal += gain;
        }
        dep.totalEarned = (Number(dep.totalEarned) || 0) + earnedTotal;
        dep.lastInterestAt += mins * 60000;
        renderStats();
        if (currentPage === "bank") renderBank();
        saveGame();
        setGameStatus(`Депозит КовельБанку: +${formatNumberFull(earnedTotal)} 💰 відсотків`);
    }
}

function isBankBlocked() {
    return gameState.credit && gameState.credit.amount > 0 && gameState.credit.overdue;
}

function getCreditLimit() {
    const jobLimit = gameState.employer === "corp"
        ? (getCurrentCorpJob().creditLimit || 15000)
        : (getCurrentPrivateJob().creditLimit || 12000);
    const depAmt = gameState.deposit?.amount || 0;
    const balanceLimit = Math.floor((gameState.coins + depAmt) * 0.8);
    return Math.max(jobLimit, balanceLimit);
}

window.setCreditQuickAmount = function (fraction) {
    const limit = getCreditLimit();
    $("credit-amount-input").value = Math.max(100, Math.floor(limit * fraction));
};

window.setRepayQuickAmount = function (fraction) {
    const debt = gameState.credit?.amount || 0;
    const target = Math.ceil(debt * fraction);
    $("repay-amount-input").value = Math.min(gameState.coins, target);
};

window.takeCredit = async function () {
    if (gameState.credit.amount > 0) return showDialog("Кредит уже є", "Спочатку погасіть поточний борг.", "⚠️");
    const limit = getCreditLimit();
    if (limit <= 0) return showDialog("Ліміт 0", "Заробіть більше або підвищіть посаду.", "💸");

    const rawInput = Number($("credit-amount-input")?.value) || limit;
    const requested = Math.min(limit, Math.max(100, Math.floor(rawInput)));
    const totalDebt = requested + Math.max(5, Math.floor(requested * 0.05));
    const now = Date.now();

    gameState.credit = { amount: totalDebt, takenAt: now, dueAt: now + 30 * 60 * 1000, overdue: false, lastPenaltyAt: 0 };
    gameState.coins += requested;
    if ($("credit-amount-input")) $("credit-amount-input").value = "";
    sfx.win();
    renderAll(); saveGame();
    setGameStatus("Кредит отримано: +" + formatNumberFull(requested) + " 💰");
    showDialog("Кредит оформлено!", `Отримано в гаманець: +${formatNumberFull(requested)} 💰\nДо повернення (+5%): ${formatNumberFull(totalDebt)} 💰\nТермін: 30 хвилин`, "🏦");
};

window.repayCredit = async function (payAll = true) {
    const debt = gameState.credit.amount;
    if (debt <= 0) return;

    const inputVal = Math.floor(Number($("repay-amount-input")?.value) || 0);
    const payAmount = payAll ? debt : Math.min(debt, inputVal);

    if (payAmount <= 0) return showDialog("Введіть суму", "Вкажіть суму для часткового погашення або натисніть «Погасити повністю».", "⚠️");
    if (gameState.coins < payAmount) return showDialog("Недостатньо монет у гаманці", `Потрібно ${formatNumberFull(payAmount)} 💰.\nЯкщо гроші на депозиті — спочатку зніміть їх у вкладці «Депозитний сейф».`, "💸");

    gameState.coins -= payAmount;
    gameState.credit.amount -= payAmount;
    if ($("repay-amount-input")) $("repay-amount-input").value = "";

    if (gameState.credit.amount <= 0) {
        gameState.credit = { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
        sfx.win();
        renderAll(); saveGame();
        setGameStatus("Кредит повністю погашено!");
        showDialog("Кредит погашено!", "Борг перед КовельБанком повністю закрито.", "✅");
    } else {
        sfx.good();
        renderAll(); saveGame();
        setGameStatus(`Сплачено ${formatNumberFull(payAmount)} 💰. Залишок боргу: ${formatNumberFull(gameState.credit.amount)} 💰`);
    }
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
        checkDepositInterest();
        if (currentPage === "bank") renderBank();
    }, 1000);
}

// ===== РЕНДЕР =====
function renderAll() {
    renderStats();
    renderEmployerBar();
    renderTask();
    renderPrivateJobsBoard();
    renderJobsList();
    renderShop();
    renderMap();
    renderBank();
    updateWorkButtonState();
}

function renderEmployerBar() {
    const nameEl = $("emp-current-name");
    const subEl = $("emp-current-sub");
    const joinCorpBtn = $("btn-join-corp");
    const resignBtn = $("btn-resign");
    if (!nameEl) return;

    if (gameState.employer === "corp") {
        const job = getCurrentCorpJob();
        nameEl.textContent = `🏢 КовельКорп — ${job.name}`;
        subEl.textContent = `Режим: ІТ Міні-ігри • Нагорода: +${formatNumberFull(job.taskReward)} 💰 за задачу`;
        joinCorpBtn.style.display = "none";
        resignBtn.style.display = "inline-block";
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        const p = MAP_PLOTS_BASE.find(x => x.id === pid);
        const owned = sharedPlots[pid];
        const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
        const pJob = getCurrentPrivateJob();
        const baseWage = Number(owned?.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 10);
        const myWage = Math.max(1, Math.floor(baseWage * pJob.mult));
        nameEl.textContent = `${bld ? bld.icon + " " + bld.name : (p ? p.name : "Бізнеc")} — ${pJob.name}`;
        subEl.textContent = `Власник: ${owned?.owner || "—"} • Кліки за ЗП: +${formatNumberFull(myWage)} 💰/клік (каса: ${formatNumber(owned?.treasury || 0)} 💰)`;
        joinCorpBtn.style.display = "inline-block";
        resignBtn.style.display = "inline-block";
    } else {
        const pJob = getCurrentPrivateJob();
        nameEl.textContent = `🧹 Вільний працівник (${pJob.name})`;
        subEl.textContent = hasCourse("basics")
            ? "Доступний вступ у КовельКорп або робота в бізнесах гравців!"
            : "Для КовельКорп пройдіть курс «Основи програмування» або влаштуйтесь у магазин гравця!";
        joinCorpBtn.style.display = "inline-block";
        resignBtn.style.display = "none";
    }
}

function renderPrivateJobsBoard() {
    const listEl = $("private-jobs-list");
    if (!listEl) return;
    const activePid = getActiveEmployerPlotId();

    const businesses = [];
    MAP_PLOTS_BASE.forEach(p => {
        const owned = sharedPlots[p.id];
        if (owned && owned.building) {
            const bld = getBuildingDef(p.zone, owned.building);
            if (bld) {
                const wage = Number(owned.wage) > 0 ? Number(owned.wage) : bld.defaultWage;
                const workersCount = owned.workers ? Object.keys(owned.workers).length : 0;
                businesses.push({ plot: p, owned, bld, wage, workersCount });
            }
        }
    });

    if (!businesses.length) {
        listEl.innerHTML = `<div class="muted" style="padding:10px;text-align:center">Поки жоден гравець не побудував магазин чи підприємство на мапі Ковеля. Станьте першим або купіть курс «Основи програмування» для роботи в КовельКорп!</div>`;
        return;
    }

    businesses.sort((a, b) => b.wage - a.wage);
    const pJob = getCurrentPrivateJob();

    let html = "";
    businesses.forEach(({ plot, owned, bld, wage, workersCount }) => {
        const isCurrent = activePid === plot.id;
        const myPay = Math.max(1, Math.floor(wage * pJob.mult));
        const treasury = Number(owned.treasury) || 0;
        const workerNames = owned.workers ? Object.keys(owned.workers).slice(0, 3).join(", ") : "немає";
        html += `<div class="pjob-card${isCurrent ? " active-emp" : ""}">
            <div class="pjob-info">
                <div class="pjob-title">${bld.icon} ${escapeHtml(bld.name)} — ${escapeHtml(plot.name)}</div>
                <div class="pjob-meta">Власник: <b>${escapeHtml(owned.owner)}</b> • Штат: ${workersCount} роб. (${escapeHtml(workerNames)}) • Каса: ${formatNumber(treasury)} 💰</div>
                <div class="pjob-wage">Ваша ЗП (${escapeHtml(pJob.name)}): +${formatNumberFull(myPay)} 💰 за клік</div>
            </div>
            <div>
                ${isCurrent
                    ? `<button class="btn" onclick="resignCurrentJob()" style="min-height:30px;min-width:74px;padding:4px 8px;font-size:11px;color:#800000">Звільнитись</button>`
                    : `<button class="btn default" onclick="hireIntoPlot(${plot.id})" style="min-height:30px;min-width:80px;padding:4px 8px;font-size:11px">Влаштуватись</button>`
                }
            </div>
        </div>`;
    });
    listEl.innerHTML = html;
}

function renderStats() {
    $("stat-coins").textContent = formatNumber(gameState.coins);
    $("stat-boost").textContent = gameState.xpBoost + "%";
    const inc = getTotalPassiveIncomePerMin();
    const incEl = $("stat-income");
    if (incEl) incEl.textContent = "+" + formatNumber(inc);
    $("big-coins").textContent = formatNumberFull(gameState.coins);

    const promoteBtn = $("promote-btn");
    const careerBox = $("career-group-box");

    if (gameState.employer === "corp") {
        const job = getCurrentCorpJob();
        const nextJob = JOBS[gameState.jobIndex + 1] || null;
        $("stat-job").textContent = job.name;
        $("stat-xp").textContent = formatNumber(gameState.xp);
        if (careerBox) careerBox.setAttribute("data-label", "Кар'єра в КовельКорп (IT досвід)");

        const needed = job.xpNeeded || 1;
        const pct = job.xpNeeded === 0 ? 100 : Math.min(100, (gameState.xp / needed) * 100);
        $("xp-bar").style.width = pct + "%";
        $("xp-text").textContent = job.xpNeeded === 0 ? "Макс. рівень (CTO)" : `${formatNumber(gameState.xp)} / ${formatNumber(needed)} IT-XP`;

        const canPromoteXp = job.xpNeeded > 0 && gameState.xp >= job.xpNeeded;
        if (canPromoteXp && nextJob) {
            const reqOk = hasCourse(nextJob.reqCourse);
            promoteBtn.classList.add("show");
            promoteBtn.textContent = reqOk
                ? `⬆ Підвищитись до «${nextJob.name}»`
                : `🔒 Потрібен курс «${getCourseName(nextJob.reqCourse)}»`;
        } else {
            promoteBtn.classList.remove("show");
        }
    } else {
        const pJob = getCurrentPrivateJob();
        const nextPJob = PRIVATE_JOBS[gameState.privateJobIndex + 1] || null;
        $("stat-job").textContent = pJob.name;
        $("stat-xp").textContent = formatNumber(gameState.privateXp);
        if (careerBox) careerBox.setAttribute("data-label", "Приватна кар'єра (Робота на людей / Торгівля)");

        const needed = pJob.xpNeeded || 1;
        const pct = pJob.xpNeeded === 0 ? 100 : Math.min(100, (gameState.privateXp / needed) * 100);
        $("xp-bar").style.width = pct + "%";
        $("xp-text").textContent = pJob.xpNeeded === 0 ? "Макс. рівень" : `${formatNumber(gameState.privateXp)} / ${formatNumber(needed)} Торг-XP`;

        if (pJob.xpNeeded > 0 && gameState.privateXp >= pJob.xpNeeded && nextPJob) {
            promoteBtn.classList.add("show");
            promoteBtn.textContent = `⬆ Підвищитись до «${nextPJob.name}» (×${nextPJob.mult})`;
        } else {
            promoteBtn.classList.remove("show");
        }
    }
}

function renderTask() {
    if (gameState.employer === "corp") {
        const job = getCurrentCorpJob();
        const needed = job.taskClicks;
        const prog = gameState.taskActive ? Math.floor(gameState.taskProgress) : 0;
        $("task-bar").style.width = (needed > 0 ? Math.min(100, (gameState.taskProgress / needed) * 100) : 0) + "%";
        $("task-text").textContent = prog + " / " + needed;
        $("task-reward").textContent = "Нагорода за задачу: " + formatNumberFull(job.taskReward) + " 💰";
        $("task-title").textContent = gameState.taskActive ? "Активна ІТ-задача (" + job.name + ")" : "КовельКорп: Задача не почата";
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        const p = MAP_PLOTS_BASE.find(x => x.id === pid);
        const owned = sharedPlots[pid];
        const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
        const pJob = getCurrentPrivateJob();
        const baseWage = Number(owned?.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 10);
        const myPay = Math.max(1, Math.floor(baseWage * pJob.mult));
        const step = Math.floor(gameState.taskProgress) % 20;
        $("task-bar").style.width = ((step / 20) * 100) + "%";
        $("task-text").textContent = `${step} / 20 кліків зміни`;
        $("task-reward").textContent = `Оплата миттєво: +${formatNumberFull(myPay)} 💰 за кожен клік (×${pJob.mult})`;
        $("task-title").textContent = `Робота: ${bld ? bld.name : "Підприємство"} (${owned?.owner || "—"})`;
    } else {
        const step = Math.floor(gameState.taskProgress) % 10;
        $("task-bar").style.width = ((step / 10) * 100) + "%";
        $("task-text").textContent = `${step} / 10 кліків`;
        $("task-reward").textContent = "Підробіток: +3 💰 за клік (влаштуйтесь у бізнес гравця або КовельКорп!)";
        $("task-title").textContent = "Тимчасовий муніципальний підробіток";
    }
}

function updateWorkButtonState() {
    const btn = $("big-click"), label = $("big-click-label"), emoji = $("big-click-emoji"), blocker = $("course-blocker");
    if (isBankBlocked()) {
        miniGames.stop();
        btn.style.display = "flex";
        btn.disabled = true;
        if (emoji) emoji.textContent = "🚫";
        label.textContent = "БОРГ У БАНКУ";
        blocker.classList.remove("show"); return;
    }
    if (isCourseRunning()) {
        miniGames.stop();
        btn.style.display = "flex";
        btn.disabled = true;
        if (emoji) emoji.textContent = "📚";
        label.textContent = "КУРС У ПРОЦЕСІ";
        blocker.classList.add("show");
        $("course-blocker-timer").textContent = "Залишилось: " + formatDuration(getRemainingCourseMs());
    } else {
        blocker.classList.remove("show");
        if (gameState.employer === "corp") {
            if (miniGames.isRunning()) {
                btn.style.display = "none";
            } else {
                btn.style.display = "flex";
                btn.disabled = false;
                if (emoji) emoji.textContent = "💻";
                label.textContent = gameState.taskActive ? "ПРОДОВЖИТИ ІТ-ЗАДАЧУ" : "ПОЧАТИ ІТ-ЗАДАЧУ (МІНІ-ГРА)";
            }
        } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
            miniGames.stop();
            btn.style.display = "flex";
            btn.disabled = false;
            if (emoji) emoji.textContent = "🛒";
            label.textContent = "ОБСЛУГОВУВАТИ КЛІЄНТІВ (КЛІК = ЗП)";
        } else {
            miniGames.stop();
            btn.style.display = "flex";
            btn.disabled = false;
            if (emoji) emoji.textContent = "🧹";
            label.textContent = "ПІДРОБЛЯТИ В МІСТІ (+3 💰 / КЛІК)";
        }
    }
}

function renderJobsList() {
    let html = "";
    if (gameState.employer === "corp") {
        JOBS.forEach((job, i) => {
            const isCurrent = i === gameState.jobIndex, isLocked = i > gameState.jobIndex;
            const status = isCurrent ? "← зараз" : (isLocked ? "🔒" : "✓");
            const courseOk = hasCourse(job.reqCourse);
            const courseTitle = getCourseName(job.reqCourse);
            html += `<div class="job-row${isCurrent ? " current" : ""}${isLocked ? " locked" : ""}">
                <span class="job-name">${i + 1}. ${job.name}</span>
                <span class="job-req${courseOk ? " ok" : ""}">${courseOk ? "🎓 " : "🔒 "}${escapeHtml(courseTitle)}</span>
                <span class="job-pay">+${formatNumber(job.taskReward)}</span>
                <span class="job-status">${status}</span></div>`;
        });
    } else {
        PRIVATE_JOBS.forEach((pj, i) => {
            const isCurrent = i === gameState.privateJobIndex, isLocked = i > gameState.privateJobIndex;
            const status = isCurrent ? "← зараз" : (isLocked ? "🔒" : "✓");
            html += `<div class="job-row${isCurrent ? " current" : ""}${isLocked ? " locked" : ""}">
                <span class="job-name">${i + 1}. ${pj.name}</span>
                <span class="job-pay">ЗП ×${pj.mult}</span>
                <span class="job-status">${status}</span></div>`;
        });
    }
    $("jobs-list").innerHTML = html;
}

function renderShop() {
    let html = "";
    COURSES.forEach(c => {
        const done = gameState.completedCourses.includes(c.id);
        const active = gameState.activeCourseId === c.id;
        const can = !done && !active && !gameState.activeCourseId && gameState.coins >= c.price;
        let status = done ? `<span style="color:#008000;font-weight:bold">✓ Пройдено (+${c.boost}% XP)</span>` :
            active ? `<span class="course-timer">Залишилось: ${formatDuration(getRemainingCourseMs())}</span>` :
                `<button class="btn" ${can ? "" : "disabled"} onclick="buyCourse('${c.id}')">Купити (${formatNumber(c.price)})</button>`;
        html += `<div class="shop-item${done ? " completed" : ""}${active ? " active-course" : ""}">
            <div class="shop-item-header"><span class="shop-item-name">🎓 ${c.name}</span><span class="shop-item-boost">+${c.boost}% XP</span></div>
            <div class="shop-item-info">Тривалість: ${Math.round(c.durationMs / 3600000)} год • <b>${escapeHtml(c.desc || "")}</b></div>
            <div class="shop-item-actions">${status}</div></div>`;
    });
    $("shop-list").innerHTML = html;
}

// ===== РЕАЛЬНА МАПА КОВЕЛЯ (ЧІТКІ КОЛЬОРИ ЗОН + ОКРЕМИЙ ПРІОРИТЕТНИЙ ШАР БУДІВЕЛЬ) =====
function initKovelMap() {
    if (leafletMap || typeof L === "undefined") return;
    const container = $("kovel-leaflet-map");
    if (!container) return;

    leafletMap = L.map(container, {
        center: KOVEL_CENTER,
        zoom: 13,
        minZoom: 13,
        maxZoom: 17,
        maxBounds: KOVEL_BOUNDS,
        maxBoundsViscosity: 1.0,
        attributionControl: false
    });

    const bldPane = leafletMap.createPane("kovelBuildingsPane");
    bldPane.style.zIndex = 680;

    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 18
    }).addTo(leafletMap);

    leafletPlotLayer = L.layerGroup().addTo(leafletMap);
    leafletBldLayer = L.layerGroup().addTo(leafletMap);
}

window.centerKovelMap = function () {
    if (leafletMap) leafletMap.setView(KOVEL_CENTER, 13);
};

window.focusBohdanHouse = function () {
    const b = MAP_BUILDINGS.find(x => x.id === "bohdan");
    if (leafletMap && b) {
        leafletMap.setView([b.lat, b.lng], 16);
    }
    openBohdanModal();
};

window.setZoneFilter = function (zone) {
    currentZoneFilter = zone;
    ["all", "residential", "commercial", "industrial"].forEach(z => {
        const el = $("zfilter-" + z);
        if (el) el.classList.toggle("active", z === zone);
    });
    renderMap();
};

function renderMap() {
    if (!leafletMap) initKovelMap();
    if (!leafletMap || !leafletPlotLayer || !leafletBldLayer) return;

    leafletPlotLayer.clearLayers();
    leafletBldLayer.clearLayers();

    MAP_PLOTS_BASE.forEach(p => {
        if (currentZoneFilter !== "all" && p.zone !== currentZoneFilter) return;

        const zInfo = ZONE_INFO[p.zone] || ZONE_INFO.residential;
        const owned = sharedPlots[p.id];
        const price = calcPlotPrice(p, sharedPlots);
        const canAfford = gameState.coins >= price && !owned;
        const isSelected = selectedPlotId === p.id;

        let fillColor = zInfo.fillFree;
        let borderColor = zInfo.borderFree;
        let labelCls = "win95-map-label zone-" + p.zone;
        let labelStyle = "";

        const bld = owned ? getBuildingDef(p.zone, owned.building) : null;

        if (owned) {
            if (owned.owner === currentUser) {
                fillColor = "#55ff55";
                borderColor = "#0b4d0b";
                labelCls = "win95-map-label owned-self";
            } else {
                const c = colorFromName(owned.owner);
                fillColor = c;
                borderColor = "#1a1a1a";
                labelCls = "win95-map-label owned-other";
                labelStyle = `background:${c};`;
            }
        }
        if (isSelected) {
            borderColor = "#ffff00";
            labelCls += " selected";
        }

        const bounds = [
            [p.lat - p.dLat / 2, p.lng - p.dLng / 2],
            [p.lat + p.dLat / 2, p.lng + p.dLng / 2]
        ];

        const rect = L.rectangle(bounds, {
            color: borderColor,
            weight: isSelected ? 3 : 2,
            dashArray: (!owned && !canAfford) ? "4,3" : null,
            fillColor: fillColor,
            fillOpacity: owned ? 0.76 : (canAfford ? 0.65 : 0.48)
        }).addTo(leafletPlotLayer);

        rect.on("click", () => selectPlot(p.id));

        const zoneBadge = p.zone === "industrial" ? "🏭" : (p.zone === "commercial" ? "🏪" : "🏡");
        const workersCount = owned?.workers ? Object.keys(owned.workers).length : 0;
        const workerTag = workersCount > 0 ? ` 👷${workersCount}` : "";
        const bldIcon = bld ? bld.icon + " " : zoneBadge + " ";

        const badgeHtml = owned
            ? `<div class="${labelCls}" style="${labelStyle}">${bldIcon}${escapeHtml(owned.owner)}${workerTag}</div>`
            : `<div class="${labelCls}">${zoneBadge} ${formatNumber(price)}</div>`;

        const labelMarker = L.marker([p.lat, p.lng], {
            icon: L.divIcon({
                className: "",
                html: badgeHtml,
                iconSize: [0, 0]
            })
        }).addTo(leafletPlotLayer);
        labelMarker.on("click", () => selectPlot(p.id));
    });

    MAP_BUILDINGS.forEach(b => {
        const marker = L.marker([b.lat, b.lng], {
            pane: "kovelBuildingsPane",
            zIndexOffset: 1000,
            icon: L.divIcon({
                className: "",
                html: `<div class="win95-bld-marker ${b.cls}">${b.icon} ${b.name}</div>`,
                iconSize: [0, 0]
            })
        }).addTo(leafletBldLayer);
        marker.on("click", () => clickBuilding(b.id));
    });
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
    const zInfo = ZONE_INFO[p.zone] || ZONE_INFO.residential;
    const owned = sharedPlots[plotId];
    const price = calcPlotPrice(p, sharedPlots);
    const proximity = getBuildingProximityBonus(p);
    const density = getDensityBonus(p);
    const neighbors = countOwnedNeighbors(plotId, sharedPlots);

    const tagEl = $("info-zone-tag");
    tagEl.className = "zone-tag " + p.zone;
    tagEl.textContent = zInfo.name;

    const bonusText = [];
    if (proximity > 0) bonusText.push(`будівлі +${proximity}%`);
    if (density > 0) bonusText.push(`густота +${density}%`);
    if (neighbors > 0) bonusText.push(`сусіди +${neighbors * 10}%`);

    const bld = owned ? getBuildingDef(p.zone, owned.building) : null;
    const baseRent = Math.max(25, Math.floor(zInfo.basePrice * 0.005));
    const currentIncome = owned ? getPlotPassiveIncome(p, owned) : 0;

    $("info-name").textContent = `#${p.id + 1} ${p.name}`;
    $("info-owner").textContent = owned ? owned.owner : "Вільна (Міська рада)";
    $("info-price").textContent = owned ? `Куплено (${formatNumberFull(owned.price || price)})` : formatNumberFull(price) + " 💰";
    $("info-building").textContent = bld ? `${bld.icon} ${bld.name}` : (owned ? "Не забудовано" : "—");
    $("info-income").textContent = owned ? `+${formatNumberFull(currentIncome)} 💰/хв` : `від +${baseRent} до +${formatNumberFull(zInfo.buildings[zInfo.buildings.length - 1].income)} 💰/хв`;
    $("info-bonus").textContent = bonusText.length ? bonusText.join(", ") : "базова ставка";

    const buyWrap = $("info-buy-wrap");
    const buyBtn = $("info-buy-btn");
    const buildSec = $("info-build-section");
    const buildGrid = $("info-build-options");
    const workersSec = $("info-workers-section");

    if (owned && bld) {
        workersSec.style.display = "flex";
        const wage = Number(owned.wage) > 0 ? Number(owned.wage) : bld.defaultWage;
        const treasury = Number(owned.treasury) || 0;
        const workersMap = owned.workers || {};
        const workersArr = Object.entries(workersMap);
        const boostPct = Math.min(200, workersArr.length * 25);

        $("info-biz-funds").textContent = formatNumberFull(treasury) + " 💰";
        $("info-biz-wage").textContent = formatNumberFull(wage) + " 💰/клік";
        $("info-biz-boost").textContent = `+${boostPct}% (${workersArr.length} роб.)`;

        const wListEl = $("info-workers-list");
        if (!workersArr.length) {
            wListEl.innerHTML = `<div class="muted" style="text-align:center;padding:4px">Наразі робітників немає (підприємство працює в базовому авто-режимі)</div>`;
        } else {
            wListEl.innerHTML = workersArr.map(([wName, wData]) => `
                <div class="worker-row">
                    <span class="w-name">👷 ${escapeHtml(wName)}</span>
                    <span class="w-role">${escapeHtml(wData?.role || "Працівник")}</span>
                    <span class="w-clicks">${formatNumberFull(wData?.clicks || 0)} кліків</span>
                </div>
            `).join("");
        }

        const hireActions = $("info-hire-actions");
        const isEmployedHere = getActiveEmployerPlotId() === plotId;
        const pJob = getCurrentPrivateJob();
        const myClickWage = Math.max(1, Math.floor(wage * pJob.mult));
        if (isEmployedHere) {
            hireActions.innerHTML = `
                <button class="btn default" onclick="switchPage('work')" style="min-height:32px;padding:4px 10px;font-size:12px">🛒 Перейти до роботи (+${formatNumberFull(myClickWage)} 💰/клік)</button>
                <button class="btn" onclick="resignCurrentJob()" style="min-height:32px;padding:4px 10px;font-size:12px;color:#800000">🚪 Звільнитись</button>
            `;
        } else {
            hireActions.innerHTML = `
                <button class="btn default" onclick="hireIntoPlot(${plotId})" style="min-height:32px;padding:4px 12px;font-size:12px">✍️ Влаштуватись сюди (${escapeHtml(pJob.name)}: +${formatNumberFull(myClickWage)} 💰/клік)</button>
            `;
        }

        const ownerCtrl = $("info-owner-Controls");
        if (owned.owner === currentUser) {
            ownerCtrl.style.display = "flex";
            const wageInp = $("owner-wage-input");
            if (wageInp && document.activeElement !== wageInp) wageInp.value = wage;
        } else {
            ownerCtrl.style.display = "none";
        }
    } else {
        workersSec.style.display = "none";
    }

    if (owned && owned.owner === currentUser) {
        buyWrap.style.display = "none";
        buildSec.style.display = "flex";
        let bHtml = "";
        zInfo.buildings.forEach((b, idx) => {
            const curIdx = zInfo.buildings.findIndex(x => x.id === owned.building);
            const isCurrent = owned.building === b.id;
            const isLower = curIdx >= idx;
            const canBuild = !isLower && gameState.coins >= b.cost;
            const btnLabel = isCurrent ? "✓ Збудовано" : (isLower ? "✓ Пройдено" : `Збудувати (${formatNumber(b.cost)})`);
            bHtml += `<div class="build-card${isCurrent ? " current-bld" : ""}">
                <div class="build-card-info">
                    <span class="build-card-name">${b.icon} ${b.name}</span>
                    <span class="build-card-sub">Ціна: ${formatNumberFull(b.cost)} 💰 • Дохід: +${formatNumberFull(b.income)}/хв • Реком. ЗП: ${b.defaultWage} 💰</span>
                </div>
                <button class="btn" ${canBuild ? "" : "disabled"} onclick="buildOnSelectedPlot('${b.id}')">${btnLabel}</button>
            </div>`;
        });
        buildGrid.innerHTML = bHtml;
    } else {
        buildSec.style.display = "none";
        buyWrap.style.display = "flex";
        if (owned) {
            buyBtn.textContent = "Зайнято (" + owned.owner + ")";
            buyBtn.disabled = true;
        } else if (gameState.coins < price) {
            buyBtn.textContent = "Недостатньо монет (" + formatNumber(price) + ")";
            buyBtn.disabled = true;
        } else {
            buyBtn.textContent = "Купити землю (" + formatNumber(price) + ")";
            buyBtn.disabled = false;
        }
    }
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
    if (gameState.coins < price) return showDialog("Недостатньо коштів", "Потрібно " + formatNumberFull(price) + " 💰.\nПорада: ви можете накопичити кошти на депозиті або взяти кредит у вкладці «🏦 Банк»!", "💸");
    try {
        const result = await runTransaction(ref(db, `plots/${selectedPlotId}`), (current) => {
            if (current === null) return { owner: currentUser, price: price, boughtAt: Date.now(), zone: p.zone, building: null, treasury: 0, wage: 0, workers: {} };
            return;
        });
        if (!result.committed) return showDialog("Не встигли", "Хтось купив цю ділянку раніше.", "⚠️");
        gameState.coins -= price;
        sfx.win();
        renderAll(); saveGame();
        showMapInfo(selectedPlotId);
        setGameStatus("Ділянку куплено: " + p.name);
        showDialog("Ділянку куплено!", `${p.name}\nЗона: ${ZONE_INFO[p.zone].name}\nТепер ви можете звести тут прибуткову будівлю та наймати гравців!`, "🗺️");
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.buildOnSelectedPlot = async function (buildingId) {
    if (selectedPlotId === null) return;
    const p = MAP_PLOTS_BASE.find(x => x.id === selectedPlotId);
    const owned = sharedPlots[selectedPlotId];
    if (!p || !owned || owned.owner !== currentUser) return;

    const bld = getBuildingDef(p.zone, buildingId);
    if (!bld) return;
    if (gameState.coins < bld.cost) return showDialog("Недостатньо монет", "Потрібно " + formatNumberFull(bld.cost) + " 💰", "💸");

    try {
        const starterTreasury = (Number(owned.treasury) || 0) + Math.floor(bld.defaultWage * 25);
        await update(ref(db, `plots/${selectedPlotId}`), {
            building: bld.id,
            builtAt: Date.now(),
            wage: bld.defaultWage,
            treasury: starterTreasury
        });
        gameState.coins -= bld.cost;
        sfx.win();
        renderAll(); saveGame();
        showMapInfo(selectedPlotId);
        setGameStatus(`Збудовано: ${bld.name} (+${bld.income}/хв)`);
        showDialog("Будівництво завершено!", `${bld.icon} ${bld.name}\nДілянка: ${p.name}\nБазовий дохід: +${formatNumberFull(bld.income)} монет/хв\nСтартова каса зарплат: ${formatNumberFull(starterTreasury)} 💰\nІнші гравці тепер можуть влаштовуватись до вас на роботу!`, "🏗️");
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.clickBuilding = function (id) {
    if (id === "bank") switchPage("bank");
    else if (id === "bohdan") openBohdanModal();
    else if (id === "corp") {
        if (!hasCourse("basics")) {
            showDialog("КовельКорп", "Для вступу в ІТ-корпорацію «КовельКорп» потрібен сертифікат курсу «Основи програмування» (800 💰 у вкладці «🛒 Курси»).", "🏢");
        } else {
            joinKovelCorp();
            switchPage("work");
        }
    }
};

// ===== ДІМ БОГДАНА ПОЛІЩУКА (МИКОЛАЙЧУКА, 100) — ШІ ДІАЛОГ =====
let bohdanHistory = [];

function initBohdanChatIfEmpty() {
    const log = $("bohdan-chat-log");
    if (!log || log.children.length > 0) return;
    appendBohdanMsg(
        "bohdan",
        "Богдан Поліщук",
        "Здоров, козаче! Заходь у хату на Миколайчука 100, не стій на порозі. Я якраз зварювальний інвертор у гаражі налаштував після Чехії. Як сам? Працюєш у КовельКорп чи відкрив свій магазин у Ковелі?"
    );
}

function appendBohdanMsg(role, sender, text) {
    const log = $("bohdan-chat-log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "chat-msg " + (role === "user" ? "user" : "bohdan");
    div.innerHTML = `<div class="sender">${escapeHtml(sender)}</div><div>${escapeHtml(text)}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

window.openBohdanModal = function () {
    sfx.click();
    initBohdanChatIfEmpty();
    try {
        const savedKey = localStorage.getItem("w95_openrouter_key") || "";
        $("bohdan-api-key").value = savedKey;
    } catch (e) {}
    $("bohdan-overlay").classList.add("active");
    setTimeout(() => $("bohdan-input")?.focus(), 50);
};

window.closeBohdanModal = function () {
    $("bohdan-overlay").classList.remove("active");
};

window.openBohdanAiConfig = function () {
    const el = $("bohdan-ai-config");
    el.style.display = el.style.display === "none" ? "block" : "none";
};

window.saveBohdanApiKey = function () {
    const val = $("bohdan-api-key").value.trim();
    try {
        if (val) localStorage.setItem("w95_openrouter_key", val);
        else localStorage.removeItem("w95_openrouter_key");
    } catch (e) {}
    $("bohdan-ai-config").style.display = "none";
    appendBohdanMsg("bohdan", "Система Win95", val ? "Ключ OpenRouter збережено! Богдан підключений до хмарної LLM." : "Увімкнено локальний ШІ-движок Богдана.");
};

window.askBohdanPreset = function (text) {
    $("bohdan-input").value = text;
    sendBohdanMessage();
};

function generateSmartBohdanReply(userText) {
    const q = userText.toLowerCase();
    const job = gameState.employer === "corp" ? getCurrentCorpJob().name : getCurrentPrivateJob().name;
    const coins = formatNumberFull(gameState.coins);
    const dep = formatNumberFull(gameState.deposit?.amount || 0);
    const myPlots = MAP_PLOTS_BASE.filter(p => sharedPlots[p.id]?.owner === currentUser);

    if (q.includes("чехі") || q.includes("звар") || q.includes("робот") || q.includes("кемп") || q.includes("метал")) {
        const replies = [
            "Ох, у Чехії на заводі зміни по 12 годин з напівавтоматом! Шов клав як по маслу, крони капали, але вдома в Ковелі на Миколайчука все одно душевніше. Зате тепер можу зварити ворота чи ангар із закритими очима!",
            "У Чехії головне — маску хамелеон нормальну мати й подачу дроту виставити. Там добре підзаробив, але вирішив: треба на своїй вулиці Миколайчука 100 хазяйнувати!",
            `Ти зараз як «${job}» трудишся, а я тобі скажу: якщо візьмеш оранжеву промзону на Сільмаші й поставиш Зварювальний цех за 250К та наймеш туди робітників — кожен працівник дасть ще +25% до пасивного доходу!`
        ];
        return replies[Math.floor(Math.random() * replies.length)];
    }
    if (q.includes("інвест") || q.includes("земл") || q.includes("ділянк") || q.includes("куди") || q.includes("мап") || q.includes("пром") || q.includes("комерц")) {
        return `У тебе в гаманці ${coins} 💰 і на депозиті ${dep} 💰 (ділянок: ${myPlots.length}). Зелені житлові ділянки — від 15К, синя Комерція в Центрі — від 55К, а оранжева Промзона — від 180К. Коли збудуєш магазин чи цех, інші гравці зможуть влаштуватися до тебе на роботу й качати тобі касу!`;
    }
    if (q.includes("миколайчук") || q.includes("дім") || q.includes("хат") || q.includes("справ") || q.includes("життя")) {
        return "Та як на Миколайчука 100 — тихо, спокійно, свіже повітря! Свою садибу нізащо не продам, зате двері для друзів завжди відкриті. Сусідні ділянки (Миколайчука 33 та 75) якраз у кадастрі під житлову забудову — бери, будемо сусідами!";
    }
    if (q.includes("кав") || q.includes("чай") || q.includes("пив") || q.includes("гост") || q.includes("піц") || q.includes("класік")) {
        return "Оце по-нашому! ☕ Тримай гарячу каву по-ковельськи і канапки. До речі, як купиш синю комерційну землю в Центрі на Незалежності — відкривай там свою піцерію за 85 000 💰 і став нормальну зарплату, щоб гравці йшли до тебе працювати!";
    }
    const fallback = [
        `Слухай, ${currentUser || "брате"}, тепер у Ковелі можна і в КовельКорп через курси пробитися, і в магазин сусіда піти працювати за живі монети з каси!`,
        "Я як у Чехії варив металоконструкції, завжди думав: от повернусь у Ковель на Миколайчука 100 — зроблю все по красі. Так що ти теж не зупиняйся!",
        "До речі, ти бачив, що кожен робітник у твоєму магазині чи на заводі піднімає пасивний дохід об'єкта на +25% і поповнює касу кожним кліком?"
    ];
    return fallback[Math.floor(Math.random() * fallback.length)];
}

window.sendBohdanMessage = async function () {
    const input = $("bohdan-input");
    const btn = $("bohdan-send-btn");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sfx.click();
    appendBohdanMsg("user", currentUser || "Ви", text);
    bohdanHistory.push({ role: "user", content: text });

    btn.disabled = true;
    let apiKey = "";
    try { apiKey = localStorage.getItem("w95_openrouter_key") || ""; } catch (e) {}

    if (apiKey) {
        try {
            const sysPrompt = `Ти — Богдан Поліщук із міста Ковель (живеш на вул. Миколайчука, 100). Раніше працював зварювальником у Чехії, повернувся додому в Ковель. Розмовляєш живою, дружньою українською мовою з ковельським колоритом. Гравець ${currentUser} зараз у тебе в гостях у грі Win95 Work (гаманець: ${gameState.coins} монет, депозит: ${gameState.deposit?.amount || 0} монет). Відповідай лаконічно (2-3 речення).`;
            const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + apiKey
                },
                body: JSON.stringify({
                    model: "deepseek/deepseek-chat",
                    messages: [
                        { role: "system", content: sysPrompt },
                        ...bohdanHistory.slice(-6)
                    ]
                })
            });
            const data = await resp.json();
            const reply = data?.choices?.[0]?.message?.content?.trim();
            if (reply) {
                sfx.good();
                bohdanHistory.push({ role: "assistant", content: reply });
                appendBohdanMsg("bohdan", "Богдан Поліщук", reply);
                btn.disabled = false;
                return;
            }
        } catch (e) {}
    }

    setTimeout(() => {
        const reply = generateSmartBohdanReply(text);
        sfx.good();
        bohdanHistory.push({ role: "assistant", content: reply });
        appendBohdanMsg("bohdan", "Богдан Поліщук", reply);
        btn.disabled = false;
    }, 320);
};

document.addEventListener("DOMContentLoaded", () => {
    const bInput = $("bohdan-input");
    if (bInput) {
        bInput.addEventListener("keydown", e => {
            if (e.key === "Enter") sendBohdanMessage();
        });
    }
});

function renderBank() {
    const c = gameState.credit || { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
    const dep = gameState.deposit || { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 };
    const blocked = isBankBlocked();

    $("bank-top-wallet").textContent = formatNumberFull(gameState.coins) + " 💰";
    $("bank-top-deposit").textContent = formatNumberFull(dep.amount) + " 💰";
    $("bank-top-debt").textContent = formatNumberFull(c.amount) + " 💰";

    $("bank-blocked").classList.toggle("show", blocked);
    $("bank-warning").classList.toggle("show", c.amount > 0 && c.overdue);

    $("dep-balance").textContent = formatNumberFull(dep.amount) + " 💰";
    const nextYield = dep.amount > 0 ? Math.max(1, Math.floor(dep.amount * DEPOSIT_RATE_PER_MIN)) : 0;
    $("dep-next-yield").textContent = "+" + formatNumberFull(nextYield) + " 💰";
    const secLeft = dep.amount > 0 && dep.lastInterestAt
        ? Math.max(0, 60 - Math.floor((Date.now() - dep.lastInterestAt) / 1000))
        : 60;
    $("dep-next-timer").textContent = secLeft + "с";
    $("dep-earned-total").textContent = formatNumberFull(dep.totalEarned || 0) + " 💰";
    $("dep-take-btn").disabled = dep.amount <= 0;
    $("dep-take-all-btn").disabled = dep.amount <= 0;
    $("dep-put-btn").disabled = gameState.coins <= 0;

    const limit = getCreditLimit();
    const curJobTitle = gameState.employer === "corp" ? getCurrentCorpJob().name : getCurrentPrivateJob().name;
    $("credit-limit").textContent = "до " + formatNumberFull(limit) + " 💰";
    if (c.amount > 0) {
        $("credit-card-info").style.display = "none";
        $("credit-active-card").style.display = "block";
        $("credit-debt").textContent = formatNumberFull(c.amount) + " 💰";
        const remaining = c.dueAt - Date.now();
        if (remaining > 0) {
            $("credit-due-text").innerHTML = `Повернути через: <b>${formatDuration(remaining)}</b>.<br>Ви можете гасити борг частинами або повністю.`;
        } else {
            $("credit-due-text").innerHTML = `⚠️ <b>Прострочено на ${formatDuration(Date.now() - c.dueAt)}!</b> Штраф +10% кожні 5 хв.`;
        }
        $("credit-debt-fill").style.width = Math.min(100, (gameState.coins / c.amount) * 100) + "%";
        $("credit-debt-text").textContent = `У гаманці: ${formatNumber(gameState.coins)} / Борг: ${formatNumber(c.amount)}`;
        $("credit-repay-btn").textContent = "Погасити все (" + formatNumber(c.amount) + ")";
        $("credit-repay-btn").disabled = gameState.coins < c.amount;
        $("credit-repay-part-btn").disabled = gameState.coins <= 0;
    } else {
        $("credit-card-info").style.display = "block";
        $("credit-active-card").style.display = "none";
        $("credit-info-text").innerHTML =
            `• Ваш ліміт залежить від посади (<b>${escapeHtml(curJobTitle)}</b>) або 80% вашого капіталу.<br>` +
            `• Комісія банку: <b>5%</b> (додається до боргу). Термін: <b>30 хв</b>.<br>` +
            `• Доступне часткове погашення у будь-який момент.`;
        $("credit-take-btn").disabled = limit <= 0;
    }
}

// ===== СТАРТ ЗАДАЧІ В КОВЕЛЬКОРП АБО КЛІК-РОБОТА НА ПРИВАТНОМУ ПІДПРИЄМСТВІ =====
window.startTaskOrShowStatus = function () {
    if (!currentUser || isCourseRunning() || isBankBlocked()) return;

    if (gameState.employer === "corp") {
        if (!hasCourse("basics")) {
            gameState.employer = "none";
            renderAll();
            return showDialog("Потрібен курс!", "Для роботи в КовельКорп пройдіть курс «Основи програмування».", "🎓");
        }
        sfx.click();
        gameState.taskActive = true;
        gameState.taskProgress = 0;
        renderTask();
        miniGames.startRandom(gameState.jobIndex);
        updateWorkButtonState();
        setGameStatus("ІТ-задачу в КовельКорп розпочато!");
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        doPrivateClickWork(pid);
    } else {
        doMunicipalClickWork();
    }
};

window.doPromote = async function () {
    if (gameState.employer === "corp") {
        const job = getCurrentCorpJob();
        const nextJob = JOBS[gameState.jobIndex + 1];
        if (!nextJob || job.xpNeeded <= 0 || gameState.xp < job.xpNeeded) return;

        if (!hasCourse(nextJob.reqCourse)) {
            return showDialog(
                "Потрібен курс для підвищення!",
                `Щоб отримати звання «${nextJob.name}» у КовельКорп, вам необхідно пройти курс:\n\n🎓 «${getCourseName(nextJob.reqCourse)}»\n\nПерейдіть у вкладку «🛒 Курси», щоб розпочати навчання!`,
                "📚"
            );
        }

        miniGames.stop();
        gameState.xp -= job.xpNeeded;
        gameState.jobIndex = Math.min(gameState.jobIndex + 1, JOBS.length - 1);
        gameState.taskActive = false; gameState.taskProgress = 0;
        sfx.win();
        renderAll();
        saveGame();
        setGameStatus("Підвищення в КовельКорп! " + getCurrentCorpJob().name);
        showDialog("Підвищення в КовельКорп!", "Ви стали: " + getCurrentCorpJob().name, "🎉");
    } else {
        const pJob = getCurrentPrivateJob();
        const nextPJob = PRIVATE_JOBS[gameState.privateJobIndex + 1];
        if (!nextPJob || pJob.xpNeeded <= 0 || gameState.privateXp < pJob.xpNeeded) return;

        gameState.privateXp -= pJob.xpNeeded;
        gameState.privateJobIndex = Math.min(gameState.privateJobIndex + 1, PRIVATE_JOBS.length - 1);
        const newRole = getCurrentPrivateJob();

        const pid = getActiveEmployerPlotId();
        if (pid !== null) {
            try {
                await update(ref(db, `plots/${pid}/workers/${currentUser}`), {
                    role: newRole.name,
                    level: gameState.privateJobIndex
                });
            } catch (e) {}
        }

        sfx.win();
        renderAll();
        saveGame();
        setGameStatus(`Нова посада: ${newRole.name} (ЗП ×${newRole.mult})`);
        showDialog("Підвищення на роботі!", `Ви отримали посаду: ${newRole.name}\nМножник вашої зарплати тепер: ×${newRole.mult}!`, "🎉");
    }
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
    const te = $("tabnav-" + page); if (te) te.classList.add("active");
    if (page === "leaderboard") { loadLeaderboard(); loadOnline(); }
    if (page === "shop") renderShop();
    if (page === "map") {
        renderMap();
        setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 60);
    }
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
        const list = Object.entries(snap.val()).map(([name, d]) => ({
            name,
            coins: (Number(d?.clicker?.coins) || 0) + (Number(d?.clicker?.deposit?.amount) || 0)
        }));
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
        myRankEl.textContent = idx >= 0 ? `Ваше місце: #${idx + 1} з ${list.length} (гаманець + депозит)` : "Вас немає в списку";
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
            .map(([name, d]) => ({
                name,
                coins: (Number(d?.clicker?.coins) || 0) + (Number(d?.clicker?.deposit?.amount) || 0),
                lastOnline: Number(d?.lastOnline) || 0,
                online: (now - (Number(d?.lastOnline) || 0)) < ONLINE_THRESHOLD_MS
            }))
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
    if (rentTimerInterval) clearInterval(rentTimerInterval);
    if (dataListener) { dataListener(); dataListener = null; }
    if (mapListener) { mapListener(); mapListener = null; }
    currentUser = "";
    gameState = {
        coins: 0, jobIndex: 0, xp: 0,
        privateJobIndex: 0, privateXp: 0, employer: "none",
        taskProgress: 0, taskActive: false,
        activeCourseId: null, courseStartTime: 0, completedCourses: [], xpBoost: 0,
        credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
        deposit: { amount: 0, lastInterestAt: 0, totalEarned: 0 }
    };
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
                coins: gameState.coins,
                jobIndex: gameState.jobIndex,
                xp: gameState.xp,
                privateJobIndex: gameState.privateJobIndex,
                privateXp: gameState.privateXp,
                employer: gameState.employer,
                taskProgress: gameState.taskProgress,
                taskActive: gameState.taskActive,
                activeCourseId: gameState.activeCourseId,
                courseStartTime: gameState.courseStartTime,
                completedCourses: gameState.completedCourses,
                xpBoost: gameState.xpBoost,
                credit: gameState.credit,
                deposit: gameState.deposit
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
