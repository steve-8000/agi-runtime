# Source Audit — OMP 18.1.11 / Runtime 0.5

현재 workspace·설치 상태를 우선한다. 아래 소스는 소유권과 event 계약의 근거이며 실행 검증은 `evidence/` 및 [VERIFICATION.md](VERIFICATION.md)에 분리한다.

## OMP native loop

- [agent-loop.ts](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/agent/src/agent-loop.ts): 도구 결과를 다음 모델 호출에 넣는 내부/외부 루프, queued follow-up, bounded `pause_turn` 처리. extension이 매 turn마다 `sendMessage`나 `triggerTurn`을 호출할 필요가 없다.
- `beforeModelCall.stop`, 사용자 abort, native deadline, terminal tool response 등은 종료 이유가 될 수 있다. provider 안전 승인을 우회해 계속하는 기능은 추가하지 않았다.
- 실제 CLI `omp --help`: print mode, session resume, model/thinking 선택을 제공한다. end-to-end probe는 한 번의 `omp -p` 호출에서 여러 모델 턴과 실제 편집·실행을 관측했다. `--auto-approve`를 사용하지 않았다.
- [extension types](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/extensibility/extensions/types.ts): `BeforeAgentStartEvent.systemPrompt`는 **`string[]`**다. 테스트 observer가 문자열 `.includes()`로 해석하면 실제 주입을 놓친다. 모델 컨텍스트 검증은 각 segment 내용으로 수행해야 한다.

## Sharpshooter

- [backend.ts](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/sharpshooter/backend.ts): `message_start`의 committed user prompt에서 extraction을 시작한다. startup race는 최신 user message로 catch-up한다. `taskDepth > 0`의 subagent는 제외한다.
- [extract.ts](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/sharpshooter/extract.ts): 비동기 extraction, 검증 가능한 원문 evidence를 가진 delta만 queue에 저장, 짧은 print 세션 dispose에서 bounded flush. 모델 응답이 즉시 끝나는 테스트에서 비동기 작업 수명을 충분히 관측하지 않으면 false negative가 가능하다.
- backend `buildDeveloperInstructions`: `architecture.md`, `product.md`, `style.md` 중 채워진 문서를 읽어 injection token limit 안에서 developer instructions를 구성한다.
- scheduler/consolidator: OMP가 queue와 consolidation lock, 통합 state와 문서 replacement를 소유한다. runtime은 `ctx.memory.status()`가 알려 준 scope만 읽는다.
- 실제 `omp config get memory.backend`는 `sharpshooter`. 모델 smoke 두 개에서 backend active를 관측했다. 설정만으로 추출/통합/주입 PASS라고 판단하지 않는다.

## lazy-intel

현재 호스트 `/Users/steve/lazy-project/lazy-intel`, commit `dff2e3e69560adf4333d3d33c76868c765e6a417`, version 0.2.0.

- `src/mcp/server.js`: `tools/list`는 `[TOOL]`, `tools/call`은 `code_intel`만 받는다. 실제 stdio initialize/tools-list 응답을 `evidence/intelligence-tools.json`에 저장했다.
- `src/engine.js`: operation별 query/symbol 검증과 backend routing. `diagnostics`도 `query` 또는 `symbol`이 필요하며 Serena의 file input에는 `relativePath`를 준다. query를 생략한 호출은 protocol error였고 올바른 입력으로 diagnostics 호출 성공을 확인했다.
- `src/backends/serena.js`: native LSP symbol/reference/implementation/diagnostics를 제공한다. JS 프로젝트 설정 없이 받은 빈 references는 호출자 부재의 증명이 아니었다. runtime `jsconfig.json` 추가 후 `config`의 kernel/extension/check/tests cross-file references를 실제로 반환했다.
- graph `impact(Runtime)`는 현재 src/extension/scripts/tests 의존 관계를 반환했다. `diagnostics(src/contracts.mjs)`의 관측 결과는 `{}`였다. 이것을 프로젝트 전체 compiler 검증으로 확대 해석하지 않는다.
- 호스트 MCP 설정은 standalone zvec/CodeGraph server를 disabled로 유지하며 lazy-intel 하나를 노출한다. 경쟁 `zvec-autoindex.ts`는 extension 로딩 디렉터리 밖으로 이동했다. backend package/process 여러 개가 실행되는 것과 OMP에 MCP 도구 여러 개를 노출하는 것은 다른 문제다.

## Runtime boundaries

`extension/index.mjs`는 native event를 journal/observer로 전달한다. kernel은 효과의 결과/불명 상태와 lease를 관리한다. context는 정상일 때 비어 있으며 복구 때만 action-changing 상태를 준다. 통합 memory의 재주입·독립 extraction·forced continuation은 없다.

`config/AGENTS.md`와 검색 규칙은 실제 호스트 정책의 추적본이다. 변경 후 사용자 승인/production 정책을 보존했다. 소스 확인과 로컬 activation이 GitHub push 또는 production 배포를 뜻하지 않는다.
