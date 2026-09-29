// intro.js

import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js"
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"

const BGM_LIST = [
  "../bgm/bgm1.mp3",
  "../bgm/bgm2.mp3",
  "../bgm/bgm3.mp3"
]

export let bgmAudio = null

export function fadeBgmOut(duration = 2000) {
  if (!bgmAudio) return
  const step = bgmAudio.volume / (duration / 50)
  const timer = setInterval(() => {
    if (bgmAudio.volume > step) {
      bgmAudio.volume = Math.max(0, bgmAudio.volume - step)
    } else {
      bgmAudio.volume = 0
      bgmAudio.pause()
      clearInterval(timer)
    }
  }, 50)
}

function playBgm() {
  if (bgmAudio) return
  const chosen = BGM_LIST[Math.floor(Math.random() * BGM_LIST.length)]
  bgmAudio = new Audio(chosen)
  bgmAudio.loop   = true
  bgmAudio.volume = 0.7
  bgmAudio.play().catch(() => {})
}

const overlay     = document.getElementById("intro-overlay")
const touchScreen = document.getElementById("touch-screen")
const readyStatus = document.getElementById("touch-ready-status")
const vsScreen    = document.getElementById("vs-screen")
const roomRef     = doc(db, "rooms", ROOM_ID)

const isSpectatorParam = new URLSearchParams(location.search).get("spectator") === "true"

let myUid          = null
let mySlot         = null
let touched        = false
let introDone      = false  // 내 인트로 5초가 끝났는지
let opponentReady  = false  // 상대방이 ready를 올렸는지 (한번 true되면 유지)

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

onAuthStateChanged(auth, async (user) => {
  if (!user) return
  myUid = user.uid

  if (isSpectatorParam) {
    skipIntro()
    return
  }

  const snap = await getDoc(roomRef)
  const room = snap.data()
  mySlot = room?.player1_uid === myUid ? "p1" : "p2"

  // 인트로가 이미 끝난 상태 = 게임 도중 새로고침 → 인트로 스킵
  if (room?.intro_done) {
    skipIntro()
    return
  }

  bindTouch()
  listenReady()
})

function bindTouch() {
  const handler = () => {
    if (touched) return
    touched = true
    document.removeEventListener("click",      handler)
    document.removeEventListener("touchstart", handler)
    onTouched()
  }
  document.addEventListener("click",      handler)
  document.addEventListener("touchstart", handler)
}

async function onTouched() {
  // BGM — 터치 컨텍스트 안에서 바로 재생 (인트로 중에도 들리게)
  playBgm()

  const snap = await getDoc(roomRef)
  const room = snap.data()

  // VS 인트로 재생
  playVsIntro(room)

  // Firestore에 내 ready 마킹
  const field = mySlot === "p1" ? "intro_ready_p1" : "intro_ready_p2"
  await updateDoc(roomRef, { [field]: true })
}

function listenReady() {
  onSnapshot(roomRef, (snap) => {
    const room = snap.data()
    if (!room) return

    const r1 = !!room.intro_ready_p1
    const r2 = !!room.intro_ready_p2

    // opponentReady는 한번 true되면 false로 안 돌아감
    // → intro_ready 필드가 나중에 초기화돼도 영향 없음
    if (r1 && r2) opponentReady = true

    if (touched && !opponentReady) readyStatus.innerText = "상대방을 기다리는 중..."

    // 내 인트로가 끝난 상태에서 상대방 ready 도착 → 배틀 시작
    if (opponentReady && introDone) startBattle()
  })
}

async function playVsIntro(room) {
  document.getElementById("vs-name-left").textContent  = (room.player1_name ?? "PLAYER1").toUpperCase()
  document.getElementById("vs-name-right").textContent = (room.player2_name ?? "PLAYER2").toUpperCase()

  touchScreen.style.display = "none"
  vsScreen.classList.add("show")

  await wait(50)

  const flash      = document.getElementById("vs-flash")
  const burst      = document.getElementById("vs-burst")
  const vsLeft     = document.getElementById("vs-left")
  const vsRight    = document.getElementById("vs-right")
  const vsLabel    = document.getElementById("vs-label")
  const innerLeft  = document.getElementById("vs-inner-left")
  const innerRight = document.getElementById("vs-inner-right")

  flash.classList.add("show")
  await wait(100); vsLeft.classList.add("show")
  await wait(100); vsRight.classList.add("show")
  await wait(250)
  vsLabel.classList.add("show")
  flash.classList.add("show")
  burst.classList.add("show")
  vsScreen.classList.add("vs-shake")
  await wait(450)
  innerLeft.classList.add("drift-left")
  innerRight.classList.add("drift-right")

  // 5초 인트로 대기
  await wait(5000)
  introDone = true

  if (opponentReady) {
    // 상대방도 이미 ready → 바로 배틀
    startBattle()
  } else {
    // 상대방 아직 대기 중 → listenReady에서 처리
    vsScreen.style.opacity = "0.3"
    readyStatus.style.cssText = "color:white; font-size:clamp(1rem,3vw,1.4rem); position:absolute; bottom:10vh; width:100%; text-align:center; z-index:10;"
    readyStatus.innerText = "상대방을 기다리는 중..."
  }
}

function startBattle() {
  if (overlay.classList.contains("fade-out")) return

  if (mySlot === "p1") updateDoc(roomRef, { intro_done: true }).catch(() => {})
  document.dispatchEvent(new Event("battle:introDone"))

  overlay.classList.add("fade-out")
  setTimeout(() => {
    overlay.classList.add("hidden")
    initVolumeSlider()
  }, 800)
}

function initVolumeSlider() {
  const slider = document.getElementById("bgm-volume")
  const label  = document.getElementById("bgm-volume-label")
  if (!slider) return
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value)
    if (bgmAudio) bgmAudio.volume = v
    label.innerText = Math.round(v * 100) + "%"
  })
}

function skipIntro() {
  overlay.classList.add("hidden")
  initVolumeSlider()
  document.dispatchEvent(new Event("battle:introDone"))

  // BGM 복원
  // 모바일은 터치 컨텍스트 안에서 Audio 생성 + play() 해야 함
  // → 토스트 버튼 onclick 안에서 처리
  const chosen = BGM_LIST[Math.floor(Math.random() * BGM_LIST.length)]

  // 데스크탑은 바로 시도
  const testAudio = new Audio(chosen)
  testAudio.loop   = true
  testAudio.volume = 0.7
  testAudio.play().then(() => {
    bgmAudio = testAudio  // 성공하면 그대로 사용
  }).catch(() => {
    // 실패하면 토스트 — onclick 안에서 새로 생성
    showBgmToast(chosen)
    setTimeout(() => {
      if (bgmAudio && bgmAudio.paused) showBgmToast(chosen)
    }, 500)
  })

  setTimeout(() => {
    if (!bgmAudio || bgmAudio.paused) showBgmToast(chosen)
  }, 500)
}

function showBgmToast(chosen) {
  if (document.getElementById("bgm-toast")) return

  if (!document.getElementById("bgm-toast-style")) {
    const s = document.createElement("style")
    s.id = "bgm-toast-style"
    s.textContent = `
      @keyframes fadeInUp {
        from { opacity:0; transform:translateX(-50%) translateY(10px) }
        to   { opacity:1; transform:translateX(-50%) translateY(0) }
      }
      #bgm-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8); color: #fff;
        padding: 12px 24px; border-radius: 999px;
        font-size: 14px; z-index: 9999;
        border: none; cursor: pointer;
        animation: fadeInUp 0.3s ease;
        white-space: nowrap;
      }
    `
    document.head.appendChild(s)
  }

  const btn = document.createElement("button")
  btn.id = "bgm-toast"
  btn.innerText = "🎵 탭하여 브금 재생"

  btn.onclick = () => {
    // 터치 컨텍스트 안에서 Audio 새로 생성 + play() → 모바일 정책 우회
    bgmAudio = new Audio(chosen)
    bgmAudio.loop   = true
    bgmAudio.volume = 0.7
    bgmAudio.play().catch(() => {})
    btn.remove()
  }

  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 10000)
}