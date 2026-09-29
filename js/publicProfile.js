// js/publicProfile.js
import { db } from "./firebase.js";
import { doc, getDoc, setDoc, serverTimestamp }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const profileRef = (uid) => doc(db, "profiles", uid);

// users 문서 데이터 -> 공개 프로필 (firestore.rules의 profiles 허용 필드와 맞출 것)
export function syncPublicProfile(uid, userData) {
    return setDoc(profileRef(uid), {
        nickname: userData?.nickname ?? null,
        profileImage: userData?.profileImage ?? null,
        cardSlots: Array.isArray(userData?.cardSlots) ? userData.cardSlots : [],
        entry: Array.isArray(userData?.entry) ? userData.entry : [],
        updatedAt: serverTimestamp(),
    }).catch((err) => console.error("공개 프로필 갱신 실패", err));
}

export async function loadPublicProfile(uid) {
    const snap = await getDoc(profileRef(uid));
    return snap.exists() ? snap.data() : null;
}
