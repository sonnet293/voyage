// js/field.js
// 장판(필드) 기술 - 스텔스록 / 독압정.
// 상대방 진영에 설치되며, "설치 당시"에는 아무 효과가 없다.
// "상대방이 포켓몬을 교체해서 내보낼 때" 그 포켓몬에게 효과가 발동한다.
//
// 필드 상태는 room 문서에 사이드별로 저장한다 (예: p1_field, p2_field):
//   { stealth_rock: boolean, toxic_spikes: boolean }

import { getTypeMultiplier, pokemonTypes } from "./typeChart.js";
import { applyStatus, josa } from "./effecthandler.js";

export const FIELD_LIST = ["stealth_rock", "toxic_spikes"];

export function defaultField() {
  return { stealth_rock: false, toxic_spikes: false };
}

function hasType(pokemon, typeName) {
  return pokemonTypes(pokemon).includes(typeName);
}

// 방어 포켓몬의 다중 타입에 대해 바위 타입 배율을 모두 곱함
function getRockMultiplier(defenderTypes) {
  if (!Array.isArray(defenderTypes) || defenderTypes.length === 0) return 1;
  return defenderTypes.reduce((mult, t) => mult * getTypeMultiplier("바위", t), 1);
}

// 바위 상성 배율 -> 최대 HP 대비 데미지 비율
function stealthRockDamageRatio(mult) {
  if (mult <= 0) return 0; // 무효 타입 (없긴 하지만 안전장치)
  if (mult <= 0.6) return 1 / 32; // 0.8*0.8
  if (mult <= 0.9) return 1 / 16; // 0.8
  if (mult <= 1.1) return 1 / 8; // 1배 (0.96 포함)
  if (mult <= 1.3) return 1 / 4; // 1.2
  return 1 / 2; // 1.2*1.2
}

// 장판 설치 시도. 이미 설치되어 있으면 실패.
// 반환: { field: 갱신된(또는 그대로인) 필드 상태, applied: boolean, message }
export function setHazard(field, hazardName) {
  const current = field ?? defaultField();
  if (!FIELD_LIST.includes(hazardName)) return { field: current, applied: false, message: null };

  if (current[hazardName]) {
    return { field: current, applied: false, message: "그러나 실패했다!" };
  }

  const message = hazardName === "stealth_rock"
    ? "상대방 주위에 뾰족한 바위가 떠올랐다!"
    : "상대방 발밑에 독가시가 깔렸다!";

  return { field: { ...current, [hazardName]: true }, applied: true, message };
}

// 포켓몬이 교체되어 나올 때(강제/자발 모두), 나가는 쪽 진영에 깔린 장판 효과를 적용.
// 스텔스록 데미지 -> 독압정 중독 순서로 처리.
// 반환: { pokemon: 갱신된 포켓몬, messages: string[] }
export function applyHazardsOnSwitchIn(pokemon, field, currentTurn) {
  const messages = [];
  if (!pokemon || pokemon.hp <= 0 || !field) return { pokemon, messages };

  let updated = pokemon;

  if (field.stealth_rock) {
    const mult = getRockMultiplier(pokemonTypes(updated));
    const ratio = stealthRockDamageRatio(mult);
    if (ratio > 0) {
      const dmg = Math.max(1, Math.floor(updated.maxHp * ratio));
      const newHp = Math.max(0, updated.hp - dmg);
      updated = { ...updated, hp: newHp };
      const name = updated.name ?? "포켓몬";
      messages.push(`${name}${josa(name, "은는")} 스텔스록으로 데미지를 입었다!`);
    }
  }

  if (field.toxic_spikes && updated.hp > 0) {
    if (!hasType(updated, "독") && !hasType(updated, "강철")) {
      const statusResult = applyStatus(updated, "독", currentTurn);
      if (statusResult.applied) {
        updated = statusResult.pokemon;
        messages.push(statusResult.message);
      }
    }
  }

  return { pokemon: updated, messages };
}
