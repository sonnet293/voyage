// js/main.js — 배틀룸 목록 (rooms 컬렉션을 구독해서 방마다 상태를 실시간 표시)
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, collection, onSnapshot }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ROOMS, roomStatus, roomBgStyle } from "./rooms.js";
import { fillAvatar } from "./avatar.js";

const grid = document.getElementById("room-grid");
const summary = document.getElementById("room-summary");
const cards = new Map(); // roomId -> 카드 요소
let myUid = null;
let unsubRooms = null;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

// 카드 뼈대는 로그인 확인 전에 먼저 그려둔다
for (const info of ROOMS) {
    const card = el("a", "room-card");
    card.href = `pages/battleroom${info.no}.html`;

    const visual = el("div", "room-visual");
    visual.style.setProperty("--room-bg", roomBgStyle(info, "img/") || null);
    visual.append(el("span", "room-no", `ROOM ${String(info.no).padStart(2, "0")}`));
    const pill = el("span", "status-pill");
    pill.append(el("i"), el("span", "status-label", "불러오는 중"));
    visual.append(pill);
    const mine = el("span", "room-mine", "참가 중");
    mine.hidden = true;
    visual.append(mine);

    const body = el("div", "room-body");
    body.append(el("h2", "room-name", info.name));
    const seats = el("div", "room-seats");
    seats.append(makeSeat("P1"), el("span", "room-vs", "VS"), makeSeat("P2"));
    body.append(seats);
    const foot = el("div", "room-foot");
    foot.append(el("span", "room-watchers", "관전자 0명"), el("span", "room-cta", "입장하기 →"));
    body.append(foot);

    card.append(visual, body);
    grid.append(card);
    cards.set(info.id, card);
}

function makeSeat(label) {
    const seat = el("div", "seat");
    seat.append(el("span", "seat-label", label), el("span", "seat-name", "-"), el("span", "seat-ready"));
    return seat;
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        location.href = "index.html";
        return;
    }
    myUid = user.uid;

    const userSnap = await getDoc(doc(db, "users", myUid));
    const nickname = userSnap.data()?.nickname ?? "트레이너";
    document.getElementById("trainer-name").textContent = nickname;
    fillAvatar(document.getElementById("trainer-initial"), {
        uid: myUid,
        name: nickname,
        src: userSnap.data()?.profileImage,
    });

    if (!unsubRooms) {
        unsubRooms = onSnapshot(collection(db, "rooms"), (snap) => {
            const rooms = new Map(snap.docs.map((d) => [d.id, d.data()]));
            renderRooms(rooms);
        });
    }
});

document.getElementById("logoutBtn").onclick = () => signOut(auth);

function renderRooms(rooms) {
    const counts = { waiting: 0, playing: 0, ended: 0 };

    for (const info of ROOMS) {
        const room = rooms.get(info.id);
        const status = roomStatus(room);
        if (status.key in counts) counts[status.key]++;
        renderCard(cards.get(info.id), room, status);
    }

    summary.innerHTML = "";
    const labels = { waiting: "대기 중", playing: "게임 중", ended: "게임 종료" };
    for (const [key, n] of Object.entries(counts)) {
        if (!n) continue;
        const pill = el("span", "status-pill");
        pill.dataset.status = key;
        pill.append(el("i"), `${labels[key]} ${n}`);
        summary.append(pill);
    }
}

function renderCard(card, room, status) {
    card.dataset.status = status.key;
    card.querySelector(".status-label").textContent = status.label;

    const closed = status.key === "closed";
    card.setAttribute("aria-disabled", String(closed));
    card.tabIndex = closed ? -1 : 0;

    const seats = card.querySelectorAll(".seat");
    ["player1", "player2"].forEach((slot, i) => {
        const seat = seats[i];
        const name = room?.[`${slot}_name`];
        const key = i === 0 ? "p1" : "p2";
        seat.dataset.empty = String(!name);
        seat.dataset.winner = String(!!name && room?.battle_winner === key);
        seat.querySelector(".seat-name").textContent = name ?? "빈 자리";

        let tag = "";
        if (status.key === "ended" && room.battle_winner === key) tag = "WIN";
        else if (status.key === "waiting" && room?.[`${slot}_ready`]) tag = "READY";
        seat.querySelector(".seat-ready").textContent = tag;
    });

    const spectatorCount = room?.spectators?.length ?? 0;
    card.querySelector(".room-watchers").textContent = closed ? "GM이 방을 열면 입장할 수 있어요" : `관전자 ${spectatorCount}명`;

    const isMine = !!room && !!myUid && (
        room.player1_uid === myUid ||
        room.player2_uid === myUid ||
        (room.spectators ?? []).includes(myUid)
    );
    card.querySelector(".room-mine").hidden = !isMine;

    const seatsFull = !!room?.player1_uid && !!room?.player2_uid;
    let cta = "참가하기 →";
    if (closed) cta = "";
    else if (isMine) cta = "돌아가기 →";
    else if (status.key !== "waiting" || seatsFull) cta = "관전하기 →";
    card.querySelector(".room-cta").textContent = cta;
}
