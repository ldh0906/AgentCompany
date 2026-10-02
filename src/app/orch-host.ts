// 오케스트레이터에서 떼어 낸 기능(화면 점검·고급 QA·대표 알림)이 쓰는 오케스트레이터 쪽 기능. 필요한 것만 넘긴다.
import type { Employee, TicketBudget } from '../core/types.ts';
import type { Chat } from './chat.ts';
import type { Company } from './company.ts';
import type { PreviewInfo } from './preview.ts';
import type { Records } from './records.ts';

/** 대화방에서 도는 실행(화면 QA 의견·고급 QA 플레이) */
export interface ChatLaunch {
  ticket: { id: string; round: number; budget: TicketBudget };
  employee: Employee;
  kind: 'chat';
  cwd: string;
  prompt: string;
  nonce: string;
  accessLevel: Employee['accessLevel'];
  baseSha: null;
}

export interface OrchHost {
  readonly company: Company;
  readonly records: Records;
  readonly chat: Chat;
  readonly dataDir: string;
  readonly language: string;
  paused(): boolean;
  changed(kind: string, id: string): void;
  preview(projectId: string, ticketId: string | null): Promise<PreviewInfo>;
  launchChat(p: ChatLaunch): Promise<string>;
  track(key: string, p: Promise<void>): void;
  notice(title: string, body: string, link?: string): void;
  /** 지금 돌고 있는 이 직원의 실행 수(일을 고르게 나누는 데 쓴다) */
  loadOf(employeeId: string): number;
}
