// js/weather.js
// 날씨 기술 - 쾌청 / 비바라기 / 모래바람 / 싸라기눈.
// 필드 전체(양쪽 모두)에 적용되는 전역 상태. room 문서에는 다음 형태로 저장한다:
//   weather: { type: "쾌청"|"비"|"모래바람"|"싸라기눈", appliedTurn, expireTurn } | null
//
// appliedTurn은 설치된 라운드 번호. 그 라운드의 라운드 종료 처리에서는 아직 틱하지 않고,
// 그 다음 라운드부터 지속 로그/데미지가 들어가며 currentTurn > expireTurn이 되면 종료된다.

import { josa } from "./effecthandler.js";

export const WEATHER_LIST = ["쾌청", "비", "모래바람", "싸라기눈"];

const START_MESSAGE = {
  "쾌청": "햇살이 강해졌다!",
  "비": "비가 내리기 시작했다!",
  "모래바람": "모래바람이 불기 시작했다!",
  "싸라기눈": "싸라기눈이 내리기 시작했다!",
};

const CONTINUE_MESSAGE = {
  "쾌청": "햇살이 강하다.",
  "비": "비가 계속 내리고 있다.",
  "모래바람": "모래바람이 계속 불고 있다.",
  "싸라기눈": "싸라기눈이 계속 내리고 있다.",
};

const END_MESSAGE = {
  "쾌청": "햇살이 약해졌다!",
  "비": "비가 그쳤다!",
  "모래바람": "모래바람이 가라앉았다!",
  "싸라기눈": "싸라기눈이 그쳤다!",
};

function hasType(pokemon, typeName) {
  return Array.isArray(pokemon?.types) && pokemon.types.includes(typeName);
}

// 날씨 기술 사용 시 필드 날씨를 새로 설치(기존 날씨가 있어도 덮어씀).
// 반환: { weather, message }
export function setWeather(weatherType, turns, currentTurn) {
  if (!WEATHER_LIST.includes(weatherType)) return { weather: null, message: null };
  return {
    weather: { type: weatherType, appliedTurn: currentTurn, expireTurn: currentTurn + turns },
    message: START_MESSAGE[weatherType],
  };
}

// 쾌청/비바라기가 불/물 기술 위력에 미치는 배율
export function weatherPowerMultiplier(weatherType, moveType) {
  if (weatherType === "쾌청") {
    if (moveType === "불") return 1.2;
    if (moveType === "물") return 0.8;
  } else if (weatherType === "비") {
    if (moveType === "물") return 1.2;
    if (moveType === "불") return 0.8;
  }
  return 1;
}

// 쾌청 상태에서는 얼음 상태이상에 걸리지 않음
export function preventsFreeze(weatherType) {
  return weatherType === "쾌청";
}

// 모래바람 중 바위 타입이 방어할 때 붙는 방어 랭크 보정치(+2)
export function sandstormDefenseBonus(pokemon, weatherType) {
  return weatherType === "모래바람" && hasType(pokemon, "바위") ? 2 : 0;
}

// 라운드 종료 처리. 설치된 바로 그 라운드에는 처리하지 않는다(appliedTurn === currentTurn).
// 반환: { active: 이번에 지속 처리가 됐는지, expired, weather: 갱신된(또는 종료 시 null인) 날씨, continueMessage, endMessage }
export function tickWeather(weather, currentTurn) {
  if (!weather) return { active: false, expired: false, weather: null, continueMessage: null, endMessage: null };
  if (weather.appliedTurn === currentTurn) {
    return { active: false, expired: false, weather, continueMessage: null, endMessage: null };
  }

  const expired = currentTurn >= weather.expireTurn;
  return {
    active: true,
    expired,
    weather: expired ? null : weather,
    continueMessage: CONTINUE_MESSAGE[weather.type],
    endMessage: expired ? END_MESSAGE[weather.type] : null,
  };
}

// 모래바람/싸라기눈의 라운드 종료 데미지. 면역 타입(모래바람: 바위/땅/강철, 싸라기눈: 얼음)이면 데미지 없음.
// 반환: { pokemon: 갱신된 포켓몬, damage, message }
export function applyWeatherDamage(pokemon, weatherType) {
  if (!pokemon || pokemon.hp <= 0) return { pokemon, damage: 0, message: null };

  let immune;
  if (weatherType === "모래바람") {
    immune = hasType(pokemon, "바위") || hasType(pokemon, "땅") || hasType(pokemon, "강철");
  } else if (weatherType === "싸라기눈") {
    immune = hasType(pokemon, "얼음");
  } else {
    return { pokemon, damage: 0, message: null };
  }
  if (immune) return { pokemon, damage: 0, message: null };

  const damage = Math.max(1, Math.floor(pokemon.maxHp / 16));
  const newHp = Math.max(0, pokemon.hp - damage);
  const name = pokemon.name ?? "포켓몬";
  const message = `${weatherType}${josa(weatherType, "이가")} ${name}${josa(name, "을를")} 덮쳤다!`;
  return { pokemon: { ...pokemon, hp: newHp }, damage, message };
}
