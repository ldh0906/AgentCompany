// 재시작 복구 기록(타입만): 데몬·CLI·웹이 같이 쓴다.

export interface RecoveryReport {
  chainOk: boolean;
  chainDetail: string;
  reattached: string[];
  ingestedAfterRestart: string[];
  orphaned: string[];
  /** 복구한 시각 */
  at?: string;
  /** 실행마다: 무엇을 근거로 어떻게 처리했고 결과가 무엇인지(OpenRig 비교 2026-10-08: 복구 시도 기록) */
  runs?: RecoveredRun[];
  /** 반영하다 끊긴 요청: 처음 ref 값으로 이어서 반영한다(승인이 없어졌으면 버린다) */
  integrations?: { requestId: string; approvalId: string; action: 'resume' | 'dropped'; since: string }[];
  /** 처리하다 끊긴 회사 도구 요청 수(다음 주기에 실제로 일어난 일을 보고 이어간다) */
  toolCalls?: number;
}

export interface RecoveredRun {
  runId: string;
  ticketId: string;
  employeeId: string;
  kind: string;
  action: 'reattached' | 'collected' | 'not_started';
  /** 판단 근거(사람이 읽는 한 줄) */
  reason: string;
  /** 처리 뒤 실행 상태 */
  status: string;
}
