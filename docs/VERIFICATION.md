# Verification — Runtime 0.5.0

환경: macOS arm64, Node v26.7.0, Homebrew OMP 18.1.11. 이 기록은 실제 이 checkout·호스트에서 실행한 결과다. 구형 65-test/한 단어 attach 증거를 현재 버전의 결과로 재사용하지 않는다.

## 2026-09-09 통합 보강 검증

- OMP 18.1.11 기반 stdio cancellation 패치: transport 테스트 46개 통과, TypeScript check 통과, 바이너리 build 및 실제 CLI 실행 성공.
- Runtime: runtime/extension 38개, installer 7개 통과. 명시적 intelligence maintenance의 derived effect 분류, pause, envelope 중복 방지, unknown/read-back을 검증했다.
- lazy-intel: 실행 파일·canonical root·watcher 상한·atomic installer·취소·partial repair 실패 회귀를 실행했고 관측된 실패를 수정했다. 실제 zvec-grep 0.2.1, CodeGraph 1.6.0, Serena 1.7.0에서 search/architecture/impact/references/symbol 모두 PASS.
- `scripts/check-omp-contract.mjs`의 실제 OMP SDK type compatibility와 양쪽 GitHub Actions workflow의 actionlint 검증 통과. 원격 scheduled job 실행 결과와는 구분한다.
- `evidence/live-integrated.json`: 실제 OMP 기본 모델 **13턴 / 325.294초 / PASS**. Sharpshooter 활성, intelligence tool 하나, verifier 불변, 소스 수정 후 verifier 성공, runtime healthy/unknown 0.
- 동시 4세션·400회 synthetic derived-effect hook cycle: 기록 400회, degrade 0, p95 0.864ms. 별도 강제 lock은 136.203ms 뒤 observer degrade를 확인했다. 정상 read hook 1,000회 median 0.294ms / p95 0.560ms, steady context 0 bytes. `busy_timeout=100ms`를 유지한다.
- 두 파일 scratch의 최초 search 7,236ms, MCP 재시작 후 최초 2,556ms, warm 1,797ms. 단일 표본이며 기존 재시작 reconciliation 정책을 유지한다.
- 최종 reviewer pass는 사용자의 우선 커밋·푸시 요청으로 중단됐다. 완료된 리뷰로 주장하지 않는다.

아래는 이전 0.5 검증 이력이다.

## Deterministic checks

| 실행 | 결과 | 범위 |
|---|---|---|
| `node scripts/upgrade-check.mjs --json --live` | PASS | 모델·reasoning override 제거 후 최신 gate: 실제 버전·활성 symlink·parser/config·패키지 회귀 + OMP 메인 기본값 실행 |
| gate 내 `node --test --test-reporter=tap tests/runtime.test.mjs tests/extension.test.mjs tests/memory.test.mjs tests/install.test.mjs` | **54 passed, 0 failed, 0 skipped** | 실제 SQLite/임시 FS, mock OMP event adapter, Sharpshooter 권한 거부·복구, installer/foreign-bank 보존 |
| gate 내 `node scripts/check.mjs` | **17 parser/config checks passed** | OMP SDK build나 전체 LSP diagnostics 아님 |
| `node --test tests/install.test.mjs` | **6 passed, 0 failed** | 설치 plan, symlink activation/idempotency/rollback, foreign file/package 보존, zsh block 보존 |
| 추가 `--test-name-pattern='live probe preserves' tests/install.test.mjs` | **1 passed, 0 failed** | 리뷰 후 추가한 actual-CLI foreign-memory-bank 보존 회귀 |
| `node scripts/measure.mjs` | 1,000 hook cycles | synthetic 결과 + 실제 로컬 SQLite; 모델·네트워크 latency 제외 |

cleanup·memory I/O 보정 당시의 53-test/14턴 모델 지정 실행은 `evidence/memory-io-upgrade-check.json`에 보존했다. 공개 probe 보정 뒤 54개 일반 gate와 synthetic child의 원문 비노출 확인도 통과했다. 이후 사용자 의도에 맞춰 모델·reasoning override를 삭제하고 **기존 gate**를 다시 실행했다: 54개 회귀와 OMP 메인 기본값의 실제 12턴 실행 모두 PASS. 이 정정에 새 테스트·게이트·실행 계층은 추가하지 않았다. 현재 gate는 네 test 파일과 installer 7개를 포함하며 위의 별도 6개/1개는 최초 확인 이력이다.

최신 원본: `evidence/upgrade-check.json`, `evidence/probe-projection-smoke.json`, `evidence/memory-io-smoke.json`, `evidence/check.jsonl`, `evidence/summary.json`. `evidence/initial-upgrade-check.json`과 `evidence/initial-runtime-tests.tap`은 cleanup/I/O 보정 전의 역사적 16턴·45-test 증거다. 당시 scope 문구와 전체 stdout은 최신 gate의 출력 계약으로 해석하지 않는다.

## 실제 모델 실행

현재 경로는 OMP 메인 기본 모델과 reasoning 설정을 그대로 사용한다. Fable/Astra는 사용자 설명의 이름이지 runtime의 선택 옵션이 아니다. 아래 모델 지정 실행은 이 의도를 정정하기 전의 역사적 시험이며 기본 모델 경로의 증거로 대체하지 않는다.

| 과거 명시적 모델 지정 실행 | 결과 | model turns | 시간 |
|---|---|---:|---:|
| `openai-codex/gpt-6-astra` 최초 probe | PASS | 8 | 78.509 s |
| `anthropic/claude-fable-5-1` | PASS | 5 | 47.931 s |
| Astra 초기 통합 gate | PASS | 16 | 129.412 s |
| Astra I/O·진단 보정 gate, 공개 projection 보정 전 | PASS | 14 | 93.087 s |

각 실행은 한 번의 실제 `omp -p`에서 중간 사용자 응답 없이 진행했다. fixture는 percent discount를 잘못 계산하도록 만들었으며, subprocess로 수정 전 실패를 확인했다. 모델은 `search`·`architecture`·`references`를 호출하고 native source inspection/명령/편집/검증을 수행했다. OMP 종료 뒤 같은 verifier를 다시 실행해 성공과 verifier 불변을 확인했다. `runtime_status`는 0.5.0/healthy/unknown 0이었다.

실제 stdio `tools/list`는 intelligence tool `code_intel` 하나였다. native 모델 tool 목록에 standalone zvec/CodeGraph/Serena MCP는 없었다. 마지막 실모델 gate는 독립 `zvec-autoindex.ts`의 로딩 경로 부재도 확인했다. 조회는 journal에 read로 기록됐다.

원본: `evidence/live-astra.json`, `evidence/live-fable.json`, `evidence/memory-io-upgrade-check.json`, `evidence/intelligence-tools.json`.

실제 호스트 OMP 설정·extension·credentials를 검증하기 위해 agent directory는 재사용한다. source/session/runtime journal은 scratch이며, native Sharpshooter가 scratch scope의 호스트 bank를 만들 수 있다. 이것은 production workload/cluster 변경이 없다는 것과 구분한다. 현재 probe는 child가 보고한 bank 경로를 삭제하지 않는다. 초기 합성 bank 세 개와 I/O 보정 실모델 gate의 합성 bank 한 개는 실제 delta/문서 내용을 확인한 뒤 별도 정리했다. 일회성 memory pipeline/I/O probe 디렉터리도 제거했다. `intel-contract-probe`는 종료 상태를 확인했다. 실제 사용자 프로젝트 bank는 건드리지 않았다.

## 실제 Sharpshooter pipeline

`evidence/live-memory.json`: **extracted / consolidated / injected / answered 모두 PASS**.

1. 합성 프로젝트에서 floating-point 통화를 integer cents로 대체한다는 사용자 correction을 실제 native extraction에 전달했다.
2. queue에 correction·constraint·rejected approach **3개**가 나타났다.
3. native consolidator가 해당 3개를 처리하고 `architecture.md`에 결정을 썼다. 관측한 consolidation model은 `grok-4.6`이었다.
4. 새 OMP 세션의 native system-prompt segment에서 채워진 bank 문서의 실제 내용을 확인했고, 모델은 retained decision만으로 integer cents를 답했다.

초기 테스트 observer에는 두 결함이 있었다. 짧은 종료 hook에서 비동기 작업을 기다려 2초/30초 handler deadline에 걸렸고, 이후 `BeforeAgentStartEvent.systemPrompt`를 string으로 오해했다. native source의 실제 계약은 **string[]**다. 일반 native 명령으로 수명을 관측하고 각 segment에서 원래 bank 문서 내용을 검사하도록 throwaway probe를 고쳤다. 추출/통합 성공을 반복하지 않고 실패한 주입 검사만 재실행했다. 초기 실패 관측도 보고서에 남겼다. PASS는 제목 문구나 모델 답변만으로 판정하지 않았다.

테스트용 `--config` overlay에서만 consolidation interval을 0으로 설정했다. 호스트 interval·추출 모델을 바꾸거나 bank를 직접 작성하지 않았다. native provider 실패를 의도적으로 유발한 consolidation failure 검증은 수행하지 않았다.

## 회귀와 리뷰

- `searchTools:['bash']`로 pause가 우회되는 실패를 재현했다. 동적 read override 자체를 제거한 뒤 같은 테스트가 통과했다.
- xd outer/child correlation, read error 이후 개발 지속, conflicting result, input drift, journal/lease 손실, 명시적 read-back, retired external-memory scope 보호, pause와 기존 approval 비간섭을 검증했다.
- compaction이 최신 Sharpshooter sample을 await하고 다음 context가 해당 pending decision을 보는 경쟁 조건을 회귀로 고정했다.
- 실제 POSIX chmod로 queue EACCES를 재현했다. 수정 전 정상 빈 queue가 반환됐고, 수정 후 `null` 및 권한 복구 후 원래 결정 재관측이 통과했다. 별도 native smoke는 queue/session queue/delta 파일 세 경로 모두 확인했다. 영구 permission 회귀는 Windows·uid 0에서 skip하지만 이번 macOS 실행에서는 실제 수행됐다.
- 공개 진단은 마지막 12줄·2,048 UTF-8 bytes로 제한하며 기존 obvious-secret 검사를 먼저 적용한다. newline을 사이에 둔 Bearer credential과 긴 멀티바이트 문자열 smoke가 통과했다. 최신 gate JSON에는 raw stdout/stderr 대신 bounded tail만 있으며 raw trace 파일을 자동 저장하지 않는다. 이는 DLP 보장이 아니다.
- 추가 공개 경계 회귀: gate는 `probe` 원문 대신 고정 typed allowlist를 반환하고 모델을 `<configured>`로 표시한다. live child의 stdout/stderr/error 원문과 unknown 필드는 재전달하지 않는다. 실제 CLI의 synthetic child로 수정 전 모델 선택자 노출·수정 후 비노출을 확인했으며, 두 경우 모두 불완전 실행은 FAIL로 유지됐다. 별도 회귀는 valid PASS를 유지하면서 추가 필드/객체를 제거하고 truthy non-boolean check를 거절한다. focused reviewer에서 추가 material defect는 없었다.
- Reviewer의 P1: child `memory.scope`를 근거로 호스트 bank를 삭제하던 smoke finalizer. fake child가 foreign bank를 보고하는 actual-CLI 테스트에서 수정 전 ENOENT, 수정 후 파일 보존을 확인했다. 삭제는 mkdtemp scratch 트리로만 제한했다. 이 P1의 좁은 재리뷰는 추가 material defect 없음이었다.

## 비용과 미검증 범위

정상 runtime projection: **0 bytes / 추가 메시지 0개**. stress resume: 2,029 bytes; packing bound: 4,096 bytes. 측정은 runtime 카드만 포함하며 AGENTS·tool schemas·native memory·원래 대화는 별도다. 1,000 cycles median 0.273 ms, p95 0.536 ms, max 0.898 ms. cache/로컬 storage 영향을 받는 synthetic 수치이며 운영 SLO나 비용 절감률이 아니다.

검증하지 않은 것: 모든 모델/장기 작업의 성공률, 검색 relevance 품질, 모든 provider 오류와 safety 경로, Kubernetes hook의 모든 mutation 경로, 실제 전원 상실 내구성, OMP 프로세스 종료 후 OS 자동 재기동, production 배포. 테스트를 위해 기존 승인 정책을 끄거나 클러스터를 변경하지 않았다.

로컬 활성화와 실제 실행 검증은 완료했으나 이 변경의 Git commit/push와 원격 배포는 수행하지 않았다. 새 OMP 프로세스는 활성 symlink의 0.5를 로드한다. 이미 실행 중인 세션을 hot-patch했다고 주장하지 않는다.
