// js/battle.js
// 플레이어/관전자 화면. 판정은 하지 않고 rooms/{ROOM_ID}/actions에 요청만 생성한다.
// 실제 판정과 방 상태 갱신은 GM 브라우저(gm/gm.js)가 js/engine.js로 처리한다.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  collection,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { MOVES } from "./moves.js";
import { formatPokemonName } from "./effecthandler.js";
import { displayName, isMoveLocked } from "./engine.js";
import { vacateSeat } from "./roomLeave.js";

const roomRef = doc(db, "rooms", ROOM_ID);
const actionsRef = collection(roomRef, "actions");
const isSpectatorView = new URLSearchParams(location.search).get("spectator") === "true";

const MOVE_BUTTON_COUNT = 4;
const GM_WAIT_NOTICE_MS = 5000; // 이 시간 안에 GM이 요청을 처리하지 않으면 안내 문구 표시

const TYPE_COLORS = {
  노말: "#949495", 불: "#e56c3e", 물: "#5185c5", 전기: "#fbb917", 풀: "#66a945",
  얼음: "#6dc8eb", 격투: "#e09c40", 독: "#735198", 땅: "#9c7743", 바위: "#bfb889",
  비행: "#a2c3e7", 에스퍼: "#dd6b7b", 벌레: "#9fa244", 고스트: "#684870",
  드래곤: "#535ca8", 악: "#4c4948", 강철: "#69a9c7", 페어리: "#dab4d4",
};

// battleroom에 인트로 오버레이가 있는 페이지에서는, 인트로(양쪽 터치 + VS 연출)가 끝나기 전까지
// 첫 라운드(주사위 굴리기)를 시작하지 않는다. intro.js가 끝나면 "battle:introDone"을 쏴준다.
const hasIntro = !!document.getElementById("intro-overlay");
let introReady = !hasIntro;
let latestRoomForInit = null;

if (hasIntro) {
  document.addEventListener("battle:introDone", () => {
    introReady = true;
    if (latestRoomForInit) maybeInitRound(latestRoomForInit);
  }, { once: true });
}

let myUid = null;
let mySlot = null;
let latestRoom = null;
let roundInitInFlight = false;
let lastAnimatedRound = 0;
let isAnimating = false;
let diceRolling = false;
let pendingDiceRoll = null;
let actionInFlight = false;
let pendingFirstMoveLog = null; // 다이스 롤이 끝난 뒤에야 재생할 "~의 선공!" 로그 줄

const DICE_SOUND_URL = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3";
const diceSound = new Audio(DICE_SOUND_URL);

const BUTTON_SOUND_URL = "https://usual-salmon-mnqxptwyvw.edgeone.app/Pokemon%20(A%20Button)%20-%20Sound%20Effect%20(HD)%20(1)%20(1).mp3";
const buttonSound = new Audio(BUTTON_SOUND_URL);

function playButtonSound() {
  buttonSound.currentTime = 0;
  buttonSound.play().catch(() => {});
}

function slotKey(slot) {
  if (slot === "player1") return "p1";
  if (slot === "player2") return "p2";
  return null;
}

function perspectiveKeys() {
  const myKey = slotKey(mySlot);
  if (myKey === "p2") return { mineKey: "p2", enemyKey: "p1" };
  return { mineKey: "p1", enemyKey: "p2" };
}

function calcMySlot(room) {
  if (!room || !myUid) return null;
  if (room.player1_uid === myUid) return "player1";
  if (room.player2_uid === myUid) return "player2";
  return "spectator";
}

// GM에게 요청(action)을 보내고, GM이 처리(done/rejected)할 때까지 기다린다.
// 방 상태 변경은 GM이 같은 트랜잭션으로 반영하므로, 결과 화면은 room onSnapshot으로 자연히 갱신된다.
function sendAction(type, payload = {}) {
  return new Promise(async (resolve) => {
    let noticeTimer = null;
    try {
      const ref = await addDoc(actionsRef, {
        uid: myUid,
        type,
        payload,
        round_no: latestRoom?.round_no ?? 0,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      noticeTimer = setTimeout(() => {
        const el = document.getElementById("turn-indicator");
        if (el) el.innerText = "GM 응답 대기 중...";
      }, GM_WAIT_NOTICE_MS);
      const unsub = onSnapshot(ref, (snap) => {
        const action = snap.data();
        if (!action || action.status === "pending") return;
        clearTimeout(noticeTimer);
        unsub();
        if (action.status === "rejected") console.warn(`요청 거절됨(${type}):`, action.reason);
        resolve(action);
      });
    } catch (err) {
      clearTimeout(noticeTimer);
      console.error(`요청 전송 실패(${type}):`, err);
      resolve({ status: "error", reason: String(err) });
    }
  });
}

// 기술/교체 요청 공통 처리: 요청 중에는 버튼을 잠그고, 끝나면 최신 상태로 다시 그림
async function requestTurnAction(type, payload) {
  if (!slotKey(mySlot) || isAnimating || actionInFlight) return;
  actionInFlight = true;
  if (latestRoom) renderTurnUI(latestRoom);
  try {
    await sendAction(type, payload);
  } finally {
    actionInFlight = false;
    if (latestRoom && !isAnimating) renderTurnUI(latestRoom);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  myUid = user.uid;
  listenBattle();
});

function listenBattle() {
  onSnapshot(roomRef, (snap) => {
    const room = snap.data();
    if (!room) return;
    latestRoom = room;

    mySlot = isSpectatorView ? "spectator" : calcMySlot(room);

    const roundNo = room.round_no ?? 0;
    const isNewRound = !!room.battle_turn && roundNo !== lastAnimatedRound;

    renderBoard(room, isNewRound);
    latestRoomForInit = room;
    maybeInitRound(room);

    if (isNewRound) {
      if (!isAnimating) {
        isAnimating = true;
        renderTurnUI(room);
      }
      // 이전 라운드의 로그/연출 큐가 다 끝난 뒤에 굴리도록 일단 대기시켜둠
      const { mineKey, enemyKey } = perspectiveKeys();
      pendingDiceRoll = { roundNo, mineRoll: room[`${mineKey}_roll`], enemyRoll: room[`${enemyKey}_roll`], room };
      tryStartPendingDiceRoll();
    } else if (!isAnimating) {
      afterDiceSettled(room);
    }
  });
}

// 이전 라운드의 로그 타이핑/피격 연출 큐가 완전히 빌 때까지는 다이스를 굴리지 않음.
// processBoardQueue가 큐를 다 비울 때마다도 호출해서, 마지막 로그 줄 연출이 끝나자마자 이어서 굴림.
function tryStartPendingDiceRoll() {
  if (!pendingDiceRoll || diceRolling) return;
  if (boardBusy || boardQueue.length > 0) return; // 아직 이전 라운드 연출 재생 중

  const { roundNo, mineRoll, enemyRoll, room } = pendingDiceRoll;
  pendingDiceRoll = null;
  diceRolling = true;
  // document.getElementById("turn-indicator").innerText = "주사위 굴리는 중...";
  playDiceRoll(mineRoll, enemyRoll).then(() => {
    diceRolling = false;
    isAnimating = false;
    lastAnimatedRound = roundNo;
    afterDiceSettled(room);
    flushPendingFirstMoveLog();
  });
}

// 다이스 결과가 확정된 뒤에야 보류해뒀던 "~의 선공!" 로그 줄을 재생
function flushPendingFirstMoveLog() {
  if (!pendingFirstMoveLog) return;
  const { text } = pendingFirstMoveLog;
  pendingFirstMoveLog = null;
  boardQueue.push({ kind: "log", text });
  processBoardQueue();
}

// 다이스(선공 결정)가 끝난 뒤 화면을 갱신
function afterDiceSettled(room) {
  renderTurnUI(room);
}

// 게임이 막 시작됐는데 아직 선공이 안 정해졌으면 player1이 GM에게 첫 라운드 세팅을 요청.
// round_no로 판단(battle_turn만 보면 강제교체 대기 중의 null 상태와 구분이 안 돼서 재시작 취급될 수 있음).
async function maybeInitRound(room) {
  if (!introReady) return;
  if (!room.game_started || (room.round_no ?? 0) > 0 || room.battle_winner) return;
  if (mySlot !== "player1" || roundInitInFlight) return;
  if (!room.p1_entry?.length || !room.p2_entry?.length) return;

  roundInitInFlight = true;
  await sendAction("init");
}

// switchIdx: 유턴류 기술로 공격 후 교체해 들어갈 벤치 번호 (공격+교체를 한 요청으로 보냄)
function useMove(moveIdx, switchIdx = null) {
  uTurnPick = null;
  return requestTurnAction("move", switchIdx === null ? { moveIdx } : { moveIdx, switchIdx });
}

// 유턴류 기술 버튼을 누른 뒤 교체할 벤치를 고르는 중이면 그 기술 번호, 아니면 null
let uTurnPick = null;

// 벤치 포켓몬 교체 요청. 강제/자발적 교체 구분과 턴 소모는 GM(engine.switchPokemon)이 판단한다.
function switchPokemon(targetIdx) {
  return requestTurnAction("switch", { targetIdx });
}

// 전투 종료 후 LEAVE 버튼 클릭 시: GM이 내 슬롯을 비우고 전투 필드를 초기화하면 메인으로 이동.
// 상대가 먼저 LEAVE해서 방이 이미 초기화됐으면(game_started=false) GM을 거치지 않고 직접 자리를 비운다.
let leaveInFlight = false;
let sawBattle = false; // 이 화면에서 전투 중/종료 상태를 본 적이 있는지 (초기화 감지용)
async function leaveBattle() {
  if (leaveInFlight || !latestRoom) return;
  const alreadyReset = sawBattle && !latestRoom.game_started;
  if (!latestRoom.battle_winner && !alreadyReset) return;

  leaveInFlight = true;
  if (alreadyReset) {
    await vacateSeat(roomRef, latestRoom, myUid);
  } else {
    const result = await sendAction("leave");
    if (result.status !== "done") {
      leaveInFlight = false;
      return;
    }
  }
  location.href = "../main.html";
}

function renderLeaveButton(room) {
  const btn = document.getElementById("leaveBtn");
  if (!btn) return;
  if (room.game_started) sawBattle = true;
  const canLeave = !!room.battle_winner || (sawBattle && !room.game_started);
  btn.style.display = canLeave ? "inline-block" : "none";
  btn.onclick = () => {
    playButtonSound();
    leaveBattle();
  };
}

function renderBoard(room, isNewRound = false) {
  const { mineKey, enemyKey } = perspectiveKeys();
  const myKey = slotKey(mySlot);

  const mineLabel = myKey ? `${displayName(mineKey, room)}` : displayName(mineKey, room);
  const enemyLabel = myKey ? `${displayName(enemyKey, room)}` : displayName(enemyKey, room);

  document.getElementById("mine-name").innerText = mineLabel;
  document.getElementById("enemy-name").innerText = enemyLabel;
  document.getElementById("dice-mine-name").innerText = mineLabel;
  document.getElementById("dice-enemy-name").innerText = enemyLabel;

  renderLogAndBoard(room, isNewRound);
  renderResult(room);
  renderLeaveButton(room);
}

function renderTurnUI(room) {
  if (room.battle_turn !== slotKey(mySlot) || room.battle_winner) uTurnPick = null; // 내 턴이 끝나면 유턴 선택 취소
  renderTurn(room);
  if (uTurnPick !== null) document.getElementById("turn-indicator").innerText = "유턴 후 교체할 포켓몬을 선택!";
  renderMoveButtons(room);
  renderBench(room);
}

// HP바 하나를 지정된 색상 구간(초록/주황/빨강)으로 갱신. showNumbers가 false면 텍스트는 비워둠(적군 HP 숨김 등에 사용 가능).
function updateHpBar(barId, textId, hp, maxHp, showNumbers) {
  const bar = document.getElementById(barId), txt = textId ? document.getElementById(textId) : null;
  if (!bar) return;
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
  bar.style.width = pct + "%";
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336";
  if (txt) txt.innerText = showNumbers ? `HP: ${hp} / ${maxHp}` : "";
}

// mine/enemy 포트레이트를 갱신. animate가 true면 등장 슬라이드 애니메이션을 재생(교체 시에만 사용).
function updatePortrait(prefix, pokemon, animate = false) {
  const img = document.getElementById(`${prefix}-portrait`);
  const placeholder = document.getElementById(`${prefix}-portrait-placeholder`);
  if (!img) return;
  if (!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display = "none";
    if (placeholder) placeholder.style.display = "block"; return;
  }
  if (placeholder) placeholder.style.display = "none";
  img.classList.remove("visible", "slide-in-mine", "slide-in-enemy");
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name;
  setTimeout(() => {
    img.classList.add("visible", ...(animate ? [prefix === "mine" ? "slide-in-mine" : "slide-in-enemy"] : []));
  }, 80);
}

// 공격 연출: 공격자 플래시 + 화면 흔들림 + (짧은 딜레이 후) 피격자 흔들림
function triggerAttackEffect(atkPfx, defPfx) {
  return new Promise(resolve => {
    const atkArea = document.getElementById(`${atkPfx}-pokemon-area`);
    const defArea = document.getElementById(`${defPfx}-pokemon-area`);
    const wrapper = document.getElementById("battle-wrapper");
    if (atkArea) { atkArea.classList.add("attacker-flash"); atkArea.addEventListener("animationend", () => atkArea.classList.remove("attacker-flash"), { once: true }); }
    if (wrapper) { wrapper.classList.add("screen-shake"); wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), { once: true }); }
    setTimeout(() => {
      if (defArea) { defArea.classList.add("defender-hit"); defArea.addEventListener("animationend", () => { defArea.classList.remove("defender-hit"); resolve(); }, { once: true }); }
      else resolve();
    }, 120);
  });
}

// 도트 데미지(독/화상) 등 공격자가 없는 피해에 쓰는 단순 깜빡임 연출
function triggerBlink(prefix) {
  return new Promise(resolve => {
    const area = document.getElementById(`${prefix}-pokemon-area`);
    if (!area) { resolve(); return; }
    area.classList.add("blink-damage");
    area.addEventListener("animationend", () => { area.classList.remove("blink-damage"); resolve(); }, { once: true });
  });
}

// mine/enemy 패널의 HP바/스탯/초상화를 즉시(연출 없이) 채워 넣음.
// 슬라이드 인 연출이 필요하면 호출부에서 updatePortrait(side, pkmn, true)를 따로 호출한다.
// 화면에 현재 표시 중인 포켓몬(연출 도중의 상태). status 연출이 이름 표시만 바꿀 때 사용.
const shownPokemon = { mine: null, enemy: null };

function applyPokemonVisual(side, pkmn, idx) {
  shownPokemon[side] = pkmn;
  const hpText = document.getElementById(`${side}-hp`);
  const hpBar = document.getElementById(`${side}-hp-bar`);
  const stats = document.getElementById(`${side}-stats`);
  if (!hpText || !hpBar || !stats) return;

  if (!pkmn) {
    hpText.innerText = "-";
    hpBar.style.width = "0%";
    stats.innerText = "";
    updatePortrait(side, null);
    return;
  }

  updateHpBar(`${side}-hp-bar`, `${side}-hp`, pkmn.hp, pkmn.maxHp, true);
  stats.innerText = formatPokemonName(pkmn);

  const portrait = document.getElementById(`${side}-portrait`);
  if (portrait) portrait.classList.toggle("fainted", pkmn.hp <= 0);
}

// 내 활성 포켓몬의 기술로 빈 버튼(moveBtn0~3)을 채움
function renderMoveButtons(room) {
  const myKey = slotKey(mySlot);

  for (let i = 0; i < MOVE_BUTTON_COUNT; i++) {
    const btn = document.getElementById(`moveBtn${i}`);
    if (!btn) continue;

    if (!myKey) {
      btn.style.display = "none";
      continue;
    }

    const activeIdx = room[`${myKey}_active_idx`] ?? 0;
    const myPkmn = room[`${myKey}_entry`]?.[activeIdx];
    const move = myPkmn?.moves?.[i];

    if (!move) {
      btn.style.display = "none";
      continue;
    }

    const canAct =
      room.battle_turn === myKey &&
      !room.battle_winner &&
      !isAnimating &&
      !actionInFlight;
    // 고스트다이브로 사라진 상태면 그 기술만 누를 수 있음 (다음 턴 강제 공격, PP는 이미 소모됨)
    const diving = myPkmn.ghostDive;
    const locked = isMoveLocked(myPkmn, move.name, room.round_no ?? 0); // 거대해머: 사용 다음 라운드엔 잠김
    const usable = diving ? canAct && diving.moveIdx === i : canAct && (move.pp ?? 0) > 0 && !locked;

    const moveData = MOVES[move.name];
    btn.classList.toggle("uturn-picking", uTurnPick === i);
    btn.style.display = "inline-flex";
    btn.style.backgroundColor = TYPE_COLORS[moveData?.type] ?? "var(--accent)";
    btn.style.opacity = usable ? "1" : "0.45";
    const accText = moveData?.alwaysHit ? "필중" : `${moveData?.accuracy ?? "-"}%`;
    btn.innerHTML = `<span class="move-btn-name">${move.name}</span><span class="move-btn-info">PP ${move.pp} | ${accText}</span>`;
    btn.disabled = !usable;
    btn.onclick = () => {
      playButtonSound();
      // 유턴류 기술: 교체할 수 있는 벤치가 있으면 먼저 교체 대상을 고르게 함 (같은 버튼을 다시 누르면 취소)
      const canPivot = moveData?.uTurn && !diving &&
        (myPkmn.hp > 0) && room[`${myKey}_entry`].some((p, idx) => idx !== activeIdx && p && p.hp > 0);
      if (canPivot) {
        uTurnPick = uTurnPick === i ? null : i;
        renderTurnUI(room);
        return;
      }
      useMove(i);
    };
  }
}

// 양쪽 벤치를 렌더링. 클릭 가능한 건 "내 쪽"이고, 교체 대기 중이거나(강제) 내 차례에 자발적 교체가 가능할 때만.
// dataKey(p1/p2)는 room 문서에서 데이터를 읽는 키, uiKey(mine/enemy)는 화면에 표시되는 위치.
function renderBench(room) {
  const { mineKey, enemyKey } = perspectiveKeys();
  renderBenchSide(mineKey, "mine", room);
  renderBenchSide(enemyKey, "enemy", room);
}

function renderBenchSide(dataKey, uiKey, room) {
  const container = document.getElementById(`${uiKey}-bench`);
  if (!container) return;

  const entry = room[`${dataKey}_entry`] ?? [];
  const activeIdx = room[`${dataKey}_active_idx`] ?? 0;
  const myKey = slotKey(mySlot);
  const pendingSwitch = !!room[`${dataKey}_pending_switch`];
  const anyonePending = !!room.p1_pending_switch || !!room.p2_pending_switch;

  const canForcedSwitch = myKey === dataKey && pendingSwitch;
  const canUTurnSwitch = myKey === dataKey && uTurnPick !== null && !isAnimating && !actionInFlight;
  const canVoluntarySwitch =
    myKey === dataKey &&
    !pendingSwitch &&
    !anyonePending &&
    !entry[activeIdx]?.ghostDive &&
    !room.battle_winner &&
    !isAnimating &&
    !actionInFlight &&
    room.battle_turn === dataKey;

  container.innerHTML = "";
  container.style.flexWrap = "wrap";
  container.style.gap = "6px";

  if (myKey !== dataKey) return; // 상대 벤치는 아예 표시하지 않음

  entry.forEach((pkmn, idx) => {
    if (!pkmn) return;

    const isActive = idx === activeIdx && !pendingSwitch;
    if (isActive) return; // 이미 출전 중인 포켓몬은 벤치에 버튼을 표시하지 않음

    const isFainted = pkmn.hp <= 0;
    const usable = (canForcedSwitch || canVoluntarySwitch || canUTurnSwitch) && !isFainted;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bench-btn";
    btn.disabled = !usable;
    if (isFainted) btn.classList.add("fainted");

    const name = document.createElement("span");
    name.className = "bench-name";
    name.textContent = formatPokemonName(pkmn);
    btn.appendChild(name);

    const hp = document.createElement("span");
    hp.className = "bench-hp";
    hp.textContent = `${pkmn.hp}/${pkmn.maxHp}`;
    btn.appendChild(hp);

    btn.onclick = () => {
      playButtonSound();
      if (uTurnPick !== null) useMove(uTurnPick, idx);
      else switchPokemon(idx);
    };
    container.appendChild(btn);
  });

  container.style.display = "flex";
}

// ---- 로그 타이핑 + 전투 연출 시퀀서 ----
// battle_log(대사 한 줄씩)와 battle_event_log(그 줄에 달린 연출: 피격/교체)를 함께 받아서
// "로그 한 줄 타이핑 -> (그 줄에 연출이 달려 있으면 재생 + HP바 반영) -> 다음 줄" 순서로 재생한다.
const LOG_MAX_LINES = 8;
const LOG_TYPE_CHAR_MS = 18; // 한 글자 타이핑 간격
const LOG_TYPE_GAP_MS = 80; // 한 스텝 끝난 후 다음 스텝 시작 전 여백
const HIT_ANIM_DELAY_MS = 350; // 로그 타이핑이 끝난 뒤 shake/blink 연출 시작까지의 텀

let renderedLogCount = 0; // 지금까지 큐에 반영한 로그 줄 수
let renderedEventCount = 0; // 지금까지 큐에 반영한 연출 이벤트 수
let boardInitialized = false; // 최초 진입/재접속 시엔 연출 없이 즉시 표시
let boardQueue = []; // { kind: "log", text } | { kind: "hit"|"switch", side, pkmn, idx, hasAttacker? } | { kind: "status", side, status } | { kind: "heal", side, hp }
let boardBusy = false;

function trimLogLines(el) {
  while (el.children.length > LOG_MAX_LINES) {
    el.removeChild(el.firstChild);
  }
}

function appendLogLineInstant(el, text) {
  const div = document.createElement("div");
  div.textContent = text;
  el.appendChild(div);
  trimLogLines(el);
}

function typeLogLine(text, onDone) {
  const el = document.getElementById("battle-log");
  if (!el) { onDone(); return; }

  const div = document.createElement("div");
  el.appendChild(div);

  const chars = [...text];
  let i = 0;
  function typeNext() {
    if (i >= chars.length) {
      trimLogLines(el);
      onDone();
      return;
    }
    div.textContent += chars[i++];
    el.scrollTop = el.scrollHeight;
    setTimeout(typeNext, LOG_TYPE_CHAR_MS);
  }
  typeNext();
}

function processBoardQueue() {
  if (boardBusy) return;
  if (boardQueue.length === 0) {
    tryStartPendingDiceRoll(); // 큐가 방금 다 비었으면, 대기 중이던 다음 라운드 다이스를 굴림
    return;
  }
  boardBusy = true;
  const step = boardQueue.shift();
  const next = () => {
    boardBusy = false;
    setTimeout(processBoardQueue, LOG_TYPE_GAP_MS);
  };

  if (step.kind === "log") {
    typeLogLine(step.text, next);
    return;
  }

  if (step.kind === "hit") {
    // 로그가 다 보인 뒤 잠깐 텀을 두고 나서야 shake/blink 연출이 시작되도록
    setTimeout(() => {
      const atkSide = step.side === "mine" ? "enemy" : "mine";
      const playEffect = step.hasAttacker ? triggerAttackEffect(atkSide, step.side) : triggerBlink(step.side);
      playEffect.then(() => {
        applyPokemonVisual(step.side, step.pkmn, step.idx);
        next();
      });
    }, HIT_ANIM_DELAY_MS);
    return;
  }

  if (step.kind === "heal") {
    // 흡수 회복: 연출 없이 HP바만 갱신
    const shown = shownPokemon[step.side];
    if (shown) applyPokemonVisual(step.side, { ...shown, hp: step.hp });
    next();
    return;
  }

  if (step.kind === "status") {
    // 상태이상이 걸리거나 풀린 로그 줄 직후 바로 이름 옆 [상태] 표시만 갱신
    const stats = document.getElementById(`${step.side}-stats`);
    const shown = shownPokemon[step.side];
    if (stats && shown) {
      shownPokemon[step.side] = { ...shown, status: step.status };
      stats.innerText = formatPokemonName(shownPokemon[step.side]);
    }
    next();
    return;
  }

  if (step.kind === "switch") {
    updatePortrait(step.side, step.pkmn, true);
    applyPokemonVisual(step.side, step.pkmn, step.idx);
    setTimeout(next, 400); // 슬라이드 인 연출 재생 시간만큼 대기
    return;
  }

  next();
}

// room 스냅샷 -> 로그/연출 재생 큐 구성. 최초 렌더는 즉시 전부 표시하고,
// 그 이후엔 새로 추가된 줄만 한 줄씩, 해당 줄에 달린 연출과 함께 순서대로 재생한다.
function renderLogAndBoard(room, isNewRound = false) {
  const el = document.getElementById("battle-log");
  if (!el) return;

  const log = room.battle_log ?? [];
  const events = room.battle_event_log ?? [];

  if (log.length < renderedLogCount) {
    // 새 전투 등으로 로그가 리셋된 경우
    el.innerHTML = "";
    renderedLogCount = 0;
    renderedEventCount = 0;
    boardInitialized = false;
    boardQueue = [];
    boardBusy = false;
    pendingFirstMoveLog = null;
  }

  const { mineKey, enemyKey } = perspectiveKeys();
  const mineIdx = room[`${mineKey}_active_idx`] ?? 0;
  const enemyIdx = room[`${enemyKey}_active_idx`] ?? 0;
  const minePkmn = room[`${mineKey}_entry`]?.[mineIdx] ?? null;
  const enemyPkmn = room[`${enemyKey}_entry`]?.[enemyIdx] ?? null;

  if (!boardInitialized) {
    // 최초 렌더링(또는 재접속)은 기존 로그/보드를 연출 없이 즉시 표시
    const holdLast = isNewRound && log.length > 0;
    const visibleLog = holdLast ? log.slice(0, -1) : log;

    el.innerHTML = "";
    visibleLog.slice(-LOG_MAX_LINES).forEach((line) => appendLogLineInstant(el, line));
    el.scrollTop = el.scrollHeight;
    renderedLogCount = log.length;
    renderedEventCount = events.length;
    if (holdLast) pendingFirstMoveLog = { text: log[log.length - 1] };

    applyPokemonVisual("mine", minePkmn, mineIdx);
    updatePortrait("mine", minePkmn, false);
    applyPokemonVisual("enemy", enemyPkmn, enemyIdx);
    updatePortrait("enemy", enemyPkmn, false);

    boardInitialized = true;
    return;
  }

  if (log.length === renderedLogCount) return; // 새로 추가된 줄 없음

  const startIdx = renderedLogCount;
  const newLines = log.slice(renderedLogCount);
  const newEvents = events.slice(renderedEventCount);
  renderedLogCount = log.length;
  renderedEventCount = events.length;

  const sideMap = { [mineKey]: "mine", [enemyKey]: "enemy" };

  // 새 라운드가 시작된 경우, 마지막 줄(항상 "~의 선공!")은 다이스 연출이 끝난 뒤에 재생하도록 보류
  const holdLastLine = isNewRound && newLines.length > 0;
  const linesToQueue = holdLastLine ? newLines.slice(0, -1) : newLines;

  linesToQueue.forEach((text, i) => {
    boardQueue.push({ kind: "log", text });

    const absoluteIdx = startIdx + i;
    for (const ev of newEvents) {
      if (ev.logIndex !== absoluteIdx) continue;
      const side = sideMap[ev.side];

      if (ev.type === "hit") {
        const finalPkmn = side === "mine" ? minePkmn : enemyPkmn;
        const idx = side === "mine" ? mineIdx : enemyIdx;
        // 피격 시점의 상태이상(ev.status)을 써야, 뒤에 걸릴 상태이상이 미리 표시되지 않음
        const hitPkmn = { ...finalPkmn, hp: ev.hp };
        if ("status" in ev) hitPkmn.status = ev.status;
        boardQueue.push({ kind: "hit", side, pkmn: hitPkmn, idx, hasAttacker: ev.hasAttacker });
      } else if (ev.type === "heal") {
        boardQueue.push({ kind: "heal", side, hp: ev.hp });
      } else if (ev.type === "status") {
        boardQueue.push({ kind: "status", side, status: ev.status });
      } else if (ev.type === "switch") {
        const finalPkmn = side === "mine" ? minePkmn : enemyPkmn;
        boardQueue.push({ kind: "switch", side, pkmn: finalPkmn, idx: ev.idx });
      }
    }
  });

  if (holdLastLine) {
    pendingFirstMoveLog = { text: newLines[newLines.length - 1] };
  }

  processBoardQueue();
}

function renderTurn(room) {
  const el = document.getElementById("turn-indicator");
  if (room.battle_winner) {
    el.innerText = "배틀 종료";
    return;
  }

  const pendingSides = ["p1", "p2"].filter((s) => room[`${s}_pending_switch`]);
  if (pendingSides.length > 0) {
    const myKey = slotKey(mySlot);
    if (myKey && pendingSides.includes(myKey)) {
      el.innerText = "교체할 포켓몬을 선택!";
    } else {
      el.innerText = `${pendingSides.map((s) => displayName(s, room)).join(", ")} 교체 대기 중...`;
    }
    return;
  }

  if (!room.battle_turn) {
    el.innerText = "선공 결정 중...";
    return;
  }
  el.innerText = `${displayName(room.battle_turn, room)}의 턴`;
}

function renderResult(room) {
  const el = document.getElementById("result");
  if (!room.battle_winner) {
    el.innerText = "";
    return;
  }
  const myKey = slotKey(mySlot);
  if (myKey) {
    el.innerText = room.battle_winner === myKey ? "승리!" : "패배...";
  } else {
    el.innerText = `${displayName(room.battle_winner, room)} 승리!`;
  }
}

// 다이스 한 개를 finalValue로 멈추는 애니메이션 (숫자 빠르게 돌다가 착지)
function animateOneDice(elId, finalValue) {
  return new Promise((resolve) => {
    const el = document.getElementById(elId);
    let elapsed = 0;
    const interval = 10;
    const duration = 1200;
    const timer = setInterval(() => {
      el.textContent = Math.floor(Math.random() * 10) + 1;
      elapsed += interval;
      if (elapsed >= duration) {
        clearInterval(timer);
        el.textContent = finalValue;
        el.classList.remove("pop");
        void el.offsetWidth;
        el.classList.add("pop");
        resolve();
      }
    }, interval);
  });
}

// 양쪽 주사위를 동시에 굴려서 실제 저장된 값(mineRoll, enemyRoll)으로 착지시킴
async function playDiceRoll(mineRoll, enemyRoll) {
  const diceRow = document.getElementById("diceRow");
  diceRow.style.display = "flex";
  document.getElementById("dice-mine").textContent = "-";
  document.getElementById("dice-enemy").textContent = "-";

  await Promise.all([
    animateOneDice("dice-mine", mineRoll),
    animateOneDice("dice-enemy", enemyRoll),
  ]);

  diceSound.currentTime = 0;
  diceSound.play().catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 700)); // 결과 잠깐 보여주기
  diceRow.style.display = "none";
}