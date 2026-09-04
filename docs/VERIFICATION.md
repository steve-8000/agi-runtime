# 검증 기록

기준: 2026-09-05. 실제 출력은 `evidence/`에 있다. 기록의 홈 디렉터리 접두어는 `$HOME`으로 치환했다. 환경: macOS arm64, Node v26.7.0, tsc 5.9.3, Bun 1.3.14(시스템), OMP 18.1.10(Homebrew 바이너리, 자체 Bun 내장).

## 수행한 검사

| 검사 | 결과 | 범위 | 증거 |
|---|---|---|---|
| `node --experimental-strip-types --test tests/*.test.mjs` | 66 passed, 0 failed | 실제 SQLite(node:sqlite)·파일 시스템. OMP는 v18.1.10 이벤트 모양의 mock | `evidence/node-test.tap` |
| `node scripts/check.mjs` | JS 22개 syntax, `tsc -p .` 통과 | `types/pi-coding-agent.d.ts`에 대한 typecheck. 전체 OMP typecheck 아님 | `evidence/check.jsonl` |
| `node scripts/demo.mjs` | 통과 | offline fake memory port. 모델·원격 호출 없음 | `evidence/demo.json` |
| `omp -p … -e extension/index.ts` (임시 runtime dir, `OMP_RUNTIME_REQUIRED=1`) | 로드·attach·저널·release 확인. 첫 실행에서 중첩 `xd://` 결함 발견, 수정 후 재실행 네 행 `succeeded` | 실제 바이너리(Bun 런타임, `bun:sqlite`) | 본문 §라이브 |
| `node scripts/install.mjs` | symlink `~/.omp/agent/extensions/agi-runtime`, `~/.omp/runtime/{config.json,journals,compat}` 생성 | 실제 설치 | `evidence/doctor.json` |
| `scripts/compat.mjs --live` | `degraded:false`; offline `ok`, live `ok`, exit 0, `read`/`bash` 두 행 `succeeded`, compat report `ok`, counters 2/2/2/2 | auto-discovery 경로로 실제 `omp -p` 1회(모델 `gpt-5.6-luna`) | `evidence/compat-live.json` |
| `node scripts/doctor.mjs` | `ready:true`; tested-version `tested`, compat-report `ok` | 실제 설치 상태 | `evidence/doctor.json` |

## 라이브에서 확인한 것

- 확장이 컴파일된 OMP 바이너리 안에서 로드된다: `.ts` 진입점, `../src/*.mjs` 상대 import, `bun:sqlite`, `import type` 제거 모두 문제 없음.
- probe: API 멤버 9개, 컨텍스트 멤버 8개 모두 present. `pi.pi.VERSION === "18.1.10"`, `getAgentDir()` 동작.
- 이벤트 순서와 counters가 소스 독해(`docs/SOURCE-AUDIT.md`)와 일치. `tool_execution_start.args`가 실제 실행 입력.
- 중첩 디스패치(`write` → `xd://runtime_status`)는 외부 호출과 같은 `toolCallId`. toolCallId 단독 키는 외부 행을 `executing`으로 남겼다(다음 세션에서 거짓 `unknown`). `(toolCallId, toolName)` 키로 수정, 회귀 테스트 `tests/kernel.test.mjs` "a nested xd:// device dispatch …".
- `omp -p`는 `hasUI=false`; 기본 정책(`headlessEffects: allow`)에서 `bash`가 실행되고 `has_ui:0`으로 저널됨.
- 종료 시 `writer.released`, lease `expires=0`. 이후 같은 세션 ID를 다른 프로세스가 acquire 가능(테스트).

## 테스트가 방어하는 불변식

**저널/lease**: 같은 세션 이중 실행 거절, 형제 세션 공존, 살아 있는 형제의 `executing`은 sweep 안 함, lapse한 형제의 효과는 `unknown`→새 효과 차단(읽기는 허용), 읽기 중단은 `failed`, 재개 시 epoch 증가·사용량 카운터 유지·구 lease fencing, 중복 디스패치 거절, 사용량 카운터 무상한(호출 수·경과 시간이 차단하지 않음), observe 모드 unknown 비차단, `blockOnUnknown:false`, pause workspace 전역, 승인 정확 입력·1회·만료·epoch, evidence scope, nonzero exit/isError = `failed`(unknown 아님), 입력 수정 저널, isError 뒤집기 저널, goal mirror, reconcile(근거 선택·scope 검사·`all`·해소 후 새 효과 허용), 스키마 버전 불일치 거절.

**커널**: 네 이벤트 1회 정산, `tool_execution_end` 단독 마감, 중첩 디스패치 키, 차단한 호출의 후속 이벤트는 계약 위반으로 세지 않음, 못 본 호출의 이벤트는 `unmatched*`, 승인 1회 소비, 저널 쓰기 실패 → poison(enforce 차단 / observe 기록), lease 상실 차단, context의 권한 부인 문구.

**정책/근거**: 미지 도구·오도하는 MCP 이름 = 효과, 정확 allowlist만 read, headless 기본 허용/`deny` 옵션, `requireApproval` UI 필요, clab target fingerprint/headless/고위험, 모델 공급 descriptor 거절, approval hash 결합(입력·세션·epoch), evidence hash·traversal·symlink·secret·범위, zvec = read(입력 무수정·`revisions` 0·`search.*` 이벤트 없음·toolCalls +1/effects +0), zvec 실패·lapse = `failed`(unknown·poison 아님, 다음 효과 허용), workspace-write 분류(literal/edit path/정책·자격증명·device·shebang·dangling symlink), 민감 read 이벤트(차단 없음).

**확장(mock)**: 로드·도구 4개·명령·저널 사이클·compat report `ok`·before_agent_start 상태(사용량·`search.semanticDiscovery`=zvec), evidence→checkpoint→candidate 체인과 `MEMORY_PORT_UNBOUND`, pause/resume/reconcile all, 멤버 누락 시 disabled(비REQUIRED)·차단(REQUIRED)·report `degraded`, runtime config 반영과 잘못된 config fail closed, shutdown 후 재acquire.

**메모리**: 미바인딩/idempotency 없는 포트 거절, 후보≠정본, fresh 근거 게시, stale 근거 사전 거절, timeout→unknown→read-back ack, receipt 없음은 재시도 허가 아님, durable ack 없는 성공 거절, hash 불일치 거절, 투기적 kind·자격증명 거절, sending 중 lapse→unknown, validator 변조 차단.

## 수행하지 않은 검사

- 인터랙티브 TUI에서 `/runtime` 명령과 승인 대화상자 실행(print 모드와 mock으로만 검증).
- `session_switch`(`/resume`, `/new`) 경로의 라이브 재attach.
- 원격 Utopia 쓰기·조회(이 세션에서 mem.clab.one 연결 실패; 전송은 설계상 미바인딩).
- 다른 OMP 버전. `compat/tested-versions.json`에는 18.1.10만 있다.
- 동일 workload A/B 성능 측정. 모델 기반 작업 품질에 대한 주장은 없다.
- 두 프로세스가 같은 workspace에서 동시에 효과를 실행하는 실제 경쟁(단위 테스트의 시계 기반 시뮬레이션만).
