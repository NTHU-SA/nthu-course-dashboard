"use strict";

const $ = (id) => document.getElementById(id);
const DAY_NAMES = { M: "一", T: "二", W: "三", R: "四", F: "五", S: "六", U: "日" };
const FIELD_NAMES = {
  id: "課號", chinese_title: "中文課名", english_title: "英文課名", credit: "學分",
  size_limit: "人限", student_count: "選課人數", lecturer: "授課教師", language: "授課語言",
  class_room_and_time: "教室與時間原文", classroom: "教室", time: "時段",
  note: "備註", suspend: "停開註記", limit_note: "選課限制",
  freshman_reservation: "新生保留人數", object: "開課對象", ge_type: "通識對象",
  ge_category: "通識類別", prerequisite: "擋修", expertise: "專長對應",
  program: "學分學程", no_extra_selection: "不可加簽說明",
  required_optional_note: "必選修說明",
};
const FILTER_IDS = ["search", "unit", "language", "ge", "credit", "capacity", "day", "period", "suspend"];
const PAGE_SIZE = 40;
const fmt = new Intl.NumberFormat("zh-TW");
const dateFmt = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const shortDateFmt = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
});
const state = { bundle: null, selected: 0, page: 0, filtered: [], changeLimit: 100 };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function svgNode(tag, attrs = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function title(course) { return course.chinese_title || course.english_title || course.id; }
function date(value) { return dateFmt.format(new Date(value)); }
function sourceURL(sha) { return `https://github.com/NTHU-SA/NTHU-Data-Scraper/commit/${sha}`; }
function coursesAt(index) {
  return state.bundle.snapshots[index].indices.map((i) => state.bundle.versions[i]);
}
function courseAt(index, identity) {
  if (index < 0) return null;
  return coursesAt(index).find((course) => course.id === identity) || null;
}
function coverage(summary) {
  return summary.courses ? `${(100 * summary.capacity_known / summary.courses).toFixed(1)}%` : "—";
}
function capacityText(course) {
  if (course.size_limit_state === "unknown") return "未提供";
  if (course.size_limit_state === "invalid") return `異常：${course.size_limit}`;
  if (course.size_limit_state === "zero") return "0（待確認）";
  return fmt.format(course.size_limit_value);
}
function addOptions(id, values) {
  const select = $(id);
  for (const value of [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-TW", { numeric: true }))) {
    const option = node("option", value);
    option.value = value;
    select.append(option);
  }
}
function tally(courses, field, fallback = "未提供") {
  const result = new Map();
  for (const course of courses) {
    const value = course[field] || fallback;
    result.set(value, (result.get(value) || 0) + 1);
  }
  return [...result].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-TW"));
}
function applyFilter(id, value) {
  $(id).value = value;
  state.page = 0;
  render();
}
function barChart(id, entries, onSelect, limit = 12, selectedValue = null) {
  const container = $(id);
  container.replaceChildren();
  if (!entries.length) { container.append(node("p", "沒有符合條件的資料", "empty")); return; }
  const max = Math.max(...entries.map((entry) => entry[1]), 1);
  const list = node("div", null, "bar-list");
  for (const [label, count, value] of entries.slice(0, limit)) {
    const row = node(onSelect ? "button" : "div", null, "bar-row");
    const selected = selectedValue !== null && (value ?? label) === selectedValue;
    if (onSelect) {
      row.type = "button";
      row.setAttribute("aria-label", `篩選 ${label}，${count} 門課`);
      row.setAttribute("aria-pressed", String(selected));
      row.addEventListener("click", () => onSelect(value === undefined ? label : value));
    }
    row.title = label;
    const track = node("span", null, "bar-track");
    const fill = node("span", null, "bar-fill");
    fill.style.width = `${100 * count / max}%`;
    track.append(fill);
    const labelElement = node("span", label, "bar-label");
    if (selected) labelElement.append(node("span", "已選", "selection-label"));
    row.append(labelElement, track, node("span", fmt.format(count), "bar-count"));
    list.append(row);
  }
  container.append(list);
}

function matches(course) {
  const query = $("search").value.trim().toLocaleLowerCase();
  if (query && ![course.id, course.chinese_title, course.english_title, course.lecturer]
    .some((value) => (value || "").toLocaleLowerCase().includes(query))) return false;
  if ($("unit").value && course.unit !== $("unit").value) return false;
  if ($("language").value === "__missing" && course.language) return false;
  if ($("language").value && $("language").value !== "__missing" && course.language !== $("language").value) return false;
  const ge = $("ge").value;
  if (ge === "__any" && !course.ge_category) return false;
  if (ge === "__none" && course.ge_category) return false;
  if (ge && !ge.startsWith("__") && course.ge_category !== ge) return false;
  if ($("credit").value === "__missing" && course.credit) return false;
  if ($("credit").value && $("credit").value !== "__missing" && course.credit !== $("credit").value) return false;
  const cap = $("capacity").value;
  if (["positive", "unknown", "zero", "invalid"].includes(cap) && course.size_limit_state !== cap) return false;
  if (cap.includes("-")) {
    const [min, max] = cap.split("-").map(Number);
    if (course.size_limit_state !== "positive" || course.size_limit_value < min || course.size_limit_value > max) return false;
  }
  if (cap === "101+" && (course.size_limit_state !== "positive" || course.size_limit_value < 101)) return false;
  const day = $("day").value, period = $("period").value;
  if ((day || period) && !course.slots.some((slot) => (!day || slot[0] === day) && (!period || slot[1] === period))) return false;
  if ($("suspend").value === "yes" && !course.suspend) return false;
  if ($("suspend").value === "no" && course.suspend) return false;
  return true;
}

function renderMetrics(courses) {
  const positive = courses.filter((course) => course.size_limit_state === "positive");
  const english = courses.filter((course) => course.language === "英").length;
  const entries = [
    ["課程數", fmt.format(courses.length), ""],
    ["開課單位", fmt.format(new Set(courses.map((course) => course.unit)).size), ""],
    ["英語授課", courses.length ? `${(100 * english / courses.length).toFixed(1)}%` : "—", `${fmt.format(english)} 門`],
    ["通識課程", fmt.format(courses.filter((course) => course.ge_category).length), ""],
    ["已知人限合計", positive.length ? fmt.format(positive.reduce((sum, course) => sum + course.size_limit_value, 0)) : "—",
      `${fmt.format(positive.length)} 門・覆蓋 ${courses.length ? (100 * positive.length / courses.length).toFixed(1) : "0"}%`],
  ];
  $("metrics").replaceChildren(...entries.map(([label, value, note]) => {
    const card = node("article", null, "metric");
    card.append(node("p", label), node("strong", value));
    if (note) card.append(node("small", note));
    return card;
  }));
  barChart("unit-chart", tally(courses, "unit"), (value) => applyFilter("unit", value), 12, $("unit").value || null);
  barChart("language-chart", tally(courses, "language"),
    (value) => applyFilter("language", value === "未提供" ? "__missing" : value), 12,
    $("language").value === "__missing" ? "未提供" : $("language").value || null);
  barChart("credit-chart", tally(courses, "credit"),
    (value) => applyFilter("credit", value === "未提供" ? "__missing" : value), 12,
    $("credit").value === "__missing" ? "未提供" : $("credit").value || null);
  barChart("ge-chart", tally(courses, "ge_category", "非通識／未標示"),
    (value) => applyFilter("ge", value === "非通識／未標示" ? "__none" : value), 12,
    $("ge").value === "__none" ? "非通識／未標示" : $("ge").value || null);
  const groups = [
    ["1–30", 0, "1-30"], ["31–60", 0, "31-60"], ["61–100", 0, "61-100"],
    ["101 以上", 0, "101+"], ["0（語意未確認）", 0, "zero"], ["未提供", 0, "unknown"], ["格式異常", 0, "invalid"],
  ];
  for (const course of courses) {
    let i = 0;
    if (course.size_limit_state === "positive") {
      i = course.size_limit_value <= 30 ? 0 : course.size_limit_value <= 60 ? 1 : course.size_limit_value <= 100 ? 2 : 3;
    } else i = { zero: 4, unknown: 5, invalid: 6 }[course.size_limit_state];
    groups[i][1]++;
  }
  barChart("capacity-chart", groups.filter((entry) => entry[1]),
    (value) => applyFilter("capacity", value), 12, $("capacity").value || null);
}

function renderSchedule(courses) {
  const counts = new Map();
  for (const course of courses) for (const slot of course.slots) counts.set(slot, (counts.get(slot) || 0) + 1);
  const max = Math.max(...counts.values(), 1);
  const table = node("table", null, "heat-table");
  const head = node("thead"), header = node("tr");
  header.append(node("th", "節次"));
  for (const day of state.bundle.days) {
    const th = node("th", `週${DAY_NAMES[day]}`);
    th.scope = "col";
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = node("tbody");
  for (const period of state.bundle.periods) {
    const row = node("tr"), heading = node("th", period);
    heading.scope = "row";
    row.append(heading);
    for (const day of state.bundle.days) {
      const count = counts.get(day + period) || 0;
      const cell = node("td"), button = node("button", count ? fmt.format(count) : "·");
      button.title = `週${DAY_NAMES[day]}・節次 ${period}：${count} 門課`;
      button.setAttribute("aria-label", `篩選 ${button.title}`);
      const level = count ? Math.min(4, Math.ceil(4 * count / max)) : 0;
      button.style.background = `var(--heat-${level})`;
      button.style.color = level === 4 ? "var(--color-on-action)" : "var(--color-text)";
      const selected = $("day").value === day && $("period").value === period;
      button.setAttribute("aria-pressed", String(selected));
      if (selected) button.append(node("span", "已選", "selection-label"));
      button.addEventListener("click", () => {
        $("day").value = day;
        $("period").value = period;
        state.page = 0;
        render();
      });
      cell.append(button); row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  $("heatmap").replaceChildren(table);
  const missing = courses.filter((course) => !course.time).length;
  const invalid = courses.filter((course) => course.issues.includes("time")).length;
  $("schedule-quality").textContent = `未提供時段 ${missing} 門・格式異常 ${invalid} 門（未列入熱圖）`;
  barChart("room-chart", tally(courses, "classroom"), null, 10);
  barChart("teacher-chart", tally(courses, "lecturer"), null, 10);
}

function sortedCourses() {
  const courses = [...state.filtered];
  const sort = $("sort").value;
  return courses.sort((a, b) => {
    if (sort === "title") return title(a).localeCompare(title(b), "zh-TW") || a.id.localeCompare(b.id);
    if (sort === "capacity-desc") {
      const av = a.size_limit_state === "positive" ? a.size_limit_value : -1;
      const bv = b.size_limit_state === "positive" ? b.size_limit_value : -1;
      return bv - av || a.id.localeCompare(b.id);
    }
    if (sort === "credit-desc") return (b.credit_value ?? -1) - (a.credit_value ?? -1) || a.id.localeCompare(b.id);
    return a.id.localeCompare(b.id);
  });
}

function renderTable() {
  const courses = sortedCourses();
  const pages = Math.max(1, Math.ceil(courses.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  $("course-rows").replaceChildren();
  for (const course of courses.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const row = node("tr"), identityCell = node("td");
    const link = node("button", title(course), "course-link");
    link.addEventListener("click", () => openDetail(course.id));
    identityCell.append(link, node("span", course.id, "course-id"));
    if (course.suspend) identityCell.append(node("span", `停開註記：${course.suspend}`, "pill removed"));
    row.append(identityCell);
    for (const value of [course.unit, course.lecturer || "未提供", course.credit || "未提供",
      course.language || "未提供", capacityText(course), course.time || "未提供"]) row.append(node("td", value));
    $("course-rows").append(row);
  }
  if (!courses.length) {
    const row = node("tr"), cell = node("td", "沒有符合條件的課程。", "empty");
    cell.colSpan = 7; row.append(cell); $("course-rows").append(row);
  }
  $("table-count").textContent = `${fmt.format(courses.length)} 門課`;
  $("sort").classList.toggle("has-value", $("sort").value !== "id");
  $("page-label").textContent = `第 ${state.page + 1} / ${pages} 頁`;
  $("prev").disabled = state.page === 0;
  $("next").disabled = state.page >= pages - 1;
  $("export").disabled = courses.length === 0;
}

function trend(container, points, label, noteForPoint, onSelect, selected = -1) {
  container.replaceChildren();
  if (!points.length || points.every((point) => point.value === null)) {
    container.append(node("p", "沒有可用數值。", "empty"));
    return;
  }
  const width = 550, height = 205, left = 58, right = 15, top = 24, bottom = 38;
  const times = points.map((point) => new Date(point.time).getTime());
  const minTime = Math.min(...times), timeRange = Math.max(...times) - minTime || 1;
  const values = points.filter((point) => point.value !== null).map((point) => point.value);
  const minValue = Math.min(...values), maxValue = Math.max(...values);
  const padding = Math.max((maxValue - minValue) * 0.15, maxValue * 0.03, 1);
  const low = Math.max(0, minValue - padding), high = maxValue + padding;
  const x = (i) => times.length === 1 ? (width + left - right) / 2 : left + (times[i] - minTime) / timeRange * (width - left - right);
  const y = (value) => height - bottom - (value - low) / (high - low) * (height - top - bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, class: "trend-svg",
    role: onSelect ? "group" : "img", "aria-label": label });
  svg.append(svgNode("title", {}, label));
  for (const value of [low, (low + high) / 2, high]) {
    const yy = y(value);
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: yy, y2: yy, class: "axis" }));
    svg.append(svgNode("text", { x: left - 8, y: yy + 4, "text-anchor": "end" }, fmt.format(Math.round(value))));
  }
  let path = "", started = false;
  points.forEach((point, i) => {
    if (point.value === null) { started = false; return; }
    path += `${started ? "L" : "M"}${x(i)},${y(point.value)} `;
    started = true;
  });
  svg.append(svgNode("path", { d: path, class: "line" }));
  points.forEach((point, i) => {
    if (point.value === null) return;
    const circle = svgNode("circle", { cx: x(i), cy: y(point.value), r: i === selected ? 5 : 3.5,
      class: i === selected ? "point selected" : "point" });
    const pointText = `${date(point.time)}：${fmt.format(point.value)}${noteForPoint ? `；${noteForPoint(point, i)}` : ""}`;
    circle.append(svgNode("title", {}, pointText));
    if (onSelect) {
      circle.setAttribute("tabindex", "0");
      circle.setAttribute("role", "button");
      circle.setAttribute("aria-label", pointText);
      circle.addEventListener("click", () => onSelect(i));
      circle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(i); }
      });
    }
    svg.append(circle);
  });
  svg.append(svgNode("text", { x: left, y: height - 9 }, shortDateFmt.format(new Date(points[0].time))));
  svg.append(svgNode("text", { x: width - right, y: height - 9, "text-anchor": "end" },
    shortDateFmt.format(new Date(points[points.length - 1].time))));
  const scroll = node("div", null, "chart-scroll");
  scroll.append(svg);
  container.append(scroll);
  const details = node("details", null, "trend-list"), list = node("div", null, "table-scroll"), table = node("table");
  details.append(node("summary", "明細"));
  const head = node("thead"), row = node("tr");
  for (const text of ["資料時間（台北）", "數值", "說明"]) row.append(node("th", text));
  head.append(row); table.append(head);
  const body = node("tbody");
  points.forEach((point, i) => {
    const tr = node("tr");
    const timeCell = node("td");
    if (onSelect) {
      const button = node("button", date(point.time), "text-button");
      button.setAttribute("aria-label", `查看 ${date(point.time)} 的課程資料`);
      button.addEventListener("click", () => onSelect(i));
      timeCell.append(button);
    } else timeCell.textContent = date(point.time);
    tr.append(timeCell, node("td", point.value === null ? "未提供" : fmt.format(point.value)),
      node("td", noteForPoint ? noteForPoint(point, i) : ""));
    body.append(tr);
  });
  table.append(body); list.append(table); details.append(list); container.append(details);
}

function setSnapshot(index) {
  state.selected = index;
  state.page = 0;
  state.changeLimit = 100;
  $("snapshot").value = String(index);
  $("timeline").value = String(index);
  render();
}
function renderHistory() {
  const snapshots = state.bundle.snapshots;
  trend($("course-trend"), snapshots.map((snapshot) => ({ time: snapshot.time, value: snapshot.summary.courses })),
    "全學期課程筆數，橫軸為真實 commit 時間", null, setSnapshot, state.selected);
  trend($("capacity-trend"), snapshots.map((snapshot) => ({
    time: snapshot.time, value: snapshot.summary.capacity_known ? snapshot.summary.capacity : null,
  })), "全學期正數已知人限合計，缺值不填零",
    (_, i) => `正數人限覆蓋 ${coverage(snapshots[i].summary)}`, setSnapshot, state.selected);
  renderChanges();
}
function changeDescription(change, old, current) {
  if (change.kind === "added") return "前一筆紀錄中未出現";
  if (change.kind === "removed") return "從紀錄移除，不代表停開";
  return change.fields.map((field) =>
    `${FIELD_NAMES[field] || field}：${old?.[field] || "未提供"} → ${current?.[field] || "未提供"}`).join("；");
}
function renderChanges() {
  const snapshot = state.bundle.snapshots[state.selected];
  const added = snapshot.changes.filter((change) => change.kind === "added").length;
  const removed = snapshot.changes.filter((change) => change.kind === "removed").length;
  $("change-summary").textContent = snapshot.baseline ? "基準紀錄，無前一筆可比較。" :
    `相較 ${date(state.bundle.snapshots[state.selected - 1].time)}：新出現 ${added}、移除 ${removed}、欄位異動 ${snapshot.changes.length - added - removed} 門。`;
  const kind = $("change-kind").value;
  $("change-kind").classList.toggle("has-value", Boolean(kind));
  const changes = snapshot.changes.filter((change) => {
    if (!kind) return true;
    if (kind === "added" || kind === "removed") return change.kind === kind;
    if (kind === "other") return change.kind === "changed" &&
      change.fields.some((field) => !["size_limit", "suspend", "lecturer", "time", "language"].includes(field));
    return change.fields.includes(kind);
  });
  const current = new Map(coursesAt(state.selected).map((course) => [course.id, course]));
  const previous = new Map(state.selected ? coursesAt(state.selected - 1).map((course) => [course.id, course]) : []);
  $("changes").replaceChildren();
  for (const change of changes.slice(0, state.changeLimit)) {
    const course = current.get(change.id) || previous.get(change.id);
    const button = node("button", null, "change-entry");
    button.append(node("span", { added: "新出現", removed: "移除", changed: "調整" }[change.kind],
      `pill ${change.kind === "removed" ? "removed" : ""}`), node("strong", title(course)),
      node("small", `${change.id} · ${changeDescription(change, previous.get(change.id), current.get(change.id))}`));
    button.addEventListener("click", () => openDetail(change.id));
    $("changes").append(button);
  }
  if (!changes.length) $("changes").append(node("p", "沒有符合類型的變動。", "empty"));
  if (changes.length > state.changeLimit) {
    const button = node("button", `顯示更多（尚有 ${changes.length - state.changeLimit} 筆）`, "secondary");
    button.addEventListener("click", () => { state.changeLimit += 100; renderChanges(); });
    $("changes").append(button);
  }
}

function renderQuality(courses) {
  const total = courses.length;
  const entries = [
    ["人限未提供", courses.filter((c) => c.size_limit_state === "unknown").length],
    ["人限為 0", courses.filter((c) => c.size_limit_state === "zero").length],
    ["時段未提供", courses.filter((c) => !c.time).length],
    ["欄位格式異常", courses.filter((c) => c.issues.length).length],
  ];
  const grid = node("div", null, "quality-grid");
  for (const [label, count] of entries) {
    const item = node("div", null, "quality-item");
    item.append(node("strong", fmt.format(count)), node("span", `${label} · ${total ? (100 * count / total).toFixed(1) : "0"}%`));
    grid.append(item);
  }
  const students = courses.filter((c) => c.student_count_state === "positive" || c.student_count_state === "zero").length;
  $("quality").replaceChildren(grid,
    node("p", `選課人數：${students} / ${total} 門有資料。`, "caption"));
}

function render() {
  const snapshot = state.bundle.snapshots[state.selected];
  const all = coursesAt(state.selected);
  state.filtered = all.filter(matches);
  $("source-link").href = sourceURL(snapshot.sha);
  $("source-link").textContent = snapshot.sha.slice(0, 8);
  $("source-link").setAttribute("aria-label", `來源 commit ${snapshot.sha.slice(0, 8)}，另開分頁`);
  $("snapshot-meta").textContent = `${state.bundle.snapshots.length} 筆歷史紀錄`;
  $("snapshot-position").textContent = `${state.selected + 1} / ${state.bundle.snapshots.length}`;
  $("snapshot-prev").disabled = state.selected === 0;
  $("snapshot-next").disabled = state.selected === state.bundle.snapshots.length - 1;
  $("timeline").setAttribute("aria-valuetext", date(snapshot.time));
  for (const id of FILTER_IDS.filter((id) => id !== "search")) {
    $(id).classList.toggle("has-value", Boolean($(id).value));
  }
  $("provenance").textContent = `${date(snapshot.time)} Asia/Taipei · ${snapshot.path} · ${state.bundle.snapshots.length} 個內容變更觀測點 · 歷史 ${date(state.bundle.snapshots[0].time)} — ${date(state.bundle.snapshots.at(-1).time)} · 固定來源 ${state.bundle.source_sha.slice(0, 8)}`;
  $("filter-summary").textContent = `${fmt.format(state.filtered.length)} / ${fmt.format(all.length)} 門課`;
  renderMetrics(state.filtered);
  renderSchedule(state.filtered);
  renderTable();
  renderHistory();
  renderQuality(all);
}

function openDetail(identity) {
  const selectedCourse = courseAt(state.selected, identity);
  let course = selectedCourse;
  for (let i = state.selected; !course && i >= 0; i--) course = courseAt(i, identity);
  if (!course) throw new Error(`找不到課程 ${identity} 的觀測版本`);
  const content = $("detail-content");
  const heading = node("h2", title(course));
  heading.id = "detail-title";
  heading.tabIndex = -1;
  content.replaceChildren(heading, node("p", course.id, "course-id"));
  content.append(node("p", selectedCourse ? `目前快照：${date(state.bundle.snapshots[state.selected].time)}` :
    "此筆紀錄已移除課程，以下為最後可見版本。", "caption"));
  if (course.issues.length) content.append(node("p",
    `欄位格式異常：${course.issues.map((field) => FIELD_NAMES[field] || field).join("、")}`, "data-warning"));
  const details = node("dl");
  for (const [field, label] of Object.entries(FIELD_NAMES)) {
    if (field === "id" || field === "chinese_title") continue;
    details.append(node("dt", label), node("dd", course[field] || "未提供"));
  }
  content.append(details, node("h3", "人限歷史"));
  const chart = node("div");
  const points = state.bundle.snapshots.map((snapshot, i) => {
    const observation = courseAt(i, identity);
    return { time: snapshot.time, value: observation?.size_limit_state === "positive" ? observation.size_limit_value : null,
      note: observation ? capacityText(observation) : "快照中不存在" };
  });
  trend(chart, points, "課程正數人限歷史；空白、0、移除皆中斷折線", (point) => point.note, null, state.selected);
  content.append(chart, node("p", "完整學期紀錄；空白、0 或課程移除時不連線。", "caption"),
    node("h3", "異動紀錄"));
  const events = node("div", null, "detail-events");
  state.bundle.snapshots.forEach((snapshot, i) => {
    const observation = courseAt(i, identity);
    const change = snapshot.changes.find((entry) => entry.id === identity);
    if (!(snapshot.baseline && observation) && !change) return;
    const entry = node("div", null, "detail-event");
    entry.append(node("strong", `${date(snapshot.time)} · ${snapshot.baseline ? "基準快照" : { added: "新出現", removed: "移除", changed: "欄位調整" }[change.kind]}`));
    if (change) entry.append(node("p", changeDescription(change, courseAt(i - 1, identity), observation)));
    const link = node("a", `來源 ${snapshot.sha.slice(0, 8)} ↗`);
    link.href = sourceURL(snapshot.sha); link.target = "_blank"; link.rel = "noopener noreferrer";
    entry.append(link); events.append(entry);
  });
  if (!events.children.length) events.append(node("p", "沒有可見異動。", "empty"));
  content.append(events);
  $("detail").showModal();
  heading.focus();
}

function trapDialogFocus(event) {
  if (event.key !== "Tab") return;
  const focusable = [...$("detail").querySelectorAll(
    "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']",
  )].filter((element) => element.tabIndex >= 0 && element.getClientRects().length);
  const first = focusable[0], last = focusable.at(-1);
  if (!first) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function csvCell(value) {
  let text = String(value ?? "");
  // Quote alone does not prevent spreadsheet formula execution.
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
function exportCSV() {
  const columns = ["id", "chinese_title", "english_title", "unit", "lecturer", "credit", "language",
    "size_limit", "time", "classroom", "ge_category", "suspend", "limit_note", "note"];
  const snapshot = state.bundle.snapshots[state.selected];
  const rows = [
    ["觀測時間（Asia/Taipei）", "來源 commit", ...columns.map((key) => FIELD_NAMES[key] || "開課單位代碼")],
    ...sortedCourses().map((course) => [date(snapshot.time), snapshot.sha, ...columns.map((key) => course[key] || "")]),
  ];
  const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"],
    { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url; link.download = `${state.bundle.semester}-${snapshot.sha.slice(0, 8)}-courses.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadJSON(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}：HTTP ${response.status}`);
  return response.json();
}
function validateBundle(bundle) {
  if (bundle.schema_version !== 1 || !Array.isArray(bundle.snapshots) || !bundle.snapshots.length ||
      !Array.isArray(bundle.versions) || !Array.isArray(bundle.days) || !Array.isArray(bundle.periods) ||
      !/^\d{5}$/.test(bundle.semester) || !/^[a-f0-9]{40,64}$/.test(bundle.source_sha)) {
    throw new Error("分析資料格式不符合版本 1");
  }
  for (const version of bundle.versions) {
    if (typeof version.id !== "string" || !version.id.startsWith(bundle.semester) ||
        !Array.isArray(version.slots) || !Array.isArray(version.issues)) throw new Error("課程版本資料損壞");
  }
  for (const snapshot of bundle.snapshots) {
    if (!/^[a-f0-9]{40,64}$/.test(snapshot.sha) || !Number.isFinite(new Date(snapshot.time).getTime()) ||
        !Array.isArray(snapshot.indices) || !Array.isArray(snapshot.changes) || !snapshot.summary ||
        snapshot.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= bundle.versions.length)) {
      throw new Error("快照索引或來源資訊損壞");
    }
  }
}
async function init() {
  $("retry").onclick = () => window.location.reload();
  try {
    const manifest = await loadJSON("manifest.json");
    if (!/^courses-[a-f0-9]{64}\.json$/.test(manifest.file)) throw new Error("產物 manifest 格式錯誤");
    const bundle = await loadJSON(manifest.file);
    validateBundle(bundle);
    state.bundle = bundle;
    $("semester").textContent = bundle.semester;
    document.title = `${bundle.semester}｜清華課程`;
    bundle.snapshots.forEach((snapshot, i) => {
      const option = node("option", `${date(snapshot.time)}${snapshot.baseline ? " · 基準" : ""}`);
      option.value = String(i); $("snapshot").append(option);
    });
    $("timeline").max = String(bundle.snapshots.length - 1);
    $("timeline").disabled = bundle.snapshots.length === 1;
    for (const field of ["unit", "language", "credit"]) addOptions(field, bundle.versions.map((course) => course[field]));
    addOptions("ge", bundle.versions.map((course) => course.ge_category));
    for (const day of bundle.days) {
      const option = node("option", `週${DAY_NAMES[day]}`); option.value = day; $("day").append(option);
    }
    for (const period of bundle.periods) {
      const option = node("option", period); option.value = period; $("period").append(option);
    }
    for (const id of FILTER_IDS) $(id).addEventListener(id === "search" ? "input" : "change", () => { state.page = 0; render(); });
    $("snapshot").addEventListener("change", () => setSnapshot(Number($("snapshot").value)));
    $("snapshot-prev").addEventListener("click", () => setSnapshot(state.selected - 1));
    $("snapshot-next").addEventListener("click", () => setSnapshot(state.selected + 1));
    $("timeline").addEventListener("input", () => setSnapshot(Number($("timeline").value)));
    $("reset").addEventListener("click", () => {
      for (const id of FILTER_IDS) $(id).value = "";
      state.page = 0; render();
    });
    $("sort").addEventListener("change", () => { state.page = 0; renderTable(); });
    $("prev").addEventListener("click", () => { state.page--; renderTable(); });
    $("next").addEventListener("click", () => { state.page++; renderTable(); });
    $("change-kind").addEventListener("change", () => { state.changeLimit = 100; renderChanges(); });
    $("export").addEventListener("click", exportCSV);
    $("close-detail").addEventListener("click", () => $("detail").close());
    $("detail").addEventListener("keydown", trapDialogFocus);
    setSnapshot(bundle.snapshots.length - 1);
    $("status").hidden = true;
    $("dashboard").hidden = false;
    $("load-actions").hidden = true;
  } catch (error) {
    console.error("Course dashboard failed", error);
    $("dashboard").hidden = true;
    $("status").hidden = false;
    $("status").classList.add("error");
    $("status").setAttribute("role", "alert");
    $("status").textContent = `資料載入失敗：${error.message}`;
    $("load-actions").hidden = false;
  }
}
init();
