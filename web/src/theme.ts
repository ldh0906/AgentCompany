// 화이트(기본)·다크 테마. 대표 요청(2026-10-03): 원하는 색으로 바꾸게, 기본은 화이트.
// 고른 값은 이 브라우저에만 저장한다(앱 창마다 따로).
export type Theme = 'light' | 'dark';

export function savedTheme(): Theme {
  try {
    return localStorage.getItem('ac-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#07080d' : '#f5f6fa');
}

export function saveTheme(t: Theme): void {
  applyTheme(t);
  try {
    localStorage.setItem('ac-theme', t);
  } catch {
    // 저장이 막혀 있으면 이번 창에서만 바뀐다
  }
}
