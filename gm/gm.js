// gm/gm.js
// GM 브라우저 = 권한 서버. 모든 방의 요청(rooms/{roomId}/actions)을 구독해서
// js/engine.js로 판정한 뒤, 방 상태 갱신과 요청 처리 완료 표시를 한 트랜잭션으로 반영한다.
import { auth, db } from "../js/firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  sideOfUid,
  startGame,
  initRound,
  useMove,
  switchPokemon,
  leaveBattle,
} from "../js/engine.js";

const LOG_MAX_LINES = 200;

const roomListeners = new Map(); // roomId -> unsubscribe (actions 구독)
const startInFlight = new Set(); // 게임 시작 트랜잭션 진행 중인 roomId
const queued = new Set(); // 큐에 들어간 "roomId/actionId"
const queue = []; // { roomId, actionId }
let busy = false;
let unsubRooms = null;

// ---- 화면 ----
const $ = (id) => document.getElementById(id);

function gmLog(text, kind = "info") {
  const el = $("gm-log");
  if (!el) return;
  const div = document.createElement("div");
  div.className = `log-${kind}`;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.prepend(div);
  while (el.children.length > LOG_MAX_LINES) el.removeChild(el.lastChild);
}

function renderRooms(rooms) {
  const el = $("gm-rooms");
  if (!el) return;
  el.innerHTML = "";
  rooms.forEach(({ id, room }) => {
    const row = document.createElement("div");
    row.className = "room-row";
    const state = room.battle_winner
      ? `종료 (${room.battle_winner} 승)`
      : room.game_started
        ? `진행 중 · 라운드 ${room.round_no ?? 0} · 턴 ${room.battle_turn ?? "-"}`
        : `대기 · READY ${room.player1_ready ? "O" : "X"}/${room.player2_ready ? "O" : "X"}`;
    row.textContent = `${id} | ${room.player1_name ?? "-"} vs ${room.player2_name ?? "-"} | ${state}`;
    el.appendChild(row);
  });
}

// ---- 로그인 ----
let loginFromForm = false; // 이 페이지 폼으로 방금 로그인했는지 (GM이 아니면 바로 로그아웃시킴)

$("gm-login-btn").onclick = async () => {
  $("gm-login-msg").textContent = "";
  loginFromForm = true;
  try {
    await signInWithEmailAndPassword(auth, $("gm-email").value.trim(), $("gm-password").value);
  } catch (err) {
    loginFromForm = false;
    $("gm-login-msg").textContent = "로그인 실패: 이메일/비밀번호를 확인해주세요.";
    console.error(err);
  }
};
$("gm-logout-btn").onclick = () => signOut(auth);

// 내 users 문서의 role이 "gm"인지 확인. 실제 권한은 규칙(firestore.rules의 isGM)이 같은 필드로 강제한다.
async function isGMAccount(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.data()?.role === "gm";
}

function showLogin(message = "") {
  stopServer();
  $("gm-login").style.display = "block";
  $("gm-panel").style.display = "none";
  $("gm-login-msg").textContent = message;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showLogin($("gm-login-msg").textContent);
    return;
  }

  const fromForm = loginFromForm;
  loginFromForm = false;

  let allowed;
  try {
    allowed = await isGMAccount(user.uid);
  } catch (err) {
    showLogin(`GM 확인 실패: ${err.message}`);
    return;
  }

  if (!allowed) {
    if (fromForm) {
      // 이 페이지에서 GM이 아닌 계정으로 로그인 시도 -> 즉시 로그아웃
      await signOut(auth);
      showLogin("GM 계정이 아닙니다.");
    } else {
      // 게임에서 이미 로그인된 플레이어 계정으로 들어온 경우엔 게임 세션을 끊지 않고 서버만 막음
      showLogin("현재 로그인된 계정은 GM이 아닙니다. GM 계정으로 로그인하세요.");
    }
    return;
  }

  $("gm-login").style.display = "none";
  $("gm-panel").style.display = "block";
  $("gm-uid").textContent = user.uid;
  startServer();
});

// ---- 서버 루프 ----
function startServer() {
  if (unsubRooms) return;
  gmLog("GM 서버 시작");
  unsubRooms = onSnapshot(
    collection(db, "rooms"),
    (snap) => {
      const rooms = snap.docs.map((d) => ({ id: d.id, room: d.data() }));
      renderRooms(rooms);
      for (const { id, room } of rooms) {
        watchActions(id);
        maybeStartGame(id, room);
      }
    },
    (err) => gmLog(`rooms 구독 실패: ${err.message}`, "error")
  );
}

function stopServer() {
  unsubRooms?.();
  unsubRooms = null;
  roomListeners.forEach((unsub) => unsub());
  roomListeners.clear();
}

// 방마다 pending 요청을 구독. 창을 다시 켜면 쌓여 있던 pending 요청부터 이어서 처리된다.
function watchActions(roomId) {
  if (roomListeners.has(roomId)) return;
  const q = query(collection(db, "rooms", roomId, "actions"), where("status", "==", "pending"));
  const unsub = onSnapshot(
    q,
    (snap) => {
      const docs = [...snap.docs].sort(
        (a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0)
      );
      for (const d of docs) enqueue(roomId, d.id);
    },
    (err) => gmLog(`${roomId} actions 구독 실패: ${err.message}`, "error")
  );
  roomListeners.set(roomId, unsub);
}

function enqueue(roomId, actionId) {
  const key = `${roomId}/${actionId}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ roomId, actionId });
  drain();
}

// 요청은 하나씩 순서대로 처리 (같은 방 요청끼리 경합하지 않도록)
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) {
    const { roomId, actionId } = queue.shift();
    try {
      await processAction(roomId, actionId);
    } catch (err) {
      gmLog(`${roomId} 요청 처리 실패: ${err.message}`, "error");
      console.error(err);
    }
    queued.delete(`${roomId}/${actionId}`);
  }
  busy = false;
}

// 요청 종류별 판정. 반환값은 engine과 같은 { ok, update } | { ok: false, reason }
function judge(room, action) {
  const side = sideOfUid(room, action.uid);
  const payload = action.payload ?? {};
  const isPlayer = side === "p1" || side === "p2";
  const sameRound = (action.round_no ?? 0) === (room.round_no ?? 0);

  switch (action.type) {
    case "init":
      if (side !== "p1") return { ok: false, reason: "player1만 첫 라운드를 시작할 수 있음" };
      return initRound(room);
    case "move":
      if (!isPlayer) return { ok: false, reason: "플레이어가 아님" };
      if (!sameRound) return { ok: false, reason: "지난 라운드의 요청" };
      if (!Number.isInteger(payload.moveIdx)) return { ok: false, reason: "잘못된 기술 번호" };
      return useMove(room, side, payload.moveIdx);
    case "switch":
      if (!isPlayer) return { ok: false, reason: "플레이어가 아님" };
      if (!sameRound) return { ok: false, reason: "지난 라운드의 요청" };
      if (!Number.isInteger(payload.targetIdx)) return { ok: false, reason: "잘못된 교체 대상" };
      return switchPokemon(room, side, payload.targetIdx);
    case "leave":
      return leaveBattle(room, action.uid);
    default:
      return { ok: false, reason: `알 수 없는 요청: ${action.type}` };
  }
}

async function processAction(roomId, actionId) {
  const roomRef = doc(db, "rooms", roomId);
  const actionRef = doc(db, "rooms", roomId, "actions", actionId);

  // 방 갱신 + 요청 완료 표시를 한 트랜잭션으로 묶어서, GM 탭이 여러 개여도 같은 요청이 두 번 처리되지 않게 함
  const result = await runTransaction(db, async (tx) => {
    const [roomSnap, actionSnap] = await Promise.all([tx.get(roomRef), tx.get(actionRef)]);
    const action = actionSnap.data();
    if (!action || action.status !== "pending") return null;

    const room = roomSnap.data();
    const verdict = room ? judge(room, action) : { ok: false, reason: "방 없음" };

    if (verdict.ok) {
      tx.update(roomRef, verdict.update);
      tx.update(actionRef, { status: "done", processedAt: serverTimestamp() });
    } else {
      tx.update(actionRef, { status: "rejected", reason: verdict.reason, processedAt: serverTimestamp() });
    }
    return { action, verdict, side: room ? sideOfUid(room, action.uid) : null };
  });

  if (!result) return;
  const { action, verdict, side } = result;
  const who = `${roomId}/${side ?? "?"}`;
  if (verdict.ok) gmLog(`${who} ${action.type} ${JSON.stringify(action.payload ?? {})} 처리`);
  else gmLog(`${who} ${action.type} 거절: ${verdict.reason}`, "warn");
}

// 양쪽 READY -> users 문서에서 엔트리를 읽어 게임 시작
async function maybeStartGame(roomId, room) {
  if (!room.player1_ready || !room.player2_ready || room.game_started) return;
  if (startInFlight.has(roomId)) return;
  startInFlight.add(roomId);

  const roomRef = doc(db, "rooms", roomId);
  try {
    const started = await runTransaction(db, async (tx) => {
      const fresh = (await tx.get(roomRef)).data();
      if (!fresh?.player1_uid || !fresh?.player2_uid) return false;
      const [u1, u2] = await Promise.all([
        tx.get(doc(db, "users", fresh.player1_uid)),
        tx.get(doc(db, "users", fresh.player2_uid)),
      ]);
      const verdict = startGame(fresh, u1.data()?.entry, u2.data()?.entry);
      if (!verdict.ok) return false;
      tx.update(roomRef, verdict.update);
      return true;
    });
    if (started) gmLog(`${roomId} 게임 시작`);
  } catch (err) {
    gmLog(`${roomId} 게임 시작 실패: ${err.message}`, "error");
    console.error(err);
  } finally {
    startInFlight.delete(roomId);
  }
}
