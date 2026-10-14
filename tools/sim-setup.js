// Прогоняет виджет в Node с подставными объектами Scriptable и поддельным сервером.
// Проверяет: распознавание кода группы, первый запуск, меню, смену группы, кэш.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "gubkin-raspisanie.js"), "utf8").replace(/\nawait main\(\);\s*$/, "\n");

const FACULTIES = [{ id: 0 }, { id: 4 }, { id: -5 }];
const GROUPS = {
  0: [{ id: 9735, code: "ГМ-24-11" }, { id: 9800, code: "ГМ-24-12" }, { id: 8892, code: "ГИ-22-04" }],
  4: [{ id: 5001, code: "ХТ-23-01" }],
  "-5": [],
};
const TC = ["8:30-9:15", "9:15-10:00", "10:15-11:00", "11:00-11:45"];

function makeEnv(store, answers, log) {
  const files = {};
  const Keychain = {
    contains: (k) => k in store, get: (k) => store[k], set: (k, v) => { store[k] = v; }, remove: (k) => delete store[k],
  };
  class Alert {
    constructor() { this.fields = []; this.actions = []; }
    addTextField(p, t) { this.fields.push({ p, v: t || "" }); }
    addSecureTextField(p, t) { this.fields.push({ p, v: t || "" }); }
    addAction(a) { this.actions.push(a); }
    addCancelAction() {}
    async present() {
      const ans = answers.shift();
      log.push("ОКНО «" + (this.message || this.title) + "» поля=[" + this.fields.map((f) => f.p).join(", ") + "]");
      if (ans === undefined) throw new Error("лишнее окно");
      if (ans.fields) ans.fields.forEach((v, i) => (this.fields[i].v = v));
      return ans.idx;
    }
    textFieldValue(i) { return this.fields[i].v; }
  }
  const fetchFake = async (url, opts) => {
    const r = (o) => ({ status: 200, text: async () => JSON.stringify(o) });
    if (url.includes("method=login")) {
      const b = JSON.parse(opts.body);
      return r(b.password === "верный" ? { success: true } : { success: false, reason: "Неверный логин/пароль." });
    }
    if (url.includes("getFaculties")) return r({ rows: FACULTIES });
    const m = url.match(/getFacultyGroups&facultyId=([-\d]+)/);
    if (m) return r({ rows: GROUPS[decodeURIComponent(m[1])] });
    const s = url.match(/act=schedule&groupId=(\d+)&date=(\d\d)-(\d\d)-(\d{4})/);
    if (s) {
      log.push("  запрос расписания группы " + s[1]);
      const d = new Date(+s[4], +s[3] - 1, +s[2]);
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const p = (n) => String(n).padStart(2, "0");
      const days = [...Array(7)].map((_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return { date: p(x.getDate()) + "-" + p(x.getMonth() + 1) + "-" + x.getFullYear() }; });
      return r({ rows: { week: { weekRussia: { type: "upper", days } }, organizations: [{ lessonsTimeChunks: TC, lessons: [0, 1, 2, 3, 4].map((wd) => ({ weekDayNumber: wd, timeChunks: [2, 3], type: "Лекция", subgroup: 0, course: { name: "Пара группы " + s[1] }, rooms: [], teachers: [] })) }] } });
    }
    return r({ rows: [] });
  };
  class WebView {
    async loadURL(u) { this.url = u; }
    async evaluateJavaScript(code) {
      return new Promise((res) => new Function("fetch", "completion", "setTimeout", code)(fetchFake, res, setTimeout));
    }
  }
  const stub = () => new Proxy(function () {}, { get: () => stub(), apply: () => stub(), construct: () => stub(), set: () => true });
  let shown = null;
  class ListWidget {
    constructor() { this.texts = []; }
    addText(t) { this.texts.push(t); return stub(); }
    addStack() { const self = this; return new Proxy({}, { get: (o, k) => (k === "addText" ? (t) => (self.texts.push(t), stub()) : k === "addStack" ? () => self.addStack() : () => stub()), set: () => true }); }
    addSpacer() {} setPadding() {}
    async presentLarge() { shown = this.texts; }
  }
  const FileManager = { local: () => ({
    joinPath: (a, b) => a + "/" + b, documentsDirectory: () => "docs",
    fileExists: (p) => p in files, readString: (p) => files[p], writeString: (p, s) => (files[p] = s), remove: (p) => delete files[p],
  }) };
  const env = {
    Keychain, Alert, WebView, ListWidget, FileManager, Color: Object.assign(function () {}, { white: () => ({}) }), Font: stub(), Size: function () {},
    Timer: { schedule: (ms, r, cb) => setTimeout(cb, ms) },
    Script: { complete() {}, setWidget() {} }, config: { runsInWidget: false },
  };
  return { env, files, getShown: () => shown };
}

async function run(title, store, answers, files) {
  const log = [];
  const { env, files: f, getShown } = makeEnv(store, answers, log);
  if (files) Object.assign(f, files);
  const fn = new Function(...Object.keys(env), src + "\nreturn { main, normGroup, matchGroup };");
  const api = fn(...Object.values(env));
  await api.main();
  const shown = getShown() || [];
  console.log("\n== " + title);
  log.forEach((l) => console.log("  " + l));
  console.log("  Keychain: группа=" + (store.gubkin_group_code || "—") + " (id " + (store.gubkin_group_id || "—") + "), логин сохранён=" + ("gubkin_login" in store));
  console.log("  На экране: " + shown.filter((t) => typeof t === "string").slice(0, 3).join(" | "));
  if (answers.length) console.log("  !!! не все ответы использованы:", answers.length);
  return { api, files: f };
}

(async () => {
  // 1) Распознавание кода группы
  const { api } = await run("Проверка кодов (сразу первый запуск)", {}, [
    { idx: 0, fields: ["123456", "верный", "гм 24 11"] },
  ]);
  const groups = Object.values(GROUPS).flat();
  for (const t of ["ГМ-24-11", "гм-24-11", "GM-24-11", "ГМ 24 11", "ГМ-24-13", "XT-23-01", "ЗЗ-99"]) {
    const m = api.matchGroup(groups, t);
    console.log("  «" + t + "» →", m.found ? "найдена " + m.found.code : "не найдена, похожие: " + (m.similar.join(", ") || "нет"));
  }

  // 2) Первый запуск: неверный пароль, потом верный, потом опечатка в группе
  const store = {};
  const r2 = await run("Первый запуск: ошибка пароля и опечатка в группе", store, [
    { idx: 0, fields: ["123456", "неверный", "ГМ-24-11"] },
    { idx: 0, fields: ["123456", "верный", "ГМ-24-13"] },
    { idx: 0, fields: ["ГМ-24-11"] },
  ]);

  // 3) Повторный запуск: меню → показать (кэш свежий, сервер не трогаем)
  await run("Повторный запуск: «Показать расписание»", store, [{ idx: 0 }], r2.files);

  // 4) Смена группы через меню
  await run("Меню → «Сменить группу» на ГМ-24-12", store, [{ idx: 1 }, { idx: 0, fields: ["гм-24-12"] }], r2.files);

  // 5) Старая версия: логин есть, группы нет (как у Мартина сейчас)
  await run("Обновление со старой версии: спросит только группу", { gubkin_login: "123456", gubkin_pass: "верный" }, [
    { idx: 0, fields: ["ГМ-24-11"] },
  ]);
})().catch((e) => { console.error("ОШИБКА:", e); process.exit(1); });
