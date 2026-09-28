// 도메인 계약. 상태 전이·권한·증거 판정은 모두 이 타입을 기준으로 한다.
// LLM 출력은 이 타입으로 검증된 "제안"으로만 시스템에 들어온다.

export type CliKind = 'claude' | 'codex' | 'agy' | 'fake';

/** 공통 접근 등급. CLI별 매핑은 adapters/ 에서 한다. */
export type AccessLevel =
  | 'read-only'          // 1: 읽기만
  | 'write-ask'          // 2: 작업공간 쓰기 자동, 명령은 매번 대표 승인 (기본값)
  | 'write-allowlist'    // 3: 허용 목록 명령 자동, 나머지는 승인
  | 'full-auto';         // 4: 모든 요청 자동 허용 (위험, 대표 승인 필요)

export const MAX_ACTIVE_EMPLOYEES = 4;

export type RoleTemplate =
  | 'chief-of-staff'
  | 'planner'
  | 'architect'
  | 'implementer'
  | 'ux'
  | 'qa'
  | 'recorder';

export interface Employee {
  id: string;
  name: string;
  roles: RoleTemplate[];
  cli: CliKind;
  model: string | null;
  accessLevel: AccessLevel;
  allowedCommands: string[][];   // write-allowlist 등급에서 자동 허용할 argv 접두사
  active: boolean;
  createdAt: string;
}

export type IntegrationMode = 'manual' | 'auto_after_approval';

export interface VerifyCommand {
  label: string;
  argv: string[];
  evidenceType: EvidenceType;   // 이 명령이 통과하면 만들어지는 증거 등급
  timeoutMs?: number;
}

export interface Project {
  id: string;
  name: string;
  originPath: string;          // 대표의 원본 저장소
  baseBranch: string;
  integrationMode: IntegrationMode;
  protectedPaths: string[];    // glob. 어떤 직원도 대표 승인 없이 수정 불가
  verifyCommands: VerifyCommand[];  // 대표가 승인한 검증 명령 (argv 배열, shell 없음)
  docRules: string;            // 직원 컨텍스트에 주입할 프로젝트별 문서 권한 규칙
  createdAt: string;
}

// ---- 티켓 상태기계 ----

export type TicketStatus =
  | 'received'           // 접수
  | 'analyzing'          // 분석
  | 'backlog'            // 대기 목록
  | 'assigned'           // 배정
  | 'in_progress'        // 작업 중
  | 'verifying'          // 제출 검증 (오케스트레이터 자동)
  | 'in_review'          // 검수 중 (round >= 2 이면 재검수)
  | 'changes_requested'  // 수정 요청
  | 'awaiting_approval'  // 대표 승인 대기
  | 'integrating'        // 반영
  | 'done'               // 완료
  | 'failed'             // 실패
  | 'cancelled';         // 취소

export const TERMINAL_STATUSES: readonly TicketStatus[] = ['done', 'failed', 'cancelled'];

/** 보류는 상태가 아니라 직교 플래그다. 해제되면 resumeTo 로 복귀한다. */
export type HoldReason =
  | 'needs_decision'     // 사용자 결정 필요
  | 'waiting_dependency' // 선행 업무 대기
  | 'usage_limit'        // 사용량 한도 대기
  | 'needs_permission'   // 권한 승인 필요
  | 'on_hold';           // 보류 (대표 수동)

export interface Hold {
  reason: HoldReason;
  resumeTo: TicketStatus;
  since: string;
  note: string;
}

export type EvidenceType =
  | 'mockup'        // 시안 (가장 약함)
  | 'inspection'    // 검수자가 diff를 읽고 판단
  | 'static_check'
  | 'unit_test'
  | 'runtime'
  | 'human_attest'; // 대표 직접 확인 (가장 강함)

export const EVIDENCE_STRENGTH: Record<EvidenceType, number> = {
  mockup: 0,
  inspection: 0,
  static_check: 1,
  unit_test: 2,
  runtime: 3,
  human_attest: 4,
};

export interface Requirement {
  id: string;
  text: string;
  evidenceType: EvidenceType;  // 이 요구를 충족하는 데 필요한 최소 증거 등급
}

export interface TicketBudget {
  maxRuns: number;
  maxRounds: number;
  runTimeoutMs: number;
}

export const DEFAULT_BUDGET: TicketBudget = { maxRuns: 6, maxRounds: 3, runTimeoutMs: 30 * 60_000 };

export type TicketType = 'impl' | 'doc' | 'review' | 'research';

export interface Ticket {
  id: string;
  projectId: string;
  type: TicketType;
  title: string;
  purpose: string;
  requesterId: string;         // 'ceo' 또는 직원 ID
  assigneeId: string | null;
  reviewerId: string | null;
  priority: 1 | 2 | 3;
  status: TicketStatus;
  hold: Hold | null;
  writeScope: string[];        // glob
  readScope: string[];
  requirements: Requirement[];
  doneCriteria: string;
  round: number;               // 검수 회차 (1부터)
  runCount: number;
  budget: TicketBudget;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

// ---- 실행 ----

export type RunKind = 'work' | 'review' | 'analysis' | 'synthesis';

export type RunStatus = 'prepared' | 'running' | 'exited' | 'succeeded' | 'failed' | 'orphaned';

export type FailureClass =
  | 'spawn_failed'
  | 'timeout'
  | 'auth_required'
  | 'usage_limit'
  | 'crash'
  | 'schema_invalid'
  | 'nonce_mismatch'
  | 'policy_violation'
  | 'unknown';

export interface Run {
  id: string;
  ticketId: string;
  employeeId: string;
  kind: RunKind;
  nonce: string;
  status: RunStatus;
  pid: number | null;
  cliSessionId: string | null;
  runDir: string;
  exitCode: number | null;
  failureClass: FailureClass | null;
  startedAt: string;
  endedAt: string | null;
}

// ---- 승인 ----

export type ApprovalKind =
  | 'tool_permission'    // 실행 중 권한 요청 (GUI 승인)
  | 'integrate'          // 반영 (manual: 브랜치만 / auto: 병합까지)
  | 'scope_violation'    // 범위 밖 수정 발견
  | 'access_escalation'  // full-auto 등급 등 권한 확대
  | 'cleanup';           // 작업공간·브랜치 정리

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

export interface Evidence {
  id: string;
  ticketId: string;
  round: number;
  headSha: string;
  type: EvidenceType;
  label: string;
  argv: string[] | null;
  exitCode: number | null;
  passed: boolean;
  outputPath: string | null;
  summary: string;
  /** 특정 요구사항에만 해당하는 증거(대표 직접 확인 등). 없으면 티켓 전체. */
  requirementId?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  kind: ApprovalKind;
  ticketId: string | null;
  subjectHash: string;         // 승인이 묶이는 대상의 해시. 대상이 바뀌면 무효
  summary: string;
  detail: unknown;
  state: ApprovalState;
  requestedBy: string;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// ---- 주장 원장 ----

export type ClaimVerdict = 'agree' | 'partial' | 'disagree' | 'insufficient';
export type ClaimResponse = 'keep' | 'narrow' | 'revise' | 'withdraw' | 'user_decision';
export type ClaimStatus = 'proposed' | 'under_review' | 'reviewed' | 'responded' | 'resolved' | 'escalated';

export type ClaimImpact = 'high' | 'medium' | 'low';

export interface Claim {
  id: string;
  ticketId: string;
  authorId: string;
  text: string;
  impact: ClaimImpact;
  confidence: number;          // 0~1, 작성자 자기 평가
  sources: { doc: string; loc: string }[];
  reviewerId: string | null;
  verdict: ClaimVerdict | null;
  verdictReason: string | null;
  response: ClaimResponse | null;
  responseText: string | null;
  status: ClaimStatus;
}

// ---- 결정 기록 ----

export type DecisionStatus = 'current' | 'past' | 'superseded' | 'withdrawn' | 'needs_verification' | 'draft';

export interface Decision {
  id: string;
  projectId: string;
  text: string;
  status: DecisionStatus;
  sourceRefs: string[];
  supersedes: string | null;
  reflectedIn: { path: string; commitSha: string }[];
  createdAt: string;
}

// ---- 이벤트 로그 ----

export interface DomainEvent {
  seq: number;
  ts: string;
  actor: string;               // 'ceo' | 'orchestrator' | 직원 ID
  type: string;
  entityId: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}
