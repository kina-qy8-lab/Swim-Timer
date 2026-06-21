// ───────────────────────────────────────────────────────────
// 競泳タイマー 同期PoC
// 肝：スターターが押した「ピッ」の瞬間を T0（サーバー時刻）として共有し、
//     各端末は (自分が押した瞬間 + 自分のズレ) − T0 で経過時間を出す。
//     これで端末ごとに時計が違っても、記録の基準は揃う。
// ───────────────────────────────────────────────────────────

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getDatabase, ref, onValue, set, update, push, child, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-database.js";

import { firebaseConfig, BEEP, START_LEAD_MS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

const RACE = "session/race"; // 同時にアクティブなセッションは1つ（プール1面＝1セッション）

// ── 状態 ────────────────────────────────────────────────
let serverOffset = 0;     // この端末の時計とサーバー時刻の差(ms)
let connected = false;
let role = null;          // 'starter' | 'recorder'
let myLane = null;        // 記録者の担当レーン
let ringHere = false;     // 記録者端末でも発進音を鳴らすか
let lastBeepRaceId = null;
let race = null;          // RTDB の現在のレース状態

const serverNow = () => Date.now() + serverOffset;

// ── 時間の整形（カンマ2秒・競泳式に切り捨て） ───────────────
function fmt(ms) {
  if (ms == null || ms < 0) ms = 0;
  const cs = Math.floor(ms / 10);        // 1/100秒に切り捨て
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
// targetEpochMs（ローカルの Date.now() 基準）の瞬間に「ピッ」を鳴らす
function scheduleBeepAt(targetEpochMs) {
  if (!audioCtx) return;
  const leadSec = Math.max(0, (targetEpochMs - Date.now()) / 1000);
  const when = audioCtx.currentTime + leadSec;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = BEEP.frequencyHz;
  const dur = BEEP.durationSec, vol = BEEP.volume;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(vol, when + 0.006);
  gain.gain.setValueAtTime(vol, when + dur - 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  // 画面フラッシュも同じ瞬間に
  setTimeout(fireFlash, Math.max(0, targetEpochMs - Date.now()));
}
function fireFlash() {
  const f = $("#flash");
  f.classList.remove("fire");
  void f.offsetWidth; // リフロー
  f.classList.add("fire");
}

// ── DOMヘルパ ──────────────────────────────────────────
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function show(id) {
  $$(".screen").forEach((el) => (el.hidden = true));
  $("#" + id).hidden = false;
}

// ── RTDB購読：ズレ・接続・レース ────────────────────────
onValue(ref(db, ".info/serverTimeOffset"), (s) => {
  serverOffset = s.val() || 0;
  $("#offset-val").textContent = Math.round(serverOffset);
});
onValue(ref(db, ".info/connected"), (s) => {
  connected = !!s.val();
  $("#conn-dot").classList.toggle("on", connected);
  $("#conn-text").textContent = connected ? "接続OK" : "未接続";
});
onValue(ref(db, RACE), (s) => {
  race = s.val();
  onRaceChanged();
});

// ── スターター操作 ─────────────────────────────────────
let pool = 25;

function arm() {
  ensureAudio(); // ユーザー操作のうちに音声を解錠
  const raceId = "r" + Date.now().toString(36);
  set(ref(db, RACE), {
    state: "armed",
    raceId,
    poolLength: pool,
    startServerTime: null,
    armedAt: serverTimestamp(),
    lanes: null
  });
}

function start() {
  ensureAudio();
  if (!race || race.state !== "armed") return;
  // T0 = いま + 先読み + 自分のズレ → 全端末が同じT0を見る
  const t0Local  = Date.now() + START_LEAD_MS;
  const T0Server = t0Local + serverOffset;
  scheduleBeepAt(t0Local); // スターター端末では「ピッ」がこの瞬間に鳴る
  update(ref(db, RACE), {
    state: "running",
    startServerTime: T0Server,
    startedAt: serverTimestamp()
  });
}

function rearm() {
  if (!race) return;
  update(ref(db, RACE), {
    state: "armed",
    startServerTime: null,
    raceId: "r" + Date.now().toString(36),
    lanes: null
  });
}

function cancel() {
  set(ref(db, RACE), { state: "idle" });
}

// ── 記録者操作 ─────────────────────────────────────────
function recordSplit() {
  if (!race || race.state !== "running" || race.startServerTime == null) return;
  const elapsed = serverNow() - race.startServerTime;
  if (elapsed < 0) return; // まだT0前
  const node = push(child(ref(db, RACE), `lanes/${myLane}/splits`));
  set(node, { elapsedMs: Math.round(elapsed), at: serverTimestamp() });
}

// ── 画面更新 ───────────────────────────────────────────
function onRaceChanged() {
  // スターター画面
  if (role === "starter") {
    const st = race?.state || "idle";
    const map = { idle: "準備前", armed: "準備OK（記録者を待機）", running: "計測中" };
    $("#starter-state").textContent = map[st] || st;

    $("#btn-arm").hidden        = st !== "idle";
    $("#btn-start").hidden      = st !== "armed";
    $("#btn-cancel").hidden     = st !== "armed";
    $("#running-actions").hidden = st !== "running";
    $("#starter-clock").hidden  = st !== "running";
    $("#starter-lanes").hidden  = st === "idle";
    $("#starter-hint").hidden   = st !== "idle";

    renderStarterLanes();
  }

  // 記録者画面
  if (role === "recorder" && !$("#screen-recorder").hidden) {
    const st = race?.state || "idle";
    const statusEl = $("#rec-status");
    const btn = $("#btn-split");
    if (st === "running") {
      statusEl.textContent = "計測中 — ラップ/ゴールを押す";
      statusEl.classList.add("live");
      btn.disabled = false;
    } else if (st === "armed") {
      statusEl.textContent = "まもなくスタート（合図を待つ）";
      statusEl.classList.remove("live");
      btn.disabled = true;
    } else {
      statusEl.textContent = "スターターの準備を待っています…";
      statusEl.classList.remove("live");
      btn.disabled = true;
    }
    renderSplits();
  }

  // 記録者端末でも発進音（任意）。新しいレースのrunning化を検知して一度だけ。
  if (role === "recorder" && ringHere && race?.state === "running"
      && race.startServerTime != null && race.raceId !== lastBeepRaceId) {
    lastBeepRaceId = race.raceId;
    scheduleBeepAt(race.startServerTime - serverOffset); // サーバー時刻→自端末ローカル
  }
}

function renderStarterLanes() {
  const wrap = $("#starter-lanes");
  if (wrap.hidden) return;
  const lanes = race?.lanes || {};
  let html = "";
  for (let i = 1; i <= 6; i++) {
    const sp = lanes[i]?.splits ? Object.values(lanes[i].splits) : [];
    const last = sp.length ? fmt(sp[sp.length - 1].elapsedMs) : "—";
    const nm = lanes[i]?.label || "";
    html += `<div class="lane-cell" style="border-top-color:var(--lane${i})">
      <div class="n">L${i}</div><div class="c">${last}</div><div class="nm">${escapeHtml(nm)}</div></div>`;
  }
  wrap.innerHTML = html;
}

function renderSplits() {
  const wrap = $("#splits");
  const splitsObj = race?.lanes?.[myLane]?.splits || {};
  const arr = Object.values(splitsObj).sort((a, b) => a.elapsedMs - b.elapsedMs);
  if (!arr.length) { wrap.innerHTML = ""; return; }
  let html = `<div class="cap"><span>#</span><span>累計</span><span>ラップ</span></div>`;
  arr.forEach((s, i) => {
    const prev = i ? arr[i - 1].elapsedMs : 0;
    const lap  = s.elapsedMs - prev;
    const isLast = i === arr.length - 1;
    html += `<div class="split-row${isLast ? " final" : ""}">
      <span class="idx">${i + 1}</span>
      <span class="cum">${fmt(s.elapsedMs)}</span>
      <span class="lap">+${fmt(lap)}</span></div>`;
  });
  wrap.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── 描画ループ（同期時計＆計測中の大時計） ───────────────
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
// 役割選択
$$(".role-btn").forEach((b) => b.addEventListener("click", () => {
  role = b.dataset.role;
  if (role === "starter") { show("screen-starter"); onRaceChanged(); }
  else show("screen-recorder-setup");
}));

// 戻る
$$("[data-back]").forEach((b) => b.addEventListener("click", () => {
  if (role === "recorder" && !$("#screen-recorder").hidden) { show("screen-recorder-setup"); return; }
  role = null; myLane = null;
  show("screen-role");
}));

// プール選択
$("#pool-seg").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  pool = Number(btn.dataset.pool);
  $$("#pool-seg button").forEach((x) => x.classList.toggle("on", x === btn));
});

// スターターボタン
$("#btn-arm").addEventListener("click", arm);
$("#btn-start").addEventListener("click", start);
$("#btn-rearm").addEventListener("click", rearm);
$("#btn-cancel").addEventListener("click", cancel);

// レーン選択（記録者）
$("#lane-pick").innerHTML = [1,2,3,4,5,6]
  .map((n) => `<button class="lane-opt" data-lane="${n}">${n}</button>`).join("");
$("#lane-pick").addEventListener("click", (e) => {
  const b = e.target.closest(".lane-opt"); if (!b) return;
  myLane = Number(b.dataset.lane);
  $$(".lane-opt").forEach((x) => x.classList.toggle("sel", x === b));
  $("#btn-join").disabled = false;
});

// 記録開始
$("#btn-join").addEventListener("click", () => {
  if (!myLane) return;
  ensureAudio();
  ringHere = $("#ring-here").checked;
  const name = $("#swimmer-name").value.trim();
  if (name) update(ref(db, `${RACE}/lanes/${myLane}`), { label: name });
  $("#rec-lane-label").textContent = `レーン ${myLane}`;
  lastBeepRaceId = null;
  show("screen-recorder");
  onRaceChanged();
});

// ラップ/ゴール
$("#btn-split").addEventListener("click", recordSplit);

// 初期画面
show("screen-role");
