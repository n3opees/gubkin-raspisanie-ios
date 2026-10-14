// Виджет расписания РГУ нефти и газа им. Губкина для Scriptable (iOS)
// Запусти скрипт ОДИН раз внутри приложения Scriptable — он попросит логин и
// пароль от личного кабинета и код твоей группы, сохранит их в защищённом
// хранилище iOS (Keychain). После этого добавь виджет на экран «Домой».
//
// Что делает: заходит в личный кабинет, забирает расписание группы и показывает
// пары на сегодня, а после последней пары — на ближайший учебный день.
// Повторный запуск в приложении открывает меню: сменить группу или логин.

// ───────────────────────── НАСТРОЙКИ ─────────────────────────
const CONFIG = {
  subgroup: 0,       // 0 = показывать все подгруппы (с пометкой), иначе 1 или 2 — только свою.
  showTeacher: true, // показывать фамилию преподавателя
};
// ──────────────────────────────────────────────────────────────

const BASE = "https://lk.gubkin.ru";

const KEY_LOGIN = "gubkin_login";
const KEY_PASS = "gubkin_pass";
const KEY_GROUP_ID = "gubkin_group_id";
const KEY_GROUP_CODE = "gubkin_group_code";

const COLORS = {
  Лекция: new Color("#4f9dde"),
  Семинар: new Color("#56c271"),
  "Лабораторная работа": new Color("#e0a43b"),
  Мероприятие: new Color("#b07cd6"),
  default: new Color("#8a8f98"),
};

// ───────────────── Сохранённые данные ─────────────────
function hasCreds() {
  return Keychain.contains(KEY_LOGIN) && Keychain.contains(KEY_PASS);
}
function hasGroup() {
  return Keychain.contains(KEY_GROUP_ID);
}
function savedGroupId() {
  return hasGroup() ? Number(Keychain.get(KEY_GROUP_ID)) : 0;
}
function savedGroupCode() {
  return Keychain.contains(KEY_GROUP_CODE) ? Keychain.get(KEY_GROUP_CODE) : "";
}

// ───────────────── Поиск группы по коду ─────────────────
// Приводит код группы к единому виду: «гм 24-11» и «ГМ-24-11» превращаются
// в «ГМ2411». Латиницу меняем на русские буквы одним из двух способов:
// по похожему виду (M→М, H→Н, P→Р) или по звучанию (G→Г, H→Х, P→П).
const LAT_LOOK = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
const LAT_SOUND = { A: "А", B: "Б", C: "Ц", D: "Д", E: "Е", F: "Ф", G: "Г", H: "Х", I: "И", J: "Й", K: "К", L: "Л", M: "М", N: "Н", O: "О", P: "П", Q: "К", R: "Р", S: "С", T: "Т", U: "У", V: "В", W: "В", X: "Х", Y: "Ы", Z: "З" };
function normGroup(s, map = LAT_LOOK) {
  return String(s || "")
    .toUpperCase()
    .replace(/[A-Z]/g, (ch) => map[ch] || ch)
    .replace(/Ё/g, "Е")
    .replace(/[^0-9А-Я]/g, "");
}

// Ищет группу в списке; если не нашёл — подбирает похожие коды для подсказки
function matchGroup(groups, input) {
  const target = normGroup(input);
  const found =
    groups.find((g) => normGroup(g.code) === target) ||
    groups.find((g) => normGroup(g.code) === normGroup(input, LAT_SOUND));
  if (found) return { found };
  const letters = target.replace(/[0-9]/g, "");
  const year = target.replace(/\D/g, "").slice(0, 2);
  const uniq = (list) => [...new Set(list.map((g) => g.code))].sort();
  const sameLetters = groups.filter((g) => letters && normGroup(g.code).startsWith(letters));
  const sameYear = sameLetters.filter((g) => year && normGroup(g.code).startsWith(letters + year));
  const similar = uniq(sameYear.length ? sameYear : sameLetters).slice(0, 6);
  return { found: null, similar };
}

// ───────────────── Работа с сетью (через встроенный браузер) ─────────────────
// Сервер расписания тормозит запросы, которые не похожи на браузер, а сам сайт
// в Safari работает. Поэтому открываем страницу кабинета в невидимом встроенном
// браузере (тот же движок, что у Safari) и делаем запросы прямо со страницы —
// для сервера это ничем не отличается от тебя в Safari.

// Код, который выполняется внутри страницы кабинета. Возвращает JSON-строку.
function pageScript(task) {
  return `
(async () => {
  const task = ${JSON.stringify(task)};
  const withTimeout = (p, ms) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
  const getJSON = async (url, opts) => {
    const r = await withTimeout(fetch(url, Object.assign({ credentials: "include" }, opts || {})), task.timeoutMs);
    const text = await r.text();
    if (r.status === 418 || r.status === 429 || !text.trim()) return { blocked: true, status: r.status };
    try { return JSON.parse(text); } catch (e) { return { badFormat: true, status: r.status }; }
  };
  const API = "/schedule/api/api.php?";
  try {
    if (task.kind === "login") {
      const res = await getJSON("/api/api.php?module=auth&method=login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ login: task.login, password: task.password, rememberMe: 1 }),
      });
      completion(JSON.stringify(res));
    } else if (task.kind === "groups") {
      // Все группы всех факультетов: так найдём группу по коду
      await getJSON(API + "act=meta").catch(() => null);
      const fac = await getJSON(API + "act=list&method=getFaculties");
      if (!fac || !Array.isArray(fac.rows)) { completion(JSON.stringify({ blocked: !!(fac && fac.blocked) })); return; }
      const groups = [];
      for (const f of fac.rows) {
        const g = await getJSON(API + "act=list&method=getFacultyGroups&facultyId=" + encodeURIComponent(f.id)).catch(() => null);
        for (const row of (g && g.rows) || []) groups.push({ id: row.id, code: row.code });
      }
      completion(JSON.stringify({ groups }));
    } else {
      // Как сайт: сначала служебные запросы, потом расписание
      await getJSON(API + "act=meta").catch(() => null);
      await getJSON(API + "act=list&method=getStudies").catch(() => null);
      const weeks = [];
      for (const d of task.dates) {
        weeks.push(await getJSON(API + "act=schedule&groupId=" + task.groupId + "&date=" + d));
      }
      completion(JSON.stringify({ weeks }));
    }
  } catch (e) {
    completion(JSON.stringify({ error: String(e && e.message || e) }));
  }
})();
// Последнее выражение должно быть простым значением, а не Promise —
// иначе Scriptable падает с «результат неподдерживаемого типа»
null;
`;
}

async function runInPage(wv, task) {
  const raw = await wv.evaluateJavaScript(pageScript(task), true);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Непонятный ответ страницы кабинета.");
  }
}

const BLOCKED_MSG = "Сервер расписания временно ограничил доступ. Попробуй позже.";
function requestTimeout() {
  return config.runsInWidget ? 12000 : 30000;
}

// Открывает кабинет во встроенном браузере и входит. Возвращает браузер,
// уже стоящий на странице расписания — с него и делаем запросы.
async function openSession(login, password) {
  const wv = new WebView();
  await wv.loadURL(BASE + "/login/");
  const auth = await runInPage(wv, { kind: "login", login, password, timeoutMs: requestTimeout() });
  if (auth.error) throw new Error("Нет связи с кабинетом (" + auth.error + ").");
  if (auth.blocked || auth.badFormat) throw new Error("Кабинет не ответил на вход. Попробуй позже.");
  if (auth.success !== true) {
    const e = new Error(auth.reason || "Не удалось войти. Проверь логин и пароль.");
    e.isAuth = true; // неверный логин или пароль — можно переспросить
    throw e;
  }
  await wv.loadURL(BASE + "/schedule/");
  return wv;
}

async function loadAllGroups(wv) {
  const res = await runInPage(wv, { kind: "groups", timeoutMs: requestTimeout() });
  if (res.error) throw new Error(res.error === "timeout" ? BLOCKED_MSG : "Нет связи (" + res.error + ").");
  if (!res.groups || !res.groups.length) throw new Error(res.blocked ? BLOCKED_MSG : "Не удалось получить список групп.");
  return res.groups;
}

// Загружает недели расписания для указанных дат (ДД-ММ-ГГГГ)
async function fetchWeeksViaBrowser(dates, session) {
  const wv = session || (await openSession(Keychain.get(KEY_LOGIN), Keychain.get(KEY_PASS)));
  const res = await runInPage(wv, { kind: "schedule", dates, groupId: savedGroupId(), timeoutMs: requestTimeout() });
  if (res.error) throw new Error(res.error === "timeout" ? BLOCKED_MSG : "Нет связи (" + res.error + ").");
  return res.weeks.map((w) => {
    if (!w || w.blocked) throw new Error(BLOCKED_MSG);
    if (w.badFormat || !w.rows) throw new Error("Непонятный ответ сервера расписания.");
    return w.rows;
  });
}

// ───────────────── Настройка: логин, пароль, группа ─────────────────
async function askSetup(opts, message) {
  const a = new Alert();
  a.title = "Расписание Губкина";
  a.message = message;
  if (opts.creds) {
    a.addTextField("Логин от ЛК", Keychain.contains(KEY_LOGIN) ? Keychain.get(KEY_LOGIN) : "");
    a.addSecureTextField("Пароль от ЛК");
  }
  if (opts.group) a.addTextField("Группа, например ГМ-24-11", savedGroupCode());
  a.addAction("Готово");
  a.addCancelAction("Отмена");
  if ((await a.present()) === -1) return null;
  let i = 0;
  const ans = {};
  if (opts.creds) {
    ans.login = a.textFieldValue(i++).trim();
    ans.password = a.textFieldValue(i++);
  }
  if (opts.group) ans.group = a.textFieldValue(i++).trim();
  return ans;
}

// Спрашивает нужное, проверяет вход и ищет группу. Возвращает открытую сессию,
// чтобы сразу загрузить расписание без второго входа.
async function runSetup(opts) {
  opts = Object.assign({}, opts);
  let message = opts.creds
    ? "Логин и пароль от lk.gubkin.ru сохранятся только на этом iPhone." + (opts.group ? " Группу впиши так, как она пишется в ЛК." : "")
    : "Впиши код своей группы так, как он пишется в ЛК.";
  for (let attempt = 0; attempt < 5; attempt++) {
    const ans = await askSetup(opts, message);
    if (!ans) throw new Error("Настройка отменена. Запусти скрипт ещё раз.");
    const login = opts.creds ? ans.login : Keychain.get(KEY_LOGIN);
    const password = opts.creds ? ans.password : Keychain.get(KEY_PASS);
    if (!login || !password) {
      message = "Нужны и логин, и пароль.";
      continue;
    }
    if (opts.group && !normGroup(ans.group)) {
      message = "Впиши код группы, например ГМ-24-11.";
      continue;
    }

    let wv;
    try {
      wv = await openSession(login, password);
    } catch (e) {
      if (e.isAuth) {
        message = e.message;
        continue;
      }
      throw e;
    }
    if (opts.creds) {
      Keychain.set(KEY_LOGIN, login);
      Keychain.set(KEY_PASS, password);
      opts.creds = false; // логин подошёл — дальше переспрашиваем только группу
    }

    if (opts.group) {
      const m = matchGroup(await loadAllGroups(wv), ans.group);
      if (!m.found) {
        message = "Группа «" + ans.group + "» не найдена." + (m.similar.length ? " Похожие: " + m.similar.join(", ") + "." : " Проверь код в ЛК.");
        continue;
      }
      Keychain.set(KEY_GROUP_ID, String(m.found.id));
      Keychain.set(KEY_GROUP_CODE, m.found.code);
      clearCache(); // в памяти расписание старой группы
    }
    return wv;
  }
  throw new Error("Не получилось настроить. Запусти скрипт ещё раз.");
}

// Меню при запуске в приложении, когда всё уже настроено
async function appMenu() {
  const a = new Alert();
  a.title = "Расписание " + savedGroupCode();
  a.addAction("Показать расписание");
  a.addAction("Сменить группу");
  a.addAction("Сменить логин и пароль");
  a.addCancelAction("Закрыть");
  const idx = await a.present();
  if (idx === 1) return { session: await runSetup({ group: true }) };
  if (idx === 2) return { session: await runSetup({ creds: true }) };
  if (idx === -1) return { close: true };
  return {};
}

// ───────────────── Разбор расписания ─────────────────
function ddmmyyyy(d) {
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "-" + p(d.getMonth() + 1) + "-" + d.getFullYear();
}
function weekdayIndex(d) {
  // 0 = Пн ... 6 = Вс
  return (d.getDay() + 6) % 7;
}
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function lessonsForDay(rows, wdn) {
  const org = (rows.organizations || [])[0];
  if (!org) return { chunks: [], list: [] };
  const TC = org.lessonsTimeChunks || [];
  let list = (org.lessons || []).filter((l) => l.weekDayNumber === wdn);
  if (CONFIG.subgroup !== 0) {
    list = list.filter((l) => l.subgroup === 0 || l.subgroup === CONFIG.subgroup);
  }
  const mapped = list.map((l) => {
    const first = l.timeChunks[0];
    const last = l.timeChunks[l.timeChunks.length - 1];
    const start = TC[first].split("-")[0];
    const end = TC[last].split("-")[1];
    const teacher = (l.teachers || [])
      .map((t) => t.lastName + (t.firstName ? " " + t.firstName[0] + "." : "") + (t.patronymic ? t.patronymic[0] + "." : ""))
      .join(", ");
    return {
      start,
      end,
      startMin: toMinutes(start),
      endMin: toMinutes(end),
      type: l.type,
      name: l.course ? l.course.name : "—",
      room: (l.rooms || []).map((r) => r.number).join(", "),
      teacher,
      subgroup: l.subgroup,
    };
  });
  mapped.sort((a, b) => a.startMin - b.startMin);
  return { week: rows.week, list: mapped };
}

function mondayOf(d) {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - weekdayIndex(m)); // откат к понедельнику
  return m;
}
function weekKey(rows) {
  const days = rows && rows.week && rows.week.weekRussia ? rows.week.weekRussia.days : null;
  return days && days[0] ? days[0].date : null; // дата понедельника этой недели
}

// ───────────────── Кэш на диске ─────────────────
const FM = FileManager.local();
// Папка «Документы» Scriptable общая для приложения и виджета на рабочем столе
// (у папки cache виджет свою копию, и сохранённое в приложении он не видел)
const CACHE_PATH = FM.joinPath(FM.documentsDirectory(), "gubkin_sched_cache.json");

// Виджету iOS даёт очень мало времени. Если загрузка не успевает — бросаем её
// и показываем сохранённое, чтобы виджет не падал с «timeout».
const WIDGET_DEADLINE_MS = 15000;
function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => Timer.schedule(ms, false, () => rej(new Error("Не успел обновиться")))),
  ]);
}
const FRESH_MS = 3 * 60 * 60 * 1000; // обновляем из сети не чаще, чем раз в 3 часа

// Кэш хранит расписание одной группы; если группа сменилась — он не подходит
function loadCache() {
  const empty = { groupId: savedGroupId(), fetchedAt: 0, weeks: {} };
  try {
    if (FM.fileExists(CACHE_PATH)) {
      const c = JSON.parse(FM.readString(CACHE_PATH));
      if (c.groupId === savedGroupId()) return c;
    }
  } catch (e) {}
  return empty;
}
function saveCache(c) {
  try {
    FM.writeString(CACHE_PATH, JSON.stringify(c));
  } catch (e) {}
}
function clearCache() {
  try {
    if (FM.fileExists(CACHE_PATH)) FM.remove(CACHE_PATH);
  } catch (e) {}
}

// Готовит расписание: берёт из кэша, а в сеть ходит только если данные устарели.
// При сбое сети возвращает то, что уже сохранено. Делает максимум 1 вход + 2 запроса.
async function ensureSchedule(session) {
  const now = new Date();
  const cache = loadCache();
  const monKey = ddmmyyyy(mondayOf(now));
  const nextMon = new Date(mondayOf(now));
  nextMon.setDate(nextMon.getDate() + 7);
  const nextKey = ddmmyyyy(nextMon);

  const haveCurrent = !!cache.weeks[monKey];
  const stale = now.getTime() - (cache.fetchedAt || 0) > FRESH_MS;
  let networkError = null;

  if (stale || !haveCurrent) {
    try {
      // Одним заходом берём текущую и следующую неделю (2 запроса расписания)
      const load = fetchWeeksViaBrowser([ddmmyyyy(now), nextKey], session);
      const got = config.runsInWidget ? await withDeadline(load, WIDGET_DEADLINE_MS) : await load;
      for (const w of got) {
        const k = weekKey(w);
        if (k) cache.weeks[k] = w;
      }
      cache.fetchedAt = now.getTime();
      // чистим старые недели, храним только текущую и следующую
      const keep = {};
      if (cache.weeks[monKey]) keep[monKey] = cache.weeks[monKey];
      if (cache.weeks[nextKey]) keep[nextKey] = cache.weeks[nextKey];
      cache.weeks = keep;
      saveCache(cache);
    } catch (e) {
      networkError = e; // оставляем старый кэш
    }
  }
  return { weeks: cache.weeks, fetchedAt: cache.fetchedAt, networkError };
}

// Выбирает ближайший день с занятиями, читая только из подготовленного кэша недель
function pickDay(weeks, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(now);
    d.setDate(now.getDate() + offset);
    const rows = weeks[ddmmyyyy(mondayOf(d))];
    if (!rows) continue; // этой недели нет в кэше
    const { week, list } = lessonsForDay(rows, weekdayIndex(d));
    if (!list.length) continue;
    // Сегодня показываем весь день, пока не кончится последняя пара
    if (offset === 0 && Math.max(...list.map((x) => x.endMin)) <= nowMin) continue; // все пары прошли → следующий день
    return { date: d, offset, week, lessons: list };
  }
  return { date: now, offset: 0, lessons: [], week: null };
}

// ───────────────── Виджет ─────────────────
const WD_RU = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const MON_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function buildWidget(data) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#15181d");
  w.setPadding(12, 14, 12, 14);

  const d = data.date;
  const weekType = data.week && data.week.weekRussia ? (data.week.weekRussia.type === "upper" ? "верхняя" : "нижняя") : "";

  const header = w.addStack();
  header.layoutHorizontally();
  const title = header.addText(data.offset === 0 ? "Сегодня" : WD_RU[weekdayIndex(d)]);
  title.font = Font.semiboldSystemFont(15);
  title.textColor = Color.white();
  header.addSpacer();
  const dateLbl = header.addText(d.getDate() + " " + MON_RU[d.getMonth()] + (weekType ? " · " + weekType : ""));
  dateLbl.font = Font.systemFont(11);
  dateLbl.textColor = new Color("#8a8f98");
  w.addSpacer(6);

  // Если свежие данные не удалось получить — мягко сообщаем и показываем из памяти
  if (data.note) {
    const note = w.addText(data.note);
    note.font = Font.systemFont(9);
    note.textColor = new Color("#e0a43b");
    w.addSpacer(4);
  }

  if (!data.lessons.length) {
    const empty = w.addText("На ближайшие дни занятий нет 🎉");
    empty.font = Font.systemFont(13);
    empty.textColor = new Color("#8a8f98");
    w.addSpacer();
    w.refreshAfterDate = nextRefreshDate(data);
    return w;
  }

  // Показываем ВСЕ пары дня (их не больше 6). Размер строки подстраиваем,
  // чтобы на большом виджете поместилось до 6 строк.
  const total = data.lessons.length;
  const compact = total >= 5;
  const barH = compact ? 28 : 34;
  const nameFont = compact ? 11 : 12;
  const gap = compact ? 4 : 6;

  // Параллельные пары (одинаковое время начала) идут подряд — так видно,
  // что это одновременные занятия для разных подгрупп.
  for (let i = 0; i < data.lessons.length; i++) {
    const l = data.lessons[i];
    const prev = data.lessons[i - 1];
    const parallel = prev && prev.start === l.start; // идёт в то же время, что и прошлая

    const row = w.addStack();
    row.layoutHorizontally();
    row.spacing = 8;

    // Цветная полоска по типу пары
    const bar = row.addStack();
    bar.size = new Size(3, barH);
    bar.cornerRadius = 2;
    bar.backgroundColor = COLORS[l.type] || COLORS.default;

    const time = row.addStack();
    time.layoutVertically();
    time.size = new Size(44, 0);
    if (parallel) {
      // У параллельной пары время не повторяем — ставим пунктир
      const t1 = time.addText("┊");
      t1.font = Font.mediumSystemFont(12);
      t1.textColor = new Color("#8a8f98");
    } else {
      const t1 = time.addText(l.start);
      t1.font = Font.mediumSystemFont(12);
      t1.textColor = Color.white();
      const t2 = time.addText(l.end);
      t2.font = Font.systemFont(10);
      t2.textColor = new Color("#8a8f98");
    }

    const info = row.addStack();
    info.layoutVertically();

    // Строка названия + пометка подгруппы цветом
    const nameRow = info.addStack();
    nameRow.layoutHorizontally();
    nameRow.spacing = 5;
    const nameTxt = nameRow.addText(l.name);
    nameTxt.font = Font.mediumSystemFont(nameFont);
    nameTxt.textColor = Color.white();
    nameTxt.lineLimit = 1;
    if (l.subgroup) {
      const sg = nameRow.addText("п/г " + l.subgroup);
      sg.font = Font.semiboldSystemFont(nameFont - 1);
      sg.textColor = l.subgroup === 1 ? new Color("#56c271") : new Color("#e0a43b");
    }

    let sub = l.room ? "ауд. " + l.room : "";
    if (CONFIG.showTeacher && l.teacher) sub += (sub ? " · " : "") + l.teacher;
    const subTxt = info.addText(sub);
    subTxt.font = Font.systemFont(compact ? 9 : 10);
    subTxt.textColor = new Color("#8a8f98");
    subTxt.lineLimit = 1;

    w.addSpacer(gap);
  }

  w.refreshAfterDate = nextRefreshDate(data);
  return w;
}

// Когда попросить iOS перерисовать виджет: только после конца последней пары
// сегодня (тогда он переключится на следующий день), а если уже показан
// следующий день — в полночь, чтобы «Пятница» сменилась на «Сегодня».
function nextRefreshDate(data) {
  const now = new Date();
  if (data.offset === 0 && data.lessons.length) {
    const t = new Date(now);
    t.setHours(0, Math.max(...data.lessons.map((l) => l.endMin)), 30, 0); // через 30 сек после последней пары
    return t;
  }
  const midnight = new Date(now);
  midnight.setHours(24, 0, 30, 0);
  return midnight;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#15181d");
  const t = w.addText("Расписание Губкина");
  t.font = Font.semiboldSystemFont(14);
  t.textColor = Color.white();
  w.addSpacer(6);
  const e = w.addText("⚠️ " + msg);
  e.font = Font.systemFont(11);
  e.textColor = new Color("#e0a43b");
  return w;
}

function fmtAgo(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return mins + " мин назад";
  const h = Math.round(mins / 60);
  if (h < 24) return h + " ч назад";
  return Math.round(h / 24) + " дн назад";
}

// ───────────────── Запуск ─────────────────
async function main() {
  let widget;
  try {
    let session = null;
    if (!hasCreds() || !hasGroup()) {
      if (config.runsInWidget) throw new Error("Открой скрипт в приложении Scriptable и введи логин и группу.");
      // Первый запуск: спрашиваем логин и пароль (если их нет) и группу
      session = await runSetup({ creds: !hasCreds(), group: true });
    } else if (!config.runsInWidget) {
      const choice = await appMenu();
      if (choice.close) return Script.complete();
      session = choice.session || null;
    }

    const { weeks, fetchedAt, networkError } = await ensureSchedule(session);

    if (!Object.keys(weeks).length) {
      // Совсем нет данных (ни в сети, ни в памяти)
      if (config.runsInWidget) {
        throw new Error("Открой скрипт один раз в приложении Scriptable — он загрузит расписание.");
      }
      throw networkError || new Error("Нет данных расписания");
    }

    const now = new Date();
    const data = pickDay(weeks, now);
    // Если обновиться не удалось, но что-то есть в памяти — показываем с пометкой
    if (networkError) data.note = "Обновлено " + fmtAgo(fetchedAt);
    widget = buildWidget(data);
  } catch (e) {
    widget = errorWidget(String(e.message || e));
  }
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentLarge();
  }
  Script.complete();
}

await main();
