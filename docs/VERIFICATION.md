# 검증 기록

기준: 2026-09-05. 실제 출력은 `evidence/`에 있다. 기록의 홈 디렉터리 접두어는 `$HOME`으로 치환했다. 환경: macOS arm64, Node v26.7.0, tsc 5.9.3, Bun 1.3.14(시스템), OMP 18.1.10(Homebrew 바이너리, 자체 Bun 내장).

## 수행한 검사

| 검사 | 결과 | 범위 | 증거 |
|---|---|---|---|
| `node --experimental-strip-types --test tests/*.test.mjs` | 82 passed, 0 failed | 실제 SQLite(node:sqlite)·파일 시스템·Ed25519 키. OMP는 v18.1.10 이벤트 모양의 mock | `evidence/node-test.tap` |
| `node scripts/check.mjs` | JS 23개 syntax, `tsc -p .` 통과 | `types/pi-coding-agent.d.ts`에 대한 typecheck. 전체 OMP typecheck 아님 | `evidence/check.jsonl` |
| `node scripts/demo.mjs` | 통과: 회상 거절 → settle → 다음 turn 허용, 불명 note → 백엔드 검사 거절 → status → 서명 receipt로 `reconciled`, publish 성공만으로 `submitted`, receipt로 `published` | offline, 스크립트가 만든 임시 서명키. 모델·원격 호출 없음 | `evidence/demo.json` |
| `scripts/compat.mjs --live` | `degraded:false`; offline `ok`, live `ok`, exit 0, `read`/`bash` 두 행 `succeeded`, compat report `ok`, counters intents/starts/results/ends 2/2/2/2, **`turns: 3`**(이전 실행 4; 프롬프트 1 + 모델 호출당 `turn_start`) | auto-discovery 경로로 실제 `omp -p` 1회. `turn_start`가 18.1.10에서 실제로 발화함을 확인 | `evidence/compat-live.json` |
| `node scripts/doctor.mjs` | `ready:true`; tested-version `tested`, compat-report `ok`, `memory-receipts: verifiable` | 실제 설치 상태 | `evidence/doctor.json` |
| clab-mem `bun test` | 120 passed (커밋 규약 14개 신규: 마커 dedupe, 덮어쓰기 재적용, 위에 쌓기, 청크 지연 대기, ready 미도달 거부, 손실 복원 거부·정규화 일치 허용, 읽는 중 행 변경 재읽기, 정확 캐시, 상한 실패, inspect가 duplicate보다 먼저, `not_sent`는 push 이전 연결 실패에만, SQLite 쓰기 lock: 같은 프로세스 큐 직렬화, 다른 프로세스가 쥔 lock은 busy 초과 시 `NotSentError`·그 프로세스 종료 후 획득) | `lazy-project/clab-mem` | 본 문서 |
| 청크 복원 fidelity 실측 | 정규화 전 0/40 일치, `render(parse(·))` 정규화 후 79/80 일치 | 실제 Utopia 기록 80건 | 본 문서 |
| clab-mem 라이브 `mem_task_note` ×2 (같은 `idempotency_key`) | 1회차 `receipt outcome=committed … action=updated`, 2회차 `action=duplicate`, 기록에 마커 1개·절 2개(요구사항+진행) | 실제 Utopia(`mem.clab.one`), `/usr/bin/curl` 전송 | 본 문서 |
| clab-mem 라이브 cache-miss note | 로컬 사본을 치운 뒤 새 키로 note → 복원·정규화 sha 일치 → `updated`, 이전 절 보존(절 3개, 마커 각 1개) | 다른 기계 경로의 실제 동작 | 본 문서 |
| v2 저널 손상 행 마이그레이션 | `bun`·`node` 양쪽에서 open이 throw, `user_version=2`·원본 `outbox`·행 보존(문장별 실행 + ROLLBACK) | 두 SQLite 엔진의 실제 동작 | 본 문서 |
| 서버 receipt → 런타임 `verifyReceipt` | 라이브 receipt 줄이 `memoryReceiptPublicKey`로 `verified:true`, 한 글자 바꾸면 `false` | 두 구현의 서명 호환 | 본 문서 |

## 라이브에서 확인한 것

- 확장이 컴파일된 OMP 바이너리 안에서 로드된다: `.ts` 진입점, `../src/*.mjs` 상대 import, `bun:sqlite`, `import type` 제거 모두 문제 없음.
- probe: API 멤버 9개, 컨텍스트 멤버 8개 모두 present. `pi.pi.VERSION === "18.1.10"`, `getAgentDir()` 동작.
- 이벤트 순서와 counters가 소스 독해(`docs/SOURCE-AUDIT.md`)와 일치. `tool_execution_start.args`가 실제 실행 입력.
- `xd://` 봉투는 디스패치되는 도구로 분류된다: 디스패치된 회상 read는 게이트를 만족시키고 봉투는 효과가 아니며, 디스패치된 편집·미지 device는 그대로 효과다. 운영자 `/runtime recall skip`은 goal 하나만 해제하고 `recall.override`로 기록된다(모델은 호출 불가).
- 중첩 디스패치(`write` → `xd://runtime_status`)는 외부 호출과 같은 `toolCallId`. toolCallId 단독 키는 외부 행을 `executing`으로 남겼다(다음 세션에서 거짓 `unknown`). `(toolCallId, toolName)` 키로 수정, 회귀 테스트 `tests/kernel.test.mjs` "a nested xd:// device dispatch …".
- `omp -p`는 `hasUI=false`; 기본 정책(`headlessEffects: allow`)에서 `bash`가 실행되고 `has_ui:0`으로 저널됨.
- 종료 시 `writer.released`, lease `expires=0`. 이후 같은 세션 ID를 다른 프로세스가 acquire 가능(테스트).
- `turn_start`는 18.1.10에서 모델 호출마다 발화한다(프롬프트 1개, 도구 2개 → `turns` 3~4 = `before_agent_start` 1 + 모델 호출당 `turn_start` 1). 발화하지 않는 호스트에서도 `before_agent_start`가 turn을 올리므로 회상 게이트는 프롬프트 단위로 degrade할 뿐 영구 차단되지 않는다.
- clab-mem 새 쓰기 경로(키별 lock + sha 검증 커밋 + 서명 receipt)가 실제 Utopia에서 동작한다. 같은 `idempotency_key` 재발행은 절을 붙이지 않고 `duplicate`를 돌려준다.

## 테스트가 방어하는 불변식

**저널/lease**: 같은 세션 이중 실행 거절, 형제 세션 공존, 살아 있는 형제의 `executing`은 sweep 안 함, lapse한 형제의 효과는 `unknown`→새 효과 차단(읽기는 허용), 읽기 중단은 `failed`, 재개 시 epoch 증가·사용량 카운터 유지·구 lease fencing, 중복 디스패치 거절, 사용량 카운터 무상한(호출 수·경과 시간이 차단하지 않음), observe 모드 unknown 비차단, `blockOnUnknown:false`, pause workspace 전역, 승인 정확 입력·1회·만료·epoch, evidence scope, nonzero exit/isError = `failed`(unknown 아님), 입력 수정 저널, isError 뒤집기 저널, goal mirror, reconcile(근거 선택·scope 검사·`all`·해소 후 새 효과 허용), 스키마 버전 불일치 거절.

**커널**: 네 이벤트 1회 정산, `tool_execution_end` 단독 마감, 중첩 디스패치 키, 차단한 호출의 후속 이벤트는 계약 위반으로 세지 않음, 못 본 호출의 이벤트는 `unmatched*`, 승인 1회 소비, 저널 쓰기 실패 → poison(enforce 차단 / observe 기록), lease 상실 차단, context의 권한 부인 문구.

**정책/근거**: 미지 도구·오도하는 MCP 이름 = 효과, 정확 allowlist만 read, headless 기본 허용/`deny` 옵션, `requireApproval` UI 필요, clab target fingerprint/headless/고위험, 모델 공급 descriptor 거절, approval hash 결합(입력·세션·epoch), evidence hash·traversal·symlink·secret·범위, zvec = read(입력 무수정·`revisions` 0·`search.*` 이벤트 없음·toolCalls +1/effects +0), zvec 실패·lapse = `failed`(unknown·poison 아님, 다음 효과 허용), workspace-write 분류(literal/edit path/정책·자격증명·device·shebang·dangling symlink), 민감 read 이벤트(차단 없음).

**확장(mock)**: 로드·도구 5개·`session_stop` 미등록·명령·저널 사이클·compat report `ok`·before_agent_start 상태(사용량·recall·memory·discovery·`search.semanticDiscovery`=zvec), evidence→checkpoint→candidate 체인(publish 명령 없음, 후보는 `candidate`), `runtime_reconcile`은 session-write라 workspace unknown·recall gate가 막지 못함(tool_call 경유 회귀), attestation(`by: session`, `observed` 저널), `agent_end` 알림만, 재attach·compaction 뒤 resume card 1회(저널 사실), pause/resume/reconcile all, 멤버 누락 시 disabled(비REQUIRED)·차단(REQUIRED)·report `degraded`, runtime config 반영과 잘못된 config fail closed, shutdown 후 재acquire.

**회상**: 같은 turn의 회상 intent·settle은 효과를 통과시키지 않음(`settledTurn < intent.turn`), 읽기는 대기 없음, 실패한 회상도 settle, `mem_status`/`mem_read`는 회상 아님, 10회 거절해도 상태 불변(횟수 해제 없음), goal 변경 시 재요구, epoch 재개 + task 알려짐 → 그 키의 `mem_task_read`만, `advise`는 차단 없음, `hits>0` 뒤 읽기 없음 → `recall.shallow`, discovery: zvec 전 distinct read 수·`freshness:` 관측·`search.scope` 이벤트(입력 무수정).

**메모리**: receipt 파싱 엄격(중복 토큰·미지 outcome·sig 없음 거절), 서명 검증(다른 키·변조 거절), publish 성공만으로 `submitted`(정본 아님), 무서명·타키·타payload receipt는 telemetry, 검증된 receipt로만 `published`, publish 입력≠후보 → `MEMORY_CANDIDATE_MISMATCH`(hash·idem·content·evidence·rejected), stale evidence는 publish·인용 note 모두 전송 전 거절, 인용 없는 note 허용+`memory.unverified`, publish 오류 → outbox·action `unknown`이되 workspace 효과는 비차단, 직전 실패 뒤 쓰기 → `MEMORY_BACKEND_DEGRADED`(status 성공으로 해제), 다른 idem 쓰기 → `RECONCILIATION_REQUIRED`, 같은 idem 재발행 허용, receipt 없는 2xx는 해소 아님, 자기 intent에 묶인 `committed`만 이전 행 `reconciled(by: receipt)`, `not_sent`는 서명+바인딩(key·idem 정확 일치)일 때만 `failed`(타키·타intent·idem 없음은 `unknown`), revise로 입력이 바뀐 쓰기는 성공해도 `unknown`(실행된 intent의 receipt로만 해소), payload가 바뀐 publish는 receipt가 있어도 `unknown`, task key 미확인 쓰기 → `MEMORY_TASK_NOT_STARTED`(실패한 read는 증명 아님, start는 예외), 자격증명 → `MEMORY_SECRET`, 투기적 kind 거절, `memoryTask`·`effectsSinceNote`는 저널에서 유도되어 재시작 뒤 동일(`rowid` 경계), v2 저널 마이그레이션.

**clab-mem 커밋 규약**(`mcp/commit.test.ts`): 마커 있으면 밀지 않음, 덮어쓰기 감지 후 재적용(두 절 보존), 위에 쌓인 경우 재적용 없음, `ready` 대기 후 바탕, 정확 캐시는 청크 미조회, 상한 초과는 실패(조용한 성공 없음), SQLite 쓰기 lock 직렬화(같은 프로세스 큐, 자식 프로세스가 쥔 lock 대기·해제).

## 수행하지 않은 검사

- 인터랙티브 TUI에서 `/runtime` 명령과 승인 대화상자 실행(print 모드와 mock으로만 검증).
- `session_switch`(`/resume`, `/new`)·`session_compact`·`agent_end` 경로의 라이브 발화(mock으로만; `turn_start`는 라이브 확인).
- 회상 게이트·메모리 게이트·`mem_publish`의 라이브 세션 실행(단위 테스트·demo·서버 라이브 note로 각 조각은 확인했으나 한 세션에서 이어 돌리지는 않았다. 이 세션의 OMP는 이전 확장·이전 MCP 서버를 로드한 상태였다).
- 두 기계에서 같은 기록에 동시에 쓰는 실제 경쟁(가짜 서버로만). 같은 기계의 두 프로세스 경쟁은 lock 테스트로만.
- 다른 OMP 버전. `compat/tested-versions.json`에는 18.1.10만 있다.
- 동일 workload A/B 성능 측정. 모델 기반 작업 품질에 대한 주장은 없다.
- 두 프로세스가 같은 workspace에서 동시에 효과를 실행하는 실제 경쟁(단위 테스트의 시계 기반 시뮬레이션만).
