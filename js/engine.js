// js/engine.js
// 전투 판정 엔진. Firestore/DOM에 의존하지 않는 순수 계산만 담당한다.
// GM 브라우저(gm/gm.js)만 이 파일로 판정하고, 플레이어 브라우저는 요청(actions)만 생성한다.
// 모든 함수는 room 스냅샷을 받아 { ok: true, update } 또는 { ok: false, reason }을 돌려준다.
import { MOVES } from "./moves.js";
import { getTypeMultiplier, pokemonTypes } from "./typeChart.js";
import {
  applyStatus,
  applyVolatile,
  applyEndOfTurnStatusDamage,
  checkActionPrevented,
  checkConfusionInterrupt,
  josa,
} from "./effecthandler.js";
import { setHazard, applyHazardsOnSwitchIn, defaultField } from "./field.js";
import {
  setWeather,
  weatherPowerMultiplier,
  preventsFreeze,
  sandstormDefenseBonus,
  tickWeather,
  applyWeatherDamage,
} from "./weather.js";

const RANK_MULT_TABLE = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3];

export const BATTLE_RESET_FIELDS = {
  game_started: false,
  game_started_at: null,
  player1_ready: false,
  player2_ready: false,
  p1_entry: null,
  p2_entry: null,
  p1_active_idx: 0,
  p2_active_idx: 0,
  p1_pending_switch: false,
  p2_pending_switch: false,
  p1_ranks: null,
  p2_ranks: null,
  p1_field: null,
  p2_field: null,
  weather: null,
  battle_turn: null,
  round_first: null,
  round_no: 0,
  p1_roll: null,
  p2_roll: null,
  battle_log: [],
  battle_event_log: [],
  battle_winner: null,
  intro_ready_p1: false,
  intro_ready_p2: false,
  intro_done: false,
};

const ok = (update) => ({ ok: true, update });
const fail = (reason) => ({ ok: false, reason });

export function displayName(key, room) {
  return key === "p1" ? (room.player1_name ?? "Player1") : (room.player2_name ?? "Player2");
}

// uid -> "p1" | "p2" | "spectator" | null
export function sideOfUid(room, uid) {
  if (!room || !uid) return null;
  if (room.player1_uid === uid) return "p1";
  if (room.player2_uid === uid) return "p2";
  if ((room.spectators ?? []).includes(uid)) return "spectator";
  return null;
}

function rollD10() {
  return Math.floor(Math.random() * 10) + 1;
}

function clampRank(value) {
  return Math.max(-3, Math.min(3, value));
}

function rankMultiplier(rank) {
  return RANK_MULT_TABLE[clampRank(rank) + 3];
}

export function defaultRanks() {
  return {
    atk: { value: 0, expireTurn: 0 },
    def: { value: 0, expireTurn: 0 },
    evasion: { value: 0, expireTurn: 0 },
  };
}

const RANK_FIELD_MAP = {
  atk: { self: true, stat: "atk" },
  def: { self: true, stat: "def" },
  spd: { self: true, stat: "evasion" },
  targetAtk: { self: false, stat: "atk" },
  targetDef: { self: false, stat: "def" },
  targetSpd: { self: false, stat: "evasion" },
};

function getEffectiveRank(ranks, stat, currentTurn) {
  const data = ranks?.[stat];
  if (!data) return 0;
  if (currentTurn > data.expireTurn) return 0;
  return data.value;
}

// 기술 타입 vs 방어 포켓몬의 다중 타입 -> 각 타입 배율을 곱해서 반환
function getDefenderTypeMultiplier(moveType, defenderTypes) {
  if (!Array.isArray(defenderTypes) || defenderTypes.length === 0) return 1;
  return defenderTypes.reduce((mult, t) => mult * getTypeMultiplier(moveType, t), 1);
}

// 공격자 타입 배열에 기술 타입이 포함되어 있으면 자속 보정
function hasStab(attackerTypes, moveType) {
  return Array.isArray(attackerTypes) && attackerTypes.includes(moveType);
}

// 회피율(%) = 5 * (방어자 spd - 공격자 spd), 0~10% 범위로 clamp
function calcBaseEvasionPercent(attackerSpd, defenderSpd) {
  return Math.max(0, Math.min(18, 5 * (defenderSpd - attackerSpd)));
}

// 명중 판정 (기술 자체의 명중률만 사용). 실패하면 "빗나갔다" - 공격자 쪽 귀책.
function rollAccuracy(moveData) {
  if (moveData.alwaysHit) return true;
  return Math.random() < moveData.accuracy / 100;
}

// 회피 판정 (방어자의 회피율만 사용). 성공하면 "맞지 않았다" - 방어자 쪽 회피.
// 회피율 = spd차 기반 회피율(0~10%) * 회피 랭크 보정값(0.7~1.3)
function rollEvasion(attacker, defender, defenderRanks, currentTurn) {
  const baseEvasionPct = calcBaseEvasionPercent(attacker.spd, defender.spd);
  const evasionRankMult = rankMultiplier(getEffectiveRank(defenderRanks, "evasion", currentTurn));
  const finalEvasionPct = Math.max(0, Math.min(100, baseEvasionPct * evasionRankMult));
  return Math.random() < finalEvasionPct / 100;
}

// 연속자르기: 최대 위력과 누적 상한 (30 -> 40 -> 50)
const FURY_CUTTER_MAX_POWER = 50;
const FURY_CUTTER_MAX_STACK = 2;

// 빛의장막/리플렉터: 지속 라운드 수, 받는 데미지 배율
const SCREEN_TURNS = 5;
const SCREEN_DAMAGE_MULT = 0.75;

// 방어류(방어/판별/니들가드): 사용한 라운드 포함 2라운드 유지, 직전 행동도 방어류 성공이었으면 성공률 45%
const GUARD_TURNS = 2;
const GUARD_REPEAT_CHANCE = 0.33;

// 포켓몬에 걸려 있는 방어류 상태. guard: { name: 기술명, spiky: 니들가드 여부, expireTurn } | null
function activeGuard(pokemon, currentTurn) {
  const guard = pokemon?.guard;
  return guard && currentTurn <= guard.expireTurn ? guard : null;
}

// 거대해머류로 이번 라운드에 잠긴 기술인지. moveLock: { name: 기술명, turn: 사용 불가 라운드 }
export function isMoveLocked(pokemon, moveName, currentTurn) {
  const lock = pokemon?.moveLock;
  return !!lock && lock.name === moveName && lock.turn === currentTurn;
}

// 상대 포켓몬에게 영향을 주는 기술인지 (데미지 / 상태이상·상태변화 / 상대 랭크 변화)
function targetsOpponent(moveData) {
  if (moveData.power > 0) return true;
  if (moveData.effect?.status || moveData.effect?.volatile) return true;
  const rank = moveData.rank ?? {};
  return !!(rank.targetAtk || rank.targetDef || rank.targetSpd);
}

// 급소 판정. 급소율 = 공격력 * 2% (100% 상한). 급소 시 최종 피해량 x1.5.
function rollCrit(attacker) {
  return Math.random() < Math.min(1, (attacker.atk ?? 0) * 0.02);
}

// 랭크 변화 로그 메시지. oldValue/newValue는 적용 전/후의 유효 랭크값(-3~3), wasIncrease는 이번에 올리려던 시도였는지.
function buildRankChangeMessage(name, statLabel, oldValue, newValue, wasIncrease) {
  const delta = newValue - oldValue;
  if (delta === 0) {
    return wasIncrease
      ? `${name}의 ${statLabel}${josa(statLabel, "은는")} 더 이상 올라가지 않는다!`
      : `${name}의 ${statLabel}${josa(statLabel, "은는")} 더 이상 내려가지 않는다!`;
  }
  if (newValue === 0) {
    return `${name}의 ${statLabel}${josa(statLabel, "이가")} 원래대로 돌아왔다!`;
  }
  if (delta > 0) {
    return `${name}의 ${statLabel}${josa(statLabel, "이가")} ${delta} 상승했다!`;
  }
  return `${name}의 ${statLabel}${josa(statLabel, "이가")} ${-delta} 하락했다!`;
}

function decideFirst(p1Active, p2Active) {
  let score1, score2, r1, r2;
  for (let i = 0; i < 20; i++) {
    r1 = rollD10();
    r2 = rollD10();
    score1 = p1Active.spd + r1;
    score2 = p2Active.spd + r2;
    if (score1 !== score2) break;
  }
  return { first: score1 > score2 ? "p1" : "p2", r1, r2 };
}

function handleFaintSwitch(entries, sideKey, activeIdx) {
  const arr = entries[sideKey];
  const idx = activeIdx[sideKey];
  const pkmn = arr[idx];
  if (!pkmn || pkmn.hp > 0) return { fainted: false };

  const name = pkmn.name ?? "포켓몬";
  const hasAliveBench = arr.some((p, i) => i !== idx && p && p.hp > 0);
  return { fainted: true, allFainted: !hasAliveBench, name };
}

function buildTurnAdvanceUpdate(room, entries, activeIdx, currentTurn, log, events, alreadyPendingSides = new Set(), weather = room.weather ?? null) {
  const update = {};

  if (alreadyPendingSides.size > 0) {
    update.battle_turn = null;
    return update;
  }

  if (room.battle_turn === room.round_first) {
    update.battle_turn = room.battle_turn === "p1" ? "p2" : "p1";
    return update;
  }

  for (const side of ["p1", "p2"]) {
    const pkmn = entries[side][activeIdx[side]];
    if (!pkmn) continue;
    const tick = applyEndOfTurnStatusDamage(pkmn, currentTurn);
    if (tick.damage > 0) {
      entries[side][activeIdx[side]] = tick.pokemon;
      log.push(tick.message);
      events.push({ logIndex: log.length - 1, type: "hit", side, hp: tick.pokemon.hp, status: tick.pokemon.status ?? null, hasAttacker: false });
    }
  }

  // 방어류 만료: 피격되지 않았으면 사용한 라운드 포함 2라운드째 종료 시 해제
  for (const side of ["p1", "p2"]) {
    const pkmn = entries[side][activeIdx[side]];
    if (!pkmn?.guard || currentTurn < pkmn.guard.expireTurn) continue;
    entries[side][activeIdx[side]] = { ...pkmn, guard: null };
    if (currentTurn === pkmn.guard.expireTurn) {
      const n = pkmn.name ?? "포켓몬";
      log.push(`${n}의 ${pkmn.guard.name}${josa(pkmn.guard.name, "이가")} 풀렸다!`);
    }
  }

  // 빛의장막/리플렉터 만료 (날씨와 같은 방식: 사용한 라운드 + 5라운드 뒤 라운드 종료 시 해제)
  for (const side of ["p1", "p2"]) {
    const pkmn = entries[side][activeIdx[side]];
    if (!pkmn?.screen || currentTurn < pkmn.screen.expireTurn) continue;
    entries[side][activeIdx[side]] = { ...pkmn, screen: null };
    const n = pkmn.name ?? "포켓몬";
    log.push(`${n}의 ${pkmn.screen.name}${josa(pkmn.screen.name, "이가")} 사라졌다!`);
  }

  // 날씨 라운드 종료 처리: 지속 로그 -> 모래바람/싸라기눈 데미지 -> (종료라면) 종료 로그
  const weatherTick = tickWeather(weather, currentTurn);
  if (weatherTick.active) {
    log.push(weatherTick.continueMessage);
    for (const side of ["p1", "p2"]) {
      const pkmn = entries[side][activeIdx[side]];
      if (!pkmn) continue;
      const dmgResult = applyWeatherDamage(pkmn, weather.type);
      if (dmgResult.damage > 0) {
        entries[side][activeIdx[side]] = dmgResult.pokemon;
        log.push(dmgResult.message);
        events.push({ logIndex: log.length - 1, type: "hit", side, hp: dmgResult.pokemon.hp, status: dmgResult.pokemon.status ?? null, hasAttacker: false });
      }
    }
    if (weatherTick.expired) log.push(weatherTick.endMessage);
    update.weather = weatherTick.weather;
  }

  let winner = null;
  let needsSwitch = false;
  for (const side of ["p1", "p2"]) {
    const opp = side === "p1" ? "p2" : "p1";
    const faint = handleFaintSwitch(entries, side, activeIdx);
    if (!faint.fainted) continue;

    if (faint.allFainted) {
      winner = opp;
      log.push(`${displayName(opp, room)} 승리!`);
    } else {
      update[`${side}_pending_switch`] = true;
      needsSwitch = true;
      log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
    }
  }

  if (winner) {
    update.battle_winner = winner;
    return update;
  }

  if (needsSwitch) {
    update.battle_turn = null;
    return update;
  }

  Object.assign(update, buildNextRound(entries, activeIdx, currentTurn, log));
  return update;
}

// 다음 라운드 선공 결정 (다이스) + "~의 선공!" 로그
function buildNextRound(entries, activeIdx, currentTurn, log) {
  const p1Active = entries.p1[activeIdx.p1];
  const p2Active = entries.p2[activeIdx.p2];
  const { first, r1, r2 } = decideFirst(p1Active, p2Active);
  const firstPkmnName = (first === "p1" ? p1Active : p2Active)?.name ?? "포켓몬";
  log.push(`${firstPkmnName}의 선공!`);
  return {
    battle_turn: first,
    round_first: first,
    round_no: currentTurn + 1,
    p1_roll: r1,
    p2_roll: r2,
  };
}

// 양쪽 READY -> 게임 시작. entries는 users 문서에서 읽어 온 각 플레이어의 엔트리.
export function startGame(room, p1Entry, p2Entry) {
  if (!room.player1_ready || !room.player2_ready || room.game_started) return fail("시작 조건 아님");
  if (!room.player1_uid || !room.player2_uid) return fail("플레이어 부족");
  const withMax = (entry) => (entry ?? []).map((pkmn) => ({ ...pkmn, maxHp: pkmn.hp }));
  return ok({
    p1_entry: withMax(p1Entry),
    p2_entry: withMax(p2Entry),
    p1_active_idx: 0,
    p2_active_idx: 0,
    game_started: true,
    game_started_at: Date.now(),
    // 새 게임마다 인트로(양쪽 터치 → VS 연출)를 처음부터 다시 진행
    intro_ready_p1: false,
    intro_ready_p2: false,
    intro_done: false,
  });
}

// 게임이 막 시작됐는데 아직 선공이 안 정해졌으면 첫 라운드 세팅.
// round_no로 판단(battle_turn만 보면 강제교체 대기 중의 null 상태와 구분이 안 돼서 재시작 취급될 수 있음).
export function initRound(room) {
  if (!room.game_started || (room.round_no ?? 0) > 0 || room.battle_winner) return fail("이미 시작된 라운드");

  const p1Active = room.p1_entry?.[room.p1_active_idx ?? 0];
  const p2Active = room.p2_entry?.[room.p2_active_idx ?? 0];
  if (!p1Active || !p2Active) return fail("출전 포켓몬 없음");

  const { first, r1, r2 } = decideFirst(p1Active, p2Active);

  const p1Name = displayName("p1", room);
  const p2Name = displayName("p2", room);
  const p1PkmnName = p1Active.name ?? "포켓몬";
  const p2PkmnName = p2Active.name ?? "포켓몬";
  const firstPkmnName = (first === "p1" ? p1Active : p2Active)?.name ?? "포켓몬";

  return ok({
    battle_turn: first,
    round_first: first,
    round_no: 1,
    p1_roll: r1,
    p2_roll: r2,
    p1_ranks: defaultRanks(),
    p2_ranks: defaultRanks(),
    p1_field: defaultField(),
    p2_field: defaultField(),
    weather: null,
    p1_pending_switch: false,
    p2_pending_switch: false,
    battle_log: [
      `${p1Name}${josa(p1Name, "과와")} ${p2Name}의 승부가 시작됐다!`,
      `${p1Name}${josa(p1Name, "은는")} ${p1PkmnName}${josa(p1PkmnName, "을를")} 내보냈다!`,
      `${p2Name}${josa(p2Name, "은는")} ${p2PkmnName}${josa(p2PkmnName, "을를")} 내보냈다!`,
      `${firstPkmnName}의 선공!`,
    ],
    battle_event_log: [],
  });
}

// uTurnIdx: 유턴류 기술(uTurn)로 공격 후 교체해 들어갈 벤치 포켓몬 번호. 살아 있는 벤치가 있으면 필수.
export function useMove(room, myKey, moveIdx, uTurnIdx = null) {
  if (room.battle_winner) return fail("이미 끝난 배틀");
  if (room.battle_turn !== myKey) return fail("내 턴이 아님");

  const oppKey = myKey === "p1" ? "p2" : "p1";
  const entries = {
    p1: [...(room.p1_entry ?? [])],
    p2: [...(room.p2_entry ?? [])],
  };
  const activeIdx = {
    p1: room.p1_active_idx ?? 0,
    p2: room.p2_active_idx ?? 0,
  };
  const currentTurn = room.round_no ?? 1;

  const attacker = entries[myKey][activeIdx[myKey]];
  let defender = entries[oppKey][activeIdx[oppKey]];
  if (!attacker || !defender) return fail("포켓몬 없음");

  // 고스트다이브로 사라진 상태면 어떤 버튼을 눌렀든 그 기술로 강제 공격 (PP는 사라질 때 이미 소모)
  const diving = attacker.ghostDive ?? null;
  if (diving) moveIdx = diving.moveIdx;

  const moveSlot = attacker.moves?.[moveIdx];
  if (!moveSlot) return fail("기술 없음");
  if (!diving && (moveSlot.pp ?? 0) <= 0) return fail("PP 없음"); // PP 없으면 사용 불가

  const moveData = MOVES[moveSlot.name];
  if (!moveData) return fail(`moves.js에 "${moveSlot.name}" 기술이 정의되어 있지 않음`);

  // 거대해머류(heavyHammer): 사용한 다음 라운드에는 같은 기술을 쓸 수 없음
  if (!diving && isMoveLocked(attacker, moveSlot.name, currentTurn)) return fail(`${moveSlot.name}은(는) 이번 라운드에 사용할 수 없음`);

  // 유턴: 공격과 교체가 한 세트. 교체할 수 있는 벤치가 있으면 교체 대상을 함께 받아야 함.
  const myBenchAlive = entries[myKey].some((p, i) => i !== activeIdx[myKey] && p && p.hp > 0);
  if (moveData.uTurn && myBenchAlive) {
    const t = entries[myKey][uTurnIdx];
    if (!Number.isInteger(uTurnIdx) || uTurnIdx === activeIdx[myKey] || !t || t.hp <= 0) return fail("유턴 교체 대상이 올바르지 않음");
  }

  // PP 소모
  const newMoves = [...attacker.moves];
  if (!diving) newMoves[moveIdx] = { ...moveSlot, pp: moveSlot.pp - 1 };
  let currentAttacker = { ...attacker, moves: newMoves };
  entries[myKey][activeIdx[myKey]] = currentAttacker;

  let myRanks = room[`${myKey}_ranks`] ?? defaultRanks();
  let oppRanks = room[`${oppKey}_ranks`] ?? defaultRanks();
  let oppField = room[`${oppKey}_field`] ?? defaultField();
  let currentWeather = room.weather ?? null;

  const log = [...(room.battle_log ?? [])];
  const events = [...(room.battle_event_log ?? [])];
  const update = {};
  let directPendingSide = null;
  let furyCutterHit = false; // 이번 연속자르기가 실제로 맞았는지
  let guardSucceeded = false; // 이번에 방어류 기술이 성공했는지 (연속 사용 판정용)
  const defGuard = activeGuard(defender, currentTurn);

  // 기술을 고른 뒤에야 얼음/마비/혼란으로 인한 행동 저지를 판정 (버튼은 항상 활성화된 상태로 유지)
  const gate = checkActionPrevented(currentAttacker);
  currentAttacker = gate.pokemon;
  let blocked = !gate.canAct;
  if (gate.message) log.push(gate.message);
  // 얼음이 풀리는 등 상태이상이 바뀌었으면 그 줄에서 바로 [상태] 표시를 갱신
  if (gate.message && (gate.pokemon.status ?? null) !== (attacker.status ?? null)) {
    events.push({ logIndex: log.length - 1, type: "status", side: myKey, status: gate.pokemon.status ?? null });
  }

  if (gate.canAct && currentAttacker.volatiles?.["혼란"]) {
    const confusion = checkConfusionInterrupt(currentAttacker);
    currentAttacker = confusion.pokemon;
    if (confusion.message) log.push(confusion.message);
    if (confusion.confused) {
      blocked = true;
      events.push({ logIndex: log.length - 1, type: "hit", side: myKey, hp: currentAttacker.hp, status: currentAttacker.status ?? null, hasAttacker: false });
    }
  }

  // 고스트다이브의 강제 공격(2턴째)은 상대의 방어 상태(방어/판별/니들가드)를 없애고 공격함
  const breaksProtection = !!(diving && moveData.ghostDive);

  // 사라진 상태는 이번 턴으로 끝 (공격하든, 얼음/마비/혼란 등으로 행동이 저지되든)
  if (diving) currentAttacker = { ...currentAttacker, ghostDive: null };

  entries[myKey][activeIdx[myKey]] = currentAttacker;

  if (blocked) {
    // 행동 저지(혼란 자해 포함) -> 자기 자신이 쓰러졌는지 체크
    const faint = handleFaintSwitch(entries, myKey, activeIdx);
    if (faint.fainted) {
      if (faint.allFainted) {
        update.battle_winner = oppKey;
        log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
        log.push(`${displayName(oppKey, room)} 승리!`);
        update[`${myKey}_entry`] = entries[myKey];
        update.battle_log = log;
        update.battle_event_log = events;
        return ok(update);
      }
      update[`${myKey}_pending_switch`] = true;
      log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
      directPendingSide = myKey;
    }
  } else if (moveData.ghostDive && !diving) {
    // 고스트다이브 1턴째: 공격하지 않고 사라짐. 다음 내 턴에 같은 기술로 강제 공격.
    const attackerName = currentAttacker.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    log.push(`${attackerName}${josa(attackerName, "은는")} 어디론가 사라졌다!`);
    currentAttacker = { ...currentAttacker, ghostDive: { moveIdx } };
    entries[myKey][activeIdx[myKey]] = currentAttacker;
  } else if (moveData.spikyShield || moveData.defend) {
    // 방어류(니들가드/방어/판별): 한 번 막거나 2라운드가 지날 때까지 유지.
    // 직전 행동도 방어류 성공이었으면 45% 확률로만 성공. 성공하면 기존 방어류 상태를 새것으로 교체.
    const attackerName = currentAttacker.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    const chance = currentAttacker.guardStreak ? GUARD_REPEAT_CHANCE : 1;
    if (Math.random() < chance) {
      const spiky = !!moveData.spikyShield;
      currentAttacker = { ...currentAttacker, guard: { name: moveSlot.name, spiky, expireTurn: currentTurn + GUARD_TURNS - 1 } };
      entries[myKey][activeIdx[myKey]] = currentAttacker;
      guardSucceeded = true;
      log.push(spiky
        ? `${attackerName}${josa(attackerName, "은는")} 가시로 몸을 지켰다!`
        : `${attackerName}${josa(attackerName, "은는")} 방어 태세에 들어갔다!`);
    } else {
      log.push("그러나 실패했다!");
    }
  } else if (moveData.lightScreen) {
    // 빛의장막/리플렉터: 사용한 포켓몬만 5라운드 동안 받는 데미지 25% 감소. 둘은 중첩되지 않음.
    const attackerName = currentAttacker.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    if (currentAttacker.screen) {
      log.push("그러나 실패했다!");
    } else {
      currentAttacker = { ...currentAttacker, screen: { name: moveSlot.name, appliedTurn: currentTurn, expireTurn: currentTurn + SCREEN_TURNS } };
      entries[myKey][activeIdx[myKey]] = currentAttacker;
      log.push(`${attackerName}${josa(attackerName, "은는")} ${moveSlot.name}${josa(moveSlot.name, "으로")} 받는 데미지가 줄어들었다!`);
    }
  } else if (defGuard && !defGuard.spiky && moveData.power > 0 && !breaksProtection) {
    // 상대의 방어/판별: 공격 기술을 막고 방어 상태 소모 (변화기는 막지 않음)
    const attackerName = currentAttacker.name ?? "포켓몬";
    const defenderName = defender.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    log.push(`${defenderName}${josa(defenderName, "은는")} 공격으로부터 몸을 지켰다!`);
    entries[oppKey][activeIdx[oppKey]] = { ...defender, guard: null };
  } else if (defGuard?.spiky && targetsOpponent(moveData) && !breaksProtection) {
    // 상대의 니들가드: 상대를 노리는 기술(공격기/변화기)을 막고(방패 소모), 사용한 쪽이 자기 최대 체력의 1/8 데미지
    const attackerName = currentAttacker.name ?? "포켓몬";
    const defenderName = defender.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    log.push(`${defenderName}${josa(defenderName, "은는")} 몸을 지켰다!`);
    entries[oppKey][activeIdx[oppKey]] = { ...defender, guard: null };

    const spikeDmg = Math.max(1, Math.floor((currentAttacker.maxHp ?? currentAttacker.hp) / 8));
    currentAttacker = { ...currentAttacker, hp: Math.max(0, currentAttacker.hp - spikeDmg) };
    entries[myKey][activeIdx[myKey]] = currentAttacker;
    log.push(`${attackerName}${josa(attackerName, "은는")} 가시에 찔려 데미지를 입었다!`);
    events.push({ logIndex: log.length - 1, type: "hit", side: myKey, hp: currentAttacker.hp, status: currentAttacker.status ?? null, hasAttacker: false });

    const faint = handleFaintSwitch(entries, myKey, activeIdx);
    if (faint.fainted) {
      log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
      if (faint.allFainted) {
        update.battle_winner = oppKey;
        log.push(`${displayName(oppKey, room)} 승리!`);
        update[`${myKey}_entry`] = entries[myKey];
        update[`${oppKey}_entry`] = entries[oppKey];
        update.battle_log = log;
        update.battle_event_log = events;
        return ok(update);
      }
      update[`${myKey}_pending_switch`] = true;
      directPendingSide = myKey;
    }
  } else if (defender.ghostDive && targetsOpponent(moveData)) {
    // 상대가 고스트다이브로 사라져 있으면 상대를 노리는 기술은 반드시 빗나감
    const attackerName = currentAttacker.name ?? "포켓몬";
    const defenderName = defender.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    log.push(`${defenderName}에게는 맞지 않았다!`);
  } else {
    const attackerName = currentAttacker.name ?? "포켓몬";
    log.push(`${attackerName}의 ${moveSlot.name}!`);
    const moveLogIndex = log.length - 1;

    // 고스트다이브 공격은 명중/회피와 상관없이 상대의 방어 상태(니들가드 등)를 없앰
    if (breaksProtection) {
      if (defGuard) {
        defender = { ...defender, guard: null };
        entries[oppKey][activeIdx[oppKey]] = defender;
        const dn = defender.name ?? "포켓몬";
        log.push(`${dn}의 ${defGuard.name}${josa(defGuard.name, "이가")} 사라졌다!`);
      }
    }

    const accuracyHit = rollAccuracy(moveData);

    if (!accuracyHit) {
      log.push(`그러나 ${attackerName}의 공격은 빗나갔다!`);
    } else {
      const evaded = !moveData.alwaysHit && rollEvasion(attacker, defender, oppRanks, currentTurn);
      const defenderName = defender.name ?? "포켓몬";

      if (evaded) {
        log.push(`${defenderName}에게는 맞지 않았다!`);
      } else {
        // 공격 랭크업/다운: (위력 + 공격력x4 + 1d10) 전체에 곱해짐, 타입상성/자속 적용 "이전" 보정값 (급소율에는 영향 없음)
        // 방어 랭크업/다운: 방어력x3 항에만 곱해짐. 모래바람 중 바위 타입 방어자는 방어 랭크 +2 보정을 추가로 받음
        const atkMult = rankMultiplier(getEffectiveRank(myRanks, "atk", currentTurn));
        const sandDefBonus = sandstormDefenseBonus(defender, currentWeather?.type);
        const defMult = rankMultiplier(clampRank(getEffectiveRank(oppRanks, "def", currentTurn) + sandDefBonus));

        const typeMult = getDefenderTypeMultiplier(moveData.type, pokemonTypes(defender));
        const stab = hasStab(pokemonTypes(attacker), moveData.type) ? 1.3 : 1;
        const weatherMult = weatherPowerMultiplier(currentWeather?.type, moveData.type);

        let updatedDefender = { ...defender };

        // 위력이 0인 기술(상태이상/랭크 변화 전용)은 데미지를 주지 않음
        if (moveData.power > 0) {
          // 최종 피해량 = ((위력 + 공격력x4 + 1d10) x 공격랭크보정 x 타입상성 x 자속) - (방어력x3 x 방어랭크보정)
          // 눈사태: 이번 라운드에 상대의 공격 기술(위력>0)에 맞았으면 위력 70
          let power = moveData.power;
          if (moveData.avalanche && attacker.lastHitRound === currentTurn) power = 70;
          // 연속자르기: 연속으로 맞힐 때마다 +10 (30 -> 40 -> 50, 최대 50)
          if (moveData.furyCutter) {
            power = Math.min(FURY_CUTTER_MAX_POWER, moveData.power + 10 * (attacker.furyCutter ?? 0));
            furyCutterHit = true;
          }
          const rawDamage =
            (power + attacker.atk * 4 + rollD10()) * atkMult * typeMult * stab * weatherMult -
            defender.def * 3 * defMult;
          const isCrit = rollCrit(attacker);
          const screenMult = defender.screen ? SCREEN_DAMAGE_MULT : 1; // 빛의장막/리플렉터
          const dmg = Math.max(0, Math.round(rawDamage * (isCrit ? 1.5 : 1) * screenMult));
          const newHp = Math.max(0, defender.hp - dmg);

          // lastHitRound: 이번 라운드에 상대의 공격 기술에 맞았다는 표시 (눈사태 위력 판정용)
          updatedDefender = { ...updatedDefender, hp: newHp, lastHitRound: currentTurn };
          events.push({ logIndex: moveLogIndex, type: "hit", side: oppKey, hp: newHp, status: defender.status ?? null, hasAttacker: true });

          if (isCrit && dmg > 0) log.push("급소에 맞았다!");

          if (typeMult === 0) log.push(`${defenderName}에게는 효과가 없는 듯하다...`);
          else if (typeMult > 1) log.push("효과가 굉장했다!");
          else if (typeMult < 1) log.push("효과가 별로인 듯하다...");

          // 흡수기(effect.drain): 가한 데미지의 drain 비율만큼 회복 (최대 체력까지)
          if (moveData.effect?.drain && dmg > 0) {
            const maxHp = currentAttacker.maxHp ?? currentAttacker.hp;
            const heal = Math.min(maxHp - currentAttacker.hp, Math.max(1, Math.round(dmg * moveData.effect.drain)));
            if (heal > 0) {
              currentAttacker = { ...currentAttacker, hp: currentAttacker.hp + heal };
              entries[myKey][activeIdx[myKey]] = currentAttacker;
              log.push(`${defenderName}의 체력을 흡수했다!`);
              events.push({ logIndex: log.length - 1, type: "heal", side: myKey, hp: currentAttacker.hp });
            }
          }
        }

        // 장판(스텔스록/독압정) 설치. 설치 당시엔 데미지/효과 없이 상대 진영에 표시만 해둠.
        if (moveData.field) {
          const hazardResult = setHazard(oppField, moveData.field);
          oppField = hazardResult.field;
          update[`${oppKey}_field`] = oppField;
          if (hazardResult.message) log.push(hazardResult.message);
        }

        // 날씨 설치. 설치 당시엔 지속/데미지 로그 없이 시작 로그만 남김 (라운드 종료 처리는 buildTurnAdvanceUpdate에서)
        if (moveData.effect?.weather) {
          const weatherResult = setWeather(moveData.effect.weather, moveData.effect.weatherTurns ?? 5, currentTurn);
          currentWeather = weatherResult.weather;
          update.weather = currentWeather;
          if (weatherResult.message) log.push(weatherResult.message);
        }

        // 상태이상 / 상태변화 부여 시도
        if (moveData.effect && Math.random() < moveData.effect.chance) {
          if (moveData.effect.status) {
            if (moveData.effect.status === "얼음" && preventsFreeze(currentWeather?.type)) {
              // 쾌청 상태에서는 얼음 상태이상에 걸리지 않음
            } else {
              const statusResult = applyStatus(updatedDefender, moveData.effect.status, currentTurn);
              updatedDefender = statusResult.pokemon;
              if (statusResult.message) log.push(statusResult.message);
              // 상태이상이 걸린 그 로그 줄에서 바로 이름 옆 [상태] 표시를 갱신하도록 연출 이벤트를 남김
              if (statusResult.applied) {
                events.push({ logIndex: log.length - 1, type: "status", side: oppKey, status: updatedDefender.status });
              }
            }
          } else if (moveData.effect.volatile) {
            const volName = moveData.effect.volatile;
            const dn = updatedDefender.name ?? "포켓몬";
            if (updatedDefender.volatiles?.[volName]) {
              log.push(`${dn}${josa(dn, "은는")} 이미 ${volName} 상태다!`);
            } else {
              updatedDefender = applyVolatile(updatedDefender, volName);
              log.push(`${dn}${josa(dn, "은는")} ${volName} 상태가 되었다!`);
            }
          }
        }

        entries[oppKey][activeIdx[oppKey]] = updatedDefender;

        // 랭크 변화. moves.js의 rank: { atk?, def?, spd?, targetAtk?, targetDef?, targetSpd?, turns, chance? }
        // 갱신 시점부터 turns만큼 다시 지속 시작.
        if (moveData.rank && Math.random() < (moveData.rank.chance ?? 1)) {
          const { turns } = moveData.rank;
          for (const [field, { self, stat }] of Object.entries(RANK_FIELD_MAP)) {
            const value = moveData.rank[field];
            if (!value) continue;

            const targetKey = self ? myKey : oppKey;
            const targetRanks = targetKey === myKey ? myRanks : oppRanks;
            const oldValue = getEffectiveRank(targetRanks, stat, currentTurn);
            const newValue = clampRank(oldValue + value);
            const newRanks = { ...targetRanks, [stat]: { value: newValue, expireTurn: currentTurn + turns } };
            if (targetKey === myKey) myRanks = newRanks; else oppRanks = newRanks;
            update[`${targetKey}_ranks`] = newRanks;

            const tn = entries[targetKey][activeIdx[targetKey]]?.name ?? "포켓몬";
            const statLabel = stat === "evasion" ? "속도" : stat === "atk" ? "공격" : "방어";
            log.push(buildRankChangeMessage(tn, statLabel, oldValue, newValue, value > 0));
          }
        }

        // 전멸/교체 체크 (직접 데미지로 쓰러진 경우)
        const faint = handleFaintSwitch(entries, oppKey, activeIdx);
        if (faint.fainted) {
          if (faint.allFainted) {
            update.battle_winner = myKey;
            log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
            log.push(`${displayName(myKey, room)} 승리!`);
            update[`${myKey}_entry`] = entries[myKey];
            update[`${oppKey}_entry`] = entries[oppKey];
            update.battle_log = log;
            update.battle_event_log = events;
            return ok(update);
          }
          update[`${oppKey}_pending_switch`] = true;
          log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
          directPendingSide = oppKey;
        }
      }
    }
  }

  // 연속자르기 누적: 맞히면 +1(상한까지), 빗나가거나 막히거나 다른 기술을 쓰면 0으로 초기화
  // + 방어류 연속 사용 기록
  {
    const cur = entries[myKey][activeIdx[myKey]];
    const nextFury = moveData.furyCutter && furyCutterHit ? Math.min((cur.furyCutter ?? 0) + 1, FURY_CUTTER_MAX_STACK) : 0;
    // 방어류 연속 사용 판정: 이번 행동이 방어류 성공일 때만 true (실패/다른 행동이면 초기화)
    if ((cur.furyCutter ?? 0) !== nextFury || !!cur.guardStreak !== guardSucceeded) {
      entries[myKey][activeIdx[myKey]] = { ...cur, furyCutter: nextFury, guardStreak: guardSucceeded };
    }
  }

  // 거대해머류: 실제로 기술을 썼으면(빗나가거나 막혀도) 다음 라운드엔 사용 불가
  if (moveData.heavyHammer && !blocked) {
    const cur = entries[myKey][activeIdx[myKey]];
    entries[myKey][activeIdx[myKey]] = { ...cur, moveLock: { name: moveSlot.name, turn: currentTurn + 1 } };
  }

  const pendingSides = new Set(directPendingSide ? [directPendingSide] : []);

  // 유턴: 기술을 쓴 뒤(빗나가거나 막혀도) 곧바로 교체. 행동이 저지됐거나 내가 쓰러졌으면 교체 없음.
  if (moveData.uTurn && !blocked && myBenchAlive && Number.isInteger(uTurnIdx) && entries[myKey][activeIdx[myKey]].hp > 0) {
    const hazardFaint = switchIn(room, myKey, entries, activeIdx, uTurnIdx, log, events, update, true);
    if (hazardFaint.fainted) {
      log.push(`${hazardFaint.name}${josa(hazardFaint.name, "은는")} 쓰러졌다!`);
      if (hazardFaint.allFainted) {
        update.battle_winner = oppKey;
        log.push(`${displayName(oppKey, room)} 승리!`);
        update[`${myKey}_entry`] = entries[myKey];
        update[`${oppKey}_entry`] = entries[oppKey];
        update.battle_log = log;
        update.battle_event_log = events;
        return ok(update);
      }
      update[`${myKey}_pending_switch`] = true;
      pendingSides.add(myKey);
    }
  }

  const advance = buildTurnAdvanceUpdate(
    room, entries, activeIdx, currentTurn, log, events,
    pendingSides.size > 0 ? pendingSides : undefined,
    currentWeather
  );
  Object.assign(update, advance);
  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];

  update.battle_log = log;
  update.battle_event_log = events;
  return ok(update);
}

// 교체로 들어가는 포켓몬에게서 해제되는 상태 (방어류/빛의장막·리플렉터/연속자르기 누적/방어류 연속 사용 기록)
function clearOnSwitchOut(pokemon) {
  return { ...pokemon, guard: null, guardStreak: false, screen: null, furyCutter: 0 };
}

// 교체 공통 처리(자발적 교체/강제 교체/유턴): 나가는 포켓몬 상태 정리 -> 내보내기 로그/연출 -> 장판 적용.
// entries/activeIdx/log/events/update를 직접 갱신하고, 들어온 포켓몬이 장판으로 쓰러졌는지를 반환.
function switchIn(room, myKey, entries, activeIdx, targetIdx, log, events, update, recall) {
  const myArr = entries[myKey];
  const prevIdx = activeIdx[myKey];
  const prevPkmn = myArr[prevIdx];
  if (prevPkmn) myArr[prevIdx] = clearOnSwitchOut(prevPkmn);
  activeIdx[myKey] = targetIdx;

  update[`${myKey}_active_idx`] = targetIdx;
  update[`${myKey}_ranks`] = defaultRanks(); // 교체하면 랭크 초기화

  const target = myArr[targetIdx];
  const pName = displayName(myKey, room);
  const dn = target.name ?? "포켓몬";
  if (recall) log.push(`돌아와, ${prevPkmn?.name ?? "포켓몬"}!`);
  log.push(`${pName}${josa(pName, "은는")} ${dn}${josa(dn, "을를")} 내보냈다!`);
  events.push({ logIndex: log.length - 1, type: "switch", side: myKey, idx: targetIdx });

  // 장판(스텔스록/독압정) 효과 적용
  const myField = room[`${myKey}_field`] ?? defaultField();
  const hazard = applyHazardsOnSwitchIn(target, myField, room.round_no ?? 1);
  myArr[targetIdx] = hazard.pokemon;
  hazard.messages.forEach((msg) => {
    log.push(msg);
    events.push({ logIndex: log.length - 1, type: "hit", side: myKey, hp: hazard.pokemon.hp, status: hazard.pokemon.status ?? null, hasAttacker: false });
  });

  return handleFaintSwitch(entries, myKey, activeIdx);
}

// 벤치 포켓몬 교체.
// - pending switch 상태(쓰러져서 강제로 교체해야 하는 상태)면: 턴 소모 없이 바로 다음 포켓몬으로.
//   상대도 더 이상 교체 대기가 아니면 그 시점에 다음 라운드 다이스를 굴림.
// - 평상시(자발적 교체)면: 기술 사용과 동등하게 내 턴(액션) 하나를 소모함.
export function switchPokemon(room, myKey, targetIdx) {
  if (room.battle_winner) return fail("이미 끝난 배틀");

  const pendingSwitch = !!room[`${myKey}_pending_switch`];

  // 자발적 교체: 내 턴일 때만 가능
  if (!pendingSwitch && room.battle_turn !== myKey) return fail("내 턴이 아님");

  const oppKey = myKey === "p1" ? "p2" : "p1";
  const entries = { p1: [...(room.p1_entry ?? [])], p2: [...(room.p2_entry ?? [])] };
  const activeIdx = { p1: room.p1_active_idx ?? 0, p2: room.p2_active_idx ?? 0 };
  const myArr = entries[myKey];
  const target = myArr[targetIdx];

  if (!target || target.hp <= 0) return fail("쓰러진 포켓몬"); // 쓰러진 포켓몬으론 못 나감
  if (!pendingSwitch && targetIdx === activeIdx[myKey]) return fail("이미 출전 중"); // 이미 나가 있는 포켓몬
  if (!pendingSwitch && myArr[activeIdx[myKey]]?.ghostDive) return fail("고스트다이브 중에는 교체 불가");

  const update = {};
  const log = [...(room.battle_log ?? [])];
  const events = [...(room.battle_event_log ?? [])];

  // 자발적 교체는 내 턴(액션)을 소모함 ("돌아와" 로그). 강제 교체는 턴 소모 없음.
  if (pendingSwitch) update[`${myKey}_pending_switch`] = false;
  const hazardFaint = switchIn(room, myKey, entries, activeIdx, targetIdx, log, events, update, !pendingSwitch);
  if (hazardFaint.fainted) {
    log.push(`${hazardFaint.name}${josa(hazardFaint.name, "은는")} 쓰러졌다!`);
    if (hazardFaint.allFainted) {
      update.battle_winner = oppKey;
      update[`${myKey}_pending_switch`] = false;
      log.push(`${displayName(oppKey, room)} 승리!`);
    } else {
      update[`${myKey}_pending_switch`] = true;
    }
    update[`${myKey}_entry`] = entries[myKey];
    update[`${oppKey}_entry`] = entries[oppKey];
    update.battle_log = log;
    update.battle_event_log = events;
    return ok(update);
  }

  if (pendingSwitch) {
    // 양쪽 다 교체 끝났으면 다음 라운드 다이스
    if (!room[`${oppKey}_pending_switch`]) {
      Object.assign(update, buildNextRound(entries, activeIdx, room.round_no ?? 1, log));
    }
  } else {
    Object.assign(update, buildTurnAdvanceUpdate(room, entries, activeIdx, room.round_no ?? 1, log, events));
  }

  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];
  update.battle_log = log;
  update.battle_event_log = events;
  return ok(update);
}

// 전투 종료 후 LEAVE: 내 슬롯을 비우고(관전자가 있으면 그 자리로 승격) 다음 게임을 위해 전투 필드를 초기화.
export function leaveBattle(room, uid) {
  if (!room.battle_winner) return fail("전투가 끝나지 않음"); // 전투가 끝났을 때만 나갈 수 있음

  const update = { ...BATTLE_RESET_FIELDS };
  const spectators = room.spectators ?? [];
  const spectatorNames = room.spectator_names ?? [];
  const side = sideOfUid(room, uid);

  if (side === "p1" || side === "p2") {
    const slot = side === "p1" ? "player1" : "player2";
    if (spectators.length > 0) {
      const randIdx = Math.floor(Math.random() * spectators.length);
      update[`${slot}_uid`] = spectators[randIdx];
      update[`${slot}_name`] = spectatorNames[randIdx];
      update.spectators = spectators.filter((_, i) => i !== randIdx);
      update.spectator_names = spectatorNames.filter((_, i) => i !== randIdx);
    } else {
      update[`${slot}_uid`] = null;
      update[`${slot}_name`] = null;
    }
  } else if (side === "spectator") {
    const idx = spectators.indexOf(uid);
    update.spectators = spectators.filter((_, i) => i !== idx);
    update.spectator_names = spectatorNames.filter((_, i) => i !== idx);
  }

  return ok(update);
}
