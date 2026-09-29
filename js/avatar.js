// js/avatar.js
// 트레이너 카드 프로필 이미지(Supabase 공개 버킷 avatars/{uid}/avatar)를 아바타로 보여준다.
// 다른 유저의 users 문서는 규칙상 읽을 수 없으므로, uid로 공개 URL을 직접 만든다.
export const SUPABASE_URL = "https://xnbegbwpqhhfbnhwjbuw.supabase.co";
export const AVATAR_BUCKET = "avatars";

// 페이지를 새로 열 때마다 최신 이미지를 받도록 (프로필에서 같은 경로에 덮어쓰기 때문)
const PAGE_VERSION = Date.now();

// 이미지가 없는(업로드 안 한) uid는 다시 요청하지 않고 바로 이니셜로 표시
const missing = new Set();
// 한 번 불러온 URL은 다시 그릴 때 이니셜을 거치지 않고 바로 이미지로 (대기실은 스냅샷마다 다시 그림)
const loaded = new Set();

export function avatarUrl(uid) {
    return `${SUPABASE_URL}/storage/v1/object/public/${AVATAR_BUCKET}/${uid}/avatar?v=${PAGE_VERSION}`;
}

// container 안을 프로필 이미지로 채우고, 없거나 실패하면 이름 첫 글자를 보여준다.
// src를 주면 그 URL을 우선 사용 (내 users 문서의 profileImage 등)
export function fillAvatar(container, { uid, name, src } = {}) {
    const initial = [...(name ?? "")][0] ?? "?";
    container.textContent = initial;
    container.classList.remove("has-image");

    const url = src || (uid && !missing.has(uid) ? avatarUrl(uid) : null);
    if (!url) return;

    const show = (img) => {
        container.textContent = "";
        container.append(img);
        container.classList.add("has-image");
    };

    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.onload = () => {
        loaded.add(url);
        show(img);
    };
    img.onerror = () => {
        if (uid && !src) missing.add(uid);
    };
    img.src = url;
    if (loaded.has(url)) show(img);
}