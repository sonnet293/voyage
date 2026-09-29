// js/roomLeave.js
// 게임이 진행 중이 아닐 때 방에서 내 자리를 비운다 (로비 필드만 수정하므로 플레이어 권한으로 가능).
// 플레이어가 나가면 관전자 중 한 명을 무작위로 그 자리에 올린다.
import { updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export async function vacateSeat(roomRef, room, uid) {
    const req = room.swap_request;
    const swapClear = req && (req.fromUid === uid || req.toUid === uid)
        ? { swap_request: deleteField() }
        : {};

    const spectators = room.spectators ?? [];
    const spectatorNames = room.spectator_names ?? [];
    const slot = room.player1_uid === uid ? "player1"
        : room.player2_uid === uid ? "player2"
        : null;

    if (slot) {
        if (spectators.length > 0) {
            const randIdx = Math.floor(Math.random() * spectators.length);
            await updateDoc(roomRef, {
                [`${slot}_uid`]: spectators[randIdx],
                [`${slot}_name`]: spectatorNames[randIdx],
                [`${slot}_ready`]: false,
                spectators: spectators.filter((_, i) => i !== randIdx),
                spectator_names: spectatorNames.filter((_, i) => i !== randIdx),
                ...swapClear
            });
        } else {
            await updateDoc(roomRef, {
                [`${slot}_uid`]: null,
                [`${slot}_name`]: null,
                [`${slot}_ready`]: false,
                ...swapClear
            });
        }
        return;
    }

    const idx = spectators.indexOf(uid);
    if (idx === -1) return;
    await updateDoc(roomRef, {
        spectators: spectators.filter((_, i) => i !== idx),
        spectator_names: spectatorNames.filter((_, i) => i !== idx),
        ...swapClear
    });
}
