// js/battleroom.js
import { auth, db } from "./firebase.js";
import { onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { roomInfo, roomStatus, roomBgStyle } from "./rooms.js";
import { vacateSeat } from "./roomLeave.js";
import { fillAvatar } from "./avatar.js";
import { syncPublicProfile } from "./publicProfile.js";

const roomRef = doc(db, "rooms", ROOM_ID);
let myUid = null;
let myNickname = null;
let myProfileImage = null;
let latestRoom = null;

const info = roomInfo(ROOM_ID);
if (info) {
    document.getElementById("room-name").textContent = info.name;
    document.title = `${info.name} · 대기실`;
    const bg = roomBgStyle(info, "../img/");
    if (bg) document.getElementById("lobby-hero").style.setProperty("--room-bg", bg);
}

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

function calcMySlot(room) {
    if (!room || !myUid) return null;
    if (room.player1_uid === myUid) return "player1";
    if (room.player2_uid === myUid) return "player2";
    if ((room.spectators ?? []).includes(myUid)) return "spectator";
    return null;
}

function slotLabel(slot) {
    if (slot === "player1") return "Player1";
    if (slot === "player2") return "Player2";
    return "관전자";
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        location.href = "../index.html";
        return;
    }
    myUid = user.uid;

    const userSnap = await getDoc(doc(db, "users", myUid));
    const userData = userSnap.data();
    myNickname = userData.nickname;
    myProfileImage = userData.profileImage ?? null;
    syncPublicProfile(myUid, userData); // 다른 사람이 내 트레이너 카드를 볼 수 있도록

    await joinRoom();
    listenRoom();
    setupButtons();
});

async function joinRoom() {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();

    if (calcMySlot(room)) return;

    if (room.game_started) {
        await joinAsSpectator(room);
        return;
    }

    if (!room.player1_uid) {
        await updateDoc(roomRef, { player1_uid: myUid, player1_name: myNickname });
    } else if (!room.player2_uid) {
        await updateDoc(roomRef, { player2_uid: myUid, player2_name: myNickname });
    } else {
        await joinAsSpectator(room);
    }
}

async function joinAsSpectator(room) {
    const spectators = room.spectators ?? [];
    if (spectators.includes(myUid)) return;

    await updateDoc(roomRef, {
        spectators: [...spectators, myUid],
        spectator_names: [...(room.spectator_names ?? []), myNickname]
    });
}

function listenRoom() {
    onSnapshot(roomRef, async (snap) => {
        const room = snap.data();
        if (!room) return;
        latestRoom = room;

        const mySlot = calcMySlot(room);

        renderStatus(room);
        renderPlayers(room, mySlot);
        renderSpectators(room, mySlot);
        renderSwapStatus(room);
        renderHint(room, mySlot);
        updateButtonsBySlot(room, mySlot);

        // 양쪽 READY가 되면 GM 브라우저(gm/gm.js)가 엔트리를 등록하고 game_started를 켠다.
        if (room.game_started && mySlot) {
            const roomNumber = ROOM_ID.replace("battleroom", "");
            if (mySlot === "spectator") {
                location.href = `../games/battleroom${roomNumber}.html?spectator=true`;
            } else {
                location.href = `../games/battleroom${roomNumber}.html`;
            }
        }
    });
}

function updateButtonsBySlot(room, mySlot) {
    const isPlayer = mySlot === "player1" || mySlot === "player2";

    const readyBtn = document.getElementById("readyBtn");
    const leaveBtn = document.getElementById("leaveBtn");

    if (readyBtn) {
        const isReady = isPlayer && !!room[`${mySlot}_ready`];
        readyBtn.hidden = !isPlayer;
        readyBtn.disabled = !!room.swap_request || !!room.game_started;
        readyBtn.textContent = isReady ? "READY 취소" : "READY";
        readyBtn.setAttribute("aria-pressed", String(isReady));
    }
    if (leaveBtn) leaveBtn.disabled = isPlayer && !!room.game_started;
}

function renderStatus(room) {
    const pill = document.getElementById("room-status");
    if (!pill) return;
    const status = roomStatus(room);
    pill.dataset.status = status.key;
    pill.querySelector("span").textContent = status.label;
}

function renderHint(room, mySlot) {
    const hintEl = document.getElementById("lobby-hint");
    if (!hintEl) return;

    const isPlayer = mySlot === "player1" || mySlot === "player2";
    const bothSeated = !!room.player1_uid && !!room.player2_uid;
    const bothReady = !!room.player1_ready && !!room.player2_ready;

    hintEl.innerHTML = "";
    if (room.game_started) {
        hintEl.append("배틀 화면으로 이동하는 중…");
    } else if (bothSeated && bothReady) {
        hintEl.append(el("strong", null, "양쪽 모두 READY!"), " 곧 배틀이 시작됩니다.");
    } else if (!bothSeated) {
        hintEl.append("상대 트레이너를 기다리는 중입니다.");
    } else if (isPlayer && room[`${mySlot}_ready`]) {
        hintEl.append("상대의 READY를 기다리는 중… 버튼을 다시 누르면 READY가 취소됩니다.");
    } else if (isPlayer) {
        hintEl.append("준비가 되면 ", el("strong", null, "READY"), "를 눌러주세요.");
    } else {
        hintEl.append("두 플레이어가 모두 READY하면 배틀이 시작됩니다.");
    }
}

// 내 아바타는 users 문서의 profileImage(업로드마다 버전이 바뀜)를 우선 사용
function avatarOptions(uid, name) {
    return { uid, name, src: uid === myUid ? myProfileImage : null };
}

// 아바타+이름을 누르면 그 트레이너의 카드를 팝업으로 연다
function profileLink(uid, name, className, ...children) {
    const btn = el("button", className);
    btn.type = "button";
    btn.title = `${name ?? "트레이너"}의 트레이너 카드 보기`;
    btn.append(...children);
    btn.onclick = () => openTrainerCard(uid);
    return btn;
}

// 대기실을 떠나지 않도록(게임 시작 시 자동 이동 유지) 프로필 페이지를 팝업 안 iframe으로 띄운다
let profileDialog = null;
function openTrainerCard(uid) {
    if (!profileDialog) {
        profileDialog = el("dialog", "profile-dialog");
        const close = el("button", "profile-dialog-close", "✕");
        close.type = "button";
        close.setAttribute("aria-label", "닫기");
        close.onclick = () => profileDialog.close();
        const frame = el("iframe");
        frame.title = "트레이너 카드";
        profileDialog.append(close, frame);
        profileDialog.addEventListener("click", (e) => {
            if (e.target === profileDialog) profileDialog.close(); // 바깥 클릭 시 닫기
        });
        profileDialog.addEventListener("close", () => { frame.src = "about:blank"; });
        document.body.append(profileDialog);
    }
    profileDialog.querySelector("iframe").src = `../profile.html?uid=${encodeURIComponent(uid)}&embed=1`;
    profileDialog.showModal();
}

function renderPlayers(room, mySlot) {
    renderPlayerRow("player1", room, mySlot);
    renderPlayerRow("player2", room, mySlot);
}

function renderPlayerRow(slot, room, mySlot) {
    const card = document.getElementById(slot);
    if (!card) return;

    const uid = room[`${slot}_uid`];
    const name = room[`${slot}_name`];
    const ready = !!uid && !!room[`${slot}_ready`];

    card.dataset.state = !uid ? "empty" : ready ? "ready" : "waiting";
    card.dataset.me = String(!!uid && uid === myUid);
    card.innerHTML = "";

    const avatar = el("div", "player-avatar", "?");
    if (uid) fillAvatar(avatar, avatarOptions(uid, name));

    const nameEl = el("strong", "player-name", uid ? (name ?? "-") : "빈 자리");

    card.append(
        el("span", "player-slot", slot === "player1" ? "PLAYER 1" : "PLAYER 2"),
        uid ? profileLink(uid, name, "profile-link", avatar, nameEl) : avatar,
    );
    if (!uid) card.append(nameEl);
    if (uid) card.append(el("span", "ready-badge", ready ? "READY" : "대기 중"));

    const canRequest = mySlot === "spectator" && uid && !room.swap_request && !room.game_started;
    if (canRequest) {
        const btn = el("button", "btn btn-ghost btn-small", "교체 요청");
        btn.type = "button";
        btn.onclick = () => requestSwap(slot, uid, name);
        card.appendChild(btn);
    }
}

function renderSpectators(room, mySlot) {
    const list = document.getElementById("spectator-list");
    if (!list) return;

    const uids = room.spectators ?? [];
    const names = room.spectator_names ?? [];

    document.getElementById("spectator-count").textContent = uids.length;
    list.innerHTML = "";

    if (uids.length === 0) {
        list.append(el("li", "empty", "아직 관전자가 없습니다."));
        return;
    }

    const isPlayer = mySlot === "player1" || mySlot === "player2";
    const canRequest = isPlayer && !room.swap_request && !room.game_started;

    uids.forEach((uid, i) => {
        const chip = el("li", "spectator-chip");
        chip.dataset.me = String(uid === myUid);
        const avatar = el("span", "spectator-avatar");
        fillAvatar(avatar, avatarOptions(uid, names[i]));
        chip.append(profileLink(uid, names[i], "profile-link inline", avatar, el("span", null, names[i] ?? "-")));

        if (canRequest) {
            const btn = el("button", "btn btn-ghost btn-small", "교체 요청");
            btn.type = "button";
            btn.onclick = () => requestSwap("spectator", uid, names[i]);
            chip.appendChild(btn);
        }
        list.appendChild(chip);
    });
}

function renderSwapStatus(room) {
    const banner = document.getElementById("swap-status");
    if (!banner) return;

    banner.innerHTML = "";

    const req = room.swap_request;
    banner.hidden = !req;
    if (!req) return;

    const text = el("span", "swap-text");
    const actions = el("div", "swap-actions");
    const addButton = (label, variant, onclick) => {
        const btn = el("button", `btn btn-small ${variant}`, label);
        btn.type = "button";
        btn.onclick = onclick;
        actions.appendChild(btn);
    };

    if (req.toUid === myUid) {
        text.textContent = `${req.fromName}님이 ${slotLabel(req.fromSlot)} 자리와의 교체를 요청했습니다.`;
        addButton("수락", "btn-primary", () => respondSwap(true));
        addButton("거절", "btn-ghost", () => respondSwap(false));
    } else if (req.fromUid === myUid) {
        text.textContent = `${req.toName}님에게 교체를 요청했습니다. 응답을 기다리는 중...`;
        addButton("요청 취소", "btn-ghost", () => cancelSwap());
    } else {
        text.textContent = `${req.fromName}님이 ${req.toName}님에게 교체를 요청했습니다.`;
    }

    banner.append(text);
    if (actions.childElementCount) banner.append(actions);
}

async function requestSwap(toSlot, toUid, toName) {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();
    if (!room || room.game_started || room.swap_request) return;

    const mySlot = calcMySlot(room);
    if (!mySlot || mySlot === toSlot) return;
    if (mySlot !== "spectator" && toSlot !== "spectator") return;

    await updateDoc(roomRef, {
        swap_request: {
            fromUid: myUid,
            fromName: myNickname,
            fromSlot: mySlot,
            toUid,
            toName,
            toSlot,
        }
    });
}

async function cancelSwap() {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();
    const req = room?.swap_request;
    if (!req || req.fromUid !== myUid) return;

    await updateDoc(roomRef, { swap_request: deleteField() });
}

async function respondSwap(accepted) {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();
    const req = room?.swap_request;
    if (!req || req.toUid !== myUid) return;

    if (!accepted) {
        await updateDoc(roomRef, { swap_request: deleteField() });
        return;
    }

    let playerSlot, playerUid, playerName, spectatorUid, spectatorName;
    if (req.fromSlot === "spectator") {
        spectatorUid = req.fromUid;
        spectatorName = req.fromName;
        playerSlot = req.toSlot;
        playerUid = req.toUid;
        playerName = req.toName;
    } else {
        playerSlot = req.fromSlot;
        playerUid = req.fromUid;
        playerName = req.fromName;
        spectatorUid = req.toUid;
        spectatorName = req.toName;
    }

    const spectators = room.spectators ?? [];
    const spectatorNames = room.spectator_names ?? [];
    const idx = spectators.indexOf(spectatorUid);

    if (idx === -1 || room[`${playerSlot}_uid`] !== playerUid) {
        await updateDoc(roomRef, { swap_request: deleteField() });
        return;
    }

    const newSpectators = [...spectators];
    const newSpectatorNames = [...spectatorNames];
    newSpectators[idx] = playerUid;
    newSpectatorNames[idx] = playerName;

    await updateDoc(roomRef, {
        [`${playerSlot}_uid`]: spectatorUid,
        [`${playerSlot}_name`]: spectatorName,
        [`${playerSlot}_ready`]: false,
        spectators: newSpectators,
        spectator_names: newSpectatorNames,
        swap_request: deleteField(),
    });
}

function setupButtons() {
  const readyBtn = document.getElementById("readyBtn");

  // READY 토글: 누르면 READY, 한 번 더 누르면 READY 취소
  readyBtn.onclick = async () => {
    readyBtn.disabled = true;
    try {
      const roomSnap = await getDoc(roomRef);
      const room = roomSnap.data();
      const mySlot = calcMySlot(room);
      if ((mySlot !== "player1" && mySlot !== "player2") || room.game_started) return;
      const key = `${mySlot}_ready`;
      await updateDoc(roomRef, { [key]: !room[key] });
    } finally {
      readyBtn.disabled = false;
      if (latestRoom) updateButtonsBySlot(latestRoom, calcMySlot(latestRoom));
    }
  };

  document.getElementById("leaveBtn").onclick = async () => {
    const roomSnap = await getDoc(roomRef);
    const room = roomSnap.data();
    const mySlot = calcMySlot(room);
    const isPlayer = mySlot === "player1" || mySlot === "player2";

    if (isPlayer && room.game_started) {
      return;
    }
    await vacateSeat(roomRef, room, myUid);
    location.href = "../main.html";
  };
}
