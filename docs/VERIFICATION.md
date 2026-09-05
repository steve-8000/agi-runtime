# 검증 기록

기준: 2026-09-06 (OMP 18.1.11에서 재검증; 계약 변화 없음). 실제 출력은 `evidence/`에 있다. 기록의 홈 디렉터리 접두어는 `$HOME`으로 치환했다. 환경: macOS arm64, Node v26.7.0, tsc 5.9.3, Bun 1.3.14(시스템), OMP 18.1.10(Homebrew 바이너리, 자체 Bun 내장).

## 수행한 검사

| 검사 | 결과 | 범위 | 증거 |
|---|---|---|---|
| `node --experimental-strip-types --test tests/*.test.mjs` | 81 passed, 0 failed | 실제 SQLite(node:sqlite)·파일 시스템. OMP는 v18.1.10 이벤트 모양의 mock | `evidence/node-test.tap` |
| `node scripts/check.mjs` | JS 23개 syntax, `tsc -p .` 통과 | `types/pi-coding-agent.d.ts`에 대한 typecheck. 전체 OMP typecheck 아님 | `evidence/check.jsonl` |
| `node scripts/demo.mjs` | 통과: 회상 거절 → settle → 다음 turn 허용, 오류난 쓰기 → `unknown` → 백엔드 검사 거절 → 읽기 성공 후에도 `RECONCILIATION_REQUIRED` → attestation 뒤 허용 → stale evidence 인용 거절 | offline. 모델·원격 호출 없음 | `evidence/demo.json` |
| `scripts/compat.mjs --live` | `degraded:false`; offline `ok`, live `ok`, exit 0, `read`/`bash` 두 행 `succeeded`, compat report `ok`, contract 3, counters intents/starts/results/ends 2/2/2/2·`turns: 3` | 새 config(gbrain 도구·`recall.mode: require`)로 실제 `omp -p` 1회. 시작 명령 없이 attach·저널·게이트가 붙는다 | `evidence/compat-live.json` |
| `node scripts/doctor.mjs` | `ready:true`; tested-version `tested`, compat-report `ok`, `memory-tools: valid` | 실제 설치 상태 | `evidence/doctor.json` |
| 정본 메모리 라이브 왕복 | `remember` → `inserted`, `recall`(entity) → 그 사실을 그대로 반환, `search_degraded` 없음 | 실제 gbrain(`gbrain.clab.one/mcp`), 임베딩·chat은 맥의 `llm.clab.one` | 본 문서 |
| pod 안 모델 도달성 | `gbrain models doctor` 5/5 reachable(임베딩 `openai:Qwen3-Embedding-0.6B-8bit` 1024차원, chat `llama-server:mtplx-…`), reranker `(none)` | 클러스터 pod에서 실제 HTTP | 본 문서 |
| 저널 스키마 전진 마이그레이션 | 후보 큐 테이블이 있는 v3 저널을 열면 `user_version=4`·그 테이블 없음·`actions` 행 보존 | 실제 SQLite 파일 | `evidence/node-test.tap` |

## 라이브에서 확인한 것

- 확장이 컴파일된 OMP 바이너리 안에서 로드된다: `.ts` 진입점, `../src/*.mjs` 상대 import, `bun:sqlite`, `import type` 제거 모두 문제 없음.
- probe: API 멤버 9개, 컨텍스트 멤버 8개 모두 present. `pi.pi.VERSION === "18.1.10"`, `getAgentDir()` 동작.
- 이벤트 순서와 counters가 소스 독해(`docs/SOURCE-AUDIT.md`)와 일치. `tool_execution_start.args`가 실제 실행 입력.
- `xd://` 봉투는 디스패치되는 도구로 분류된다: 디스패치된 회상 read는 게이트를 만족시키고 봉투는 효과가 아니며, 디스패치된 편집·미지 device는 그대로 효과다. 운영자 `/runtime recall skip`은 goal 하나만 해제하고 `recall.override`로 기록된다(모델은 호출 불가).
- 중첩 디스패치(`write` → `xd://runtime_status`)는 외부 호출과 같은 `toolCallId`. toolCallId 단독 키는 외부 행을 `executing`으로 남겼다(다음 세션에서 거짓 `unknown`). `(toolCallId, toolName)` 키로 수정, 회귀 테스트 `tests/kernel.test.mjs` "a nested xd:// device dispatch …".
- `omp -p`는 `hasUI=false`; 기본 정책(`headlessEffects: allow`)에서 `bash`가 실행되고 `has_ui:0`으로 저널됨.
- 종료 시 `writer.released`, lease `expires=0`. 이후 같은 세션 ID를 다른 프로세스가 acquire 가능(테스트).
- `turn_start`는 18.1.10에서 모델 호출마다 발화한다(프롬프트 1개, 도구 2개 → `turns` 3~4 = `before_agent_start` 1 + 모델 호출당 `turn_start` 1). 발화하지 않는 호스트에서도 `before_agent_start`가 turn을 올리므로 회상 게이트는 프롬프트 단위로 degrade할 뿐 영구 차단되지 않는다.
- 정본 메모리는 verbs 표면(`recall`/`entity`/`context_pack`/`delta`/`synthesize`/`remember`/`forget`)만 노출한다. 쓰기에 서버가 강제하는 멱등 키가 없으므로 오류는 `unknown`으로만 닫힌다.

## 테스트가 방어하는 불변식

**저널/lease**: 같은 세션 이중 실행 거절, 형제 세션 공존, 살아 있는 형제의 `executing`은 sweep 안 함, lapse한 형제의 효과는 `unknown`→새 효과 차단(읽기는 허용), 읽기 중단은 `failed`, 재개 시 epoch 증가·사용량 카운터 유지·구 lease fencing, 중복 디스패치 거절, 사용량 카운터 무상한(호출 수·경과 시간이 차단하지 않음), observe 모드 unknown 비차단, `blockOnUnknown:false`, pause workspace 전역, 승인 정확 입력·1회·만료·epoch, evidence scope, nonzero exit/isError = `failed`(unknown 아님), 입력 수정 저널, isError 뒤집기 저널, goal mirror, reconcile(근거 선택·scope 검사·`all`·해소 후 새 효과 허용), 스키마 버전 불일치 거절.

**커널**: 네 이벤트 1회 정산, `tool_execution_end` 단독 마감, 중첩 디스패치 키, 차단한 호출의 후속 이벤트는 계약 위반으로 세지 않음, 못 본 호출의 이벤트는 `unmatched*`, 승인 1회 소비, 저널 쓰기 실패 → poison(enforce 차단 / observe 기록), lease 상실 차단, context의 권한 부인 문구.

**정책/근거**: 미지 도구·오도하는 MCP 이름 = 효과, 정확 allowlist만 read, headless 기본 허용/`deny` 옵션, `requireApproval` UI 필요, clab target fingerprint/headless/고위험, 모델 공급 descriptor 거절, approval hash 결합(입력·세션·epoch), evidence hash·traversal·symlink·secret·범위, zvec = read(입력 무수정·`revisions` 0·`search.*` 이벤트 없음·toolCalls +1/effects +0), zvec 실패·lapse = `failed`(unknown·poison 아님, 다음 효과 허용), workspace-write 분류(literal/edit path/정책·자격증명·device·shebang·dangling symlink), 민감 read 이벤트(차단 없음).

**확장(mock)**: 로드·도구 4개·`session_stop` 미등록·명령·저널 사이클·compat report `ok`·before_agent_start 상태(사용량·recall·memory·discovery·`search.semanticDiscovery`=zvec), evidence→checkpoint 체인(정본 메모리에 쓰는 런타임 도구 없음, publish 명령 없음), `runtime_reconcile`은 session-write라 workspace unknown·recall gate가 막지 못함(tool_call 경유 회귀), attestation(`by: session`, `observed` 저널), `agent_end` 알림만, 재attach·compaction 뒤 resume card 1회(저널 사실), pause/resume/reconcile all, 멤버 누락 시 disabled(비REQUIRED)·차단(REQUIRED, 호스트 계약 위반에 한정)·report `degraded`, runtime config 반영과 잘못된 config fail closed, shutdown 후 재acquire.

**회상**: 같은 turn의 회상 intent·settle은 효과를 통과시키지 않음(`settledTurn < intent.turn`), 읽기는 대기 없음, 실패한 회상도 settle, `recall.tools` 밖의 메모리 read(`synthesize`)는 회상 아님, 회상 settle 없이 3회 거절되면 게이트가 스스로 열리고 `recall.forced`를 남김(settle된 회상은 카운트를 되돌린다), 세션에 없는 회상 도구는 시도의 실패로 `unavailable`, goal 변경 시 재요구, 새 epoch는 이전 settle을 물려받지 않음, 디스패치된 회상(`xd://`)은 게이트를 만족시키고 봉투는 효과가 아님, 운영자 해제는 goal 하나·`recall.override` 저널·모델은 호출 불가, `advise`는 차단 없음, 조망 회상 뒤 아무 것도 읽지 않으면 `recall.shallow`, discovery: zvec 전 distinct read 수·`freshness:` 관측·`search.scope` 이벤트(입력 무수정).

**메모리**: `xd://` 봉투로 디스패치된 쓰기도 원격으로 범위가 잡힌다(저널 행의 도구 이름이 실행될 도구, `uncertainRemote` 1, 후속 메모리 쓰기 대기)·봉투 안의 자격증명도 device 실행 전에 거절, 자격증명 패턴은 전송 전 거절(`MEMORY_SECRET`, 저널에 executing 행 없음), 인용한 근거의 파일이 바뀌면 거절(`STALE_EVIDENCE`)·안 바뀌면 통과, 인용 없는 쓰기는 허용+`memory.unverified`, 직전 메모리 호출이 **불명**이면 다음 쓰기 대기(`MEMORY_BACKEND_DEGRADED`)·실패한 메모리 read는 쓰기를 막지 않음, 오류난 쓰기는 `unknown`(읽기 성공만으로 해소되지 않음, attestation 필요), 입력이 게이트 통과 후 바뀐 쓰기는 성공해도 `unknown`(`memory.write_revised`+`memory.write_unknown`), 메모리 unknown은 메모리 쓰기만 막고 workspace 효과는 계속(`blockedUntilReconciled` false), 후보 큐 테이블이 있는 저널은 v4로 전진하며 `actions` 보존, 미지 스키마는 열지 않음.

## 수행하지 않은 검사

- 인터랙티브 TUI에서 `/runtime` 명령과 승인 대화상자 실행(print 모드와 mock으로만 검증).
- `session_switch`(`/resume`, `/new`)·`session_compact`·`agent_end` 경로의 라이브 발화(mock으로만; `turn_start`는 라이브 확인).
- 인터랙티브 세션에서의 `recall.forced`(라이브 `omp -p` 두 경로로 확인: 마운트된 gbrain 회상 → 효과 실행, 도구 부재 → 3회 거절 후 자동 개방 + 효과 실행).
- 18.1.10·18.1.11 외의 OMP 버전. `compat/tested-versions.json`에 두 버전이 기록돼 있다.
- 동일 workload A/B 성능 측정. 모델 기반 작업 품질에 대한 주장은 없다.
- 두 프로세스가 같은 workspace에서 동시에 효과를 실행하는 실제 경쟁(단위 테스트의 시계 기반 시뮬레이션만).
