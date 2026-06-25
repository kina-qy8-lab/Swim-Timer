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
const MEETS    = "meets";
const TRAINING = "trainingResults";
const DAILYMENUS = "dailyMenus";
const OWN_SCHOOL = "鎌倉高校";

// 練習メニューの選択肢
const MENU_TYPES  = ["W-up", "Kick", "Pull", "Swim", "Down", "Drill"];
const MENU_STYLES = ["Cho", "Fr", "Fly", "Ba", "Br", "IM", "S1"];
const MENU_NOMEAS = ["W-up", "Down", "Drill"];  // 既定で計測しない分類

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
let timingMeetId = null;   // 記録会の計測対象（nullなら練習）
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
let showRetiredRec = false;
let relayGenderF = "";
let relayEventF = "";
let relayYearF = null;
let relaySort = "date";
let rankEvent = "";
let analysisId = null;
let manualKind = "indiv";
let dailyMenus = {};          // dailyMenus[dateISO] = { dateISO, updatedAt, items:{...} }
let mbDate = null;            // メニュー作成画面の対象日
let mbEditingId = null;       // 編集中の行ID（新規は null）
let mbFilled = false;         // サークルselectの初期化済みフラグ
let chProgress = null, chOverlay = null, chLap = null, chShape = null, chDeficit = null;
let chTrRep = null, chTrTrend = null, chTrSeg = null, chTrSetRep = null, chTrSetAvg = null;
let training = {};
let trFilter = "", trDate = "", trMenuId = null, trCalYM = null;
let viewPassHash = null;
let ending = false;
let joinedRaceId = null;
let recFinished = false, finishedResult = null, finishedSaved = false;
// 記録会（フェーズ1）
let meets = {};
let currentMeetId = null;
let entryKind = "indiv";       // indiv | relay
let newMeetSchools = [];
let newMeetHasOther = false;
let meetPoolNew = 50;
let showGuests = false;
let meetRestricted = false;   // エントリー＋プログラムのみの制限ビュー
let guestLink = false;        // 他校用リンクから入った
let pendingEntrySwimmer = null;
let meetsLoaded = false;
let draftProgram = null;       // 編集中のプログラム下書き
let programEditMode = false;
let editSel = null;            // 入れ替え選択中のレーン {ridx, lane}
let programTab = "program";    // program | results

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
// メニュー表用：先頭の0時を省いて詰める（8:00 / 22:30 / 1:05:00）
function fmtHMS(ms) {
  let sec = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
              : `${m}:${String(s).padStart(2, "0")}`;
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
onValue(ref(db, MEMBERS), (s) => {
  members = s.val() || {};
  if (!$("#screen-members").hidden) renderMembers();
  populatePicker(); populateFilter();
  if (!$("#screen-entry").hidden) { refreshEntrySwimmers(); refreshRelayLegs(); }
});
onValue(ref(db, RESULTS), (s) => { results = s.val() || {}; if (!$("#screen-records").hidden) renderRecordsAll(); });
onValue(ref(db, TRAINING), (s) => { training = s.val() || {}; if (!$("#screen-records").hidden && recMode === "practice") renderTraining(); });
onValue(ref(db, DAILYMENUS), (s) => { dailyMenus = s.val() || {}; if (!$("#screen-menu-builder").hidden) renderMenuBuilder(); if (!$("#screen-practice-menu").hidden) renderMenuPick(); });
onValue(ref(db, MEETS), (s) => {
  meets = s.val() || {};
  meetsLoaded = true;
  if (!$("#screen-meets").hidden) renderMeets();
  if (!$("#screen-meet").hidden) renderMeet();
  if (!$("#screen-entry").hidden) renderEntryList();
  if (!$("#screen-program").hidden) renderProgram();
  if (!$("#screen-meet-public").hidden) renderMeetPublic();
});
onValue(ref(db, `${SETTINGS}/viewPassHash`), (s) => { viewPassHash = s.val() || null; });

// ── スターター操作 ─────────────────────────────────────
let pool = 25, lapMode = "both", mode = "practice";

// 非計測時は常に ready（準備）状態。スターター画面に入ったら ready を保証。
function ensureReady() {
  if (race && race.state === "running") return;
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
  const meetMode = !!timingMeetId;
  $("#pool-row").hidden = meetMode;
  $("#starter-meet").hidden = !meetMode;
  $$("#pool-seg button").forEach((x) => x.classList.toggle("on", Number(x.dataset.pool) === pool));
  $$("#lap-seg button").forEach((x) => x.classList.toggle("on", x.dataset.lap === lapMode));
  if (meetMode) populateStarterMeet();
}
function isMeetMode() { return !!(race && race.mode === "meet" && race.meetId); }
function inMeetTiming() { return !!timingMeetId || isMeetMode(); }
function meetProgramRaces(meetId) { const m = meets[meetId]; if (!m || !m.program) return []; return (Array.isArray(m.program.races) ? m.program.races : Object.values(m.program.races)).filter(Boolean); }
function populateStarterMeet() {
  const m = meets[timingMeetId];
  $("#sm-meet-name").textContent = m ? `${m.name}（${m.poolLength === 50 ? "長水路" : "短水路"}）` : "";
  populateStarterRaces();
}
function populateStarterRaces() {
  const sel = $("#sm-race"); if (!sel) return;
  const races = meetProgramRaces(timingMeetId);
  const cur = sel.value;
  sel.innerHTML = races.length ? races.map((r, i) => `<option value="${i}">第${r.raceNo}レース　${r.distance}m ${escapeHtml(r.label)}</option>`).join("") : `<option value="">（プログラムなし）</option>`;
  if (cur && races[Number(cur)]) sel.value = cur;
}
function loadMeetRace() {
  const meetId = timingMeetId, m = meets[meetId];
  if (!m || !m.program) { alert("プログラムがありません。"); return; }
  const races = meetProgramRaces(meetId), r = races[Number($("#sm-race").value)];
  if (!r) { alert("レースを選んでください。"); return; }
  const lanes = {};
  for (let L = 1; L <= 6; L++) {
    const e = r.lanes && r.lanes[L];
    if (e) lanes[L] = { memberId: e.memberId || null, name: e.name || "", school: e.school || "", stroke: e.stroke, distance: e.distance, isRelay: !!e.isRelay, legs: e.legs || null, entryId: e.entryId || null, done: false };
  }
  pool = m.poolLength || 50;
  set(ref(db, RACE), { state: "ready", raceId: "r" + Date.now().toString(36), poolLength: pool, lapMode, mode: "meet", meetId, meetRaceNo: r.raceNo, startServerTime: null, lanes });
  toast(`第${r.raceNo}レースをレーンにセットしました`);
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
  if (race.meetId) {
    base.meetId = race.meetId; base.meetRaceNo = race.meetRaceNo || null; base.entryId = lane.entryId || null;
    base.meetName = (meets[race.meetId] && meets[race.meetId].name) || null;
  }
  if (lane.isRelay) return { ...base, isRelay: true, name: lane.name || "リレー", school: lane.school || "", legs: lane.legs || [] };
  return { ...base, memberId: lane.memberId || null, name: lane.name, school: lane.school || "" };
}
// 終了：レースを片付けて準備状態へ（保存は各記録者が手動で行う）
function endRace() {
  if (!race || ending) return;
  ending = true;
  set(ref(db, RACE), freshReady());
  setTimeout(() => { ending = false; }, 1200);
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
function saveResult() { /* 廃止 */ }

// ── ゴール後の完了表示（手動保存） ──
function captureFinish() {
  if (recFinished) return;
  const lane = race?.lanes?.[myLane];
  if (!lane) return;
  finishedResult = buildResult(myLane, lane);   // この時点でスナップショット（以後セッションが変わっても保持）
  finishedSaved = false;
  recFinished = true;
  renderFinished();
}
function renderFinished() {
  const r = finishedResult; if (!r) return;
  $("#rec-status").textContent = "計測完了";
  $("#rec-status").classList.remove("live");
  $("#rec-swimmer").textContent = r.isRelay ? "🏊 リレー" : (r.name || "—");
  $("#rec-event").textContent = r.stroke ? `${r.stroke} ${r.distance}m` : "自由計測";
  $("#rec-clock").textContent = fmt(r.finalMs);
  $("#btn-split").hidden = true;
  // 通過タイム表
  const dists = recDists(r), s = r.splits || [];
  let html = `<div class="cap"><span>距離</span><span>累計</span><span>ラップ</span></div>`;
  s.forEach((c, i) => {
    const lap = c - (i ? s[i - 1] : 0);
    const isGoal = i === s.length - 1;
    html += `<div class="split-row${isGoal ? " final" : ""}"><span class="idx">${dists[i] ?? i + 1}m</span><span class="cum">${fmt(c)}</span><span class="lap">${fmt(lap)}</span></div>`;
  });
  $("#splits").innerHTML = html;
  $("#rec-review").hidden = false;
  $("#screen-recorder .back").hidden = true;
  $("#btn-rec-save").disabled = finishedSaved;
  $("#rec-review .review-msg").textContent = finishedSaved ? "✓ 保存しました" : "ゴール！　保存するか、次の記録へ進んでください";
}
function saveFinished() {
  if (!finishedResult || finishedSaved) return;
  set(push(ref(db, RESULTS)), finishedResult);
  const ind = firstLegIndividual(finishedResult);
  if (ind) set(push(ref(db, RESULTS)), ind);
  if (finishedResult.meetId && finishedResult.entryId) {
    set(ref(db, `${MEETS}/${finishedResult.meetId}/results/${finishedResult.entryId}`), {
      finalMs: finishedResult.finalMs, splits: finishedResult.splits || [], lane: finishedResult.lane || null,
      raceNo: finishedResult.meetRaceNo || null, stroke: finishedResult.stroke, distance: finishedResult.distance,
      name: finishedResult.name, school: finishedResult.school || "", isRelay: !!finishedResult.isRelay,
      memberId: finishedResult.memberId || null, legs: finishedResult.legs || null, savedAt: serverTimestamp()
    });
  }
  finishedSaved = true;
  $("#btn-rec-save").disabled = true;
  $("#rec-review .review-msg").textContent = finishedResult.meetId ? "✓ 保存しました（プログラムに反映）" : (ind ? "✓ 保存しました（第1泳者の個人記録も追加）" : "✓ 保存しました");
}
function nextRecord() {
  if (!finishedSaved) { $("#unsaved-modal").hidden = false; return; }
  leaveFinished();
}
function leaveFinished() {
  recFinished = false; finishedResult = null; finishedSaved = false;
  $("#unsaved-modal").hidden = true;
  $("#rec-review").hidden = true;
  $("#btn-split").hidden = false;
  resetRecorderSetup();
  show("screen-recorder-setup");
}

// ── 画面更新（レース） ─────────────────────────────────
function onRaceChanged() {
  if (role === "starter") {
    const running = race?.state === "running";
    $("#starter-state").textContent = running ? "計測中" : "準備OK（記録者を待機）";
    $("#starter-config").hidden = running;
    $("#btn-start").hidden = running;
    $("#running-actions").hidden = !running;
    $("#starter-clock").hidden = !running;
    $("#starter-hint").hidden = running;
    renderStarterLanes();
  }

  if (role === "recorder" && !$("#screen-recorder").hidden) {
    if (recFinished) { return; }            // 完了表示中はレースの変化で画面遷移しない
    if (!race || race.raceId !== joinedRaceId) {
      resetRecorderSetup(); show("screen-recorder-setup"); return;
    }
    const running = race.state === "running";
    const statusEl = $("#rec-status");
    statusEl.textContent = running ? "計測中" : "まもなくスタート（合図を待つ）";
    statusEl.classList.toggle("live", running);
    const lane = race.lanes?.[myLane];
    $("#rec-swimmer").textContent = lane?.name || "—";
    $("#rec-event").textContent = lane?.stroke ? `${lane.stroke} ${lane.distance}m` : "自由計測";
    renderSplits();
    updateSplitButton();
    const plan = currentPlan();
    if (running && plan && laneSplitsArr(myLane).length >= plan.count) captureFinish();
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
  if (showGuests) {
    list = list.filter((m) => m.guest);
  } else {
    list = list.filter((m) => !m.guest);
    if (!showRetired) list = list.filter((m) => !m.retired);
  }
  if (!list.length) { wrap.innerHTML = `<p class="empty">${showGuests ? "ゲストはいません。" : (showRetired ? "まだ登録がありません。" : "表示できるメンバーがいません。")}</p>`; return; }
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
// リレー第1泳者の記録を、個人種目の記録として作る（正式記録扱い）。
function firstLegIndividual(r) {
  if (!r.isRelay || !(r.legs || []).length || !r.distance) return null;
  const leg = r.legs[0];
  if (!leg.memberId) return null;
  const legCount = r.legs.length, legDist = r.distance / legCount;
  const dists = recDists(r), splits = r.splits || [];
  const firstSplits = [], firstDists = [];
  for (let i = 0; i < splits.length; i++) {
    if (dists[i] <= legDist + 0.5) { firstSplits.push(splits[i]); firstDists.push(dists[i]); } else break;
  }
  if (!firstSplits.length || Math.abs(firstDists[firstDists.length - 1] - legDist) > 0.5) return null;
  const stroke = leg.legStroke || (r.stroke === "メドレーリレー" ? "背泳ぎ" : "自由形");
  const rec = {
    memberId: leg.memberId, name: leg.name, school: leg.school || "",
    dateISO: r.dateISO, poolLength: r.poolLength || null, lapMode: r.lapMode || null,
    stroke, distance: legDist, splits: firstSplits.slice(), splitDists: firstDists.slice(),
    finalMs: firstSplits[firstSplits.length - 1], fromRelay: true, createdAt: serverTimestamp()
  };
  if (r.meetName) rec.meetName = r.meetName;
  return rec;
}
// 既存のリレー記録から、第1泳者の個人記録をまとめて作成（重複は作らない）
function backfillFirstLeg() {
  const relays = allRecs().filter((r) => r.isRelay);
  if (!relays.length) { alert("リレーの記録がありません。"); return; }
  if (!confirm("既存のリレー記録から、第1泳者の個人記録を作成します。\n（すでに反映済みのものは作成しません）よろしいですか？")) return;
  const sig = (mid, st, di, da, fm) => `${mid}|${st}|${di}|${da}|${Math.round((fm || 0) / 10)}`;
  const have = new Set(allRecs().filter((r) => !r.isRelay).map((r) => sig(r.memberId, r.stroke, r.distance, r.dateISO, r.finalMs)));
  let created = 0;
  relays.forEach((r) => {
    const ind = firstLegIndividual(r);
    if (!ind) return;
    const s = sig(ind.memberId, ind.stroke, ind.distance, ind.dateISO, ind.finalMs);
    if (have.has(s)) return;
    set(push(ref(db, RESULTS)), ind);
    have.add(s); created++;
  });
  alert(created ? `${created}件の個人記録を追加しました。` : "追加対象はありませんでした（すでに反映済みです）。");
  renderRecordsAll();
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
  const list = memberList().filter((m) => (!m.retired || showRetiredRec || m.id === recFilter) && (!m.guest || m.id === recFilter));
  sel.innerHTML = `<option value="">— 選手を選択 —</option>` + list.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年${m.retired ? "・引退" : ""}）</option>`).join("");
  sel.value = cur || recFilter || "";
}
function renderRecordsAll() {
  $$("#rec-mode button").forEach((b) => b.classList.toggle("on", b.dataset.rmode === recMode));
  $("#pane-indiv").hidden = recMode !== "indiv";
  $("#pane-relay").hidden = recMode !== "relay";
  $("#pane-ranking").hidden = recMode !== "ranking";
  $("#pane-practice").hidden = recMode !== "practice";
  if (recMode === "indiv") renderIndiv();
  else if (recMode === "relay") renderRelay();
  else if (recMode === "ranking") renderRanking();
  else renderTraining();
  if (analysisId) renderAnalysis();
}
function rerenderActiveList() {
  if (recMode === "indiv") renderIndiv();
  else if (recMode === "relay") renderRelay();
  else if (recMode === "ranking") renderRanking();
  else renderTraining();
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
  const allRelay = allRecs().filter((r) => r.isRelay);
  // 年度プルダウン（データのある年度＋今年度）
  const cfy = currentFiscalYear();
  const years = [...new Set(allRelay.map((r) => fiscalYear(r.dateISO)).filter((y) => y != null))];
  if (!years.includes(cfy)) years.push(cfy);
  years.sort((a, b) => b - a);
  if (relayYearF == null) relayYearF = cfy;
  const ysel = $("#relay-year");
  ysel.innerHTML = years.map((y) => `<option value="${y}">${y}年度</option>`).join("");
  ysel.value = String(relayYearF);
  // 種目プルダウン
  const evs = [...new Set(allRelay.map(evKey))];
  const esel = $("#relay-event");
  esel.innerHTML = `<option value="">全て</option>` + evs.map((k) => `<option value="${k}">${escapeHtml(evLabelFromKey(k))}</option>`).join("");
  esel.value = (relayEventF && evs.includes(relayEventF)) ? relayEventF : "";
  relayEventF = esel.value;
  $("#relay-gender").value = relayGenderF;
  // 絞り込み
  let recs = allRelay.filter((r) => fiscalYear(r.dateISO) === Number(relayYearF));
  if (relayGenderF) recs = recs.filter((r) => relayGender(r) === relayGenderF);
  if (relayEventF) recs = recs.filter((r) => evKey(r) === relayEventF);
  $$("#relay-sort-seg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === relaySort));
  sortRecs(recs, relaySort);
  $("#relay-list").innerHTML = recs.length ? recs.map(recordCardHtml).join("") : `<p class="empty">この年度のリレー記録がありません。</p>`;
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
      <div class="r-sub">${r.meetName ? `🏆 ${escapeHtml(r.meetName)}・` : ""}${escapeHtml(r.dateISO || "")}${r.lane ? `・L${r.lane}` : ""}${r.school ? `・${escapeHtml(r.school)}` : ""}${r.fromRelay ? "・リレー第1泳" : ""}</div>
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
  if (rec.isRelay) { const ind = firstLegIndividual(rec); if (ind) set(push(ref(db, RESULTS)), ind); }
  alert(rec.isRelay && firstLegIndividual(rec) ? "保存しました（第1泳者の個人記録も追加）。" : "保存しました。");
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
  $("#assign-readonly").hidden = true;
  $("#setup-hint").hidden = true;
  $("#btn-join").disabled = true;
}
function memberOptions(selId) {
  return memberList().filter((m) => (!m.retired || m.id === selId) && (!m.guest || m.id === selId)).map((m) =>
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
  if (inMeetTiming()) {
    $("#assign-area").hidden = true;
    $("#assign-readonly").hidden = false;
    if (a && a.name) {
      $("#assign-readonly").innerHTML = `<div class="ro-name">${escapeHtml(a.name)}</div><div class="ro-ev">${escapeHtml(a.stroke || "")} ${a.distance || ""}m${a.school ? `・${escapeHtml(a.school)}` : ""}</div>`;
      $("#btn-join").disabled = false;
    } else {
      $("#assign-readonly").innerHTML = `<div class="ro-empty">この組ではレーン${lane}に割り当てがありません。</div>`;
      $("#btn-join").disabled = true;
    }
    return;
  }
  $("#assign-readonly").hidden = true;
  $("#assign-area").hidden = false;
  $("#setup-hint").hidden = memberList().length !== 0;
  $("#ev-stroke").value = a?.stroke || "自由形";
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
  if (inMeetTiming()) {
    const a = race.lanes?.[myLane];
    if (!a || !a.name) { alert("このレーンには割り当てがありません。"); return; }
    // 割り当てはプログラム由来。上書きせずそのまま記録。
  } else {
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
  }
  $("#rec-lane-label").textContent = `レーン ${myLane}`;
  lastBeepRaceId = null;
  joinedRaceId = race.raceId;
  recFinished = false; finishedResult = null; finishedSaved = false;
  $("#rec-review").hidden = true;
  $("#btn-split").hidden = false;
  $("#screen-recorder .back").hidden = false;
  show("screen-recorder");
  onRaceChanged();
}

// ── 描画ループ ─────────────────────────────────────────
function tick() {
  $("#sync-clock").textContent = fmtClock(serverNow());
  tickPractice();
  if (recFinished) {
    // 完了表示：確定タイムのまま凍結
  } else if (race?.state === "running" && race.startServerTime != null) {
    const t = fmt(serverNow() - race.startServerTime);
    if (role === "starter") $("#starter-clock").textContent = t;
    if (role === "recorder") $("#rec-clock").textContent = t;
  } else if (role === "recorder") {
    $("#rec-clock").textContent = "0.00";
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ══ 練習メニュー作成（1日1枚の自動計算表） ══════════════
function mbItems(date) {
  const node = (dailyMenus[date] && dailyMenus[date].items) || {};
  return Object.entries(node).map(([id, it]) => ({ id, ...it })).sort((a, b) => (a.order || 0) - (b.order || 0));
}
function mbItemTime(it) { return (it.circleMs || 0) * (it.reps || 0) * (it.sets || 1); }
function mbItemDist(it) { return (it.distance || 0) * (it.reps || 0) * (it.sets || 1); }

function enterMenuBuilder() {
  role = null; myLane = null; timingMeetId = null;
  mbDate = todayISO();
  mbEditingId = null;
  $("#mb-date").value = mbDate;
  if (!mbFilled) {
    $("#mb-cmin").innerHTML = Array.from({ length: 20 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
    $("#mb-csec").innerHTML = Array.from({ length: 60 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}</option>`).join("");
    $("#mb-cat").innerHTML = `<option value="">—（任意）</option>` + ["A", "B", "C", "D", "E"].map((c) => `<option value="${c}">${c}：${TR_CAT_LABEL[c]}</option>`).join("");
    $("#mb-type").innerHTML = MENU_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
    $("#mb-style").innerHTML = `<option value="">—</option>` + MENU_STYLES.map((s) => `<option value="${s}">${s}</option>`).join("");
    mbFilled = true;
  }
  mbCloseForm();
  renderMenuBuilder();
  show("screen-menu-builder");
}

function renderMenuBuilder() {
  const items = mbItems(mbDate);
  const head = `<thead><tr>
    <th>区分</th><th>分類</th><th>距離</th><th>本</th><th>ｾｯﾄ</th>
    <th class="mb-note-h">詳細</th><th>ｽﾀｲﾙ</th><th>ｻｰｸﾙ</th>
    <th>合計<br>時間</th><th>合計<br>距離</th>
  </tr></thead>`;
  let totT = 0, totD = 0;
  const rows = items.map((it) => {
    const t = mbItemTime(it), d = mbItemDist(it); totT += t; totD += d;
    const cat = it.category ? `<span class="mb-cat cat-${it.category}">${it.category}</span>` : "—";
    const noMeas = it.measurable ? "" : `<span class="mb-nomeas">記録外</span>`;
    return `<tr data-mb-row="${it.id}">
      <td>${cat}</td>
      <td class="mb-type">${escapeHtml(it.type || "")}${noMeas}</td>
      <td>${it.distance || 0}</td><td>${it.reps || 0}</td><td>${it.sets || 1}</td>
      <td class="mb-note">${escapeHtml(it.note || "")}</td>
      <td>${escapeHtml(it.style || "—")}</td>
      <td>${it.circleMs ? fmtHMS(it.circleMs) : "—"}</td>
      <td><b>${fmtHMS(t)}</b></td><td><b>${d}</b></td>
    </tr>`;
  }).join("");
  const body = rows || `<tr><td colspan="10" class="mb-empty">まだメニューがありません。「＋ メニューを追加」で作成してください。</td></tr>`;
  $("#mb-table").innerHTML = head + `<tbody>${body}</tbody>`;
  $("#mb-total").innerHTML = items.length
    ? `<span class="mb-total-lbl">1日合計</span><span class="mb-total-t">時間 <b>${fmtHMS(totT)}</b></span><span class="mb-total-d">距離 <b>${totD.toLocaleString()}</b>m</span>`
    : "";
}

// ── 追加／編集フォーム ──
function mbOpenForm(id) {
  mbEditingId = id || null;
  const it = id ? (mbItems(mbDate).find((x) => x.id === id) || {}) : null;
  $("#mb-form-title").textContent = id ? "メニューを編集" : "メニューを追加";
  $("#mb-commit").textContent = id ? "この行を更新" : "この行を追加";
  $("#mb-cat").value = (it && it.category) || "";
  $("#mb-type").value = (it && it.type) || "Swim";
  $("#mb-dist").value = it ? (it.distance ?? "") : "";
  $("#mb-reps").value = it ? (it.reps ?? "") : "";
  $("#mb-sets").value = it ? (it.sets ?? 1) : 1;
  $("#mb-style").value = (it && it.style) || "";
  const cms = (it && it.circleMs) || 0;
  $("#mb-cmin").value = String(Math.floor(cms / 60000));
  $("#mb-csec").value = String(Math.floor((cms % 60000) / 1000));
  $("#mb-note").value = (it && it.note) || "";
  $("#mb-meas").checked = it ? !!it.measurable : !MENU_NOMEAS.includes($("#mb-type").value);
  $("#mb-manage").hidden = !id;
  $("#mb-form").hidden = false;
  $("#mb-add").hidden = true;
  $("#mb-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function mbCloseForm() {
  mbEditingId = null;
  $("#mb-form").hidden = true;
  $("#mb-add").hidden = false;
}
function mbCommit() {
  const type = $("#mb-type").value;
  const distance = Number($("#mb-dist").value);
  const reps = Number($("#mb-reps").value);
  const sets = Math.max(1, Number($("#mb-sets").value) || 1);
  if (!type) { alert("分類を選択してください。"); return; }
  if (!distance || distance <= 0) { alert("距離を入力してください。"); return; }
  if (!reps || reps <= 0) { alert("本数を入力してください。"); return; }
  const circleMs = (Number($("#mb-cmin").value || 0) * 60 + Number($("#mb-csec").value || 0)) * 1000;
  const item = {
    category: $("#mb-cat").value || "",
    type, distance, reps, sets,
    style: $("#mb-style").value || "",
    note: ($("#mb-note").value || "").trim(),
    circleMs,
    measurable: $("#mb-meas").checked
  };
  const items = mbItems(mbDate);
  if (mbEditingId) {
    const cur = items.find((x) => x.id === mbEditingId);
    set(ref(db, `${DAILYMENUS}/${mbDate}/items/${mbEditingId}`), { ...item, order: cur ? cur.order || 0 : items.length });
  } else {
    const order = items.length ? Math.max(...items.map((x) => x.order || 0)) + 1 : 0;
    const r = push(ref(db, `${DAILYMENUS}/${mbDate}/items`));
    set(r, { ...item, order });
  }
  update(ref(db, `${DAILYMENUS}/${mbDate}`), { dateISO: mbDate, updatedAt: serverTimestamp() });
  toast(mbEditingId ? "メニューを更新しました" : "メニューを追加しました");
  mbCloseForm();
  renderMenuBuilder();
}
function mbDeleteItem(id) {
  if (!confirm("このメニューを削除しますか？")) return;
  remove(ref(db, `${DAILYMENUS}/${mbDate}/items/${id}`));
  update(ref(db, `${DAILYMENUS}/${mbDate}`), { dateISO: mbDate, updatedAt: serverTimestamp() });
  if (mbEditingId === id) mbCloseForm();
  renderMenuBuilder();
}
function mbMoveItem(id, dir) {
  const items = mbItems(mbDate);
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  const a = items[i], b = items[j];
  const oa = a.order || 0, ob = b.order || 0;
  update(ref(db, `${DAILYMENUS}/${mbDate}/items/${a.id}`), { order: ob });
  update(ref(db, `${DAILYMENUS}/${mbDate}/items/${b.id}`), { order: oa });
  renderMenuBuilder();
}

// ══ 練習計測（1端末1レーン・独立スタート） ══════════════
let trSetup = null;   // （旧）設定中の状態：未使用
let psSession = null; // 練習セッション（選手・設定・選択メニューを画面間で引き継ぐ）
let tr = null;        // ライブ計測の状態
let trReview = null;  // 確認画面用に確定した配列

// 1本あたりのラップ（押下）回数。lapDistM(0=なし) と 1本の距離から算出。
function trLapsPerRep(menu) {
  const ld = menu.lapDistM;
  if (!ld) return 1;
  const interval = Math.min(ld, menu.distance);
  return Math.max(1, Math.round(menu.distance / interval));
}
function fmtCircle(ms) { return fmt(ms).replace(/\.00$/, ""); }
function fmtCd(ms) { if (ms == null) return "—"; return (Math.max(0, ms) / 1000).toFixed(1); }
function fmtDrop(ms) { if (ms == null) return "—"; const s = ms > 0 ? "+" : (ms < 0 ? "−" : "±"); return s + fmt(Math.abs(ms)); }
function trMenuLabel(menu) {
  const lap = menu.lapDistM ? `・${menu.lapDistM}mラップ` : "";
  return `${menu.distance}m×${menu.reps}　サークル${fmtCircle(menu.circleMs)}${lap}`;
}
function trMenuHead(menu) {
  const tag = [menu.category, menu.strokeType, menu.style].filter(Boolean).join("・");
  const memo = menu.name ? `（${escapeHtml(menu.name)}）` : "";
  return (tag ? escapeHtml(tag) + "　" : "") + trMenuLabel(menu) + memo;
}
// rep内の各区間タイムと、直前区間との落ち幅
function trSegTimes(rep) { const laps = rep.laps || [], out = []; let prev = 0; for (let j = 0; j < laps.length; j++) { out.push(laps[j] - prev); prev = laps[j]; } return out; }
function trSegHtml(rep) {
  const segs = trSegTimes(rep);
  return segs.map((s, j) => {
    const d = j > 0 ? s - segs[j - 1] : null;
    return `<span class="seg-cell"><b>${fmt(s)}</b>${d == null ? "" : `<i class="${d > 0 ? "pr-up" : "pr-down"}">${fmtDrop(d)}</i>`}</span>`;
  }).join("");
}

// サークル計算の核：S = max(基準スタート, 直前ゴール)。完了済みの本だけ返す。
function trComputeReps(sw, menu) {
  const lpr = trLapsPerRep(menu), C = menu.circleMs, off = sw.offsetMs || 0;
  const presses = sw.presses || [];
  const out = [];
  let prevFinish = null, prevTime = null;
  const fullReps = Math.floor(presses.length / lpr);
  for (let n = 1; n <= fullReps; n++) {
    const startIdx = (n - 1) * lpr;
    const F = presses[n * lpr - 1];
    const E = off + (n - 1) * C;
    const S = (n === 1) ? off : Math.max(E, prevFinish);
    const timeMs = F - S;
    const nextDep = off + n * C;
    const madeCircle = F <= nextDep;
    const restMs = nextDep - F;
    const dropMs = (n > 1) ? timeMs - prevTime : null;
    const laps = [];
    for (let j = 0; j < lpr; j++) laps.push(presses[startIdx + j] - S);
    out.push({ repNo: n, startMs: S, finishMs: F, timeMs, madeCircle, restMs, dropMs, laps });
    prevFinish = F; prevTime = timeMs;
  }
  return out;
}
// 進行中の本のライブ状態
function trLiveState(sw, menu, t) {
  const lpr = trLapsPerRep(menu), C = menu.circleMs, off = sw.offsetMs || 0;
  const presses = sw.presses || [];
  const done = presses.length;
  const fullReps = Math.floor(done / lpr);
  const total = menu.reps;
  if (fullReps >= total) return { done: true };
  const currentRep = fullReps + 1;
  const lapInRep = done % lpr;
  let S;
  if (currentRep === 1) S = off;
  else { const prevF = presses[(currentRep - 1) * lpr - 1]; S = Math.max(off + (currentRep - 1) * C, prevF); }
  const phase = (t < S) ? "wait" : "swim";
  return { done: false, currentRep, lapInRep, lpr, S, phase, value: phase === "wait" ? S - t : t - S };
}

// ── 練習セッション（選手・設定・選択メニューを画面間で引き継ぐ） ──
// psSession = { swimmers:[{memberId,name,school}], gapSec, poolLength, menuDate, selItemId }
let pmStroke = "Swim";   // メニュー選択画面の種類
let pmLapDist = 0;       // メニュー選択画面のラップ区切り
function psEnsureSession() {
  if (!psSession) psSession = { swimmers: [], gapSec: 10, poolLength: 25, menuDate: todayISO(), selItemId: null };
}

// ── 画面1：選手選択 ──
function enterPracticeSetup() {
  role = null; myLane = null; timingMeetId = null;
  psEnsureSession();
  if (!$("#pm-cmin").dataset.filled) {
    $("#pm-cmin").innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i}">${i}</option>`).join("");
    $("#pm-csec").innerHTML = Array.from({ length: 60 }, (_, i) => `<option value="${i}">${String(i).padStart(2, "0")}</option>`).join("");
    $("#pm-cmin").value = "1"; $("#pm-csec").value = "30"; $("#pm-cmin").dataset.filled = "1";
  }
  renderSwimmerSetup();
  show("screen-practice-setup");
}
function psAddSwimmer(id) {
  if (!psSession || psSession.swimmers.some((s) => s.memberId === id)) return;
  if (psSession.swimmers.length >= 5) { alert("レーン内の選手は最大5名です。"); return; }
  const m = members[id] || {};
  psSession.swimmers.push({ memberId: id, name: m.name || "—", school: m.school || OWN_SCHOOL });
  renderSwimmerSetup();
}
function psRemoveSwimmer(i) { if (!psSession) return; psSession.swimmers.splice(i, 1); renderSwimmerSetup(); }
function psMoveSwimmer(i, d) { if (!psSession) return; const o = psSession.swimmers, j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; renderSwimmerSetup(); }
function renderSwimmerSetup() {
  if (!psSession) return;
  const chosen = new Set(psSession.swimmers.map((s) => s.memberId));
  const opts = memberList().filter((m) => !m.retired && (m.school || OWN_SCHOOL) === OWN_SCHOOL && !chosen.has(m.id));
  $("#ps-add").innerHTML = `<option value="">＋ 選手を追加</option>` + opts.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade || ""}年）</option>`).join("");
  const gap = psSession.gapSec;
  $("#ps-order").innerHTML = psSession.swimmers.length ? psSession.swimmers.map((s, i) => {
    return `<div class="ps-row"><span class="ps-no">${i + 1}</span><span class="ps-nm">${escapeHtml(s.name || "—")}</span><span class="ps-off">${i === 0 ? "基準" : "+" + (i * gap) + "秒"}</span>` +
      `<button class="ps-mini" data-ps-up="${i}" ${i === 0 ? "disabled" : ""}>↑</button>` +
      `<button class="ps-mini" data-ps-dn="${i}" ${i === psSession.swimmers.length - 1 ? "disabled" : ""}>↓</button>` +
      `<button class="ps-mini rm" data-ps-rm="${i}">✕</button></div>`;
  }).join("") : `<p class="hint">出発順に選手を追加してください（最大5名）。</p>`;
  $("#btn-ps-begin").disabled = psSession.swimmers.length < 1;
}

// ── 設定モーダル（出発間隔・プール） ──
function openPsSettings() {
  psEnsureSession();
  $("#set-gap").value = psSession.gapSec;
  $$("#set-pool button").forEach((b) => b.classList.toggle("on", Number(b.dataset.pool) === psSession.poolLength));
  $("#ps-settings").hidden = false;
}
function closePsSettings() {
  psSession.gapSec = Math.max(0, Number($("#set-gap").value) || 0);
  $("#ps-settings").hidden = true;
  if (!$("#screen-practice-setup").hidden) renderSwimmerSetup();
}

// ── 画面2：メニュー選択 ──
function enterMenuPick() {
  psEnsureSession();
  if (!psSession.swimmers.length) { enterPracticeSetup(); return; }
  $("#pm-date").value = psSession.menuDate;
  renderMenuPick();
  show("screen-practice-menu");
}
function pmSetCircle(ms) {
  const mn = Math.floor((ms || 0) / 60000), sc = Math.floor(((ms || 0) % 60000) / 1000);
  if (mn <= 9) $("#pm-cmin").value = String(mn);
  $("#pm-csec").value = String(sc);
}
function renderMenuPick() {
  const items = mbItems(psSession.menuDate);
  const head = `<thead><tr>
    <th>区分</th><th>分類</th><th>距離</th><th>本</th><th>ｾｯﾄ</th>
    <th class="mb-note-h">詳細</th><th>ｽﾀｲﾙ</th><th>ｻｰｸﾙ</th>
    <th>合計<br>時間</th><th>合計<br>距離</th>
  </tr></thead>`;
  const rows = items.map((it) => {
    const t = mbItemTime(it), d = mbItemDist(it);
    const cat = it.category ? `<span class="mb-cat cat-${it.category}">${it.category}</span>` : "—";
    const noMeas = it.measurable ? "" : `<span class="mb-nomeas">記録外</span>`;
    const sel = (it.id === psSession.selItemId) ? " sel" : "";
    const cls = it.measurable ? "pm-pick" : "pm-nopick";
    return `<tr class="${cls}${sel}"${it.measurable ? ` data-pm-row="${it.id}"` : ""}>
      <td>${cat}</td>
      <td class="mb-type">${escapeHtml(it.type || "")}${noMeas}</td>
      <td>${it.distance || 0}</td><td>${it.reps || 0}</td><td>${it.sets || 1}</td>
      <td class="mb-note">${escapeHtml(it.note || "")}</td>
      <td>${escapeHtml(it.style || "—")}</td>
      <td>${it.circleMs ? fmtHMS(it.circleMs) : "—"}</td>
      <td><b>${fmtHMS(t)}</b></td><td><b>${d}</b></td>
    </tr>`;
  }).join("");
  const body = rows || `<tr><td colspan="10" class="mb-empty">この日のメニューがありません。下の項目を手入力して計測できます。</td></tr>`;
  $("#pm-table").innerHTML = head + `<tbody>${body}</tbody>`;
  $$("#pm-type button").forEach((x) => x.classList.toggle("on", x.dataset.type === pmStroke));
  $$("#pm-lap button").forEach((x) => x.classList.toggle("on", Number(x.dataset.lapd) === pmLapDist));
}
function pmSelectItem(id) {
  const it = mbItems(psSession.menuDate).find((x) => x.id === id);
  if (!it || !it.measurable) return;
  psSession.selItemId = id;
  $("#pm-distance").value = it.distance || "";
  $("#pm-reps").value = it.reps || "";
  pmSetCircle(it.circleMs || 0);
  $("#pm-note").value = it.note || "";
  pmStroke = ["Kick", "Pull", "Swim"].includes(it.type) ? it.type : "Swim";
  renderMenuPick();
}

// ── 計測開始：tr を構築（複数セット対応） ──
function pmBegin() {
  psEnsureSession();
  const distance = Number($("#pm-distance").value);
  const reps = Number($("#pm-reps").value);
  const circleMs = (Number($("#pm-cmin").value || 0) * 60 + Number($("#pm-csec").value || 0)) * 1000;
  if (!distance || !reps || !circleMs) { alert("距離・本数・サークルを正しく入力してください。"); return; }
  const it = psSession.selItemId ? mbItems(psSession.menuDate).find((x) => x.id === psSession.selItemId) : null;
  const totalSets = it ? (it.sets || 1) : 1;
  const menu = {
    name: ($("#pm-note").value || "").trim(),
    category: it ? (it.category || "") : "",
    strokeType: pmStroke || "Swim",
    style: it ? (it.style || "") : "",
    poolLength: psSession.poolLength,
    distance, reps, circleMs,
    lapDistM: pmLapDist || 0,
    startGapMs: Math.round((psSession.gapSec || 0) * 1000),
    sets: totalSets,
    menuRef: it ? { dateISO: psSession.menuDate, itemId: it.id } : null
  };
  tr = { menu, totalSets, curSet: 0, sets: [], dateISO: todayISO() };
  trAddSet();
  renderPracticeRun();
  show("screen-practice-run");
}
function curSet() { return tr ? tr.sets[tr.curSet - 1] : null; }
function trAddSet() {
  const setNo = tr.sets.length + 1;
  const swimmers = psSession.swimmers.map((s, i) => ({ memberId: s.memberId, name: s.name, school: s.school, offsetMs: i * tr.menu.startGapMs, presses: [] }));
  tr.sets.push({ setNo, t0: null, state: "ready", log: [], swimmers });
  tr.curSet = setNo;
}

// ── 画面3：計測 ──
function trStart() {
  const s = curSet(); if (!tr || !s || s.state === "running") return;
  ensureAudio();
  const t0Local = Date.now() + START_LEAD_MS;
  scheduleBeepAt(t0Local);
  s.t0 = t0Local + serverOffset;
  s.state = "running";
  renderPracticeRun();
}
function trNextSet() {
  if (!tr || tr.curSet >= tr.totalSets) return;
  trAddSet();
  trStart();
}
function trSetDone(s) { const lpr = trLapsPerRep(tr.menu); return s.swimmers.every((sw) => Math.floor((sw.presses || []).length / lpr) >= tr.menu.reps); }
function trPress(si) {
  const s = curSet();
  if (!tr || !s || s.state !== "running") return;
  const sw = s.swimmers[si]; if (!sw) return;
  const lpr = trLapsPerRep(tr.menu);
  sw.presses = sw.presses || [];
  if (sw.presses.length >= tr.menu.reps * lpr) return;
  const t = serverNow() - s.t0;
  if (t < 0) return;
  sw.presses.push(Math.round(t));
  s.log.push(si);
  if (trSetDone(s)) s.state = "done";
  renderPracticeRun();
}
function trUndo() {
  const s = curSet();
  if (!tr || !s || !s.log || !s.log.length) return;
  const si = s.log.pop();
  const sw = s.swimmers[si];
  if (sw && sw.presses && sw.presses.length) sw.presses.pop();
  if (s.state === "done") s.state = "running";
  renderPracticeRun();
}
function trBackFromRun() {
  const anyData = tr && tr.sets.some((st) => st.swimmers.some((sw) => (sw.presses || []).length));
  if (anyData && !confirm("このメニューの計測を中止して戻りますか？（保存されていない記録は破棄されます）")) return;
  tr = null; trReview = null;
  enterMenuPick();
}
function renderPracticeRun() {
  if (!tr) return;
  const s = curSet(); if (!s) return;
  const setTag = tr.totalSets > 1 ? `［${s.setNo}/${tr.totalSets}セット］ ` : "";
  $("#pr-menu").innerHTML = setTag + trMenuHead(tr.menu);
  const moreSets = tr.curSet < tr.totalSets;
  const anyData = tr.sets.some((st) => st.swimmers.some((sw) => (sw.presses || []).length));
  const setDone = s.state === "done";
  let startVisible = false, startText = "", startNext = false;
  if (s.state === "ready") { startVisible = true; startText = tr.totalSets > 1 ? `スタート（${s.setNo}/${tr.totalSets}セット）` : "スタート（発進音）"; }
  else if (setDone && moreSets) { startVisible = true; startNext = true; startText = `スタート（${s.setNo + 1}/${tr.totalSets}セット）`; }
  $("#pr-start-row").hidden = !startVisible;
  if (startVisible) { $("#btn-pr-start").textContent = startText; $("#btn-pr-start").dataset.next = startNext ? "1" : ""; }
  if (s.state === "ready" && !s.t0) $("#pr-clock").textContent = "0.00";
  $("#pr-ctrl-row").hidden = !(s.state === "running" || anyData);
  $("#btn-pr-undo").disabled = !(s.state === "running");
  // セット完了時：そのセットのサマリーを表示し、計測カードは隠す
  $("#pr-set-summary").hidden = !setDone;
  $("#pr-set-summary").innerHTML = setDone ? trSetSummaryHtml(s) : "";
  $("#pr-cards").hidden = setDone;
  if (setDone) return;
  const lpr = trLapsPerRep(tr.menu);
  $("#pr-cards").innerHTML = s.swimmers.map((sw, si) => {
    const reps = trComputeReps(sw, tr.menu);
    const pressDone = (sw.presses || []).length;
    const fullReps = Math.floor(pressDone / lpr);
    const done = fullReps >= tr.menu.reps;
    const remaining = tr.menu.reps - fullReps;
    const curRep = Math.min(fullReps + 1, tr.menu.reps);
    const lapInRep = pressDone % lpr;
    const nowLabel = done ? "完了" : `${curRep}本目` + (lpr > 1 ? `　ラップ ${Math.min(lapInRep + 1, lpr)}/${lpr}` : "");
    // 履歴（新しい順・上から。入りきらない古い記録は下で見えなくなる）
    const histDone = reps.slice().reverse().map((r) => {
      const dr = r.dropMs == null ? "" : `<span class="ph-dr ${r.dropMs > 0 ? "pr-up" : "pr-down"}">${fmtDrop(r.dropMs)}</span>`;
      const ci = r.madeCircle ? `<span class="ph-ci ok">◯${fmtCd(r.restMs)}</span>` : `<span class="ph-ci late">×遅</span>`;
      const laps = lpr > 1 ? `<div class="ph-laps">${trSegHtml(r)}</div>` : "";
      return `<div class="ph-row${r.madeCircle ? "" : " late"}"><div class="ph-line"><span class="ph-no">${r.repNo}</span><span class="ph-tm">${fmt(r.timeMs)}</span>${dr}${ci}</div>${laps}</div>`;
    }).join("");
    // 計測中の本：ラップを取った時点で即反映（最上段）
    let histLive = "";
    if (lpr > 1 && lapInRep > 0 && !done) {
      const off = sw.offsetMs || 0, C = tr.menu.circleMs;
      const S = (curRep === 1) ? off : Math.max(off + (curRep - 1) * C, (sw.presses || [])[(curRep - 1) * lpr - 1]);
      const startIdx = (curRep - 1) * lpr;
      const cum = [];
      for (let j = 0; j < lapInRep; j++) cum.push((sw.presses || [])[startIdx + j] - S);
      histLive = `<div class="ph-row inprog"><div class="ph-line"><span class="ph-no">${curRep}</span><span class="ph-tm live">計測中</span><span class="ph-ci">ﾗｯﾌﾟ ${lapInRep}/${lpr}</span></div><div class="ph-laps">${trSegHtml({ laps: cum })}</div></div>`;
    }
    const hist = histLive + histDone;
    return `<div class="pr-card${done ? " done" : ""}" data-pr-si="${si}">
      <div class="pr-btn">
        <div class="pr-top"><span class="pr-name">${escapeHtml(sw.name)}</span><span class="pr-rem">${done ? "完了" : "残り " + remaining + "本"}</span></div>
        <div class="pr-now" id="pr-now-${si}">${nowLabel}</div>
        <div class="pr-live" id="pr-live-${si}">—</div>
      </div>
      <div class="pr-hist" id="pr-hist-${si}">${hist || `<div class="ph-empty">スタート前</div>`}</div>
    </div>`;
  }).join("");
}
// 1選手分のサマリーHTML（確認画面とセット完了サマリーで共用）
function trSwSummaryHtml(name, reps, lpr, setLbl) {
  const times = reps.map((r) => r.timeMs);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const rows = reps.map((r) => {
    let row = `<div class="prv-row${r.madeCircle ? "" : " late"}"><span class="i">${r.repNo}</span><span class="tm">${fmt(r.timeMs)}</span><span class="dr">${fmtDrop(r.dropMs)}</span><span class="ci">${r.madeCircle ? "◯ 余裕" + fmtCd(r.restMs) + "s" : "× 遅れ"}</span></div>`;
    if (lpr > 1) row += `<div class="prv-laps">${trSegHtml(r)}</div>`;
    return row;
  }).join("");
  return `<div class="prv-sw"><div class="prv-h"><b>${escapeHtml(name)}</b>${setLbl || ""}<span>平均 ${fmt(avg)}・${reps.length}本</span></div><div class="prv-cap"><span>本</span><span>タイム</span><span>落ち幅</span><span>サークル</span></div>${rows}</div>`;
}
// セット完了サマリー（計測画面内）
function trSetSummaryHtml(setEntry) {
  const lpr = trLapsPerRep(tr.menu);
  const blocks = setEntry.swimmers.map((sw) => {
    const reps = trComputeReps(sw, tr.menu);
    return reps.length ? trSwSummaryHtml(sw.name, reps, lpr, "") : "";
  }).filter(Boolean).join("");
  if (!blocks) return "";
  const title = tr.totalSets > 1 ? `第${setEntry.setNo}セットの記録` : "計測結果";
  return `<div class="pr-sum-title">${title}</div>${blocks}`;
}
function tickPractice() {
  if (!tr || !$("#screen-practice-run") || $("#screen-practice-run").hidden) return;
  const s = curSet(); if (!s) return;
  const t = (s.state === "running" && s.t0 != null) ? (serverNow() - s.t0) : 0;
  const clk = $("#pr-clock"); if (clk && s.state === "running") clk.textContent = fmt(Math.max(0, t));
  s.swimmers.forEach((sw, si) => {
    const el = $(`#pr-live-${si}`); if (!el) return;
    if (s.state !== "running") { el.textContent = "—"; return; }
    const st = trLiveState(sw, tr.menu, t);
    if (st.done) { el.textContent = "完了"; return; }
    el.textContent = st.phase === "wait" ? `出発まで ${fmtCd(st.value)}s` : fmt(st.value);
  });
}

// ── 確認・保存 ──
function trEnd() {
  if (!tr) return;
  trReview = [];
  tr.sets.forEach((st) => {
    st.swimmers.forEach((sw) => {
      const reps = trComputeReps(sw, tr.menu);
      if (reps.length) trReview.push({ setNo: st.setNo, sw, reps });
    });
  });
  renderPracticeReview();
  show("screen-practice-review");
}
function renderPracticeReview() {
  $("#prv-menu").textContent = trMenuHead(tr.menu).replace(/<[^>]+>/g, "");
  if (!trReview || !trReview.length) {
    $("#prv-body").innerHTML = `<p class="empty">記録された本数がありません。</p>`;
    $("#btn-prv-save").disabled = true; return;
  }
  $("#btn-prv-save").disabled = false;
  const lpr = trLapsPerRep(tr.menu);
  const multi = tr.totalSets > 1;
  $("#prv-body").innerHTML = trReview.map(({ setNo, sw, reps }) => {
    const setLbl = multi ? `<span class="prv-set">第${setNo}セット</span>` : "";
    return trSwSummaryHtml(sw.name, reps, lpr, setLbl);
  }).join("");
}
function trSave() {
  if (!tr || !trReview || !trReview.length) { trBackToMenu(); return; }
  const m = tr.menu, label = trMenuLabel(m);
  trReview.forEach(({ setNo, sw, reps }) => {
    const times = reps.map((r) => r.timeMs);
    const rec = {
      dateISO: tr.dateISO, poolLength: m.poolLength,
      menu: { name: m.name || "", category: m.category || "", strokeType: m.strokeType || "", style: m.style || "", distance: m.distance, reps: m.reps, circleMs: m.circleMs, lapDistM: m.lapDistM || 0, startGapMs: m.startGapMs || 0, sets: m.sets || 1, label },
      menuRef: m.menuRef ? { ...m.menuRef, setNo } : null,
      setNo,
      memberId: sw.memberId || null, name: sw.name, school: sw.school || OWN_SCHOOL, offsetMs: sw.offsetMs || 0,
      doneReps: reps.length,
      reps: reps.map((r) => ({ repNo: r.repNo, startMs: Math.round(r.startMs), finishMs: Math.round(r.finishMs), timeMs: Math.round(r.timeMs), madeCircle: !!r.madeCircle, restMs: Math.round(r.restMs), dropMs: r.dropMs == null ? null : Math.round(r.dropMs), laps: (r.laps || []).map((x) => Math.round(x)) })),
      avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      bestRepMs: Math.min(...times), worstRepMs: Math.max(...times),
      totalDropMs: times.length > 1 ? (times[times.length - 1] - times[0]) : 0,
      createdAt: serverTimestamp()
    };
    set(push(ref(db, TRAINING)), rec);
  });
  toast(`${trReview.length}件の練習記録を保存しました`);
  trBackToMenu();
}
function trDiscard() { trBackToMenu(); }
function trBackToMenu() {
  tr = null; trReview = null;
  enterMenuPick();   // 選手・選択メニューは維持
}
function trExitPractice() {
  tr = null; trReview = null; psSession = null;
  show("screen-role");
}

// ══ 練習分析（記録を見る → 練習タブ） ══════════════
const TR_CAT_LABEL = { A: "リカバリー・フォーム", B: "有酸素持久力", C: "レース持久力・閾値", D: "対乳酸", E: "スプリント・スピード" };
function trainingList(memberId) { return Object.entries(training).map(([id, r]) => ({ id, ...r })).filter((r) => r.memberId === memberId); }
function trDateLabel(iso) { if (!iso) return ""; const p = iso.split("-").map(Number); const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(p[0], p[1] - 1, p[2]).getDay()]; return `${p[1]}/${p[2]}（${wd}）`; }
function trSig(m) { return [m.category || "", m.strokeType || "", m.distance, m.reps, m.circleMs, m.lapDistM || 0].join("|"); }
function trCatTag(m) {
  const c = m.category ? `<span class="tr-tag cat-${m.category}">${m.category}</span>` : "";
  const t = m.strokeType ? `<span class="tr-tag type">${escapeHtml(m.strokeType)}</span>` : "";
  return c + t;
}
function trDestroyCharts() { chTrRep?.destroy(); chTrTrend?.destroy(); chTrSeg?.destroy(); chTrSetRep?.destroy(); chTrSetAvg?.destroy(); chTrRep = chTrTrend = chTrSeg = chTrSetRep = chTrSetAvg = null; }

function renderTrCalendar(dates) {
  if (!trCalYM) return;
  const set = new Set(dates);
  const { y, m } = trCalYM;
  const startDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(`<div class="tc-cell empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const has = set.has(iso), sel = iso === trDate;
    cells.push(`<div class="tc-cell${has ? " has" : ""}${sel ? " sel" : ""}"${has ? ` data-tr-date="${iso}"` : ""}><span>${d}</span></div>`);
  }
  $("#tr-dates").innerHTML = `
    <div class="tc-head">
      <button class="tc-nav" data-tc-nav="-1">◀</button>
      <span class="tc-title">${y}年${m}月</span>
      <button class="tc-nav" data-tc-nav="1">▶</button>
    </div>
    <div class="tc-grid tc-dow"><span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span></div>
    <div class="tc-grid">${cells.join("")}</div>`;
}
function trCalShift(delta) {
  if (!trCalYM) return;
  let { y, m } = trCalYM; m += delta;
  if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
  trCalYM = { y, m };
  renderTrCalendar([...new Set(trainingList(trFilter).map((r) => r.dateISO))]);
}

function renderTraining() {
  const sel = $("#tr-filter"); if (!sel) return;
  const list = memberList().filter((m) => (m.school || OWN_SCHOOL) === OWN_SCHOOL && (!m.retired || m.id === trFilter));
  sel.innerHTML = `<option value="">— 選手を選択 —</option>` + list.map((m) => `<option value="${m.id}"${m.id === trFilter ? " selected" : ""}>${escapeHtml(m.name)}（${m.grade}年${m.retired ? "・引退" : ""}）</option>`).join("");
  $("#tr-body").hidden = !trFilter;
  if (!trFilter) { trDestroyCharts(); return; }
  const recs = trainingList(trFilter);
  const dates = [...new Set(recs.map((r) => r.dateISO))].sort((a, b) => (b || "").localeCompare(a || ""));
  if (!dates.length) { $("#tr-dates").innerHTML = `<p class="empty">この選手の練習記録はまだありません。</p>`; }
  else {
    if (!trCalYM) { const p = (trDate || dates[0]).split("-").map(Number); trCalYM = { y: p[0], m: p[1] }; }
    renderTrCalendar(dates);
  }
  if (trDate && dates.includes(trDate)) {
    $("#tr-menus-wrap").hidden = false;
    $("#tr-date-label").textContent = trDateLabel(trDate) + " のメニュー（タップで分析）";
    const day = recs.filter((r) => r.dateISO === trDate).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const groups = trDayGroups(day);
    $("#tr-menus").innerHTML = groups.map((g) => trGroupCard(g)).join("");
    const cur = trMenuId ? groups.find((g) => g.key === trMenuId) : null;
    if (cur) { $("#tr-detail").hidden = false; renderTrainingGroup(cur.recs); }
    else { trMenuId = null; $("#tr-detail").hidden = true; $("#tr-detail").innerHTML = ""; trDestroyCharts(); }
  } else {
    $("#tr-menus-wrap").hidden = true;
    trDate = trDate && dates.includes(trDate) ? trDate : "";
    trMenuId = null; $("#tr-detail").hidden = true; $("#tr-detail").innerHTML = ""; trDestroyCharts();
  }
}

// 同じメニュー（=同じ itemId）のセットをまとめる
function trGroupKey(r) { return (r.menuRef && r.menuRef.itemId) ? ("item:" + r.menuRef.itemId) : ("rec:" + r.id); }
function trDayGroups(dayRecs) {
  const map = new Map();
  dayRecs.forEach((r) => { const k = trGroupKey(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
  return [...map.entries()].map(([key, recs]) => {
    recs.sort((a, b) => (a.setNo || 1) - (b.setNo || 1) || (a.createdAt || 0) - (b.createdAt || 0));
    return { key, recs };
  });
}
function trGroupCard(g) {
  const recs = g.recs, m = recs[0].menu, n = recs.length;
  const avgAll = Math.round(recs.reduce((a, r) => a + (r.avgMs || 0), 0) / n);
  const totalReps = recs.reduce((a, r) => a + (r.doneReps || 0), 0);
  const setBadge = n > 1 ? `<span class="tm-sets">${n}セット</span>` : "";
  const right = n > 1 ? `平均 ${fmt(avgAll)}・${n}セット` : `平均 ${fmt(avgAll)}・${totalReps}本`;
  return `<div class="tr-menu${g.key === trMenuId ? " on" : ""}" data-tr-menu="${g.key}"><div class="tm-top">${trCatTag(m)}${setBadge}<span class="tm-avg">${right}</span></div><div class="tm-label">${escapeHtml(m.label || "")}${m.name ? `　<i>${escapeHtml(m.name)}</i>` : ""}</div></div>`;
}
function renderTrainingGroup(recs) {
  if (recs.length <= 1) { renderTrainingDetail(recs[0]); return; }
  renderTrainingMultiSet(recs);
}

function renderTrainingDetail(r) {
  trDestroyCharts();
  const m = r.menu, reps = r.reps || [];
  if (!reps.length) { $("#tr-detail").innerHTML = `<p class="empty">本数の記録がありません。</p>`; return; }
  const lpr = trLapsPerRep(m);
  const times = reps.map((x) => x.timeMs);
  const best = Math.min(...times), bestRep = reps[times.indexOf(best)] ? reps[times.indexOf(best)].repNo : null;
  const made = reps.filter((x) => x.madeCircle).length;
  const maxDrop = Math.max(0, ...reps.map((x) => x.dropMs || 0));
  const head = (m.category ? (TR_CAT_LABEL[m.category] ? `${m.category}：${TR_CAT_LABEL[m.category]}` : m.category) : "") + (m.strokeType ? ` ・ ${m.strokeType}` : "");
  const half = Math.floor(reps.length / 2);
  const front = times.slice(0, half), back = times.slice(reps.length - half);
  const favg = front.length ? front.reduce((a, b) => a + b, 0) / front.length : 0;
  const bavg = back.length ? back.reduce((a, b) => a + b, 0) / back.length : 0;
  const fade = bavg - favg;
  const rows = reps.map((x) => {
    let row = `<div class="prv-row${x.madeCircle ? "" : " late"}"><span class="i">${x.repNo}</span><span class="tm">${fmt(x.timeMs)}</span><span class="dr">${fmtDrop(x.dropMs)}</span><span class="ci">${x.madeCircle ? "◯ 余裕" + fmtCd(x.restMs) + "s" : "× 遅れ"}</span></div>`;
    if (lpr > 1) row += `<div class="prv-laps">${trSegHtml(x)}</div>`;
    return row;
  }).join("");
  const trendRecs = trainingList(trFilter).filter((o) => trSig(o.menu) === trSig(m));
  const segHtml = lpr > 1 ? `<div class="sec-title">区間ペース（位置別の平均）</div><div class="chart-wrap"><canvas id="tr-chart-seg"></canvas></div><p class="hint">1本の中で、各折り返し区間の平均タイム。右肩上がりだと後半で失速しています。</p>` : "";
  const trendHtml = trendRecs.length >= 2 ? `<div class="sec-title">同じメニューの推移（練習日ごと）</div><div class="chart-wrap"><canvas id="tr-chart-trend"></canvas></div><p class="hint">同じ内容の練習日ごとの平均タイム。下がっていれば改善です。</p>` : "";
  let fadeNote;
  if (Math.abs(fade) < 100) fadeNote = "前半と後半でほぼ一定のペースを保てています。";
  else if (fade > 0) fadeNote = `後半は前半より平均 +${fmt(fade)} 落ちています。`;
  else fadeNote = `後半の方が平均 ${fmt(Math.abs(fade))} 速い、良いネガティブスプリットです。`;
  $("#tr-detail").innerHTML = `
    <div class="tr-d-head">${head ? `<b>${escapeHtml(head)}</b>` : ""}<span>${escapeHtml(m.label || "")}${m.name ? `・${escapeHtml(m.name)}` : ""}</span></div>
    <div class="tr-stats">
      <div class="tr-stat"><span>平均</span><b>${fmt(r.avgMs)}</b></div>
      <div class="tr-stat"><span>最速</span><b>${fmt(best)}<i>${bestRep ? ` ${bestRep}本目` : ""}</i></b></div>
      <div class="tr-stat"><span>サークル達成</span><b>${made}/${reps.length}</b></div>
      <div class="tr-stat"><span>最大落ち</span><b>${maxDrop > 0 ? "+" + fmt(maxDrop) : "—"}</b></div>
    </div>
    <div class="prv-cap"><span>本</span><span>タイム</span><span>落ち幅</span><span>サークル</span></div>
    ${rows}
    <div class="sec-title">本数ごとのタイム</div>
    <div class="chart-wrap"><canvas id="tr-chart-rep"></canvas></div>
    <p class="hint">${fadeNote} 赤い点はサークルに間に合わなかった本です。</p>
    ${segHtml}
    ${trendHtml}`;
  trDrawRepChart(reps, m);
  if (lpr > 1) trDrawSegChart(reps, lpr);
  if (trendRecs.length >= 2) trDrawTrendChart(trendRecs, m);
}

function trDrawRepChart(reps, m) {
  if (!window.Chart) return;
  const labels = reps.map((x) => x.repNo + "本");
  const datasets = [
    { label: "タイム(秒)", data: reps.map((x) => +(x.timeMs / 1000).toFixed(2)), borderColor: "#1577dd", backgroundColor: "#1577dd22", tension: 0.2, pointRadius: 5, fill: true, pointBackgroundColor: reps.map((x) => x.madeCircle ? "#1577dd" : "#d7263d"), pointBorderColor: reps.map((x) => x.madeCircle ? "#1577dd" : "#d7263d") },
    { label: "サークル", data: reps.map(() => +(m.circleMs / 1000).toFixed(2)), borderColor: "#ff7a1a", borderDash: [6, 4], pointRadius: 0, fill: false }
  ];
  chTrRep = new Chart($("#tr-chart-rep"), { type: "line", data: { labels, datasets }, options: chartOpts("秒（小さいほど速い）") });
}
function trDrawTrendChart(recs, m) {
  if (!window.Chart) return;
  const data = recs.slice().sort((a, b) => (a.dateISO || "").localeCompare(b.dateISO || "") || (a.createdAt || 0) - (b.createdAt || 0));
  chTrTrend = new Chart($("#tr-chart-trend"), { type: "line", data: { labels: data.map((r) => trDateLabel(r.dateISO)), datasets: [{ label: "平均(秒)", data: data.map((r) => +(r.avgMs / 1000).toFixed(2)), borderColor: "#22a06b", backgroundColor: "#22a06b22", tension: 0.2, pointRadius: 5, fill: true }] }, options: chartOpts("秒（小さいほど速い）") });
}
function trDrawSegChart(reps, lpr) {
  if (!window.Chart) return;
  const sums = Array(lpr).fill(0), cnt = Array(lpr).fill(0);
  reps.forEach((r) => trSegTimes(r).forEach((s, j) => { if (j < lpr) { sums[j] += s; cnt[j]++; } }));
  const avg = sums.map((s, j) => cnt[j] ? +(s / cnt[j] / 1000).toFixed(2) : null);
  chTrSeg = new Chart($("#tr-chart-seg"), { type: "line", data: { labels: avg.map((_, j) => `区間${j + 1}`), datasets: [{ label: "位置別平均(秒)", data: avg, borderColor: "#9b59b6", backgroundColor: "#9b59b622", tension: 0.2, pointRadius: 5, fill: true }] }, options: chartOpts("秒（小さいほど速い）") });
}

// ── 複数セットの詳細（セット毎の変化） ──
const TR_SET_PALETTE = ["#1577dd", "#22a06b", "#e0a800", "#9b59b6", "#d7263d", "#0e7490"];
function renderTrainingMultiSet(recs) {
  trDestroyCharts();
  const m = recs[0].menu, lpr = trLapsPerRep(m);
  const head = (m.category ? (TR_CAT_LABEL[m.category] ? `${m.category}：${TR_CAT_LABEL[m.category]}` : m.category) : "") + (m.strokeType ? ` ・ ${m.strokeType}` : "");
  const setAvgs = recs.map((r) => r.avgMs || 0);
  const bestSet = recs[setAvgs.indexOf(Math.min(...setAvgs))];
  const setStats = recs.map((r, i) => `<div class="tr-stat"><span>第${r.setNo || i + 1}セット</span><b>${fmt(r.avgMs)}</b></div>`).join("");
  const drift = setAvgs.length > 1 ? setAvgs[setAvgs.length - 1] - setAvgs[0] : 0;
  let driftNote;
  if (Math.abs(drift) < 100) driftNote = "セットを通してほぼ一定のペースを保てています。";
  else if (drift > 0) driftNote = `最終セットは初めのセットより平均 +${fmt(drift)} 落ちています。`;
  else driftNote = `最終セットの方が平均 ${fmt(Math.abs(drift))} 速い、よく粘れています。`;
  const blocks = recs.map((r, i) => {
    const reps = r.reps || [];
    const rows = reps.map((x) => {
      let row = `<div class="prv-row${x.madeCircle ? "" : " late"}"><span class="i">${x.repNo}</span><span class="tm">${fmt(x.timeMs)}</span><span class="dr">${fmtDrop(x.dropMs)}</span><span class="ci">${x.madeCircle ? "◯ 余裕" + fmtCd(x.restMs) + "s" : "× 遅れ"}</span></div>`;
      if (lpr > 1) row += `<div class="prv-laps">${trSegHtml(x)}</div>`;
      return row;
    }).join("");
    return `<div class="prv-sw"><div class="prv-h"><b>第${r.setNo || i + 1}セット</b><span>平均 ${fmt(r.avgMs)}・${reps.length}本</span></div><div class="prv-cap"><span>本</span><span>タイム</span><span>落ち幅</span><span>サークル</span></div>${rows}</div>`;
  }).join("");
  $("#tr-detail").innerHTML = `
    <div class="tr-d-head">${head ? `<b>${escapeHtml(head)}</b>` : ""}<span>${escapeHtml(m.label || "")}${m.name ? `・${escapeHtml(m.name)}` : ""}　/　${recs.length}セット</span></div>
    <div class="tr-stats tr-setstats">${setStats}</div>
    <div class="sec-title">セット平均の推移</div>
    <div class="chart-wrap"><canvas id="tr-chart-setavg"></canvas></div>
    <p class="hint">${driftNote} 最速は第${bestSet.setNo || (recs.indexOf(bestSet) + 1)}セット。</p>
    <div class="sec-title">セットごとの本数比較</div>
    <div class="chart-wrap"><canvas id="tr-chart-setrep"></canvas></div>
    <p class="hint">各セットの本数ごとのタイムを重ねて比較。オレンジ破線はサークルです。</p>
    <div class="sec-title">セット別の記録</div>
    ${blocks}`;
  trDrawSetAvgChart(recs);
  trDrawSetRepChart(recs, m);
}
function trDrawSetAvgChart(recs) {
  if (!window.Chart) return;
  const labels = recs.map((r, i) => `第${r.setNo || i + 1}`);
  chTrSetAvg = new Chart($("#tr-chart-setavg"), { type: "line", data: { labels, datasets: [{ label: "セット平均(秒)", data: recs.map((r) => +((r.avgMs || 0) / 1000).toFixed(2)), borderColor: "#22a06b", backgroundColor: "#22a06b22", tension: 0.2, pointRadius: 6, fill: true }] }, options: chartOpts("秒（小さいほど速い）") });
}
function trDrawSetRepChart(recs, m) {
  if (!window.Chart) return;
  const maxReps = Math.max(...recs.map((r) => (r.reps || []).length), 0);
  const labels = Array.from({ length: maxReps }, (_, j) => `${j + 1}本`);
  const datasets = recs.map((r, i) => ({
    label: `第${r.setNo || i + 1}ｾｯﾄ`,
    data: (r.reps || []).map((x) => +(x.timeMs / 1000).toFixed(2)),
    borderColor: TR_SET_PALETTE[i % TR_SET_PALETTE.length],
    backgroundColor: "transparent", tension: 0.2, pointRadius: 4, fill: false
  }));
  datasets.push({ label: "サークル", data: labels.map(() => +(m.circleMs / 1000).toFixed(2)), borderColor: "#ff7a1a", borderDash: [6, 4], pointRadius: 0, fill: false });
  chTrSetRep = new Chart($("#tr-chart-setrep"), { type: "line", data: { labels, datasets }, options: chartOpts("秒（小さいほど速い）") });
}

// ══ 記録会（フェーズ1：作成・エントリー） ══════════════
function meetList() {
  return Object.entries(meets).map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || "") || (b.createdAt || 0) - (a.createdAt || 0));
}
function currentMeet() { return meets[currentMeetId] || null; }
function meetSchools() { const m = currentMeet(); return [OWN_SCHOOL, ...((m && m.schools) || [])]; }
function allKnownSchools() {
  const set = new Set();
  Object.values(meets).forEach((m) => (m.schools || []).forEach((s) => set.add(s)));
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}
function swimmersOfSchool(school) {
  return memberList().filter((m) => (m.school || OWN_SCHOOL) === school && !m.retired);
}

// 記録会一覧
function renderMeets() {
  const list = meetList();
  $("#meet-list").innerHTML = list.length ? list.map((m) => {
    const n = m.entries ? Object.keys(m.entries).length : 0;
    return `<button class="meet-card" data-meet="${m.id}"><span class="mc-name">${escapeHtml(m.name || "(無題)")}</span><span class="mc-sub">${escapeHtml(m.dateISO || "")}・${m.poolLength === 50 ? "長水路" : "短水路"}・エントリー${n}件</span></button>`;
  }).join("") : `<p class="empty">記録会がありません。「新しい記録会を作成」から追加してください。</p>`;
}

// 記録会の新規作成フォーム
function openMeetNew() {
  newMeetSchools = []; newMeetHasOther = false; meetPoolNew = 50;
  $("#meet-name").value = "";
  $("#meet-date").value = todayISO();
  $$("#meet-pool-seg button").forEach((b) => b.classList.toggle("on", Number(b.dataset.pool) === 50));
  $$("#meet-other-seg button").forEach((b) => b.classList.toggle("on", b.dataset.other === "no"));
  $("#meet-schools-area").hidden = true;
  renderMeetSchools();
  show("screen-meet-new");
}
function renderMeetSchools() {
  $("#meet-schools-list").innerHTML = newMeetSchools.length
    ? newMeetSchools.map((s, i) => `<span class="school-chip">${escapeHtml(s)}<button data-rm-school="${i}" type="button">✕</button></span>`).join("")
    : `<span class="muted">（参加校が未設定）</span>`;
  const past = allKnownSchools().filter((s) => !newMeetSchools.includes(s));
  $("#meet-school-past").innerHTML = `<option value="">過去の学校から追加…</option>` + past.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
}
function addNewMeetSchool(name) {
  name = (name || "").trim();
  if (!name) return;
  if (name === OWN_SCHOOL) { alert("自校はエントリー時に自動で選べます。他校名を入力してください。"); return; }
  if (newMeetSchools.includes(name)) { alert("すでに追加済みです。"); return; }
  newMeetSchools.push(name);
  renderMeetSchools();
}
function createMeet() {
  const name = $("#meet-name").value.trim();
  if (!name) { alert("記録会名を入力してください。"); return; }
  if (newMeetHasOther && !newMeetSchools.length) { alert("他校参加「有」のときは、参加校を1校以上設定してください。"); return; }
  const meet = {
    name, dateISO: $("#meet-date").value || todayISO(), poolLength: meetPoolNew,
    hasOther: newMeetHasOther, schools: newMeetHasOther ? newMeetSchools.slice() : [],
    createdAt: serverTimestamp()
  };
  const r = push(ref(db, MEETS));
  set(r, meet);
  currentMeetId = r.key;
  show("screen-meet"); renderMeet();
}
function deleteMeet() {
  const m = currentMeet(); if (!m) return;
  if (!confirm(`記録会「${m.name}」を削除しますか？\nエントリーも消えます（保存済みの記録は残ります）。`)) return;
  remove(ref(db, `${MEETS}/${currentMeetId}`));
  currentMeetId = null;
  show("screen-meets"); renderMeets();
}

// 記録会のハブ
function isMeetFinished(m) { return (m && (m.dateISO || "")) < todayISO(); }
function renderMeet() {
  const m = currentMeet();
  if (!m) {
    if (guestLink) { $("#meet-title").textContent = meetsLoaded ? "記録会が見つかりません" : "読み込み中…"; $("#meet-meta").textContent = ""; $("#meet-entry-count").textContent = ""; return; }
    show("screen-meets"); renderMeets(); return;
  }
  $("#meet-title").textContent = m.name || "(無題)";
  $("#meet-meta").textContent = `${m.dateISO || ""}・${m.poolLength === 50 ? "長水路" : "短水路"}${m.hasOther && (m.schools || []).length ? `・他校：${m.schools.join("、")}` : ""}`;
  const n = m.entries ? Object.keys(m.entries).length : 0;
  $("#meet-entry-count").textContent = `エントリー ${n}件`;
  const restricted = meetRestricted, finished = isMeetFinished(m), guest = guestLink;
  $("#meet-finished-note").hidden = !finished;
  $("#btn-meet-entry").hidden = finished;
  $("#btn-meet-rec").hidden = finished || guest;
  $("#btn-meet-seed").hidden = restricted || finished;
  $("#btn-meet-delete").hidden = restricted;
  $("#meet-copy-link").hidden = restricted;
  $("#meet-back").style.display = guest ? "none" : "";
}
function resetMeetMode() { meetRestricted = false; guestLink = false; }
function enterRestrictedMeet(id, fromLink) {
  currentMeetId = id; meetRestricted = true; guestLink = !!fromLink;
  show("screen-meet"); renderMeet();
}
function copyMeetLink() {
  const url = `${location.origin}${location.pathname}?m=${currentMeetId}`;
  const done = () => alert("他校用リンクをコピーしました。\nこのリンクからはエントリーとプログラムのみ表示されます。\n\n" + url);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done).catch(() => prompt("コピーできない場合は手動でコピーしてください：", url));
  else prompt("以下のリンクをコピーしてください：", url);
}
// 公開：記録会のエントリー・結果（開始前／終了で分けて表示）
function renderMeetPublic() {
  const today = todayISO();
  const list = meetList();
  const up = list.filter((m) => (m.dateISO || "") >= today);
  const fin = list.filter((m) => (m.dateISO || "") < today);
  const card = (m, done) => `<button class="meet-card${done ? " done" : ""}" data-pubmeet="${m.id}"><span class="mc-name">${done ? "🏁 " : "🏁 "}${escapeHtml(m.name || "(無題)")}</span><span class="mc-sub">${escapeHtml(m.dateISO || "")}・${m.poolLength === 50 ? "長水路" : "短水路"}${done ? "・終了（結果のみ）" : "・エントリー受付中"}</span></button>`;
  $("#pub-upcoming").innerHTML = up.length ? up.map((m) => card(m, false)).join("") : `<p class="empty">開始前の記録会はありません。</p>`;
  $("#pub-finished").innerHTML = fin.length ? fin.map((m) => card(m, true)).join("") : `<p class="empty">終了した記録会はありません。</p>`;
}
// 記録会の計測（スターター／記録者を選ぶ）
function openMeetRec() {
  const m = currentMeet();
  if (!m || !m.program) { alert("先に「組み分け」を実行して確定してください。"); return; }
  if (isMeetFinished(m)) { alert("終了した記録会のため、記録はできません。"); return; }
  timingMeetId = currentMeetId;
  show("screen-meet-rec");
}
function enterTimingStarter() { role = "starter"; syncStarterControls(); show("screen-starter"); onRaceChanged(); }
function enterTimingRecorder() { role = "recorder"; resetRecorderSetup(); show("screen-recorder-setup"); }

// エントリー
function openEntry() { entryKind = "indiv"; show("screen-entry"); renderEntryForm(); renderEntryList(); }
function renderEntryForm() {
  $$("#entry-kind-seg button").forEach((b) => b.classList.toggle("on", b.dataset.ek === entryKind));
  $("#entry-indiv").hidden = entryKind !== "indiv";
  $("#entry-relay").hidden = entryKind !== "relay";
  const optS = meetSchools().map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  $("#ei-school").innerHTML = optS;
  $("#er-school").innerHTML = optS;
  $("#ei-stroke").innerHTML = INDIV_STROKES.map((s) => `<option>${s}</option>`).join("");
  $("#er-stroke").innerHTML = RELAY_STROKES.map((s) => `<option>${s}</option>`).join("");
  onEiStrokeChange(); onErStrokeChange();
  refreshEntrySwimmers(); refreshRelayLegs();
}
function onEiStrokeChange() { const ds = EVENTS[$("#ei-stroke").value] || []; $("#ei-dist").innerHTML = ds.map((d) => `<option value="${d}">${d}m</option>`).join(""); }
function onErStrokeChange() { const ds = EVENTS[$("#er-stroke").value] || []; $("#er-dist").innerHTML = ds.map((d) => `<option value="${d}">${d}m</option>`).join(""); }
function refreshEntrySwimmers() {
  const sel = $("#ei-swimmer"); if (!sel) return;
  const school = $("#ei-school").value;
  const isOwn = school === OWN_SCHOOL;
  const prev = sel.value;
  const sw = swimmersOfSchool(school);
  sel.innerHTML = `<option value="">— 氏名を選択 —</option>`
    + sw.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年）</option>`).join("")
    + (isOwn ? "" : `<option value="__guest">＋ 新規ゲスト登録</option>`);
  const want = pendingEntrySwimmer || prev;
  if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
  pendingEntrySwimmer = null;
  onEiSwimmerChange();
}
function onEiSwimmerChange() { $("#ei-guest-fields").hidden = $("#ei-swimmer").value !== "__guest"; }
function refreshRelayLegs() {
  const sw = swimmersOfSchool($("#er-school").value);
  const opts = `<option value="">— 選択 —</option>` + sw.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年）</option>`).join("");
  $$(".er-leg").forEach((sel) => { const cur = sel.value; sel.innerHTML = opts; sel.value = cur; });
}
function addIndivEntry() {
  if (!currentMeet()) return;
  const school = $("#ei-school").value, stroke = $("#ei-stroke").value, distance = Number($("#ei-dist").value);
  const seedMs = parseTime($("#ei-seed").value.trim());
  let memberId = null, name = "", grade = null, gender = "";
  const sv = $("#ei-swimmer").value;
  if (sv === "__guest") {
    name = $("#ei-guest-name").value.trim();
    grade = Number($("#ei-guest-grade").value); gender = $("#ei-guest-gender").value;
    if (!name) { alert("ゲストの氏名を入力してください。"); return; }
  } else {
    if (!sv || !members[sv]) { alert("氏名を選択してください。"); return; }
    const mm = members[sv]; memberId = sv; name = mm.name; grade = mm.grade; gender = mm.gender;
  }
  if (!stroke || !distance) { alert("種目と距離を選んでください。"); return; }
  if (seedMs == null || seedMs <= 0) { alert("エントリータイムの形式が正しくありません。\n例：28.55 または 1:05.33"); $("#ei-seed").focus(); return; }
  if (sv === "__guest") { const gref = push(ref(db, MEMBERS)); set(gref, { name, grade, gender, school, guest: true, createdAt: serverTimestamp() }); memberId = gref.key; pendingEntrySwimmer = gref.key; }
  const entry = { isRelay: false, school, memberId, name, grade, gender, stroke, distance, seedMs, createdAt: serverTimestamp() };
  // 同一人物・同一種目×距離は重複させず更新
  const ex = currentMeet().entries || {};
  let dupId = null;
  Object.entries(ex).forEach(([id, e]) => { if (!e.isRelay && e.memberId && e.memberId === memberId && e.stroke === stroke && Number(e.distance) === distance) dupId = id; });
  if (dupId) { update(ref(db, `${MEETS}/${currentMeetId}/entries/${dupId}`), entry); toast("エントリーを更新しました"); }
  else { set(push(ref(db, `${MEETS}/${currentMeetId}/entries`)), entry); toast("エントリーを追加しました"); }
  $("#ei-seed").value = ""; $("#ei-guest-name").value = "";
  if (sv === "__guest") { $("#ei-swimmer").value = ""; $("#ei-guest-fields").hidden = true; }
  $("#ei-seed").focus();
  renderEntryList();
}
function addRelayEntry() {
  if (!currentMeet()) return;
  const school = $("#er-school").value, stroke = $("#er-stroke").value, distance = Number($("#er-dist").value);
  const seedMs = parseTime($("#er-seed").value.trim());
  const raw = $$(".er-leg").map((s) => s.value);
  if (raw.some((v) => !v)) { alert("第1〜第4泳者をすべて選択してください。"); return; }
  if (new Set(raw).size !== 4) { alert("同じ選手が重複しています。"); return; }
  if (!distance) { alert("距離を選んでください。"); return; }
  if (seedMs == null || seedMs <= 0) { alert("エントリータイムの形式が正しくありません。\n例：1:45.20"); $("#er-seed").focus(); return; }
  const legs = raw.map((id, i) => { const mm = members[id]; return { memberId: id, name: mm.name, grade: mm.grade, gender: mm.gender, legStroke: stroke === "メドレーリレー" ? MEDLEY_ORDER[i] : "自由形" }; });
  const entry = { isRelay: true, school, stroke, distance, seedMs, legs, name: legs.map((l) => l.name).join("→"), createdAt: serverTimestamp() };
  set(push(ref(db, `${MEETS}/${currentMeetId}/entries`)), entry);
  toast("リレーを追加しました");
  $("#er-seed").value = ""; $$(".er-leg").forEach((s) => (s.value = ""));
  renderEntryList();
}
function renderEntryList() {
  const m = currentMeet();
  const entries = m && m.entries ? Object.entries(m.entries).map(([id, e]) => ({ id, ...e })) : [];
  entries.sort((a, b) => (a.distance - b.distance) || String(a.stroke).localeCompare(b.stroke) || (a.seedMs - b.seedMs));
  $("#entry-count2").textContent = `エントリー ${entries.length}件`;
  $("#entry-list").innerHTML = entries.length ? entries.map((e) => {
    const ev = `${e.stroke} ${e.distance}m`;
    const who = e.isRelay
      ? `🏊 ${escapeHtml(e.school)}（${e.legs.map((l) => escapeHtml(l.name)).join("・")}）`
      : `${escapeHtml(e.name)}（${escapeHtml(e.school)}）`;
    return `<div class="entry-row"><div class="er-main"><span class="er-ev">${ev}</span><span class="er-who">${who}</span></div><div class="er-right"><span class="er-seed">${fmt(e.seedMs)}</span><button class="er-del" data-del-entry="${e.id}">削除</button></div></div>`;
  }).join("") : `<p class="empty">まだエントリーがありません。</p>`;
}
function deleteEntry(id) {
  if (!confirm("このエントリーを削除しますか？")) return;
  remove(ref(db, `${MEETS}/${currentMeetId}/entries/${id}`));
  renderEntryList();
}
let _toastTimer = null;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ══ 記録会（フェーズ2：自動シード・プログラム） ══════════
const LANE_PRIORITY = [3, 4, 2, 5, 1, 6];   // 速い順に割り当てるレーン（中央→外、6レーン）
const STROKE_ORDER = ["自由形", "平泳ぎ", "背泳ぎ", "バタフライ", "個人メドレー", "フリーリレー", "メドレーリレー"];
function cmpArr(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; }
function strokeOrderIndex(s) { const i = STROKE_ORDER.indexOf(s); return i < 0 ? 99 : i; }

function seedMeet() {
  const m = currentMeet(); if (!m) return;
  const entries = Object.entries(m.entries || {}).map(([id, e]) => ({ id, ...e }));
  if (!entries.length) { alert("エントリーがありません。先にエントリーを追加してください。"); return; }
  if (m.program && !confirm("すでに組み分け済みです。作り直しますか？\n（記録が入っている場合は消えます）")) return;

  const indivEvents = {}, relayEvents = {};
  entries.forEach((e) => { const map = e.isRelay ? relayEvents : indivEvents; (map[`${e.stroke}|${e.distance}`] ||= []).push(e); });

  let races = [];
  function buildHeats(list, isRelay) {
    const k = list.length, numHeats = Math.ceil(k / 6);
    const base = Math.floor(k / numHeats), rem = k - base * numHeats;
    const sizes = []; for (let i = 0; i < numHeats; i++) sizes.push(base + (i < rem ? 1 : 0));
    const slow = list.slice().sort((a, b) => b.seedMs - a.seedMs);    // 遅い順
    let idx = 0;
    for (let h = 0; h < numHeats; h++) {
      const group = slow.slice(idx, idx + sizes[h]); idx += sizes[h];
      const byFast = group.slice().sort((a, b) => a.seedMs - b.seedMs); // 速い→中央
      const lanes = {};
      byFast.forEach((e, i) => { lanes[LANE_PRIORITY[i]] = e; });
      races.push({ lanes, eventKey: `${list[0].stroke}|${list[0].distance}`, stroke: list[0].stroke, distance: list[0].distance, heatIndex: h, isRelay });
    }
  }
  Object.values(indivEvents).forEach((list) => buildHeats(list, false));
  Object.values(relayEvents).forEach((list) => buildHeats(list, true));

  // 1人だけの個人種目 → 同じ距離のレースの空きレーンへ。なければ単独レース。
  const lone = [];
  Object.values(indivEvents).forEach((list) => { if (list.length === 1) lone.push(list[0]); });
  races = races.filter((r) => !(!r.isRelay && indivEvents[r.eventKey] && indivEvents[r.eventKey].length === 1));
  lone.forEach((e) => {
    const target = races.find((r) => !r.isRelay && r.distance === e.distance && Object.keys(r.lanes).length < 6);
    if (target) {
      const used = new Set(Object.keys(target.lanes).map(Number));
      const emptyLane = [...LANE_PRIORITY].reverse().find((L) => !used.has(L));
      target.lanes[emptyLane] = e;
    } else {
      races.push({ lanes: { 3: e }, eventKey: `${e.stroke}|${e.distance}`, stroke: e.stroke, distance: e.distance, heatIndex: 0, isRelay: false });
    }
  });

  // 並び順（既定）：個人→リレー、泳法順、距離昇順、各種目は遅い組から
  races.forEach((r) => { r._order = [r.isRelay ? 1 : 0, strokeOrderIndex(r.stroke), r.distance, r.heatIndex]; });
  const remaining = races.slice().sort((a, b) => cmpArr(a._order, b._order));
  const membersOf = (r) => { const s = new Set(); Object.values(r.lanes).forEach((e) => { if (e.isRelay) (e.legs || []).forEach((l) => l.memberId && s.add(l.memberId)); else if (e.memberId) s.add(e.memberId); }); return s; };
  const ready = (r) => r.heatIndex === 0 || !remaining.some((x) => x !== r && x.eventKey === r.eventKey && x.heatIndex < r.heatIndex);
  const placed = []; const last2 = [];   // 直近2レースの選手集合（連続出場を避ける）
  const penalty = (r) => {
    const m = membersOf(r);
    const p1 = last2[last2.length - 1] || new Set();        // 直前レース
    const p2 = last2.length > 1 ? last2[0] : new Set();     // 2つ前レース
    let p = 0; for (const id of m) { if (p1.has(id)) p += 100; else if (p2.has(id)) p += 10; }
    return p;
  };
  while (remaining.length) {
    const readyList = remaining.filter(ready);
    let best = null, bestKey = null;
    readyList.forEach((r) => { const key = [penalty(r), ...r._order]; if (!best || cmpArr(key, bestKey) < 0) { best = r; bestKey = key; } });
    const pick = best || remaining[0];
    placed.push(pick); remaining.splice(remaining.indexOf(pick), 1);
    last2.push(membersOf(pick)); if (last2.length > 2) last2.shift();
  }

  draftProgram = placed.map((r, i) => {
    const strokes = new Set(Object.values(r.lanes).map((e) => e.stroke));
    const lanes = {};
    Object.entries(r.lanes).forEach(([L, e]) => {
      lanes[L] = { entryId: e.id, name: e.name || "", school: e.school || "", stroke: e.stroke, distance: e.distance, seedMs: e.seedMs, isRelay: !!e.isRelay, memberId: e.memberId || null, legs: e.legs || null };
    });
    return { raceNo: i + 1, distance: r.distance, label: strokes.size === 1 ? [...strokes][0] : "混合", isRelay: !!r.isRelay, lanes };
  });
  programEditMode = true; editSel = null;
  toast("組み分けを作成しました。入れ替えて『確定』してください");
  show("screen-program"); renderProgram();
}

function programRaces() { const m = currentMeet(); const p = m && m.program; if (!p || !p.races) return []; return Array.isArray(p.races) ? p.races.filter(Boolean) : Object.values(p.races); }
function cloneRaces(list) { return JSON.parse(JSON.stringify(list)); }
function openProgram() {
  const m = currentMeet(); if (!m) return;
  if (!m.program) { alert("まだ組み分けされていません。「組み分け」を実行してください。"); return; }
  programEditMode = false; draftProgram = null; editSel = null; programTab = "program";
  show("screen-program"); renderProgram();
}
function enterProgramEdit() {
  draftProgram = cloneRaces(programRaces()); programEditMode = true; editSel = null; renderProgram();
}
function cancelProgramEdit() {
  programEditMode = false; draftProgram = null; editSel = null;
  if (currentMeet() && currentMeet().program) renderProgram();
  else { show("screen-meet"); renderMeet(); }
}
function recomputeLabel(r) { const st = new Set(Object.values(r.lanes).map((e) => e.stroke)); r.label = st.size <= 1 ? ([...st][0] || r.label) : "混合"; }
function swapLanes(aIdx, aLane, bIdx, bLane) {
  const A = draftProgram[aIdx], B = draftProgram[bIdx];
  const av = A.lanes[aLane] || null, bv = B.lanes[bLane] || null;
  if (bv) A.lanes[aLane] = bv; else delete A.lanes[aLane];
  if (av) B.lanes[bLane] = av; else delete B.lanes[bLane];
  recomputeLabel(A); recomputeLabel(B);
}
function onLaneTap(ridx, lane) {
  if (!editSel) { editSel = { ridx, lane }; renderProgram(); return; }
  if (editSel.ridx === ridx && editSel.lane === lane) { editSel = null; renderProgram(); return; }
  if (draftProgram[editSel.ridx].distance !== draftProgram[ridx].distance) { toast("距離が異なるため入れ替えできません"); editSel = null; renderProgram(); return; }
  swapLanes(editSel.ridx, editSel.lane, ridx, lane);
  editSel = null; renderProgram();
}
function confirmProgram() {
  const races = (draftProgram || []).filter((r) => Object.keys(r.lanes).length > 0)
    .map((r, i) => ({ raceNo: i + 1, distance: r.distance, label: r.label, isRelay: !!r.isRelay, lanes: r.lanes }));
  set(ref(db, `${MEETS}/${currentMeetId}/program`), { seededAt: serverTimestamp(), races });
  programEditMode = false; draftProgram = null; editSel = null;
  toast("プログラムを確定しました");
  renderProgram();
}
function meetResults() { const m = currentMeet(); return (m && m.results) || {}; }
function isSelfBest(r) {
  const m = currentMeet(); if (!m || !r || r.isRelay || !r.memberId) return false;
  const recs = allRecs().filter((x) => !x.isRelay && x.memberId === r.memberId && x.stroke === r.stroke && Number(x.distance) === Number(r.distance) && x.poolLength === m.poolLength);
  if (!recs.length) return false;
  return r.finalMs <= Math.min(...recs.map((x) => x.finalMs)) + 1;
}
function renderProgram() {
  const m = currentMeet();
  const edit = programEditMode;
  $("#program-title").textContent = m ? `${m.name}` : "プログラム";
  $("#program-tabs").hidden = edit;
  $$("#program-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.ptab === programTab));
  $("#program-edit-bar").hidden = !edit;
  $("#program-edit-btn").hidden = edit || meetRestricted || programTab !== "program" || !(m && m.program);
  if (!edit && programTab === "results") { renderResults(); return; }

  const races = edit ? (draftProgram || []) : programRaces();
  const res = meetResults();
  $("#program-list").innerHTML = races.length ? races.map((r, ri) => {
    let rows = "";
    for (let L = 1; L <= 6; L++) {
      const e = r.lanes && r.lanes[L];
      const sel = edit && editSel && editSel.ridx === ri && editSel.lane === L;
      const attr = edit ? ` data-ridx="${ri}" data-lane="${L}"` : "";
      let resultCell = edit ? "" : "—";
      if (!edit && e && e.entryId && res[e.entryId]) { const rr = res[e.entryId]; resultCell = `${fmt(rr.finalMs)}${isSelfBest({ ...e, finalMs: rr.finalMs }) ? " 🏅" : ""}`; }
      rows += `<div class="prow${e ? "" : " empty"}${sel ? " sel" : ""}${edit ? " tap" : ""}"${attr}><span class="plane">${L}</span>`
        + (e
          ? `<span class="pname">${escapeHtml(e.name)}${e.isRelay ? "" : `<span class="psch">${escapeHtml(e.school || "")}</span>`}${e.stroke !== r.label ? `<span class="pst">${escapeHtml(e.stroke)}</span>` : ""}</span><span class="pseed">${fmt(e.seedMs)}</span><span class="presult">${resultCell}</span>`
          : `<span class="pname muted">―</span><span class="pseed"></span><span class="presult"></span>`)
        + `</div>`;
    }
    return `<div class="prace${edit ? " editable" : ""}"><div class="prace-head"><span class="pno">第${r.raceNo}レース</span><span class="pev">${r.distance}m ${escapeHtml(r.label)}</span></div>${rows}</div>`;
  }).join("") : `<p class="empty">レースがありません。</p>`;
}
function renderResults() {
  const m = currentMeet();
  const res = Object.entries(meetResults()).map(([entryId, r]) => ({ entryId, ...r }));
  if (!res.length) { $("#program-list").innerHTML = `<p class="empty">まだ記録がありません。レースを計測して保存すると、ここに種目別の順位が表示されます。</p>`; return; }
  const groups = {};
  res.forEach((r) => { const k = `${r.isRelay ? "R" : "I"}|${r.stroke}|${r.distance}`; (groups[k] ||= []).push(r); });
  const keys = Object.keys(groups).sort((a, b) => {
    const [ta, sa, da] = a.split("|"), [tb, sb, db_] = b.split("|");
    return (ta === tb ? 0 : ta === "I" ? -1 : 1) || strokeOrderIndex(sa) - strokeOrderIndex(sb) || Number(da) - Number(db_);
  });
  $("#program-list").innerHTML = keys.map((k) => {
    const list = groups[k].slice().sort((a, b) => a.finalMs - b.finalMs);
    const [, stroke, dist] = k.split("|");
    const rows = list.map((r, i) => {
      const medal = i === 0 ? "rk1" : i === 1 ? "rk2" : i === 2 ? "rk3" : "";
      const best = isSelfBest(r) ? ' <span class="pb">🏅自己ベスト</span>' : "";
      const who = r.isRelay ? `${escapeHtml(r.school || "")}（${(r.legs || []).map((l) => escapeHtml(l.name)).join("・")}）` : `${escapeHtml(r.name)}<span class="rsch">${escapeHtml(r.school || "")}</span>`;
      return `<div class="rrow"><span class="rrank ${medal}">${i + 1}</span><span class="rwho">${who}${best}</span><span class="rtime">${fmt(r.finalMs)}</span></div>`;
    }).join("");
    return `<div class="revent"><div class="revent-head">${dist}m ${escapeHtml(stroke)}</div>${rows}</div>`;
  }).join("");
}

// ── イベント結線 ───────────────────────────────────────
$$("#screen-role .role-btn").forEach((b) => b.addEventListener("click", () => {
  role = b.dataset.role; timingMeetId = null; mode = "practice";
  if (role === "starter") { ensureReady(); syncStarterControls(); show("screen-starter"); onRaceChanged(); }
  else { resetRecorderSetup(); show("screen-recorder-setup"); }
}));

$$("[data-go]").forEach((b) => b.addEventListener("click", async () => {
  const t = b.dataset.go;
  if (!(await requireUnlock())) return;  // バックオフィスはパスワード
  role = null; myLane = null;
  if (t === "members") { renderMembers(); show("screen-members"); }
  if (t === "records") { renderRecordsAll(); show("screen-records"); }
  if (t === "meets") { renderMeets(); show("screen-meets"); }
  if (t === "menu") { enterMenuBuilder(); }
}));

$$("[data-back]").forEach((b) => b.addEventListener("click", () => {
  if (role === "recorder" && !$("#screen-recorder").hidden) { resetRecorderSetup(); show("screen-recorder-setup"); return; }
  role = null; myLane = null; timingMeetId = null;
  show("screen-role");
}));

// 記録会：ナビ
$("#btn-meet-new").addEventListener("click", openMeetNew);
$("#meet-new-back").addEventListener("click", () => { show("screen-meets"); renderMeets(); });
$("#meet-back").addEventListener("click", () => {
  if (meetRestricted && !guestLink) { resetMeetMode(); show("screen-meet-public"); renderMeetPublic(); return; }
  resetMeetMode(); show("screen-meets"); renderMeets();
});
$("#entry-back").addEventListener("click", () => { show("screen-meet"); renderMeet(); });
$("#btn-meet-create").addEventListener("click", createMeet);
$("#btn-meet-delete").addEventListener("click", deleteMeet);
$("#btn-meet-entry").addEventListener("click", openEntry);
$("#btn-meet-rec").addEventListener("click", openMeetRec);
$("#btn-meet-seed").addEventListener("click", seedMeet);
$("#btn-meet-program").addEventListener("click", openProgram);
$("#program-back").addEventListener("click", () => { if (programEditMode) cancelProgramEdit(); else { show("screen-meet"); renderMeet(); } });
$("#program-edit-btn").addEventListener("click", enterProgramEdit);
$("#btn-program-confirm").addEventListener("click", confirmProgram);
$("#btn-program-cancel").addEventListener("click", cancelProgramEdit);
$("#program-list").addEventListener("click", (e) => {
  if (!programEditMode) return;
  const row = e.target.closest("[data-lane]"); if (!row) return;
  onLaneTap(Number(row.dataset.ridx), Number(row.dataset.lane));
});
$("#program-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; programTab = b.dataset.ptab; renderProgram(); });
$("#btn-sm-load").addEventListener("click", loadMeetRace);
$("#meet-copy-link").addEventListener("click", copyMeetLink);
$("#meet-list").addEventListener("click", (e) => { const b = e.target.closest("[data-meet]"); if (!b) return; resetMeetMode(); currentMeetId = b.dataset.meet; show("screen-meet"); renderMeet(); });
// 公開：記録会のエントリー・結果
$("#btn-meetpub").addEventListener("click", () => { renderMeetPublic(); show("screen-meet-public"); });
$("#meetpub-back").addEventListener("click", () => { show("screen-role"); });
$("#screen-meet-public").addEventListener("click", (e) => { const b = e.target.closest("[data-pubmeet]"); if (!b) return; enterRestrictedMeet(b.dataset.pubmeet, false); });
// 記録会の計測（役割選択）
$("#mrec-back").addEventListener("click", () => { show("screen-meet"); renderMeet(); });
$("#mrec-starter").addEventListener("click", enterTimingStarter);
$("#mrec-recorder").addEventListener("click", enterTimingRecorder);
// メンバー：ゲスト表示切替
$("#show-guests").addEventListener("change", (e) => { showGuests = e.target.checked; renderMembers(); });
// 記録会：新規作成フォーム
$("#meet-pool-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; meetPoolNew = Number(b.dataset.pool); $$("#meet-pool-seg button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#meet-other-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; newMeetHasOther = b.dataset.other === "yes"; $$("#meet-other-seg button").forEach((x) => x.classList.toggle("on", x === b)); $("#meet-schools-area").hidden = !newMeetHasOther; });
$("#meet-school-add").addEventListener("click", () => { addNewMeetSchool($("#meet-school-input").value); $("#meet-school-input").value = ""; });
$("#meet-school-past").addEventListener("change", (e) => { if (e.target.value) { addNewMeetSchool(e.target.value); e.target.value = ""; } });
$("#meet-schools-list").addEventListener("click", (e) => { const b = e.target.closest("[data-rm-school]"); if (!b) return; newMeetSchools.splice(Number(b.dataset.rmSchool), 1); renderMeetSchools(); });
// エントリー
$("#entry-kind-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; entryKind = b.dataset.ek; renderEntryForm(); });
$("#ei-school").addEventListener("change", refreshEntrySwimmers);
$("#ei-stroke").addEventListener("change", onEiStrokeChange);
$("#ei-swimmer").addEventListener("change", onEiSwimmerChange);
$("#er-school").addEventListener("change", refreshRelayLegs);
$("#er-stroke").addEventListener("change", onErStrokeChange);
$("#btn-add-indiv").addEventListener("click", addIndivEntry);
$("#btn-add-relay").addEventListener("click", addRelayEntry);
$("#entry-list").addEventListener("click", (e) => { const b = e.target.closest("[data-del-entry]"); if (b) deleteEntry(b.dataset.delEntry); });

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
$("#btn-rec-save").addEventListener("click", saveFinished);
$("#btn-rec-next").addEventListener("click", nextRecord);
$("#modal-cancel").addEventListener("click", () => { $("#unsaved-modal").hidden = true; });
$("#modal-proceed").addEventListener("click", leaveFinished);

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
$("#rec-show-retired").addEventListener("change", (e) => { showRetiredRec = e.target.checked; populateFilter(); });
$("#relay-gender").addEventListener("change", (e) => { relayGenderF = e.target.value; renderRelay(); });
$("#relay-year").addEventListener("change", (e) => { relayYearF = Number(e.target.value); renderRelay(); });
$("#btn-backfill-relay").addEventListener("click", backfillFirstLeg);
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

// 練習計測
$("#btn-practice").addEventListener("click", enterPracticeSetup);
// 画面1：選手選択
$("#ps-back").addEventListener("click", trExitPractice);
$("#ps-add").addEventListener("change", (e) => { if (e.target.value) { psAddSwimmer(e.target.value); e.target.value = ""; } });
$("#ps-order").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-ps-rm]"); if (rm) return psRemoveSwimmer(Number(rm.dataset.psRm));
  const up = e.target.closest("[data-ps-up]"); if (up) return psMoveSwimmer(Number(up.dataset.psUp), -1);
  const dn = e.target.closest("[data-ps-dn]"); if (dn) return psMoveSwimmer(Number(dn.dataset.psDn), 1);
});
$("#btn-ps-begin").addEventListener("click", enterMenuPick);
// 設定モーダル（出発間隔・プール）
$("#ps-settings-btn").addEventListener("click", openPsSettings);
$("#pm-settings-btn").addEventListener("click", openPsSettings);
$("#set-pool").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; psSession.poolLength = Number(b.dataset.pool); $$("#set-pool button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#set-close").addEventListener("click", closePsSettings);
// 画面2：メニュー選択
$("#pm-back").addEventListener("click", enterPracticeSetup);
$("#pm-date").addEventListener("change", (e) => { psSession.menuDate = e.target.value || todayISO(); renderMenuPick(); });
$("#pm-table").addEventListener("click", (e) => { const r = e.target.closest("[data-pm-row]"); if (r) pmSelectItem(r.dataset.pmRow); });
$("#pm-type").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pmStroke = b.dataset.type; $$("#pm-type button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#pm-lap").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pmLapDist = Number(b.dataset.lapd); $$("#pm-lap button").forEach((x) => x.classList.toggle("on", x === b)); });
$("#btn-pm-begin").addEventListener("click", pmBegin);
// 画面3：計測
$("#btn-pr-start").addEventListener("click", (e) => { if (e.currentTarget.dataset.next === "1") trNextSet(); else trStart(); });
$("#btn-pr-undo").addEventListener("click", trUndo);
$("#btn-pr-end").addEventListener("click", trEnd);
$("#pr-cards").addEventListener("click", (e) => { const c = e.target.closest("[data-pr-si]"); if (c) trPress(Number(c.dataset.prSi)); });
$("#pr-back").addEventListener("click", trBackFromRun);
$("#btn-prv-save").addEventListener("click", trSave);
$("#btn-prv-discard").addEventListener("click", trDiscard);
$("#prv-back").addEventListener("click", () => { show("screen-practice-run"); });

// 練習分析
$("#tr-filter").addEventListener("change", (e) => { trFilter = e.target.value; trDate = ""; trMenuId = null; trCalYM = null; renderTraining(); });
$("#tr-dates").addEventListener("click", (e) => {
  const nav = e.target.closest("[data-tc-nav]"); if (nav) { trCalShift(Number(nav.dataset.tcNav)); return; }
  const b = e.target.closest("[data-tr-date]"); if (!b) return;
  trDate = b.dataset.trDate; trMenuId = null; renderTraining();
});
$("#tr-menus").addEventListener("click", (e) => { const b = e.target.closest("[data-tr-menu]"); if (!b) return; trMenuId = (trMenuId === b.dataset.trMenu) ? null : b.dataset.trMenu; renderTraining(); });

// 練習メニュー作成
$("#mb-back").addEventListener("click", () => { mbCloseForm(); show("screen-role"); });
$("#mb-date").addEventListener("change", (e) => { mbDate = e.target.value || todayISO(); mbCloseForm(); renderMenuBuilder(); });
$("#mb-add").addEventListener("click", () => mbOpenForm(null));
$("#mb-cancel").addEventListener("click", mbCloseForm);
$("#mb-commit").addEventListener("click", mbCommit);
$("#mb-type").addEventListener("change", () => { $("#mb-meas").checked = !MENU_NOMEAS.includes($("#mb-type").value); });
$("#mb-table").addEventListener("click", (e) => {
  const row = e.target.closest("[data-mb-row]"); if (!row) return;
  mbOpenForm(row.dataset.mbRow);
});
$("#mb-mv-up").addEventListener("click", () => { if (mbEditingId) mbMoveItem(mbEditingId, -1); });
$("#mb-mv-dn").addEventListener("click", () => { if (mbEditingId) mbMoveItem(mbEditingId, 1); });
$("#mb-del").addEventListener("click", () => { if (mbEditingId) mbDeleteItem(mbEditingId); });

show("screen-role");

// 他校用リンク（?m=記録会ID）で入った場合は、制限ビューへ
(function initFromURL() {
  const m = new URLSearchParams(location.search).get("m");
  if (!m) return;
  currentMeetId = m; meetRestricted = true; guestLink = true;
  $("#meet-title").textContent = "読み込み中…"; $("#meet-meta").textContent = ""; $("#meet-entry-count").textContent = "";
  $("#btn-meet-seed").hidden = true; $("#btn-meet-delete").hidden = true; $("#meet-copy-link").hidden = true; $("#meet-back").style.display = "none";
  show("screen-meet");
})();
