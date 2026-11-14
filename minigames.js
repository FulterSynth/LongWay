// ===== WEB AUDIO RETRO SFX =====
class RetroSFX {
    constructor() {
        this.muted = false;
        this.ctx = null;
    }
    _ensureCtx() {
        if (this.muted) return null;
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === "suspended") {
            this.ctx.resume().catch(() => {});
        }
        return this.ctx;
    }
    tone(freq, dur = 0.07, type = "square", vol = 0.06) {
        const ctx = this._ensureCtx();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + dur);
    }
    click() { this.tone(660, 0.04, "square", 0.05); }
    good() { this.tone(523, 0.06, "triangle", 0.07); setTimeout(() => this.tone(784, 0.08, "triangle", 0.07), 55); }
    bad() { this.tone(180, 0.14, "sawtooth", 0.06); }
    win() {
        [523, 659, 784, 1046].forEach((f, i) => {
            setTimeout(() => this.tone(f, 0.1, "triangle", 0.07), i * 70);
        });
    }
}

export const sfx = new RetroSFX();

const MAIL_POOL = [
    { from: "boss@kovelcorp.ua", subj: "Терміново: звіт по продажах за квартал", spam: false },
    { from: "promo@free-ram95.net", subj: "Завантажити 128MB RAM безкоштовно зараз!!!", spam: true },
    { from: "devops@kovelcorp.ua", subj: "Впав продакшн-сервер, потрібен рестарт", spam: false },
    { from: "lottery@win98-prize.biz", subj: "Вітаємо! Ви виграли новенький Pentium II!", spam: true },
    { from: "support@kovelcorp.ua", subj: "Тікет #402: у клієнта не працює оплата", spam: false },
    { from: "antivirus@superclean.exe", subj: "Знайдено 999 вірусів! Натисніть щоб видалити", spam: true },
    { from: "hr@kovelcorp.ua", subj: "Нагадування: дейлі-мітинг о 10:30", spam: false },
    { from: "prince@dialup-gold.org", subj: "Секрет заробітку 5000$ за годину на модемі", spam: true },
    { from: "qa@kovelcorp.ua", subj: "Знайдено баг у формі авторизації", spam: false },
    { from: "casino@poker95.ru", subj: "Бонус 1000 фішок без реєстрації!", spam: true },
    { from: "sysadmin@kovelcorp.ua", subj: "Оновіть пароль від корпоративної пошти", spam: false },
    { from: "ads@cursor-pack.info", subj: "Блискучі курсори для Windows 95 без СМС", spam: true },
    { from: "client@volyn-biz.ua", subj: "Потрібна інтеграція CRM до п'ятниці", spam: false },
    { from: "shop@magic-disk.cc", subj: "Дискета для прискорення інтернету в 10 разів", spam: true }
];

const DOS_COMMANDS = [
    ["git", "push", "origin", "main"],
    ["npm", "run", "build", "--prod"],
    ["ping", "8.8.8.8", "-t", "5"],
    ["fix", "--bug", "--module", "auth"],
    ["defrag", "C:", "/f", "/v"],
    ["ssh", "admin@kovel", "-p", "22"],
    ["docker", "up", "-d", "api"],
    ["sql", "SELECT", "*", "FROM users"]
];

const MEM_ITEMS = [
    { ico: "💾", label: "Дискета", freq: 392 },
    { ico: "🔌", label: "Модем", freq: 494 },
    { ico: "🖱️", label: "Миша", freq: 587 },
    { ico: "🔑", label: "Ключ", freq: 698 }
];

export class MiniGameManager {
    constructor(containerIds, callbacks) {
        this.elWin = document.getElementById(containerIds.window);
        this.elIcon = document.getElementById(containerIds.icon);
        this.elTitle = document.getElementById(containerIds.title);
        this.elBadge = document.getElementById(containerIds.badge);
        this.elBody = document.getElementById(containerIds.body);
        this.cb = callbacks; // { onStep(xpWeight), onComplete(), onStatus(msg) }
        this.activeType = null;
        this.lastType = null;
        this.cleanups = [];
        this.keyHandler = null;
    }

    isRunning() {
        return this.activeType !== null;
    }

    stop() {
        this.cleanups.forEach(fn => { try { fn(); } catch (e) {} });
        this.cleanups = [];
        if (this.keyHandler) {
            window.removeEventListener("keydown", this.keyHandler);
            this.keyHandler = null;
        }
        this.activeType = null;
        this.elWin.style.display = "none";
        this.elBody.innerHTML = "";
    }

    startRandom(jobIndex) {
        this.stop();
        const types = ["bugs", "defrag", "inbox", "memory", "terminal"];
        const pool = types.filter(t => t !== this.lastType);
        const picked = pool[Math.floor(Math.random() * pool.length)];
        this.lastType = picked;
        this.activeType = picked;
        this.elWin.style.display = "flex";

        if (picked === "bugs") this._startBugs(jobIndex);
        else if (picked === "defrag") this._startDefrag(jobIndex);
        else if (picked === "inbox") this._startInbox(jobIndex);
        else if (picked === "memory") this._startMemory(jobIndex);
        else if (picked === "terminal") this._startTerminal(jobIndex);
    }

    _shake() {
        this.elWin.classList.remove("mg-shake");
        void this.elWin.offsetWidth;
        this.elWin.classList.add("mg-shake");
    }

    // ===== 1. БАГ-ХАНТЕР =====
    _startBugs(jobIndex) {
        const target = Math.min(12, 6 + Math.floor(jobIndex * 0.7));
        let score = 0;
        const cells = Array(12).fill(null); // 4x3 grid
        this.elIcon.textContent = "🐛";
        this.elTitle.textContent = "Баг-Хантер 95";
        this.elBadge.textContent = `0/${target}`;

        this.elBody.innerHTML = `
            <div class="mg-hint">Ловіть баги (🐛 👾 💥), не чіпайте файли (📄 📁)!</div>
            <div class="mg-bug-grid" id="mg-bug-grid"></div>
            <div class="mg-feedback" id="mg-fb">Очікування багів...</div>
        `;
        const grid = document.getElementById("mg-bug-grid");
        const fb = document.getElementById("mg-fb");

        for (let i = 0; i < 12; i++) {
            const btn = document.createElement("button");
            btn.className = "mg-bug-cell";
            btn.type = "button";
            btn.addEventListener("click", () => {
                if (this.activeType !== "bugs") return;
                const item = cells[i];
                if (!item) return;
                cells[i] = null;
                if (item.bad) {
                    score++;
                    sfx.good();
                    btn.className = "mg-bug-cell hit";
                    btn.textContent = "✓";
                    fb.className = "mg-feedback ok";
                    fb.textContent = `Баг знешкоджено! (${score}/${target})`;
                    this.elBadge.textContent = `${score}/${target}`;
                    this.cb.onStep(1 / target);
                    if (score >= target) {
                        sfx.win();
                        setTimeout(() => { if (this.activeType === "bugs") { this.stop(); this.cb.onComplete(); } }, 180);
                    }
                } else {
                    sfx.bad();
                    this._shake();
                    btn.className = "mg-bug-cell miss";
                    btn.textContent = "✕";
                    fb.className = "mg-feedback err";
                    fb.textContent = "Це був системний файл! Обережніше!";
                }
                setTimeout(() => {
                    if (!cells[i] && btn.isConnected) {
                        btn.className = "mg-bug-cell";
                        btn.textContent = "";
                    }
                }, 180);
            });
            grid.appendChild(btn);
        }

        const spawn = () => {
            if (this.activeType !== "bugs") return;
            const emptyIdx = [];
            for (let i = 0; i < 12; i++) if (!cells[i]) emptyIdx.push(i);
            if (!emptyIdx.length) return;
            const idx = emptyIdx[Math.floor(Math.random() * emptyIdx.length)];
            const isBug = Math.random() < 0.72;
            const ico = isBug
                ? ["🐛", "👾", "💥"][Math.floor(Math.random() * 3)]
                : ["📄", "📁"][Math.floor(Math.random() * 2)];
            const cls = isBug ? (ico === "💥" ? "virus" : "bug") : "safe";
            cells[idx] = { bad: isBug };
            const btn = grid.children[idx];
            if (btn) {
                btn.className = "mg-bug-cell " + cls;
                btn.textContent = ico;
            }
            const ttl = Math.max(850, 1550 - jobIndex * 65);
            const t = setTimeout(() => {
                if (cells[idx]) {
                    cells[idx] = null;
                    if (btn && btn.isConnected) {
                        btn.className = "mg-bug-cell";
                        btn.textContent = "";
                    }
                }
            }, ttl);
            this.cleanups.push(() => clearTimeout(t));
        };

        spawn();
        spawn();
        const intervalMs = Math.max(420, 720 - jobIndex * 30);
        const iv = setInterval(spawn, intervalMs);
        this.cleanups.push(() => clearInterval(iv));
    }

    // ===== 2. ДЕФРАГМЕНТАТОР (ТАЙМІНГ) =====
    _startDefrag(jobIndex) {
        const target = Math.min(6, 4 + Math.floor(jobIndex / 3));
        let hits = 0;
        this.elIcon.textContent = "💿";
        this.elTitle.textContent = "Defrag.exe";
        this.elBadge.textContent = `0/${target}`;

        const zoneWidth = Math.max(16, 28 - jobIndex * 1.2);
        let zoneLeft = 36;
        let pos = 0;
        let dir = 1;
        const speed = 1.5 + jobIndex * 0.16;

        this.elBody.innerHTML = `
            <div class="mg-hint">Тисніть <b>СИНХРОНІЗУВАТИ</b> (або Пробіл), коли повзунок у зеленій зоні!</div>
            <div class="mg-defrag-sectors" id="mg-sectors"></div>
            <div class="mg-defrag-track">
                <div class="mg-defrag-zone" id="mg-zone" style="left:${zoneLeft}%;width:${zoneWidth}%"></div>
                <div class="mg-defrag-cursor" id="mg-cursor" style="left:0%"></div>
            </div>
            <button class="btn default mg-defrag-btn" id="mg-defrag-hit" type="button">⚡ СИНХРОНІЗУВАТИ</button>
            <div class="mg-feedback" id="mg-fb">Секторів: 0 / ${target}</div>
        `;

        const sectorsEl = document.getElementById("mg-sectors");
        for (let i = 0; i < 20; i++) {
            const s = document.createElement("div");
            s.className = "mg-sector" + (i % 3 === 0 ? " frag" : "");
            sectorsEl.appendChild(s);
        }

        const cursorEl = document.getElementById("mg-cursor");
        const zoneEl = document.getElementById("mg-zone");
        const fb = document.getElementById("mg-fb");
        const hitBtn = document.getElementById("mg-defrag-hit");

        const attempt = () => {
            if (this.activeType !== "defrag") return;
            const center = pos + 2; // cursor center %
            if (center >= zoneLeft && center <= zoneLeft + zoneWidth) {
                hits++;
                sfx.good();
                const doneCount = Math.round((hits / target) * 20);
                Array.from(sectorsEl.children).forEach((el, idx) => {
                    if (idx < doneCount) el.className = "mg-sector done";
                });
                this.elBadge.textContent = `${hits}/${target}`;
                fb.className = "mg-feedback ok";
                fb.textContent = `Сектор оптимізовано! (${hits}/${target})`;
                this.cb.onStep(1 / target);
                zoneLeft = 10 + Math.random() * (80 - zoneWidth);
                zoneEl.style.left = zoneLeft + "%";
                if (hits >= target) {
                    sfx.win();
                    setTimeout(() => { if (this.activeType === "defrag") { this.stop(); this.cb.onComplete(); } }, 200);
                }
            } else {
                sfx.bad();
                this._shake();
                fb.className = "mg-feedback err";
                fb.textContent = "Промах! Ловіть зелену зону!";
            }
        };

        hitBtn.addEventListener("click", attempt);
        this.keyHandler = (e) => {
            if (e.code === "Space") { e.preventDefault(); attempt(); }
        };
        window.addEventListener("keydown", this.keyHandler);

        let rafId = 0;
        const tick = () => {
            if (this.activeType !== "defrag") return;
            pos += dir * speed;
            if (pos >= 96) { pos = 96; dir = -1; }
            else if (pos <= 0) { pos = 0; dir = 1; }
            cursorEl.style.left = pos + "%";
            rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        this.cleanups.push(() => cancelAnimationFrame(rafId));
    }

    // ===== 3. СОРТУВАННЯ ПОШТИ (OUTLOOK 95) =====
    _startInbox(jobIndex) {
        const target = Math.min(9, 6 + Math.floor(jobIndex / 2));
        let done = 0;
        const shuffled = [...MAIL_POOL].sort(() => Math.random() - 0.5);
        let idx = 0;
        let current = shuffled[0];

        this.elIcon.textContent = "📧";
        this.elTitle.textContent = "Outlook Express 95";
        this.elBadge.textContent = `0/${target}`;

        this.elBody.innerHTML = `
            <div class="mg-hint">Сортуйте листи: <b>Спам</b> у кошик, <b>Робочі</b> у роботу!</div>
            <div class="mg-mail-card">
                <div class="mg-mail-from" id="mg-mail-from"></div>
                <div class="mg-mail-subj" id="mg-mail-subj"></div>
            </div>
            <div class="mg-mail-actions">
                <button class="btn mg-mail-btn-spam" id="mg-btn-spam" type="button">🗑️ В спам</button>
                <button class="btn mg-mail-btn-work" id="mg-btn-work" type="button">✅ В роботу</button>
            </div>
            <div class="mg-feedback" id="mg-fb">Очікує сортування...</div>
        `;

        const fromEl = document.getElementById("mg-mail-from");
        const subjEl = document.getElementById("mg-mail-subj");
        const fb = document.getElementById("mg-fb");

        const renderMail = () => {
            current = shuffled[idx % shuffled.length];
            fromEl.textContent = "Від: " + current.from;
            subjEl.textContent = current.subj;
        };
        renderMail();

        const answer = (isSpamChoice) => {
            if (this.activeType !== "inbox") return;
            if (isSpamChoice === current.spam) {
                done++;
                idx++;
                sfx.good();
                this.elBadge.textContent = `${done}/${target}`;
                fb.className = "mg-feedback ok";
                fb.textContent = `Вірно! (${done}/${target})`;
                this.cb.onStep(1 / target);
                if (done >= target) {
                    sfx.win();
                    setTimeout(() => { if (this.activeType === "inbox") { this.stop(); this.cb.onComplete(); } }, 180);
                } else {
                    renderMail();
                }
            } else {
                sfx.bad();
                this._shake();
                fb.className = "mg-feedback err";
                fb.textContent = current.spam ? "Це ж очевидний спам!" : "Це важливий робочий лист!";
            }
        };

        document.getElementById("mg-btn-spam").addEventListener("click", () => answer(true));
        document.getElementById("mg-btn-work").addEventListener("click", () => answer(false));
        this.keyHandler = (e) => {
            if (e.key === "ArrowLeft") answer(true);
            else if (e.key === "ArrowRight") answer(false);
        };
        window.addEventListener("keydown", this.keyHandler);
    }

    // ===== 4. ДЕШИФРАТОР (ПАМ'ЯТЬ) =====
    _startMemory(jobIndex) {
        const rounds = 2;
        let round = 0;
        let seq = [];
        let userIdx = 0;
        let locked = true;

        this.elIcon.textContent = "🔐";
        this.elTitle.textContent = "Dial-Up Дешифратор";
        this.elBadge.textContent = `1/${rounds}`;

        this.elBody.innerHTML = `
            <div class="mg-hint" id="mg-mem-hint">Запам'ятайте послідовність підключення...</div>
            <div class="mg-mem-grid" id="mg-mem-grid"></div>
            <div class="mg-feedback" id="mg-fb">Раунд 1 з ${rounds}</div>
        `;

        const grid = document.getElementById("mg-mem-grid");
        const fb = document.getElementById("mg-fb");
        const hint = document.getElementById("mg-mem-hint");

        const buttons = MEM_ITEMS.map((item, i) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "mg-mem-btn";
            b.innerHTML = `<span class="mem-ico">${item.ico}</span><span>${item.label}</span>`;
            b.addEventListener("click", () => handlePress(i));
            grid.appendChild(b);
            return b;
        });

        const playRound = () => {
            locked = true;
            userIdx = 0;
            const len = Math.min(5, 3 + round + Math.floor(jobIndex / 4));
            seq = Array.from({ length: len }, () => Math.floor(Math.random() * 4));
            hint.textContent = "Дивіться уважно...";
            fb.className = "mg-feedback";
            fb.textContent = `Раунд ${round + 1} з ${rounds} (код з ${len} символів)`;

            seq.forEach((btnIdx, step) => {
                const t1 = setTimeout(() => {
                    if (this.activeType !== "memory") return;
                    buttons[btnIdx].classList.add("lit");
                    sfx.tone(MEM_ITEMS[btnIdx].freq, 0.14, "triangle", 0.06);
                }, 400 + step * 520);
                const t2 = setTimeout(() => {
                    buttons[btnIdx].classList.remove("lit");
                    if (step === seq.length - 1 && this.activeType === "memory") {
                        locked = false;
                        hint.textContent = "Повторіть код у тому ж порядку!";
                    }
                }, 400 + step * 520 + 320);
                this.cleanups.push(() => { clearTimeout(t1); clearTimeout(t2); });
            });
        };

        const handlePress = (idx) => {
            if (this.activeType !== "memory" || locked) return;
            const b = buttons[idx];
            if (idx === seq[userIdx]) {
                sfx.tone(MEM_ITEMS[idx].freq, 0.09, "triangle", 0.06);
                b.classList.add("good");
                setTimeout(() => b.classList.remove("good"), 160);
                userIdx++;
                if (userIdx >= seq.length) {
                    round++;
                    this.cb.onStep(1 / rounds);
                    if (round >= rounds) {
                        locked = true;
                        sfx.win();
                        fb.className = "mg-feedback ok";
                        fb.textContent = "З'єднання встановлено!";
                        setTimeout(() => { if (this.activeType === "memory") { this.stop(); this.cb.onComplete(); } }, 220);
                    } else {
                        this.elBadge.textContent = `${round + 1}/${rounds}`;
                        fb.className = "mg-feedback ok";
                        fb.textContent = "Код вірний! Наступний етап...";
                        const t = setTimeout(playRound, 500);
                        this.cleanups.push(() => clearTimeout(t));
                    }
                }
            } else {
                sfx.bad();
                this._shake();
                b.classList.add("bad");
                setTimeout(() => b.classList.remove("bad"), 220);
                userIdx = 0;
                fb.className = "mg-feedback err";
                fb.textContent = "Помилка! Почніть цей код спочатку.";
            }
        };

        playRound();
    }

    // ===== 5. ТЕРМІНАЛ MS-DOS (ЗБІР КОМАНДИ) =====
    _startTerminal(jobIndex) {
        const totalCmds = jobIndex >= 4 ? 3 : 2;
        let cmdDone = 0;
        const pickedList = [...DOS_COMMANDS].sort(() => Math.random() - 0.5);

        this.elIcon.textContent = "💻";
        this.elTitle.textContent = "MS-DOS Prompt";
        this.elBadge.textContent = `0/${totalCmds}`;

        this.elBody.innerHTML = `
            <div class="mg-hint">Зберіть команду в правильному порядку:</div>
            <div class="mg-dos-screen">
                <div>C:\\KOVELCORP&gt; <span style="color:#aaa">потрібна команда:</span></div>
                <div class="mg-dos-target" id="mg-dos-target"></div>
                <div class="mg-dos-typed" id="mg-dos-typed">&gt; _</div>
            </div>
            <div class="mg-dos-tokens" id="mg-dos-tokens"></div>
            <div class="mg-feedback" id="mg-fb">Команда 1 з ${totalCmds}</div>
        `;

        const targetEl = document.getElementById("mg-dos-target");
        const typedEl = document.getElementById("mg-dos-typed");
        const tokensEl = document.getElementById("mg-dos-tokens");
        const fb = document.getElementById("mg-fb");

        let currentCmd = [];
        let stepIdx = 0;

        const loadCommand = () => {
            currentCmd = pickedList[cmdDone % pickedList.length];
            stepIdx = 0;
            targetEl.textContent = currentCmd.join(" ");
            typedEl.textContent = "> _";
            tokensEl.innerHTML = "";

            const shuffled = currentCmd
                .map((tok, origIdx) => ({ tok, origIdx }))
                .sort(() => Math.random() - 0.5);

            shuffled.forEach(({ tok }) => {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "btn mg-dos-tok";
                btn.textContent = tok;
                btn.addEventListener("click", () => {
                    if (this.activeType !== "terminal") return;
                    if (tok === currentCmd[stepIdx]) {
                        sfx.click();
                        btn.disabled = true;
                        stepIdx++;
                        typedEl.textContent = "> " + currentCmd.slice(0, stepIdx).join(" ") + (stepIdx < currentCmd.length ? " _" : "");
                        if (stepIdx >= currentCmd.length) {
                            cmdDone++;
                            sfx.good();
                            this.elBadge.textContent = `${cmdDone}/${totalCmds}`;
                            fb.className = "mg-feedback ok";
                            fb.textContent = `Виконано! (${cmdDone}/${totalCmds})`;
                            this.cb.onStep(1 / totalCmds);
                            if (cmdDone >= totalCmds) {
                                sfx.win();
                                setTimeout(() => { if (this.activeType === "terminal") { this.stop(); this.cb.onComplete(); } }, 200);
                            } else {
                                const t = setTimeout(loadCommand, 320);
                                this.cleanups.push(() => clearTimeout(t));
                            }
                        }
                    } else {
                        sfx.bad();
                        this._shake();
                        fb.className = "mg-feedback err";
                        fb.textContent = `Очікувалось "${currentCmd[stepIdx]}"!`;
                    }
                });
                tokensEl.appendChild(btn);
            });
        };

        loadCommand();
    }
}
