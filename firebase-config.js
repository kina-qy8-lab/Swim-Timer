// ───────────────────────────────────────────────────────────
// Firebase の設定値をここに貼り付けてください。
// 取得方法: Firebase コンソール → プロジェクトの設定（歯車）
//          → 「マイアプリ」でウェブアプリ（</>）を追加 → 構成をコピー
//
// ★ databaseURL は Realtime Database を使うので必須です ★
//   （コンソールで Realtime Database を「作成」すると表示されます）
// ───────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "AIzaSyByXDmmYhkBbuhLD1Zu_aJVmLoppJEz8Qw",
  authDomain: "swim-timer-efbe4.firebaseapp.com",
  databaseURL: "https://swim-timer-efbe4-default-rtdb.asia-southeast1.firebasedatabase.app/", // ← 必須
  projectId: "swim-timer-efbe4",
  storageBucket: "swim-timer-efbe4.firebasestorage.app",
  messagingSenderId: "372197082807",
  appId: "1:372197082807:web:afb133a36cab8558c1af32"
};

// 発進音の設定（現場の慣れに合わせて調整可）
export const BEEP = {
  frequencyHz: 1000, // 音の高さ
  durationSec: 0.5,  // 鳴る長さ
  volume: 0.9        // 0〜1
};

// スタートの先読み(ms)。ボタンを押した瞬間ではなく、この時間だけ先の
// 「ピッ」が鳴る瞬間を T0 にすることで、選手の体感と記録を一致させる。
export const START_LEAD_MS = 200;