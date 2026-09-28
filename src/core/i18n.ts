export type Lang = 'ko' | 'en';
let current: Lang = 'ko';
export function setLanguage(lang: Lang): void { current = lang; }
export function getLanguage(): Lang { return current; }
/** 사용자에게 보이는 문장. 한국어 원문을 그대로 두고 영어를 옆에 적는다. */
export function tr(ko: string, en: string): string { return current === 'en' ? en : ko; }
