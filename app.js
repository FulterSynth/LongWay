import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, child, update, onValue, runTransaction, push } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { MiniGameManager, sfx } from "./minigames.js";

const APP_VERSION = "4.3.0";
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 30000;
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const LEADERBOARD_LIMIT = 100;

// Депозит у банку (1% в годину) та погодинний облік землі й будівель (3 600 000 мс)
const HOUR_MS = 3600000;
const DEPOSIT_RATE_PER_HOUR = 0.003; // +0.3% на годину

// Глобальний цикл Богдана Поліщука ДЛЯ ВСІХ: 24 год продає перші 2 пром. курси (-10%), 24 год відпочиває (хмари, кола, Clash Royale)
const BOHDAN_ACTIVE_MS = 24 * 60 * 60 * 1000;
const BOHDAN_REST_MS = 24 * 60 * 60 * 1000;
const BOHDAN_CYCLE_MS = BOHDAN_ACTIVE_MS + BOHDAN_REST_MS;
const BOHDAN_CYCLE_EPOCH = Date.UTC(2026, 10, 16, 0, 0, 0);
const BOHDAN_DISCOUNT_MULT = 0.90; // на 10% дешевше

// Налаштування кулдаунів та покрокових замовлень для робіт гравців і підробітку
const ORDER_STEPS_REQUIRED = 5;
const PRIVATE_STEP_COOLDOWN_MS = 1600;   // 1.6 сек між діями одного замовлення
const PRIVATE_ORDER_COOLDOWN_MS = 7000;  // 7 сек перерва після виконаного замовлення
const MUNICIPAL_STEP_COOLDOWN_MS = 1200; // 1.2 сек між діями на муніципальному підробітку
const MUNICIPAL_ORDER_COOLDOWN_MS = 4500;// 4.5 сек перерва після муніципального завдання
const MUNICIPAL_TASK_REWARD = 5;         // Нагорода за розчищення ділянки двірником

const PRIVATE_ORDER_STAGE_LABELS = [
    "Крок 1/5: Прийняти замовлення клієнта",
    "Крок 2/5: Підготувати товар / сировину",
    "Крок 3/5: Перевірити якість і упакувати",
    "Крок 4/5: Оформити чек через касу",
    "Крок 5/5: Видати готове замовлення клієнту"
];

const OWNER_ASSIGNED_TITLES = [
    "Новачок",
    "Робітник зміни",
    "Старший зміни",
    "Провідний фахівець",
    "Керуючий філією",
    "Права рука власника"
];


// ===== СИСТЕМА ПОТОКУ КЛІЄНТІВ, ПЕРМАНЕНТНОЇ ІНФРАСТРУКТУРИ ТА ТИМЧАСОВОЇ РЕКЛАМИ (v4.3.0) =====
const BUSINESS_UPGRADES = [
    { id: "parking",  name: "🅿️ Власна парковка",          cost: 12000, clientBonus: 15, desc: "+15 макс. клієнтів/год назавжди" },
    { id: "ramp",     name: "♿ Пандус і доступність",     cost: 15000, clientBonus: 15, desc: "+15 макс. клієнтів/год назавжди" },
    { id: "cameras",  name: "📹 Камери безпеки і Wi-Fi",   cost: 24000, clientBonus: 20, desc: "+20 макс. клієнтів/год назавжди" },
    { id: "climate",  name: "❄️ Кондиціонер і лаунж-зона", cost: 38000, clientBonus: 25, desc: "+25 макс. клієнтів/год назавжди" }
];

const BUSINESS_ADS = [
    { id: "flyers", name: "📢 Листівки біля ЦУМу",       cost: 1500,  durationMs: 3600000,  multPct: 35,  instantClients: 18, desc: "+35% до потоку на 1 год і +18 клієнтів одразу" },
    { id: "radio",  name: "📻 Реклама на Радіо Ковель",  cost: 4200,  durationMs: 7200000,  multPct: 65,  instantClients: 40, desc: "+65% до потоку на 2 год і +40 клієнтів одразу" },
    { id: "social", name: "📱 Таргет у соцмережах",      cost: 9500,  durationMs: 10800000, multPct: 100, instantClients: 75, desc: "+100% до потоку (x2) на 3 год і +75 клієнтів одразу" }
];

function getBaseClientsPerHour(zone, buildingId) {
    const zInfo = ZONE_INFO[zone];
    if (!zInfo || !buildingId) return 15;
    const idx = zInfo.buildings.findIndex(b => b.id === buildingId);
    const tierRates = [16, 30, 52, 85];
    return tierRates[Math.max(0, idx)] || 16;
}

function getPlotClientsState(plot, ownedData) {
    if (!plot || !ownedData || !ownedData.building) {
        return { current: 0, max: 0, perHour: 0, adActive: false, adRemainingMs: 0, nextClientSec: 0 };
    }
    const basePerHour = getBaseClientsPerHour(plot.zone, ownedData.building);
    const upgMap = ownedData.upgrades || {};
    let upgradeBonus = 0;
    BUSINESS_UPGRADES.forEach(u => {
        if (upgMap[u.id]) upgradeBonus += u.clientBonus;
    });

    const now = Date.now();
    const adUntil = Number(ownedData.adUntil) || 0;
    const adMultPct = adUntil > now ? (Number(ownedData.adMultPct) || 0) : 0;
    const rawCap = basePerHour + upgradeBonus;
    const perHour = Math.round(rawCap * (1 + adMultPct / 100));
    const maxClients = perHour;

    const lastRefill = Number(ownedData.clientsLastRefillAt) || Number(ownedData.builtAt) || now;
    const storedClients = ownedData.clientsRemaining !== undefined ? Number(ownedData.clientsRemaining) : maxClients;
    const elapsedMs = Math.max(0, now - lastRefill);
    const msPerClient = HOUR_MS / Math.max(1, perHour);
    const regenerated = Math.floor(elapsedMs / msPerClient);
    const current = Math.min(maxClients, Math.max(0, storedClients + regenerated));
    const remToNextMs = current >= maxClients ? 0 : Math.max(1000, msPerClient - (elapsedMs % msPerClient));

    return {
        current,
        max: maxClients,
        perHour,
        basePerHour,
        upgradeBonus,
        adActive: adUntil > now,
        adName: ownedData.adName || "",
        adMultPct,
        adRemainingMs: Math.max(0, adUntil - now),
        nextClientSec: Math.ceil(remToNextMs / 1000)
    };
}

const DEFAULT_CITY_TAX_POLICY = {
    residential: { turnoverTaxPct: 8,  landTaxPct: 0.4 },
    commercial:  { turnoverTaxPct: 12, landTaxPct: 0.5 },
    industrial:  { turnoverTaxPct: 16, landTaxPct: 0.6 },
    updatedAt: 0,
    updatedBy: "Міська рада Ковеля"
};

let cityTaxPolicy = JSON.parse(JSON.stringify(DEFAULT_CITY_TAX_POLICY));
let policyListener = null;

// ВИМОГА 1: ІТ-курси повернуто точно як було раніше (800, 3500, 9000, 22000, 45000, 90000),
// а курси Житлової, Комерційної та Промислової зон розділені й усі дешевші за ІТ (< 800 💰)!
const COURSES = [
    // 1. ІТ-курси (КовельКорп — проходяться строго по черзі!)
    { id: "basics", category: "it", name: "Основи програмування", price: 800, durationMs: 3600000, boost: 10, zoneBoost: 0, desc: "Крок 1: Базовий курс для вступу в КовельКорп" },
    { id: "algorithms", category: "it", name: "Алгоритми та структури даних", price: 3500, durationMs: 10800000, boost: 15, zoneBoost: 0, desc: "Крок 2: Потрібен для звання Junior QA та Junior Developer" },
    { id: "cleancode", category: "it", name: "Clean Code (книга)", price: 9000, durationMs: 18000000, boost: 20, zoneBoost: 0, desc: "Крок 3: Потрібен для звання Middle Developer" },
    { id: "sysdesign", category: "it", name: "Системний дизайн", price: 22000, durationMs: 28800000, boost: 25, zoneBoost: 0, desc: "Крок 4: Потрібен для звання Senior Developer" },
    { id: "leadership", category: "it", name: "Лідерство і менеджмент", price: 45000, durationMs: 43200000, boost: 30, zoneBoost: 0, desc: "Крок 5: Потрібен для звання Team Lead" },
    { id: "architecture", category: "it", name: "Архітектура високих навантажень", price: 90000, durationMs: 64800000, boost: 40, zoneBoost: 0, desc: "Крок 6: Потрібен для звання Tech Lead та CTO" },

    // 2. Курси Житлової зони (збалансовані % та підвищені ціни: 450 – 9 500 💰)
    { id: "res_plumber", category: "residential", name: "Сантехніка та водопровід ОСББ", price: 450, durationMs: 900000, boost: 0, zoneBoost: 5, desc: "Дає +5% до чека клієнта при роботі на об'єктах у Житловій зоні" },
    { id: "res_electric", category: "residential", name: "Електромонтаж побутових мереж", price: 1200, durationMs: 1800000, boost: 0, zoneBoost: 8, desc: "Допуск до обслуговування таунхаусів і ЖК: +8% до чека у Житловій зоні" },
    { id: "res_landscape", category: "residential", name: "Благоустрій двору та озеленення", price: 2800, durationMs: 2700000, boost: 0, zoneBoost: 12, desc: "Професійний догляд за житловими кварталами: +12% до чека у Житловій зоні" },
    { id: "res_repair", category: "residential", name: "Майстер ремонту квартир і будинків", price: 5500, durationMs: 3600000, boost: 0, zoneBoost: 16, desc: "Комплексний ремонт та утеплення фасадів: +16% до чека у Житловій зоні" },
    { id: "res_osbb", category: "residential", name: "Управління ОСББ та житловим фондом", price: 9500, durationMs: 5400000, boost: 0, zoneBoost: 22, desc: "Диплом головного управителя ЖК: +22% до чека замовлення у Житловій зоні" },

    // 3. Курси Комерційної зони (збалансовані % та підвищені ціни: 550 – 12 000 💰)
    { id: "com_cashier", category: "commercial", name: "Касова справа та обслуговування", price: 550, durationMs: 900000, boost: 0, zoneBoost: 5, desc: "Швидкий розрахунок покупців: +5% до чека клієнта у Комерційній зоні" },
    { id: "com_barista", category: "commercial", name: "Бариста і кухар піцерії", price: 1500, durationMs: 1800000, boost: 0, zoneBoost: 8, desc: "Професійна робота в кав'ярнях і піцеріях Ковеля: +8% до чека у Комерційній зоні" },
    { id: "res_trade", category: "commercial", name: "Товарознавство та мерчандайзинг", price: 3400, durationMs: 2700000, boost: 0, zoneBoost: 12, desc: "Грамотна викладка товарів у маркетах і пасажах: +12% до чека у Комерційній зоні" },
    { id: "com_marketing", category: "commercial", name: "Торговий маркетинг та продажі", price: 6800, durationMs: 3600000, boost: 0, zoneBoost: 16, desc: "Залучення клієнтів і підвищення середнього чека: +16% у Комерційній зоні" },
    { id: "com_admin", category: "commercial", name: "Адміністратор ТРЦ та бізнес-холу", price: 12000, durationMs: 5400000, boost: 0, zoneBoost: 22, desc: "Диплом топ-менеджера торгівлі: +22% до чека замовлення у Комерційній зоні" },

    // 4. Курси Промислової зони та Зварювання (збалансовані % та підвищені ціни: 650 – 15 000 💰)
    { id: "ind_safety", category: "industrial", name: "Охорона праці та техніка безпеки", price: 650, durationMs: 900000, boost: 0, zoneBoost: 5, isWelding: true, bohdanOffer: true, desc: "Обов'язковий інструктаж для роботи в цехах і на заводах: +5% до чека" },
    { id: "ind_welding", category: "industrial", name: "Електрогазозварювання (MIG/MAG)", price: 1800, durationMs: 1800000, boost: 0, zoneBoost: 8, isWelding: true, bohdanOffer: true, desc: "Зварювання металоконструкцій та ремонт техніки на СТО: +8% до чека" },
    { id: "ind_forklift", category: "industrial", name: "Аргонодугове зварювання (TIG) і різка", price: 4200, durationMs: 2700000, boost: 0, zoneBoost: 12, isWelding: true, desc: "Робота з нержавійкою, алюмінієм і складними деталями: +12% до чека" },
    { id: "ind_cnc", category: "industrial", name: "Оператор верстатів з ЧПК та плазморіза", price: 8500, durationMs: 3600000, boost: 0, zoneBoost: 16, isWelding: true, desc: "Точна промислова обробка металу та автоматизація ліній: +16% до чека" },
    { id: "ind_chief", category: "industrial", name: "Головний інженер-зварювальник заводу", price: 15000, durationMs: 5400000, boost: 0, zoneBoost: 22, isWelding: true, desc: "Вища виробнича кваліфікація для заводів і депо Ковеля: +22% до чека" }
];

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

// ВИМОГА 4: Перероблені будівлі у Житловій, Комерційній та Промисловій зонах (по 4 рівні забудови в кожній зоні!)
const ZONE_INFO = {
    residential: {
        name: "🏡 Житлова зона",
        shortName: "Житлова",
        basePrice: 15000,
        fillFree: "#2ecc71",
        borderFree: "#0b5e28",
        desc: "Житлові квартали, таунхауси, ОСББ та сервісні служби побуту. Найнижчий податок на землю та оборот.",
        buildings: [
            { id: "kiosk", name: "Комунальна майстерня двору (ЖЕК)", icon: "🛠️", cost: 22000, income: 240, defaultWage: 12, clickProfit: 24 },
            { id: "house", name: "Дуплекси та Таунхаус-кооператив", icon: "🏘️", cost: 60000, income: 650, defaultWage: 24, clickProfit: 48 },
            { id: "apartments", name: "Житловий комплекс «Турія-Парк» (ОСББ)", icon: "🏢", cost: 150000, income: 1700, defaultWage: 50, clickProfit: 98 },
            { id: "res_elite", name: "Елітний мікрорайон «Ковель-Резиденс»", icon: "🏰", cost: 360000, income: 4200, defaultWage: 105, clickProfit: 210 }
        ]
    },
    commercial: {
        name: "🏪 Комерційна зона",
        shortName: "Комерційна",
        basePrice: 55000,
        fillFree: "#2980ff",
        borderFree: "#003080",
        desc: "Пекарні, ресторани, пасажі та торгово-розважальні центри. Високий потік покупців і середній податок.",
        buildings: [
            { id: "cafe", name: "Пекарня та Міні-маркет «Свіжа випічка»", icon: "🥐", cost: 75000, income: 880, defaultWage: 32, clickProfit: 64 },
            { id: "mall", name: "Ресторан-Піцерія «Класік»", icon: "🍕", cost: 210000, income: 2500, defaultWage: 75, clickProfit: 148 },
            { id: "it_hub", name: "Гіпермаркет та Торговий Пасаж", icon: "🛒", cost: 520000, income: 6800, defaultWage: 170, clickProfit: 330 },
            { id: "com_plaza", name: "ТРЦ «Ковель-Плаза» & Бізнес-Хол", icon: "🏬", cost: 1150000, income: 15500, defaultWage: 350, clickProfit: 680 }
        ]
    },
    industrial: {
        name: "🏭 Промислова зона",
        shortName: "Промислова",
        basePrice: 180000,
        fillFree: "#ff7722",
        borderFree: "#7a2200",
        desc: "Зварювальні цехи, меблеві комбінати, залізничні термінали та важке машинобудування.",
        buildings: [
            { id: "auto_weld", name: "Зварювальний цех та Автосервіс (СТО)", icon: "🔧", cost: 220000, income: 2900, defaultWage: 88, clickProfit: 170 },
            { id: "logistics", name: "Деревообробний та Меблевий комбінат", icon: "🪵", cost: 580000, income: 7800, defaultWage: 195, clickProfit: 380 },
            { id: "factory", name: "Євро-Логістичний Термінал та Депо", icon: "🚂", cost: 1350000, income: 19500, defaultWage: 390, clickProfit: 760 },
            { id: "ind_plant", name: "Машинобудівний завод «КовельПромМаш»", icon: "🏭", cost: 2900000, income: 44000, defaultWage: 800, clickProfit: 1550 }
        ]
    }
};

// Меню кафе "DOBRE" (вул. Косачів, 4а)
const DOBRE_MENU = [
    {
        id: "pepperoni",
        name: "🍕 Піца Пепероні",
        price: 20,
        desc: "Гаряча піца з пепероні просто для душі! Особливих бонусів не дає — чисто прікольчік.",
        effect: "fun_only"
    },
    {
        id: "espresso",
        name: "☕ Еспресо «DOBRE»",
        price: 25,
        desc: "Миттєво знімає перерву (кулдаун) на роботі — одразу беріть наступне замовлення!",
        effect: "reset_cooldown"
    },
    {
        id: "croissant",
        name: "🥐 Капучино + Французький круасан",
        price: 120,
        desc: "Знімає кулдаун роботи та скорочує час навчання на поточному курсі на 10 хвилин!",
        effect: "boost_course_10m"
    },
    {
        id: "lunch",
        name: "🍲 Фірмовий ланч «DOBRE на Косачів, 4а»",
        price: 340,
        desc: "Повний заряд бадьорості: знімає кулдаун роботи та скорочує час поточного курсу на 35 хвилин!",
        effect: "boost_course_35m"
    }
];

const KOVEL_CENTER = [51.2135, 24.7060];
const KOVEL_BOUNDS = [
    [51.1860, 24.6480],
    [51.2420, 24.7620]
];

// ВИМОГА 5: Вулиця Косачів, 4а — там знаходиться кафе "DOBRE", так само як дім Поліщука (видно на макс. зумі!)
const MAP_BUILDINGS = [
    { id: "bank", name: "КовельБанк 98", icon: "🏦", cls: "bank", lat: 51.2121, lng: 24.7102, sub: "Кредити та Депозити", secretZoom: false },
    { id: "corp", name: "КовельКорп", icon: "🏢", cls: "corp", lat: 51.2208, lng: 24.7120, sub: "IT-Корпорація", secretZoom: false },
    { id: "bohdan", name: "Дім Богдана Поліщука", icon: "👨‍🏭", cls: "bohdan", lat: 51.2226, lng: 24.7392, sub: "вул. Миколайчука, 100", secretZoom: true },
    { id: "dobre", name: 'Кафе "DOBRE"', icon: "☕", cls: "dobre", lat: 51.2149, lng: 24.7114, sub: "вул. Косачів, 4а", secretZoom: true }
];

const MAP_PLOTS_BASE = [
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

function isAdminUser() {
    return currentUser && currentUser.toLowerCase() === "admin";
}

function getOwnedPlotData(plotId) {
    const d = sharedPlots ? sharedPlots[plotId] : null;
    if (!d || !d.owner || String(d.owner).trim() === "" || d.wiped) return null;
    return d;
}

function formatPlotCoords(plot) {
    if (!plot) return "—";
    return `${plot.lat.toFixed(4)}°N, ${plot.lng.toFixed(4)}°E`;
}

function getZoneTaxRates(zone) {
    const z = cityTaxPolicy && cityTaxPolicy[zone] ? cityTaxPolicy[zone] : DEFAULT_CITY_TAX_POLICY[zone] || DEFAULT_CITY_TAX_POLICY.residential;
    return {
        turnoverTaxPct: Math.max(0, Math.min(60, Number(z.turnoverTaxPct) || 8)),
        landTaxPct: Math.max(0.1, Math.min(10, Number(z.landTaxPct) || 0.4))
    };
}

function getExistingEmploymentForOwner(targetUser, ownerUser = currentUser) {
    if (!targetUser || !ownerUser) return null;
    const tClean = String(targetUser).trim().toLowerCase();
    for (const p of MAP_PLOTS_BASE) {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === ownerUser && owned.workers) {
            for (const wName of Object.keys(owned.workers)) {
                if (wName.toLowerCase() === tClean) {
                    const bld = getBuildingDef(p.zone, owned.building);
                    return {
                        plotId: p.id,
                        plotName: p.name,
                        buildingName: bld ? `${bld.icon} ${bld.name}` : p.name,
                        workerName: wName
                    };
                }
            }
        }
    }
    return null;
}

function getWorkerZoneSkillBonusPct(completedList, plotZone) {
    if (!Array.isArray(completedList) || !completedList.length) return 0;
    let totalPct = 0;
    completedList.forEach(cid => {
        const c = COURSES.find(x => x.id === cid);
        if (!c) return;
        if (c.category === plotZone) {
            totalPct += (Number(c.zoneBoost) || 0);
        }
    });
    return totalPct;
}

function calcOrderFinancials(plotZone, buildingDef, workerCourses = [], workerWage = 15) {
    const baseCheck = buildingDef ? buildingDef.clickProfit : 24;
    const skillBonusPct = getWorkerZoneSkillBonusPct(workerCourses, plotZone);
    const grossCheck = Math.max(2, Math.round(baseCheck * (1 + skillBonusPct / 100)));
    const { turnoverTaxPct } = getZoneTaxRates(plotZone);
    const taxAmount = Math.max(1, Math.round(grossCheck * (turnoverTaxPct / 100)));
    const afterTaxRevenue = Math.max(1, grossCheck - taxAmount);
    const wage = Math.max(1, Math.floor(Number(workerWage) || (buildingDef ? buildingDef.defaultWage : 12)));
    const ownerNetMargin = afterTaxRevenue - wage;
    return {
        baseCheck,
        skillBonusPct,
        grossCheck,
        turnoverTaxPct,
        taxAmount,
        afterTaxRevenue,
        wage,
        ownerNetMargin
    };
}

function renderCourseChipsHtml(completedList, targetZone = null) {
    if (!Array.isArray(completedList) || !completedList.length) {
        return `<span class="muted">Немає пройдених курсів</span>`;
    }
    return completedList.map(cid => {
        const c = COURSES.find(x => x.id === cid);
        if (!c) return "";
        const isMatched = targetZone && c.category === targetZone;
        const cls = isMatched ? "matched" : (c.category === "it" ? "it" : (c.category === "industrial" ? "ind" : ""));
        const bonusLabel = c.zoneBoost > 0 ? ` (+${c.zoneBoost}%)` : (c.boost > 0 ? ` (+${c.boost}% IT)` : "");
        return `<span class="course-chip ${cls}">🎓 ${escapeHtml(c.name)}${bonusLabel}</span>`;
    }).join(" ");
}

function geoDistMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * 111320;
    const dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

function getBuildingProximityBonus(plot) {
    let bonus = 0;
    MAP_BUILDINGS.forEach(b => {
        if (b.secretZoom) return;
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
    return getPlotNeighbors(plotId).filter(id => owners && owners[id] && owners[id].owner && !owners[id].wiped).length;
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

function getPlotPassiveBonusPct(plot, ownedData) {
    if (!ownedData || !ownedData.workers) return 0;
    const workersArr = Object.values(ownedData.workers);
    let totalBoostPct = 0;
    workersArr.forEach(w => {
        totalBoostPct += 15;
        const skillBonus = getWorkerZoneSkillBonusPct(w?.completedCourses || [], plot.zone);
        totalBoostPct += Math.round(skillBonus * 0.25);
    });
    return Math.min(180, totalBoostPct);
}

function calcPlotHourlyTaxAndNet(plot, ownedData) {
    if (!plot) return { grossIncome: 0, landTax: 0, turnoverTax: 0, totalTax: 0, netIncome: 0, landTaxPct: 0, turnoverTaxPct: 0 };
    const { turnoverTaxPct, landTaxPct } = getZoneTaxRates(plot.zone);
    const landValue = ownedData && Number(ownedData.price) > 0 ? Number(ownedData.price) : calcPlotPrice(plot, sharedPlots);
    const landTax = Math.max(10, Math.round(landValue * (landTaxPct / 100)));

    if (!ownedData || !ownedData.owner || ownedData.wiped) {
        return { grossIncome: 0, landTax, turnoverTax: 0, totalTax: landTax, netIncome: -landTax, landTaxPct, turnoverTaxPct };
    }

    const bld = getBuildingDef(plot.zone, ownedData.building);
    if (!bld) {
        return { grossIncome: 0, landTax, turnoverTax: 0, totalTax: landTax, netIncome: -landTax, landTaxPct, turnoverTaxPct };
    }

    const bonusPct = getPlotPassiveBonusPct(plot, ownedData);
    const grossIncome = Math.floor(bld.income * (1 + bonusPct / 100));
    const turnoverTax = Math.max(1, Math.round(grossIncome * (turnoverTaxPct / 100)));
    const totalTax = landTax + turnoverTax;
    const netIncome = grossIncome - totalTax;

    return {
        grossIncome,
        landTax,
        turnoverTax,
        totalTax,
        netIncome,
        landTaxPct,
        turnoverTaxPct,
        bonusPct
    };
}

function getPlotPassiveIncome(plot, ownedData) {
    return calcPlotHourlyTaxAndNet(plot, ownedData).netIncome;
}

function getPlayerPortfolioHourlyBreakdown(username = currentUser) {
    let grossTotal = 0;
    let landTaxTotal = 0;
    let turnoverTaxTotal = 0;
    let netTotal = 0;
    let plotsCount = 0;
    let builtCount = 0;

    if (!username || !sharedPlots) {
        return { grossTotal: 0, landTaxTotal: 0, turnoverTaxTotal: 0, netTotal: 0, plotsCount: 0, builtCount: 0 };
    }

    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === username) {
            plotsCount++;
            if (owned.building) builtCount++;
            const calc = calcPlotHourlyTaxAndNet(p, owned);
            grossTotal += calc.grossIncome;
            landTaxTotal += calc.landTax;
            turnoverTaxTotal += calc.turnoverTax;
            netTotal += calc.netIncome;
        }
    });

    return { grossTotal, landTaxTotal, turnoverTaxTotal, netTotal, plotsCount, builtCount };
}

function getTotalPassiveIncomePerHour() {
    return getPlayerPortfolioHourlyBreakdown(currentUser).netTotal;
}

function getTotalOwnerTreasury() {
    if (!currentUser || !sharedPlots) return 0;
    let sum = 0;
    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === currentUser && owned.building) {
            sum += Math.max(0, Number(owned.treasury) || 0);
        }
    });
    return sum;
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

let currentUser = "";
let authMode = "login";
let activeBankTab = "deposit";
let activeWorkSubtab = "vacancies";
let activeCourseCategory = "it";
let activeMailSubtab = "inbox";
let activeHistoryContact = "";
let resumeTargetPlotId = null;

let userInboxMail = {};
let userSentMail = {};
let mailInboxListener = null;
let mailSentListener = null;
let lastUnreadMailCount = 0;

let workCooldownUntil = 0;
let workCooldownTotalMs = 0;
let workCooldownReason = "";
let cooldownIntervalId = null;
let isProcessingWorkClick = false;

let lastLocalCoinChangeAt = 0;
let pendingSaveRequested = false;

function markLocalCoinsChanged() {
    lastLocalCoinChangeAt = Date.now();
}

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
    coursePaused: false,
    courseRemainingMs: 0,
    bohdanDiscountUsedAt: 0,
    completedCourses: [],
    xpBoost: 0,
    lastRentAt: 0,
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
let saveTimer = null, heartbeatTimer = null, courseTimerInterval = null, dataListener = null, creditTimerInterval = null;
let isSaving = false, currentPage = "work";

const miniGames = new MiniGameManager(
    { window: "mg-window", icon: "mg-icon", title: "mg-title", badge: "mg-badge", body: "mg-body" },
    {
        onStep: (fraction) => {
            if (gameState.employer === "corp") {
                const job = getCurrentCorpJob();
                const xpGain = Math.max(1, job.taskClicks * fraction) * (1 + gameState.xpBoost / 100);
                gameState.xp += xpGain;
                gameState.taskProgress = Math.min(job.taskClicks, gameState.taskProgress + job.taskClicks * fraction);
            } else {
                gameState.taskProgress = Math.min(6, gameState.taskProgress + 1);
            }
            renderStats();
            renderTask();
        },
        onComplete: () => {
            const job = getCurrentCorpJob();
            gameState.coins += job.taskReward;
            markLocalCoinsChanged();
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

function $(id) { return document.getElementById(id); }
function formatNumber(n) {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "K";
    return sign + Math.floor(abs).toString();
}
function formatNumberFull(n) {
    const sign = n < 0 ? "-" : "";
    return sign + Math.floor(Math.abs(n)).toLocaleString("uk-UA");
}
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

function getMissingPreviousItCourse(courseId, completedList = gameState.completedCourses) {
    const itList = COURSES.filter(x => x.category === "it");
    const idx = itList.findIndex(x => x.id === courseId);
    if (idx <= 0) return null;
    const prev = itList[idx - 1];
    if (!Array.isArray(completedList) || !completedList.includes(prev.id)) {
        return prev;
    }
    return null;
}

function hasCourse(courseId, completedList = gameState.completedCourses) {
    if (!courseId) return true;
    if (!Array.isArray(completedList) || !completedList.length) return false;
    if (completedList.includes(courseId)) return true;

    const reqCourse = COURSES.find(x => x.id === courseId);
    if (!reqCourse) return false;

    return completedList.some(doneId => {
        const doneCourse = COURSES.find(x => x.id === doneId);
        return doneCourse && doneCourse.category === reqCourse.category && doneCourse.price >= reqCourse.price;
    });
}

function getCourseName(courseId) {
    const c = COURSES.find(x => x.id === courseId);
    return c ? c.name : courseId;
}

function getWorkerRecordOnPlot(plotId, username = currentUser) {
    const owned = getOwnedPlotData(plotId);
    if (!owned) return { role: "Робітник зміни", personalWage: 10, orders: 0, clicks: 0, totalEarned: 0, profitBrought: 0, netMarginBrought: 0, taxPaidTotal: 0, completedCourses: [] };
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const bld = p ? getBuildingDef(p.zone, owned.building) : null;
    const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);
    const w = owned.workers && owned.workers[username] ? owned.workers[username] : null;
    const personalWage = w && Number(w.personalWage) > 0 ? Number(w.personalWage) : baseWage;
    const role = (w && w.role) ? w.role : "Робітник зміни";
    const orders = Number(w?.orders) || 0;
    const clicks = Number(w?.clicks) || 0;
    const totalEarned = Number(w?.totalEarned) || 0;
    const profitBrought = Number(w?.profitBrought) || 0;
    const netMarginBrought = w?.netMarginBrought !== undefined ? Number(w.netMarginBrought) : Math.max(0, profitBrought - totalEarned);
    const taxPaidTotal = Number(w?.taxPaidTotal) || 0;
    const lastWorkAt = Number(w?.lastWorkAt) || 0;
    const completedCourses = Array.isArray(w?.completedCourses)
        ? w.completedCourses
        : (username === currentUser ? gameState.completedCourses : []);
    return { role, personalWage, baseWage, orders, clicks, totalEarned, profitBrought, netMarginBrought, taxPaidTotal, lastWorkAt, completedCourses };
}

function triggerWorkCooldown(durationMs, reason) {
    workCooldownTotalMs = durationMs;
    workCooldownUntil = Date.now() + durationMs;
    workCooldownReason = reason;
    if (cooldownIntervalId) clearInterval(cooldownIntervalId);
    updateWorkButtonState();
    renderTask();
    cooldownIntervalId = setInterval(() => {
        if (Date.now() >= workCooldownUntil) {
            clearInterval(cooldownIntervalId);
            cooldownIntervalId = null;
            workCooldownUntil = 0;
            workCooldownReason = "";
            updateWorkButtonState();
            renderTask();
        } else {
            updateWorkButtonState();
            renderTask();
        }
    }, 100);
}

window.openMyBizCashboxQuick = function () {
    switchPage("work");
    switchWorkSubtab("mybiz");
};

window.switchWorkSubtab = function (sub) {
    activeWorkSubtab = sub;
    ["vacancies", "mybiz", "career"].forEach(k => {
        const btn = $("wtab-" + k);
        const box = $("work-sub-" + k);
        if (btn) btn.classList.toggle("active", k === sub);
        if (box) box.style.display = k === sub ? "block" : "none";
    });
    if (sub === "mybiz") renderOwnerBusinessesHub();
};

window.switchCourseCategory = function (cat) {
    activeCourseCategory = cat;
    ["it", "residential", "commercial", "industrial"].forEach(c => {
        const btn = $("ctab-" + c);
        if (btn) btn.classList.toggle("active", c === cat);
    });
    renderShop();
};

window.showDialog = (title, text, icon) => {
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-icon").textContent = icon || "ℹ️";
    $("dialog-overlay").classList.add("active");
};
window.closeDialog = () => $("dialog-overlay").classList.remove("active");

window.switchAuthTab = (tab) => {
    authMode = tab;
    $("tab-login").classList.toggle("active", tab === "login");
    $("tab-register").classList.toggle("active", tab === "register");
    $("confirm-row").style.display = tab === "register" ? "flex" : "none";
    $("auth-submit").textContent = tab === "login" ? "Увійти в систему" : "Зареєструватись";
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
                    activeCourseId: null, courseStartTime: 0, coursePaused: false, courseRemainingMs: 0,
                    bohdanDiscountUsedAt: 0,
                    completedCourses: [], xpBoost: 0,
                    lastRentAt: Date.now(),
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

async function startGame() {
    $("auth-window").style.display = "none";
    $("game-screen").classList.add("active");
    $("stat-user").textContent = currentUser;
    $("game-title").textContent = "Win98 SE Work — " + currentUser;

    const wipeBtn = $("admin-wipe-btn");
    if (wipeBtn) {
        wipeBtn.style.display = isAdminUser() ? "inline-block" : "none";
    }

    await loadGame();
    startPolicySync();
    startLiveSync();
    startMapSync();
    startMailSync();
    checkCourseCompletion();
    renderAll();
    switchPage("work");
    if (saveTimer) clearInterval(saveTimer);
    saveTimer = setInterval(saveGame, SAVE_INTERVAL_MS);
    startHeartbeat();
    startCourseTimer();
    startCreditTimer();
    setGameStatus("Ласкаво просимо у Windows 98 SE Work, " + currentUser + "!");
}

function startPolicySync() {
    if (policyListener) { policyListener(); policyListener = null; }
    policyListener = onValue(ref(db, "users/admin/clicker/cityPolicy"), snap => {
        if (snap.exists() && snap.val()) {
            const v = snap.val();
            cityTaxPolicy = {
                residential: { ...DEFAULT_CITY_TAX_POLICY.residential, ...(v.residential || {}) },
                commercial:  { ...DEFAULT_CITY_TAX_POLICY.commercial,  ...(v.commercial || {}) },
                industrial:  { ...DEFAULT_CITY_TAX_POLICY.industrial,  ...(v.industrial || {}) },
                updatedAt: Number(v.updatedAt) || 0,
                updatedBy: v.updatedBy || "Міська рада Ковеля"
            };
        } else {
            cityTaxPolicy = JSON.parse(JSON.stringify(DEFAULT_CITY_TAX_POLICY));
        }
        renderStats();
        renderPrivateJobsBoard();
        renderOwnerBusinessesHub();
        if (currentPage === "politics") renderPoliticsPage();
        if (selectedPlotId !== null) showMapInfo(selectedPlotId);
    });
}

// ===== ГЛОБАЛЬНИЙ ВАЙП СЕРВЕРА (ТІЛЬКИ ДЛЯ ГРАВЦЯ admin) =====
window.openAdminWipeModal = function () {
    if (!isAdminUser()) return;
    sfx.click();
    $("wipe-overlay").classList.add("active");
};

window.closeAdminWipeModal = function () {
    $("wipe-overlay").classList.remove("active");
};

window.executeAdminGlobalWipe = async function () {
    if (!isAdminUser()) {
        return showDialog("Доступ заборонено", "Ця функція доступна лише гравцю admin!", "🚫");
    }

    const btnProg = $("btn-confirm-wipe-progress");
    if (btnProg) btnProg.disabled = true;
    setGameStatus("☢️ Виконується глобальний вайп усіх гравців і мапи...");

    try {
        const plotIdsToWipe = new Set([
            ...MAP_PLOTS_BASE.map(p => String(p.id)),
            ...Object.keys(sharedPlots || {})
        ]);

        for (const pid of plotIdsToWipe) {
            try {
                await set(ref(db, `plots/${pid}`), null);
            } catch (errPlotNull) {
                try {
                    await update(ref(db, `plots/${pid}`), {
                        owner: "",
                        price: 0,
                        boughtAt: 0,
                        building: null,
                        treasury: 0,
                        wage: 0,
                        workers: null,
                        applicants: null,
                        wiped: true
                    });
                } catch (e2) {}
            }
        }

        const usersSnap = await get(child(ref(db), "users"));
        if (usersSnap.exists()) {
            const allUsers = usersSnap.val() || {};
            const now = Date.now();
            const freshClickerState = {
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
                coursePaused: false,
                courseRemainingMs: 0,
                bohdanDiscountUsedAt: 0,
                completedCourses: [],
                xpBoost: 0,
                lastRentAt: now,
                credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
                deposit: { amount: 0, lastInterestAt: now, totalEarned: 0 },
                mail: null,
                sentMail: null
            };

            for (const uname of Object.keys(allUsers)) {
                try {
                    await set(ref(db, `users/${uname}/clicker`), freshClickerState);
                } catch (errUser) {}
            }
        }

        miniGames.stop();
        workCooldownUntil = 0;
        selectedPlotId = null;
        sharedPlots = {};
        userInboxMail = {};
        userSentMail = {};
        markLocalCoinsChanged();
        gameState = {
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
            coursePaused: false,
            courseRemainingMs: 0,
            bohdanDiscountUsedAt: 0,
            completedCourses: [],
            xpBoost: 0,
            lastRentAt: Date.now(),
            credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
            deposit: { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 }
        };

        closeAdminWipeModal();
        closeMapInfo();
        sfx.win();
        renderAll();
        if (currentPage === "leaderboard") {
            loadLeaderboard();
            loadOnline();
        }
        setGameStatus("☢️ Глобальний вайп успішно завершено! Увесь прогрес скинуто до нуля.");
        showDialog(
            "Вайп виконано!",
            "Увесь прогрес усіх гравців (монети, депозити, кредити, курси, звання, пошта) та всі ділянки на мапі Ковеля повністю скинуті до початкового стану!",
            "☢️"
        );
    } catch (e) {
        showDialog("Помилка вайпу", e.message, "⚠️");
    } finally {
        if (btnProg) btnProg.disabled = false;
    }
};

function normalizeEmployerState(d) {
    const completed = Array.isArray(d.completedCourses) ? d.completedCourses : [];
    let emp = d.employer || "none";
    if (emp === "corp" && !hasCourse("basics", completed)) {
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
                privateJobIndex: 0,
                privateXp: Number(d.privateXp) || 0,
                employer: normalizeEmployerState(d),
                taskProgress: Number(d.taskProgress) || 0,
                taskActive: Boolean(d.taskActive),
                activeCourseId: d.activeCourseId || null,
                courseStartTime: Number(d.courseStartTime) || 0,
                coursePaused: Boolean(d.coursePaused),
                courseRemainingMs: Number(d.courseRemainingMs) || 0,
                bohdanDiscountUsedAt: Number(d.bohdanDiscountUsedAt) || 0,
                completedCourses: completed,
                xpBoost: Number(d.xpBoost) || 0,
                lastRentAt: Number(d.lastRentAt) || Date.now(),
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
        if (!isSaving && (Date.now() - lastLocalCoinChangeAt > 2500)) {
            gameState.coins = Number(d.coins) || 0;
        }
        gameState.jobIndex = Math.min(Number(d.jobIndex) || 0, JOBS.length - 1);
        gameState.xp = Number(d.xp) || 0;
        gameState.privateXp = Number(d.privateXp) || 0;
        gameState.completedCourses = Array.isArray(d.completedCourses) ? d.completedCourses : [];
        gameState.employer = normalizeEmployerState(d);
        if (!miniGames.isRunning() && workCooldownUntil <= Date.now()) {
            gameState.taskProgress = Number(d.taskProgress) || 0;
            gameState.taskActive = Boolean(d.taskActive);
        }
        gameState.activeCourseId = d.activeCourseId || null;
        gameState.courseStartTime = Number(d.courseStartTime) || 0;
        gameState.coursePaused = Boolean(d.coursePaused);
        gameState.courseRemainingMs = Number(d.courseRemainingMs) || 0;
        gameState.bohdanDiscountUsedAt = Number(d.bohdanDiscountUsedAt) || 0;
        gameState.xpBoost = Number(d.xpBoost) || 0;
        gameState.lastRentAt = Number(d.lastRentAt) || gameState.lastRentAt || Date.now();
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
            const pData = getOwnedPlotData(pid);
            if (!pData || !pData.building || !pData.workers || !pData.workers[currentUser]) {
                gameState.employer = "none";
            }
        }
        checkPassiveRentIncome();
        renderStats();
        renderEmployerBar();
        renderPrivateJobsBoard();
        renderOwnerBusinessesHub();
        renderJobsList();
        renderTask();
        renderMap();
        if (currentPage === "politics") renderPoliticsPage();
        if (selectedPlotId !== null) showMapInfo(selectedPlotId);
    });
}

async function checkPassiveRentIncome() {
    if (!currentUser || !sharedPlots) return;
    const now = Date.now();
    if (!gameState.lastRentAt) {
        gameState.lastRentAt = now;
        return;
    }

    const portfolio = getPlayerPortfolioHourlyBreakdown(currentUser);
    if (portfolio.plotsCount <= 0) {
        gameState.lastRentAt = now;
        return;
    }

    const elapsed = now - gameState.lastRentAt;
    if (elapsed < HOUR_MS) return;

    const hours = Math.min(48, Math.floor(elapsed / HOUR_MS));
    gameState.lastRentAt += hours * HOUR_MS;

    let totalAddedToCashboxes = 0;
    let totalEmptyLandTaxDeducted = 0;

    for (const p of MAP_PLOTS_BASE) {
        const owned = getOwnedPlotData(p.id);
        if (!owned || owned.owner !== currentUser) continue;

        const calc = calcPlotHourlyTaxAndNet(p, owned);
        const deltaForHours = calc.netIncome * hours;

        if (owned.building) {
            if (deltaForHours >= 0) {
                totalAddedToCashboxes += deltaForHours;
                try {
                    await runTransaction(ref(db, `plots/${p.id}/treasury`), cur => Math.max(0, (Number(cur) || 0) + deltaForHours));
                } catch (e) {}
            } else {
                const loss = Math.abs(deltaForHours);
                totalEmptyLandTaxDeducted += loss;
                gameState.coins = Math.max(0, gameState.coins - loss);
                markLocalCoinsChanged();
            }
        } else {
            const landTaxBill = calc.landTax * hours;
            totalEmptyLandTaxDeducted += landTaxBill;
            gameState.coins = Math.max(0, gameState.coins - landTaxBill);
            markLocalCoinsChanged();
        }
    }

    renderStats();
    renderOwnerBusinessesHub();
    if (currentPage === "bank") renderBank();
    if (currentPage === "politics") renderPoliticsPage();
    saveGame();

    if (totalAddedToCashboxes > 0 && totalEmptyLandTaxDeducted > 0) {
        setGameStatus(`🏛️ Погодинний звіт (${hours} год): у Каси бізнесів +${formatNumberFull(totalAddedToCashboxes)} 💰 (після податків), податок за пусту землю: -${formatNumberFull(totalEmptyLandTaxDeducted)} 💰`);
    } else if (totalAddedToCashboxes > 0) {
        setGameStatus(`🏦 Погодинний дохід бізнесів за ${hours} год (після сплати податків): +${formatNumberFull(totalAddedToCashboxes)} 💰 зараховано у ваші Каси!`);
    } else if (totalEmptyLandTaxDeducted > 0) {
        setGameStatus(`🏛️ Сплачено податок на незабудовану землю за ${hours} год: -${formatNumberFull(totalEmptyLandTaxDeducted)} 💰!`);
    }
}

function recalculateBoost() {
    let b = 0;
    gameState.completedCourses.forEach(id => {
        const c = COURSES.find(x => x.id === id);
        if (c && c.boost) b += c.boost;
    });
    gameState.xpBoost = b;
}

async function saveGame() {
    if (!currentUser) return;
    if (isSaving) {
        pendingSaveRequested = true;
        return;
    }
    isSaving = true;
    try {
        do {
            pendingSaveRequested = false;
            await update(ref(db, `users/${currentUser}/clicker`), {
                coins: gameState.coins,
                jobIndex: gameState.jobIndex,
                xp: gameState.xp,
                privateJobIndex: 0,
                privateXp: gameState.privateXp,
                employer: gameState.employer,
                taskProgress: gameState.taskProgress,
                taskActive: gameState.taskActive,
                activeCourseId: gameState.activeCourseId,
                courseStartTime: gameState.courseStartTime,
                coursePaused: Boolean(gameState.coursePaused),
                courseRemainingMs: Number(gameState.courseRemainingMs) || 0,
                bohdanDiscountUsedAt: Number(gameState.bohdanDiscountUsedAt) || 0,
                completedCourses: gameState.completedCourses,
                xpBoost: gameState.xpBoost,
                lastRentAt: gameState.lastRentAt || Date.now(),
                credit: gameState.credit,
                deposit: gameState.deposit
            });
        } while (pendingSaveRequested);

        const pid = getActiveEmployerPlotId();
        if (pid !== null && getOwnedPlotData(pid)?.workers?.[currentUser]) {
            await update(ref(db, `plots/${pid}/workers/${currentUser}`), {
                completedCourses: gameState.completedCourses
            });
        }
        const now = new Date();
        $("save-status").textContent = "💾 " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");
    } catch (e) { $("save-status").textContent = "⚠ Помилка"; }
    finally { isSaving = false; }
}

function getCurrentCorpJob() { return JOBS[gameState.jobIndex] || JOBS[0]; }

function getActiveEmployerPlotId() {
    if (!gameState.employer || !gameState.employer.startsWith("plot:")) return null;
    return Number(gameState.employer.split(":")[1]);
}

// ===== ВИМОГА 3: КУРС МОЖНА СТАВИТИ НА ПАУЗУ І ПРАЦЮВАТИ! =====
function hasActiveOrPausedCourse() {
    return Boolean(gameState.activeCourseId);
}

// Робота блокується ТІЛЬКИ тоді, коли курс іде активно і НЕ стоїть на паузі!
function isCourseRunning() {
    return Boolean(gameState.activeCourseId && !gameState.coursePaused);
}

function getRemainingCourseMs() {
    if (!gameState.activeCourseId) return 0;
    const c = COURSES.find(x => x.id === gameState.activeCourseId);
    if (!c) return 0;
    const baseDur = Number(gameState.courseRemainingMs) > 0 ? Number(gameState.courseRemainingMs) : c.durationMs;
    if (gameState.coursePaused) {
        return Math.max(0, baseDur);
    }
    return Math.max(0, baseDur - (Date.now() - (Number(gameState.courseStartTime) || Date.now())));
}

window.toggleCoursePause = async function () {
    if (!gameState.activeCourseId) return;
    const c = COURSES.find(x => x.id === gameState.activeCourseId);
    sfx.click();

    if (!gameState.coursePaused) {
        // Ставимо курс на паузу: зберігаємо точний залишок часу і відкриваємо роботу!
        const rem = getRemainingCourseMs();
        gameState.courseRemainingMs = Math.max(1000, rem);
        gameState.coursePaused = true;
        gameState.courseStartTime = 0;
        renderAll();
        await saveGame();
        setGameStatus(`⏸️ Курс «${c ? c.name : ""}» поставлено на паузу (залишилось ${formatDuration(gameState.courseRemainingMs)}). Тепер ви можете працювати!`);
    } else {
        // Знімаємо курс із паузи: продовжуємо навчання з тієї ж секунди!
        miniGames.stop();
        gameState.taskActive = false;
        gameState.taskProgress = 0;
        if (!gameState.courseRemainingMs || gameState.courseRemainingMs <= 0) {
            gameState.courseRemainingMs = c ? c.durationMs : 900000;
        }
        gameState.coursePaused = false;
        gameState.courseStartTime = Date.now();
        renderAll();
        startCourseTimer();
        await saveGame();
        setGameStatus(`▶️ Навчання на курсі «${c ? c.name : ""}» продовжено!`);
    }
};

function checkCourseCompletion() {
    if (!gameState.activeCourseId || gameState.coursePaused) return;
    if (getRemainingCourseMs() <= 0) {
        const c = COURSES.find(x => x.id === gameState.activeCourseId);
        if (c && !gameState.completedCourses.includes(c.id)) {
            gameState.completedCourses.push(c.id);
            recalculateBoost();
        }
        gameState.activeCourseId = null;
        gameState.courseStartTime = 0;
        gameState.coursePaused = false;
        gameState.courseRemainingMs = 0;
        setGameStatus("Курс завершено!");
        let bonusDesc = "";
        if (c?.category === "it") {
            bonusDesc = `+${c.boost}% IT-XP та доступ до посад у КовельКорп!`;
        } else if (c?.category === "residential") {
            bonusDesc = `+${c.zoneBoost}% до чека замовлення у Житловій зоні!`;
        } else if (c?.category === "commercial") {
            bonusDesc = `+${c.zoneBoost}% до чека замовлення у Комерційній зоні!`;
        } else {
            bonusDesc = `+${c?.zoneBoost || 0}% до чека замовлення у Промисловій зоні!`;
        }
        showDialog("Диплом отримано!", `🎓 ${c ? c.name : "Курс"}\n${bonusDesc}`, "🎓");
        saveGame();
    }
}

window.joinKovelCorp = async function () {
    if (!hasCourse("basics")) {
        return showDialog(
            "Потрібен ІТ-диплом!",
            "Ніхто не працює в КовельКорп зі старту гри!\nЩоб влаштуватися в IT-корпорацію «КовельКорп», пройдіть курс «Основи програмування» (або будь-який дорожчий курс програмування) у вкладці «🎓 Курси».",
            "🎓"
        );
    }
    const prevPlotId = getActiveEmployerPlotId();
    if (prevPlotId !== null) {
        try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
    }
    miniGames.stop();
    workCooldownUntil = 0;
    gameState.employer = "corp";
    gameState.taskActive = false;
    gameState.taskProgress = 0;
    sfx.win();
    renderAll();
    saveGame();
    setGameStatus("Ви влаштувались у КовельКорп!");
};

// ===== ПОШТА OUTLOOK EXPRESS 98 (ІЗ ВИДАЛЕННЯМ ПОВІДОМЛЕНЬ ДЛЯ ДВОХ СТОРІН!) =====

window.openResumeModal = function (plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || !owned.building) {
        return showDialog("Недоступно", "На цій ділянці ще немає збудованого підприємства.", "⚠️");
    }

    if (getActiveEmployerPlotId() === plotId || (owned.workers && owned.workers[currentUser])) {
        return showDialog("Ви вже тут працюєте!", "Ви вже працевлаштовані на цьому підприємстві.", "👷");
    }
    const existingForOwner = getExistingEmploymentForOwner(currentUser, owned.owner);
    if (existingForOwner) {
        return showDialog(
            "Ви вже працюєте на цього власника!",
            `Ви вже працевлаштовані у власника «${owned.owner}» на підприємстві «${existingForOwner.buildingName}» (${existingForOwner.plotName}). Спочатку звільніться, якщо хочете перейти на іншу його точку.`,
            "👷"
        );
    }

    resumeTargetPlotId = plotId;
    const bld = getBuildingDef(p.zone, owned.building);
    const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);
    const fin = calcOrderFinancials(p.zone, bld, gameState.completedCourses, baseWage);
    const zInfo = ZONE_INFO[p.zone] || ZONE_INFO.residential;

    $("resume-target-info").innerHTML = `
        <div><b>Підприємство:</b> ${bld ? bld.icon + " " + escapeHtml(bld.name) : escapeHtml(p.name)} (${escapeHtml(p.name)})</div>
        <div><b>Координати GPS:</b> <span class="coord-badge">${formatPlotCoords(p)}</span></div>
        <div><b>Зона:</b> ${escapeHtml(zInfo.name)} • <b>Власник:</b> <span style="color:#000080;font-weight:bold">${escapeHtml(owned.owner)}</span></div>
        <div style="margin-top:4px;padding:4px 6px;background:#ffffff;border:1px solid #808080">
            <b>Економіка 1 вашого замовлення для власника:</b><br>
            • Чек клієнта з вашими курсами (+${fin.skillBonusPct}%): <b>+${fin.grossCheck} 💰</b><br>
            • Податок зони (${fin.turnoverTaxPct}%): <b style="color:#800000">-${fin.taxAmount} 💰</b> (залишається <b>${fin.afterTaxRevenue} 💰</b>)<br>
            • Базова ЗП на об'єкті: <b style="color:#006400">${baseWage} 💰</b> (власнику в касу: <b>${fin.ownerNetMargin >= 0 ? "+" + fin.ownerNetMargin : fin.ownerNetMargin} 💰</b>)
        </div>
        <div style="margin-top:4px"><b>Ваші дипломи у резюме:</b><br>${renderCourseChipsHtml(gameState.completedCourses, p.zone)}</div>
    `;
    $("resume-desired-wage").value = baseWage;
    $("resume-note-input").value = `Вітаю! Прошу прийняти мене на роботу у «${bld ? bld.name : p.name}». Чек мого замовлення з курсами: ${fin.grossCheck} 💰 (+${fin.skillBonusPct}%).`;
    $("resume-overlay").classList.add("active");
};

window.closeResumeModal = function () {
    resumeTargetPlotId = null;
    $("resume-overlay").classList.remove("active");
};

window.submitResumeApplication = async function () {
    if (resumeTargetPlotId === null || !currentUser) return;
    const plotId = resumeTargetPlotId;
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || !owned.building) {
        closeResumeModal();
        return;
    }

    if (owned.workers && owned.workers[currentUser]) {
        closeResumeModal();
        return showDialog("Ви вже тут працюєте", "Ви вже є працівником цього підприємства!", "👷");
    }

    const bld = getBuildingDef(p.zone, owned.building);
    const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);
    const desiredWage = Math.max(5, Math.min(50000, Math.floor(Number($("resume-desired-wage").value) || baseWage)));
    const note = ($("resume-note-input").value || "").trim() || "Хочу працювати на вашому підприємстві!";
    const zoneBonus = getWorkerZoneSkillBonusPct(gameState.completedCourses, p.zone);

    const mailPayload = {
        type: "resume",
        from: currentUser,
        to: owned.owner,
        plotId: plotId,
        plotName: p.name,
        plotCoords: formatPlotCoords(p),
        plotZone: p.zone,
        buildingName: bld ? `${bld.icon} ${bld.name}` : p.name,
        desiredWage: desiredWage,
        completedCourses: gameState.completedCourses || [],
        zoneBonusPct: zoneBonus,
        subject: `📋 Резюме на роботу: ${bld ? bld.name : p.name} (${p.name})`,
        body: note,
        status: "pending",
        unread: true,
        createdAt: Date.now()
    };

    try {
        const newMailRef = push(ref(db, `users/${owned.owner}/clicker/mail`));
        mailPayload.id = newMailRef.key;
        await set(newMailRef, mailPayload);
        await set(ref(db, `users/${currentUser}/clicker/sentMail/${newMailRef.key}`), mailPayload);
        await set(ref(db, `plots/${plotId}/applicants/${currentUser}`), {
            desiredWage,
            zoneBonusPct: zoneBonus,
            appliedAt: Date.now(),
            mailId: newMailRef.key
        });

        closeResumeModal();
        sfx.good();
        setGameStatus(`📨 Резюме надіслано власнику ${owned.owner} на Пошту!`);
        showDialog(
            "Резюме надіслано!",
            `Ваше резюме доставлено на пошту власнику «${owned.owner}».\n\nКоли власник перегляне ваші курси та натисне «✅ Прийняти на роботу» у своїй Пошті — ви автоматично станете працівником підприємства й отримаєте повідомлення!`,
            "📨"
        );
    } catch (e) {
        showDialog("Помилка", "Не вдалося надіслати резюме: " + e.message, "⚠️");
    }
};

function startMailSync() {
    if (mailInboxListener) { mailInboxListener(); mailInboxListener = null; }
    if (mailSentListener) { mailSentListener(); mailSentListener = null; }
    if (!currentUser) return;

    mailInboxListener = onValue(ref(db, `users/${currentUser}/clicker/mail`), snap => {
        userInboxMail = snap.exists() ? snap.val() : {};
        updateMailBadges();
        if (currentPage === "mail") renderMailPage();
    });

    mailSentListener = onValue(ref(db, `users/${currentUser}/clicker/sentMail`), snap => {
        userSentMail = snap.exists() ? snap.val() : {};
        if (currentPage === "mail" && (activeMailSubtab === "sent" || activeMailSubtab === "history")) renderMailPage();
    });
}

function updateMailBadges() {
    const items = Object.values(userInboxMail || {});
    const unreadAll = items.filter(m => m && m.unread).length;
    const pendingResumes = items.filter(m => m && m.type === "resume" && m.status === "pending").length;

    const tabBadge = $("tab-mail-badge");
    if (tabBadge) {
        if (unreadAll > 0) {
            tabBadge.style.display = "inline-block";
            tabBadge.textContent = unreadAll;
        } else {
            tabBadge.style.display = "none";
        }
    }

    const hudBtn = $("hud-mail-btn");
    const hudCnt = $("hud-mail-cnt");
    if (hudCnt) hudCnt.textContent = unreadAll;
    if (hudBtn) hudBtn.classList.toggle("has-unread", unreadAll > 0);

    if ($("badge-mail-all")) $("badge-mail-all").textContent = items.length;
    if ($("badge-mail-resumes")) $("badge-mail-resumes").textContent = pendingResumes;

    if (unreadAll > lastUnreadMailCount) {
        sfx.good();
    }
    lastUnreadMailCount = unreadAll;
}

window.switchMailSubtab = async function (sub) {
    activeMailSubtab = sub;
    ["inbox", "resumes", "history", "sent", "compose"].forEach(k => {
        const btn = $("mtab-" + k);
        if (btn) btn.classList.toggle("active", k === sub);
    });

    const listBox = $("mail-list-container");
    const historyBox = $("mail-history-container");
    const composeBox = $("mail-compose-container");

    if (sub === "compose") {
        if (listBox) listBox.style.display = "none";
        if (historyBox) historyBox.style.display = "none";
        if (composeBox) composeBox.style.display = "block";
        populatePlayersSelectForMail();
        populateJobOfferPlotsSelect();
    } else if (sub === "history") {
        if (listBox) listBox.style.display = "none";
        if (historyBox) historyBox.style.display = "flex";
        if (composeBox) composeBox.style.display = "none";
        renderMailHistoryView();
    } else {
        if (listBox) listBox.style.display = "flex";
        if (historyBox) historyBox.style.display = "none";
        if (composeBox) composeBox.style.display = "none";
        renderMailPage();
    }
};

window.openComposeMail = function (toUser = "", subject = "", preselectPlotId = null) {
    switchPage("mail");
    switchMailSubtab("compose");
    if (toUser) $("mail-to-input").value = toUser;
    if (subject) $("mail-subj-input").value = subject;
    if ($("mail-coins-input")) $("mail-coins-input").value = "";
    populateJobOfferPlotsSelect(preselectPlotId);
    $("mail-body-input").focus();
};

window.openJobInviteMail = function (plotId, toUser = "") {
    if (plotId === null || plotId === undefined) return;
    if (toUser) {
        const existing = getExistingEmploymentForOwner(toUser, currentUser);
        if (existing) {
            return showDialog(
                "Вже працює на вас!",
                `Гравець «${existing.workerName}» вже працює на вашому підприємстві «${existing.buildingName}» (${existing.plotName}).\nНе можна просити влаштуватись на роботу людину, яка вже працює на вас!`,
                "👷"
            );
        }
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === Number(plotId));
    const owned = getOwnedPlotData(Number(plotId));
    const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
    const wage = Number(owned?.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);
    openComposeMail(
        toUser,
        `📍 Запрошення на роботу: ${bld ? bld.name : (p ? p.name : "Підприємство")}`,
        Number(plotId)
    );
    $("mail-body-input").value = `Привіт! Запрошую тебе працювати на підприємство «${bld ? bld.name : p?.name}» (${p?.name}, координати ${formatPlotCoords(p)}). Ставка: +${wage} 💰 за замовлення!`;
};

function populateJobOfferPlotsSelect(preselectPlotId = null) {
    const sel = $("mail-job-plot-select");
    if (!sel) return;

    const options = [`<option value="">— Не прикріплювати координати роботи —</option>`];
    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.building && owned.owner === currentUser) {
            const bld = getBuildingDef(p.zone, owned.building);
            const selAttr = (preselectPlotId !== null && Number(preselectPlotId) === p.id) ? " selected" : "";
            options.push(
                `<option value="${p.id}"${selAttr}>⭐ #${p.id + 1} ${escapeHtml(p.name)} — ${bld ? bld.icon + " " + escapeHtml(bld.name) : ""} (${formatPlotCoords(p)})</option>`
            );
        }
    });
    sel.innerHTML = options.join("");
    onMailJobPlotChange();
}

window.onMailJobPlotChange = function () {
    const sel = $("mail-job-plot-select");
    const wageRow = $("mail-job-wage-row");
    const wageInp = $("mail-job-wage-input");
    if (!sel || !wageRow) return;
    const pid = sel.value !== "" ? Number(sel.value) : null;
    if (pid === null || isNaN(pid)) {
        wageRow.style.display = "none";
        return;
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === pid);
    const owned = getOwnedPlotData(pid);
    const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
    const wage = Number(owned?.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);
    wageRow.style.display = "flex";
    if (wageInp) wageInp.value = wage;
};

async function populatePlayersSelectForMail() {
    const sel = $("mail-to-select");
    if (!sel) return;
    try {
        const snap = await get(child(ref(db), "users"));
        if (!snap.exists()) return;
        const names = Object.keys(snap.val()).filter(n => n !== currentUser).sort();
        sel.innerHTML = `<option value="">▼ Оберіть гравця (${names.length})</option>` +
            names.map(n => {
                const alreadyWorks = getExistingEmploymentForOwner(n, currentUser);
                const suffix = alreadyWorks ? ` (👷 вже працює у вас)` : "";
                return `<option value="${escapeHtml(n)}">${escapeHtml(n)}${suffix}</option>`;
            }).join("");
    } catch (e) {}
}

window.sendPersonalMail = async function () {
    const to = ($("mail-to-input").value || "").trim();
    const subj = ($("mail-subj-input").value || "").trim() || "Повідомлення";
    const body = ($("mail-body-input").value || "").trim();
    const attachedCoins = Math.max(0, Math.floor(Number($("mail-coins-input")?.value) || 0));
    const jobPlotVal = $("mail-job-plot-select")?.value || "";
    const offerPlotId = jobPlotVal !== "" ? Number(jobPlotVal) : null;
    const offeredWage = offerPlotId !== null
        ? Math.max(5, Math.min(50000, Math.floor(Number($("mail-job-wage-input")?.value) || 15)))
        : 0;

    if (!to) return showDialog("Вкажіть отримувача", "Введіть логін гравця, якому хочете написати листа.", "⚠️");
    if (to.toLowerCase() === currentUser.toLowerCase() && (attachedCoins > 0 || offerPlotId !== null)) {
        return showDialog("Помилка", "Не можна пересилати гроші або запрошення на роботу самому собі.", "⚠️");
    }
    if (!body && attachedCoins <= 0 && offerPlotId === null) {
        return showDialog("Порожній лист", "Напишіть текст повідомлення, додайте переказ монет або координати роботи.", "⚠️");
    }

    if (offerPlotId !== null) {
        const existingEmp = getExistingEmploymentForOwner(to, currentUser);
        if (existingEmp) {
            return showDialog(
                "Ця людина вже працює на вас!",
                `Гравець «${existingEmp.workerName}» вже працевлаштований на вашому підприємстві «${existingEmp.buildingName}» (${existingEmp.plotName}).\n\nНе можна просити влаштовуватись на роботу людину, яка вже працює на вас!`,
                "👷"
            );
        }
        const targetPlotOwned = getOwnedPlotData(offerPlotId);
        if (targetPlotOwned && targetPlotOwned.workers && targetPlotOwned.workers[to]) {
            return showDialog(
                "Вже працює тут!",
                `Гравець «${to}» вже працює на цьому підприємстві!`,
                "👷"
            );
        }
    }

    if (attachedCoins > 0) {
        if (isBankBlocked()) {
            return showDialog("Покупки та перекази заблоковано!", "У вас прострочений кредит у банку. Спочатку погасіть борг, щоб пересилати гроші!", "🚫");
        }
        if (gameState.coins < attachedCoins) {
            return showDialog("Недостатньо монет", `У вашому гаманці лише ${formatNumberFull(gameState.coins)} 💰.`, "💸");
        }
    }

    try {
        const userSnap = await get(child(ref(db), `users/${to}`));
        if (!userSnap.exists()) {
            return showDialog("Гравця не знайдено", `Користувача з логіном «${to}» не існує в базі Ковеля.`, "⚠️");
        }

        if (offerPlotId !== null) {
            const targetEmp = userSnap.val()?.clicker?.employer || "none";
            if (String(targetEmp).startsWith("plot:")) {
                const tPid = Number(String(targetEmp).split(":")[1]);
                const tOwned = getOwnedPlotData(tPid);
                if (tPid === offerPlotId || (tOwned && tOwned.owner === currentUser)) {
                    return showDialog(
                        "Вже працює на вас!",
                        `Гравець «${to}» вже працює на вашому підприємстві! Не можна повторно кликати на роботу своїх працівників.`,
                        "👷"
                    );
                }
            }
        }

        let jobOfferMeta = null;
        if (offerPlotId !== null) {
            const p = MAP_PLOTS_BASE.find(x => x.id === offerPlotId);
            const owned = getOwnedPlotData(offerPlotId);
            const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
            if (p && owned && bld) {
                jobOfferMeta = {
                    plotId: p.id,
                    plotName: p.name,
                    plotZone: p.zone,
                    coords: formatPlotCoords(p),
                    lat: p.lat,
                    lng: p.lng,
                    buildingName: `${bld.icon} ${bld.name}`,
                    owner: owned.owner,
                    offeredWage: offeredWage
                };
            }
        }

        if (attachedCoins > 0) {
            gameState.coins = Math.max(0, gameState.coins - attachedCoins);
            markLocalCoinsChanged();
            renderStats();
        }

        const newRef = push(ref(db, `users/${to}/clicker/mail`));
        const msgData = {
            id: newRef.key,
            type: jobOfferMeta ? "job_offer" : "personal",
            from: currentUser,
            to: to,
            subject: subj,
            body: body || (jobOfferMeta ? `Запрошую на роботу у ${jobOfferMeta.buildingName} (${jobOfferMeta.plotName})!` : `Грошовий переказ: +${attachedCoins} 💰`),
            attachedCoins: attachedCoins,
            coinsClaimed: false,
            jobOffer: jobOfferMeta,
            unread: true,
            createdAt: Date.now()
        };

        await update(ref(db, `users/${currentUser}/clicker`), {
            coins: gameState.coins,
            [`sentMail/${newRef.key}`]: msgData
        });

        await set(newRef, msgData);

        $("mail-subj-input").value = "";
        $("mail-body-input").value = "";
        if ($("mail-coins-input")) $("mail-coins-input").value = "";
        if ($("mail-job-plot-select")) {
            $("mail-job-plot-select").value = "";
            onMailJobPlotChange();
        }

        sfx.good();
        renderAll();
        activeHistoryContact = to;
        switchMailSubtab("history");
        const coinNote = attachedCoins > 0 ? ` (списано -${formatNumberFull(attachedCoins)} 💰 з вашого гаманця)` : "";
        setGameStatus(`📨 Листа для ${to} успішно надіслано!${coinNote}`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.claimMailCoins = async function (mailId) {
    const mail = userInboxMail[mailId];
    if (!mail || !mail.attachedCoins || mail.coinsClaimed) return;
    const amt = Math.max(0, Math.floor(Number(mail.attachedCoins) || 0));
    if (amt <= 0) return;

    try {
        mail.coinsClaimed = true;
        gameState.coins += amt;
        markLocalCoinsChanged();

        await update(ref(db, `users/${currentUser}/clicker`), {
            coins: gameState.coins,
            [`mail/${mailId}/coinsClaimed`]: true,
            [`mail/${mailId}/unread`]: false
        });

        if (mail.from) {
            try {
                await update(ref(db, `users/${mail.from}/clicker/sentMail/${mailId}`), {
                    coinsClaimed: true
                });
            } catch (e2) {}
        }
        sfx.win();
        renderAll();
        setGameStatus(`💰 Отримано переказ +${formatNumberFull(amt)} 💰 від гравця ${mail.from}!`);
        showDialog("Переказ отримано!", `Ви забрали +${formatNumberFull(amt)} 💰 від гравця «${mail.from}» у свій гаманець!`, "💰");
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.focusPlotFromMail = function (plotId) {
    const pid = Number(plotId);
    const p = MAP_PLOTS_BASE.find(x => x.id === pid);
    if (!p) return;
    switchPage("map");
    setTimeout(() => {
        if (!leafletMap) initKovelMap();
        if (leafletMap) {
            leafletMap.invalidateSize();
            leafletMap.setView([p.lat, p.lng], 16);
        }
        selectPlot(pid);
        setGameStatus(`📍 Навігатор Ковеля: ділянка #${pid + 1} «${p.name}» (${formatPlotCoords(p)})`);
    }, 100);
};

window.acceptJobOfferFromMail = async function (mailId) {
    const mail = userInboxMail[mailId];
    if (!mail || !mail.jobOffer) return;
    const offer = mail.jobOffer;
    const plotId = Number(offer.plotId);
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || !owned.building) {
        return showDialog("Недоступно", "Це підприємство більше не існує на мапі.", "⚠️");
    }

    if (getActiveEmployerPlotId() === plotId || (owned.workers && owned.workers[currentUser])) {
        return showDialog("Ви вже тут працюєте!", "Ви вже працевлаштовані на цьому підприємстві.", "👷");
    }

    if (owned.owner === mail.from) {
        try {
            const prevPlotId = getActiveEmployerPlotId();
            if (prevPlotId !== null && prevPlotId !== plotId) {
                try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
            }

            const wage = Math.max(5, Number(offer.offeredWage) || Number(owned.wage) || 15);
            await update(ref(db, `plots/${plotId}/workers/${currentUser}`), {
                role: "Робітник зміни",
                personalWage: wage,
                completedCourses: gameState.completedCourses || [],
                orders: Number(owned.workers?.[currentUser]?.orders) || 0,
                clicks: Number(owned.workers?.[currentUser]?.clicks) || 0,
                totalEarned: Number(owned.workers?.[currentUser]?.totalEarned) || 0,
                profitBrought: Number(owned.workers?.[currentUser]?.profitBrought) || 0,
                netMarginBrought: Number(owned.workers?.[currentUser]?.netMarginBrought) || 0,
                taxPaidTotal: Number(owned.workers?.[currentUser]?.taxPaidTotal) || 0,
                joinedAt: Date.now(),
                lastWorkAt: Date.now()
            });

            await update(ref(db, `users/${currentUser}/clicker/mail/${mailId}`), {
                offerAccepted: true,
                unread: false
            });

            miniGames.stop();
            workCooldownUntil = 0;
            gameState.employer = "plot:" + plotId;
            gameState.taskActive = false;
            gameState.taskProgress = 0;

            sfx.win();
            renderAll();
            await saveGame();
            switchPage("work");
            showDialog(
                "Пропозицію прийнято!",
                `Ви влаштувались у «${offer.buildingName}» (${offer.plotName}, GPS: ${offer.coords}) за запрошенням власника ${owned.owner}!\nВаша зарплата: +${formatNumberFull(wage)} 💰 за замовлення.`,
                "🎉"
            );
        } catch (e) {
            showDialog("Помилка", e.message, "⚠️");
        }
    } else {
        openResumeModal(plotId);
    }
};

// ===== ІСТОРІЯ ПЕРЕПИСКИ (ДІАЛОГИ МІЖ ГРАВЦЯМИ) =====
window.openConversationHistory = function (otherUser) {
    if (!otherUser) return;
    activeHistoryContact = otherUser;
    switchPage("mail");
    switchMailSubtab("history");
};

window.openComposeWithActiveContact = function () {
    openComposeMail(activeHistoryContact, "Повідомлення");
};

window.sendQuickHistoryReply = async function () {
    if (!activeHistoryContact) return;
    const inp = $("history-quick-reply-input");
    const text = (inp?.value || "").trim();
    if (!text) return;
    inp.value = "";

    const msgData = {
        type: "personal",
        from: currentUser,
        to: activeHistoryContact,
        subject: "Повідомлення в діалозі",
        body: text,
        attachedCoins: 0,
        coinsClaimed: false,
        unread: true,
        createdAt: Date.now()
    };

    try {
        const newRef = push(ref(db, `users/${activeHistoryContact}/clicker/mail`));
        msgData.id = newRef.key;
        await set(newRef, msgData);
        await set(ref(db, `users/${currentUser}/clicker/sentMail/${newRef.key}`), msgData);
        sfx.good();
        renderMailHistoryView();
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

function renderMailHistoryView() {
    const contactsBar = $("mail-history-contacts");
    const logEl = $("mail-history-log");
    const replyBar = $("mail-history-reply-bar");
    if (!contactsBar || !logEl) return;

    const contactsSet = new Set();
    Object.values(userInboxMail || {}).forEach(m => { if (m && m.from && m.from !== currentUser) contactsSet.add(m.from); });
    Object.values(userSentMail || {}).forEach(m => { if (m && m.to && m.to !== currentUser) contactsSet.add(m.to); });

    const contacts = Array.from(contactsSet).sort();

    if (!contacts.length) {
        contactsBar.innerHTML = `<span class="muted">Немає активних діалогів</span>`;
        logEl.innerHTML = `<div class="muted" style="text-align:center;padding:20px">Ви ще ні з ким не листувалися. Натисніть «✍️ Новий лист», щоб почати переписку!</div>`;
        if (replyBar) replyBar.style.display = "none";
        return;
    }

    if (!activeHistoryContact || !contacts.includes(activeHistoryContact)) {
        activeHistoryContact = contacts[0];
    }

    contactsBar.innerHTML = contacts.map(c =>
        `<button class="mail-contact-pill${c === activeHistoryContact ? " active" : ""}" onclick="openConversationHistory('${escapeHtml(c)}')">👤 ${escapeHtml(c)}</button>`
    ).join("");

    if (replyBar) replyBar.style.display = "flex";

    const thread = [];
    Object.entries(userInboxMail || {}).forEach(([id, m]) => {
        if (m && m.from === activeHistoryContact) {
            thread.push({ ...m, id, dir: "in" });
            if (m.unread) markMailRead(id);
        }
    });
    Object.entries(userSentMail || {}).forEach(([id, m]) => {
        if (m && m.to === activeHistoryContact) {
            thread.push({ ...m, id, dir: "out" });
        }
    });

    thread.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    logEl.innerHTML = thread.map(m => {
        const isOut = m.dir === "out";
        const senderLabel = isOut ? `Ви → ${m.to}` : `${m.from} → Вам`;
        let extraHtml = "";

        if (Number(m.attachedCoins) > 0) {
            extraHtml += `
                <div class="mail-attachment-box money-box" style="margin-top:4px">
                    <div>💸 <b>Переказ монет: +${formatNumberFull(m.attachedCoins)} 💰</b></div>
                    ${(!isOut && !m.coinsClaimed)
                        ? `<button class="btn success" onclick="claimMailCoins('${m.id}')" style="min-height:26px;padding:2px 8px;font-size:11px">📥 Забрати гроші в гаманець</button>`
                        : `<span style="color:#006400;font-weight:bold">${m.coinsClaimed ? "✓ Отримано" : "Надіслано"}</span>`
                    }
                </div>
            `;
        }

        if (m.jobOffer) {
            const jo = m.jobOffer;
            extraHtml += `
                <div class="mail-attachment-box job-offer-box" style="margin-top:4px">
                    <div>📍 <b>Пропозиція роботи:</b> ${escapeHtml(jo.buildingName)} (${escapeHtml(jo.plotName)})</div>
                    <div>Координати місця: <span class="coord-badge">${escapeHtml(jo.coords || "")}</span> • ЗП: <b>+${formatNumberFull(jo.offeredWage)} 💰/замовл.</b></div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:2px">
                        <button class="btn" onclick="focusPlotFromMail(${jo.plotId})" style="min-height:24px;min-width:auto;padding:2px 7px;font-size:11px">🗺️ Показати на мапі</button>
                        ${(!isOut && !m.offerAccepted)
                            ? `<button class="btn success" onclick="acceptJobOfferFromMail('${m.id}')" style="min-height:24px;min-width:auto;padding:2px 7px;font-size:11px">✅ Прийняти роботу</button>`
                            : (m.offerAccepted ? `<span style="color:#006400;font-weight:bold">✓ Прийнято</span>` : "")
                        }
                    </div>
                </div>
            `;
        }

        if (m.type === "resume") {
            extraHtml += `<div style="font-size:11px;color:#000080;margin-top:3px">📋 Резюме на «${escapeHtml(m.buildingName || "")}» (бажана ЗП: ${formatNumberFull(m.desiredWage || 15)} 💰)</div>`;
        }

        return `
            <div class="history-bubble ${isOut ? "outgoing" : "incoming"}">
                <div class="history-meta">
                    <b>${escapeHtml(senderLabel)}</b>
                    <span style="display:flex;align-items:center;gap:6px">
                        <span>${formatTimeAgo(m.createdAt)}</span>
                        <button class="btn danger" onclick="deleteMailItem('${m.id}', ${isOut}, '${escapeHtml(activeHistoryContact)}')" style="min-height:18px;min-width:auto;padding:0 5px;font-size:10px" title="Видалити повідомлення для обох сторін">🗑️</button>
                    </span>
                </div>
                <div style="font-weight:bold;margin-bottom:2px">${escapeHtml(m.subject || "")}</div>
                <div style="white-space:pre-line">${escapeHtml(m.body || "")}</div>
                ${extraHtml}
            </div>
        `;
    }).join("");

    logEl.scrollTop = logEl.scrollHeight;
}

window.acceptResume = async function (mailId) {
    const mail = userInboxMail[mailId];
    if (!mail || mail.type !== "resume") return;

    const plotId = Number(mail.plotId);
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || owned.owner !== currentUser || !owned.building) {
        return showDialog("Помилка", "Ви більше не є власником цього підприємства.", "⚠️");
    }

    const applicant = mail.from;
    const wageInput = $("approve_wage_" + mailId);
    const approvedWage = Math.max(5, Math.min(50000, Math.floor(Number(wageInput?.value) || mail.desiredWage || 15)));
    const applicantCourses = Array.isArray(mail.completedCourses) ? mail.completedCourses : [];

    try {
        const empSnap = await get(child(ref(db), `users/${applicant}/clicker/employer`));
        const oldEmp = empSnap.exists() ? empSnap.val() : "none";
        if (oldEmp && String(oldEmp).startsWith("plot:")) {
            const oldPid = Number(String(oldEmp).split(":")[1]);
            if (oldPid !== plotId) {
                try { await set(ref(db, `plots/${oldPid}/workers/${applicant}`), null); } catch (e) {}
            }
        }

        await update(ref(db, `plots/${plotId}/workers/${applicant}`), {
            role: "Робітник зміни",
            personalWage: approvedWage,
            completedCourses: applicantCourses,
            orders: Number(owned.workers?.[applicant]?.orders) || 0,
            clicks: Number(owned.workers?.[applicant]?.clicks) || 0,
            totalEarned: Number(owned.workers?.[applicant]?.totalEarned) || 0,
            profitBrought: Number(owned.workers?.[applicant]?.profitBrought) || 0,
            netMarginBrought: Number(owned.workers?.[applicant]?.netMarginBrought) || 0,
            taxPaidTotal: Number(owned.workers?.[applicant]?.taxPaidTotal) || 0,
            joinedAt: Date.now(),
            lastWorkAt: Date.now()
        });

        await set(ref(db, `plots/${plotId}/applicants/${applicant}`), null);

        await update(ref(db, `users/${applicant}/clicker`), {
            employer: "plot:" + plotId,
            taskActive: false,
            taskProgress: 0
        });

        await update(ref(db, `users/${currentUser}/clicker/mail/${mailId}`), {
            status: "accepted",
            unread: false,
            approvedWage: approvedWage
        });

        const replyData = {
            type: "system",
            from: currentUser,
            to: applicant,
            subject: `🎉 Ваше резюме прийнято! (${mail.buildingName})`,
            body: `Вітаємо! Власник ${currentUser} розглянув ваше резюме та прийняв вас на роботу у «${mail.buildingName}» (${mail.plotName}).\nВаша затверджена зарплата: +${formatNumberFull(approvedWage)} 💰 за виконане замовлення! Перейдіть у вкладку «💼 Робота і Бізнес», щоб розпочати зміну.`,
            unread: true,
            createdAt: Date.now()
        };
        const replyRef = push(ref(db, `users/${applicant}/clicker/mail`));
        replyData.id = replyRef.key;
        await set(replyRef, replyData);
        await set(ref(db, `users/${currentUser}/clicker/sentMail/${replyRef.key}`), replyData);

        sfx.win();
        setGameStatus(`✅ Гравець ${applicant} прийнятий на роботу у «${mail.buildingName}» (ЗП: ${approvedWage} 💰)!`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.rejectResume = async function (mailId) {
    const mail = userInboxMail[mailId];
    if (!mail || mail.type !== "resume") return;
    const plotId = Number(mail.plotId);
    const applicant = mail.from;

    try {
        await update(ref(db, `users/${currentUser}/clicker/mail/${mailId}`), {
            status: "rejected",
            unread: false
        });
        await set(ref(db, `plots/${plotId}/applicants/${applicant}`), null);

        const replyData = {
            type: "system",
            from: currentUser,
            to: applicant,
            subject: `ℹ️ Відповідь на резюме (${mail.buildingName})`,
            body: `Власник ${currentUser} переглянув ваше резюме у «${mail.buildingName}» (${mail.plotName}) та наразі відхилив заявку. Ви можете пройти додаткові профільні курси або подати резюме повторно!`,
            unread: true,
            createdAt: Date.now()
        };
        const replyRef = push(ref(db, `users/${applicant}/clicker/mail`));
        replyData.id = replyRef.key;
        await set(replyRef, replyData);
        await set(ref(db, `users/${currentUser}/clicker/sentMail/${replyRef.key}`), replyData);

        sfx.click();
        setGameStatus(`Резюме від ${applicant} відхилено.`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

// ВИМОГА 2: Видалення повідомлень на Пошті ОДРАЗУ ДЛЯ ДВОХ СТОРІН (і у відправника, і в отримувача)!
window.deleteMailItem = async function (mailId, isSent = false, otherUserHint = "") {
    if (!mailId || !currentUser) return;
    const msgObj = userInboxMail[mailId] || userSentMail[mailId] || null;
    const fromUser = msgObj?.from || (isSent ? currentUser : otherUserHint);
    const toUser = msgObj?.to || (isSent ? otherUserHint : currentUser);

    const tasks = [
        set(ref(db, `users/${currentUser}/clicker/mail/${mailId}`), null).catch(() => {}),
        set(ref(db, `users/${currentUser}/clicker/sentMail/${mailId}`), null).catch(() => {})
    ];

    if (fromUser && fromUser !== currentUser) {
        tasks.push(set(ref(db, `users/${fromUser}/clicker/sentMail/${mailId}`), null).catch(() => {}));
        tasks.push(set(ref(db, `users/${fromUser}/clicker/mail/${mailId}`), null).catch(() => {}));
    }
    if (toUser && toUser !== currentUser) {
        tasks.push(set(ref(db, `users/${toUser}/clicker/mail/${mailId}`), null).catch(() => {}));
        tasks.push(set(ref(db, `users/${toUser}/clicker/sentMail/${mailId}`), null).catch(() => {}));
    }
    if (msgObj?.type === "resume" && msgObj.plotId !== undefined && fromUser) {
        tasks.push(set(ref(db, `plots/${msgObj.plotId}/applicants/${fromUser}`), null).catch(() => {}));
    }

    try {
        await Promise.all(tasks);
        delete userInboxMail[mailId];
        delete userSentMail[mailId];
        sfx.click();
        updateMailBadges();
        if (currentPage === "mail") renderMailPage();
        setGameStatus("🗑️ Повідомлення видалено для обох сторін!");
    } catch (e) {}
};

window.markMailRead = async function (mailId) {
    if (!userInboxMail[mailId] || !userInboxMail[mailId].unread) return;
    try {
        await update(ref(db, `users/${currentUser}/clicker/mail/${mailId}`), { unread: false });
    } catch (e) {}
};

function renderMailPage() {
    if (activeMailSubtab === "history") {
        renderMailHistoryView();
        return;
    }

    const box = $("mail-list-container");
    if (!box) return;

    if (activeMailSubtab === "sent") {
        const sentArr = Object.entries(userSentMail || {})
            .map(([id, m]) => ({ ...m, id }))
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        if (!sentArr.length) {
            box.innerHTML = `<div class="muted" style="text-align:center;padding:24px">Ви ще не надсилали жодних листів чи резюме.</div>`;
            return;
        }

        box.innerHTML = sentArr.map(m => `
            <div class="mail-card">
                <div class="mail-header-row">
                    <span class="mail-from">📤 Кому: <b>${escapeHtml(m.to || "—")}</b></span>
                    <span class="mail-date">${formatTimeAgo(m.createdAt)}</span>
                </div>
                <div class="mail-subj">${escapeHtml(m.subject || "Без теми")}</div>
                <div class="mail-body-text">${escapeHtml(m.body || "")}</div>
                ${Number(m.attachedCoins) > 0 ? `<div style="font-size:11px;color:#006400;font-weight:bold">💸 Переслано монет: +${formatNumberFull(m.attachedCoins)} 💰 (${m.coinsClaimed ? "отримано" : "очікує отримання"})</div>` : ""}
                ${m.jobOffer ? `<div style="font-size:11px;color:#000080">📍 Прикріплено координати: ${escapeHtml(m.jobOffer.plotName)} (${escapeHtml(m.jobOffer.coords)})</div>` : ""}
                <div class="btn-row" style="margin-top:2px">
                    <button class="btn" onclick="openConversationHistory('${escapeHtml(m.to || "")}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px">💬 Історія переписки</button>
                    <button class="btn danger" onclick="deleteMailItem('${m.id}', true, '${escapeHtml(m.to || "")}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px">🗑️ Видалити у всіх</button>
                </div>
            </div>
        `).join("");
        return;
    }

    let list = Object.entries(userInboxMail || {})
        .map(([id, m]) => ({ ...m, id }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (activeMailSubtab === "resumes") {
        list = list.filter(m => m.type === "resume");
    }

    if (!list.length) {
        box.innerHTML = `<div class="muted" style="text-align:center;padding:24px">${activeMailSubtab === "resumes" ? "Наразі нових резюме від кандидатів немає." : "Ваша поштова скринька порожня."}</div>`;
        return;
    }

    box.innerHTML = list.map(m => {
        const isResume = m.type === "resume";
        const isUnread = Boolean(m.unread);
        const coursesHtml = isResume ? renderCourseChipsHtml(m.completedCourses || [], m.plotZone) : "";

        let resumeMarginHtml = "";
        if (isResume) {
            const p = MAP_PLOTS_BASE.find(x => x.id === Number(m.plotId));
            const owned = getOwnedPlotData(Number(m.plotId));
            const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
            const fin = calcOrderFinancials(m.plotZone || (p ? p.zone : "residential"), bld, m.completedCourses || [], m.desiredWage || 15);
            const netSign = fin.ownerNetMargin >= 0 ? `+${fin.ownerNetMargin} 💰 (в плюсі)` : `${fin.ownerNetMargin} 💰 (ЗБИТОК!)`;
            const netColor = fin.ownerNetMargin >= 0 ? "#006400" : "#900000";
            resumeMarginHtml = `
                <div style="margin-top:3px;padding:4px 6px;background:#fffff0;border:1px solid #808080;font-size:11px">
                    📊 <b>Розрахунок з цим кандидатом за 1 замовлення:</b><br>
                    Чек покупця: <b>+${fin.grossCheck} 💰</b> (бонус курсів +${fin.skillBonusPct}%) ➔ Податок (${fin.turnoverTaxPct}%): <b style="color:#800000">-${fin.taxAmount} 💰</b> ➔ Бажана ЗП: <b>-${fin.wage} 💰</b> ➔ <b>Ваш чистий плюс у касу: <span style="color:${netColor}">${netSign}</span></b>
                </div>
            `;
        }

        let resumeActionsHtml = "";
        if (isResume) {
            if (m.status === "accepted") {
                resumeActionsHtml = `<div style="color:#006400;font-weight:bold;font-size:12px">✅ Резюме прийнято (встановлена ЗП: ${formatNumberFull(m.approvedWage || m.desiredWage)} 💰)</div>`;
            } else if (m.status === "rejected") {
                resumeActionsHtml = `<div style="color:#800000;font-weight:bold;font-size:12px">❌ Резюме відхилено</div>`;
            } else {
                resumeActionsHtml = `
                    <div class="worker-owner-actions" style="border-top:1px solid #808080;padding-top:6px;margin-top:4px">
                        <span style="font-size:11px;font-weight:bold">Призначити ЗП (💰):</span>
                        <input type="number" id="approve_wage_${m.id}" class="input-field" value="${m.desiredWage || 15}" min="5" max="50000" style="max-width:85px">
                        <button class="btn success" onclick="acceptResume('${m.id}')">✅ Прийняти на роботу</button>
                        <button class="btn danger" onclick="rejectResume('${m.id}')">❌ Відхилити</button>
                    </div>
                `;
            }
        }

        let moneyAttachmentHtml = "";
        if (Number(m.attachedCoins) > 0) {
            moneyAttachmentHtml = `
                <div class="mail-attachment-box money-box">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
                        <span>💸 <b>Грошовий переказ у листі: +${formatNumberFull(m.attachedCoins)} 💰</b></span>
                        ${!m.coinsClaimed
                            ? `<button class="btn success" onclick="claimMailCoins('${m.id}')" style="min-height:28px;min-width:auto;padding:3px 10px;font-size:11px">📥 Забрати гроші в гаманець</button>`
                            : `<span style="color:#006400;font-weight:bold">✓ Зараховано у ваш гаманець</span>`
                        }
                    </div>
                </div>
            `;
        }

        let jobOfferAttachmentHtml = "";
        if (m.jobOffer) {
            const jo = m.jobOffer;
            jobOfferAttachmentHtml = `
                <div class="mail-attachment-box job-offer-box">
                    <div>📍 <b>Пропозиція місця роботи:</b> ${escapeHtml(jo.buildingName || "")} — <b>${escapeHtml(jo.plotName || "")}</b></div>
                    <div>Гео-координати ділянки: <span class="coord-badge">${escapeHtml(jo.coords || "")}</span> • Запропонована ЗП: <b style="color:#006400">+${formatNumberFull(jo.offeredWage || 15)} 💰 / замовл.</b></div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">
                        <button class="btn default" onclick="focusPlotFromMail(${jo.plotId})" style="min-height:28px;min-width:auto;padding:3px 10px;font-size:11px">🗺️ Показати на мапі за координатами</button>
                        ${!m.offerAccepted
                            ? `<button class="btn success" onclick="acceptJobOfferFromMail('${m.id}')" style="min-height:28px;min-width:auto;padding:3px 10px;font-size:11px">✅ Прийняти роботу (+${formatNumberFull(jo.offeredWage || 15)} 💰)</button>`
                            : `<span style="color:#006400;font-weight:bold;align-self:center">✓ Ви прийняли цю пропозицію</span>`
                        }
                    </div>
                </div>
            `;
        }

        return `
            <div class="mail-card${isUnread ? " unread" : ""}${isResume ? " resume-card" : ""}" onclick="markMailRead('${m.id}')">
                <div class="mail-header-row">
                    <span class="mail-from">${isResume ? "📋 Кандидат:" : "📩 Від:"} <b>${escapeHtml(m.from || "Система")}</b> ${isUnread ? '<span class="tab-badge">НОВЕ</span>' : ""}</span>
                    <span class="mail-date">${formatTimeAgo(m.createdAt)}</span>
                </div>
                <div class="mail-subj">${escapeHtml(m.subject || "Повідомлення")}</div>
                ${isResume ? `
                <div class="mail-resume-details">
                    <div><b>Підприємство:</b> ${escapeHtml(m.buildingName || "")} (${escapeHtml(m.plotName || "")}) ${m.plotCoords ? `<span class="coord-badge">${escapeHtml(m.plotCoords)}</span>` : ""}</div>
                    <div><b>Пройдені курси кандидата:</b> ${coursesHtml}</div>
                    ${resumeMarginHtml}
                </div>
                ` : ""}
                <div class="mail-body-text">${escapeHtml(m.body || "")}</div>
                ${moneyAttachmentHtml}
                ${jobOfferAttachmentHtml}
                ${resumeActionsHtml}
                <div class="btn-row" style="margin-top:2px">
                    <button class="btn" onclick="openConversationHistory('${escapeHtml(m.from)}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px">💬 Історія переписки</button>
                    <button class="btn default" onclick="openComposeMail('${escapeHtml(m.from)}', 'Re: ${escapeHtml(m.subject || "")}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px">↩️ Відповісти / Переказ</button>
                    <button class="btn danger" onclick="deleteMailItem('${m.id}', false, '${escapeHtml(m.from || "")}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px">🗑️ Видалити у всіх</button>
                </div>
            </div>
        `;
    }).join("");
}

window.resignCurrentJob = async function () {
    if (gameState.employer === "none") return;
    const prevPlotId = getActiveEmployerPlotId();
    if (prevPlotId !== null) {
        try { await set(ref(db, `plots/${prevPlotId}/workers/${currentUser}`), null); } catch (e) {}
    }
    miniGames.stop();
    workCooldownUntil = 0;
    gameState.employer = "none";
    gameState.taskActive = false;
    gameState.taskProgress = 0;
    sfx.click();
    renderAll();
    saveGame();
    setGameStatus("Ви звільнились за власним бажанням.");
    showDialog("Звільнення оформлено", "Ви звільнились із попереднього місця роботи.\nТепер ви можете подати резюме в бізнес іншого гравця або піти в КовельКорп.", "🚪");
};

async function doPrivateOrderStepWork(plotId) {
    if (isProcessingWorkClick || Date.now() < workCooldownUntil) return;

    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || !owned.building) {
        gameState.employer = "none";
        renderAll();
        return;
    }

    const cStatePre = getPlotClientsState(p, owned);
    if (cStatePre.current <= 0) {
        return showDialog(
            "Клієнтів зараз немає!",
            `Усі клієнти на підприємстві «${p.name}» вже обслужені!\nНаступний клієнт зайде приблизно через ${cStatePre.nextClientSec} сек.\n\n💡 Власник може купити Рекламу або покращити інфраструктуру (парковку, камери, пандус), щоб збільшити потік клієнтів!`,
            "🚶"
        );
    }

    const currentStep = (Math.floor(gameState.taskProgress) % ORDER_STEPS_REQUIRED) + 1;
    sfx.click();

    if (currentStep < ORDER_STEPS_REQUIRED) {
        gameState.taskProgress = currentStep;
        triggerWorkCooldown(PRIVATE_STEP_COOLDOWN_MS, "step");
        setGameStatus(`${PRIVATE_ORDER_STAGE_LABELS[currentStep - 1]} — виконано! Наступний крок через 1.6с...`);
        return;
    }

    isProcessingWorkClick = true;
    const bld = getBuildingDef(p.zone, owned.building);
    const wRec = getWorkerRecordOnPlot(plotId, currentUser);
    const fin = calcOrderFinancials(p.zone, bld, gameState.completedCourses, wRec.personalWage);

    let paidToWorker = 0;
    let netOwnerTreasuryDelta = 0;
    let taxPaidThisOrder = fin.taxAmount;
    let noClientsLeft = false;

    try {
        const txRes = await runTransaction(ref(db, `plots/${plotId}`), (cur) => {
            if (!cur) return cur;
            const cLive = getPlotClientsState(p, cur);
            if (cLive.current <= 0) {
                noClientsLeft = true;
                return; // перериваємо транзакцію, бо клієнти скінчились
            }
            cur.clientsRemaining = Math.max(0, cLive.current - 1);
            cur.clientsLastRefillAt = Date.now();

            const treasury = Math.max(0, Number(cur.treasury) || 0);
            const curWorker = (cur.workers && cur.workers[currentUser]) ? cur.workers[currentUser] : {};
            const baseWage = Number(cur.wage) > 0 ? Number(cur.wage) : (bld ? bld.defaultWage : 15);
            // ВИМОГА 1: Зарплата строго дорівнює тій, яку призначив власник (без жодного множення на бонуси курсів!)
            const activeWage = Number(curWorker.personalWage) > 0 ? Number(curWorker.personalWage) : baseWage;
            const txFin = calcOrderFinancials(p.zone, bld, gameState.completedCourses, activeWage);
            taxPaidThisOrder = txFin.taxAmount;

            const availableForPay = treasury + txFin.afterTaxRevenue;
            if (availableForPay >= activeWage) {
                paidToWorker = activeWage;
                netOwnerTreasuryDelta = txFin.afterTaxRevenue - activeWage;
                cur.treasury = treasury + netOwnerTreasuryDelta;
            } else {
                paidToWorker = Math.max(1, availableForPay);
                netOwnerTreasuryDelta = -treasury;
                cur.treasury = 0;
            }

            if (!cur.workers) cur.workers = {};
            const prevOrders = Number(curWorker.orders) || 0;
            const prevClicks = Number(curWorker.clicks) || 0;
            const prevEarned = Number(curWorker.totalEarned) || 0;
            const prevProfit = Number(curWorker.profitBrought) || 0;
            const prevNetMargin = curWorker.netMarginBrought !== undefined
                ? Number(curWorker.netMarginBrought)
                : Math.max(0, prevProfit - prevEarned);
            const prevTax = Number(curWorker.taxPaidTotal) || 0;

            cur.workers[currentUser] = {
                role: curWorker.role || "Робітник зміни",
                personalWage: activeWage,
                completedCourses: gameState.completedCourses || [],
                orders: prevOrders + 1,
                clicks: prevClicks + ORDER_STEPS_REQUIRED,
                totalEarned: prevEarned + paidToWorker,
                profitBrought: prevProfit + txFin.grossCheck,
                netMarginBrought: prevNetMargin + netOwnerTreasuryDelta,
                taxPaidTotal: prevTax + taxPaidThisOrder,
                joinedAt: curWorker.joinedAt || Date.now(),
                lastWorkAt: Date.now()
            };
            return cur;
        });
    } catch (e) {
        paidToWorker = fin.wage;
        netOwnerTreasuryDelta = fin.afterTaxRevenue - paidToWorker;
    } finally {
        isProcessingWorkClick = false;
    }

    if (noClientsLeft) {
        gameState.taskProgress = 0;
        renderTask();
        updateWorkButtonState();
        return showDialog("Клієнта вже обслужено", "Останнього клієнта щойно обслужив інший працівник! Зачекайте на наступного покупця.", "🚶");
    }

    sfx.good();
    gameState.coins += paidToWorker;
    markLocalCoinsChanged();
    gameState.taskProgress = 0;
    triggerWorkCooldown(PRIVATE_ORDER_COOLDOWN_MS, "order");
    renderStats();
    renderEmployerBar();
    renderOwnerBusinessesHub();
    saveGame();

    const marginStr = netOwnerTreasuryDelta >= 0 ? `+${netOwnerTreasuryDelta} 💰 у касу` : `${netOwnerTreasuryDelta} 💰 з каси`;
    setGameStatus(`✅ Чек покупця: ${fin.grossCheck} 💰 | Податок (${fin.turnoverTaxPct}%): -${taxPaidThisOrder} 💰 | Ваша ЗП: +${paidToWorker} 💰 | Власнику: ${marginStr}`);
}

function doMunicipalStepWork() {
    if (Date.now() < workCooldownUntil) return;
    if (miniGames.isRunning()) return;
    sfx.click();
    gameState.taskActive = true;
    gameState.taskProgress = 0;
    renderTask();
    miniGames.startJanitorClean(() => {
        gameState.coins += MUNICIPAL_TASK_REWARD;
        markLocalCoinsChanged();
        gameState.taskActive = false;
        gameState.taskProgress = 0;
        triggerWorkCooldown(MUNICIPAL_ORDER_COOLDOWN_MS, "order");
        renderStats();
        renderTask();
        updateWorkButtonState();
        saveGame();
        setGameStatus(`✅ Ділянку розчищено! Отримано +${MUNICIPAL_TASK_REWARD} 💰 від міськради. Перерва 4.5с.`);
    });
    updateWorkButtonState();
    setGameStatus("🧹 Розчищаємо сміття на вулицях Ковеля...");
}

window.raiseWorkerWage = async function (plotId, workerName, mult = 1.25) {
    const owned = getOwnedPlotData(plotId);
    if (!owned || owned.owner !== currentUser) return;
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const bld = p ? getBuildingDef(p.zone, owned.building) : null;
    const wRec = getWorkerRecordOnPlot(plotId, workerName);
    const fin = calcOrderFinancials(p ? p.zone : "residential", bld, wRec.completedCourses, wRec.personalWage);

    const rawTarget = Math.max(wRec.personalWage + 3, Math.round(wRec.personalWage * mult));
    const newWage = Math.min(50000, rawTarget);

    const curTitleIdx = OWNER_ASSIGNED_TITLES.indexOf(wRec.role);
    const nextTitle = curTitleIdx >= 0 && curTitleIdx < OWNER_ASSIGNED_TITLES.length - 1
        ? OWNER_ASSIGNED_TITLES[curTitleIdx + 1]
        : (curTitleIdx === -1 ? OWNER_ASSIGNED_TITLES[1] : wRec.role);

    try {
        await update(ref(db, `plots/${plotId}/workers/${workerName}`), {
            personalWage: newWage,
            role: nextTitle,
            lastRaisedAt: Date.now()
        });
        sfx.win();
        const newMargin = fin.afterTaxRevenue - newWage;
        const mInfo = newMargin >= 0 ? `чистий плюс з замовлення: +${newMargin} 💰` : `⚠️ ЗБИТОК з замовлення: ${newMargin} 💰`;
        setGameStatus(`⬆️ ${workerName}: ЗП ${formatNumberFull(newWage)} 💰 («${nextTitle}», ${mInfo})`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.setWorkerCustomWage = async function (plotId, workerName, inputId, roleSelectId) {
    const owned = getOwnedPlotData(plotId);
    if (!owned || owned.owner !== currentUser) return;
    const inp = $(inputId);
    const roleSel = $(roleSelectId);
    const val = Math.max(5, Math.min(50000, Math.floor(Number(inp?.value) || 0)));
    const newRole = roleSel ? roleSel.value : getWorkerRecordOnPlot(plotId, workerName).role;

    try {
        await update(ref(db, `plots/${plotId}/workers/${workerName}`), {
            personalWage: val,
            role: newRole,
            lastRaisedAt: Date.now()
        });
        sfx.good();
        setGameStatus(`💾 Збережено для ${workerName}: посада «${newRole}», ЗП ${formatNumberFull(val)} 💰/замовлення`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.fireWorkerFromPlot = async function (plotId, workerName) {
    const owned = getOwnedPlotData(plotId);
    if (!owned || owned.owner !== currentUser) return;
    try {
        await set(ref(db, `plots/${plotId}/workers/${workerName}`), null);
        sfx.click();
        setGameStatus(`Працівника ${workerName} звільнено з підприємства.`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};


window.buyPlotUpgrade = async function (plotId, upgradeId) {
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "У вас прострочений кредит у КовельБанку!", "🚫");
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === Number(plotId));
    const owned = getOwnedPlotData(Number(plotId));
    const upg = BUSINESS_UPGRADES.find(u => u.id === upgradeId);
    if (!p || !owned || owned.owner !== currentUser || !owned.building || !upg) return;
    if (owned.upgrades && owned.upgrades[upgradeId]) return;
    if (gameState.coins < upg.cost) {
        return showDialog("Недостатньо монет", `Потрібно ${formatNumberFull(upg.cost)} 💰.`, "💸");
    }

    try {
        gameState.coins -= upg.cost;
        markLocalCoinsChanged();
        const cState = getPlotClientsState(p, owned);
        await update(ref(db, `plots/${p.id}`), {
            [`upgrades/${upgradeId}`]: true,
            clientsRemaining: cState.current + upg.clientBonus,
            clientsLastRefillAt: Date.now()
        });
        sfx.win();
        renderAll();
        await saveGame();
        setGameStatus(`✅ Встановлено «${upg.name}»! Потік клієнтів збільшено на +${upg.clientBonus}/год назавжди!`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.buyPlotAd = async function (plotId, adId) {
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "У вас прострочений кредит у КовельБанку!", "🚫");
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === Number(plotId));
    const owned = getOwnedPlotData(Number(plotId));
    const ad = BUSINESS_ADS.find(a => a.id === adId);
    if (!p || !owned || owned.owner !== currentUser || !owned.building || !ad) return;
    if (gameState.coins < ad.cost) {
        return showDialog("Недостатньо монет", `Потрібно ${formatNumberFull(ad.cost)} 💰.`, "💸");
    }

    try {
        gameState.coins -= ad.cost;
        markLocalCoinsChanged();
        const cState = getPlotClientsState(p, owned);
        const now = Date.now();
        await update(ref(db, `plots/${p.id}`), {
            adUntil: now + ad.durationMs,
            adMultPct: ad.multPct,
            adName: ad.name,
            clientsRemaining: cState.current + ad.instantClients,
            clientsLastRefillAt: now
        });
        sfx.win();
        renderAll();
        await saveGame();
        setGameStatus(`📢 Запущено «${ad.name}»! +${ad.instantClients} клієнтів прийшли одразу, потік +${ad.multPct}%!`);
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.savePlotWage = async function (customPlotId = null, customInputId = null, applyToAll = false) {
    const pid = customPlotId !== null ? customPlotId : selectedPlotId;
    if (pid === null) return;
    const owned = getOwnedPlotData(pid);
    if (!owned || owned.owner !== currentUser) return;
    const inpEl = customInputId ? $(customInputId) : $("owner-wage-input");
    const val = Math.max(5, Math.min(50000, Math.floor(Number(inpEl?.value) || 0)));
    try {
        const updates = { wage: val };
        if (applyToAll && owned.workers) {
            Object.keys(owned.workers).forEach(wName => {
                updates[`workers/${wName}/personalWage`] = val;
            });
        }
        await update(ref(db, `plots/${pid}`), updates);
        sfx.good();
        setGameStatus(applyToAll
            ? `✅ Всім працівникам підприємства встановлено ЗП: ${formatNumberFull(val)} 💰/замовлення!`
            : `💾 Базову ЗП для нових працівників встановлено: ${formatNumberFull(val)} 💰/замовлення`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.fundPlotTreasury = async function (customPlotId = null, customInputId = null) {
    const pid = customPlotId !== null ? customPlotId : selectedPlotId;
    if (pid === null) return;
    const owned = getOwnedPlotData(pid);
    if (!owned || owned.owner !== currentUser) return;
    const inpEl = customInputId ? $(customInputId) : $("owner-fund-input");
    const val = Math.floor(Number(inpEl?.value) || 0);
    if (val <= 0) return showDialog("Введіть суму", "Вкажіть суму монет для поповнення каси підприємства.", "⚠️");
    if (gameState.coins < val) return showDialog("Недостатньо монет", `У гаманці лише ${formatNumberFull(gameState.coins)} 💰`, "💸");
    try {
        gameState.coins -= val;
        markLocalCoinsChanged();
        await runTransaction(ref(db, `plots/${pid}/treasury`), (cur) => (Number(cur) || 0) + val);
        if (inpEl) inpEl.value = "";
        sfx.good();
        renderAll(); await saveGame();
        setGameStatus(`Касу підприємства поповнено на +${formatNumberFull(val)} 💰`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.withdrawPlotTreasury = async function (customPlotId = null, customInputId = null, takeAll = false) {
    const pid = customPlotId !== null ? customPlotId : selectedPlotId;
    if (pid === null) return;
    const owned = getOwnedPlotData(pid);
    if (!owned || owned.owner !== currentUser) return;
    const curTreasury = Math.max(0, Number(owned.treasury) || 0);
    if (curTreasury <= 0) return showDialog("Каса порожня", "У касі цього підприємства зараз 0 монет. Коли робітники виконують замовлення або минає година роботи, прибуток надходить сюди!", "ℹ️");
    const inpEl = customInputId ? $(customInputId) : $("owner-fund-input");
    const inputVal = Math.floor(Number(inpEl?.value) || 0);
    const takeAmt = (takeAll || inputVal <= 0) ? curTreasury : Math.min(curTreasury, inputVal);
    try {
        gameState.coins += takeAmt;
        markLocalCoinsChanged();
        await runTransaction(ref(db, `plots/${pid}/treasury`), (cur) => Math.max(0, (Number(cur) || 0) - takeAmt));
        if (inpEl) inpEl.value = "";
        sfx.win();
        renderAll(); await saveGame();
        setGameStatus(`💰 Виведено з Каси бізнесу у ваш гаманець: +${formatNumberFull(takeAmt)} 💰!`);
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.withdrawAllPlotsTreasury = async function () {
    if (!currentUser || !sharedPlots) return;
    let totalTaken = 0;
    for (const p of MAP_PLOTS_BASE) {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === currentUser && owned.building) {
            const curT = Math.max(0, Math.floor(Number(owned.treasury) || 0));
            if (curT > 0) {
                try {
                    await set(ref(db, `plots/${p.id}/treasury`), 0);
                    totalTaken += curT;
                } catch (e) {}
            }
        }
    }
    if (totalTaken <= 0) {
        return showDialog("Каси порожні", "Наразі в касах ваших підприємств 0 💰.", "ℹ️");
    }
    gameState.coins += totalTaken;
    markLocalCoinsChanged();
    sfx.win();
    renderAll();
    await saveGame();
    setGameStatus(`💰 Ви забрали весь прибуток з усіх своїх Кас у гаманець: +${formatNumberFull(totalTaken)} 💰!`);
    showDialog("Прибуток забрано!", `Із кас усіх ваших підприємств у ваш гаманець переведено:\n\n+${formatNumberFull(totalTaken)} 💰`, "💰");
};

window.sellPlotToCity = async function (plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === Number(plotId));
    const owned = getOwnedPlotData(Number(plotId));
    if (!p || !owned || owned.owner !== currentUser) return;
    const paidPrice = Number(owned.price) > 0 ? Number(owned.price) : calcPlotPrice(p, sharedPlots);
    const bld = getBuildingDef(p.zone, owned.building);
    const bldCost = bld ? bld.cost : 0;
    const treasuryLeft = Math.max(0, Number(owned.treasury) || 0);
    const refund = Math.floor((paidPrice + bldCost) * 0.75) + treasuryLeft;

    try {
        await set(ref(db, `plots/${p.id}`), null);
        gameState.coins += refund;
        markLocalCoinsChanged();
        if (selectedPlotId === p.id) closeMapInfo();
        sfx.win();
        renderAll();
        await saveGame();
        setGameStatus(`🏷️ Ділянку «${p.name}» продано місту за +${formatNumberFull(refund)} 💰 (податок на землю більше не стягується).`);
        showDialog("Ділянку продано місту!", `Ви продали «${p.name}» міській раді Ковеля та отримали:\n+${formatNumberFull(refund)} 💰 (75% вартості + залишок каси).\nПодаток на цю землю більше не стягується.`, "🏷️");
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

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
    if (isBankBlocked()) {
        return showDialog("Прострочений кредит!", "Ви не можете поповнювати депозит, поки у вас є прострочений кредит! Спочатку погасіть борг у вкладці «💳 Кредитний відділ».", "🚫");
    }
    const val = Math.floor(Number($("dep-amount-input").value) || 0);
    if (val <= 0) return showDialog("Помилка", "Введіть суму для поповнення депозиту.", "⚠️");
    if (gameState.coins < val) return showDialog("Недостатньо монет", "У гаманці лише " + formatNumberFull(gameState.coins) + " 💰", "💸");

    if (!gameState.deposit) gameState.deposit = { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 };
    if (gameState.deposit.amount === 0) gameState.deposit.lastInterestAt = Date.now();
    gameState.coins -= val;
    markLocalCoinsChanged();
    gameState.deposit.amount += val;
    $("dep-amount-input").value = "";
    sfx.good();
    renderAll(); saveGame();
    setGameStatus(`Покладено на депозит: +${formatNumberFull(val)} 💰 (ставка +0.3%/год)`);
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
    markLocalCoinsChanged();
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
    if (isBankBlocked()) {
        dep.lastInterestAt = now;
        return;
    }
    const elapsed = now - dep.lastInterestAt;
    if (elapsed >= HOUR_MS) {
        const hours = Math.min(72, Math.floor(elapsed / HOUR_MS));
        let earnedTotal = 0;
        for (let i = 0; i < hours; i++) {
            const gain = Math.max(1, Math.floor(dep.amount * DEPOSIT_RATE_PER_HOUR));
            dep.amount += gain;
            earnedTotal += gain;
        }
        dep.totalEarned = (Number(dep.totalEarned) || 0) + earnedTotal;
        dep.lastInterestAt += hours * HOUR_MS;
        renderStats();
        if (currentPage === "bank") renderBank();
        saveGame();
        setGameStatus(`🏦 Депозит КовельБанку (+0.3%/год): нараховано +${formatNumberFull(earnedTotal)} 💰 відсотків`);
    }
}

function isBankBlocked() {
    return Boolean(gameState.credit && gameState.credit.amount > 0 && gameState.credit.overdue);
}

function getCreditLimit() {
    const jobLimit = gameState.employer === "corp"
        ? (getCurrentCorpJob().creditLimit || 15000)
        : 20000;
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
    markLocalCoinsChanged();
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
    if (gameState.coins < payAmount) return showDialog("Недостатньо монет у гаманці", `Потрібно ${formatNumberFull(payAmount)} 💰.\nВи можете заробити монети на роботі або зняти кошти з депозиту чи Каси бізнесу.`, "💸");

    gameState.coins -= payAmount;
    markLocalCoinsChanged();
    gameState.credit.amount -= payAmount;
    if ($("repay-amount-input")) $("repay-amount-input").value = "";

    if (gameState.credit.amount <= 0) {
        gameState.credit = { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 };
        sfx.win();
        renderAll(); saveGame();
        setGameStatus("Кредит повністю погашено! Усі покупки розблоковано.");
        showDialog("Кредит погашено!", "Борг перед КовельБанком повністю закрито. Усі покупки знову доступні!", "✅");
    } else {
        sfx.good();
        renderAll(); saveGame();
        setGameStatus(`Сплачено ${formatNumberFull(payAmount)} 💰. Залишок боргу: ${formatNumberFull(gameState.credit.amount)} 💰`);
    }
};

function applyOverduePenaltyTick(c) {
    const penalty = Math.max(10, Math.floor(c.amount * 0.10));
    if (!gameState.deposit) gameState.deposit = { amount: 0, lastInterestAt: Date.now(), totalEarned: 0 };
    const depAvail = Math.max(0, Number(gameState.deposit.amount) || 0);

    if (depAvail >= penalty) {
        gameState.deposit.amount -= penalty;
        setGameStatus(`⚠️ Штраф за прострочений кредит (-${formatNumberFull(penalty)} 💰) примусово списано з вашого депозиту!`);
    } else if (depAvail > 0) {
        const remainder = penalty - depAvail;
        gameState.deposit.amount = 0;
        c.amount += remainder;
        setGameStatus(`⚠️ Штраф за кредит забрав увесь депозит (-${formatNumberFull(depAvail)} 💰) та додав +${formatNumberFull(remainder)} 💰 до боргу!`);
    } else {
        c.amount += penalty;
        setGameStatus(`⚠️ Штраф за прострочений кредит: +${formatNumberFull(penalty)} 💰 до боргу (депозит порожній)!`);
    }
}

function checkCreditPenalties() {
    const c = gameState.credit;
    if (!c || c.amount <= 0) return;
    const now = Date.now();
    if (now < c.dueAt) return;

    if (!c.overdue) {
        c.overdue = true;
        c.lastPenaltyAt = now;
        applyOverduePenaltyTick(c);
        renderAll();
        saveGame();
        return;
    }

    if (now - c.lastPenaltyAt >= 5 * 60 * 1000) {
        c.lastPenaltyAt = now;
        applyOverduePenaltyTick(c);
        renderAll();
        saveGame();
    }
}

function startCreditTimer() {
    if (creditTimerInterval) clearInterval(creditTimerInterval);
    creditTimerInterval = setInterval(() => {
        checkCreditPenalties();
        checkDepositInterest();
        checkPassiveRentIncome();
        if (currentPage === "bank") renderBank();
        if ($("bohdan-overlay")?.classList.contains("active")) renderBohdanWeldingSchool();
    }, 1000);
}

function renderAll() {
    renderStats();
    renderEmployerBar();
    renderTask();
    renderPrivateJobsBoard();
    renderOwnerBusinessesHub();
    renderJobsList();
    renderShop();
    renderMap();
    renderBank();
    if (currentPage === "mail") renderMailPage();
    if (currentPage === "politics") renderPoliticsPage();
    if ($("bohdan-overlay")?.classList.contains("active")) renderBohdanWeldingSchool();
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
        const owned = getOwnedPlotData(pid);
        const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
        const wRec = getWorkerRecordOnPlot(pid, currentUser);
        const fin = calcOrderFinancials(p ? p.zone : "residential", bld, gameState.completedCourses, wRec.personalWage);
        nameEl.textContent = `${bld ? bld.icon + " " + bld.name : (p ? p.name : "Підприємство")} — ${wRec.role}`;
        subEl.textContent = `Власник: ${owned?.owner || "—"} • Ваша ЗП: +${formatNumberFull(wRec.personalWage)} 💰 • Чек вашого замовлення: ${fin.grossCheck} 💰 (податок -${fin.taxAmount} 💰)`;
        joinCorpBtn.style.display = "inline-block";
        resignBtn.style.display = "inline-block";
    } else {
        nameEl.textContent = `🧹 Муніципальний підробіток (Вільний працівник)`;
        subEl.textContent = hasCourse("basics")
            ? "Ви можете увійти в КовельКорп або подати резюме на підприємство гравця нижче!"
            : "Оберіть підприємство у вкладці «🏪 Вакансії» нижче або вивчіть ІТ-курс для КовельКорп!";
        joinCorpBtn.style.display = "inline-block";
        resignBtn.style.display = "none";
    }
}

function renderPrivateJobsBoard() {
    const listEl = $("private-jobs-list");
    const badgeEl = $("badge-vacancies");
    if (!listEl) return;
    const activePid = getActiveEmployerPlotId();

    const businesses = [];
    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.building) {
            const bld = getBuildingDef(p.zone, owned.building);
            if (bld) {
                const wage = Number(owned.wage) > 0 ? Number(owned.wage) : bld.defaultWage;
                const workersCount = owned.workers ? Object.keys(owned.workers).length : 0;
                businesses.push({ plot: p, owned, bld, wage, workersCount });
            }
        }
    });

    if (badgeEl) badgeEl.textContent = businesses.length;

    if (!businesses.length) {
        listEl.innerHTML = `<div class="muted" style="padding:10px;text-align:center">Поки жоден гравець не побудував магазин чи підприємство на мапі Ковеля. Купіть ділянку у вкладці «🗺️ Мапа» або пройдіть курс програмування для роботи в КовельКорп!</div>`;
        return;
    }

    businesses.sort((a, b) => b.wage - a.wage);

    let html = "";
    businesses.forEach(({ plot, owned, bld, wage, workersCount }) => {
        const isCurrent = activePid === plot.id;
        const alreadyWorksForThisOwner = getExistingEmploymentForOwner(currentUser, owned.owner);
        const hasPendingResume = Boolean(owned.applicants && owned.applicants[currentUser]);
        const fin = calcOrderFinancials(plot.zone, bld, gameState.completedCourses, wage);
        const zInfo = ZONE_INFO[plot.zone] || ZONE_INFO.residential;
        const treasury = Math.max(0, Number(owned.treasury) || 0);

        let actionBtnHtml = "";
        if (isCurrent) {
            actionBtnHtml = `<button class="btn danger" onclick="resignCurrentJob()" style="min-height:30px;min-width:85px;padding:4px 8px;font-size:11px">Звільнитись</button>`;
        } else if (alreadyWorksForThisOwner) {
            actionBtnHtml = `<span style="font-size:11px;color:#006400;font-weight:bold">👷 Вже працюєте у ${escapeHtml(owned.owner)}</span>`;
        } else if (hasPendingResume) {
            actionBtnHtml = `<button class="btn" onclick="openResumeModal(${plot.id})" style="min-height:30px;min-width:90px;padding:4px 8px;font-size:11px;color:#000080">⏳ Резюме подано</button>`;
        } else {
            actionBtnHtml = `<button class="btn default" onclick="openResumeModal(${plot.id})" style="min-height:30px;min-width:96px;padding:4px 8px;font-size:11px">📨 Подати резюме</button>`;
        }

        html += `<div class="pjob-card${isCurrent ? " active-emp" : ""}">
            <div class="pjob-info">
                <div class="pjob-title">${bld.icon} ${escapeHtml(bld.name)} — ${escapeHtml(plot.name)} <span style="font-weight:normal;font-size:11px">(${escapeHtml(zInfo.shortName)}, податок ${fin.turnoverTaxPct}%)</span></div>
                <div class="pjob-meta">Власник: <b>${escapeHtml(owned.owner)}</b> • Штат: ${workersCount} роб. • У касі бізнесу: <b>${formatNumberFull(treasury)} 💰</b></div>
                <div class="pjob-wage">ЗП вам: <b>+${formatNumberFull(wage)} 💰</b>/замовл. • Чек з вашими курсами (+${fin.skillBonusPct}%): <b>${fin.grossCheck} 💰</b></div>
            </div>
            <div>${actionBtnHtml}</div>
        </div>`;
    });
    listEl.innerHTML = html;
}

function buildWorkersRosterHtml(plotId, owned, bld, prefix = "map") {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const plotZone = p ? p.zone : "residential";
    const workersMap = owned.workers || {};
    const workersArr = Object.entries(workersMap);
    const isOwner = owned.owner === currentUser;
    const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : (bld ? bld.defaultWage : 15);

    if (!workersArr.length) {
        return `<div class="muted" style="text-align:center;padding:8px;background:#f8f8f8;border:1px dashed #808080">На цьому підприємстві ще немає найманих робітників. Коли гравці подадуть резюме на Пошту або приймуть ваше запрошення за координатами — тут з'явиться їхній розрахунок прибутку!</div>`;
    }

    workersArr.sort((a, b) => (Number(b[1]?.orders) || 0) - (Number(a[1]?.orders) || 0));

    return workersArr.map(([wName, wData]) => {
        const pWage = Number(wData?.personalWage) > 0 ? Number(wData.personalWage) : baseWage;
        const role = wData?.role || "Робітник зміни";
        const orders = Number(wData?.orders) || 0;
        const totalEarned = Number(wData?.totalEarned) || 0;
        const wCourses = Array.isArray(wData?.completedCourses) ? wData.completedCourses : [];
        const fin = calcOrderFinancials(plotZone, bld, wCourses, pWage);
        const netTotalBrought = wData?.netMarginBrought !== undefined
            ? Number(wData.netMarginBrought)
            : (orders * fin.ownerNetMargin);
        const lastAgo = formatTimeAgo(wData?.lastWorkAt);

        const safeId = `${prefix}_${plotId}_${wName.replace(/[^a-zA-Z0-9_]/g, "")}`;
        const roleOptions = OWNER_ASSIGNED_TITLES.map(t =>
            `<option value="${escapeHtml(t)}"${t === role ? " selected" : ""}>${escapeHtml(t)}</option>`
        ).join("");

        const isPositive = fin.ownerNetMargin >= 0;
        const marginText = isPositive
            ? `+${formatNumberFull(fin.ownerNetMargin)} 💰 у касу`
            : `${formatNumberFull(fin.ownerNetMargin)} 💰 ЗБИТОК!`;

        return `
            <div class="worker-row">
                <div class="worker-row-top">
                    <div>
                        <span class="w-name">👷 ${escapeHtml(wName)}</span>
                        <span class="w-role">${escapeHtml(role)}</span>
                        <span style="font-size:10px;color:#555">(${lastAgo})</span>
                    </div>
                    <span class="w-wage-badge">ЗП робітнику: ${formatNumberFull(pWage)} 💰</span>
                </div>

                <div class="receipt-pills-row" style="margin:3px 0">
                    <span class="receipt-pill">🛒 Чек клієнта: <b>+${fin.grossCheck} 💰</b> (курси +${fin.skillBonusPct}%)</span>
                    <span class="receipt-pill tax">🏛️ Податок (${fin.turnoverTaxPct}%): <b>-${fin.taxAmount} 💰</b></span>
                    <span class="receipt-pill wage">👷 ЗП: <b>-${fin.wage} 💰</b></span>
                    <span class="receipt-pill ${isPositive ? "net-pos" : "net-neg"}">📈 Ваша маржа з замовлення: ${marginText}</span>
                </div>

                <div class="w-stats">
                    <span>📦 Виконано замовлень: <b>${formatNumberFull(orders)}</b></span>
                    <span>💵 Виплачено ЗП: <b>${formatNumberFull(totalEarned)} 💰</b></span>
                    <span>🏦 Всього приніс вам чистими в Касу: <b style="color:${netTotalBrought >= 0 ? "#006400" : "#900000"}">${netTotalBrought >= 0 ? "+" : ""}${formatNumberFull(netTotalBrought)} 💰</b></span>
                </div>

                <div style="font-size:11px;margin-top:2px">
                    <b>Дипломи робітника:</b> ${renderCourseChipsHtml(wCourses, plotZone)}
                </div>

                ${isOwner ? `
                <div class="worker-owner-actions">
                    <button class="btn success" onclick="raiseWorkerWage(${plotId}, '${escapeHtml(wName)}', 1.25)" title="Підвищити ЗП на +25% та підняти посаду">⬆️ Підвищити ЗП (+25%)</button>
                    <select id="role_${safeId}" class="input-field" style="max-width:130px;padding:2px 4px;font-size:11px;height:28px">${roleOptions}</select>
                    <input type="number" id="wage_${safeId}" class="input-field" value="${pWage}" min="5" max="50000" title="Індивідуальна ЗП (беззбитково до ${fin.afterTaxRevenue} 💰)">
                    <button class="btn default" onclick="setWorkerCustomWage(${plotId}, '${escapeHtml(wName)}', 'wage_${safeId}', 'role_${safeId}')">💾 Зберегти ЗП</button>
                    <button class="btn" onclick="openConversationHistory('${escapeHtml(wName)}')" title="Історія переписки з працівником">💬 Чат</button>
                    <button class="btn danger" onclick="fireWorkerFromPlot(${plotId}, '${escapeHtml(wName)}')" title="Звільнити працівника">✕ Звільнити</button>
                </div>` : ""}
            </div>
        `;
    }).join("");
}

window.previewHubBaseWageMargin = function (plotId) {
    const p = MAP_PLOTS_BASE.find(x => x.id === plotId);
    const owned = getOwnedPlotData(plotId);
    if (!p || !owned || !owned.building) return;
    const bld = getBuildingDef(p.zone, owned.building);
    const inp = $("hub_basewage_" + plotId);
    const hintEl = $("hub_wage_hint_" + plotId);
    if (!inp || !hintEl || !bld) return;
    const testWage = Math.max(1, Math.floor(Number(inp.value) || bld.defaultWage));
    const fin = calcOrderFinancials(p.zone, bld, [], testWage);
    if (fin.ownerNetMargin >= 0) {
        hintEl.innerHTML = `✅ При ЗП <b>${testWage} 💰</b> (без курсів): чек <b>${fin.grossCheck} 💰</b> − податок <b>${fin.taxAmount} 💰</b> − ЗП <b>${testWage} 💰</b> = <b style="color:#006400">ваш чистий плюс +${fin.ownerNetMargin} 💰 у касу</b> (з курсами робітника буде ще більше!)`;
    } else {
        hintEl.innerHTML = `⚠️ При ЗП <b>${testWage} 💰</b> ви будете <b style="color:#900000">В МІНУСІ на ${fin.ownerNetMargin} 💰</b> з замовлення (максимальна беззбиткова ЗП без курсів: <b>${fin.afterTaxRevenue} 💰</b>)!`;
    }
};

window.previewMapOwnerWageMargin = function () {
    if (selectedPlotId === null) return;
    const p = MAP_PLOTS_BASE.find(x => x.id === selectedPlotId);
    const owned = getOwnedPlotData(selectedPlotId);
    const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
    const inp = $("owner-wage-input");
    const hintEl = $("owner-wage-preview-hint");
    if (!inp || !hintEl || !p || !bld) return;
    const testWage = Math.max(1, Math.floor(Number(inp.value) || bld.defaultWage));
    const fin = calcOrderFinancials(p.zone, bld, [], testWage);
    if (fin.ownerNetMargin >= 0) {
        hintEl.innerHTML = `✅ Чиста маржа власника (без курсів): <b style="color:#006400">+${fin.ownerNetMargin} 💰 у касу</b> за замовлення (податок -${fin.taxAmount} 💰).`;
    } else {
        hintEl.innerHTML = `⚠️ <b style="color:#900000">ЗБИТОК ${fin.ownerNetMargin} 💰 з каси!</b> Чек після податку становить лише <b>${fin.afterTaxRevenue} 💰</b>.`;
    }
};

function renderOwnerBusinessesHub() {
    const masterEl = $("owner-master-summary");
    const hubEl = $("owner-businesses-hub");
    const badgeEl = $("badge-mybiz");
    if (!hubEl) return;

    const myOwnedPlots = [];
    let totalWorkersAcrossBiz = 0;

    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === currentUser) {
            const bld = getBuildingDef(p.zone, owned.building);
            const wCount = owned.workers ? Object.keys(owned.workers).length : 0;
            totalWorkersAcrossBiz += wCount;
            myOwnedPlots.push({ plot: p, owned, bld, wCount });
        }
    });

    if (badgeEl) {
        badgeEl.textContent = totalWorkersAcrossBiz > 0 ? `${myOwnedPlots.length} (${totalWorkersAcrossBiz}👷)` : myOwnedPlots.length;
    }

    const totalTreasury = getTotalOwnerTreasury();
    const portfolio = getPlayerPortfolioHourlyBreakdown(currentUser);

    if (masterEl) {
        if (!myOwnedPlots.length) {
            masterEl.innerHTML = "";
        } else {
            const netSign = portfolio.netTotal >= 0 ? `+${formatNumberFull(portfolio.netTotal)} 💰/год (у плюсі)` : `${formatNumberFull(portfolio.netTotal)} 💰/год (у мінусі через податки!)`;
            masterEl.innerHTML = `
                <div class="cashbox-master-banner">
                    <div class="cashbox-master-left">
                        <span class="cashbox-master-title">🏦 ЗАГАЛЬНА КАСА ВАШИХ ПІДПРИЄМСТВ (ГОТОВА ДО ВИВЕДЕННЯ):</span>
                        <span class="cashbox-master-amount">💰 ${formatNumberFull(totalTreasury)} монет</span>
                        <span class="cashbox-master-sub">
                            Погодинний обіг будівель: <b>+${formatNumberFull(portfolio.grossTotal)}/год</b> •
                            Податок на землю: <b style="color:#ff9999">-${formatNumberFull(portfolio.landTaxTotal)}/год</b> •
                            Податок зон: <b style="color:#ff9999">-${formatNumberFull(portfolio.turnoverTaxTotal)}/год</b> ➔
                            <b>Підсумок: ${netSign}</b>
                        </span>
                    </div>
                    <button class="btn success" onclick="withdrawAllPlotsTreasury()" ${totalTreasury <= 0 ? "disabled" : ""} style="min-height:38px;padding:6px 14px;font-size:13px;font-weight:bold">
                        💰 Забрати ВСЮ Касу в гаманець (+${formatNumberFull(totalTreasury)} 💰)
                    </button>
                </div>
            `;
        }
    }

    if (!myOwnedPlots.length) {
        hubEl.innerHTML = `<div class="muted" style="padding:14px;text-align:center">У вас поки немає куплених ділянок чи підприємств.<br>Перейдіть у вкладку <b>«🗺️ Мапа»</b>, купіть ділянку та збудуйте підприємство!</div>`;
        return;
    }

    hubEl.innerHTML = myOwnedPlots.map(({ plot, owned, bld }) => {
        const calc = calcPlotHourlyTaxAndNet(plot, owned);
        const zInfo = ZONE_INFO[plot.zone] || ZONE_INFO.residential;

        if (!bld) {
            return `
                <div class="group-box" data-label="⚠️ Незабудована земля: ${escapeHtml(plot.name)} (${escapeHtml(zInfo.shortName)})" style="margin-top:8px;background:#fff0f0">
                    <div style="font-size:12px;color:#800000;line-height:1.45">
                        <b>На цій ділянці ще немає будівлі!</b> Порожня земля приносить <b>0 💰 доходу</b>, але обкладається <b>податком на землю (${calc.landTaxPct}%/год = -${formatNumberFull(calc.landTax)} 💰 щогодини)</b>.<br>
                        Збудуйте тут підприємство на мапі або продайте ділянку місту, щоб не йти в мінус!
                    </div>
                    <div class="btn-row" style="margin-top:6px;justify-content:flex-start">
                        <button class="btn default" onclick="focusPlotFromMail(${plot.id})" style="min-height:30px;padding:4px 10px;font-size:11px">🏗️ Перейти на мапу і забудувати</button>
                        <button class="btn danger" onclick="sellPlotToCity(${plot.id})" style="min-height:30px;padding:4px 10px;font-size:11px">🏷️ Продати землю місту (повернути 75%)</button>
                    </div>
                </div>
            `;
        }

        const baseWage = Number(owned.wage) > 0 ? Number(owned.wage) : bld.defaultWage;
        const treasury = Math.max(0, Number(owned.treasury) || 0);
        const fin = calcOrderFinancials(plot.zone, bld, [], baseWage);
        const isOrderProfitable = fin.ownerNetMargin >= 0;

        return `
            <div class="group-box" data-label="${bld.icon} ${escapeHtml(bld.name)} — ${escapeHtml(plot.name)} (${escapeHtml(zInfo.shortName)})" style="margin-top:10px">
                <div class="biz-cash-highlight">
                    <div>
                        <div style="font-size:11px;color:#004000;font-weight:bold">🏦 КАСА ПІДПРИЄМСТВА (гроші з замовлень і погодинної роботи):</div>
                        <div class="cash-big">💰 У касі зараз: ${formatNumberFull(treasury)} монет</div>
                    </div>
                    <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
                        <button class="btn success" onclick="withdrawPlotTreasury(${plot.id}, 'hub_fund_${plot.id}', true)" ${treasury <= 0 ? "disabled" : ""} style="min-height:32px;padding:4px 12px;font-size:12px;font-weight:bold">
                            💰 Забрати в гаманець (+${formatNumberFull(treasury)})
                        </button>
                        <input type="number" class="input-field" id="hub_fund_${plot.id}" placeholder="Сума..." min="10" style="max-width:80px;padding:3px 6px;font-size:12px">
                        <button class="btn" onclick="fundPlotTreasury(${plot.id}, 'hub_fund_${plot.id}')" style="min-height:30px;min-width:auto;padding:3px 8px;font-size:11px" title="Покласти монети з гаманця в касу">➕ В касу</button>
                    </div>
                </div>

                <div class="receipt-breakdown">
                    <div class="receipt-breakdown-title">🧾 Як розподіляються гроші з 1 замовлення клієнта (при базовій ЗП ${baseWage} 💰):</div>
                    <div class="receipt-pills-row">
                        <span class="receipt-pill">🛒 Покупець платить: <b>+${fin.grossCheck} 💰</b></span>
                        <span>➔</span>
                        <span class="receipt-pill tax">🏛️ Податок зони (${fin.turnoverTaxPct}%): <b>-${fin.taxAmount} 💰</b></span>
                        <span>➔</span>
                        <span class="receipt-pill wage">👷 ЗП робітнику: <b>-${fin.wage} 💰</b></span>
                        <span>=</span>
                        <span class="receipt-pill ${isOrderProfitable ? "net-pos" : "net-neg"}">
                            📈 Ваш ЧИСТИЙ ПЛЮС у касу: ${isOrderProfitable ? "+" + fin.ownerNetMargin + " 💰" : fin.ownerNetMargin + " 💰 (ЗБИТОК!)"}
                        </span>
                    </div>
                    <div style="margin-top:4px;font-size:11px;color:#333">
                        ⏱️ <b>Погодинний баланс будівлі:</b> Валовий дохід <b>+${formatNumberFull(calc.grossIncome)}/год</b> (бонус штату +${calc.bonusPct || 0}%)
                        − Податок на землю (${calc.landTaxPct}%): <b style="color:#800000">-${formatNumberFull(calc.landTax)}/год</b>
                        − Податок зони (${calc.turnoverTaxPct}%): <b style="color:#800000">-${formatNumberFull(calc.turnoverTax)}/год</b>
                        = <b style="color:${calc.netIncome >= 0 ? "#006400" : "#900000"}">Чистими в касу: ${calc.netIncome >= 0 ? "+" : ""}${formatNumberFull(calc.netIncome)} 💰/год</b>
                    </div>
                </div>

                <!-- БЛОК ПОТОКУ КЛІЄНТІВ, ІНФРАСТРУКТУРИ ТА РЕКЛАМИ -->
                ${(() => {
                    const cs = getPlotClientsState(plot, owned);
                    const upgs = owned.upgrades || {};
                    const upgHtml = BUSINESS_UPGRADES.map(u => {
                        const isOwned = Boolean(upgs[u.id]);
                        return `<div class="infra-card${isOwned ? " owned" : ""}">
                            <div><b>${u.name}</b><br><span style="color:#444">${u.desc}</span></div>
                            ${isOwned
                                ? `<span style="color:#006400;font-weight:bold">✓ Встановлено</span>`
                                : `<button class="btn default" onclick="buyPlotUpgrade(${plot.id}, '${u.id}')" style="min-height:24px;min-width:auto;padding:2px 6px;font-size:10px">Купити (${formatNumberFull(u.cost)} 💰)</button>`
                            }
                        </div>`;
                    }).join("");
                    const adsHtml = BUSINESS_ADS.map(a => `
                        <button class="btn" onclick="buyPlotAd(${plot.id}, '${a.id}')" style="min-height:26px;min-width:auto;padding:3px 7px;font-size:10px" title="${a.desc}">${a.name} (${formatNumberFull(a.cost)} 💰)</button>
                    `).join("");
                    return `
                        <div class="clients-status-bar">
                            <span>🚶 <b>Клієнти на підприємстві: ${cs.current} / ${cs.max}</b> (потік: <b>${cs.perHour}/год</b>${cs.current < cs.max ? `, наступний через ${cs.nextClientSec}с` : ""})</span>
                            ${cs.adActive ? `<span class="ad-active-pill">📢 ${escapeHtml(cs.adName)} (+${cs.adMultPct}%, ще ${formatDuration(cs.adRemainingMs)})</span>` : ""}
                        </div>
                        <div style="margin-bottom:6px">
                            <div style="font-size:11px;font-weight:bold;color:#000080;margin-bottom:3px">🏗️ Покращення потоку клієнтів (назавжди) та 📢 Реклама (тимчасово):</div>
                            <div class="infra-ads-grid">${upgHtml}</div>
                            <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">${adsHtml}</div>
                        </div>
                    `;
                })()}

                <div class="bank-input-wrap" style="margin-bottom:6px">
                    <span style="font-size:11px;font-weight:bold">ЗП за замовлення:</span>
                    <input type="number" class="input-field" id="hub_basewage_${plot.id}" value="${baseWage}" min="5" max="50000" oninput="previewHubBaseWageMargin(${plot.id})" style="max-width:85px;padding:3px 6px;font-size:12px">
                    <button class="btn default" onclick="savePlotWage(${plot.id}, 'hub_basewage_${plot.id}', false)" style="min-height:28px;min-width:auto;padding:3px 8px;font-size:11px">💾 Для нових</button>
                    <button class="btn" onclick="savePlotWage(${plot.id}, 'hub_basewage_${plot.id}', true)" style="min-height:28px;min-width:auto;padding:3px 8px;font-size:11px" title="Застосувати цю ЗП до всіх поточних працівників">👥 Застосувати всім</button>
                    <button class="btn success" onclick="openJobInviteMail(${plot.id})" style="min-height:28px;min-width:auto;padding:3px 10px;font-size:11px" title="Надіслати гравцю координати цього місця для роботи">📍 Запросити</button>
                </div>
                <div id="hub_wage_hint_${plot.id}" style="font-size:11px;margin-bottom:6px;color:#004000"></div>

                <div class="workers-roster" style="max-height:240px">
                    ${buildWorkersRosterHtml(plot.id, owned, bld, "hub")}
                </div>
            </div>
        `;
    }).join("");
}

// ===== ВКЛАДКА «🏛️ ПОЛІТИКА» =====
window.saveAdminTaxPolicy = async function () {
    if (!isAdminUser()) return;
    const resTurn = Math.max(0, Math.min(50, Number($("pol_res_turn")?.value) || 8));
    const resLand = Math.max(0.1, Math.min(5, Number($("pol_res_land")?.value) || 0.4));
    const comTurn = Math.max(0, Math.min(50, Number($("pol_com_turn")?.value) || 12));
    const comLand = Math.max(0.1, Math.min(5, Number($("pol_com_land")?.value) || 0.5));
    const indTurn = Math.max(0, Math.min(50, Number($("pol_ind_turn")?.value) || 16));
    const indLand = Math.max(0.1, Math.min(5, Number($("pol_ind_land")?.value) || 0.6));

    const newPolicy = {
        residential: { turnoverTaxPct: resTurn, landTaxPct: resLand },
        commercial:  { turnoverTaxPct: comTurn, landTaxPct: comLand },
        industrial:  { turnoverTaxPct: indTurn, landTaxPct: indLand },
        updatedAt: Date.now(),
        updatedBy: currentUser
    };

    try {
        await set(ref(db, `users/${currentUser}/clicker/cityPolicy`), newPolicy);
        cityTaxPolicy = newPolicy;
        sfx.win();
        renderAll();
        setGameStatus("🏛️ Податкову політику м. Ковель оновлено для всіх гравців!");
        showDialog("Податки оновлено!", "Нові податкові ставки для Житлової, Комерційної та Промислової зон набули чинності!", "🏛️");
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

function renderPoliticsPage() {
    const zonesGrid = $("politics-zones-grid");
    const adminBox = $("politics-admin-box");
    const adminCtrl = $("politics-admin-controls");
    const ledgerEl = $("politics-player-ledger");
    if (!zonesGrid || !ledgerEl) return;

    const zonesOrder = [
        { key: "residential", cls: "res" },
        { key: "commercial",  cls: "com" },
        { key: "industrial",  cls: "ind" }
    ];

    zonesGrid.innerHTML = zonesOrder.map(({ key, cls }) => {
        const zInfo = ZONE_INFO[key];
        const rates = getZoneTaxRates(key);
        const sampleLandTax = Math.round(zInfo.basePrice * (rates.landTaxPct / 100));
        return `
            <div class="politics-card ${cls}">
                <div class="politics-card-title">${zInfo.name}</div>
                <div style="font-size:11px;color:#333;min-height:30px">${escapeHtml(zInfo.desc)}</div>
                <div class="politics-rate-row">
                    <span>🧾 Податок з обороту / замовлень:</span>
                    <span class="politics-rate-val">${rates.turnoverTaxPct}%</span>
                </div>
                <div class="politics-rate-row">
                    <span>🌍 Податок на землю (щогодини):</span>
                    <span class="politics-rate-val">${rates.landTaxPct}% / год</span>
                </div>
                <div style="font-size:11px;color:#004000;margin-top:2px">
                    • Базова ціна землі: <b>${formatNumberFull(zInfo.basePrice)} 💰</b><br>
                    • Базовий податок на землю: <b>~${formatNumberFull(sampleLandTax)} 💰/год</b>
                </div>
            </div>
        `;
    }).join("");

    if (adminBox && adminCtrl) {
        if (isAdminUser()) {
            adminBox.style.display = "block";
            const rRes = getZoneTaxRates("residential");
            const rCom = getZoneTaxRates("commercial");
            const rInd = getZoneTaxRates("industrial");
            adminCtrl.innerHTML = `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;font-size:11px">
                    <div style="background:#fff;padding:6px;border:1px solid #808080">
                        <b>🏡 Житлова зона:</b><br>
                        Оборот (%): <input type="number" id="pol_res_turn" class="input-field" value="${rRes.turnoverTaxPct}" min="0" max="50" style="max-width:60px;padding:2px 4px"><br>
                        Земля (%/год): <input type="number" id="pol_res_land" class="input-field" value="${rRes.landTaxPct}" step="0.1" min="0.1" max="5" style="max-width:60px;padding:2px 4px;margin-top:3px">
                    </div>
                    <div style="background:#fff;padding:6px;border:1px solid #808080">
                        <b>🏪 Комерційна зона:</b><br>
                        Оборот (%): <input type="number" id="pol_com_turn" class="input-field" value="${rCom.turnoverTaxPct}" min="0" max="50" style="max-width:60px;padding:2px 4px"><br>
                        Земля (%/год): <input type="number" id="pol_com_land" class="input-field" value="${rCom.landTaxPct}" step="0.1" min="0.1" max="5" style="max-width:60px;padding:2px 4px;margin-top:3px">
                    </div>
                    <div style="background:#fff;padding:6px;border:1px solid #808080">
                        <b>🏭 Промислова зона:</b><br>
                        Оборот (%): <input type="number" id="pol_ind_turn" class="input-field" value="${rInd.turnoverTaxPct}" min="0" max="50" style="max-width:60px;padding:2px 4px"><br>
                        Земля (%/год): <input type="number" id="pol_ind_land" class="input-field" value="${rInd.landTaxPct}" step="0.1" min="0.1" max="5" style="max-width:60px;padding:2px 4px;margin-top:3px">
                    </div>
                </div>
                <div class="btn-row" style="margin-top:6px">
                    <button class="btn default" onclick="saveAdminTaxPolicy()">💾 Затвердити нові податки по місту</button>
                </div>
            `;
        } else {
            adminBox.style.display = "none";
        }
    }

    const myPlots = [];
    MAP_PLOTS_BASE.forEach(p => {
        const owned = getOwnedPlotData(p.id);
        if (owned && owned.owner === currentUser) {
            myPlots.push({ plot: p, owned, bld: getBuildingDef(p.zone, owned.building), calc: calcPlotHourlyTaxAndNet(p, owned) });
        }
    });

    if (!myPlots.length) {
        ledgerEl.innerHTML = `<div class="muted" style="padding:10px;text-align:center">У вас наразі немає земельних ділянок у власності, тому земельний податок з вас не стягується.</div>`;
        return;
    }

    const pf = getPlayerPortfolioHourlyBreakdown(currentUser);
    const totalNetColor = pf.netTotal >= 0 ? "#006400" : "#900000";

    ledgerEl.innerHTML = `
        <div style="background:#fffff0;border:1px solid #808080;padding:8px;margin-bottom:8px;font-size:12px;line-height:1.5">
            <div><b>Ваші володіння:</b> ділянок <b>${pf.plotsCount}</b> (забудовано: <b>${pf.builtCount}</b>, пустих: <b>${pf.plotsCount - pf.builtCount}</b>)</div>
            <div>• Сумарний валовий дохід будівель: <b style="color:#006400">+${formatNumberFull(pf.grossTotal)} 💰/год</b></div>
            <div>• Податок на землю по всіх ділянках: <b style="color:#800000">-${formatNumberFull(pf.landTaxTotal)} 💰/год</b></div>
            <div>• Податок з обороту по зонах: <b style="color:#800000">-${formatNumberFull(pf.turnoverTaxTotal)} 💰/год</b></div>
            <div style="border-top:1px solid #a0a0a0;margin-top:4px;padding-top:4px;font-size:13px">
                📈 <b>Чистий погодинний підсумок (у Касу після всіх податків): <span style="color:${totalNetColor}">${pf.netTotal >= 0 ? "+" : ""}${formatNumberFull(pf.netTotal)} 💰/год</span></b>
            </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow-y:auto">
            ${myPlots.map(({ plot, owned, bld, calc }) => {
                const zInfo = ZONE_INFO[plot.zone];
                const netPositive = calc.netIncome >= 0;
                return `
                    <div style="background:#ffffff;border:1px solid #808080;padding:6px 8px;font-size:11px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
                        <div>
                            <b>#${plot.id + 1} ${escapeHtml(plot.name)}</b> (${escapeHtml(zInfo.shortName)}) —
                            ${bld ? `<b>${bld.icon} ${escapeHtml(bld.name)}</b>` : `<b style="color:#900000">⚠️ Порожня земля (без будівлі!)</b>`}<br>
                            Валовий дохід: <b>+${formatNumberFull(calc.grossIncome)}/год</b> |
                            Податок на землю (${calc.landTaxPct}%): <b style="color:#800000">-${formatNumberFull(calc.landTax)}/год</b> |
                            Податок зони (${calc.turnoverTaxPct}%): <b style="color:#800000">-${formatNumberFull(calc.turnoverTax)}/год</b>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px">
                            <span class="receipt-pill ${netPositive ? "net-pos" : "net-neg"}">
                                ${netPositive ? "+" + formatNumberFull(calc.netIncome) + " 💰/год" : formatNumberFull(calc.netIncome) + " 💰/год (ЗБИТОК)"}
                            </span>
                            ${!bld ? `<button class="btn danger" onclick="sellPlotToCity(${plot.id})" style="min-height:24px;min-width:auto;padding:2px 6px;font-size:10px">🏷️ Продати</button>` : ""}
                        </div>
                    </div>
                `;
            }).join("")}
        </div>
    `;
}

function renderStats() {
    $("stat-coins").textContent = formatNumber(gameState.coins);
    $("stat-boost").textContent = gameState.xpBoost + "%";
    const resBoost = getWorkerZoneSkillBonusPct(gameState.completedCourses, "residential");
    const comBoost = getWorkerZoneSkillBonusPct(gameState.completedCourses, "commercial");
    const indBoost = getWorkerZoneSkillBonusPct(gameState.completedCourses, "industrial");
    if ($("stat-res-boost")) $("stat-res-boost").textContent = "+" + resBoost + "%";
    if ($("stat-com-boost")) $("stat-com-boost").textContent = "+" + comBoost + "%";
    if ($("stat-ind-boost")) $("stat-ind-boost").textContent = "+" + indBoost + "%";

    const incPerHour = getTotalPassiveIncomePerHour();
    const totalTreasury = getTotalOwnerTreasury();
    $("big-coins").textContent = formatNumberFull(gameState.coins);

    if ($("hud-coins")) $("hud-coins").textContent = formatNumberFull(gameState.coins);
    if ($("hud-treasury")) $("hud-treasury").textContent = formatNumberFull(totalTreasury) + " 💰";
    if ($("hud-income")) {
        $("hud-income").textContent = (incPerHour >= 0 ? "+" : "") + formatNumber(incPerHour) + "/год";
        $("hud-income").style.color = incPerHour >= 0 ? "#006400" : "#900000";
    }

    const promoteBtn = $("promote-btn");
    const xpWrap = $("career-xp-wrap");

    if (gameState.employer === "corp") {
        const job = getCurrentCorpJob();
        const nextJob = JOBS[gameState.jobIndex + 1] || null;
        $("stat-job").textContent = job.name;
        if ($("hud-job")) $("hud-job").textContent = `КовельКорп: ${job.name}`;
        $("stat-xp").textContent = formatNumber(gameState.xp);
        if (xpWrap) xpWrap.style.display = "block";

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
                : `🔒 Потрібен курс «${getCourseName(nextJob.reqCourse)}» (або дорожчий)`;
        } else {
            promoteBtn.classList.remove("show");
        }
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        const wRec = getWorkerRecordOnPlot(pid, currentUser);
        $("stat-job").textContent = wRec.role;
        if ($("hud-job")) $("hud-job").textContent = `${wRec.role} (${wRec.personalWage} 💰)`;
        $("stat-xp").textContent = `${wRec.orders} зам.`;
        if (xpWrap) xpWrap.style.display = "none";
        promoteBtn.classList.remove("show");
    } else {
        $("stat-job").textContent = "Підробіток";
        if ($("hud-job")) $("hud-job").textContent = "Підробіток";
        $("stat-xp").textContent = formatNumber(gameState.xp);
        if (xpWrap) xpWrap.style.display = "none";
        promoteBtn.classList.remove("show");
    }
}

function renderTask() {
    const barEl = $("task-bar");
    const now = Date.now();
    const onCooldown = workCooldownUntil > now;
    const remMs = Math.max(0, workCooldownUntil - now);

    if (gameState.employer === "corp") {
        if (barEl) barEl.classList.remove("cooldown-bar");
        const job = getCurrentCorpJob();
        const needed = job.taskClicks;
        const prog = gameState.taskActive ? Math.floor(gameState.taskProgress) : 0;
        $("task-bar").style.width = (needed > 0 ? Math.min(100, (gameState.taskProgress / needed) * 100) : 0) + "%";
        $("task-text").textContent = prog + " / " + needed;
        $("task-reward").textContent = "Нагорода за ІТ-задачу: +" + formatNumberFull(job.taskReward) + " 💰";
        $("task-title").textContent = gameState.taskActive ? "Активна ІТ-задача (" + job.name + ")" : "КовельКорп: Задача очікує запуску";
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        const p = MAP_PLOTS_BASE.find(x => x.id === pid);
        const owned = getOwnedPlotData(pid);
        const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
        const wRec = getWorkerRecordOnPlot(pid, currentUser);
        const fin = calcOrderFinancials(p ? p.zone : "residential", bld, gameState.completedCourses, wRec.personalWage);
        const step = Math.floor(gameState.taskProgress) % ORDER_STEPS_REQUIRED;

        if (onCooldown && workCooldownReason === "order") {
            if (barEl) barEl.classList.add("cooldown-bar");
            const pct = Math.min(100, ((workCooldownTotalMs - remMs) / workCooldownTotalMs) * 100);
            $("task-bar").style.width = pct + "%";
            $("task-text").textContent = `⏳ Перерва між клієнтами: ${(remMs / 1000).toFixed(1)}с`;
        } else {
            if (barEl) barEl.classList.remove("cooldown-bar");
            $("task-bar").style.width = ((step / ORDER_STEPS_REQUIRED) * 100) + "%";
            $("task-text").textContent = `Етап замовлення: ${step} / ${ORDER_STEPS_REQUIRED}`;
        }
        const cs = p && owned ? getPlotClientsState(p, owned) : { current: 0, max: 0, nextClientSec: 0 };
        $("task-reward").textContent = `ЗП: +${formatNumberFull(wRec.personalWage)} 💰 | Клієнтів у черзі: ${cs.current}/${cs.max} | Чек: ${fin.grossCheck} 💰 (податок -${fin.taxAmount})`;
        $("task-title").textContent = `${bld ? bld.icon + " " + bld.name : "Підприємство"} (${owned?.owner || "—"}) — Посада: ${wRec.role}`;
    } else {
        const step = Math.floor(gameState.taskProgress);
        if (onCooldown && workCooldownReason === "order") {
            if (barEl) barEl.classList.add("cooldown-bar");
            const pct = Math.min(100, ((workCooldownTotalMs - remMs) / workCooldownTotalMs) * 100);
            $("task-bar").style.width = pct + "%";
            $("task-text").textContent = `⏳ Перепочинок: ${(remMs / 1000).toFixed(1)}с`;
        } else {
            if (barEl) barEl.classList.remove("cooldown-bar");
            const progPct = gameState.taskActive ? Math.min(100, (step / 6) * 100) : 0;
            $("task-bar").style.width = progPct + "%";
            $("task-text").textContent = gameState.taskActive ? `Розчищено: ${step} / 6` : "Готово до прибирання";
        }
        $("task-reward").textContent = `Оплата двірника: +${MUNICIPAL_TASK_REWARD} 💰 за ділянку (міні-гра розчищення)`;
        $("task-title").textContent = "Муніципальний підробіток — Двірник м. Ковель";
    }
}

// ВИМОГА 3: Кнопка паузи курсу прямо на банері навчання; коли курс на паузі — кнопка роботи ВІДКРИТА!
function updateWorkButtonState() {
    const btn = $("big-click"), label = $("big-click-label"), sub = $("big-click-sub"), emoji = $("big-click-emoji");
    const blocker = $("course-blocker"), blockerMsg = $("course-blocker-msg"), pauseBtn = $("course-pause-btn");
    if (!btn) return;

    if (hasActiveOrPausedCourse()) {
        const c = COURSES.find(x => x.id === gameState.activeCourseId);
        const cName = c ? c.name : "Курс";
        const remStr = formatDuration(getRemainingCourseMs());
        blocker.classList.add("show");

        if (gameState.coursePaused) {
            blocker.classList.add("paused-mode");
            if (blockerMsg) blockerMsg.innerHTML = `⏸️ Курс <b>«${escapeHtml(cName)}»</b> стоїть на ПАУЗІ. Ви можете вільно працювати!`;
            $("course-blocker-timer").textContent = "Залишилось довчити: " + remStr;
            if (pauseBtn) {
                pauseBtn.textContent = "▶️ Продовжити навчання з паузи";
                pauseBtn.className = "btn success";
            }
        } else {
            blocker.classList.remove("paused-mode");
            if (blockerMsg) blockerMsg.innerHTML = `📚 Зараз ви проходите курс <b>«${escapeHtml(cName)}»</b>. Щоб попрацювати — натисніть «Поставити на паузу»!`;
            $("course-blocker-timer").textContent = "Залишилось: " + remStr;
            if (pauseBtn) {
                pauseBtn.textContent = "⏸️ Поставити на паузу (піти працювати)";
                pauseBtn.className = "btn default";
            }

            miniGames.stop();
            btn.style.display = "flex";
            btn.disabled = true;
            btn.classList.remove("cooldown-active");
            if (emoji) emoji.textContent = "📚";
            label.textContent = "ТРИВАЄ НАВЧАННЯ";
            if (sub) sub.textContent = "Натисніть «Поставити на паузу» вище, якщо хочете працювати";
            return;
        }
    } else {
        blocker.classList.remove("show");
        blocker.classList.remove("paused-mode");
    }

    const now = Date.now();
    const remMs = Math.max(0, workCooldownUntil - now);
    const debtNote = isBankBlocked() ? " • ⚠️ Працюйте, щоб погасити прострочений кредит!" : "";

    if (gameState.employer === "corp") {
        btn.classList.remove("cooldown-active");
        if (miniGames.isRunning()) {
            btn.style.display = "none";
        } else {
            btn.style.display = "flex";
            btn.disabled = false;
            if (emoji) emoji.textContent = "💻";
            label.textContent = gameState.taskActive ? "ПРОДОВЖИТИ ІТ-ЗАДАЧУ" : "ПОЧАТИ ІТ-ЗАДАЧУ (МІНІ-ГРА)";
            if (sub) sub.textContent = "Виконайте інтерактивне ІТ-завдання КовельКорп" + debtNote;
        }
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        miniGames.stop();
        btn.style.display = "flex";
        const pid = getActiveEmployerPlotId();
        const wRec = getWorkerRecordOnPlot(pid, currentUser);
        const step = Math.floor(gameState.taskProgress) % ORDER_STEPS_REQUIRED;

        if (remMs > 0) {
            btn.disabled = true;
            btn.classList.add("cooldown-active");
            if (emoji) emoji.textContent = "⏳";
            if (workCooldownReason === "order") {
                label.textContent = `ПЕРЕРВА МІЖ КЛІЄНТАМИ (${(remMs / 1000).toFixed(1)}с)`;
                if (sub) sub.textContent = "Замовлення закрито! Готуємо місце для наступного клієнта...";
            } else {
                label.textContent = `ВИКОНУЄТЬСЯ ДІЯ... (${(remMs / 1000).toFixed(1)}с)`;
                if (sub) sub.textContent = `Завершено крок ${step} із ${ORDER_STEPS_REQUIRED}`;
            }
        } else {
            btn.disabled = false;
            btn.classList.remove("cooldown-active");
            if (emoji) emoji.textContent = step === ORDER_STEPS_REQUIRED - 1 ? "✅" : "🛒";
            label.textContent = PRIVATE_ORDER_STAGE_LABELS[step];
            if (sub) sub.textContent = `Після 5 кроків ви отримаєте +${formatNumberFull(wRec.personalWage)} 💰 зарплати` + debtNote;
        }
    } else {
        if (miniGames.isRunning()) {
            btn.style.display = "none";
        } else {
            btn.style.display = "flex";
            if (remMs > 0) {
                btn.disabled = true;
                btn.classList.add("cooldown-active");
                if (emoji) emoji.textContent = "⏳";
                label.textContent = `ПЕРЕПОЧИНОК ДВІРНИКА (${(remMs / 1000).toFixed(1)}с)`;
                if (sub) sub.textContent = "Готуємо наступну ділянку для прибирання...";
            } else {
                btn.disabled = false;
                btn.classList.remove("cooldown-active");
                if (emoji) emoji.textContent = "🧹";
                label.textContent = "ДВІРНИК: РОЗЧИСТИТИ ВУЛИЦЮ (МІНІ-ГРА)";
                if (sub) sub.textContent = `Приберіть сміття на ділянці • Оплата: +${MUNICIPAL_TASK_REWARD} 💰` + debtNote;
            }
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
                <span class="job-req${courseOk ? " ok" : ""}" title="Також підходить будь-який дорожчий ІТ-курс">${courseOk ? "🎓 " : "🔒 "}${escapeHtml(courseTitle)}</span>
                <span class="job-pay">+${formatNumber(job.taskReward)}</span>
                <span class="job-status">${status}</span></div>`;
        });
    } else if (gameState.employer && gameState.employer.startsWith("plot:")) {
        const pid = getActiveEmployerPlotId();
        const p = MAP_PLOTS_BASE.find(x => x.id === pid);
        const owned = getOwnedPlotData(pid);
        const bld = p && owned ? getBuildingDef(p.zone, owned.building) : null;
        const wRec = getWorkerRecordOnPlot(pid, currentUser);
        const fin = calcOrderFinancials(p ? p.zone : "residential", bld, gameState.completedCourses, wRec.personalWage);
        html = `
            <div style="padding:10px;line-height:1.5;font-size:12px;color:#000">
                <div style="font-weight:bold;color:#000080;font-size:13px;margin-bottom:6px">📋 Ваша особова картка на підприємстві «${escapeHtml(bld ? bld.name : "Бізнес")}»</div>
                <div>• <b>Власник підприємства:</b> ${escapeHtml(owned?.owner || "—")}</div>
                <div>• <b>Ваша посада:</b> <span style="color:#000080;font-weight:bold">${escapeHtml(wRec.role)}</span></div>
                <div>• <b>Ваша зарплата:</b> <span style="color:#006400;font-weight:bold">+${formatNumberFull(wRec.personalWage)} 💰</span> за кожне замовлення (5 дій)</div>
                <div>• <b>Чек вашого замовлення (з курсами +${fin.skillBonusPct}%):</b> <b>${fin.grossCheck} 💰</b> (податок місту: -${fin.taxAmount} 💰, чиста маржа власника в касу: <b>${fin.ownerNetMargin >= 0 ? "+" + fin.ownerNetMargin : fin.ownerNetMargin} 💰</b>)</div>
                <div>• <b>Ваші дипломи:</b> ${renderCourseChipsHtml(gameState.completedCourses, p ? p.zone : null)}</div>
                <div>• <b>Виконано замовлень вами:</b> <b>${formatNumberFull(wRec.orders)}</b></div>
            </div>
        `;
    } else {
        html = `
            <div style="padding:10px;line-height:1.5;font-size:12px;color:#000">
                <div style="margin-bottom:6px"><b>🎓 Ваші отримані дипломи та сертифікати:</b><br>${renderCourseChipsHtml(gameState.completedCourses)}</div>
                <b>Як влаштуватися на престижну роботу:</b><br>
                • <b>У бізнес гравця:</b> оберіть підприємство у вкладці «🏪 Вакансії» та натисніть <b>«📨 Подати резюме»</b> або прийміть запрошення за координатами на Пошті.<br>
                • <b>У КовельКорп:</b> пройдіть будь-який курс програмування у вкладці «🎓 Курси» (дорожчий ІТ-курс автоматично відкриває вступ і молодші звання!).
            </div>
        `;
    }
    $("jobs-list").innerHTML = html;
}

// Магазин курсів із підтримкою ПАУЗИ курсу
function renderShop() {
    const bannerEl = $("course-cat-banner");
    const overdueBlocked = isBankBlocked();
    if (bannerEl) {
        if (overdueBlocked) {
            bannerEl.innerHTML = `🚫 <span style="color:#800000">У вас прострочений кредит! Купівля курсів тимчасово заблокована — заробляйте монети на роботі та погасіть борг у вкладці «🏦 Банк».</span>`;
        } else if (activeCourseCategory === "it") {
            bannerEl.innerHTML = `💻 <b>Курси програмування (IT — КовельКорп):</b> Вивчаються <b>строго по черзі</b> — від «Основи програмування» (800 💰) до «Архітектура високих навантажень» (90 000 💰).`;
        } else if (activeCourseCategory === "residential") {
            const myRes = getWorkerZoneSkillBonusPct(gameState.completedCourses, "residential");
            bannerEl.innerHTML = `🏡 <b>Курси Житлової зони (450 – 9 500 💰):</b> Збільшують чек клієнта при роботі на об'єктах Житлової зони! Ваш поточний бонус у Житловій зоні: <span style="color:#006400">+${myRes}%</span>.`;
        } else if (activeCourseCategory === "commercial") {
            const myCom = getWorkerZoneSkillBonusPct(gameState.completedCourses, "commercial");
            bannerEl.innerHTML = `🏪 <b>Курси Комерційної зони (550 – 12 000 💰):</b> Збільшують чек клієнта при роботі в пекарнях, піцеріях і ТРЦ Комерційної зони! Ваш поточний бонус у Комерції: <span style="color:#006400">+${myCom}%</span>.`;
        } else {
            const myInd = getWorkerZoneSkillBonusPct(gameState.completedCourses, "industrial");
            bannerEl.innerHTML = `🏭 <b>Курси Промислової зони (650 – 15 000 💰):</b> Промислові та зварювальні спеціальності для цехів, комбінатів, депо й заводів Ковеля. Підвищують чек кожного замовлення у Промзоні — ваш поточний бонус: <span style="color:#006400">+${myInd}%</span>.`;
        }
    }

    const filtered = COURSES.filter(c => c.category === activeCourseCategory);
    let html = "";
    filtered.forEach(c => {
        const done = gameState.completedCourses.includes(c.id);
        const missingPrevIt = (!done && c.category === "it") ? getMissingPreviousItCourse(c.id) : null;
        const active = gameState.activeCourseId === c.id;
        const can = !done && !active && !missingPrevIt && !gameState.activeCourseId && !overdueBlocked && gameState.coins >= c.price;

        let badgeLabel = "";
        if (c.category === "it") {
            badgeLabel = `+${c.boost}% IT-XP`;
        } else if (c.category === "residential") {
            badgeLabel = `+${c.zoneBoost}% Житлова зона`;
        } else if (c.category === "commercial") {
            badgeLabel = `+${c.zoneBoost}% Комерційна зона`;
        } else {
            badgeLabel = `+${c.zoneBoost}% Промислова зона`;
        }

        const durMin = Math.round(c.durationMs / 60000);
        const durText = durMin >= 60 ? `${(durMin / 60).toFixed(durMin % 60 === 0 ? 0 : 1)} год` : `${durMin} хв`;

        let status = "";
        if (done) {
            status = `<span style="color:#006400;font-weight:bold">✓ Диплом отримано (${badgeLabel})</span>`;
        } else if (active) {
            const remStr = formatDuration(getRemainingCourseMs());
            if (gameState.coursePaused) {
                status = `
                    <span class="course-timer" style="color:#004080;margin-right:6px">⏸️ На паузі (залишилось: ${remStr})</span>
                    <button class="btn success" onclick="toggleCoursePause()" style="min-height:28px;padding:3px 10px;font-size:11px">▶️ Продовжити</button>
                `;
            } else {
                status = `
                    <span class="course-timer" style="margin-right:6px">⏳ Навчання: ${remStr}</span>
                    <button class="btn" onclick="toggleCoursePause()" style="min-height:28px;padding:3px 10px;font-size:11px">⏸️ Пауза</button>
                `;
            }
        } else if (missingPrevIt) {
            status = `<button class="btn" disabled title="Спочатку пройдіть попередній курс: ${escapeHtml(missingPrevIt.name)}">🔒 Спочатку: «${escapeHtml(missingPrevIt.name)}»</button>`;
        } else {
            const btnText = overdueBlocked ? `🚫 Борг у банку` : `Вивчити (${formatNumberFull(c.price)} 💰)`;
            status = `<button class="btn default" ${can ? "" : "disabled"} onclick="buyCourse('${c.id}')">${btnText}</button>`;
        }

        html += `<div class="shop-item${done ? " completed" : ""}${active ? " active-course" : ""}">
            <div class="shop-item-header"><span class="shop-item-name">🎓 ${escapeHtml(c.name)}</span><span class="shop-item-boost">${badgeLabel}</span></div>
            <div class="shop-item-info">Тривалість: ${durText} • Ціна: <b>${formatNumberFull(c.price)} 💰</b><br>${escapeHtml(c.desc || "")}</div>
            <div class="shop-item-actions">${status}</div></div>`;
    });
    $("shop-list").innerHTML = html;
}

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

    leafletMap.on("zoomend", () => {
        renderMap();
    });
}

window.centerKovelMap = function () {
    if (leafletMap) leafletMap.setView(KOVEL_CENTER, 13);
};

window.focusBohdanHouse = function () {
    const b = MAP_BUILDINGS.find(x => x.id === "bohdan");
    if (leafletMap && b) {
        leafletMap.setView([b.lat, b.lng], 17);
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

// Мапа: колір зони зберігається, нік зверху всередині квадрата, Богдан та кафе «DOBRE» (Косачів, 4а) з'являються лише на макс. зумі!
function renderMap() {
    if (!leafletMap) initKovelMap();
    if (!leafletMap || !leafletPlotLayer || !leafletBldLayer) return;

    leafletPlotLayer.clearLayers();
    leafletBldLayer.clearLayers();

    const curZoom = leafletMap.getZoom() || 13;
    const maxZoom = leafletMap.getMaxZoom() || 17;

    MAP_PLOTS_BASE.forEach(p => {
        if (currentZoneFilter !== "all" && p.zone !== currentZoneFilter) return;

        const zInfo = ZONE_INFO[p.zone] || ZONE_INFO.residential;
        const owned = getOwnedPlotData(p.id);
        const price = calcPlotPrice(p, sharedPlots);
        const canAfford = gameState.coins >= price && !owned && !isBankBlocked();
        const isSelected = selectedPlotId === p.id;

        const fillColor = zInfo.fillFree;
        const borderColor = isSelected ? "#ffff00" : zInfo.borderFree;
        const bld = owned ? getBuildingDef(p.zone, owned.building) : null;

        const bounds = [
            [p.lat - p.dLat / 2, p.lng - p.dLng / 2],
            [p.lat + p.dLat / 2, p.lng + p.dLng / 2]
        ];

        const rect = L.rectangle(bounds, {
            color: borderColor,
            weight: isSelected ? 3.5 : (owned ? 2.5 : 1.5),
            dashArray: owned ? null : (canAfford ? "3,2" : "5,4"),
            fillColor: fillColor,
            fillOpacity: owned ? 0.72 : (canAfford ? 0.44 : 0.30)
        }).addTo(leafletPlotLayer);

        rect.on("click", () => selectPlot(p.id));

        const zoneBadge = p.zone === "industrial" ? "🏭" : (p.zone === "commercial" ? "🏪" : "🏡");

        if (owned) {
            const topInsideLat = p.lat + (p.dLat / 2) - (p.dLat * 0.05);
            const isSelf = owned.owner === currentUser;
            const frameCls = `plot-owner-top-frame${isSelf ? " self-owner" : ""}${isSelected ? " selected" : ""}`;
            const topNameMarker = L.marker([topInsideLat, p.lng], {
                icon: L.divIcon({
                    className: "",
                    html: `<div class="${frameCls}">${escapeHtml(owned.owner)}</div>`,
                    iconSize: [0, 0]
                })
            }).addTo(leafletPlotLayer);
            topNameMarker.on("click", () => selectPlot(p.id));

            if (bld) {
                const workersCount = owned.workers ? Object.keys(owned.workers).length : 0;
                const workerTag = workersCount > 0 ? ` 👷${workersCount}` : "";
                const centerMarker = L.marker([p.lat - p.dLat * 0.12, p.lng], {
                    icon: L.divIcon({
                        className: "",
                        html: `<div class="plot-center-bld-badge">${bld.icon}${workerTag}</div>`,
                        iconSize: [0, 0]
                    })
                }).addTo(leafletPlotLayer);
                centerMarker.on("click", () => selectPlot(p.id));
            }
        } else {
            const labelCls = `win95-map-label zone-${p.zone}${isSelected ? " selected" : ""}`;
            const labelMarker = L.marker([p.lat, p.lng], {
                icon: L.divIcon({
                    className: "",
                    html: `<div class="${labelCls}">${zoneBadge} ${formatNumber(price)}</div>`,
                    iconSize: [0, 0]
                })
            }).addTo(leafletPlotLayer);
            labelMarker.on("click", () => selectPlot(p.id));
        }
    });

    MAP_BUILDINGS.forEach(b => {
        // ВИМОГА 5: І дім Богдана Поліщука, і кафе «DOBRE» (вул. Косачів, 4а) видно лише на максимальному зумі!
        if (b.secretZoom && curZoom < maxZoom) return;

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
    const owned = getOwnedPlotData(plotId);
    const price = calcPlotPrice(p, sharedPlots);
    const overdueBlocked = isBankBlocked();
    const calc = calcPlotHourlyTaxAndNet(p, owned);

    const tagEl = $("info-zone-tag");
    tagEl.className = "zone-tag " + p.zone;
    tagEl.textContent = `${zInfo.name} (Податок зони: ${calc.turnoverTaxPct}% | Земля: ${calc.landTaxPct}%/год)`;

    const bld = owned ? getBuildingDef(p.zone, owned.building) : null;

    $("info-name").textContent = `#${p.id + 1} ${p.name} [${formatPlotCoords(p)}]`;
    $("info-owner").textContent = owned ? owned.owner : "Вільна (Міська рада)";
    $("info-price").textContent = owned ? `Куплено (${formatNumberFull(owned.price || price)} 💰)` : formatNumberFull(price) + " 💰";
    $("info-building").textContent = bld ? `${bld.icon} ${bld.name}` : (owned ? "⚠️ Не забудовано (приносить 0 доходу!)" : "—");
    if ($("info-land-tax")) {
        $("info-land-tax").textContent = `-${formatNumberFull(calc.landTax)} 💰/год (${calc.landTaxPct}% від ціни землі)`;
    }
    if (owned) {
        $("info-income").innerHTML = bld
            ? `Валовий +${formatNumberFull(calc.grossIncome)}/год − Податки -${formatNumberFull(calc.totalTax)}/год = <b style="color:${calc.netIncome >= 0 ? "#006400" : "#900000"}">${calc.netIncome >= 0 ? "+" : ""}${formatNumberFull(calc.netIncome)} 💰/год у Касу</b>`
            : `<b style="color:#900000">-${formatNumberFull(calc.landTax)} 💰/год (земельний податок без будівлі!)</b>`;
    } else {
        $("info-income").textContent = `Збудуйте бізнес: до +${formatNumberFull(zInfo.buildings[zInfo.buildings.length - 1].income)} 💰/год (мінус податки)`;
    }

    const buyWrap = $("info-buy-wrap");
    const buyBtn = $("info-buy-btn");
    const buildSec = $("info-build-section");
    const buildGrid = $("info-build-options");
    const workersSec = $("info-workers-section");

    if (owned && bld) {
        workersSec.style.display = "flex";
        const wage = Number(owned.wage) > 0 ? Number(owned.wage) : bld.defaultWage;
        const treasury = Math.max(0, Number(owned.treasury) || 0);
        const fin = calcOrderFinancials(p.zone, bld, [], wage);
        const isPos = fin.ownerNetMargin >= 0;

        const cashboxBannerEl = $("info-cashbox-banner");
        if (cashboxBannerEl) {
            cashboxBannerEl.innerHTML = `
                <div class="biz-cash-highlight" style="margin-bottom:4px">
                    <div>
                        <div style="font-size:11px;font-weight:bold;color:#004000">🏦 КАСА ПІДПРИЄМСТВА:</div>
                        <div class="cash-big">💰 ${formatNumberFull(treasury)} монет</div>
                    </div>
                    ${owned.owner === currentUser ? `
                        <button class="btn success" onclick="withdrawPlotTreasury(${plotId}, null, true)" ${treasury <= 0 ? "disabled" : ""} style="min-height:30px;padding:4px 10px;font-size:11px;font-weight:bold">
                            💰 Забрати в гаманець (+${formatNumberFull(treasury)})
                        </button>
                    ` : ""}
                </div>
            `;
        }

        const formulaEl = $("info-order-formula");
        if (formulaEl) {
            formulaEl.innerHTML = `
                <div class="receipt-breakdown">
                    <div class="receipt-breakdown-title">🧾 Чек 1 замовлення на цьому підприємстві (базова ЗП ${wage} 💰):</div>
                    <div class="receipt-pills-row">
                        <span class="receipt-pill">🛒 Чек покупця: <b>+${fin.grossCheck} 💰</b></span>
                        <span class="receipt-pill tax">🏛️ Податок (${fin.turnoverTaxPct}%): <b>-${fin.taxAmount} 💰</b></span>
                        <span class="receipt-pill wage">👷 ЗП робітнику: <b>-${fin.wage} 💰</b></span>
                        <span class="receipt-pill ${isPos ? "net-pos" : "net-neg"}">📈 Маржа власника в касу: ${isPos ? "+" + fin.ownerNetMargin + " 💰" : fin.ownerNetMargin + " 💰 (ЗБИТОК)"}</span>
                    </div>
                </div>
            `;
        }

        const wListEl = $("info-workers-list");
        wListEl.innerHTML = buildWorkersRosterHtml(plotId, owned, bld, "map");

        const hireActions = $("info-hire-actions");
        const isEmployedHere = getActiveEmployerPlotId() === plotId;
        const alreadyWorksForOwner = getExistingEmploymentForOwner(currentUser, owned.owner);
        const myRec = getWorkerRecordOnPlot(plotId, currentUser);
        const myZoneBonus = getWorkerZoneSkillBonusPct(gameState.completedCourses, p.zone);

        if (isEmployedHere) {
            hireActions.innerHTML = `
                <button class="btn default" onclick="switchPage('work')" style="min-height:32px;padding:4px 10px;font-size:12px">🛒 Перейти до роботи (ЗП: +${formatNumberFull(myRec.personalWage)} 💰/замовл.)</button>
                <button class="btn danger" onclick="resignCurrentJob()" style="min-height:32px;padding:4px 10px;font-size:12px">🚪 Звільнитись</button>
            `;
        } else if (alreadyWorksForOwner) {
            hireActions.innerHTML = `<span style="font-size:11px;color:#006400;font-weight:bold">👷 Ви вже працюєте у власника ${escapeHtml(owned.owner)} на об'єкті «${escapeHtml(alreadyWorksForOwner.plotName)}».</span>`;
        } else {
            hireActions.innerHTML = `
                <button class="btn default" onclick="openResumeModal(${plotId})" style="min-height:32px;padding:4px 12px;font-size:12px">📨 Подати резюме власнику (ваш бонус курсів: +${myZoneBonus}%)</button>
                ${owned.owner !== currentUser ? `<button class="btn" onclick="openComposeMail('${escapeHtml(owned.owner)}', 'Питання щодо роботи у ${escapeHtml(p.name)}')" style="min-height:32px;padding:4px 10px;font-size:12px">📧 Написати власнику</button>` : ""}
            `;
        }

        const ownerCtrl = $("info-owner-Controls");
        if (owned.owner === currentUser) {
            ownerCtrl.style.display = "flex";
            const wageInp = $("owner-wage-input");
            if (wageInp && document.activeElement !== wageInp) wageInp.value = wage;
            previewMapOwnerWageMargin();
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
        const hasAnyBuilding = Boolean(owned.building);
        zInfo.buildings.forEach((b) => {
            const isCurrent = owned.building === b.id;
            const lockedByChoice = hasAnyBuilding && !isCurrent;
            const canBuild = !hasAnyBuilding && !overdueBlocked && gameState.coins >= b.cost;
            const bFin = calcOrderFinancials(p.zone, b, [], b.defaultWage);
            const btnLabel = isCurrent
                ? "✓ Збудовано"
                : (lockedByChoice ? "🔒 Обрано іншу будівлю" : (overdueBlocked ? "🚫 Борг у банку" : `Збудувати (${formatNumber(b.cost)})`));
            bHtml += `<div class="build-card${isCurrent ? " current-bld" : ""}">
                <div class="build-card-info">
                    <span class="build-card-name">${b.icon} ${b.name}</span>
                    <span class="build-card-sub">Ціна: ${formatNumberFull(b.cost)} 💰 • Валовий дохід: +${formatNumberFull(b.income)}/год • Чек замовлення: ${b.clickProfit} 💰 (ЗП ${b.defaultWage} 💰, маржа +${bFin.ownerNetMargin} 💰)</span>
                </div>
                <button class="btn default" ${canBuild ? "" : "disabled"} onclick="buildOnSelectedPlot('${b.id}')">${btnLabel}</button>
            </div>`;
        });
        bHtml += `<div style="margin-top:4px;text-align:right"><button class="btn danger" onclick="sellPlotToCity(${plotId})" style="min-height:26px;padding:2px 8px;font-size:11px">🏷️ Продати ділянку місту (повернути 75%)</button></div>`;
        buildGrid.innerHTML = bHtml;
    } else {
        buildSec.style.display = "none";
        buyWrap.style.display = "flex";
        if (owned) {
            buyBtn.textContent = "Зайнято (" + owned.owner + ")";
            buyBtn.disabled = true;
        } else if (overdueBlocked) {
            buyBtn.textContent = "🚫 Покупки заблоковано (погасіть кредит)";
            buyBtn.disabled = true;
        } else if (gameState.coins < price) {
            buyBtn.textContent = "Недостатньо монет (" + formatNumber(price) + ")";
            buyBtn.disabled = true;
        } else {
            buyBtn.textContent = `Купити землю (${formatNumber(price)} 💰, податок -${calc.landTax}/год)`;
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
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "У вас прострочений кредит у КовельБанку. Ви не можете нічого купувати, поки повністю не сплатите борг у вкладці «🏦 Банк»!", "🚫");
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === selectedPlotId);
    if (!p) return;
    if (getOwnedPlotData(selectedPlotId)) return showDialog("Зайнято", "Ділянка вже куплена.", "⚠️");
    const price = calcPlotPrice(p, sharedPlots);
    if (gameState.coins < price) return showDialog("Недостатньо коштів", "Потрібно " + formatNumberFull(price) + " 💰.\nПорада: ви можете накопичити кошти на депозиті або взяти кредит у вкладці «🏦 Банк»!", "💸");
    try {
        const result = await runTransaction(ref(db, `plots/${selectedPlotId}`), (current) => {
            if (current === null || !current.owner || current.wiped) {
                return { owner: currentUser, price: price, boughtAt: Date.now(), zone: p.zone, building: null, treasury: 0, wage: 0, workers: {}, wiped: null };
            }
            return;
        });
        if (!result.committed) return showDialog("Не встигли", "Хтось купив цю ділянку раніше.", "⚠️");
        gameState.coins -= price;
        markLocalCoinsChanged();
        const calc = calcPlotHourlyTaxAndNet(p, { owner: currentUser, price });
        sfx.win();
        renderAll(); await saveGame();
        showMapInfo(selectedPlotId);
        setGameStatus("Ділянку куплено: " + p.name);
        showDialog(
            "Ділянку куплено!",
            `${p.name} (${formatPlotCoords(p)})\nЗона: ${ZONE_INFO[p.zone].name}\n⚠️ Податок на саму землю: -${formatNumberFull(calc.landTax)} 💰/год.\nЗбудуйте тут підприємство, щоб земля почала приносити прибуток у вашу Касу!`,
            "🗺️"
        );
    } catch (e) { showDialog("Помилка", e.message, "⚠️"); }
};

window.buildOnSelectedPlot = async function (buildingId) {
    if (selectedPlotId === null) return;
    if (isBankBlocked()) {
        return showDialog("Будівництво заблоковано!", "У вас прострочений кредит у КовельБанку. Ви не можете нічого купувати чи будувати, поки не сплатите борг!", "🚫");
    }
    const p = MAP_PLOTS_BASE.find(x => x.id === selectedPlotId);
    const owned = getOwnedPlotData(selectedPlotId);
    if (!p || !owned || owned.owner !== currentUser) return;

    const bld = getBuildingDef(p.zone, buildingId);
    if (!bld) return;
    if (gameState.coins < bld.cost) return showDialog("Недостатньо монет", "Потрібно " + formatNumberFull(bld.cost) + " 💰", "💸");

    try {
        const currentTreasury = Math.max(0, Number(owned.treasury) || 0);
        gameState.coins -= bld.cost;
        markLocalCoinsChanged();
        await update(ref(db, `plots/${selectedPlotId}`), {
            building: bld.id,
            builtAt: Date.now(),
            wage: bld.defaultWage,
            treasury: currentTreasury
        });
        const fin = calcOrderFinancials(p.zone, bld, [], bld.defaultWage);
        sfx.win();
        renderAll(); await saveGame();
        showMapInfo(selectedPlotId);
        setGameStatus(`Збудовано: ${bld.name}! Чек замовлення: ${bld.clickProfit} 💰, ваша маржа: +${fin.ownerNetMargin} 💰 у Касу.`);
        showDialog(
            "Підприємство відкрито!",
            `${bld.icon} ${bld.name} (${p.name})\n\n• Чек покупця за замовлення: +${bld.clickProfit} 💰\n• Податок зони (${fin.turnoverTaxPct}%): -${fin.taxAmount} 💰\n• Базова ЗП робітнику: -${bld.defaultWage} 💰\n• Ваша чиста маржа в Касу: +${fin.ownerNetMargin} 💰 з кожного замовлення!\n\nЗабирайте зароблені гроші у вкладці «💼 Робота і Бізнес ➔ 🏦 Мій бізнес і КАСА» або прямо тут на мапі!`,
            "🏗️"
        );
    } catch (e) {
        showDialog("Помилка", e.message, "⚠️");
    }
};

window.clickBuilding = function (id) {
    if (id === "bank") switchPage("bank");
    else if (id === "bohdan") openBohdanModal();
    else if (id === "dobre") openDobreModal();
    else if (id === "corp") {
        if (!hasCourse("basics")) {
            showDialog("КовельКорп", "Для вступу в ІТ-корпорацію «КовельКорп» потрібен сертифікат курсу «Основи програмування» або будь-якого дорожчого ІТ-курсу (у вкладці «🎓 Курси»).", "🏢");
        } else {
            joinKovelCorp();
            switchPage("work");
        }
    }
};

// ===== ВИМОГА 5: КАФЕ "DOBRE" (ВУЛ. КОСАЧІВ, 4А) =====
window.openDobreModal = function () {
    sfx.click();
    renderDobreMenu();
    $("dobre-overlay").classList.add("active");
};

window.closeDobreModal = function () {
    $("dobre-overlay").classList.remove("active");
};

function renderDobreMenu() {
    const grid = $("dobre-menu-grid");
    if (!grid) return;
    const overdueBlocked = isBankBlocked();

    grid.innerHTML = DOBRE_MENU.map(item => {
        const canBuy = !overdueBlocked && gameState.coins >= item.price;
        return `
            <div class="dobre-item-card">
                <div>
                    <div style="font-weight:bold;color:#4a2311">${escapeHtml(item.name)}</div>
                    <div style="font-size:11px;color:#444">${escapeHtml(item.desc)}</div>
                </div>
                <button class="btn default" ${canBuy ? "" : "disabled"} onclick="buyDobreItem('${item.id}')" style="min-height:30px;min-width:95px;padding:4px 8px;font-size:11px">
                    ${overdueBlocked ? "🚫 Борг" : `Замовити (${item.price} 💰)`}
                </button>
            </div>
        `;
    }).join("");
}

window.buyDobreItem = async function (itemId) {
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "Спочатку погасіть прострочений кредит у КовельБанку!", "🚫");
    }
    const item = DOBRE_MENU.find(x => x.id === itemId);
    if (!item) return;
    if (gameState.coins < item.price) {
        return showDialog("Недостатньо монет", `Потрібно ${formatNumberFull(item.price)} 💰.`, "💸");
    }

    gameState.coins -= item.price;
    markLocalCoinsChanged();

    let bonusMsg = "";
    if (item.effect === "fun_only") {
        const jokes = [
            "Смакота! Сир тягнеться, пепероні хрумтить — настрій на 100%!",
            "З'їли шматочок піци Пепероні за 20 💰. Користі нуль, зате як смачно!",
            "Піца Пепероні зайшла на ура! Можна далі підкорювати Ковель."
        ];
        bonusMsg = jokes[Math.floor(Math.random() * jokes.length)];
    } else {
        if (cooldownIntervalId) {
            clearInterval(cooldownIntervalId);
            cooldownIntervalId = null;
        }
        workCooldownUntil = 0;
        workCooldownReason = "";
        bonusMsg = "Перерву між клієнтами на роботі миттєво знято!";
        if (gameState.activeCourseId) {
        const reduceMs = item.effect === "boost_course_35m" ? 35 * 60 * 1000 : (item.effect === "boost_course_10m" ? 10 * 60 * 1000 : 0);
        if (reduceMs > 0) {
            const curRem = getRemainingCourseMs();
            const nextRem = Math.max(1000, curRem - reduceMs);
            gameState.courseRemainingMs = nextRem;
            if (!gameState.coursePaused) {
                gameState.courseStartTime = Date.now();
            }
            checkCourseCompletion();
            bonusMsg = `Час навчання на поточному курсі скорочено на ${Math.round(reduceMs / 60000)} хв, а кулдаун роботи знято!`;
        }
    }
    }

    sfx.win();
    renderAll();
    renderDobreMenu();
    if ($("dobre-status-msg")) {
        $("dobre-status-msg").innerHTML = `✅ <b>Смачного у «DOBRE» (вул. Косачів, 4а)!</b> Ви замовили «${escapeHtml(item.name)}». ${bonusMsg}`;
    }
    await saveGame();
    setGameStatus(`☕ Кафе «DOBRE» (Косачів, 4а): ${item.name} — ${bonusMsg}`);
};

// ===== БОГДАН ПОЛІЩУК: ГЛОБАЛЬНИЙ ЦИКЛ 24/24 ДЛЯ ВСІХ ГРАВЦІВ (ПЕРШІ 2 ПРОМ. КУРСИ -10%) =====
function getBohdanGlobalSchedule() {
    const pos = ((Date.now() - BOHDAN_CYCLE_EPOCH) % BOHDAN_CYCLE_MS + BOHDAN_CYCLE_MS) % BOHDAN_CYCLE_MS;
    const isWorking = pos < BOHDAN_ACTIVE_MS;
    const remainingMs = isWorking ? (BOHDAN_ACTIVE_MS - pos) : (BOHDAN_CYCLE_MS - pos);
    return { isWorking, remainingMs };
}

function renderBohdanWeldingSchool() {
    const box = $("bohdan-welding-box");
    if (!box) return;

    const sched = getBohdanGlobalSchedule();
    const overdueBlocked = isBankBlocked();
    const bohdanCourses = COURSES.filter(c => c.bohdanOffer);

    const statusBadge = sched.isWorking
        ? `<span style="color:#006400;font-weight:bold">✅ Працює для всіх ще ${formatDuration(sched.remainingMs)}</span>`
        : `<span style="color:#900000;font-weight:bold">☁️ Відпочиває ще ${formatDuration(sched.remainingMs)}</span>`;

    const descHtml = sched.isWorking
        ? `Богдан зараз у майстерні й продає <b>перші два пром. курси на 10% дешевше</b>! Через ${formatDuration(sched.remainingMs)} він піде відпочивати на 24 години.`
        : `☁️ Богдан зараз відпочиває: <b>дивиться на хмари, п'є колу та грає в Clash Royale</b>! Наступний набір на курси відкриється для всіх через <b>${formatDuration(sched.remainingMs)}</b>.`;

    const coursesRows = bohdanCourses.map(c => {
        const done = gameState.completedCourses.includes(c.id);
        const active = gameState.activeCourseId === c.id;
        const discountedPrice = Math.max(1, Math.floor(c.price * BOHDAN_DISCOUNT_MULT));
        const canBuyHere = sched.isWorking && !done && !active && !gameState.activeCourseId && !overdueBlocked && gameState.coins >= discountedPrice;

        let actionHtml = "";
        if (done) {
            actionHtml = `<span style="color:#006400;font-weight:bold">✓ Вивчено (+${c.zoneBoost}%)</span>`;
        } else if (active) {
            actionHtml = `<span style="color:#000080;font-weight:bold">${gameState.coursePaused ? "⏸️ На паузі" : "⏳ Вивчається"}</span>`;
        } else if (!sched.isWorking) {
            actionHtml = `<button class="btn" disabled style="min-height:24px;min-width:auto;padding:2px 7px;font-size:10px">👑 Грає в Clash Royale (${formatDuration(sched.remainingMs)})</button>`;
        } else {
            actionHtml = `<button class="btn success" ${canBuyHere ? "" : "disabled"} onclick="buyCourseFromBohdan('${c.id}')" style="min-height:26px;min-width:auto;padding:2px 8px;font-size:11px;font-weight:bold">🔥 Купити за ${discountedPrice} 💰 (-10%)</button>`;
        }

        return `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;background:#ffffff;border:1px solid #a0a0a0;padding:4px 6px;margin-top:3px">
                <div>
                    <b>🔧 ${escapeHtml(c.name)}</b> <span style="color:#006400;font-weight:bold">(+${c.zoneBoost}% у Промзоні)</span><br>
                    <span style="color:#666">У комбінаті: <s>${c.price} 💰</s> ➔ У Богдана (-10%): <b style="color:#802000">${discountedPrice} 💰</b></span>
                </div>
                <div>${actionHtml}</div>
            </div>
        `;
    }).join("");

    box.innerHTML = `
        <div class="bohdan-welding-title">
            <span>🔥 Гаражна школа Богдана (24 год робота / 24 год відпочинок):</span>
            ${statusBadge}
        </div>
        <div style="color:#333;margin-bottom:3px">${descHtml}</div>
        ${coursesRows}
    `;
}

window.buyCourseFromBohdan = async function (courseId) {
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "У вас прострочений кредит у КовельБанку. Спочатку погасіть борг!", "🚫");
    }
    const sched = getBohdanGlobalSchedule();
    if (!sched.isWorking) {
        return showDialog(
            "Богдан відпочиває!",
            `Зараз у Богдана 24-годинний відпочинок: він дивиться на хмари, п'є колу та грає в Clash Royale!\nПродаж курсів відновиться для всіх через: ${formatDuration(sched.remainingMs)}.`,
            "☁️"
        );
    }
    if (gameState.activeCourseId) {
        return showDialog("Курс уже триває", "Спочатку завершіть поточний курс (у вкладці «🎓 Курси»)!", "⚠️");
    }
    const c = COURSES.find(x => x.id === courseId && x.bohdanOffer);
    if (!c || gameState.completedCourses.includes(courseId)) return;

    const discountedPrice = Math.max(1, Math.floor(c.price * BOHDAN_DISCOUNT_MULT));
    if (gameState.coins < discountedPrice) {
        return showDialog("Недостатньо монет", `Потрібно ${formatNumberFull(discountedPrice)} 💰 (зі знижкою -10% від Богдана).`, "💸");
    }

    miniGames.stop();
    gameState.coins -= discountedPrice;
    markLocalCoinsChanged();
    gameState.activeCourseId = c.id;
    gameState.courseStartTime = Date.now();
    gameState.coursePaused = false;
    gameState.courseRemainingMs = c.durationMs;
    gameState.taskActive = false;
    gameState.taskProgress = 0;

    sfx.win();
    renderAll();
    renderBohdanWeldingSchool();
    startCourseTimer();
    await saveGame();
    setGameStatus(`🔥 Ви купили курс «${c.name}» у Богдана Поліщука зі знижкою -10% за ${discountedPrice} 💰!`);
    showDialog(
        "Курс зі знижкою -10%!",
        `Богдан Поліщук розпочав ваше навчання:\n🔧 «${c.name}»\n\nЦіна зі знижкою -10%: ${discountedPrice} 💰 (замість ${c.price} 💰).\n💡 Ви можете будь-коли поставити курс на паузу, щоб попрацювати.`,
        "👨‍🏭"
    );
};

let bohdanHistory = [];

function initBohdanChatIfEmpty() {
    const log = $("bohdan-chat-log");
    if (!log || log.children.length > 0) return;
    appendBohdanMsg(
        "bohdan",
        "Богдан Поліщук",
        "Здоров, козаче! Заходь у мою гаражну майстерню на Миколайчука, 100! Я тепер навчаю зварюванню на 10% дешевше, ніж у комбінаті — але беру одного учня раз на 24 години, бо потім треба 24 години відпочити й підварити свої замовлення!"
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
    renderBohdanWeldingSchool();
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
    appendBohdanMsg("bohdan", "Система Windows 98 SE", val ? "Ключ OpenRouter збережено! Богдан підключений до хмарної LLM." : "Увімкнено локальний ШІ-движок Богдана.");
};

window.askBohdanPreset = function (text) {
    $("bohdan-input").value = text;
    sendBohdanMessage();
};

function generateSmartBohdanReply(userText) {
    const q = userText.toLowerCase();
    const coins = formatNumberFull(gameState.coins);
    const sched = getBohdanGlobalSchedule();

    if (q.includes("звар") || q.includes("10%") || q.includes("знижк") || q.includes("розклад")) {
        return sched.isWorking
            ? `Зараз я працюю! Продаю перші два пром. курси («Охорона праці» та «MIG/MAG зварювання») на 10% дешевше. Залишилось ${formatDuration(sched.remainingMs)}, а потім я на 24 години піду пити колу, дивитися на хмари й грати в Clash Royale!`
            : `Зараз я відпочиваю: дивлюся на хмари, п'ю холодну колу й пушу кубки в Clash Royale! Через ${formatDuration(sched.remainingMs)} знову відкрию набір на перші два курси зі знижкою -10% для всіх!`;
    }
    if (q.includes("пауз") || q.includes("курс")) {
        return "Тепер будь-який запущений курс можна поставити на паузу кнопкою «⏸️ Поставити на паузу» прямо на вкладці Роботи або в Курсах! Попрацював, заробив монет — і натиснув «▶️ Продовжити» з тієї ж секунди!";
    }
    if (q.includes("dobre") || q.includes("добре") || q.includes("косач") || q.includes("кафе")) {
        return "Кафе «DOBRE» знаходиться у Ковелі на вулиці Косачів, 4а! Так само як і мій дім, знайти його на мапі можна, якщо максимально наблизити камеру (зум на максимум). Там варять класну каву, яка знімає кулдаун роботи і пришвидшує навчання!";
    }
    return `У тебе в гаманці ${coins} 💰. Заглядай у мою школу зварювання (-10% раз на 24 години), або заскоч на каву в «DOBRE» на Косачів, 4а!`;
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
            const sysPrompt = `Ти — Богдан Поліщук із міста Ковель (живеш на вул. Миколайчука, 100). Раніше працював зварювальником у Чехії, повернувся додому в Ковель і тепер раз на 24 години продаєш курси зварювання зі знижкою 10%. Знаєш про кафе "DOBRE" на вул. Косачів, 4а. Відповідай живою українською мовою лаконічно (2-3 речення).`;
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
    const hInput = $("history-quick-reply-input");
    if (hInput) {
        hInput.addEventListener("keydown", e => {
            if (e.key === "Enter") sendQuickHistoryReply();
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
    const nextYield = dep.amount > 0 ? Math.max(1, Math.floor(dep.amount * DEPOSIT_RATE_PER_HOUR)) : 0;
    $("dep-next-yield").textContent = "+" + formatNumberFull(nextYield) + " 💰";
    const msLeft = dep.amount > 0 && dep.lastInterestAt
        ? Math.max(0, HOUR_MS - (Date.now() - dep.lastInterestAt))
        : HOUR_MS;
    $("dep-next-timer").textContent = blocked ? "призупинено (борг)" : formatDuration(msLeft);
    $("dep-earned-total").textContent = formatNumberFull(dep.totalEarned || 0) + " 💰";
    $("dep-take-btn").disabled = dep.amount <= 0;
    $("dep-take-all-btn").disabled = dep.amount <= 0;
    $("dep-put-btn").disabled = gameState.coins <= 0 || blocked;

    const limit = getCreditLimit();
    const curJobTitle = gameState.employer === "corp" ? getCurrentCorpJob().name : "Працівник Ковеля";
    $("credit-limit").textContent = "до " + formatNumberFull(limit) + " 💰";
    if (c.amount > 0) {
        $("credit-card-info").style.display = "none";
        $("credit-active-card").style.display = "block";
        $("credit-debt").textContent = formatNumberFull(c.amount) + " 💰";
        const remaining = c.dueAt - Date.now();
        if (remaining > 0) {
            $("credit-due-text").innerHTML = `Повернути через: <b>${formatDuration(remaining)}</b>.<br>Ви можете гасити борг частинами або повністю.`;
        } else {
            $("credit-due-text").innerHTML = `⚠️ <b>Прострочено на ${formatDuration(Date.now() - c.dueAt)}!</b> Штраф 10% кожні 5 хв списується з депозиту, а покупки заблоковано (працювати можна!).`;
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
            `• При прострочці штрафи списуються з депозиту, а покупки блокуються.`;
        $("credit-take-btn").disabled = limit <= 0;
    }
}

window.startTaskOrShowStatus = function () {
    if (!currentUser || isCourseRunning()) return;
    if (Date.now() < workCooldownUntil) return;

    if (gameState.employer === "corp") {
        if (!hasCourse("basics")) {
            gameState.employer = "none";
            renderAll();
            return showDialog("Потрібен ІТ-курс!", "Для роботи в КовельКорп пройдіть «Основи програмування» або будь-який дорожчий ІТ-курс.", "🎓");
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
        doPrivateOrderStepWork(pid);
    } else {
        doMunicipalStepWork();
    }
};

window.doPromote = async function () {
    if (gameState.employer !== "corp") {
        return showDialog(
            "Підвищення робить власник!",
            "На роботах у бізнесах гравців не можна прокачувати звання самостійно.\nВласник підприємства бачить ваші курси та кількість виконаних замовлень і сам підвищує вам зарплату й посаду!",
            "ℹ️"
        );
    }

    const job = getCurrentCorpJob();
    const nextJob = JOBS[gameState.jobIndex + 1];
    if (!nextJob || job.xpNeeded <= 0 || gameState.xp < job.xpNeeded) return;

    if (!hasCourse(nextJob.reqCourse)) {
        return showDialog(
            "Потрібен курс для підвищення!",
            `Щоб отримати звання «${nextJob.name}» у КовельКорп, вам необхідно пройти курс:\n\n🎓 «${getCourseName(nextJob.reqCourse)}» (або будь-який дорожчий ІТ-курс!)\n\nПерейдіть у вкладку «🎓 Курси», щоб розпочати навчання!`,
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
};

window.buyCourse = async function (id) {
    if (isBankBlocked()) {
        return showDialog("Покупки заблоковано!", "У вас прострочений кредит у КовельБанку. Працюйте та спочатку погасіть борг у вкладці «🏦 Банк», щоб купувати курси!", "🚫");
    }
    if (hasActiveOrPausedCourse()) {
        return showDialog("Курс уже розпочато", "Спочатку закінчіть поточний курс (якщо він на паузі — натисніть «▶️ Продовжити» або дочекайтесь завершення)!", "⚠️");
    }
    const c = COURSES.find(x => x.id === id);
    if (!c || gameState.completedCourses.includes(id)) return;
    if (c.category === "it") {
        const missingPrev = getMissingPreviousItCourse(c.id);
        if (missingPrev) {
            return showDialog(
                "Вивчайте IT-курси по черзі!",
                `Щоб відкрити курс «${c.name}», спочатку необхідно пройти попередній курс:

🎓 «${missingPrev.name}»`,
                "🔒"
            );
        }
    }
    if (gameState.coins < c.price) return showDialog("Недостатньо коштів", "Потрібно " + formatNumberFull(c.price) + " 💰", "💸");
    miniGames.stop();
    gameState.coins -= c.price;
    markLocalCoinsChanged();
    gameState.activeCourseId = c.id;
    gameState.courseStartTime = Date.now();
    gameState.coursePaused = false;
    gameState.courseRemainingMs = c.durationMs;
    gameState.taskActive = false; gameState.taskProgress = 0;
    renderAll(); startCourseTimer();
    try { await saveGame(); setGameStatus("Курс розпочато: " + c.name + " (можна ставити на паузу!)"); showDialog("Курс розпочато!", `${c.name}\n\n💡 Ви можете в будь-який момент поставити навчання на паузу, щоб попрацювати на роботі!`, "📚"); }
    catch (e) { showDialog("Помилка", "Не вдалося зберегти", "⚠️"); }
};

function startCourseTimer() {
    if (courseTimerInterval) clearInterval(courseTimerInterval);
    courseTimerInterval = setInterval(() => {
        checkCourseCompletion();
        if (hasActiveOrPausedCourse()) {
            updateWorkButtonState();
            if (currentPage === "shop") renderShop();
        } else {
            clearInterval(courseTimerInterval);
            courseTimerInterval = null;
            renderAll();
        }
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
    if (page === "mail") renderMailPage();
    if (page === "politics") renderPoliticsPage();
    if (page === "map") {
        renderMap();
        setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 60);
    }
    if (page === "bank") renderBank();
};

function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}
async function sendHeartbeat() {
    if (!currentUser) return;
    try { await update(ref(db, `users/${currentUser}`), { lastOnline: Date.now() }); } catch (e) {}
}

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
                <span class="lb-name">${escapeHtml(u.name)}</span>
                ${!self ? `<button class="btn" onclick="openComposeMail('${escapeHtml(u.name)}', 'Привіт!')" style="min-height:22px;min-width:auto;padding:1px 6px;font-size:10px" title="Написати / Переслати гроші / Запросити на роботу">📧</button>` : ""}
                <span class="lb-coins">${formatNumberFull(u.coins)}</span></div>`;
        });
        listEl.innerHTML = html;
        const idx = list.findIndex(u => u.name === currentUser);
        myRankEl.textContent = idx >= 0 ? `Ваше місце: #${idx + 1} з ${list.length} (гаманець + депозит)` : "Вас немає в списку";
    } catch (e) { listEl.innerHTML = '<div class="lb-empty">Помилка</div>'; }
};

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
    if (cooldownIntervalId) clearInterval(cooldownIntervalId);
    if (dataListener) { dataListener(); dataListener = null; }
    if (mapListener) { mapListener(); mapListener = null; }
    if (mailInboxListener) { mailInboxListener(); mailInboxListener = null; }
    if (mailSentListener) { mailSentListener(); mailSentListener = null; }
    if (policyListener) { policyListener(); policyListener = null; }
    currentUser = "";
    userInboxMail = {}; userSentMail = {}; lastUnreadMailCount = 0; activeHistoryContact = "";
    if ($("admin-wipe-btn")) $("admin-wipe-btn").style.display = "none";
    gameState = {
        coins: 0, jobIndex: 0, xp: 0,
        privateJobIndex: 0, privateXp: 0, employer: "none",
        taskProgress: 0, taskActive: false,
        activeCourseId: null, courseStartTime: 0, coursePaused: false, courseRemainingMs: 0,
        bohdanDiscountUsedAt: 0,
        completedCourses: [], xpBoost: 0,
        lastRentAt: 0,
        credit: { amount: 0, takenAt: 0, dueAt: 0, overdue: false, lastPenaltyAt: 0 },
        deposit: { amount: 0, lastInterestAt: 0, totalEarned: 0 }
    };
    sharedPlots = {}; selectedPlotId = null;
    $("game-screen").classList.remove("active");
    $("auth-window").style.display = "flex";
    $("auth-username").value = $("auth-password").value = $("auth-password2").value = "";
    switchAuthTab("login"); setStatus("Вихід виконано");
};

window.addEventListener("beforeunload", () => {
    if (currentUser) {
        try {
            update(ref(db, `users/${currentUser}/clicker`), {
                coins: gameState.coins,
                jobIndex: gameState.jobIndex,
                xp: gameState.xp,
                privateJobIndex: 0,
                privateXp: gameState.privateXp,
                employer: gameState.employer,
                taskProgress: gameState.taskProgress,
                taskActive: gameState.taskActive,
                activeCourseId: gameState.activeCourseId,
                courseStartTime: gameState.courseStartTime,
                coursePaused: Boolean(gameState.coursePaused),
                courseRemainingMs: Number(gameState.courseRemainingMs) || 0,
                bohdanDiscountUsedAt: Number(gameState.bohdanDiscountUsedAt) || 0,
                completedCourses: gameState.completedCourses,
                xpBoost: gameState.xpBoost,
                lastRentAt: gameState.lastRentAt || Date.now(),
                credit: gameState.credit,
                deposit: gameState.deposit
            });
            update(ref(db, `users/${currentUser}`), { lastOnline: Date.now() });
        } catch (e) {}
    }
});

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

document.addEventListener("DOMContentLoaded", () => {
    switchAuthTab("login");
    $("auth-username").focus();
    console.log("%cWin98 SE Work v" + APP_VERSION, "color:#000080;font-weight:bold;font-family:monospace");
});
