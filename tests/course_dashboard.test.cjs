const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function dashboard() {
  const fields = Object.fromEntries(
    ["search", "unit", "language", "ge", "credit", "capacity", "day", "period", "suspend", "sort"]
      .map((key) => [key, { value: "" }]),
  );
  const context = vm.createContext({
    console, Intl, Date, setTimeout,
    document: { getElementById: (id) => fields[id] },
  });
  const source = readFileSync(join(__dirname, "..", "dashboard", "app.js"), "utf8");
  assert.match(source, /\ninit\(\);\s*$/);
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, ""), context);
  return {
    fields,
    run: (code) => vm.runInContext(code, context),
    set: (name, value) => { context[name] = value; },
  };
}

test("CSV quotes records and neutralizes formulas including leading whitespace", () => {
  const app = dashboard();
  for (const value of ["=1+1", "+SUM(A1)", "-1+2", "@SUM(A1)", "  =1+1", "\t=1+1", "\nformula"]) {
    app.set("input", value);
    assert.equal(app.run("csvCell(input)"), `"\'${value}"`);
  }
  assert.equal(app.run("csvCell('a,\"b\"\\nc')"), '"a,""b""\nc"');
  assert.equal(app.run("csvCell(0)"), '"0"');
  assert.equal(app.run("csvCell(null)"), '""');
  assert.equal(app.run("csvCell('11510CS 101000')"), '"11510CS 101000"');
});

test("combined day and period filters must match the same slot", () => {
  const app = dashboard();
  app.set("course", {
    id: "11510CS 101000", chinese_title: "Programming", unit: "CS",
    time: "M1T2", slots: ["M1", "T2"], credit: "0.5", language: "英",
    size_limit_state: "positive", size_limit_value: 40,
  });
  assert.equal(app.run("matches(course)"), true);
  app.fields.day.value = "M";
  app.fields.period.value = "2";
  assert.equal(app.run("matches(course)"), false);
  app.fields.period.value = "1";
  assert.equal(app.run("matches(course)"), true);
  app.fields.credit.value = "0.5";
  assert.equal(app.run("matches(course)"), true);
  app.fields.credit.value = "0";
  assert.equal(app.run("matches(course)"), false);
});

test("capacity states and boundaries do not turn unknown or zero into available seats", () => {
  const app = dashboard();
  app.set("course", {
    id: "11510CS 101000", slots: [], credit: "3",
    size_limit_state: "unknown", size_limit_value: null,
  });
  app.fields.capacity.value = "1-30";
  assert.equal(app.run("matches(course)"), false);
  app.fields.capacity.value = "unknown";
  assert.equal(app.run("matches(course)"), true);
  assert.equal(app.run("capacityText(course)"), "未提供");
  app.run("course.size_limit_state = 'zero'; course.size_limit_value = 0");
  app.fields.capacity.value = "positive";
  assert.equal(app.run("matches(course)"), false);
  app.fields.capacity.value = "zero";
  assert.equal(app.run("matches(course)"), true);
  assert.equal(app.run("capacityText(course)"), "0（待確認）");
  app.run("course.size_limit_state = 'positive'; course.size_limit_value = 31");
  app.fields.capacity.value = "1-30";
  assert.equal(app.run("matches(course)"), false);
  app.fields.capacity.value = "31-60";
  assert.equal(app.run("matches(course)"), true);
});

test("unknown language and credits can be filtered without resetting to all courses", () => {
  const app = dashboard();
  app.set("course", { id: "11510CS 101000", slots: [], credit: "", language: "" });
  app.fields.language.value = "__missing";
  app.fields.credit.value = "__missing";
  assert.equal(app.run("matches(course)"), true);
  app.run("course.language = '英'");
  assert.equal(app.run("matches(course)"), false);
  app.run("course.language = ''; course.credit = '0'");
  assert.equal(app.run("matches(course)"), false);
});

test("sorting preserves decimal credits and puts unknown capacity last", () => {
  const app = dashboard();
  app.set("rows", [
    { id: "a", credit_value: 0.5, size_limit_state: "unknown", size_limit_value: null },
    { id: "b", credit_value: 3, size_limit_state: "positive", size_limit_value: 30 },
    { id: "c", credit_value: 0, size_limit_state: "positive", size_limit_value: 60 },
  ]);
  app.run("state.filtered = rows");
  app.fields.sort.value = "capacity-desc";
  assert.equal(app.run("sortedCourses().map(course => course.id).join(',')"), "c,b,a");
  app.fields.sort.value = "credit-desc";
  assert.equal(app.run("sortedCourses().map(course => course.id).join(',')"), "b,a,c");
});

test("bundle validation rejects malformed snapshots and wrong semesters", () => {
  const app = dashboard();
  app.set("bundle", {
    schema_version: 1, semester: "11510", source_sha: "a".repeat(40),
    days: ["M"], periods: ["1"],
    versions: [{ id: "11510CS101", slots: ["M1"], issues: [] }],
    snapshots: [{ sha: "b".repeat(40), time: "2026-06-15T12:00:00+08:00",
      indices: [0], changes: [], summary: { courses: 1 } }],
  });
  assert.doesNotThrow(() => app.run("validateBundle(bundle)"));
  app.run("bundle.snapshots[0].indices = [9]");
  assert.throws(() => app.run("validateBundle(bundle)"), /快照索引/);
  app.run("bundle.snapshots[0].indices = [0]; bundle.versions[0].id = '11520CS101'");
  assert.throws(() => app.run("validateBundle(bundle)"), /課程版本/);
});

test("changes distinguish removal, unknown capacity and suspension labels", () => {
  const app = dashboard();
  app.set("change", { kind: "changed", fields: ["size_limit", "suspend"] });
  app.set("old", { size_limit: "", suspend: "" });
  app.set("current", { size_limit: "0", suspend: "停開" });
  assert.equal(app.run("changeDescription(change, old, current)"),
    "人限：未提供 → 0；停開註記：未提供 → 停開");
  assert.match(app.run("changeDescription({kind:'removed'}, old, null)"), /不代表停開/);
});

test("dialog tab wraps at visible controls and skips collapsed content", () => {
  const app = dashboard();
  let focused = null;
  let prevented = 0;
  const first = { tabIndex: 0, getClientRects: () => [1], focus: () => { focused = "first"; } };
  const hidden = { tabIndex: 0, getClientRects: () => [], focus: () => { focused = "hidden"; } };
  const last = { tabIndex: 0, getClientRects: () => [1], focus: () => { focused = "last"; } };
  const document = { activeElement: last, getElementById: () => ({ querySelectorAll: () => [first, hidden, last] }) };
  app.set("document", document);
  app.set("event", { key: "Tab", shiftKey: false, preventDefault: () => { prevented++; } });
  app.run("trapDialogFocus(event)");
  assert.equal(focused, "first");
  document.activeElement = first;
  app.run("event.shiftKey = true; trapDialogFocus(event)");
  assert.equal(focused, "last");
  assert.equal(prevented, 2);
  app.run("event.key = 'Escape'; trapDialogFocus(event)");
  assert.equal(prevented, 2);
});

test("theme text and control boundaries remain legible on mint and glass backgrounds", () => {
  const css = readFileSync(join(__dirname, "..", "dashboard", "styles.css"), "utf8");
  const token = (name) => {
    const match = css.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6});`));
    assert.ok(match, name);
    return match[1];
  };
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const ratio = (a, b) => {
    const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
    return (high + 0.05) / (low + 0.05);
  };
  for (const background of ["#c8e3dc", "#d6ebe7", "#d8e3e4", token("surface-data"), token("surface-selected")]) {
    assert.ok(ratio(token("color-text-muted"), background) >= 4.5, `muted text on ${background}`);
    assert.ok(ratio(token("color-control-border"), background) >= 3, `control border on ${background}`);
    assert.ok(ratio(token("color-accent"), background) >= 3, `focus on ${background}`);
  }
  assert.ok(ratio(token("color-on-action"), token("color-action")) >= 4.5);
});
