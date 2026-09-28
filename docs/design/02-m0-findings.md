# M0 실측 결과

- 측정일: 2026-09-28
- 환경: Windows 11, Node v25.1.0, git 2.51.1
- 하네스: `C:\AgentCompany-m0\harness`. 테스트 31/31 통과. 작업자 A·B는 Codex `gpt-6-astra`(medium)이고, Claude가 검수했습니다.

## 1. 기본 실측 (기본 프로필)

| 항목 | Claude Code 2.1.202 | Codex 0.153.4 | Antigravity agy 1.2.12 |
|---|---|---|---|
| 실행 파일 | `claude.exe` | `codex.exe` | `agy.exe` |
| headless + 구조화 출력 | ✅ `-p --output-format stream-json --verbose`, stdin 프롬프트 | ✅ `exec --json ... -`, stdin 프롬프트 | ❌ stdin 프롬프트 무시. `-p`/`--print`는 **값을 받는 옵션**이라 exit 2 |
| 세션 ID 추출 | ✅ `session_id` | ✅ `thread.started.thread_id` | 재측정 필요 |
| ID로 재개 | ✅ `--resume <id>` | ✅ `exec resume <id> ... -` | `--conversation <id>` (재측정 필요) |
| 한글 경로 (cwd) | ✅ | ✅ | 재측정 필요 |
| 긴 한글 출력 (U+FFFD 없음) | ✅ | ✅ | 재측정 필요 |
| 모델 목록 조회 | 미확인 | ✅ `codex debug models` (JSON 카탈로그) | ✅ `agy models` |

- **agy 프롬프트 전달:** `--print=<프롬프트>`로 인자에 넣거나, `--input-format stream-json --output-format stream-json`으로 stdin에 NDJSON을 넣습니다. stdin 메시지 형식은 아직 확인하지 못했습니다.
- 인자 방식은 Windows 명령줄 길이 한계(약 32K자)가 있습니다. 긴 컨텍스트 팩을 넘기려면 stream-json 방식이 필요합니다.

## 2. 권한 요청 가로채기 (코드 준비 완료, 실측 대기)

- **Codex:** 로컬 `codex app-server generate-ts`(0.153.4)로 생성한 스키마를 확인했습니다.
  - 메서드: `initialize`, `thread/start`, `turn/start`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `turn/completed`
  - 승인 정책(`AskForApproval`): `untrusted | on-request | granular | never`
    - **접근 등급 2(명령 매번 승인)는 `untrusted`로 매핑합니다.** `on-request`로는 작업 폴더 안의 쓰기와 명령에 승인 요청이 오지 않을 수 있습니다.
  - 결정 값: `accept | acceptForSession | decline | cancel` 등
    - `acceptForSession`은 "이 티켓 동안 허용"에 대응합니다.
  - `thread/start`는 `developerInstructions`와 `baseInstructions`를 받습니다. 역할 지시를 주입할 통로로 쓸 수 있습니다.
- **Claude:** `--permission-prompt-tool`은 `--help`에 나오지 않습니다(숨겨진 옵션일 가능성). MCP 승인 서버는 구현을 마쳤고, 실측으로 지원 여부를 판정합니다.
  - `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `auth login|status`(`--json`)는 도움말에서 확인했습니다.
- **agy:** 가로채기 수단이 없습니다. 권한 관련 옵션은 `--sandbox`와 `--dangerously-skip-permissions`뿐입니다.

## 3. 개인 설정 누출 (관찰 1건, 정밀 실측 대기)

- **관찰:** 기본 프로필로 Codex 작업자를 실행하자, 대표 개인 설정의 **supabase MCP 서버가 작업자에게 로드됐습니다.** 인증이 없어 연결은 실패했습니다.
  - 앱 전용 프로필(A안)이 필요하다는 근거입니다.
- **Codex:** `exec --ignore-user-config`, `debug prompt-input`이 있습니다. 두 가지로 누출 여부를 비교할 예정입니다.
- **agy:** 설정 폴더를 바꾸는 옵션이나 환경변수를 도움말에서 찾지 못했습니다. `--project` 옵션만 있습니다.

## 4. Windows 실행 문제 (중요)

- **새 콘솔 창 문제와 데몬 종료 시 직원이 함께 죽는 문제 (제품 테스트로 발견·수정)**
  - `spawn(..., { detached: true })`로 띄운 프로세스는 콘솔이 없습니다(`DETACHED_PROCESS`). 그래서 그 프로세스가 부르는 git·셸마다 **새 콘솔 창**이 떠서, 사용자가 쓰던 화면(예: 게임) 위로 올라옵니다.
  - detached를 빼면 이번에는 다른 문제가 생깁니다. Node(libuv)는 Windows에서 detached가 아닌 자식을 **"부모가 죽으면 함께 종료되는" Job Object**에 넣습니다. 그래서 데몬이 죽으면 직원 CLI도 같이 죽습니다.
    - 처음 설계에서는 "Windows는 부모가 죽어도 자식을 종료하지 않는다"고 가정했습니다. 재시작 종단간 테스트에서 이 가정이 틀렸음을 확인했습니다.
  - **해결: 2단계 실행 셔틀** (`src/runner/shim.ts`)
    1. 데몬은 작은 셔틀만 detached로 띄웁니다. 셔틀은 데몬의 Job Object 밖에 있으므로 데몬이 죽어도 살아남습니다.
    2. 셔틀이 실제 CLI를 `windowsHide`로 띄웁니다. CLI는 창 없는 콘솔(`CREATE_NO_WINDOW`)을 받고, 그 하위 프로세스도 이 콘솔을 물려받아 창이 뜨지 않습니다.
    3. 셔틀은 CLI의 종료 코드를 `exit.json`으로 남깁니다. 데몬이 재시작해도 결과를 판정할 수 있습니다.
  - 검증: `test/e2e/restart.test.ts`
    - 데몬 프로세스를 강제 종료해도 직원 실행이 계속됩니다.
    - 새 데몬은 같은 실행에 재연결해 결과를 수거하고, 같은 작업을 다시 실행하지 않습니다.
    - 데몬이 꺼져 있는 동안 끝난 실행의 결과도 수거합니다.
  - 제품 요구사항: **직원 실행 중에 창이 하나도 뜨지 않아야 합니다.** 이 항목은 사람이 직접 확인합니다.
- **Codex 샌드박스 안의 작업자**
  - `taskkill`이 거부됩니다. 이 때문에 A의 테스트 2건이 실패했지만, 샌드박스 밖에서는 통과했습니다.
  - PATH에서 `codex`를 찾지 못합니다(B).
  - 결론: 직원 CLI의 샌드박스 환경은 부모 환경과 다르다는 점을 전제로 설계해야 합니다.

## 5. 남은 실측 (사용자 PC에서 창이 떠도 괜찮은 시간에 실행)

1. agy 기본 실측을 `--print=` 방식으로 다시 측정하고, stdin stream-json 메시지 형식을 확인합니다.
2. 권한 실측 A·B·C를 CLI 3종에 대해 실행합니다(agy B·C는 제외).
3. 앱 전용 프로필 로그인(대표가 직접) 후, 누출 비교를 두 프로필에서 실행합니다.
