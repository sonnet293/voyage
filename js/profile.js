// js/profile.js — 트레이너 카드
import { auth, db } from "./firebase.js";
import { supabase, AVATAR_BUCKET } from "./supabase.js";
import { POKEMON_KO, POKEMON_FORMS_KO } from "./data/pokemonKo.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { syncPublicProfile, loadPublicProfile } from "./publicProfile.js";

const SLOT_COUNT  = 6;
const ENTRY_SLOTS = SLOT_COUNT; // users/{uid}.entry(최대 6마리)가 있는 칸은 엔트리로 표시, 없는 칸은 cardSlots
const MAX_RESULTS = 40;
const AVATAR_MAX  = 800; // 업로드 전 긴 변 기준 리사이즈(px)

const TYPE_KO = {
  normal: "노말", fire: "불", water: "물", electric: "전기", grass: "풀", ice: "얼음",
  fighting: "격투", poison: "독", ground: "땅", flying: "비행", psychic: "에스퍼", bug: "벌레",
  rock: "바위", ghost: "고스트", dragon: "드래곤", dark: "악", steel: "강철", fairy: "페어리",
};

const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
// 검색 대상: [PokeAPI pokemon id, 이름, 전국도감 번호] — 리전폼은 id 가 10000번대
const ALL_POKEMON = [...POKEMON_KO.map(([id, name]) => [id, name, id]), ...POKEMON_FORMS_KO];
const ID_BY_NAME = new Map(ALL_POKEMON.map(([id, name]) => [normalize(name), id]));

const spriteUrl = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

const grid          = document.getElementById("party-grid");
const avatarImg     = document.getElementById("avatar-img");
const avatarHolder  = document.getElementById("avatar-placeholder");
const avatarBusy    = document.getElementById("avatar-uploading");
const avatarInput   = document.getElementById("avatar-input");
const nameEl        = document.getElementById("trainer-name");
const messageEl     = document.getElementById("card-message");
const dialog        = document.getElementById("search-dialog");
const searchInput   = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

let userRef   = null;
let entry     = [];
let cardSlots = Array(SLOT_COUNT).fill(null); // users/{uid}.cardSlots: [{ id, name } | null] x6
let editingSlot = null;

// profile.html?uid=다른사람 -> 공개 프로필(profiles/{uid})을 읽기 전용으로 표시
// &embed=1 -> 대기실 팝업 안에 띄울 때 (뒤로가기 링크 숨김)
const params   = new URLSearchParams(location.search);
const viewUid  = params.get("uid");
if (params.get("embed") === "1") document.documentElement.classList.add("embed");
let readOnly   = false;
let myUserData = {}; // 내 users 문서 (수정할 때마다 공개 프로필에 다시 복사)

function syncMine(changes) {
  Object.assign(myUserData, changes);
  syncPublicProfile(auth.currentUser.uid, myUserData);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showMessage(text) {
  messageEl.textContent = text;
}

// ── PokeAPI ──────────────────────────────────────────────
const pokeCache = new Map();

function fetchPokemon(id) {
  if (!pokeCache.has(id)) {
    const req = fetch(`https://pokeapi.co/api/v2/pokemon/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`PokeAPI ${res.status}`);
        return res.json();
      })
      .then((data) => ({
        sprite: data.sprites.front_default ?? spriteUrl(id),
        types: data.types.map((t) => TYPE_KO[t.type.name] ?? t.type.name),
      }))
      .catch((err) => {
        pokeCache.delete(id);
        throw err;
      });
    pokeCache.set(id, req);
  }
  return pokeCache.get(id);
}

// ── 카드 렌더링 ───────────────────────────────────────────
function spriteImg(src, alt, isPortrait = false) {
  const wrap = el("div", "sprite-wrap");
  const img = el("img", isPortrait ? "sprite portrait" : "sprite");
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  wrap.append(img);
  return wrap;
}

function typeChips(types) {
  const box = el("div", "slot-types");
  for (const t of types ?? []) box.append(el("span", `type-chip type-${t}`, t));
  return box;
}

function renderEntrySlot(index, mon) {
  const slot = el("div", "slot entry");
  slot.append(el("span", "slot-no", String(index + 1).padStart(2, "0")), el("span", "slot-badge", "엔트리"));

  // 카드 표시 이름: entry[i].cardName (Firestore 에서만 수정) > entry[i].name
  const name = (typeof mon.cardName === "string" && mon.cardName.trim()) || mon.name;
  const id = ID_BY_NAME.get(normalize(name ?? ""));
  const types = el("div");
  if (id) {
    slot.append(spriteImg(spriteUrl(id), name));
  } else if (mon.portrait) {
    slot.append(spriteImg(mon.portrait, name, true));
  }
  slot.append(el("div", "slot-name", name ?? "???"), types);

  if (mon.type?.length) {
    types.replaceWith(typeChips(mon.type));
  } else if (id) {
    fetchPokemon(id).then((p) => types.replaceWith(typeChips(p.types))).catch(() => {});
  }
  return slot;
}

function renderCustomSlot(index, mon) {
  const slot = el("div", "slot custom");
  slot.append(el("span", "slot-no", String(index + 1).padStart(2, "0")));
  const types = el("div");
  const sprite = spriteImg(spriteUrl(mon.id), mon.name);

  fetchPokemon(mon.id)
    .then((p) => {
      sprite.querySelector("img").src = p.sprite;
      types.replaceWith(typeChips(p.types));
    })
    .catch(() => {});

  if (readOnly) {
    slot.classList.add("readonly");
    slot.append(sprite, el("div", "slot-name", mon.name), types);
    return slot;
  }

  slot.title = "클릭해서 다른 포켓몬으로 변경";
  const edit = el("button", "slot-edit");
  edit.type = "button";
  edit.setAttribute("aria-label", `${mon.name} 변경`);
  edit.addEventListener("click", () => openSearch(index));
  slot.append(edit);

  const remove = el("button", "slot-remove", "✕");
  remove.type = "button";
  remove.title = "비우기";
  remove.setAttribute("aria-label", `${mon.name} 비우기`);
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    saveSlot(index, null);
  });

  slot.append(remove, sprite, el("div", "slot-name", mon.name), types);
  return slot;
}

function renderEmptySlot(index) {
  if (readOnly) {
    const slot = el("div", "slot empty readonly");
    slot.append(el("span", "slot-no", String(index + 1).padStart(2, "0")), el("span", null, "비어 있음"));
    return slot;
  }
  const slot = el("button", "slot empty");
  slot.type = "button";
  slot.setAttribute("aria-label", `${index + 1}번 칸에 포켓몬 추가`);
  slot.append(el("span", "slot-no", String(index + 1).padStart(2, "0")), el("span", "slot-plus", "+"), el("span", null, "포켓몬 추가"));
  slot.addEventListener("click", () => openSearch(index));
  return slot;
}

function renderGrid() {
  grid.replaceChildren();
  let filled = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const mon = i < ENTRY_SLOTS ? entry[i] : null;
    if (mon || cardSlots[i]) filled++;
    if (mon) grid.append(renderEntrySlot(i, mon));
    else if (cardSlots[i]) grid.append(renderCustomSlot(i, cardSlots[i]));
    else grid.append(renderEmptySlot(i));
  }
  document.getElementById("party-count").textContent = `${filled} / ${SLOT_COUNT}`;
}

async function saveSlot(index, mon) {
  const prev = cardSlots[index];
  cardSlots[index] = mon;
  renderGrid();
  try {
    await setDoc(userRef, { cardSlots }, { merge: true });
    syncMine({ cardSlots });
    showMessage("");
  } catch (err) {
    console.error(err);
    cardSlots[index] = prev;
    renderGrid();
    showMessage("저장 실패");
  }
}

// ── 검색 ─────────────────────────────────────────────────
function searchPokemon(query) {
  const q = normalize(query);
  if (!q) return [];
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    return ALL_POKEMON.filter(([, , dex]) => dex === n || String(dex).startsWith(q)).slice(0, MAX_RESULTS);
  }
  const starts = [];
  const contains = [];
  for (const row of ALL_POKEMON) {
    const name = normalize(row[1]);
    if (name.startsWith(q)) starts.push(row);
    else if (name.includes(q)) contains.push(row);
  }
  return [...starts, ...contains].slice(0, MAX_RESULTS);
}

function renderResults() {
  const query = searchInput.value;
  const rows = searchPokemon(query);
  searchResults.replaceChildren();

  if (!query.trim()) {
    searchResults.append(el("p", "hint", "포켓몬 이름이나 도감 번호를 입력"));
    return;
  }
  if (!rows.length) {
    searchResults.append(el("p", "hint", "검색 결과 없음"));
    return;
  }
  for (const [id, name, dex] of rows) {
    const btn = el("button", "result");
    btn.type = "button";
    const img = el("img", "sprite");
    img.src = spriteUrl(id);
    img.alt = "";
    img.loading = "lazy";
    btn.append(img, el("span", null, name), el("small", null, `No.${String(dex).padStart(4, "0")}`));
    btn.addEventListener("click", () => {
      saveSlot(editingSlot, { id, name });
      dialog.close();
    });
    searchResults.append(btn);
  }
}

function openSearch(index) {
  if (!userRef || readOnly) return;
  editingSlot = index;
  searchInput.value = "";
  renderResults();
  dialog.showModal();
  searchInput.focus();
}

searchInput.addEventListener("input", renderResults);
document.getElementById("avatar").addEventListener("keydown", (event) => {
  if (readOnly) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    avatarInput.click();
  }
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close(); // 바깥(backdrop) 클릭 시 닫기
});

// ── 프로필 사진 (Supabase Storage) ────────────────────────
function setAvatar(url) {
  avatarImg.hidden = !url;
  avatarHolder.hidden = !!url;
  if (url) avatarImg.src = url;
}

// 큰 사진은 업로드 전에 줄여서 webp로 변환 (GIF는 애니메이션 유지를 위해 그대로)
async function prepareImage(file) {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, AVATAR_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
}

avatarInput.addEventListener("change", async () => {
  const file = avatarInput.files[0];
  avatarInput.value = "";
  if (!file || !auth.currentUser || readOnly) return;
  if (file.size > 10 * 1024 * 1024) {
    showMessage("10MB 이하의 이미지만 올릴 수 있음");
    return;
  }

  avatarBusy.hidden = false;
  showMessage("");
  try {
    const blob = await prepareImage(file);
    const path = `${auth.currentUser.uid}/avatar`;
    const { error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(path, blob, { upsert: true, contentType: blob.type, cacheControl: "3600" });
    if (error) throw error;

    const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const url = `${data.publicUrl}?v=${Date.now()}`; // 같은 경로 덮어쓰기라 캐시 무효화용
    await setDoc(userRef, { profileImage: url }, { merge: true });
    syncMine({ profileImage: url });
    setAvatar(url);
  } catch (err) {
    console.error(err);
    showMessage("사진 업로드 실패");
  } finally {
    avatarBusy.hidden = true;
  }
});

// ── 시작 ─────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = "index.html";
    return;
  }
  if (viewUid && viewUid !== user.uid) {
    await showOtherTrainer(viewUid);
    return;
  }

  userRef = doc(db, "users", user.uid);

  try {
    const snap = await getDoc(userRef);
    const data = snap.exists() ? snap.data() : {};
    entry = Array.isArray(data.entry) ? data.entry : [];
    if (Array.isArray(data.cardSlots)) {
      cardSlots = Array.from({ length: SLOT_COUNT }, (_, i) => data.cardSlots[i] ?? null);
    }
    nameEl.textContent = data.nickname ?? user.email ?? "트레이너";
    setAvatar(data.profileImage ?? null);
    myUserData = data;
    syncMine({});
  } catch (err) {
    console.error(err);
    showMessage("정보를 불러오지 못함");
  }
  renderGrid();
});

// 다른 트레이너의 카드 (읽기 전용)
async function showOtherTrainer(uid) {
  readOnly = true;
  document.body.classList.add("readonly");
  document.title = "트레이너 카드";
  avatarInput.disabled = true;
  const avatarLabel = document.getElementById("avatar");
  avatarLabel.removeAttribute("title");
  avatarLabel.removeAttribute("role");
  avatarLabel.removeAttribute("aria-label");
  avatarLabel.tabIndex = -1;
  avatarHolder.replaceChildren(el("span", "avatar-symbol", "?"), el("span", null, "프로필 사진이 없어요"));

  try {
    const data = await loadPublicProfile(uid);
    if (!data) {
      nameEl.textContent = "???";
      showMessage("트레이너 카드 없음");
    } else {
      entry = Array.isArray(data.entry) ? data.entry : [];
      cardSlots = Array.from({ length: SLOT_COUNT }, (_, i) => data.cardSlots?.[i] ?? null);
      nameEl.textContent = data.nickname ?? "트레이너";
      document.title = `${data.nickname ?? "트레이너"}의 트레이너 카드`;
      setAvatar(data.profileImage ?? null);
    }
  } catch (err) {
    console.error(err);
    showMessage("트레이너 카드 불러오기 실패");
  }
  renderGrid();
}
