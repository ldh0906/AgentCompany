import { createContext, useContext } from 'react';

export type Lang = 'ko' | 'en';

const dict = {
  ko: {
    appName: 'Agent Company',
    nav_dashboard: '대시보드',
    nav_board: '업무판',
    nav_org: '조직',
    nav_projects: '프로젝트',
    nav_system: '시스템',
    newTicket: '새 업무',
    approvals: '대표 승인함',
    noApprovals: '승인할 항목이 없습니다.',
    held: '보류 중인 업무',
    noHeld: '보류 중인 업무가 없습니다.',
    activity: '최근 활동',
    inProgress: '진행 중',
    waitingApproval: '승인 대기',
    onHold: '보류',
    done: '완료',
    approve: '승인',
    reject: '반려',
    approveMerge: '승인하고 내 폴더에 반영',
    approveBranch: '승인만 (따로 보관)',
    release: '보류 해제',
    cancel: '취소',
    assignee: '담당',
    reviewer: '검수',
    round: '회차',
    requirements: '요구사항',
    evidence: '증거',
    timeline: '타임라인',
    runs: '실행 기록',
    diff: '변경 내용',
    hire: '직원 추가',
    activeLimit: '활성 직원은 최대 8명입니다.',
    name: '이름',
    roles: '담당 업무',
    cli: 'CLI',
    model: '모델',
    access: '접근 등급',
    active: '활성',
    inactive: '비활성',
    save: '저장',
    create: '만들기',
    close: '닫기',
    empty: '없음',
    loading: '불러오는 중…',
    authMissing:
      '이 창에는 로그인 정보가 없습니다(보안을 위해 주소만으로는 열리지 않습니다). 바탕화면이나 시작 메뉴의 Agent Company 아이콘으로 다시 여세요. 이미 켜져 있으면 그 창이 열립니다.',
  },
  en: {
    appName: 'Agent Company',
    nav_dashboard: 'Dashboard',
    nav_board: 'Board',
    nav_org: 'Team',
    nav_projects: 'Projects',
    nav_system: 'System',
    newTicket: 'New ticket',
    approvals: 'CEO approvals',
    noApprovals: 'Nothing to approve.',
    held: 'On hold',
    noHeld: 'No tickets on hold.',
    activity: 'Activity',
    inProgress: 'In progress',
    waitingApproval: 'Awaiting approval',
    onHold: 'On hold',
    done: 'Done',
    approve: 'Approve',
    reject: 'Reject',
    approveMerge: 'Approve + merge',
    approveBranch: 'Approve (branch only)',
    release: 'Release hold',
    cancel: 'Cancel',
    assignee: 'Assignee',
    reviewer: 'Reviewer',
    round: 'Round',
    requirements: 'Requirements',
    evidence: 'Evidence',
    timeline: 'Timeline',
    runs: 'Runs',
    diff: 'Diff',
    hire: 'Add employee',
    activeLimit: 'Up to 8 active employees.',
    name: 'Name',
    roles: 'Duties',
    cli: 'CLI',
    model: 'Model',
    access: 'Access level',
    active: 'Active',
    inactive: 'Inactive',
    save: 'Save',
    create: 'Create',
    close: 'Close',
    empty: 'None',
    loading: 'Loading…',
    authMissing:
      'This window has no session token (the address alone is not enough, for security). Reopen Agent Company from its desktop or Start menu icon.',
  },
} as const;

export type Key = keyof (typeof dict)['ko'];

export const STATUS: Record<Lang, Record<string, string>> = {
  ko: {
    received: '접수',
    analyzing: '분석',
    backlog: '대기 목록',
    assigned: '배정',
    in_progress: '작업 중',
    verifying: '제출 검증',
    in_review: '검수 중',
    changes_requested: '수정 요청',
    awaiting_approval: '대표 승인 대기',
    integrating: '반영',
    done: '완료',
    failed: '실패',
    cancelled: '취소',
  },
  en: {
    received: 'Received',
    analyzing: 'Analyzing',
    backlog: 'Backlog',
    assigned: 'Assigned',
    in_progress: 'Working',
    verifying: 'Verifying',
    in_review: 'In review',
    changes_requested: 'Changes requested',
    awaiting_approval: 'Awaiting CEO',
    integrating: 'Integrating',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },
};

export const HOLD: Record<Lang, Record<string, string>> = {
  ko: {
    needs_decision: '대표 결정 필요',
    waiting_dependency: '선행 업무 대기',
    usage_limit: '사용량 한도',
    needs_permission: '권한 승인 필요',
    on_hold: '보류',
  },
  en: {
    needs_decision: 'Needs CEO decision',
    waiting_dependency: 'Waiting on dependency',
    usage_limit: 'Usage limit',
    needs_permission: 'Needs permission',
    on_hold: 'On hold',
  },
};

export const ROLE: Record<Lang, Record<string, string>> = {
  ko: {
    'chief-of-staff': '비서실장',
    planner: '기획',
    architect: '기술 설계',
    implementer: '구현',
    ux: 'UI·UX',
    qa: 'QA·반박',
    recorder: '문서·기록',
  },
  en: {
    'chief-of-staff': 'Chief of staff',
    planner: 'Planner',
    architect: 'Architect',
    implementer: 'Implementer',
    ux: 'UI/UX',
    qa: 'QA',
    recorder: 'Recorder',
  },
};

export const RANK: Record<Lang, Record<string, string>> = {
  ko: { junior: '사원', senior: '선임', lead: '팀장' },
  en: { junior: 'Junior', senior: 'Senior', lead: 'Lead' },
};

export const DIFFICULTY: Record<Lang, Record<string, string>> = {
  ko: { easy: '쉬움', normal: '보통', hard: '어려움' },
  en: { easy: 'Easy', normal: 'Normal', hard: 'Hard' },
};

export const EFFORT: Record<Lang, Record<string, string>> = {
  ko: { minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' },
  en: { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max', ultra: 'Ultra' },
};

export const ACCESS: Record<Lang, Record<string, string>> = {
  ko: {
    'read-only': '1 · 읽기 전용',
    'write-ask': '2 · 쓰기, 명령은 매번 승인',
    'write-allowlist': '3 · 허용 목록 명령 자동',
    'full-auto': '4 · 전체 자동 (위험)',
  },
  en: {
    'read-only': '1 · Read only',
    'write-ask': '2 · Write, ask for commands',
    'write-allowlist': '3 · Allowlisted commands auto',
    'full-auto': '4 · Full auto (risky)',
  },
};

export const EVIDENCE: Record<Lang, Record<string, string>> = {
  ko: {
    mockup: '시안',
    inspection: '검수자 판단',
    static_check: '정적 검사',
    unit_test: '단위 테스트',
    runtime: '런타임',
    human_attest: '대표 직접 확인',
  },
  en: {
    mockup: 'Mockup',
    inspection: 'Reviewer inspection',
    static_check: 'Static check',
    unit_test: 'Unit test',
    runtime: 'Runtime',
    human_attest: 'CEO attested',
  },
};

/** 결과물 종류(프로젝트 프로필). 없으면 화면. */
export const DELIVERABLE: Record<Lang, Record<string, string>> = {
  ko: { screen: '화면 (웹·앱·게임)', document: '문서·조사', program: '화면 없는 프로그램 (API·CLI·파이썬)' },
  en: { screen: 'Screen (web, app, game)', document: 'Documents & research', program: 'Program without a screen (API, CLI)' },
};

/** 프로필의 성격을 한 줄로: "문서·조사" / "PC 전용 · 게임" 등. */
export function profileTraits(p: { deliverable?: string; mobile: boolean; game: boolean }, lang: Lang): string {
  const kind = p.deliverable ?? 'screen';
  if (kind !== 'screen') return DELIVERABLE[lang][kind] ?? kind;
  const ko = lang === 'ko';
  return `${p.mobile ? (ko ? '휴대폰 화면도 신경 씀' : 'Phones too') : ko ? 'PC 전용(휴대폰 신경 안 씀)' : 'Desktop only'}${p.game ? (ko ? ' · 게임' : ' · game') : ''}`;
}

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'ko', setLang: () => {} });

export function useT() {
  const { lang } = useContext(LangContext);
  return {
    lang,
    t: (k: Key) => dict[lang][k],
    status: (s: string) => STATUS[lang][s] ?? s,
    hold: (s: string) => HOLD[lang][s] ?? s,
    role: (s: string) => ROLE[lang][s] ?? s,
    access: (s: string) => ACCESS[lang][s] ?? s,
    evidence: (s: string) => EVIDENCE[lang][s] ?? (s === 'setup' ? (lang === 'ko' ? '준비(설치)' : 'Setup') : s),
    rank: (s: string | null | undefined) => RANK[lang][s ?? 'senior'] ?? s ?? '',
    difficulty: (s: string | null | undefined) => DIFFICULTY[lang][s ?? 'normal'] ?? s ?? '',
    effort: (s: string | null | undefined) => (s ? (EFFORT[lang][s] ?? s) : ''),
  };
}

/** 한국어 조사: 이름 끝 글자의 받침에 맞춰 을/를, 이/가, 은/는을 고른다. 한글이 아니면 "을(를)" 형태로 둔다. */
export function josa(word: string, pair: '을/를' | '이/가' | '은/는'): string {
  const [withBatchim, without] = pair.split('/') as [string, string];
  const code = word.trim().charCodeAt(word.trim().length - 1);
  if (code < 0xac00 || code > 0xd7a3) return `${word}${withBatchim}(${without})`;
  return word + ((code - 0xac00) % 28 ? withBatchim : without);
}
