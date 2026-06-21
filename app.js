// ───────────────────────────────────────────────────────────
// 競泳タイマー（PoC / フェーズ2）
// 肝：スターターが押した「ピッ」の瞬間を T0（サーバー時刻）として共有し、
//     各端末は (自分が押した瞬間 + 自分のズレ) − T0 で経過時間を出す。
// 追加：メンバー名簿、名簿からの選手選択（折り返し側は自動表示）、
//      練習記録の保存と一覧表示。保存先は Realtime Database。
// ───────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getDatabase, ref, onValue, set, update, push, child, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

import { firebaseConfig, START_LEAD_MS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

const RACE    = "session/race";       // ライブのレース状態
const MEMBERS = "members";            // メンバー名簿
const RESULTS = "practiceResults";    // 練習記録

// ── 状態 ────────────────────────────────────────────────
let serverOffset = 0;
let connected = false;
let role = null;            // 'starter' | 'recorder' | null
let myLane = null;
let ringHere = false;
let lastBeepRaceId = null;
let race = null;
let members = {};           // { id: {name,grade,gender,school,guest} }
let results = {};           // { id: {...} }
let pendingSwimmer = null;   // 記録開始前に決めた選手
let savedSig = null;         // 二重保存防止用の署名

const serverNow = () => Date.now() + serverOffset;
const todayISO = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ── 発進音の設定（端末に記憶） ──────────────────────────
const DEFAULT_PITCH = 1380;
const BEEP_DUR = 0.14;
const DEFAULT_VOL = 1.0;

const PITCH_MIN = 800, PITCH_MAX = 2500;
const clampPitch = (n) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(n) || DEFAULT_PITCH));
function loadPitch() {
  try { const v = localStorage.getItem("beepHz"); if (v) return clampPitch(Number(v)); } catch (e) {}
  return DEFAULT_PITCH;
}
function savePitch(hz) { try { localStorage.setItem("beepHz", String(hz)); } catch (e) {} }
let beepHz = loadPitch();

const VOL_MIN = 0.2, VOL_MAX = 2.0;
const clampVol = (n) => Math.min(VOL_MAX, Math.max(VOL_MIN, isNaN(n) ? DEFAULT_VOL : n));
function loadVol() {
  try { const v = localStorage.getItem("beepVol"); if (v) return clampVol(Number(v)); } catch (e) {}
  return DEFAULT_VOL;
}
function saveVol(v) { try { localStorage.setItem("beepVol", String(v)); } catch (e) {} }
let beepVol = loadVol();

// ── 時間の整形（カンマ2秒・競泳式に切り捨て） ───────────────
function fmt(ms) {
  if (ms == null || ms < 0) ms = 0;
  const cs = Math.floor(ms / 10);
  const c  = cs % 100;
  const totalSec = Math.floor(cs / 100);
  const s  = totalSec % 60;
  const m  = Math.floor(totalSec / 60);
  const cc = String(c).padStart(2, "0");
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}.${cc}`;
  return `${s}.${cc}`;
}
function fmtClock(epochMs) {
  const d  = new Date(epochMs);
  const cc = String(Math.floor((epochMs % 1000) / 10)).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}.${cc}`;
}

// ── 発進音（Web Audio） ─────────────────────────────────
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function scheduleBeepAt(targetEpochMs, doFlash = true) {
  if (!audioCtx) return;
  const leadSec = Math.max(0, (targetEpochMs - Date.now()) / 1000);
  const when = audioCtx.currentTime + leadSec;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = beepHz;
  const dur = BEEP_DUR, vol = beepVol;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(vol, when + 0.004);
  gain.gain.setValueAtTime(vol, when + Math.max(0.01, dur - 0.03));
  gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  if (doFlash) setTimeout(fireFlash, Math.max(0, targetEpochMs - Date.now()));
}
function fireFlash() {
  const f = $("#flash");
  f.classList.remove("fire"); void f.offsetWidth; f.classList.add("fire");
}

// ── DOMヘルパ ──────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function show(id) {
  $$(".screen").forEach((el) => (el.hidden = true));
  $("#" + id).hidden = false;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── RTDB購読 ───────────────────────────────────────────
onValue(ref(db, ".info/serverTimeOffset"), (s) => {
  serverOffset = s.val() || 0;
  $("#offset-val").textContent = Math.round(serverOffset);
});
onValue(ref(db, ".info/connected"), (s) => {
  connected = !!s.val();
  $("#conn-dot").classList.toggle("on", connected);
  $("#conn-text").textContent = connected ? "接続OK" : "未接続";
});
onValue(ref(db, RACE), (s) => { race = s.val(); onRaceChanged(); });
onValue(ref(db, MEMBERS), (s) => {
  members = s.val() || {};
  if (!$("#screen-members").hidden) renderMembers();
  populatePicker();
});
onValue(ref(db, RESULTS), (s) => {
  results = s.val() || {};
  if (!$("#screen-records").hidden) renderRecords();
});

// ── スターター操作 ─────────────────────────────────────
let pool = 25;

function arm() {
  ensureAudio();
  set(ref(db, RACE), {
    state: "armed", raceId: "r" + Date.now().toString(36), poolLength: pool,
    startServerTime: null, armedAt: serverTimestamp(), lanes: null
  });
}
function start() {
  ensureAudio();
  if (!race || race.state !== "armed") return;
  const t0Local  = Date.now() + START_LEAD_MS;
  const T0Server = t0Local + serverOffset;
  scheduleBeepAt(t0Local);
  update(ref(db, RACE), { state: "running", startServerTime: T0Server, startedAt: serverTimestamp() });
}
// 次の組へ：選手は残し、ラップだけ消す
function rearm() {
  if (!race) return;
  const upd = { state: "armed", startServerTime: null, raceId: "r" + Date.now().toString(36) };
  const lanes = race.lanes || {};
  Object.keys(lanes).forEach((L) => { upd[`lanes/${L}/splits`] = null; });
  update(ref(db, RACE), upd);
}
function cancel() { set(ref(db, RACE), { state: "idle" }); }

// ── 記録者操作 ─────────────────────────────────────────
function recordSplit() {
  if (!race || race.state !== "running" || race.startServerTime == null) return;
  const elapsed = serverNow() - race.startServerTime;
  if (elapsed < 0) return;
  const node = push(child(ref(db, RACE), `lanes/${myLane}/splits`));
  set(node, { elapsedMs: Math.round(elapsed), at: serverTimestamp() });
}

function laneSplitsArr(lane) {
  const o = race?.lanes?.[lane]?.splits || {};
  return Object.values(o).sort((a, b) => a.elapsedMs - b.elapsedMs);
}

function saveResult() {
  const lane = race?.lanes?.[myLane];
  const arr = laneSplitsArr(myLane);
  if (!lane?.name || !arr.length) return;
  const rec = {
    memberId: lane.memberId || null,
    name: lane.name,
    school: lane.school || "",
    dateISO: todayISO(),
    lane: myLane,
    poolLength: race.poolLength || null,
    splits: arr.map((s) => s.elapsedMs),
    finalMs: arr[arr.length - 1].elapsedMs,
    createdAt: serverTimestamp()
  };
  set(push(ref(db, RESULTS)), rec);
  savedSig = `${race.raceId}:${arr.length}`;
  $("#saved-msg").hidden = false;
  $("#btn-save").disabled = true;
}

// ── 画面更新 ───────────────────────────────────────────
function onRaceChanged() {
  if (role === "starter") {
    const st = race?.state || "idle";
    const map = { idle: "準備前", armed: "準備OK（記録者を待機）", running: "計測中" };
    $("#starter-state").textContent = map[st] || st;
    $("#btn-arm").hidden         = st !== "idle";
    $("#btn-start").hidden       = st !== "armed";
    $("#btn-cancel").hidden      = st !== "armed";
    $("#running-actions").hidden = st !== "running";
    $("#starter-clock").hidden   = st !== "running";
    $("#starter-lanes").hidden   = st === "idle";
    $("#starter-hint").hidden    = st !== "idle";
    renderStarterLanes();
  }

  if (role === "recorder" && !$("#screen-recorder").hidden) {
    const st = race?.state || "idle";
    const statusEl = $("#rec-status");
    const splitBtn = $("#btn-split");
    if (st === "running") {
      statusEl.textContent = "計測中 — ラップ/ゴールを押す";
      statusEl.classList.add("live"); splitBtn.disabled = false;
    } else if (st === "armed") {
      statusEl.textContent = "まもなくスタート（合図を待つ）";
      statusEl.classList.remove("live"); splitBtn.disabled = true;
    } else {
      statusEl.textContent = "スターターの準備を待っています…";
      statusEl.classList.remove("live"); splitBtn.disabled = true;
    }
    // 選手名（自動表示・折り返し側もここに出る）
    $("#rec-swimmer").textContent = race?.lanes?.[myLane]?.name || "—";
    renderSplits();
    updateSaveButton();
  }

  if (role === "recorder" && ringHere && race?.state === "running"
      && race.startServerTime != null && race.raceId !== lastBeepRaceId) {
    lastBeepRaceId = race.raceId;
    scheduleBeepAt(race.startServerTime - serverOffset);
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
  const wrap = $("#starter-lanes");
  if (wrap.hidden) return;
  const lanes = race?.lanes || {};
  let html = "";
  for (let i = 1; i <= 6; i++) {
    const sp = lanes[i]?.splits ? Object.values(lanes[i].splits) : [];
    const last = sp.length ? fmt(sp[sp.length - 1].elapsedMs) : "—";
    const nm = lanes[i]?.name || "";
    html += `<div class="lane-cell" style="border-top-color:var(--lane${i})">
      <div class="n">L${i}</div><div class="c">${last}</div><div class="nm">${escapeHtml(nm)}</div></div>`;
  }
  wrap.innerHTML = html;
}

function renderSplits() {
  const wrap = $("#splits");
  const arr = laneSplitsArr(myLane);
  if (!arr.length) { wrap.innerHTML = ""; return; }
  let html = `<div class="cap"><span>#</span><span>累計</span><span>ラップ</span></div>`;
  arr.forEach((s, i) => {
    const prev = i ? arr[i - 1].elapsedMs : 0;
    const isLast = i === arr.length - 1;
    html += `<div class="split-row${isLast ? " final" : ""}">
      <span class="idx">${i + 1}</span>
      <span class="cum">${fmt(s.elapsedMs)}</span>
      <span class="lap">+${fmt(s.elapsedMs - prev)}</span></div>`;
  });
  wrap.innerHTML = html;
}

// ── メンバー名簿 ───────────────────────────────────────
function memberList() {
  return Object.entries(members).map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => (a.grade - b.grade) || String(a.name).localeCompare(String(b.name), "ja"));
}
function addMember() {
  const name = $("#m-name").value.trim();
  if (!name) { $("#m-name").focus(); return; }
  const m = {
    name,
    grade: Number($("#m-grade").value),
    gender: $("#m-gender").value,
    school: $("#m-school").value.trim() || "",
    guest: $("#m-guest").checked,
    createdAt: serverTimestamp()
  };
  set(push(ref(db, MEMBERS)), m);
  $("#m-name").value = "";
  $("#m-guest").checked = false;
  $("#m-name").focus();
}
function deleteMember(id) {
  if (!confirm("このメンバーを削除しますか？")) return;
  remove(ref(db, `${MEMBERS}/${id}`));
}
function renderMembers() {
  const wrap = $("#mlist");
  const list = memberList();
  if (!list.length) { wrap.innerHTML = `<p class="empty">まだ登録がありません。</p>`; return; }
  wrap.innerHTML = list.map((m) => `
    <div class="member-row">
      <div class="m-main">
        <span class="m-name">${escapeHtml(m.name)}</span>
        ${m.guest ? `<span class="tag guest">ゲスト</span>` : ""}
      </div>
      <div class="m-sub">${m.grade}年・${escapeHtml(m.gender || "")}・${escapeHtml(m.school || "")}</div>
      <button class="del" data-del="${m.id}">削除</button>
    </div>`).join("");
}

// ── 記録一覧 ───────────────────────────────────────────
function renderRecords() {
  const wrap = $("#rlist");
  const list = Object.entries(results).map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) { wrap.innerHTML = `<p class="empty">まだ記録がありません。</p>`; return; }
  wrap.innerHTML = list.map((r) => {
    const splits = Array.isArray(r.splits) ? r.splits : [];
    let laps = "";
    splits.forEach((cum, i) => {
      const prev = i ? splits[i - 1] : 0;
      laps += `<span class="chip">+${fmt(cum - prev)}</span>`;
    });
    return `<div class="record-row">
      <div class="r-head">
        <span class="r-final">${fmt(r.finalMs)}</span>
        <span class="r-name">${escapeHtml(r.name || "")}</span>
        <span class="r-meta">${escapeHtml(r.school || "")}</span>
      </div>
      <div class="r-sub">${escapeHtml(r.dateISO || "")}・L${r.lane ?? "-"}・${r.poolLength || "?"}m</div>
      <div class="r-laps">${laps}</div>
    </div>`;
  }).join("");
}

// ── 記録者：レーン＋選手の選択 ─────────────────────────
function resetRecorderSetup() {
  myLane = null; pendingSwimmer = null;
  $$(".lane-opt").forEach((x) => x.classList.remove("sel"));
  $("#swimmer-auto").hidden = true;
  $("#swimmer-pick-field").hidden = true;
  $("#setup-hint").hidden = true;
  $("#btn-join").disabled = true;
}
function populatePicker() {
  const sel = $("#swimmer-pick");
  if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">— 選手を選択 —</option>']
    .concat(memberList().map((m) =>
      `<option value="${m.id}">${escapeHtml(m.name)}（${m.grade}年${m.guest ? "・ゲスト" : ""}）</option>`));
  sel.innerHTML = opts.join("");
  if (cur) sel.value = cur;
}
function onLaneChosen(lane) {
  myLane = lane;
  const assigned = race?.lanes?.[lane];
  if (assigned && assigned.name) {
    // 既に選手が割り当て済み → 自動表示（折り返し側など）
    pendingSwimmer = { memberId: assigned.memberId || null, name: assigned.name, school: assigned.school || "" };
    $("#swimmer-auto-name").textContent = assigned.name;
    $("#swimmer-auto").hidden = false;
    $("#swimmer-pick-field").hidden = true;
    $("#setup-hint").hidden = true;
    $("#btn-join").disabled = false;
  } else {
    // 未割り当て → 名簿から選ぶ（スタート側）
    pendingSwimmer = null;
    $("#swimmer-auto").hidden = true;
    populatePicker();
    $("#swimmer-pick-field").hidden = false;
    const none = memberList().length === 0;
    $("#setup-hint").hidden = !none;
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
    pendingSwimmer = { memberId: id, name: m.name, school: m.school || "" };
    // スタート側がセッションに選手を書き込む（折り返し側はこれを自動表示）
    update(ref(db, `${RACE}/lanes/${myLane}`), {
      memberId: pendingSwimmer.memberId, name: pendingSwimmer.name, school: pendingSwimmer.school
    });
  }
  $("#rec-lane-label").textContent = `レーン ${myLane}`;
  $("#rec-swimmer").textContent = pendingSwimmer.name;
  $("#saved-msg").hidden = true;
  savedSig = null;
  lastBeepRaceId = null;
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

$$("[data-go]").forEach((b) => b.addEventListener("click", () => {
  role = null; myLane = null;
  const t = b.dataset.go;
  if (t === "members") { renderMembers(); show("screen-members"); }
  if (t === "records") { renderRecords(); show("screen-records"); }
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

// 発進音
const pitchEl = $("#pitch"), pitchVal = $("#pitch-val");
pitchEl.min = PITCH_MIN; pitchEl.max = PITCH_MAX; pitchEl.value = beepHz;
pitchVal.textContent = beepHz + "Hz";
pitchEl.addEventListener("input", (e) => {
  beepHz = clampPitch(Number(e.target.value));
  pitchVal.textContent = beepHz + "Hz"; savePitch(beepHz);
});
$("#btn-test-sound").addEventListener("click", () => { ensureAudio(); scheduleBeepAt(Date.now() + 40, false); });

const volEl = $("#vol"), volVal = $("#vol-val");
volEl.value = beepVol; volVal.textContent = Math.round(beepVol * 100) + "%";
volEl.addEventListener("input", (e) => {
  beepVol = clampVol(Number(e.target.value));
  volVal.textContent = Math.round(beepVol * 100) + "%"; saveVol(beepVol);
});

// スターター
$("#btn-arm").addEventListener("click", arm);
$("#btn-start").addEventListener("click", start);
$("#btn-rearm").addEventListener("click", rearm);
$("#btn-cancel").addEventListener("click", cancel);

// 記録者：レーン
$("#lane-pick").innerHTML = [1,2,3,4,5,6]
  .map((n) => `<button class="lane-opt" data-lane="${n}">${n}</button>`).join("");
$("#lane-pick").addEventListener("click", (e) => {
  const b = e.target.closest(".lane-opt"); if (!b) return;
  $$(".lane-opt").forEach((x) => x.classList.toggle("sel", x === b));
  onLaneChosen(Number(b.dataset.lane));
});
$("#swimmer-pick").addEventListener("change", (e) => {
  $("#btn-join").disabled = !e.target.value;
});
$("#btn-join").addEventListener("click", joinLane);
$("#btn-split").addEventListener("click", recordSplit);
$("#btn-save").addEventListener("click", saveResult);

// メンバー
$("#btn-add-member").addEventListener("click", addMember);
$("#mlist").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]"); if (!b) return;
  deleteMember(b.dataset.del);
});

show("screen-role");
