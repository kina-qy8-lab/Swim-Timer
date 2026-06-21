// ───────────────────────────────────────────────────────────
// 競泳タイマー（PoC）
// 時刻同期：スターターが押した「ピッ」の瞬間を T0（サーバー時刻）として共有し、
//          各端末は (押した瞬間 + 自分のズレ) − T0 で経過時間を出す。
// 保存先：Realtime Database。
// ───────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getDatabase, ref, onValue, set, update, push, child, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

import { firebaseConfig, START_LEAD_MS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

const RACE     = "session/race";
const MEMBERS  = "members";
const RESULTS  = "practiceResults";
const SETTINGS = "settings";

// 種目と距離
const EVENTS = {
  "自由形": [50, 100, 200, 400, 800, 1500],
  "平泳ぎ": [50, 100, 200],
  "背泳ぎ": [50, 100, 200],
  "バタフライ": [50, 100, 200],
  "個人メドレー": [200, 400],
  "フリーリレー": [200, 400, 800],
  "メドレーリレー": [200, 400, 800]
};

// ── 状態 ────────────────────────────────────────────────
let serverOffset = 0;
let role = null;
let myLane = null;
let ringHere = false;
let lastBeepRaceId = null;
let race = null;
let members = {};
let results = {};
let pendingSwimmer = null;
let savedSig = null;
let editingMemberId = null;
let editingRecordId = null;
let memberSort = "grade";
let recFilter = "";
let viewPassHash = null;

const serverNow = () => Date.now() + serverOffset;
const todayISO = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ── 発進音の設定（端末に記憶） ──────────────────────────
const DEFAULT_PITCH = 1380, BEEP_DUR = 0.14, DEFAULT_VOL = 1.0;
const PITCH_MIN = 800, PITCH_MAX = 2500;
const clampPitch = (n) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(n) || DEFAULT_PITCH));
function loadPitch() { try { const v = localStorage.getItem("beepHz"); if (v) return clampPitch(Number(v)); } catch (e) {} return DEFAULT_PITCH; }
function savePitch(hz) { try { localStorage.setItem("beepHz", String(hz)); } catch (e) {} }
let beepHz = loadPitch();
const VOL_MIN = 0.2, VOL_MAX = 2.0;
const clampVol = (n) => Math.min(VOL_MAX, Math.max(VOL_MIN, isNaN(n) ? DEFAULT_VOL : n));
function loadVol() { try { const v = localStorage.getItem("beepVol"); if (v) return clampVol(Number(v)); } catch (e) {} return DEFAULT_VOL; }
function saveVol(v) { try { localStorage.setItem("beepVol", String(v)); } catch (e) {} }
let beepVol = loadVol();

// ── 時間の整形・解析（カンマ2秒・競泳式に切り捨て） ─────────
function fmt(ms) {
  if (ms == null || ms < 0) ms = 0;
  const cs = Math.floor(ms / 10), c = cs % 100, totalSec = Math.floor(cs / 100);
  const s = totalSec % 60, m = Math.floor(totalSec / 60), cc = String(c).padStart(2, "0");
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}.${cc}` : `${s}.${cc}`;
}
function parseTime(str) {
  str = String(str).trim(); if (!str) return null;
  let m = 0, rest = str;
  if (str.includes(":")) { const [a, b] = str.split(":"); m = Number(a); rest = b; }
  const sec = Number(rest);
  if (isNaN(sec) || isNaN(m) || sec < 0 || m < 0) return null;
  return Math.round((m * 60 + sec) * 1000);
}
function fmtClock(epochMs) {
  const d = new Date(epochMs);
  const cc = String(Math.floor((epochMs % 1000) / 10)).padStart(2, "0");
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${cc}`;
}

// ── ラップ自動計算エンジン ──────────────────────────────
// プール長 × ラップ計測(none/start/both) × 距離 → 何回押すか・各壁の距離
function lapPlan(poolLength, distance, lapMode) {
  if (!distance) return null;
  let interval;
  if (lapMode === "none") interval = distance;
  else if (lapMode === "start") interval = poolLength * 2;
  else interval = poolLength; // both
  interval = Math.min(interval, distance);
  const count = Math.max(1, Math.round(distance / interval));
  const dists = [];
  for (let i = 1; i <= count; i++) dists.push(Math.min(distance, i * interval));
  dists[dists.length - 1] = distance; // 最後は必ずゴール距離
  return { count, interval, dists };
}
function currentPlan() {
  const lane = race?.lanes?.[myLane];
  if (!lane?.distance) return null;
  return lapPlan(race.poolLength || 25, lane.distance, race.lapMode || "both");
}

// ── 発進音（Web Audio） ─────────────────────────────────
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function scheduleBeepAt(targetEpochMs, doFlash = true) {
  if (!audioCtx) return;
  const when = audioCtx.currentTime + Math.max(0, (targetEpochMs - Date.now()) / 1000);
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = "sine"; osc.frequency.value = beepHz;
  const dur = BEEP_DUR, vol = beepVol;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(vol, when + 0.004);
  gain.gain.setValueAtTime(vol, when + Math.max(0.01, dur - 0.03));
  gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when); osc.stop(when + dur + 0.02);
  if (doFlash) setTimeout(fireFlash, Math.max(0, targetEpochMs - Date.now()));
}
function fireFlash() { const f = $("#flash"); f.classList.remove("fire"); void f.offsetWidth; f.classList.add("fire"); }

// ── DOMヘルパ ──────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function show(id) { $$(".screen").forEach((el) => (el.hidden = true)); $("#" + id).hidden = false; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── 共有パスワード（バックオフィスのゲート） ───────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function isUnlocked() { try { return sessionStorage.getItem("unlocked") === "1"; } catch (e) { return false; } }
function setUnlocked() { try { sessionStorage.setItem("unlocked", "1"); } catch (e) {} }
async function requireUnlock() {
  if (isUnlocked()) return true;
  if (!viewPassHash) {
    const p = prompt("閲覧用パスワードを新規設定します（全体で共有する1つのパスワード）");
    if (!p) return false;
    const p2 = prompt("確認のためもう一度入力してください");
    if (p !== p2) { alert("一致しませんでした。"); return false; }
    set(ref(db, `${SETTINGS}/viewPassHash`), await sha256(p));
    setUnlocked();
    return true;
  }
  const p = prompt("閲覧用パスワードを入力してください");
  if (!p) return false;
  if (await sha256(p) === viewPassHash) { setUnlocked(); return true; }
  alert("パスワードが違います。");
  return false;
}

// ── RTDB購読 ───────────────────────────────────────────
onValue(ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; $("#offset-val").textContent = Math.round(serverOffset); });
onValue(ref(db, ".info/connected"), (s) => {
  const c = !!s.val();
  $("#conn-dot").classList.toggle("on", c);
  $("#conn-text").textContent = c ? "接続OK" : "未接続";
});
onValue(ref(db, RACE), (s) => { race = s.val(); onRaceChanged(); });
onValue(ref(db, MEMBERS), (s) => { members = s.val() || {}; if (!$("#screen-members").hidden) renderMembers(); populatePicker(); populateFilter(); });
onValue(ref(db, RESULTS), (s) => { results = s.val() || {}; if (!$("#screen-records").hidden) renderRecords(); });
onValue(ref(db, `${SETTINGS}/viewPassHash`), (s) => { viewPassHash = s.val() || null; });

// ── スターター操作 ─────────────────────────────────────
let pool = 25, lapMode = "both";

function arm() {
  ensureAudio();
  set(ref(db, RACE), {
    state: "armed", raceId: "r" + Date.now().toString(36),
    poolLength: pool, lapMode,
    startServerTime: null, armedAt: serverTimestamp(), lanes: null
  });
}
function start() {
  ensureAudio();
  if (!race || race.state !== "armed") return;
  const t0Local = Date.now() + START_LEAD_MS;
  scheduleBeepAt(t0Local);
  update(ref(db, RACE), { state: "running", startServerTime: t0Local + serverOffset, startedAt: serverTimestamp() });
}
// リセット：確認のうえ、選手は残してラップだけ消し、準備状態へ戻す
function resetRace() {
  if (!race) return;
  if (!confirm("本当にリセットしますか？\n（現在のラップは消去され、選手の割り当ては残ります）")) return;
  const upd = { state: "armed", startServerTime: null, raceId: "r" + Date.now().toString(36) };
  Object.keys(race.lanes || {}).forEach((L) => { upd[`lanes/${L}/splits`] = null; });
  update(ref(db, RACE), upd);
}
function cancel() { set(ref(db, RACE), { state: "idle" }); }

// ── 記録者操作 ─────────────────────────────────────────
function laneSplitsArr(lane) {
  const o = race?.lanes?.[lane]?.splits || {};
  return Object.values(o).sort((a, b) => a.elapsedMs - b.elapsedMs);
}
function recordSplit() {
  if (!race || race.state !== "running" || race.startServerTime == null) return;
  const plan = currentPlan();
  if (plan && laneSplitsArr(myLane).length >= plan.count) return; // ゴール済み
  const elapsed = serverNow() - race.startServerTime;
  if (elapsed < 0) return;
  set(push(child(ref(db, RACE), `lanes/${myLane}/splits`)), { elapsedMs: Math.round(elapsed), at: serverTimestamp() });
}
function saveResult() {
  const lane = race?.lanes?.[myLane];
  const arr = laneSplitsArr(myLane);
  if (!lane?.name || !arr.length) return;
  set(push(ref(db, RESULTS)), {
    memberId: lane.memberId || null, name: lane.name, school: lane.school || "",
    dateISO: todayISO(), lane: myLane, poolLength: race.poolLength || null,
    lapMode: race.lapMode || null, stroke: lane.stroke || "", distance: lane.distance || null,
    splits: arr.map((s) => s.elapsedMs), finalMs: arr[arr.length - 1].elapsedMs,
    createdAt: serverTimestamp()
  });
  savedSig = `${race.raceId}:${arr.length}`;
  $("#saved-msg").hidden = false;
  $("#btn-save").disabled = true;
}

// ── 画面更新（レース） ─────────────────────────────────
function onRaceChanged() {
  if (role === "starter") {
    const st = race?.state || "idle";
    $("#starter-state").textContent = { idle: "準備前", armed: "準備OK（記録者を待機）", running: "計測中" }[st] || st;
    $("#btn-arm").hidden = st !== "idle";
    $("#btn-start").hidden = st !== "armed";
    $("#btn-cancel").hidden = st !== "armed";
    $("#running-actions").hidden = st !== "running";
    $("#starter-clock").hidden = st !== "running";
    $("#starter-lanes").hidden = st === "idle";
    $("#starter-hint").hidden = st !== "idle";
    renderStarterLanes();
  }

  if (role === "recorder" && !$("#screen-recorder").hidden) {
    const st = race?.state || "idle";
    const statusEl = $("#rec-status");
    if (st === "running") { statusEl.textContent = "計測中"; statusEl.classList.add("live"); }
    else if (st === "armed") { statusEl.textContent = "まもなくスタート（合図を待つ）"; statusEl.classList.remove("live"); }
    else { statusEl.textContent = "スターターの準備を待っています…"; statusEl.classList.remove("live"); }
    const lane = race?.lanes?.[myLane];
    $("#rec-swimmer").textContent = lane?.name || "—";
    $("#rec-event").textContent = lane?.stroke ? `${lane.stroke} ${lane.distance}m` : "自由計測";
    renderSplits();
    updateSplitButton();
    updateSaveButton();
  }

  if (role === "recorder" && ringHere && race?.state === "running"
      && race.startServerTime != null && race.raceId !== lastBeepRaceId) {
    lastBeepRaceId = race.raceId;
    scheduleBeepAt(race.startServerTime - serverOffset);
  }
}
function updateSplitButton() {
  const btn = $("#btn-split");
  const running = race?.state === "running";
  const plan = currentPlan();
  const n = laneSplitsArr(myLane).length;
  if (plan) {
    const done = n >= plan.count;
    btn.disabled = !running || done;
    btn.textContent = done ? "計測完了" : (n + 1 === plan.count ? `ゴール（${n + 1}/${plan.count}）` : `ラップ（${n + 1}/${plan.count}）`);
  } else {
    btn.disabled = !running;
    btn.textContent = "ラップ / ゴール";
  }
}
function updateSaveButton() {
  const lane = race?.lanes?.[myLane];
  const arr = laneSplitsArr(myLane);
  const sig = `${race?.raceId}:${arr.length}`;
  const canSave = arr.length > 0 && !!lane?.name && sig !== savedSig;
  $("#btn-save").disabled = !canSave;
  if (canSave) $("#saved-msg").hidden = true;
}
function renderStarterLanes() {
  const wrap = $("#starter-lanes"); if (wrap.hidden) return;
  const lanes = race?.lanes || {};
  let html = "";
  for (let i = 1; i <= 6; i++) {
    const sp = lanes[i]?.splits ? Object.values(lanes[i].splits) : [];
    const last = sp.length ? fmt(sp[sp.length - 1].elapsedMs) : "—";
    html += `<div class="lane-cell" style="border-top-color:var(--lane${i})">
      <div class="n">L${i}</div><div class="c">${last}</div><div class="nm">${escapeHtml(lanes[i]?.name || "")}</div></div>`;
  }
  wrap.innerHTML = html;
}
function renderSplits() {
  const wrap = $("#splits");
  const arr = laneSplitsArr(myLane);
  const plan = currentPlan();
  if (!arr.length) { wrap.innerHTML = ""; return; }
  let html = `<div class="cap"><span>${plan ? "距離" : "#"}</span><span>累計</span><span>ラップ</span></div>`;
  arr.forEach((s, i) => {
    const prev = i ? arr[i - 1].elapsedMs : 0;
    const isGoal = plan ? (i === plan.count - 1) : (i === arr.length - 1);
    const label = plan ? `${plan.dists[i] ?? ""}m` : `${i + 1}`;
    html += `<div class="split-row${isGoal ? " final" : ""}">
      <span class="idx">${label}</span>
      <span class="cum">${fmt(s.elapsedMs)}</span>
      <span class="lap">+${fmt(s.elapsedMs - prev)}</span></div>`;
  });
  wrap.innerHTML = html;
}

// ── メンバー名簿 ───────────────────────────────────────
function memberList(sortBy = memberSort) {
  const a = Object.entries(members).map(([id, m]) => ({ id, ...m }));
  if (sortBy === "school") {
    a.sort((x, y) => String(x.school || "").localeCompare(String(y.school || ""), "ja")
      || (x.grade - y.grade) || String(x.name).localeCompare(String(y.name), "ja"));
  } else {
    a.sort((x, y) => (x.grade - y.grade) || String(x.name).localeCompare(String(y.name), "ja"));
  }
  return a;
}
function readMemberForm() {
  const name = $("#m-name").value.trim();
  if (!name) { $("#m-name").focus(); return null; }
  return {
    name, grade: Number($("#m-grade").value), gender: $("#m-gender").value,
    school: $("#m-school").value.trim() || "", guest: $("#m-guest").checked
  };
}
function addOrUpdateMember() {
  const data = readMemberForm(); if (!data) return;
  if (editingMemberId) {
    update(ref(db, `${MEMBERS}/${editingMemberId}`), data);
    exitEditMember();
  } else {
    set(push(ref(db, MEMBERS)), { ...data, createdAt: serverTimestamp() });
    $("#m-name").value = ""; $("#m-guest").checked = false; $("#m-name").focus();
  }
}
function startEditMember(id) {
  const m = members[id]; if (!m) return;
  editingMemberId = id;
  $("#m-name").value = m.name || "";
  $("#m-grade").value = String(m.grade || 2);
  $("#m-gender").value = m.gender || "男";
  $("#m-school").value = m.school || "";
  $("#m-guest").checked = !!m.guest;
  $("#btn-add-member").textContent = "更新する";
  $("#btn-cancel-edit").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function exitEditMember() {
  editingMemberId = null;
  $("#m-name").value = ""; $("#m-guest").checked = false;
  $("#btn-add-member").textContent = "追加する";
  $("#btn-cancel-edit").hidden = true;
}
function deleteMember(id) {
  if (!confirm("このメンバーを削除しますか？")) return;
  remove(ref(db, `${MEMBERS}/${id}`));
  if (editingMemberId === id) exitEditMember();
}
function renderMembers() {
  const wrap = $("#mlist");
  const list = memberList();
  if (!list.length) { wrap.innerHTML = `<p class="empty">まだ登録がありません。</p>`; return; }
  wrap.innerHTML = list.map((m) => `
    <div class="member-row${editingMemberId === m.id ? " editing" : ""}">
      <div class="m-main"><span class="m-name">${escapeHtml(m.name)}</span>${m.guest ? `<span class="tag guest">ゲスト</span>` : ""}</div>
      <div class="m-sub">${m.grade}年・${escapeHtml(m.gender || "")}・${escapeHtml(m.school || "")}</div>
      <div class="m-actions">
        <button class="edit" data-edit="${m.id}">編集</button>
        <button class="del" data-del="${m.id}">削除</button>
      </div>
    </div>`).join("");
}

// ── 記録一覧（絞り込み・編集・削除） ───────────────────────
function populateFilter() {
  const sel = $("#rec-filter"); if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">— 選手を選択 —</option>', '<option value="__all">全員</option>']
    .concat(memberList().map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年）</option>`));
  sel.innerHTML = opts.join("");
  sel.value = cur || recFilter || "";
}
function recordsFor(filter) {
  let list = Object.entries(results).map(([id, r]) => ({ id, ...r }));
  if (filter && filter !== "__all") list = list.filter((r) => r.memberId === filter);
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function renderRecords() {
  const wrap = $("#rlist");
  if (!recFilter) { wrap.innerHTML = `<p class="empty">上のリストから選手（または全員）を選んでください。</p>`; return; }
  const list = recordsFor(recFilter);
  if (!list.length) { wrap.innerHTML = `<p class="empty">記録がありません。</p>`; return; }
  wrap.innerHTML = list.map((r) => editingRecordId === r.id ? recordEditorHtml(r) : recordRowHtml(r)).join("");
}
function recordRowHtml(r) {
  const splits = Array.isArray(r.splits) ? r.splits : [];
  let laps = "";
  splits.forEach((cum, i) => { laps += `<span class="chip">+${fmt(cum - (i ? splits[i - 1] : 0))}</span>`; });
  const ev = r.stroke ? `${escapeHtml(r.stroke)} ${r.distance}m` : "自由計測";
  return `<div class="record-row" data-rec="${r.id}">
    <div class="r-head"><span class="r-final">${fmt(r.finalMs)}</span><span class="r-name">${escapeHtml(r.name || "")}</span><span class="r-meta">${ev}</span></div>
    <div class="r-sub">${escapeHtml(r.dateISO || "")}・L${r.lane ?? "-"}・${r.poolLength || "?"}m・${escapeHtml(r.school || "")}</div>
    <div class="r-laps">${laps}</div>
    <div class="r-actions"><button class="edit" data-redit="${r.id}">修正</button><button class="del" data-rdel="${r.id}">削除</button></div>
  </div>`;
}
function recordEditorHtml(r) {
  const splits = Array.isArray(r.splits) ? r.splits : [];
  const rows = splits.map((cum, i) =>
    `<label class="te-row"><span>${i + 1}本目（累計）</span><input class="te" data-i="${i}" type="text" inputmode="decimal" value="${fmt(cum)}" /></label>`).join("");
  return `<div class="record-row editing" data-rec="${r.id}">
    <div class="r-head"><span class="r-name">${escapeHtml(r.name || "")}</span><span class="r-meta">${escapeHtml(r.dateISO || "")}</span></div>
    <div class="te-list">${rows}</div>
    <p class="te-hint">例：28.55 / 1:05.33（累計タイムを入力）</p>
    <div class="r-actions"><button class="save" data-rsave="${r.id}">保存</button><button class="ghost" data-rcancel="1">キャンセル</button></div>
  </div>`;
}
function saveRecordEdit(id) {
  const inputs = $$(`#rlist [data-rec="${id}"] .te`);
  const splits = [];
  for (const inp of inputs) {
    const ms = parseTime(inp.value);
    if (ms == null) { alert("時間の形式が正しくありません（例：28.55 や 1:05.33）"); return; }
    splits.push(ms);
  }
  for (let i = 1; i < splits.length; i++) {
    if (splits[i] <= splits[i - 1]) { alert("累計タイムは前の本数より大きくなる必要があります。"); return; }
  }
  update(ref(db, `${RESULTS}/${id}`), { splits, finalMs: splits[splits.length - 1] });
  editingRecordId = null;
  renderRecords();
}
function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  remove(ref(db, `${RESULTS}/${id}`));
  if (editingRecordId === id) editingRecordId = null;
}

// ── 記録者：レーン＋選手＋種目 ─────────────────────────
function resetRecorderSetup() {
  myLane = null; pendingSwimmer = null;
  $$(".lane-opt").forEach((x) => x.classList.remove("sel"));
  $("#swimmer-auto").hidden = true;
  $("#assign-area").hidden = true;
  $("#setup-hint").hidden = true;
  $("#btn-join").disabled = true;
  $("#ev-stroke").value = ""; $("#dist-field").hidden = true;
}
function populatePicker() {
  const sel = $("#swimmer-pick"); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = ['<option value="">— 選手を選択 —</option>']
    .concat(memberList().map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年${m.guest ? "・ゲスト" : ""}）</option>`)).join("");
  if (cur) sel.value = cur;
}
function populateDistances() {
  const stroke = $("#ev-stroke").value;
  const dsel = $("#ev-dist");
  if (!stroke) { $("#dist-field").hidden = true; dsel.innerHTML = ""; return; }
  dsel.innerHTML = (EVENTS[stroke] || []).map((d) => `<option value="${d}">${d}m</option>`).join("");
  $("#dist-field").hidden = false;
}
function onLaneChosen(lane) {
  myLane = lane;
  const assigned = race?.lanes?.[lane];
  if (assigned && assigned.name) {
    pendingSwimmer = { memberId: assigned.memberId || null, name: assigned.name, school: assigned.school || "" };
    const ev = assigned.stroke ? `${assigned.stroke} ${assigned.distance}m` : "自由計測";
    $("#swimmer-auto-text").textContent = `選手：${assigned.name}（${ev}）`;
    $("#swimmer-auto").hidden = false;
    $("#assign-area").hidden = true;
    $("#setup-hint").hidden = true;
    $("#btn-join").disabled = false;
  } else {
    pendingSwimmer = null;
    $("#swimmer-auto").hidden = true;
    populatePicker();
    $("#assign-area").hidden = false;
    $("#ev-stroke").value = ""; populateDistances();
    $("#setup-hint").hidden = memberList().length !== 0;
    $("#btn-join").disabled = true;
  }
}
function joinLane() {
  if (!myLane) return;
  ensureAudio();
  ringHere = $("#ring-here").checked;
  if (!pendingSwimmer) {
    const id = $("#swimmer-pick").value;
    if (!id || !members[id]) return;
    const m = members[id];
    const stroke = $("#ev-stroke").value;
    const distance = stroke ? Number($("#ev-dist").value) : null;
    pendingSwimmer = { memberId: id, name: m.name, school: m.school || "" };
    update(ref(db, `${RACE}/lanes/${myLane}`), {
      memberId: id, name: m.name, school: m.school || "", stroke: stroke || null, distance
    });
  }
  $("#rec-lane-label").textContent = `レーン ${myLane}`;
  savedSig = null; lastBeepRaceId = null;
  $("#saved-msg").hidden = true;
  show("screen-recorder");
  onRaceChanged();
}

// ── 描画ループ ─────────────────────────────────────────
function tick() {
  $("#sync-clock").textContent = fmtClock(serverNow());
  if (race?.state === "running" && race.startServerTime != null) {
    const t = fmt(serverNow() - race.startServerTime);
    if (role === "starter") $("#starter-clock").textContent = t;
    if (role === "recorder") $("#rec-clock").textContent = t;
  } else if (role === "recorder") {
    $("#rec-clock").textContent = "0.00";
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── イベント結線 ───────────────────────────────────────
$$(".role-btn").forEach((b) => b.addEventListener("click", () => {
  role = b.dataset.role;
  if (role === "starter") { show("screen-starter"); onRaceChanged(); }
  else { resetRecorderSetup(); show("screen-recorder-setup"); }
}));

$$("[data-go]").forEach((b) => b.addEventListener("click", async () => {
  const t = b.dataset.go;
  if (!(await requireUnlock())) return;  // バックオフィスはパスワード
  role = null; myLane = null;
  if (t === "members") { renderMembers(); show("screen-members"); }
  if (t === "records") { populateFilter(); renderRecords(); show("screen-records"); }
}));

$$("[data-back]").forEach((b) => b.addEventListener("click", () => {
  if (role === "recorder" && !$("#screen-recorder").hidden) { resetRecorderSetup(); show("screen-recorder-setup"); return; }
  role = null; myLane = null;
  show("screen-role");
}));

$("#pool-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  pool = Number(btn.dataset.pool);
  $$("#pool-seg button").forEach((x) => x.classList.toggle("on", x === btn));
});
$("#lap-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  lapMode = btn.dataset.lap;
  $$("#lap-seg button").forEach((x) => x.classList.toggle("on", x === btn));
});

// 音設定の開閉
$("#sound-toggle").addEventListener("click", () => {
  const box = $("#sound-box"); box.hidden = !box.hidden;
  $("#sound-toggle").textContent = box.hidden ? "🔊 音の設定 ▾" : "🔊 音の設定 ▴";
});
const pitchEl = $("#pitch"), pitchVal = $("#pitch-val");
pitchEl.min = PITCH_MIN; pitchEl.max = PITCH_MAX; pitchEl.value = beepHz; pitchVal.textContent = beepHz + "Hz";
pitchEl.addEventListener("input", (e) => { beepHz = clampPitch(Number(e.target.value)); pitchVal.textContent = beepHz + "Hz"; savePitch(beepHz); });
$("#btn-test-sound").addEventListener("click", () => { ensureAudio(); scheduleBeepAt(Date.now() + 40, false); });
const volEl = $("#vol"), volVal = $("#vol-val");
volEl.value = beepVol; volVal.textContent = Math.round(beepVol * 100) + "%";
volEl.addEventListener("input", (e) => { beepVol = clampVol(Number(e.target.value)); volVal.textContent = Math.round(beepVol * 100) + "%"; saveVol(beepVol); });

$("#btn-arm").addEventListener("click", arm);
$("#btn-start").addEventListener("click", start);
$("#btn-reset").addEventListener("click", resetRace);
$("#btn-cancel").addEventListener("click", cancel);

$("#lane-pick").innerHTML = [1, 2, 3, 4, 5, 6].map((n) => `<button class="lane-opt" data-lane="${n}">${n}</button>`).join("");
$("#lane-pick").addEventListener("click", (e) => {
  const b = e.target.closest(".lane-opt"); if (!b) return;
  $$(".lane-opt").forEach((x) => x.classList.toggle("sel", x === b));
  onLaneChosen(Number(b.dataset.lane));
});
$("#swimmer-pick").addEventListener("change", (e) => { $("#btn-join").disabled = !e.target.value; });
$("#ev-stroke").addEventListener("change", populateDistances);
$("#btn-join").addEventListener("click", joinLane);
$("#btn-split").addEventListener("click", recordSplit);
$("#btn-save").addEventListener("click", saveResult);

// メンバー
$("#btn-add-member").addEventListener("click", addOrUpdateMember);
$("#btn-cancel-edit").addEventListener("click", exitEditMember);
$("#msort").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  memberSort = btn.dataset.sort;
  $$("#msort button").forEach((x) => x.classList.toggle("on", x === btn));
  renderMembers();
});
$("#mlist").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-edit]"); if (ed) return startEditMember(ed.dataset.edit);
  const de = e.target.closest("[data-del]"); if (de) return deleteMember(de.dataset.del);
});

// 記録
$("#rec-filter").addEventListener("change", (e) => { recFilter = e.target.value; editingRecordId = null; renderRecords(); });
$("#rlist").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-redit]"); if (ed) { editingRecordId = ed.dataset.redit; renderRecords(); return; }
  const sv = e.target.closest("[data-rsave]"); if (sv) { saveRecordEdit(sv.dataset.rsave); return; }
  const cc = e.target.closest("[data-rcancel]"); if (cc) { editingRecordId = null; renderRecords(); return; }
  const de = e.target.closest("[data-rdel]"); if (de) { deleteRecord(de.dataset.rdel); return; }
});

show("screen-role");
