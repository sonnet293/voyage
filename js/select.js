// js/select.js
// 게임 시작 직후(양쪽 READY) 포켓몬 선택 화면. users 엔트리(최대 6마리) 중 3마리를 골라 GM에게 select 요청을 보낸다.
// 고른 내용은 요청 문서에만 담기고 방 문서엔 완료 여부만 올라가므로, 상대는 내가 무엇을 골랐는지 볼 수 없다.
// 양쪽 모두 완료하면 GM이 고른 순서대로 p1_entry / p2_entry를 만들고 select_phase를 끈다 → 인트로로 진행.
import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  collection,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { pickCount } from "./engine.js";
import { POKEMON_KO, POKEMON_FORMS_KO } from "./data/pokemonKo.js";

const BALL_IMG = new URL("../img/몬스터볼.png", import.meta.url).href;
const SELECT_CSS = new URL("../css/select.css", import.meta.url).href;

const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
const ID_BY_NAME = new Map(
  [...POKEMON_KO, ...POKEMON_FORMS_KO].map(([id, name]) => [normalize(name), id])
);
const spriteUrl = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// 카드 표시 이름: cardName (Firestore 에서만 수정) > name — 프로필과 동일
const monName = (mon) => (typeof mon?.cardName === "string" && mon.cardName.trim()) || mon?.name || "???";

// 도트 이미지도 표시 이름(cardName) 기준으로 찾고, 없으면 name으로 — 폼 차이(예: 루가루암 (한밤중의 모습)) 반영
function monSprite(mon) {
  const id = ID_BY_NAME.get(normalize(monName(mon))) ?? ID_BY_NAME.get(normalize(mon?.name ?? ""));
  return id ? spriteUrl(id) : mon?.portrait ?? null;
}

const sideOf = (room, uid) => (room.player1_uid === uid ? "p1" : room.player2_uid === uid ? "p2" : null);
const selectionDone = (room) => !room.select_phase && !!room.p1_entry?.length && !!room.p2_entry?.length;

function loadCss() {
  if (document.getElementById("select-css")) return;
  const link = document.createElement("link");
  link.id = "select-css";
  link.rel = "stylesheet";
  link.href = SELECT_CSS;
  document.head.append(link);
}

// 새로고침해도 내가 고른 순서를 유지 (게임마다 키가 다름)
const storageKey = (room) => `select:${ROOM_ID}:${room.game_started_at}`;
function loadPicks(room) {
  try { return JSON.parse(sessionStorage.getItem(storageKey(room))) ?? []; } catch { return []; }
}
function savePicks(room, picks) {
  try { sessionStorage.setItem(storageKey(room), JSON.stringify(picks)); } catch {}
}

// GM에게 요청을 보내고 처리(done/rejected)될 때까지 기다린다
function sendAction(roomRef, uid, type, payload) {
  return new Promise(async (resolve) => {
    try {
      const ref = await addDoc(collection(roomRef, "actions"), {
        uid, type, payload, round_no: 0, status: "pending", createdAt: serverTimestamp(),
      });
      const unsub = onSnapshot(ref, (snap) => {
        const action = snap.data();
        if (!action || action.status === "pending") return;
        unsub();
        if (action.status === "rejected") console.warn(`요청 거절됨(${type}):`, action.reason);
        resolve(action);
      });
    } catch (err) {
      console.error(`요청 전송 실패(${type}):`, err);
      resolve({ status: "error", reason: String(err) });
    }
  });
}

// 선택 단계가 끝나면(이미 끝났으면 즉시) resolve. spectator면 대기 화면만 보여준다.
export function runSelection({ roomRef, myUid, spectator = false }) {
  return new Promise((resolve) => {
    let ui = null;
    let entry = null;
    let picks = [];
    let busy = false;
    let room = null;
    let mySide = null;
    let finished = false;

    const unsub = onSnapshot(roomRef, async (snap) => {
      room = snap.data();
      if (!room || finished) return;

      if (!room.game_started || selectionDone(room)) {
        finished = true;
        unsub();
        if (ui) close(ui.overlay);
        resolve();
        return;
      }

      mySide = spectator ? null : sideOf(room, myUid);
      if (!ui) {
        loadCss();
        ui = build(!mySide);
        if (mySide) {
          entry = (await getDoc(doc(db, "users", myUid))).data()?.entry ?? [];
          picks = loadPicks(room).filter((i) => Number.isInteger(i) && entry[i]).slice(0, pickCount(entry));
          renderBalls();
        }
      }
      render();
    });

    function build(watchOnly) {
      const overlay = el("div", "sel-overlay");
      overlay.id = "select-overlay";
      const panel = el("section", "sel-panel");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "포켓몬 선택");

      const head = el("header", "sel-head");
      head.append(
        el("span", "sel-eyebrow", "POKEMON SELECT"),
        el("h2", "sel-title", watchOnly ? "포켓몬을 고르는 중" : "출전할 포켓몬을 골라주세요"),
        el("p", "sel-desc")
      );

      const status = el("div", "sel-status");
      panel.append(head, status);

      let grid = null, slots = null, doneBtn = null;
      if (!watchOnly) {
        grid = el("div", "sel-grid");
        slots = el("ol", "sel-slots");
        slots.setAttribute("aria-label", "출전 순서");
        doneBtn = el("button", "sel-done", "선택 완료");
        doneBtn.type = "button";
        doneBtn.onclick = onDone;
        const foot = el("div", "sel-foot");
        foot.append(doneBtn);
        panel.append(grid, el("h3", "sel-sub", "출전 순서"), slots, foot);
      }

      overlay.append(panel);
      document.body.append(overlay);
      return { overlay, panel, desc: head.querySelector(".sel-desc"), status, grid, slots, doneBtn };
    }

    function renderBalls() {
      ui.grid.replaceChildren();
      for (let i = 0; i < 6; i++) {
        const mon = entry[i];
        const ball = el("button", "sel-ball");
        ball.type = "button";
        ball.dataset.idx = String(i);
        if (!mon) {
          ball.disabled = true;
          ball.classList.add("empty");
          ball.append(el("span", "sel-ball-art"), el("span", "sel-ball-name", "비어 있음"));
          ui.grid.append(ball);
          continue;
        }
        const art = el("span", "sel-ball-art");
        const img = el("img");
        img.src = BALL_IMG;
        img.alt = "";
        img.draggable = false;
        art.append(img, el("span", "sel-ball-order"));
        const name = el("span", "sel-ball-name", monName(mon));
        const info = el("span", "sel-ball-info", mon.hp != null ? `HP ${mon.hp}` : "");
        ball.append(art, name, info);
        ball.onclick = () => togglePick(i);
        ui.grid.append(ball);
      }
    }

    function render() {
      const oppSide = mySide === "p1" ? "p2" : "p1";
      const name = (side) => room[side === "p1" ? "player1_name" : "player2_name"] ?? (side === "p1" ? "Player1" : "Player2");
      const pill = (side, label) => {
        const done = !!room[`${side}_select_action`];
        const p = el("span", "sel-pill");
        p.dataset.done = String(done);
        p.append(el("i"), `${label} · ${done ? "선택 완료" : "선택 중"}`);
        return p;
      };

      if (mySide && !entry) return; // 내 엔트리를 아직 불러오는 중

      ui.status.replaceChildren();
      if (!mySide) {
        ui.desc.textContent = "두 트레이너가 모두 선택을 마치면 배틀이 시작됩니다.";
        ui.status.append(pill("p1", name("p1")), pill("p2", name("p2")));
        return;
      }

      const need = pickCount(entry);
      const submitted = !!room[`${mySide}_select_action`];
      ui.status.append(pill(mySide, "나"), pill(oppSide, name(oppSide)));

      if (need === 0) {
        ui.desc.textContent = "엔트리에 포켓몬이 없습니다. 트레이너 카드를 확인해주세요.";
      } else if (submitted) {
        ui.desc.textContent = "상대방의 선택을 기다리는 중...";
      } else {
        ui.desc.textContent = `${need}마리를 고르세요. 고른 순서가 출전 순서가 되고, 한 번 더 누르면 취소됩니다.`;
      }

      ui.panel.dataset.submitted = String(submitted);
      ui.grid.querySelectorAll(".sel-ball:not(.empty)").forEach((ball) => {
        const idx = Number(ball.dataset.idx);
        const order = picks.indexOf(idx);
        ball.dataset.picked = String(order >= 0);
        ball.setAttribute("aria-pressed", String(order >= 0));
        ball.querySelector(".sel-ball-order").textContent = order >= 0 ? String(order + 1) : "";
        ball.disabled = submitted || busy || (order < 0 && picks.length >= need);
      });

      ui.slots.replaceChildren();
      for (let n = 0; n < Math.max(need, 1); n++) {
        const mon = entry[picks[n]];
        const slot = el("li", "sel-slot");
        slot.dataset.filled = String(!!mon);
        slot.append(el("span", "sel-slot-no", n === 0 ? "선두" : `${n + 1}번`));
        const art = el("span", "sel-slot-art");
        const src = mon && monSprite(mon);
        if (src) {
          const img = el("img");
          img.src = src;
          img.alt = "";
          img.onerror = () => { img.replaceWith(ballThumb()); };
          art.append(img);
        } else {
          art.append(ballThumb(!mon));
        }
        slot.append(art, el("span", "sel-slot-name", mon ? monName(mon) : "비어 있음"));
        ui.slots.append(slot);
      }

      ui.doneBtn.textContent = submitted ? "선택 취소" : "선택 완료";
      ui.doneBtn.classList.toggle("ghost", submitted);
      ui.doneBtn.disabled = busy || need === 0 || (!submitted && picks.length !== need);
    }

    function ballThumb(dim = false) {
      const img = el("img", dim ? "dim" : null);
      img.src = BALL_IMG;
      img.alt = "";
      return img;
    }

    function togglePick(idx) {
      if (busy || room[`${mySide}_select_action`]) return;
      const at = picks.indexOf(idx);
      if (at >= 0) picks.splice(at, 1);
      else if (picks.length < pickCount(entry)) picks.push(idx);
      savePicks(room, picks);
      render();
    }

    async function onDone() {
      if (busy) return;
      const submitted = !!room[`${mySide}_select_action`];
      busy = true;
      render();
      const result = submitted
        ? await sendAction(roomRef, myUid, "unselect", {})
        : await sendAction(roomRef, myUid, "select", { picks: [...picks], gameId: room.game_started_at });
      busy = false;
      if (finished) return;
      render();
      if (result.status !== "done") ui.desc.textContent = "요청이 처리되지 않았습니다. 다시 시도해주세요.";
    }

    function close(overlay) {
      overlay.classList.add("leaving");
      setTimeout(() => overlay.remove(), 500);
    }
  });
}
