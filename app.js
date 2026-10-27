(() => {
  "use strict";

  // 既存のデモ保存データとの互換性のため、キー名は据え置く。
  const STORAGE_KEY = "bridal-daily-report-demo:v1";
  const UI_KEY = "bridal-daily-report-demo:ui";
  const VERSION = 3;
  const DAY_START = 7 * 60;
  const DAY_END = 22 * 60;
  const SNAP = 15;
  const WEEKDAYS = "日月火水木金土";
  const VIEWS = ["plan", "actual", "history"];
  const { members: DEMO_MEMBERS, templates, summaries, extraTasks } = window.DEMO_DATA;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // ---------- 日付・時刻 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayISO = () => iso(new Date());
  const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const toTime = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const isWeekend = (s) => [0, 6].includes(parseISO(s).getDay());
  const span = (item) => `${item.start}–${item.end}`;
  const duration = (item) => Math.max(0, toMin(item.end) - toMin(item.start));
  const sumDuration = (items) => items.reduce((sum, x) => sum + duration(x), 0);
  const sortByStart = (items) => [...items].sort((a, b) => toMin(a.start) - toMin(b.start));

  function formatDate(s, withYear = false) {
    const d = parseISO(s);
    const base = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
    return withYear ? `${d.getFullYear()}年${base}` : base;
  }
  function formatStamp(isoString) {
    const d = new Date(isoString);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function formatDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m}分`;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }

  // ---------- データ ----------
  // report: { date, memberId, plans[], entries[], summary, savedAt, dirty }
  // plan:   { id, title, start, end }
  // entry:  { id, title, start, end, planId, plan }  plan は追加時点の予定（差分表示用）。予定外の作業は null
  const buildReport = (date, memberId, plans = [], entries = [], summary = "", savedAt = null) =>
    ({ date, memberId, plans, entries, summary, savedAt, dirty: false });
  const snapshot = (plan) => ({ title: plan.title, start: plan.start, end: plan.end });
  const entryFromPlan = (plan) => ({ id: uid(), ...snapshot(plan), planId: plan.id, plan: snapshot(plan) });

  function seed() {
    const reports = {};
    const today = todayISO();
    let made = 0;
    for (let d = 1; made < 6 && d < 14; d += 1) {
      const date = addDays(today, -d);
      if (parseISO(date).getDay() === 2) continue; // 火曜定休
      made += 1;
      const dayType = isWeekend(date) ? "weekend" : "weekday";
      DEMO_MEMBERS.forEach((member, i) => {
        if ((d + i) % 4 === 3) return; // 休み
        const variants = templates[member.role][dayType];
        const plans = variants[(d + i) % variants.length].map(([start, end, title]) => ({ id: uid(), title, start, end }));
        const entries = plans.map((plan, k) => {
          const entry = entryFromPlan(plan);
          let s = toMin(plan.start);
          let e = toMin(plan.end);
          if ((d + k + i) % 3 === 0) e += 30;
          else if ((d + k) % 5 === 0) { s += 15; e += 15; }
          return { ...entry, start: toTime(s), end: toTime(clamp(e, s + SNAP, DAY_END)) };
        });
        if ((d + i) % 2 === 0) {
          const last = Math.max(...entries.map((x) => toMin(x.end)));
          if (last + 30 <= DAY_END) entries.push({ id: uid(), title: extraTasks[(d + i) % extraTasks.length], start: toTime(last), end: toTime(last + 30), planId: null, plan: null });
        }
        const pool = summaries[member.role][dayType];
        const isDraft = made === 1 && i === 1;
        const saved = new Date(parseISO(date).getTime());
        saved.setHours(18, 20 + i * 9);
        reports[`${date}|${member.id}`] = buildReport(
          date, member.id, plans, entries,
          isDraft ? "" : pool[(d + i) % pool.length],
          isDraft ? null : saved.toISOString()
        );
      });
    }
    // 今日：担当者Aだけ朝の予定を登録済み（実績はまだ）
    const todayType = isWeekend(today) ? "weekend" : "weekday";
    const todayPlans = templates.planner[todayType][0].slice(0, 5).map(([start, end, title]) => ({ id: uid(), title, start, end }));
    reports[`${today}|m1`] = buildReport(today, "m1", todayPlans);
    return { version: VERSION, members: DEMO_MEMBERS, reports };
  }

  // ---------- 移行 ----------
  // v2 → v3：v2は予定を作ると実績欄も自動で作っていた。
  // 未保存の日報で、予定から自動生成されて一度も触っていない実績は「まだ実績ではない」ので外す。
  // 編集済み・予定外の作業・保存済みの日報の実績は残す。
  function migrateV2(saved) {
    Object.entries(saved.reports).forEach(([key, r]) => {
      const plans = new Map(r.plans.map((p) => [p.id, p]));
      if (!r.savedAt) r.entries = r.entries.filter((e) => !(e.planId && !e.edited));
      r.entries = r.entries.map(({ id, title, start, end, planId }) => {
        const plan = planId ? plans.get(planId) : null;
        return { id, title, start, end, planId: plan ? plan.id : null, plan: plan ? snapshot(plan) : null };
      });
      if (!r.plans.length && !r.entries.length && !r.summary.trim() && !r.savedAt) delete saved.reports[key];
    });
    saved.version = VERSION;
    return saved;
  }

  function normalize(saved) {
    if (!saved || !saved.reports) return null;
    if (saved.version === VERSION) return saved;
    if (saved.version === 2) return migrateV2(saved);
    return null;
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      const before = raw?.version;
      const saved = normalize(raw);
      if (saved) {
        if (before !== VERSION) localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        return saved;
      }
    } catch { /* 破損時はサンプルに戻す */ }
    const fresh = seed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    return fresh;
  }

  let state = load();
  const ui = (() => {
    const fallback = { view: "plan", date: todayISO(), memberId: state.members[0].id };
    try {
      const saved = { ...fallback, ...JSON.parse(sessionStorage.getItem(UI_KEY)) };
      if (!VIEWS.includes(saved.view)) saved.view = "plan";
      return saved;
    } catch { return fallback; }
  })();

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast("ブラウザに保存できませんでした", "error");
    }
  }
  function persistUI() {
    sessionStorage.setItem(UI_KEY, JSON.stringify({ view: ui.view, date: ui.date, memberId: ui.memberId }));
  }

  // ---------- モデル ----------
  const reportKey = (date = ui.date, memberId = ui.memberId) => `${date}|${memberId}`;
  const memberName = (id) => state.members.find((m) => m.id === id)?.name ?? "";

  function currentReport(create = false) {
    const key = reportKey();
    if (!state.reports[key] && create) state.reports[key] = buildReport(ui.date, ui.memberId);
    return state.reports[key];
  }

  const hasContent = (r) => Boolean(r && (r.entries.length || r.plans.length || r.summary.trim() || r.savedAt));
  const entryOfPlan = (report, planId) => report?.entries.find((e) => e.planId === planId);
  const pendingPlans = (report) => sortByStart((report?.plans ?? []).filter((p) => !entryOfPlan(report, p.id)));

  function statusOf(r) {
    if (r?.savedAt && !r.dirty) return { kind: "saved", label: `保存済み ${formatStamp(r.savedAt)}` };
    if (r?.savedAt) return { kind: "changed", label: "変更あり・未保存" };
    if (r && (r.entries.length || r.summary.trim())) return { kind: "draft", label: "下書き" };
    if (r?.plans.length) return { kind: "plan", label: "予定のみ" };
    return { kind: "none", label: "未作成" };
  }

  function changed(report) {
    if (report.savedAt) report.dirty = true;
    persist();
    renderStatus();
  }

  function addPlan(title, start, end) {
    const report = currentReport(true);
    const plan = { id: uid(), title, start, end };
    report.plans.push(plan);
    changed(report);
    renderDay();
    flash(`.plan-row[data-id="${plan.id}"]`);
    showToast("予定を追加しました");
  }

  function updatePlan(id, patch) {
    const report = currentReport();
    const plan = report.plans.find((p) => p.id === id);
    Object.assign(plan, patch);
    // 実績は独立。差分の比較元だけ最新の予定に合わせる
    const entry = entryOfPlan(report, id);
    if (entry) entry.plan = snapshot(plan);
    changed(report);
    renderDay();
  }

  function deletePlan(id) {
    const report = currentReport();
    report.plans = report.plans.filter((p) => p.id !== id);
    report.entries.forEach((e) => { if (e.planId === id) e.planId = null; }); // 差分表示用の plan は残す
    changed(report);
    renderDay();
  }

  function addFromPlans(plans) {
    const report = currentReport(true);
    const added = plans.filter((p) => !entryOfPlan(report, p.id)).map(entryFromPlan);
    if (!added.length) return [];
    report.entries.push(...added);
    changed(report);
    renderDay();
    return added;
  }

  function addExtraEntry() {
    const report = currentReport(true);
    const last = report.entries.length ? Math.max(...report.entries.map((e) => toMin(e.end))) : 9 * 60;
    const start = clamp(last, DAY_START, DAY_END - 60);
    const entry = { id: uid(), title: "", start: toTime(start), end: toTime(start + 60), planId: null, plan: null };
    report.entries.push(entry);
    changed(report);
    renderDay();
    return entry;
  }

  function updateEntry(id, patch) {
    const report = currentReport();
    const entry = report.entries.find((e) => e.id === id);
    Object.assign(entry, patch);
    changed(report);
    renderActualTotal();
    renderEntryDiff(entry);
  }

  function deleteEntry(id) {
    const report = currentReport();
    report.entries = report.entries.filter((e) => e.id !== id);
    changed(report);
    renderDay();
  }

  // ---------- 描画 ----------
  const els = {
    dateInput: $("#date-input"),
    dateLabel: $("#date-label"),
    memberSelect: $("#member-select"),
    statusChip: $("#status-chip"),
    hours: $("#hours"),
    lane: $("#lane-plan"),
    timelineScroll: $("#timeline-scroll"),
    planList: $("#plan-list"),
    entryList: $("#entry-list"),
    summary: $("#summary"),
    dialog: $("#item-dialog"),
    toast: $("#toast")
  };

  const hourHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour-h")) || 36;
  const ppm = () => hourHeight() / 60;

  function buildStatic() {
    els.memberSelect.innerHTML = state.members.map((m) => `<option value="${m.id}">${escapeHTML(m.name)}</option>`).join("");
    $("#filter-member").innerHTML = `<option value="">すべて</option>${els.memberSelect.innerHTML}`;
    const titles = new Set();
    Object.values(templates).forEach((byType) => Object.values(byType).flat(2).forEach((v) => { if (typeof v === "string" && !/^\d\d:\d\d$/.test(v)) titles.add(v); }));
    extraTasks.forEach((t) => titles.add(t));
    $("#title-suggestions").innerHTML = [...titles].map((t) => `<option value="${escapeHTML(t)}"></option>`).join("");
  }

  function renderHours() {
    const rows = [];
    for (let h = DAY_START / 60; h <= DAY_END / 60; h += 1) {
      rows.push(`<span style="top:${(h * 60 - DAY_START) * ppm()}px">${h}:00</span>`);
    }
    els.hours.innerHTML = rows.join("");
    $("#timeline").style.height = `${(DAY_END - DAY_START) * ppm()}px`;
  }

  function renderDay() {
    els.dateInput.value = ui.date;
    els.dateLabel.innerHTML = escapeHTML(formatDate(ui.date, true)) + (ui.date === todayISO() ? ' <span class="today-badge">今日</span>' : "");
    els.memberSelect.value = ui.memberId;
    renderPlans();
    renderTimeline();
    renderEntries();
    const report = currentReport();
    if (els.summary.value !== (report?.summary ?? "")) els.summary.value = report?.summary ?? "";
    renderSummaryCount();
    renderStatus();
  }

  function renderStatus() {
    const status = statusOf(currentReport());
    els.statusChip.textContent = status.kind === "saved" ? "保存済み" : status.label;
    els.statusChip.dataset.kind = status.kind;
    const saveState = $("#save-state");
    saveState.textContent = status.kind === "saved" ? `✓ ${status.label}` : status.label;
    saveState.dataset.kind = status.kind;
  }

  function renderSummaryCount() {
    $("#summary-count").textContent = `${els.summary.value.length}字`;
  }

  // 予定タブ
  function renderPlans() {
    const report = currentReport();
    const plans = sortByStart(report?.plans ?? []);
    const pending = pendingPlans(report);
    $("#plan-total").textContent = plans.length ? `${plans.length}件・${formatDuration(sumDuration(plans))}` : "";
    els.planList.innerHTML = plans.map((plan) => {
      const added = Boolean(entryOfPlan(report, plan.id));
      const action = added
        ? `<span class="added-mark">✓ 追加済み</span><button type="button" class="link-btn view-entry" data-id="${plan.id}">実績を見る</button>`
        : `<button type="button" class="btn small outline add-one" data-id="${plan.id}">実績に追加</button>`;
      return `<li class="plan-row${added ? " is-added" : ""}" data-id="${plan.id}">
        <button type="button" class="plan-open" data-id="${plan.id}" aria-label="${escapeHTML(`${span(plan)} ${plan.title} を編集`)}">
          <span class="plan-time">${span(plan)}</span>
          <span class="plan-title">${escapeHTML(plan.title)}</span>
        </button>
        <div class="plan-action">${action}</div>
      </li>`;
    }).join("");
    $("#plan-empty").hidden = plans.length > 0;
    $("#bulk-row").hidden = !plans.length;
    $("#bulk-note").textContent = pending.length ? `未追加 ${pending.length}件` : "すべて実績に追加済み";
    $("#add-all").hidden = !pending.length;
  }

  function positionBlock(el, startMin, endMin) {
    const s = clamp(startMin, DAY_START, DAY_END);
    const e = clamp(endMin, DAY_START, DAY_END);
    el.style.top = `${(s - DAY_START) * ppm()}px`;
    el.style.height = `${Math.max(e - s, SNAP) * ppm() - 2}px`;
    el.classList.toggle("is-short", e - s < 60);
  }

  function layoutColumns(items) {
    const result = new Map();
    let cluster = [];
    let clusterEnd = -1;
    const flush = () => {
      const columns = [];
      cluster.forEach((item) => {
        let col = columns.findIndex((end) => end <= toMin(item.start));
        if (col === -1) { col = columns.length; columns.push(0); }
        columns[col] = toMin(item.end);
        result.set(item.id, { col, cols: 0 });
      });
      cluster.forEach((item) => { result.get(item.id).cols = columns.length; });
      cluster = [];
    };
    sortByStart(items).forEach((item) => {
      if (cluster.length && toMin(item.start) >= clusterEnd) flush();
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, toMin(item.end));
    });
    if (cluster.length) flush();
    return result;
  }

  function renderTimeline() {
    const report = currentReport();
    const lane = els.lane;
    lane.querySelectorAll(".block, .now-line").forEach((n) => n.remove());
    const items = report?.plans ?? [];
    const layout = layoutColumns(items);
    items.forEach((item) => {
      const el = document.createElement("button");
      el.type = "button";
      const added = Boolean(entryOfPlan(report, item.id));
      el.className = `block${added ? " is-added" : ""}`;
      el.dataset.id = item.id;
      const { col, cols } = layout.get(item.id);
      el.style.left = `calc(${(col / cols) * 100}% + 2px)`;
      el.style.width = `calc(${100 / cols}% - 4px)`;
      positionBlock(el, toMin(item.start), toMin(item.end));
      el.innerHTML = `<span class="block-title">${added ? "✓ " : ""}${escapeHTML(item.title)}</span><span class="block-time">${span(item)}</span><span class="resize-handle" aria-hidden="true"></span>`;
      el.setAttribute("aria-label", `予定 ${item.start}から${item.end} ${item.title}${added ? " 実績追加済み" : ""}`);
      lane.appendChild(el);
    });
    if (ui.date === todayISO()) {
      const now = new Date();
      const min = now.getHours() * 60 + now.getMinutes();
      if (min >= DAY_START && min <= DAY_END) {
        const line = document.createElement("span");
        line.className = "now-line";
        line.setAttribute("aria-hidden", "true");
        line.style.top = `${(min - DAY_START) * ppm()}px`;
        lane.appendChild(line);
      }
    }
  }

  // 実績タブ
  function diffOf(entry) {
    const plan = entry.plan;
    if (!plan) return { kind: "extra", text: "予定外" };
    const timeChanged = plan.start !== entry.start || plan.end !== entry.end;
    const titleChanged = plan.title !== entry.title;
    if (!timeChanged && !titleChanged) return { kind: "same", text: "予定どおり", timeChanged, titleChanged };
    const parts = [];
    if (timeChanged) parts.push(span(plan));
    if (titleChanged) parts.push(`「${plan.title}」`);
    const delta = duration(entry) - duration(plan);
    const deltaText = delta ? `（${delta > 0 ? "+" : "−"}${formatDuration(Math.abs(delta))}）` : "";
    return { kind: "diff", text: `予定 ${parts.join(" ")}${deltaText}`, timeChanged, titleChanged };
  }

  function renderEntryDiff(entry) {
    const row = $(`.entry-row[data-id="${entry.id}"]`, els.entryList);
    if (!row) return;
    const diff = diffOf(entry);
    const meta = $(".entry-meta", row);
    meta.textContent = diff.text;
    meta.dataset.kind = diff.kind;
    $(".entry-times", row).classList.toggle("is-changed", Boolean(diff.timeChanged));
    $(".entry-title", row).classList.toggle("is-changed", Boolean(diff.titleChanged));
  }

  function renderActualTotal() {
    const entries = currentReport()?.entries ?? [];
    $("#actual-total").textContent = entries.length ? `${entries.length}件・${formatDuration(sumDuration(entries))}` : "";
  }

  function renderEntries() {
    const report = currentReport();
    const entries = sortByStart(report?.entries ?? []);
    const pending = pendingPlans(report);
    els.entryList.innerHTML = entries.map((entry) => `
      <li class="entry-row" data-id="${entry.id}">
        <div class="entry-times">
          <input type="time" step="900" class="entry-start" value="${entry.start}" aria-label="開始">
          <span class="sep" aria-hidden="true">–</span>
          <input type="time" step="900" class="entry-end" value="${entry.end}" aria-label="終了">
        </div>
        <div class="entry-body">
          <input type="text" class="entry-title" value="${escapeHTML(entry.title)}" list="title-suggestions" aria-label="作業名" placeholder="作業名">
          <span class="entry-meta"></span>
        </div>
        <button type="button" class="icon-btn quiet entry-delete" aria-label="${escapeHTML(entry.title || "この作業")}を削除">×</button>
      </li>`).join("");
    entries.forEach(renderEntryDiff);
    $("#entry-head").hidden = !entries.length;
    $("#entry-empty").hidden = entries.length > 0;
    $("#empty-add-all").hidden = !pending.length;
    const link = $("#pending-link");
    link.hidden = !entries.length || !pending.length;
    link.textContent = `未追加の予定 ${pending.length}件`;
    renderActualTotal();
  }

  // ---------- 予定タブの操作 ----------
  els.planList.addEventListener("click", (event) => {
    const add = event.target.closest(".add-one");
    const view = event.target.closest(".view-entry");
    const open = event.target.closest(".plan-open");
    if (add) {
      const report = currentReport();
      const plan = report.plans.find((p) => p.id === add.dataset.id);
      if (addFromPlans([plan]).length) showToast("実績に追加しました", "success");
      flash(`.plan-row[data-id="${plan.id}"]`);
      $(`.plan-row[data-id="${plan.id}"] .view-entry`)?.focus();
    } else if (view) {
      showEntry(view.dataset.id);
    } else if (open) {
      const plan = currentReport().plans.find((p) => p.id === open.dataset.id);
      openDialog({ mode: "edit", id: plan.id, ...plan });
    }
  });

  $("#add-all").addEventListener("click", () => {
    const added = addFromPlans(pendingPlans(currentReport()));
    if (!added.length) return;
    setView("actual");
    added.forEach((e) => flash(`.entry-row[data-id="${e.id}"]`));
    showToast(`${added.length}件を実績に追加しました`, "success");
  });

  function showEntry(planId) {
    const entry = entryOfPlan(currentReport(), planId);
    setView("actual");
    if (!entry) return;
    flash(`.entry-row[data-id="${entry.id}"]`);
    const row = $(`.entry-row[data-id="${entry.id}"]`, els.entryList);
    row?.scrollIntoView({ block: "center" });
    $(".entry-title", row)?.focus({ preventScroll: true });
  }

  // ---------- 実績タブの操作 ----------
  els.entryList.addEventListener("input", (event) => {
    const row = event.target.closest(".entry-row");
    if (!row || !event.target.classList.contains("entry-title")) return;
    updateEntry(row.dataset.id, { title: event.target.value });
  });

  els.entryList.addEventListener("change", (event) => {
    const row = event.target.closest(".entry-row");
    if (!row || !event.target.matches(".entry-start, .entry-end")) return;
    const startInput = $(".entry-start", row);
    const endInput = $(".entry-end", row);
    if (!startInput.value || !endInput.value) return;
    let s = clamp(toMin(startInput.value), DAY_START, DAY_END - SNAP);
    let e = clamp(toMin(endInput.value), DAY_START + SNAP, DAY_END);
    if (e <= s) {
      if (event.target === startInput) e = Math.min(s + 30, DAY_END);
      else s = Math.max(e - 30, DAY_START);
      showToast("開始・終了を調整しました");
    }
    startInput.value = toTime(s);
    endInput.value = toTime(e);
    updateEntry(row.dataset.id, { start: toTime(s), end: toTime(e) });
  });

  els.entryList.addEventListener("click", (event) => {
    const button = event.target.closest(".entry-delete");
    if (!button) return;
    const row = button.closest(".entry-row");
    const nextId = (row.nextElementSibling || row.previousElementSibling)?.dataset.id;
    deleteEntry(row.dataset.id);
    showToast("実績を削除しました");
    (nextId ? $(`[data-id="${nextId}"] .entry-title`, els.entryList) : $("#add-entry"))?.focus();
  });

  $("#add-entry").addEventListener("click", () => {
    const entry = addExtraEntry();
    flash(`.entry-row[data-id="${entry.id}"]`);
    $(`[data-id="${entry.id}"] .entry-title`, els.entryList)?.focus();
  });

  $("#empty-add-all").addEventListener("click", () => {
    const added = addFromPlans(pendingPlans(currentReport()));
    added.forEach((e) => flash(`.entry-row[data-id="${e.id}"]`));
    if (added.length) showToast(`${added.length}件を実績に追加しました`, "success");
  });

  $("#pending-link").addEventListener("click", () => setView("plan"));

  els.summary.addEventListener("input", () => {
    const report = currentReport(true);
    report.summary = els.summary.value;
    renderSummaryCount();
    changed(report);
  });

  $("#save-report").addEventListener("click", () => {
    const report = currentReport();
    if (!report || (!report.entries.length && !report.summary.trim())) {
      showToast("実績か総括を入力してください", "error");
      return;
    }
    const blank = sortByStart(report.entries).find((e) => !e.title.trim());
    if (blank) {
      showToast("作業名が空欄です", "error");
      $(`[data-id="${blank.id}"] .entry-title`, els.entryList)?.focus();
      return;
    }
    report.savedAt = new Date().toISOString();
    report.dirty = false;
    persist();
    renderStatus();
    showToast("日報を保存しました", "success");
  });

  // ---------- 日付・担当者 ----------
  function setDay(date, memberId = ui.memberId) {
    ui.date = date;
    ui.memberId = memberId;
    persistUI();
    renderDay();
    scrollTimelineToStart();
  }

  els.dateInput.addEventListener("change", () => { if (els.dateInput.value) setDay(els.dateInput.value); });
  $("#prev-day").addEventListener("click", () => setDay(addDays(ui.date, -1)));
  $("#next-day").addEventListener("click", () => setDay(addDays(ui.date, 1)));
  $("#today-btn").addEventListener("click", () => setDay(todayISO()));
  els.memberSelect.addEventListener("change", () => setDay(ui.date, els.memberSelect.value));

  // ---------- 予定ダイアログ ----------
  let dialogContext = null;

  function openDialog({ mode, id = null, title = "", start, end }) {
    dialogContext = { mode, id };
    $("#dialog-title").textContent = mode === "create" ? "予定を追加" : "予定を編集";
    $("#f-title").value = title;
    $("#f-start").value = start;
    $("#f-end").value = end;
    $("#f-error").textContent = "";
    $("#dialog-delete").hidden = mode !== "edit";
    els.dialog.showModal();
    if (mode === "create") $("#f-title").focus();
    else $("#dialog-title").focus();
  }

  function nextFreeStart() {
    const report = currentReport();
    if (!report?.plans.length) return ui.date === todayISO() ? clamp(Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 30) * 30, 9 * 60, DAY_END - 60) : 10 * 60;
    return clamp(Math.max(...report.plans.map((p) => toMin(p.end))), DAY_START, DAY_END - 60);
  }

  $("#add-plan").addEventListener("click", () => {
    const start = nextFreeStart();
    openDialog({ mode: "create", start: toTime(start), end: toTime(start + 60) });
  });

  $("#item-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = $("#f-title").value.trim();
    const start = $("#f-start").value;
    const end = $("#f-end").value;
    const error = $("#f-error");
    if (!title) { error.textContent = "作業名を入力してください"; $("#f-title").focus(); return; }
    if (!start || !end) { error.textContent = "開始と終了を入力してください"; return; }
    if (toMin(start) < DAY_START || toMin(end) > DAY_END) { error.textContent = "7:00〜22:00で入力してください"; return; }
    if (toMin(end) <= toMin(start)) { error.textContent = "終了は開始より後にしてください"; $("#f-end").focus(); return; }
    const { mode, id } = dialogContext;
    els.dialog.close();
    if (mode === "create") addPlan(title, start, end);
    else updatePlan(id, { title, start, end });
  });

  $("#dialog-cancel").addEventListener("click", () => els.dialog.close());
  $("#dialog-delete").addEventListener("click", () => {
    const { id } = dialogContext;
    els.dialog.close();
    deletePlan(id);
    showToast("予定を削除しました");
  });
  els.dialog.addEventListener("click", (event) => { if (event.target === els.dialog) els.dialog.close(); });

  // ---------- タイムライン操作 ----------
  let drag = null;
  let suppressClick = false;
  const lane = els.lane;
  const findPlan = (id) => currentReport().plans.find((x) => x.id === id);
  const yToMin = (clientY, round = Math.floor) => {
    const rect = lane.getBoundingClientRect();
    return clamp(DAY_START + round((clientY - rect.top) / ppm() / SNAP) * SNAP, DAY_START, DAY_END);
  };
  const commitPlan = (id, start, end) => updatePlan(id, { start: toTime(start), end: toTime(end) });
  const suppressNextClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 80); };

  lane.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const block = event.target.closest(".block");
    if (block) {
      const handle = event.target.closest(".resize-handle");
      if (!handle && event.pointerType === "touch") return; // タップで編集
      const item = findPlan(block.dataset.id);
      drag = {
        mode: handle ? "resize" : "move", id: item.id, el: block, startY: event.clientY,
        origStart: toMin(item.start), origEnd: toMin(item.end), start: toMin(item.start), end: toMin(item.end), moved: false
      };
      block.setPointerCapture(event.pointerId);
      block.classList.add("is-dragging");
    } else {
      if (event.pointerType === "touch") return; // タップで追加
      const anchor = yToMin(event.clientY);
      const ghost = document.createElement("div");
      ghost.className = "block ghost";
      ghost.style.left = "2px";
      ghost.style.width = "calc(100% - 4px)";
      positionBlock(ghost, anchor, anchor + 60);
      lane.appendChild(ghost);
      drag = { mode: "create", anchor, start: anchor, end: anchor + 60, startY: event.clientY, moved: false, el: ghost };
      lane.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  });

  lane.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (Math.abs(event.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const delta = Math.round((event.clientY - drag.startY) / ppm() / SNAP) * SNAP;
    if (drag.mode === "move") {
      const length = drag.origEnd - drag.origStart;
      drag.start = clamp(drag.origStart + delta, DAY_START, DAY_END - length);
      drag.end = drag.start + length;
    } else if (drag.mode === "resize") {
      drag.end = clamp(drag.origEnd + delta, drag.origStart + SNAP, DAY_END);
    } else {
      const m = yToMin(event.clientY, Math.round);
      drag.start = Math.min(drag.anchor, m);
      drag.end = m < drag.anchor ? drag.anchor + SNAP : Math.max(drag.anchor + SNAP, m);
    }
    positionBlock(drag.el, drag.start, drag.end);
    const time = drag.el.querySelector(".block-time");
    const label = `${toTime(drag.start)}–${toTime(drag.end)}`;
    if (time) time.textContent = label; else drag.el.textContent = label;
  });

  const finish = (cancelled = false) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    current.el.classList.remove("is-dragging");
    if (current.mode === "create") {
      current.el.remove();
      suppressNextClick();
      if (cancelled) return;
      const end = current.moved ? current.end : Math.min(current.start + 60, DAY_END);
      const start = Math.min(current.start, end - SNAP);
      openDialog({ mode: "create", start: toTime(start), end: toTime(end) });
      return;
    }
    if (current.moved && !cancelled) {
      suppressNextClick();
      if (current.start !== current.origStart || current.end !== current.origEnd) commitPlan(current.id, current.start, current.end);
    } else if (cancelled) {
      renderTimeline();
    }
  };
  lane.addEventListener("pointerup", () => finish());
  lane.addEventListener("pointercancel", () => finish(true));

  lane.addEventListener("click", (event) => {
    if (suppressClick) return;
    const block = event.target.closest(".block");
    if (block) {
      const item = findPlan(block.dataset.id);
      openDialog({ mode: "edit", id: item.id, ...item });
      return;
    }
    // タッチ・ペンのタップで空き枠から追加
    const start = clamp(yToMin(event.clientY), DAY_START, DAY_END - 60);
    openDialog({ mode: "create", start: toTime(start), end: toTime(start + 60) });
  });

  lane.addEventListener("keydown", (event) => {
    const block = event.target.closest(".block");
    if (!block || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const item = findPlan(block.dataset.id);
    const delta = event.key === "ArrowUp" ? -SNAP : SNAP;
    let s = toMin(item.start);
    let e = toMin(item.end);
    if (event.shiftKey) e = clamp(e + delta, s + SNAP, DAY_END);
    else { const d = e - s; s = clamp(s + delta, DAY_START, DAY_END - d); e = s + d; }
    commitPlan(item.id, s, e);
    $(`.block[data-id="${item.id}"]`, lane)?.focus();
  });

  function scrollTimelineToStart() {
    const first = sortByStart(currentReport()?.plans ?? [])[0];
    els.timelineScroll.scrollTop = Math.max(0, ((first ? toMin(first.start) : 9 * 60) - DAY_START - 30) * ppm());
  }

  // ---------- 履歴 ----------
  const filters = {
    member: $("#filter-member"), from: $("#filter-from"), to: $("#filter-to"), text: $("#filter-text")
  };

  function renderHistory() {
    const member = filters.member.value;
    const from = filters.from.value;
    const to = filters.to.value;
    const text = filters.text.value.trim().toLowerCase();
    const order = new Map(state.members.map((m, i) => [m.id, i]));
    const items = Object.values(state.reports)
      .filter(hasContent)
      .filter((r) => !member || r.memberId === member)
      .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
      .filter((r) => !text || [r.summary, ...r.entries.map((e) => e.title), ...r.plans.map((p) => p.title)].join("\n").toLowerCase().includes(text))
      .sort((a, b) => (a.date === b.date ? order.get(a.memberId) - order.get(b.memberId) : a.date < b.date ? 1 : -1));

    $("#history-count").textContent = `${items.length}件`;
    const list = $("#history-list");
    if (!items.length) {
      list.innerHTML = `<p class="empty">該当する日報はありません</p>`;
      return;
    }
    const groups = new Map();
    items.forEach((r) => { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(r); });
    list.innerHTML = [...groups].map(([date, reports]) => `
      <section class="history-group">
        <h3>${formatDate(date, true)}${date === todayISO() ? ' <span class="today-badge">今日</span>' : ""}</h3>
        <ul>
          ${reports.map((r) => {
            const status = statusOf(r);
            const meta = r.entries.length ? `実績 ${r.entries.length}件・${formatDuration(sumDuration(r.entries))}` : `予定 ${r.plans.length}件`;
            const firstLine = r.summary.trim().split("\n")[0] || "総括なし";
            return `<li>
              <button type="button" class="history-card" data-date="${r.date}" data-member="${r.memberId}">
                <span class="h-top">
                  <strong>${escapeHTML(memberName(r.memberId))}</strong>
                  <span class="h-meta">${meta}</span>
                  <span class="chip" data-kind="${status.kind}">${escapeHTML(status.kind === "saved" ? "保存済み" : status.label)}</span>
                </span>
                <span class="h-summary">${escapeHTML(firstLine)}</span>
              </button>
            </li>`;
          }).join("")}
        </ul>
      </section>`).join("");
  }

  $("#history-filters").addEventListener("input", renderHistory);
  $("#history-filters").addEventListener("reset", () => setTimeout(renderHistory));
  $("#history-filters").addEventListener("submit", (event) => event.preventDefault());
  $("#history-list").addEventListener("click", (event) => {
    const card = event.target.closest(".history-card");
    if (!card) return;
    ui.date = card.dataset.date;
    ui.memberId = card.dataset.member;
    setView("actual");
    window.scrollTo({ top: 0 });
    $("#actual-title").focus({ preventScroll: true });
  });

  // ---------- 表示切替 ----------
  function setView(view) {
    ui.view = view;
    persistUI();
    $$(".view-tabs button").forEach((b) => {
      if (b.dataset.view === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    VIEWS.forEach((v) => { $(`#${v}-view`).hidden = v !== view; });
    $("#day-bar").hidden = view === "history";
    if (view === "history") renderHistory();
    else renderDay();
  }
  $$(".view-tabs button").forEach((b) => b.addEventListener("click", () => {
    setView(b.dataset.view);
    if (b.dataset.view === "plan") scrollTimelineToStart();
  }));

  $("#reset-demo").addEventListener("click", () => {
    if (!confirm("サンプルデータに戻します。入力した内容は消えます。")) return;
    state = seed();
    persist();
    ui.date = todayISO();
    ui.memberId = state.members[0].id;
    setView("plan");
    scrollTimelineToStart();
    showToast("サンプルに戻しました");
  });

  // ---------- 共通 ----------
  let toastTimer = null;
  function showToast(message, kind = "info") {
    els.toast.textContent = message;
    els.toast.dataset.kind = kind;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2400);
  }

  function flash(selector) {
    const el = $(selector);
    if (!el) return;
    el.classList.remove("is-new");
    void el.offsetWidth;
    el.classList.add("is-new");
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 別タブでの変更を反映
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    const next = normalize(JSON.parse(event.newValue));
    if (!next) return;
    state = next;
    if (ui.view === "history") renderHistory(); else renderDay();
  });

  let lastHourHeight = hourHeight();
  window.addEventListener("resize", () => {
    if (hourHeight() === lastHourHeight) return;
    lastHourHeight = hourHeight();
    renderHours();
    renderTimeline();
  });
  setInterval(() => { if (ui.view === "plan" && !drag) renderTimeline(); }, 60000);

  // ---------- 起動 ----------
  if (!state.members.some((m) => m.id === ui.memberId)) ui.memberId = state.members[0].id;
  buildStatic();
  renderHours();
  setView(ui.view);
  scrollTimelineToStart();
})();
