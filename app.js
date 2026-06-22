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
let showRetired = false;
let recFilter = "";
// 記録ページの状態
let recMode = "indiv";        // indiv | relay | ranking
let indivSub = "summary";     // summary | event
let evFilter = "";            // 個人・種目の種目キー
let sortMode = "date";        // date | time
let overlayOn = false;
let relayGenderF = "";
let relayEventF = "";
let relaySort = "date";
let rankEvent = "";
let analysisId = null;
let manualKind = "indiv";
let chProgress = null, chOverlay = null, chLap = null, chShape = null, chDeficit = null;
let viewPassHash = null;
let ending = false;
let joinedRaceId = null;

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

// iOS対策：最初のタップで音声を解錠（無音バッファを1回再生）。
// ※消音スイッチ（マナーモード）がオンだと、解錠しても鳴りません。
let audioUnlocked = false;
function unlockAudio() {
  ensureAudio();
  if (!audioCtx || audioUnlocked) return;
  try {
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination); src.start(0);
    audioUnlocked = true;
  } catch (e) {}
}
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("touchend", unlockAudio);

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
onValue(ref(db, RESULTS), (s) => { results = s.val() || {}; if (!$("#screen-records").hidden) renderRecordsAll(); });
onValue(ref(db, `${SETTINGS}/viewPassHash`), (s) => { viewPassHash = s.val() || null; });

// ── スターター操作 ─────────────────────────────────────
let pool = 25, lapMode = "both", mode = "practice";

// 非計測時は常に ready（準備）状態。スターター画面に入ったら ready を保証。
function ensureReady() {
  if (race && (race.state === "running" || race.state === "ended")) return;
  if (race && race.state === "ready") {
    pool = race.poolLength || pool; lapMode = race.lapMode || lapMode; mode = race.mode || mode;
    return;
  }
  set(ref(db, RACE), {
    state: "ready", raceId: "r" + Date.now().toString(36),
    poolLength: pool, lapMode, mode, startServerTime: null, lanes: null
  });
}
// 設定（プール/ラップ/モード）を即時にセッションへ反映（記録者にリアルタイム同期）
function setConfig() {
  if (race && race.state !== "running") update(ref(db, RACE), { poolLength: pool, lapMode, mode });
}
function syncStarterControls() {
  $$("#pool-seg button").forEach((x) => x.classList.toggle("on", Number(x.dataset.pool) === pool));
  $$("#lap-seg button").forEach((x) => x.classList.toggle("on", x.dataset.lap === lapMode));
  $$("#mode-seg button").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  $("#mode-note").hidden = mode !== "meet";
}
function start() {
  ensureAudio();
  if (!race || race.state !== "ready") return;
  const t0Local = Date.now() + START_LEAD_MS;
  scheduleBeepAt(t0Local);
  update(ref(db, RACE), { state: "running", startServerTime: t0Local + serverOffset, startedAt: serverTimestamp() });
}
function freshReady() {
  return {
    state: "ready", raceId: "r" + Date.now().toString(36),
    poolLength: race.poolLength, lapMode: race.lapMode, mode: race.mode || "practice",
    startServerTime: null, lanes: null
  };
}
// リセット：確認のうえ、記録も選手割り当ても消して準備状態へ
function resetRace() {
  if (!race) return;
  if (!confirm("本当にリセットしますか？\n（記録と選手の割り当てが消去されます）")) return;
  set(ref(db, RACE), freshReady());
}
function splitsArrOf(lane) {
  return (lane.splits ? Object.values(lane.splits) : []).sort((a, b) => a.elapsedMs - b.elapsedMs);
}
function buildResult(laneNum, lane) {
  const arr = splitsArrOf(lane);
  const base = {
    dateISO: todayISO(), lane: laneNum, poolLength: race.poolLength || null, lapMode: race.lapMode || null,
    stroke: lane.stroke || "", distance: lane.distance || null,
    splits: arr.map((s) => s.elapsedMs), finalMs: arr.length ? arr[arr.length - 1].elapsedMs : 0,
    createdAt: serverTimestamp()
  };
  if (lane.isRelay) return { ...base, isRelay: true, name: lane.name || "リレー", school: lane.school || "", legs: lane.legs || [] };
  return { ...base, memberId: lane.memberId || null, name: lane.name, school: lane.school || "" };
}
// 終了：割り当て済み全レーンを自動保存し、各レーンに resultId を記録。結果を残したまま ended で停止。
function endRace() {
  if (!race || ending) return;
  ending = true;
  const updates = { state: "ended" };
  Object.entries(race.lanes || {}).forEach(([L, lane]) => {
    if (lane?.name && splitsArrOf(lane).length) {
      const nref = push(ref(db, RESULTS));
      set(nref, buildResult(Number(L), lane));
      updates[`lanes/${L}/resultId`] = nref.key;
      updates[`lanes/${L}/saved`] = true;
    }
  });
  update(ref(db, RACE), updates);
  setTimeout(() => { ending = false; }, 1500);
}
// 次のレースへ（結果を片付けて準備状態へ）
function nextRace() { if (race) set(ref(db, RACE), freshReady()); }
// 記録者が、確認画面で自分のレーンの記録を削除（自動保存はこの後も継続）
function deleteMyResult() {
  const lane = race?.lanes?.[myLane];
  const rid = lane?.resultId;
  if (!rid) { alert("削除できる記録が見つかりません。"); return; }
  if (!confirm("この記録を削除しますか？\n（残したくない場合に使います。次回以降の自動保存は続きます）")) return;
  remove(ref(db, `${RESULTS}/${rid}`));
  update(ref(db, `${RACE}/lanes/${myLane}`), { resultId: null, deleted: true });
}

// ── 記録者操作 ─────────────────────────────────────────
function laneSplitsArr(lane) {
  const o = race?.lanes?.[lane]?.splits || {};
  return Object.values(o).sort((a, b) => a.elapsedMs - b.elapsedMs);
}
function recordSplit() {
  if (!race || race.state !== "running" || race.startServerTime == null) return;
  const plan = currentPlan();
  const n = laneSplitsArr(myLane).length;
  if (plan && n >= plan.count) return; // ゴール済み
  const elapsed = serverNow() - race.startServerTime;
  if (elapsed < 0) return;
  set(push(child(ref(db, RACE), `lanes/${myLane}/splits`)), { elapsedMs: Math.round(elapsed), at: serverTimestamp() });
  if (plan && n + 1 >= plan.count) update(ref(db, `${RACE}/lanes/${myLane}`), { done: true });
}
function saveResult() { /* 手動保存は廃止：終了時に自動保存される */ }

// ── 画面更新（レース） ─────────────────────────────────
function onRaceChanged() {
  if (role === "starter") {
    const st = race?.state || "ready";
    const running = st === "running", ended = st === "ended";
    $("#starter-state").textContent = running ? "計測中" : ended ? "計測終了（保存済み）" : "準備OK（記録者を待機）";
    $("#starter-config").hidden = running || ended;
    $("#btn-start").hidden = running || ended;
    $("#running-actions").hidden = !running;
    $("#ended-actions").hidden = !ended;
    $("#starter-clock").hidden = !running;
    $("#starter-hint").hidden = running || ended;
    renderStarterLanes();
    if (running) {
      const assigned = Object.values(race.lanes || {}).filter((l) => l?.name);
      if (assigned.length > 0 && assigned.every((l) => l.done === true)) endRace();
    }
  }

  if (role === "recorder" && !$("#screen-recorder").hidden) {
    if (!race || race.raceId !== joinedRaceId) {
      resetRecorderSetup(); show("screen-recorder-setup"); return;
    }
    const running = race.state === "running", ended = race.state === "ended";
    const statusEl = $("#rec-status");
    statusEl.textContent = running ? "計測中" : ended ? "計測終了・保存しました" : "まもなくスタート（合図を待つ）";
    statusEl.classList.toggle("live", running);
    const lane = race.lanes?.[myLane];
    $("#rec-swimmer").textContent = lane?.name || "—";
    $("#rec-event").textContent = lane?.stroke ? `${lane.stroke} ${lane.distance}m` : "自由計測";
    renderSplits();
    updateSplitButton();
    $("#btn-split").hidden = ended;
    $("#rec-review").hidden = !ended;
    if (ended) {
      const arr = laneSplitsArr(myLane);
      $("#rec-clock").textContent = arr.length ? fmt(arr[arr.length - 1].elapsedMs) : "0.00";
      const msg = lane?.deleted ? "🗑 この記録は削除しました" : (lane?.resultId ? "✓ この記録は保存されました" : "（保存対象の記録がありません）");
      $("#rec-review .review-msg").textContent = msg;
      $("#btn-rec-delete").disabled = !lane?.resultId;
    }
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
    const prevCum = i ? arr[i - 1].elapsedMs : 0;
    const lap = s.elapsedMs - prevCum;
    const prevLap = i >= 1 ? (arr[i - 1].elapsedMs - (i >= 2 ? arr[i - 2].elapsedMs : 0)) : null;
    const diff = prevLap != null ? lap - prevLap : null;
    const diffStr = diff != null ? `<span class="dlap">(${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))})</span>` : "";
    const isGoal = plan ? (i === plan.count - 1) : (i === arr.length - 1);
    const label = plan ? `${plan.dists[i] ?? ""}m` : `${i + 1}`;
    html += `<div class="split-row${isGoal ? " final" : ""}">
      <span class="idx">${label}</span>
      <span class="cum">${fmt(s.elapsedMs)}</span>
      <span class="lap">${fmt(lap)} ${diffStr}</span></div>`;
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
  if (!confirm("このメンバーを削除しますか？\n（これまでの記録は残ります）")) return;
  remove(ref(db, `${MEMBERS}/${id}`));
  if (editingMemberId === id) exitEditMember();
}
function toggleRetire(id) {
  const m = members[id]; if (!m) return;
  update(ref(db, `${MEMBERS}/${id}`), { retired: !m.retired });
}
function renderMembers() {
  const wrap = $("#mlist");
  let list = memberList();
  if (!showRetired) list = list.filter((m) => !m.retired);
  if (!list.length) { wrap.innerHTML = `<p class="empty">${showRetired ? "まだ登録がありません。" : "表示できるメンバーがいません（引退者のみ）。"}</p>`; return; }
  wrap.innerHTML = list.map((m) => `
    <div class="member-row${editingMemberId === m.id ? " editing" : ""}${m.retired ? " retired" : ""}">
      <div class="m-main"><span class="m-name">${escapeHtml(m.name)}</span>${m.guest ? `<span class="tag guest">ゲスト</span>` : ""}${m.retired ? `<span class="tag retired-tag">引退</span>` : ""}</div>
      <div class="m-sub">${m.grade}年・${escapeHtml(m.gender || "")}・${escapeHtml(m.school || "")}</div>
      <div class="m-actions">
        <button class="edit" data-edit="${m.id}">編集</button>
        <button class="retire" data-retire="${m.id}">${m.retired ? "復帰" : "引退"}</button>
        <button class="del" data-del="${m.id}">削除</button>
      </div>
    </div>`).join("");
}

// ── 記録ページ ─────────────────────────────────────────
function allRecs() { return Object.entries(results).map(([id, r]) => ({ id, ...r })); }
function fiscalYear(dateISO) { if (!dateISO) return null; const [y, m] = dateISO.split("-").map(Number); return m >= 4 ? y : y - 1; }
function currentFiscalYear() { const d = new Date(); return (d.getMonth() + 1) >= 4 ? d.getFullYear() : d.getFullYear() - 1; }
function evKey(r) { return `${r.isRelay ? "R" : "I"}|${r.stroke || ""}|${r.distance || ""}|${r.poolLength || ""}`; }
function courseLabel(p) { p = Number(p); return p === 50 ? "長水路" : p === 25 ? "短水路" : "?"; }
function evLabelFromKey(k) { const p = k.split("|"); return `${p[1] || "自由計測"} ${p[2] ? p[2] + "m" : ""}（${courseLabel(p[3])}）`.replace(/\s+/g, " ").trim(); }
function evLabel(r) { return `${r.stroke || "自由計測"} ${r.distance ? r.distance + "m" : ""}（${courseLabel(r.poolLength)}）`.replace(/\s+/g, " ").trim(); }
function rankKey(r) { return `${r.isRelay ? "R" : "I"}|${r.stroke || ""}|${r.distance || ""}`; }
function rankLabelFromKey(k) { const p = k.split("|"); return `${p[1] || ""} ${p[2] ? p[2] + "m" : ""}`.replace(/\s+/g, " ").trim(); }
function recDists(r) {
  const n = (r.splits || []).length;
  if (Array.isArray(r.splitDists) && r.splitDists.length === n && r.splitDists.every((x) => typeof x === "number")) return r.splitDists;
  if (r.distance && r.poolLength && r.lapMode) { const p = lapPlan(r.poolLength, r.distance, r.lapMode); if (p && p.dists.length === n) return p.dists; }
  if (r.distance && n) { const step = r.distance / n; return Array.from({ length: n }, (_, i) => Math.round((i + 1) * step)); }
  return Array.from({ length: n }, (_, i) => i + 1);
}
function lapsOf(r) { const s = r.splits || []; return s.map((c, i) => c - (i ? s[i - 1] : 0)); }
// リレー：各泳者（区間）の合計タイム。距離の境界で累計を区切って差を取る。
function relayLegTimes(r) {
  if (!r.isRelay || !r.distance || !(r.legs || []).length) return null;
  const dists = recDists(r), splits = r.splits || [], legCount = r.legs.length, legDist = r.distance / legCount;
  const bounds = [];
  for (let k = 1; k <= legCount; k++) {
    const target = legDist * k;
    let idx = dists.findIndex((d) => Math.abs(d - target) < 0.5);
    if (idx === -1 && splits.length === legCount) idx = k - 1; // 各泳者1区切りで入力された場合
    bounds.push(idx >= 0 ? splits[idx] : null);
  }
  return bounds.map((c, k) => { const prev = k === 0 ? 0 : bounds[k - 1]; return (c != null && prev != null) ? c - prev : null; });
}
function relayGender(r) {
  const gs = (r.legs || []).map((l) => members[l.memberId]?.gender).filter(Boolean);
  if (!gs.length) return "混合";
  if (gs.every((g) => g === "男")) return "男子";
  if (gs.every((g) => g === "女")) return "女子";
  return "混合";
}
function sortRecs(list, mode) {
  if (mode === "time") list.sort((a, b) => (a.finalMs || 0) - (b.finalMs || 0));
  else list.sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || "") || (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}
function swimmerRecs(id) { return allRecs().filter((r) => !r.isRelay && r.memberId === id); }

function populateFilter() {
  const sel = $("#rec-filter"); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">— 選手を選択 —</option>` + memberList().map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年${m.retired ? "・引退" : ""}）</option>`).join("");
  sel.value = cur || recFilter || "";
}
function renderRecordsAll() {
  $$("#rec-mode button").forEach((b) => b.classList.toggle("on", b.dataset.rmode === recMode));
  $("#pane-indiv").hidden = recMode !== "indiv";
  $("#pane-relay").hidden = recMode !== "relay";
  $("#pane-ranking").hidden = recMode !== "ranking";
  if (recMode === "indiv") renderIndiv();
  else if (recMode === "relay") renderRelay();
  else renderRanking();
  if (analysisId) renderAnalysis();
}
function rerenderActiveList() {
  if (recMode === "indiv") renderIndiv();
  else if (recMode === "relay") renderRelay();
  else renderRanking();
}

// ── 個人 ──
function renderIndiv() {
  populateFilter();
  const id = recFilter;
  $("#indiv-body").hidden = !id;
  if (!id) return;
  $$("#indiv-subtab button").forEach((b) => b.classList.toggle("on", b.dataset.sub === indivSub));
  $("#sub-summary").hidden = indivSub !== "summary";
  $("#sub-event").hidden = indivSub !== "event";
  if (indivSub === "summary") renderSummary(id); else renderEventView(id);
}
function summaryRowHtml(r) {
  return `<div class="rec-card" data-open="${r.id}">
    <span class="rc-time">${fmt(r.finalMs)}</span><span class="rc-ev">${escapeHtml(evLabel(r))}${r.meetName ? ` ・🏆${escapeHtml(r.meetName)}` : ""}</span><span class="rc-date">${escapeHtml(r.dateISO || "")}</span></div>`;
}
function renderSummary(id) {
  const recs = swimmerRecs(id).sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || "") || (b.createdAt || 0) - (a.createdAt || 0));
  const recent = recs.slice(0, 5);
  $("#recent5").innerHTML = recent.length ? recent.map(summaryRowHtml).join("") : `<p class="empty">記録なし</p>`;
  const byEv = {};
  recs.filter((r) => r.stroke && r.distance).forEach((r) => { const k = evKey(r); if (!byEv[k] || r.finalMs < byEv[k].finalMs) byEv[k] = r; });
  const bests = Object.values(byEv).sort((a, b) => (a.stroke || "").localeCompare(b.stroke || "", "ja") || a.distance - b.distance);
  $("#bests").innerHTML = bests.length ? bests.map((r) => `<div class="rec-card" data-open="${r.id}"><span class="rc-time">${fmt(r.finalMs)}</span><span class="rc-ev">${escapeHtml(evLabel(r))}</span><span class="rc-date">${escapeHtml(r.dateISO || "")}</span></div>`).join("") : `<p class="empty">ベスト記録なし</p>`;
}
function renderEventView(id) {
  const recs = swimmerRecs(id).filter((r) => r.stroke && r.distance);
  const evs = [...new Set(recs.map(evKey))];
  const sel = $("#ev-filter");
  sel.innerHTML = evs.map((k) => `<option value="${k}">${escapeHtml(evLabelFromKey(k))}</option>`).join("");
  if (!evFilter || !evs.includes(evFilter)) evFilter = evs[0] || "";
  sel.value = evFilter;
  $$("#sort-seg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === sortMode));
  const list = recs.filter((r) => evKey(r) === evFilter);
  // A-3：理想タイム
  const it = idealTime(list);
  $("#ideal-card").innerHTML = it ? `<div class="ideal"><div><b>${fmt(it.ideal)}</b><span>理想（区間ベスト合算）</span></div><div><b>${fmt(it.bestFinal)}</b><span>自己ベスト</span></div><div class="gap"><b>-${fmt(it.gap)}</b><span>短縮の余地</span></div></div>` : "";
  // A-5：改善ペース
  const tr = trendInfo(list);
  $("#trend-note").innerHTML = tr ? `改善ペース：約 <b>${(Math.abs(tr.perMonth) / 1000).toFixed(2)}秒/月</b> ${tr.improving ? "短縮中 📉" : "悪化 📈"}　／　30日後の予測 <b>${fmt(Math.max(0, tr.proj))}</b>` : "";
  drawProgress(list);
  $("#overlay-toggle").checked = overlayOn;
  $("#overlay-wrap").hidden = !overlayOn;
  if (overlayOn) drawOverlay(list);
  sortRecs(list, sortMode);
  $("#event-list").innerHTML = list.length ? list.map(recordCardHtml).join("") : `<p class="empty">この種目の記録がありません。</p>`;
}

// ── リレー ──
function renderRelay() {
  let recs = allRecs().filter((r) => r.isRelay);
  const evs = [...new Set(recs.map(evKey))];
  const esel = $("#relay-event"); const ecur = esel.value;
  esel.innerHTML = `<option value="">全て</option>` + evs.map((k) => `<option value="${k}">${escapeHtml(evLabelFromKey(k))}</option>`).join("");
  esel.value = (relayEventF && evs.includes(relayEventF)) ? relayEventF : "";
  relayEventF = esel.value;
  $("#relay-gender").value = relayGenderF;
  if (relayGenderF) recs = recs.filter((r) => relayGender(r) === relayGenderF);
  if (relayEventF) recs = recs.filter((r) => evKey(r) === relayEventF);
  $$("#relay-sort-seg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === relaySort));
  sortRecs(recs, relaySort);
  $("#relay-list").innerHTML = recs.length ? recs.map(recordCardHtml).join("") : `<p class="empty">リレーの記録がありません。</p>`;
}

// ── ランキング ──
function renderRanking() {
  const recs = allRecs().filter((r) => r.stroke && r.distance);
  const evs = [...new Set(recs.map(rankKey))].sort((a, b) => a.localeCompare(b));
  const sel = $("#rank-event");
  sel.innerHTML = evs.map((k) => `<option value="${k}">${escapeHtml(rankLabelFromKey(k))}</option>`).join("");
  if (!rankEvent || !evs.includes(rankEvent)) rankEvent = evs[0] || "";
  sel.value = rankEvent;
  const all = recs.filter((r) => rankKey(r) === rankEvent);
  const fy = currentFiscalYear();
  $("#rank-year").innerHTML = rankTable(all.filter((r) => fiscalYear(r.dateISO) === fy), rankEvent);
  $("#rank-all").innerHTML = rankTable(all, rankEvent);
}
function rankTable(list, key) {
  if (!list.length) return `<p class="empty">記録なし</p>`;
  const isRelay = key.startsWith("R|");
  let entries;
  if (isRelay) {
    const byTeam = {};
    list.forEach((r) => { const tk = (r.legs || []).map((l) => l.memberId).join(",") + "|" + r.poolLength; if (!byTeam[tk] || r.finalMs < byTeam[tk].finalMs) byTeam[tk] = r; });
    entries = Object.values(byTeam);
  } else {
    const bySw = {};
    list.forEach((r) => { const k = (r.memberId || r.name) + "|" + r.poolLength; if (!bySw[k] || r.finalMs < bySw[k].finalMs) bySw[k] = r; });
    entries = Object.values(bySw);
  }
  entries.sort((a, b) => a.finalMs - b.finalMs);
  return entries.map((r, i) => {
    const nm = r.isRelay ? "🏊 " + escapeHtml((r.legs || []).map((l) => l.name).join("・")) : escapeHtml(r.name || "");
    return `<div class="rank-row" data-open="${r.id}">
    <span class="rk">${i + 1}</span>
    <span class="rk-name">${nm}（${courseLabel(r.poolLength)}）</span>
    <span class="rk-time">${fmt(r.finalMs)}</span><span class="rk-date">${escapeHtml(r.dateISO || "")}</span></div>`;
  }).join("");
}

// ── レースカード（一覧・タップで分析・編集/削除） ──
function recordCardHtml(r) {
  if (editingRecordId === r.id) return recordEditorHtml(r);
  const laps = lapsOf(r).map((l) => `<span class="chip">${fmt(l)}</span>`).join("");
  const who = r.isRelay ? "🏊 リレー" : escapeHtml(r.name || "");
  const lt = r.isRelay ? relayLegTimes(r) : null;
  const relayLegs = r.isRelay ? `<div class="r-legs">${(r.legs || []).map((l, i) => `<span class="leg">${i + 1}. ${escapeHtml(l.name)}${l.legStroke ? `（${escapeHtml(l.legStroke)}）` : ""}${lt && lt[i] != null ? ` <b>${fmt(lt[i])}</b>` : ""}</span>`).join("")}</div>` : "";
  return `<div class="record-row" data-rec="${r.id}">
    <div class="r-tap" data-open="${r.id}">
      <div class="r-head"><span class="r-final">${fmt(r.finalMs)}</span><span class="r-name">${who}</span><span class="r-meta">${escapeHtml(evLabel(r))}</span></div>
      <div class="r-sub">${r.meetName ? `🏆 ${escapeHtml(r.meetName)}・` : ""}${escapeHtml(r.dateISO || "")}${r.lane ? `・L${r.lane}` : ""}${r.school ? `・${escapeHtml(r.school)}` : ""}</div>
      ${relayLegs}<div class="r-laps">${laps}</div>
    </div>
    <div class="r-actions"><button class="ghost" data-open="${r.id}">📊 分析</button><button class="edit" data-redit="${r.id}">修正</button><button class="del" data-rdel="${r.id}">削除</button></div>
  </div>`;
}
function recordEditorHtml(r) {
  const splits = Array.isArray(r.splits) ? r.splits : [];
  const rows = splits.map((cum, i) => `<label class="te-row"><span>${i + 1}本目（累計）</span><input class="te" data-i="${i}" type="text" inputmode="decimal" value="${fmt(cum)}" /></label>`).join("");
  return `<div class="record-row editing" data-rec="${r.id}">
    <div class="r-head"><span class="r-name">${escapeHtml(r.name || "")}</span><span class="r-meta">${escapeHtml(r.dateISO || "")}</span></div>
    <div class="te-list">${rows}</div>
    <p class="te-hint">例：28.55 / 1:05.33（累計タイムを入力）</p>
    <div class="r-actions"><button class="save" data-rsave="${r.id}">保存</button><button class="ghost" data-rcancel="1">キャンセル</button></div>
  </div>`;
}
function saveRecordEdit(id) {
  const inputs = $$(`#screen-records [data-rec="${id}"] .te`);
  const splits = [];
  for (const inp of inputs) { const ms = parseTime(inp.value); if (ms == null) { alert("時間の形式が正しくありません（例：28.55 や 1:05.33）"); return; } splits.push(ms); }
  for (let i = 1; i < splits.length; i++) if (splits[i] <= splits[i - 1]) { alert("累計タイムは前の本数より大きくなる必要があります。"); return; }
  update(ref(db, `${RESULTS}/${id}`), { splits, finalMs: splits[splits.length - 1] });
  editingRecordId = null;
  rerenderActiveList();
}
function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  remove(ref(db, `${RESULTS}/${id}`));
  if (editingRecordId === id) editingRecordId = null;
  if (analysisId === id) { analysisId = null; $("#analysis").hidden = true; }
}

// ── レース分析 ──
function openAnalysis(id) { analysisId = id; renderAnalysis(); }
function renderAnalysis() {
  const r = results[analysisId];
  if (!r) { analysisId = null; $("#analysis").hidden = true; return; }
  $("#analysis").hidden = false;
  $("#ana-title").textContent = `${r.isRelay ? "リレー" : (r.name || "")}｜${evLabel(r)}｜${r.meetName ? r.meetName + "・" : ""}${r.dateISO || ""}`;
  const dists = recDists(r), laps = lapsOf(r), s = r.splits || [];
  let rows = s.map((c, i) => {
    const diff = i >= 1 ? laps[i] - laps[i - 1] : null;
    const ds = diff != null ? `<span class="dlap">（${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))}）</span>` : "";
    return `<div class="split-row"><span class="idx">${dists[i] ?? i + 1}${r.distance ? "m" : ""}</span><span class="cum">${fmt(c)}</span><span class="lap">${fmt(laps[i])} ${ds}</span></div>`;
  }).join("");
  $("#ana-splits").innerHTML = `<div class="cap"><span>距離</span><span>累計</span><span>ラップ（前との差）</span></div>` + rows;
  if (r.isRelay) {
    const lt = relayLegTimes(r);
    $("#ana-legs").innerHTML = `<div class="sec-title">選手ごとのタイム</div><div class="leg-times">` +
      (r.legs || []).map((l, i) => `<div class="lt-row"><span class="lt-pos">${i + 1}泳</span><span class="lt-name">${escapeHtml(l.name)}${l.legStroke ? `・${escapeHtml(l.legStroke)}` : ""}</span><span class="lt-time">${lt && lt[i] != null ? fmt(lt[i]) : "—"}</span></div>`).join("") + `</div>`;
  } else $("#ana-legs").innerHTML = "";
  drawLap(r);
  // A-1：前後半バランス
  const hs = halfSplit(r);
  $("#ana-balance").innerHTML = hs ? `<div class="metric-card"><span>前半 <b>${fmt(hs.first)}</b></span><span>後半 <b>${fmt(hs.second)}</b></span><span class="${hs.fade >= 0 ? "mc-bad" : "mc-good"}">${hs.fade >= 0 ? "後半失速" : "後半加速"} ${Math.abs(hs.fade).toFixed(1)}%</span></div>` : "";
  // B-6：ペース形状
  const canShape = !r.isRelay && lapsOf(r).length >= 2;
  $("#shape-sec").hidden = !canShape;
  if (canShape) { const peer = drawShape(r); $("#shape-note").textContent = peer ? "オレンジ＝同種目・同コースの上位平均。自分の線が上にある区間ほど、相対的に時間をかけています。" : "比較できる他の選手の記録がまだありません（自分の形のみ）。"; }
  else { chShape?.destroy(); chShape = null; }
  // B-7：区間ごとの差
  $("#deficit-sec").hidden = false;
  const okDef = !r.isRelay && drawDeficit(r);
  $("#deficit-sec").hidden = !okDef;
  if (okDef) $("#deficit-note").textContent = "棒が高い区間ほどチーム最速との差が大きい（赤＝最大の課題区間）。";
  $("#analysis").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── グラフ（Chart.js） ──
function chartOpts(yTitle) {
  return { responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: true, labels: { boxWidth: 12 } } },
    scales: { y: { title: { display: true, text: yTitle } }, x: { ticks: { maxRotation: 0, autoSkip: true } } } };
}
const PALETTE = ["#1577dd", "#ff7a1a", "#22a06b", "#9b59b6", "#d7263d", "#0e7490", "#e0a800"];
function drawProgress(recs) {
  if (!window.Chart) return;
  const data = recs.slice().sort((a, b) => (a.dateISO || "").localeCompare(b.dateISO || "") || (a.createdAt || 0) - (b.createdAt || 0));
  chProgress?.destroy(); chProgress = null;
  if (!data.length) return;
  const datasets = [{ label: "タイム(秒)", data: data.map((r) => +(r.finalMs / 1000).toFixed(2)), borderColor: "#1577dd", backgroundColor: "#1577dd22", tension: 0.2, pointRadius: 4, fill: true }];
  if (data.length >= 2) {
    const x0 = dateToNum(data[0].dateISO);
    const xs = data.map((r) => (dateToNum(r.dateISO) - x0) / 86400000);
    const { a, b } = linreg(xs, data.map((r) => r.finalMs));
    datasets.push({ label: "傾向", data: xs.map((x) => +((a + b * x) / 1000).toFixed(2)), borderColor: "#ff7a1a", borderDash: [6, 4], pointRadius: 0, fill: false, tension: 0 });
  }
  chProgress = new Chart($("#chart-progress"), { type: "line", data: { labels: data.map((r) => r.dateISO || ""), datasets }, options: chartOpts("秒（小さいほど速い）") });
}
function drawOverlay(recs) {
  if (!window.Chart) return;
  const data = recs.slice().sort((a, b) => (a.dateISO || "").localeCompare(b.dateISO || "") || (a.createdAt || 0) - (b.createdAt || 0)).slice(-6);
  chOverlay?.destroy(); chOverlay = null;
  if (!data.length) return;
  const base = data.reduce((a, r) => (recDists(r).length > recDists(a).length ? r : a), data[0]);
  const labels = recDists(base).map((d) => `${d}m`);
  const datasets = data.map((r, i) => ({ label: r.dateISO || `#${i + 1}`, data: lapsOf(r).map((ms) => +(ms / 1000).toFixed(2)), borderColor: PALETTE[i % PALETTE.length], backgroundColor: "transparent", tension: 0.2, pointRadius: 3, fill: false }));
  chOverlay = new Chart($("#chart-overlay"), { type: "line", data: { labels, datasets }, options: chartOpts("各ラップ秒（小さいほど速い）") });
}
function drawLap(r) {
  if (!window.Chart) return;
  const dists = recDists(r), laps = lapsOf(r).map((ms) => +(ms / 1000).toFixed(2));
  const mx = Math.max(...laps);
  chLap?.destroy(); chLap = null;
  chLap = new Chart($("#chart-lap"), {
    type: "bar",
    data: { labels: dists.map((d) => `${d}${r.distance ? "m" : ""}`), datasets: [{ label: "各ラップ(秒)", data: laps, backgroundColor: laps.map((v) => v === mx ? "#d7263d" : "#1577dd") }] },
    options: chartOpts("各ラップ秒（小さいほど速い／赤＝最も遅い）")
  });
}

// ── 分析ユーティリティ ──
function dateToNum(d) { if (!d) return null; const t = Date.parse(d + "T00:00:00"); return isNaN(t) ? null : t; }
function linreg(xs, ys) {
  const n = xs.length, sx = xs.reduce((s, v) => s + v, 0), sy = ys.reduce((s, v) => s + v, 0);
  const sxx = xs.reduce((s, v) => s + v * v, 0), sxy = xs.reduce((s, v, i) => s + v * ys[i], 0);
  const den = (n * sxx - sx * sx) || 1, b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
  return { a, b };
}
// A-1：前後半バランス
function halfSplit(r) {
  const dists = recDists(r), laps = lapsOf(r);
  if (laps.length < 2 || !r.distance) return null;
  const half = r.distance / 2; let first = 0, second = 0;
  for (let i = 0; i < laps.length; i++) (dists[i] <= half + 0.5 ? first += laps[i] : second += laps[i]);
  if (first <= 0 || second <= 0) return null;
  return { first, second, fade: (second - first) / first * 100 };
}
// A-3：理想タイム（区間ベスト合算）。recs はその選手・その種目の記録群。
function idealTime(recs) {
  if (!recs.length) return null;
  let canon = recs[0];
  recs.forEach((r) => { if ((r.splits || []).length > (canon.splits || []).length) canon = r; });
  const cd = recDists(canon);
  if (cd.length < 2) return null;
  let ideal = 0;
  for (const d of cd) {
    let best = Infinity;
    recs.forEach((r) => { const rd = recDists(r), lp = lapsOf(r); const idx = rd.findIndex((x) => Math.abs(x - d) < 0.5); if (idx >= 0) best = Math.min(best, lp[idx]); });
    if (best === Infinity) return null;
    ideal += best;
  }
  const bestFinal = Math.min(...recs.map((r) => r.finalMs));
  return { ideal, bestFinal, gap: Math.max(0, bestFinal - ideal) };
}
// A-5：傾向（直線回帰）。{perMonth, proj, improving}
function trendInfo(recs) {
  const pts = recs.map((r) => ({ t: dateToNum(r.dateISO), y: r.finalMs })).filter((p) => p.t != null).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const x0 = pts[0].t, xs = pts.map((p) => (p.t - x0) / 86400000), ys = pts.map((p) => p.y);
  const { a, b } = linreg(xs, ys);
  return { a, b, perMonth: b * 30, proj: a + b * (xs[xs.length - 1] + 30), improving: b < 0 };
}
// 同一種目・同コースの個人記録
function sameEventRecs(r) { return allRecs().filter((x) => !x.isRelay && x.stroke === r.stroke && x.distance === r.distance && x.poolLength === r.poolLength); }
function sameLayout(x, dists) { const xd = recDists(x); if (xd.length !== dists.length) return false; for (let i = 0; i < dists.length; i++) if (Math.abs(xd[i] - dists[i]) > 0.5) return false; return true; }
// B-6：ペース形状（自分 vs 他の上位平均、各区間が総タイムに占める割合）
function drawShape(r) {
  if (!window.Chart) return false;
  const laps = lapsOf(r); if (laps.length < 2 || !r.finalMs) return false;
  const myDists = recDists(r), myId = r.memberId || r.name;
  const mine = laps.map((l) => +(l / r.finalMs * 100).toFixed(1));
  const bySw = {};
  sameEventRecs(r).forEach((x) => { if (!sameLayout(x, myDists)) return; const id = x.memberId || x.name; if (id === myId) return; if (!bySw[id] || x.finalMs < bySw[id].finalMs) bySw[id] = x; });
  const top = Object.values(bySw).sort((a, b) => a.finalMs - b.finalMs).slice(0, 3);
  const datasets = [{ label: "自分", data: mine, borderColor: "#1577dd", backgroundColor: "transparent", tension: 0.2, pointRadius: 3, fill: false }];
  if (top.length) {
    const avg = myDists.map((_, i) => { let s = 0, c = 0; top.forEach((x) => { const lp = lapsOf(x); if (lp[i] != null && x.finalMs) { s += lp[i] / x.finalMs * 100; c++; } }); return c ? +(s / c).toFixed(1) : null; });
    datasets.push({ label: `上位平均(${top.length}人)`, data: avg, borderColor: "#ff7a1a", backgroundColor: "transparent", borderDash: [6, 4], tension: 0.2, pointRadius: 3, fill: false });
  }
  chShape?.destroy();
  chShape = new Chart($("#chart-shape"), { type: "line", data: { labels: myDists.map((d) => `${d}m`), datasets }, options: chartOpts("各区間が占める割合(%)") });
  return top.length > 0;
}
// B-7：区間ごとの差（他の選手の最速ラップ比、%）
function drawDeficit(r) {
  if (!window.Chart) return false;
  const myDists = recDists(r), myLaps = lapsOf(r), myId = r.memberId || r.name;
  if (myLaps.length < 2) return false;
  const peers = sameEventRecs(r).filter((x) => sameLayout(x, myDists) && (x.memberId || x.name) !== myId);
  if (peers.length < 1) return false;
  const best = myDists.map((_, i) => { let b = Infinity; peers.forEach((x) => { const lp = lapsOf(x); if (lp[i] != null) b = Math.min(b, lp[i]); }); return b === Infinity ? null : b; });
  if (best.every((v) => v == null)) return false;
  const def = myLaps.map((l, i) => best[i] != null ? +(((l - best[i]) / best[i]) * 100).toFixed(1) : 0);
  const mx = Math.max(...def);
  chDeficit?.destroy();
  chDeficit = new Chart($("#chart-deficit"), { type: "bar", data: { labels: myDists.map((d) => `${d}m`), datasets: [{ label: "他の最速比(%)", data: def, backgroundColor: def.map((v) => v === mx && mx > 0 ? "#d7263d" : "#1577dd") }] }, options: chartOpts("他の選手の最速より何%遅いか（赤＝最大）") });
  return true;
}

// ── 記録の手動追加（大会・過去記録／個人・リレー／柔軟なラップ） ──
const INDIV_STROKES = ["自由形", "平泳ぎ", "背泳ぎ", "バタフライ", "個人メドレー"];
const RELAY_STROKES = ["フリーリレー", "メドレーリレー"];
function lapRowHtml(dist = "", time = "") {
  return `<div class="lap-in"><input class="ld" inputmode="numeric" placeholder="距離m" value="${dist}"><input class="lt" inputmode="decimal" placeholder="通過 例 28.55" value="${time}"><button class="lap-del" type="button">✕</button></div>`;
}
function manualStrokeChanged() {
  const stroke = $("#manual-stroke").value, d = $("#manual-dist");
  if (!stroke) { $("#manual-dist-field").hidden = true; d.innerHTML = ""; return; }
  d.innerHTML = (EVENTS[stroke] || []).map((x) => `<option value="${x}">${x}m</option>`).join("");
  $("#manual-dist-field").hidden = false;
}
function buildManualLegs() {
  const medley = $("#manual-stroke").value === "メドレーリレー";
  let html = "";
  for (let i = 0; i < 4; i++) {
    html += `<div class="leg-row"><span class="leg-label">${i + 1}泳者${medley ? `・${MEDLEY_ORDER[i]}` : ""}</span><select class="leg-pick" data-leg="${i}"><option value="">— 選択 —</option>${memberOptions("")}</select></div>`;
  }
  $("#manual-legs").innerHTML = html;
}
function renderManualForm() {
  $$("#manual-kind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === manualKind));
  const relay = manualKind === "relay";
  $("#manual-single").hidden = relay;
  $("#manual-name-field").hidden = relay || $("#manual-swimmer").value !== "__name";
  $("#manual-relay").hidden = !relay;
  const strokes = relay ? RELAY_STROKES : INDIV_STROKES;
  $("#manual-stroke").innerHTML = (relay ? "" : `<option value="">自由計測</option>`) + strokes.map((s) => `<option value="${s}">${s}</option>`).join("");
  manualStrokeChanged();
  if (relay) buildManualLegs();
}
function openManual() {
  manualKind = "indiv";
  $("#manual-date").value = todayISO();
  $("#manual-meet").value = "";
  $$("#manual-course button").forEach((b) => b.classList.toggle("on", b.dataset.pool === "50"));
  $("#manual-swimmer").innerHTML = `<option value="">— 選手を選択 —</option>` + memberOptions("") + `<option value="__name">（名前を直接入力）</option>`;
  $("#manual-name").value = "";
  $("#manual-laps").innerHTML = lapRowHtml("", "");
  renderManualForm();
  show("screen-manual");
}
function manualQuickFill(q) {
  const dist = Number($("#manual-dist").value) || 0;
  if (q === "goal") { $("#manual-laps").innerHTML = lapRowHtml(dist || "", ""); return; }
  if (!dist) { alert("先に種目と距離を選んでください。"); return; }
  const step = Number(q), ds = [];
  for (let d = step; d < dist; d += step) ds.push(d);
  ds.push(dist);
  $("#manual-laps").innerHTML = ds.map((d) => lapRowHtml(d, "")).join("");
}
function saveManual() {
  const dateISO = $("#manual-date").value;
  if (!dateISO) { alert("日付を入力してください。"); return; }
  const meetName = $("#manual-meet").value.trim();
  const poolLength = Number($("#manual-course button.on")?.dataset.pool || 25);
  const stroke = $("#manual-stroke").value;
  const distance = stroke ? Number($("#manual-dist").value) : null;
  const splits = [], dists = []; let allDist = true;
  for (const row of $$("#manual-laps .lap-in")) {
    const t = row.querySelector(".lt").value.trim();
    if (!t) continue;
    const ms = parseTime(t);
    if (ms == null) { alert("通過タイムの形式が正しくありません（例：28.55 や 1:05.33）"); return; }
    splits.push(ms);
    const dv = row.querySelector(".ld").value.trim();
    if (dv) dists.push(Number(dv)); else allDist = false;
  }
  if (!splits.length) { alert("少なくとも1つのタイムを入力してください。"); return; }
  for (let i = 1; i < splits.length; i++) if (splits[i] <= splits[i - 1]) { alert("通過タイム（累計）は本数が進むごとに大きくなる必要があります。"); return; }
  const rec = { dateISO, poolLength, lapMode: null, stroke: stroke || "", distance, splits, finalMs: splits[splits.length - 1], manual: true, createdAt: serverTimestamp() };
  if (meetName) rec.meetName = meetName;
  if (allDist && dists.length === splits.length) rec.splitDists = dists;
  if (manualKind === "relay") {
    const legs = $$("#manual-legs .leg-pick").map((s, i) => {
      if (!s.value || !members[s.value]) return null;
      const m = members[s.value];
      return { memberId: s.value, name: m.name, school: m.school || "", legStroke: stroke === "メドレーリレー" ? MEDLEY_ORDER[i] : "自由形" };
    }).filter(Boolean);
    if (!legs.length) { alert("泳者を1人以上選んでください。"); return; }
    rec.isRelay = true; rec.legs = legs; rec.name = legs.map((l) => l.name).join("→"); rec.school = legs[0].school || "";
  } else {
    const sv = $("#manual-swimmer").value;
    if (sv === "__name") { const nm = $("#manual-name").value.trim(); if (!nm) { alert("選手名を入力してください。"); return; } rec.name = nm; rec.school = ""; }
    else { if (!sv || !members[sv]) { alert("選手を選んでください（未登録ならメンバー登録から追加）。"); return; } const m = members[sv]; rec.memberId = sv; rec.name = m.name; rec.school = m.school || ""; }
  }
  set(push(ref(db, RESULTS)), rec);
  alert("保存しました。");
  recMode = manualKind === "relay" ? "relay" : "indiv";
  if (manualKind !== "relay" && rec.memberId) { recFilter = rec.memberId; indivSub = "summary"; }
  show("screen-records"); renderRecordsAll();
}

// ── 記録者：レーン＋選手＋種目（編集可・端末間リンク） ─────
const MEDLEY_ORDER = ["背泳ぎ", "平泳ぎ", "バタフライ", "自由形"];
const isRelayStroke = (s) => s === "フリーリレー" || s === "メドレーリレー";

function resetRecorderSetup() {
  myLane = null;
  $$(".lane-opt").forEach((x) => x.classList.remove("sel"));
  $("#assign-area").hidden = true;
  $("#setup-hint").hidden = true;
  $("#btn-join").disabled = true;
}
function memberOptions(selId) {
  return memberList().filter((m) => !m.retired || m.id === selId).map((m) =>
    `<option value="${m.id}"${m.id === selId ? " selected" : ""}>${escapeHtml(m.name)}（${m.grade}年${m.guest ? "・ゲスト" : ""}${m.retired ? "・引退" : ""}）</option>`).join("");
}
function populatePicker(selId) {
  const sel = $("#swimmer-pick"); if (!sel) return;
  const cur = selId !== undefined ? selId : sel.value;
  sel.innerHTML = `<option value="">— 選手を選択 —</option>` + memberOptions(cur || "");
  if (cur) sel.value = cur;
}
function populateDistances(distVal) {
  const stroke = $("#ev-stroke").value, dsel = $("#ev-dist");
  if (!stroke) { $("#dist-field").hidden = true; dsel.innerHTML = ""; return; }
  dsel.innerHTML = (EVENTS[stroke] || []).map((d) => `<option value="${d}">${d}m</option>`).join("");
  $("#dist-field").hidden = false;
  if (distVal) dsel.value = String(distVal);
}
function buildRelayLegs(stroke, laneData) {
  const medley = stroke === "メドレーリレー";
  let html = "";
  for (let i = 0; i < 4; i++) {
    const sel = laneData?.legs?.[i]?.memberId || "";
    html += `<div class="leg-row"><span class="leg-label">${i + 1}泳者${medley ? `・${MEDLEY_ORDER[i]}` : ""}</span>
      <select class="leg-pick" data-leg="${i}"><option value="">— 選択 —</option>${memberOptions(sel)}</select></div>`;
  }
  $("#relay-legs").innerHTML = html;
}
function applyStrokeMode(laneData) {
  const stroke = $("#ev-stroke").value;
  const relay = isRelayStroke(stroke);
  $("#single-swimmer-field").hidden = relay;
  $("#relay-legs").hidden = !relay;
  if (relay) buildRelayLegs(stroke, laneData);
  else populatePicker(laneData?.memberId || "");
  updateJoinEnabled();
}
function updateJoinEnabled() {
  const stroke = $("#ev-stroke").value;
  const ok = isRelayStroke(stroke)
    ? $$("#relay-legs .leg-pick").some((s) => s.value)
    : !!$("#swimmer-pick").value;
  $("#btn-join").disabled = !ok;
}
// レーンを選ぶと、既存の割り当てを読み込んで「編集可能」な状態で表示（どの端末でも同じ内容にリンク）
function onLaneChosen(lane) {
  myLane = lane;
  const a = race?.lanes?.[lane] || null;
  $("#assign-area").hidden = false;
  $("#setup-hint").hidden = memberList().length !== 0;
  $("#ev-stroke").value = a?.stroke || "";
  populateDistances(a?.distance);
  applyStrokeMode(a);
}
function joinLane() {
  if (!myLane) return;
  if (!race || (race.state !== "ready" && race.state !== "running")) {
    alert("スターターが画面を開くまでお待ちください。"); return;
  }
  ensureAudio();
  ringHere = $("#ring-here").checked;
  const stroke = $("#ev-stroke").value;
  const distance = stroke ? Number($("#ev-dist").value) : null;
  let laneData;
  if (isRelayStroke(stroke)) {
    const legs = $$("#relay-legs .leg-pick").map((s, i) => {
      if (!s.value || !members[s.value]) return null;
      const m = members[s.value];
      return { memberId: s.value, name: m.name, school: m.school || "", legStroke: stroke === "メドレーリレー" ? MEDLEY_ORDER[i] : "自由形" };
    }).filter(Boolean);
    if (!legs.length) return;
    laneData = { isRelay: true, name: legs.map((l) => l.name).join("→"), school: legs[0].school || "", stroke, distance, legs, memberId: null };
  } else {
    const id = $("#swimmer-pick").value;
    if (!id || !members[id]) return;
    const m = members[id];
    laneData = { memberId: id, name: m.name, school: m.school || "", stroke: stroke || null, distance, isRelay: null, legs: null };
  }
  update(ref(db, `${RACE}/lanes/${myLane}`), laneData);
  $("#rec-lane-label").textContent = `レーン ${myLane}`;
  lastBeepRaceId = null;
  joinedRaceId = race.raceId;
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
  } else if (role === "recorder" && race?.state !== "ended") {
    $("#rec-clock").textContent = "0.00";
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── イベント結線 ───────────────────────────────────────
$$(".role-btn").forEach((b) => b.addEventListener("click", () => {
  role = b.dataset.role;
  if (role === "starter") { ensureReady(); syncStarterControls(); show("screen-starter"); onRaceChanged(); }
  else { resetRecorderSetup(); show("screen-recorder-setup"); }
}));

$$("[data-go]").forEach((b) => b.addEventListener("click", async () => {
  const t = b.dataset.go;
  if (!(await requireUnlock())) return;  // バックオフィスはパスワード
  role = null; myLane = null;
  if (t === "members") { renderMembers(); show("screen-members"); }
  if (t === "records") { renderRecordsAll(); show("screen-records"); }
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
  setConfig();
});
$("#lap-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  lapMode = btn.dataset.lap;
  $$("#lap-seg button").forEach((x) => x.classList.toggle("on", x === btn));
  setConfig();
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

$("#btn-start").addEventListener("click", start);
$("#btn-end").addEventListener("click", endRace);
$("#btn-reset").addEventListener("click", resetRace);
$("#btn-next").addEventListener("click", nextRace);
$("#btn-rec-delete").addEventListener("click", deleteMyResult);
$("#btn-rec-back").addEventListener("click", () => { resetRecorderSetup(); show("screen-recorder-setup"); });
$("#mode-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  mode = b.dataset.mode;
  $$("#mode-seg button").forEach((x) => x.classList.toggle("on", x === b));
  $("#mode-note").hidden = mode !== "meet";
  setConfig();
});

$("#lane-pick").innerHTML = [1, 2, 3, 4, 5, 6].map((n) => `<button class="lane-opt" data-lane="${n}">${n}</button>`).join("");
$("#lane-pick").addEventListener("click", (e) => {
  const b = e.target.closest(".lane-opt"); if (!b) return;
  $$(".lane-opt").forEach((x) => x.classList.toggle("sel", x === b));
  onLaneChosen(Number(b.dataset.lane));
});
$("#swimmer-pick").addEventListener("change", updateJoinEnabled);
$("#ev-stroke").addEventListener("change", () => { populateDistances(); applyStrokeMode(null); });
$("#relay-legs").addEventListener("change", updateJoinEnabled);
$("#btn-join").addEventListener("click", joinLane);
$("#btn-split").addEventListener("click", recordSplit);

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
  const rt = e.target.closest("[data-retire]"); if (rt) return toggleRetire(rt.dataset.retire);
  const de = e.target.closest("[data-del]"); if (de) return deleteMember(de.dataset.del);
});
$("#show-retired").addEventListener("change", (e) => { showRetired = e.target.checked; renderMembers(); });

// 記録
$("#rec-mode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; recMode = b.dataset.rmode; analysisId = null; $("#analysis").hidden = true; renderRecordsAll(); });
$("#rec-filter").addEventListener("change", (e) => { recFilter = e.target.value; editingRecordId = null; analysisId = null; $("#analysis").hidden = true; indivSub = "summary"; evFilter = ""; renderIndiv(); });
$("#indiv-subtab").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; indivSub = b.dataset.sub; analysisId = null; $("#analysis").hidden = true; renderIndiv(); });
$("#ev-filter").addEventListener("change", (e) => { evFilter = e.target.value; renderEventView(recFilter); });
$("#sort-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; sortMode = b.dataset.sort; renderEventView(recFilter); });
$("#overlay-toggle").addEventListener("change", (e) => { overlayOn = e.target.checked; renderEventView(recFilter); });
$("#relay-gender").addEventListener("change", (e) => { relayGenderF = e.target.value; renderRelay(); });
$("#relay-event").addEventListener("change", (e) => { relayEventF = e.target.value; renderRelay(); });
$("#relay-sort-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; relaySort = b.dataset.sort; renderRelay(); });
$("#rank-event").addEventListener("change", (e) => { rankEvent = e.target.value; renderRanking(); });
$("#ana-close").addEventListener("click", () => { analysisId = null; $("#analysis").hidden = true; });
$("#screen-records").addEventListener("click", (e) => {
  const red = e.target.closest("[data-redit]"); if (red) { editingRecordId = red.dataset.redit; rerenderActiveList(); return; }
  const sv = e.target.closest("[data-rsave]"); if (sv) { saveRecordEdit(sv.dataset.rsave); return; }
  const cc = e.target.closest("[data-rcancel]"); if (cc) { editingRecordId = null; rerenderActiveList(); return; }
  const de = e.target.closest("[data-rdel]"); if (de) { deleteRecord(de.dataset.rdel); return; }
  const op = e.target.closest("[data-open]"); if (op) { openAnalysis(op.dataset.open); return; }
});

// 記録の手動追加
$("#btn-manual").addEventListener("click", openManual);
$$("[data-back-manual]").forEach((b) => b.addEventListener("click", () => { show("screen-records"); renderRecordsAll(); }));
$("#manual-kind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; manualKind = b.dataset.kind; renderManualForm(); });
$("#manual-course").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; $$("#manual-course button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#manual-stroke").addEventListener("change", () => { manualStrokeChanged(); if (manualKind === "relay") buildManualLegs(); });
$("#manual-swimmer").addEventListener("change", () => { $("#manual-name-field").hidden = $("#manual-swimmer").value !== "__name"; });
$("#manual-laps").addEventListener("click", (e) => { const d = e.target.closest(".lap-del"); if (d) d.closest(".lap-in").remove(); });
$("#btn-add-lap").addEventListener("click", () => { $("#manual-laps").insertAdjacentHTML("beforeend", lapRowHtml("", "")); });
document.querySelector(".lap-quick").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; manualQuickFill(b.dataset.q); });
$("#btn-save-manual").addEventListener("click", saveManual);

show("screen-role");
