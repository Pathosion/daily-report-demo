// 使い方: 静的サーバーを起動した状態で npm test
// 環境変数 DAILY_REPORT_URL で対象URLを変更可能（既定: http://127.0.0.1:4181/）
// SHOT_DIR を指定すると画面のPNGを保存する
import { chromium } from "playwright";

const url = process.env.DAILY_REPORT_URL || "http://127.0.0.1:4181/";
const shotDir = process.env.SHOT_DIR;
const KEY = "bridal-daily-report-demo:v1";
const browser = await chromium.launch({ headless: true });
const errors = [];
const fail = (message) => { throw new Error(message); };
const check = (cond, message) => { if (!cond) fail(message); };
const shot = async (p, name, fullPage = true) => { if (shotDir) await p.screenshot({ path: `${shotDir}/${name}.png`, fullPage }); };

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayISO = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return isoOf(d); };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const today = dayISO(0);
const yesterday = dayISO(-1);

function watch(page) {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());
}
async function newPage(options, initData) {
  const context = await browser.newContext(options);
  if (initData) {
    // 初回だけ旧データを仕込む（リロード時は上書きしない）
    await context.addInitScript(([key, data]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, JSON.stringify(data));
        sessionStorage.setItem("seeded", "1");
      }
    }, [KEY, initData]);
  }
  const page = await context.newPage();
  watch(page);
  await page.goto(url, { waitUntil: "networkidle" });
  return page;
}
const stored = (p) => p.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
const tab = (p, view) => p.click(`.view-tabs button[data-view="${view}"]`);
const activeView = (p) => p.getAttribute('.view-tabs button[aria-current="page"]', "data-view");
const text = async (p, selector) => (await p.locator(selector).textContent()).trim();
const entryTitles = (p) => p.locator(".entry-title").evaluateAll((n) => n.map((i) => i.value));
const overflowX = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

// =====================================================================
// 1. デスクトップ：予定 → 1件実績反映 → 差分変更 → 予定外の作業 → 保存 → 再読込 → 履歴
// =====================================================================
const page = await newPage({ viewport: { width: 1366, height: 860 } });
check((await page.locator(".view-tabs button").allTextContents()).join() === "予定,実績・日報,履歴", "タブ構成が「予定・実績・日報・履歴」でない");
check((await activeView(page)) === "plan", "初期表示が予定タブでない");
check((await page.locator("#member-select option").allTextContents()).join() === "担当者A,担当者B,担当者C,担当者D", "担当者名が汎用名でない");

const planCount = await page.locator(".plan-row").count();
check(planCount >= 3, "今日の予定サンプルが表示されない");
check((await page.locator(".block").count()) === planCount, "タイムラインと予定一覧の件数が一致しない");
check((await page.locator(".plan-row.is-added").count()) === 0, "今日のサンプルに実績が入っている（予定のみのはず）");
check((await text(page, "#status-chip")) === "予定のみ", "朝の状態が予定のみでない");
check((await text(page, "#bulk-note")) === `未追加 ${planCount}件`, "未追加件数が表示されない");
await shot(page, "desktop-plan");

// 実績タブは空。予定は自動で実績にならない
await tab(page, "actual");
check((await page.locator(".entry-row").count()) === 0, "予定が自動で実績に入っている");
check(await page.locator("#empty-add-all").isVisible(), "空の実績に「予定をすべて追加」が出ない");
await tab(page, "plan");

// 新しい予定を追加しても実績へは自動追加しない
await page.click("#add-plan");
await page.fill("#f-title", "見積チェック");
await page.fill("#f-start", "19:00");
await page.fill("#f-end", "19:30");
await page.click("#item-form button[type=submit]");
check((await page.locator(".plan-row").count()) === planCount + 1, "予定を追加できない");
check((await text(page, "#bulk-note")) === `未追加 ${planCount + 1}件`, "新しい予定が未追加として数えられない");
check(!(await stored(page)).reports[`${today}|m1`].entries.length, "新しい予定が実績へ自動追加された");

// 1件だけ実績に追加 → 追加済み表示・二重追加防止
const firstRow = page.locator(".plan-row").first();
const planTitle = await firstRow.locator(".plan-title").textContent();
const [planStart, planEnd] = (await firstRow.locator(".plan-time").textContent()).split("–");
await firstRow.locator(".add-one").click();
check(await firstRow.evaluate((n) => n.classList.contains("is-added")), "追加した予定が追加済みにならない");
check((await firstRow.locator(".add-one").count()) === 0, "追加済みの予定に「実績に追加」が残っている（二重追加の恐れ）");
check((await firstRow.locator(".added-mark").textContent()).includes("追加済み"), "追加済みの印が出ない");
check((await page.locator(".block.is-added").count()) === 1, "タイムラインに追加済みが反映されない");
check((await text(page, "#bulk-note")) === `未追加 ${planCount}件`, "追加後の未追加件数が減らない");
check((await text(page, "#status-chip")) === "下書き", "実績を入れても下書きにならない");

// 「実績を見る」で実績タブの該当行へ
await firstRow.locator(".view-entry").click();
check((await activeView(page)) === "actual", "「実績を見る」で実績タブに移らない");
check((await page.locator(".entry-row").count()) === 1, "実績が1件になっていない");
const entry = page.locator(".entry-row").first();
check(await entry.locator(".entry-title").evaluate((n) => n === document.activeElement), "「実績を見る」で該当行にフォーカスしない");
check((await entry.locator(".entry-title").inputValue()) === planTitle, "予定の作業名が実績にコピーされない");
check((await entry.locator(".entry-start").inputValue()) === planStart, "予定の開始時刻がコピーされない");
check((await text(page, ".entry-row:first-child .entry-meta")) === "予定どおり", "未変更の実績が「予定どおり」にならない");
check(await page.locator("#pending-link").isVisible(), "未追加の予定への導線が出ない");

// 差分変更：終了を30分延長、作業名を変更 → 変更前の予定を表示
const newEnd = toTime(toMin(planEnd) + 30);
await entry.locator(".entry-end").fill(newEnd);
await entry.locator(".entry-end").dispatchEvent("change");
check((await text(page, ".entry-row:first-child .entry-meta")) === `予定 ${planStart}–${planEnd}（+30分）`, `時間差の表示が不正: ${await text(page, ".entry-row:first-child .entry-meta")}`);
check(await entry.locator(".entry-times").evaluate((n) => n.classList.contains("is-changed")), "変更した時刻が強調されない");
await entry.locator(".entry-title").fill(`${planTitle}（延長）`);
const diffText = await text(page, ".entry-row:first-child .entry-meta");
check(diffText === `予定 ${planStart}–${planEnd} 「${planTitle}」（+30分）`, `作業名差の表示が不正: ${diffText}`);
const plansAfterEdit = (await stored(page)).reports[`${today}|m1`].plans;
check(plansAfterEdit.some((p) => p.title === planTitle && p.end === planEnd), "実績を変えたら予定まで変わった（独立していない）");

// 予定にない作業を追加
await page.click("#add-entry");
await page.locator(".entry-title:focus").fill("電話フォロー");
check((await page.locator(".entry-row").count()) === 2, "予定にない作業を追加できない");
check((await text(page, ".entry-row:last-child .entry-meta")) === "予定外", "予定にない作業が「予定外」にならない");

// 総括を書いて保存
await page.fill("#summary", "【成果】見積の比較表を作成。\n【明日】お客様へ連絡。");
await page.click("#save-report");
check((await text(page, "#save-state")).includes("保存済み"), "保存済みにならない");
await shot(page, "desktop-actual");

// 再読込しても残る
await page.reload({ waitUntil: "networkidle" });
check((await activeView(page)) === "actual", "再読込でタブが戻った");
check((await entryTitles(page)).join() === `${planTitle}（延長）,電話フォロー`, `再読込で実績が変わった: ${(await entryTitles(page)).join()}`);
check((await text(page, ".entry-row:first-child .entry-meta")) === diffText, "再読込で予定との差の表示が変わった");
check((await page.inputValue("#summary")).includes("比較表"), "再読込で総括が消えた");
check((await text(page, "#save-state")).includes("保存済み"), "再読込で保存状態が消えた");

// 残りを一括追加 → 二重にならない
await tab(page, "plan");
check(await page.locator(".plan-row").first().evaluate((n) => n.classList.contains("is-added")), "再読込で追加済み表示が消えた");
await page.click("#add-all");
check((await activeView(page)) === "actual", "一括追加後に実績タブへ移らない");
const saved = (await stored(page)).reports[`${today}|m1`];
const linked = saved.entries.filter((e) => e.planId).map((e) => e.planId);
check(linked.length === saved.plans.length && new Set(linked).size === linked.length, "一括追加で重複・漏れがある");
check((await page.locator(".entry-row").count()) === planCount + 2, "一括追加後の実績件数が不正");
check((await entryTitles(page)).includes(`${planTitle}（延長）`), "一括追加で変更済みの実績が上書きされた");
check((await text(page, "#save-state")) === "変更あり・未保存", "保存後の変更が「変更あり」にならない");
await page.click("#save-report");
await tab(page, "plan");
check((await page.locator("#add-all").isHidden()) && (await text(page, "#bulk-note")) === "すべて実績に追加済み", "全件追加後の表示が不正");

// 履歴：今日の日報が見つかり、開ける
await tab(page, "history");
check(await page.locator("#day-bar").isHidden(), "履歴タブに日付バーが出ている");
const total = Number((await text(page, "#history-count")).replace("件", ""));
check(total >= 10, `履歴が少ない: ${total}`);
await shot(page, "desktop-history");
await page.fill("#filter-text", "電話フォロー");
const hit = page.locator(`.history-card[data-date="${today}"][data-member="m1"]`);
check((await hit.count()) === 1, "キーワード検索で今日の日報が見つからない");
check((await hit.textContent()).includes("保存済み"), "履歴で保存済みにならない");
await page.click('#history-filters button[type="reset"]');
await page.selectOption("#filter-member", "m3");
const memberCards = await page.locator(".history-card").allTextContents();
check(memberCards.length && memberCards.every((t) => t.includes("担当者C")), "担当者フィルタが効かない");
await page.selectOption("#filter-member", "");
await page.fill("#filter-from", yesterday);
await page.fill("#filter-to", yesterday);
await page.locator("#filter-to").dispatchEvent("input");
check((await page.locator(".history-group h3").count()) <= 1, "日付フィルタが効かない");
await page.click('#history-filters button[type="reset"]');
await page.fill("#filter-text", "存在しないキーワード");
check(await page.locator("#history-list .empty").isVisible(), "履歴の空状態が出ない");
await page.click('#history-filters button[type="reset"]');
await page.selectOption("#filter-member", "m2");
await page.locator(".history-card").first().click();
check((await activeView(page)) === "actual", "履歴から実績・日報タブで開かない");
check((await page.inputValue("#member-select")) === "m2", "履歴から担当者が引き継がれない");
check((await page.locator(".entry-row").count()) >= 1, "過去の実績サンプルが表示されない");
await page.locator(".entry-title").first().fill("再編集テスト");
check(/変更あり|下書き/.test(await text(page, "#save-state")), "過去日報の再編集で状態が変わらない");

// =====================================================================
// 2. 予定編集（タイムライン操作・ダイアログ）と保存条件
// =====================================================================
await page.selectOption("#member-select", "m4");
await page.click("#today-btn");
await tab(page, "plan");
check((await page.locator(".plan-row").count()) === 0, "担当者Dの今日が空でない");
check(await page.locator("#plan-empty").isVisible(), "予定の空状態が出ない");

// 空き枠ドラッグで予定を作成
const hourH = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour-h")));
await page.locator("#timeline-scroll").evaluate((n) => { n.scrollTop = (13 - 7 - 1) * parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour-h")); });
const laneBox = await page.locator("#lane-plan").boundingBox();
const y13 = laneBox.y + (13 - 7) * hourH + 2;
await page.mouse.move(laneBox.x + 30, y13);
await page.mouse.down();
await page.mouse.move(laneBox.x + 30, y13 + hourH * 1.5, { steps: 6 });
await page.mouse.up();
check(await page.locator("#item-dialog").evaluate((d) => d.open), "ドラッグ作成でダイアログが開かない");
check((await page.inputValue("#f-start")) === "13:00" && (await page.inputValue("#f-end")) === "14:30", `ドラッグ作成の時刻が不正: ${await page.inputValue("#f-start")}-${await page.inputValue("#f-end")}`);
await page.click("#item-form button[type=submit]");
check((await text(page, "#f-error")).includes("作業名"), "必須チェックが働かない");
await page.fill("#f-title", "見積作成");
await page.click("#item-form button[type=submit]");
check((await page.locator(".plan-row").count()) === 1, "ドラッグ作成した予定が一覧に出ない");

// ブロックを30分移動・下端で延長・キーボード移動
const block = () => page.locator(".block", { hasText: "見積作成" });
let box = await block().boundingBox();
await page.mouse.move(box.x + 20, box.y + 8);
await page.mouse.down();
await page.mouse.move(box.x + 20, box.y + 8 + hourH / 2, { steps: 5 });
await page.mouse.up();
check((await text(page, ".plan-row .plan-time")) === "13:30–15:00", "ブロックの移動が予定に反映されない");
check(!(await page.locator("#item-dialog").evaluate((d) => d.open)), "ドラッグ後にダイアログが開いた");
box = await block().boundingBox();
await page.mouse.move(box.x + 30, box.y + box.height - 3);
await page.mouse.down();
await page.mouse.move(box.x + 30, box.y + box.height - 3 + hourH / 2, { steps: 5 });
await page.mouse.up();
check((await text(page, ".plan-row .plan-time")) === "13:30–15:30", "下端ドラッグで長さが変わらない");
await block().focus();
await page.keyboard.press("ArrowUp");
check((await text(page, ".plan-row .plan-time")) === "13:15–15:15", "キーボードで移動できない");

// 一覧から編集・削除
await page.locator(".plan-open").first().click();
check((await text(page, "#dialog-title")) === "予定を編集", "予定一覧から編集を開けない");
await page.fill("#f-title", "見積作成（2件）");
await page.click("#item-form button[type=submit]");
check((await text(page, ".plan-row .plan-title")) === "見積作成（2件）", "予定の編集が反映されない");

// 予定だけでは保存できない
await tab(page, "actual");
await page.click("#save-report");
check(!(await text(page, "#save-state")).includes("保存済み"), "実績も総括もないのに保存できた");
check((await text(page, "#toast")).includes("実績か総括"), "保存条件のメッセージが出ない");
await page.fill("#summary", "移動のみの日");
await page.click("#save-report");
check((await text(page, "#save-state")).includes("保存済み"), "総括だけで保存できない");

await tab(page, "plan");
await page.locator(".plan-open").first().click();
await page.click("#dialog-delete");
check((await page.locator(".plan-row").count()) === 0, "予定を削除できない");

// リセットで新サンプル
await page.click("#reset-demo");
check((await page.locator(".plan-row.is-added").count()) === 0, "リセット後の今日に実績が入っている");
await page.context().close();

// =====================================================================
// 3. v2 データの移行
// =====================================================================
const v2 = {
  version: 2,
  members: [
    { id: "m1", name: "担当者A", role: "planner" }, { id: "m2", name: "担当者B", role: "planner" },
    { id: "m3", name: "担当者C", role: "dress" }, { id: "m4", name: "担当者D", role: "sales" }
  ],
  reports: {
    [`${today}|m1`]: {
      date: today, memberId: "m1", savedAt: null, dirty: false, summary: "",
      plans: [
        { id: "p1", title: "装花打合せ", start: "10:00", end: "11:00" },
        { id: "p2", title: "見積書作成", start: "13:00", end: "14:00" },
        { id: "p3", title: "業者手配", start: "15:00", end: "16:00" }
      ],
      entries: [
        { id: "e1", title: "装花打合せ", start: "10:00", end: "11:00", planId: "p1", edited: false },
        { id: "e2", title: "見積書作成", start: "13:00", end: "14:30", planId: "p2", edited: true },
        { id: "e3", title: "自分で追加した作業", start: "16:00", end: "16:30", planId: null, edited: true },
        { id: "e4", title: "業者手配", start: "15:00", end: "16:00", planId: "p3", edited: false }
      ]
    },
    [`${yesterday}|m2`]: {
      date: yesterday, memberId: "m2", savedAt: new Date().toISOString(), dirty: false, summary: "保存済みの報告",
      plans: [{ id: "p9", title: "演出打合せ", start: "11:00", end: "12:30" }],
      entries: [{ id: "e9", title: "演出打合せ", start: "11:00", end: "12:30", planId: "p9", edited: false }]
    },
    [`${yesterday}|m3`]: {
      date: yesterday, memberId: "m3", savedAt: null, dirty: false, summary: "",
      plans: [], entries: []
    }
  }
};
const v2Page = await newPage({ viewport: { width: 1366, height: 860 } }, v2);
const v2Saved = await stored(v2Page);
check(v2Saved.version === 3, "v2の移行結果が保存されない");
const mToday = v2Saved.reports[`${today}|m1`];
check(mToday.entries.map((e) => e.id).join() === "e2,e3", `v2移行で残す実績が不正: ${mToday.entries.map((e) => e.id).join()}`);
check(mToday.plans.length === 3, "v2移行で予定が消えた");
check(v2Saved.reports[`${yesterday}|m2`].entries.length === 1, "v2移行で保存済み報告の実績が消えた");
check(!v2Saved.reports[`${yesterday}|m3`], "空の日報が残っている");
check(v2Saved.members.length === 4, "v2移行で担当者が消えた");
check((await v2Page.locator(".plan-row.is-added").count()) === 1, "v2移行後、編集済み実績の予定だけが追加済みになっていない");
check((await text(v2Page, "#bulk-note")) === "未追加 2件", "v2移行後の未追加件数が不正");
await tab(v2Page, "actual");
check((await entryTitles(v2Page)).join() === "見積書作成,自分で追加した作業", "v2移行後の実績表示が不正");
check((await text(v2Page, ".entry-row:first-child .entry-meta")) === "予定 13:00–14:00（+30分）", "v2移行後に予定との差が出ない");
check((await text(v2Page, ".entry-row:last-child .entry-meta")) === "予定外", "v2移行後に予定外の作業が判別できない");
await v2Page.reload({ waitUntil: "networkidle" });
check((await v2Page.locator(".entry-row").count()) === 2, "v2移行後の再読込で実績が変わった");
await v2Page.selectOption("#member-select", "m2");
await v2Page.click("#prev-day");
check((await entryTitles(v2Page)).join() === "演出打合せ", "v2移行後に保存済み報告が開けない");
await v2Page.context().close();

// =====================================================================
// 4. スマートフォン
// =====================================================================
const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
check((await overflowX(phone)) <= 1, `スマホの予定タブで横スクロールが出る: ${await overflowX(phone)}px`);
await shot(phone, "phone-plan");
await phone.locator(".block").first().tap();
check(await phone.locator("#item-dialog").evaluate((d) => d.open), "スマホでブロックをタップして編集できない");
await phone.click("#dialog-cancel");
await phone.locator(".plan-row .add-one").first().tap();
check((await phone.locator(".plan-row.is-added").count()) === 1, "スマホで実績に追加できない");
await phone.locator(".plan-row .view-entry").first().tap();
await phone.tap("#add-entry");
await phone.locator(".entry-title:focus").fill("移動");
await phone.locator(".entry-row").first().locator(".entry-title").fill("とても長い作業名をスマートフォンで入力したときにはみ出さないかの確認");
check((await phone.locator(".entry-row").count()) === 2, "スマホで実績を編集・追加できない");
check((await overflowX(phone)) <= 1, `スマホの実績タブで横スクロールが出る: ${await overflowX(phone)}px`);
await shot(phone, "phone-actual");
await tab(phone, "history");
check((await overflowX(phone)) <= 1, "スマホの履歴タブで横スクロールが出る");
await shot(phone, "phone-history", false);

await browser.close();
if (errors.length) fail(`コンソールエラー: ${errors.join(" / ")}`);
console.log("daily-report smoke: OK");
