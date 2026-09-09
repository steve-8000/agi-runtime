# OMP Native Runtime 0.5

판단과 작업 완료는 프론티어 모델과 OMP 네이티브 루프가 담당한다. 이 패키지는 모델 위에 또 다른 오케스트레이터를 올리지 않는다.

```text
OMP
├─ Sharpshooter                   memory owner
├─ native source/edit/build/test  실행과 검증의 정본
├─ native agentLoop               도구 결과를 다음 모델 턴으로 전달
│
└─ lazy-intel                     ONE code-intelligence MCP
     └─ code_intel                ONE exposed intelligence tool
          ├─ zvec-grep            semantic/hybrid retrieval
          ├─ CodeGraph            architecture / call flow / impact
          └─ Serena               live LSP semantics

OMP public events
└─ agi-runtime extension          선택적 관측·복구 계층
     ├─ SQLite journal           관측 결과와 원본 세션 참조
     ├─ Sharpshooter observation  읽기 전용; 미통합 delta와 오류만
     └─ request projection       다음 행동을 바꾸는 상태가 있을 때만
```

`ONE MCP`는 코드 인텔리전스의 단일 연결을 뜻한다. 별도 제품 도구인 lazy-ios와 figma-bridge를 제거한다는 뜻이 아니다. runtime은 MCP를 등록하거나 자체 클라이언트를 열지 않는다. OMP가 MCP 연결과 도구 발견을 소유한다.

## 책임과 진실의 순서

- Main만 아키텍처·편집·통합·빌드·테스트·수정을 수행한다. `scout`와 `reviewer`는 읽기 전용이다. `task` dispatch 도구와 비활성 generic `task` worker를 구분한다.
- 현재 환경과 소스, 실행 결과가 기억·검색 순위·인덱스 해석보다 우선한다.
- Sharpshooter만 장기 기억을 추출·통합·주입한다. 외부 memory MCP, runtime memory-write API, memory outbox, 회상 gate는 없다.
- lazy-intel만 파생 인덱스 생성·감시·동기화·복구를 소유한다. OMP의 독립 `zvec-autoindex.ts`는 로딩 경로에서 제거했다.
- runtime journal은 관측 기록이다. 외부 작업의 exactly-once, 실패 후 rollback, 기억의 의미적 진실을 증명하지 않는다.

## 도구 선택

정확한 이름·경로·리터럴·오류·모든 사용처는 native `glob`/`grep`/AST 및 live semantics로 확인한다. 위치·표현·관계가 불명확한 질문은 `code_intel`에서 시작한다.

| operation | 소유 backend | 주요 입력 |
|---|---|---|
| `search` | zvec-grep | `root`, `query` |
| `architecture` | CodeGraph | `root`, `query` |
| `impact` | CodeGraph | `root`, `symbol` |
| `symbol` | Serena | `root`, `symbol`, 선택적 `relativePath` |
| `references`, `implementations` | Serena | `root`, `symbol`, `relativePath` |
| `diagnostics` | Serena | `root`, `relativePath`, `query` 또는 `symbol` (lazy-intel 0.2 입력 검증) |
| `auto` | 최대 두 backend | 질문 종류가 정말 불명확할 때 |
| `status`, `sync`, `reindex`, `repair` | 지정 backend | 장애가 보고된 뒤의 복구용 |

`freshness=auto`와 기존 embedding 설정을 유지한다. 모델에게 index 초기화 명령을 실행시키거나 사용자가 인덱스를 준비하도록 요구하지 않는다. backend가 실패하면 native 도구로 가능한 일을 계속한다.

JavaScript의 cross-file LSP 분석에는 프로젝트 범위가 필요하다. 이 저장소의 `jsconfig.json`은 `.mjs` 소스·확장·스크립트·테스트를 포함한다. 추가 전 `config` 참조 조회가 `{}`였고, 추가 후 실제 Serena 응답에 네 파일의 호출부가 나타났다. 빈 의미 검색 결과를 완전성 증거로 취급하지 않는다.

`mcp__lazy_intel_code_intel`의 조회와 `status`는 runtime 관측상 읽기다. 명시적 `sync`·`reindex`·`repair`는 `derived-effect`/`derived` scope이며 기존 effect journal·pause·unknown/read-back 경로로 관측한다. `write(xd://...)` envelope도 실제 tool identity와 operation으로 분류한다. 파생 인덱스 I/O가 전혀 없다는 뜻은 아니며 OMP의 승인 정책을 override하지 않는다. 도구 입력의 root/query/freshness/범위를 runtime이 재작성하지 않는다.

## 사람 없이 이어지는 실행

OMP 18.1.11의 `packages/agent/src/agent-loop.ts`가 도구 호출 결과를 다음 모델 요청에 넣는다. 도구 결과나 진행 보고는 사용자에게 제어권을 돌려줄 이유가 아니다. AGENTS는 조사→구현→실행 검증→관측된 오류 수정→완료를 같은 작업 안에서 수행하도록 규정한다.

runtime에는 `session_stop` 재촉, `sendMessage`, `triggerTurn`, 강제 도구 호출, judge loop, 모델/effort 재선택, 실행 횟수·시간·토큰 예산이 없다. 기존 모델 역할도 바꾸지 않는다. 알려진 작업을 매번 사용자에게 실행시켜 달라고 요청하지 않는다.

자율성은 무조건적인 재시작이나 안전 승인 우회가 아니다.

- 명시적 사용자 stop/pause를 자동 해제하지 않는다.
- provider 오류·안전 승인·권한 부재·실제 외부 장애를 완료로 위장하지 않는다. 가능한 독립 작업은 계속한다.
- 기존 Kubernetes hook과 파괴적·credential·financial·production 보호를 유지한다. 이 작업에서는 클러스터를 변경하지 않았다.
- OMP 프로세스가 종료되면 extension timer도 종료된다. OS crash supervisor는 이 패키지에 없다. 네이티브 `--continue`/`--resume`은 OMP의 기능이며 자동 재전송 스크립트를 덧붙이지 않는다.
- 모델이 잘못 완료를 선언하는 모든 경우를 강제로 막는다는 보장은 없다. 실제 두 모델의 유한 end-to-end 실행 증거와 일반적인 무오류 보장을 구분한다.

## journal과 복구

`src/contracts.mjs`가 identity와 outcome을 분류하고, `src/kernel.mjs`가 이벤트를 연결하며, `src/journal.mjs`가 관측을 저장한다. 같은 `toolCallId`의 xd envelope와 실제 child는 logical action 하나다. `code_intel` 분류는 고정 tool identity와 명시적 operation을 함께 사용한다. 조회 중의 자동 freshness 갱신은 조회에 포함하며, 별도 maintenance 요청만 derived effect로 분리한다. 임의 native 도구를 read로 바꿔 pause를 우회할 수 있던 `searchTools` 설정 경로는 제거했으며 현재 runtime config는 `{}`다. 다른 ID의 같은 입력은 합치지 않는다.

오류 관측은 뒤의 성공 응답으로 지우지 않는다. start를 보았으면 end 전까지 완료로 확정하지 않는다. input drift, process/lease 상실, 마지막 persistence 실패는 불명 상태로 남길 수 있다. 실패한 명령이 외부 부작용을 남기지 않았다는 주장은 하지 않는다.

불명 작업은 실제 대상 read-back 뒤 `runtime_reconcile`로 명시한 ID만 정리한다. 나중에 성공한 읽기 참조와 agent attestation이 필요하다. 같은 clock tick의 이전 읽기나 실패한 읽기는 허용하지 않는다. 구 memory scope의 이력은 보존하지만 새 로컬 읽기로 외부 memory service를 확인했다고 인정하지 않는다.

SQLite 장애는 observer만 degraded로 바꾸며 일반 개발을 막지 않는다. 기존 managed timer가 lease/저널 재연결을 담당한다. heartbeat 5초, lease 30초, 재연결 간격 10초는 프로세스 소유권 관리이며 작업 예산이 아니다. 회복 후 효과를 자동 재전송하지 않는다.

## Sharpshooter와 컨텍스트

네이티브 backend는 사용자 메시지에서 decision delta를 추출하고, 자체 scheduler가 통합하며, `architecture.md`/`product.md`/`style.md`를 developer context에 주입한다. 추출과 friction/consolidation 판단은 OMP 소유다. 모델의 모든 설명이나 모든 사용자 문장이 영구 저장되는 것은 아니다.

runtime은 `ctx.memory.status().scope`로 실제 bank를 찾는다. bank id의 파생식을 복제하지 않는다. 통합된 문서는 재주입하지 않으며, 기억을 쓰거나 `/memory sync`를 강제하지 않는다. 미관측 bank는 `null`이지 빈 기억이라는 뜻이 아니다. queue·session queue·delta 파일에서 EACCES 등 실제 읽기 실패가 발생해도 `null`로 남기며 부분 관측을 정상 snapshot으로 반환하지 않는다. 생성/통합 중의 ENOENT와 malformed delta JSON은 기존 처리대로 구분한다.

미통합 delta는 재개/compaction recovery card에만 나타난다. compaction handler는 bank sample을 await하여 다음 요청이 이전 sample을 사용하는 경쟁을 막는다. 기억 내용은 미통합·비신뢰 evidence로 명시한다. consolidation 오류는 credential이 섞일 수 있는 원문 대신 고정 분류값만 제공한다.

`src/context.mjs`는 자기 과거 메시지만 제거한 detached projection을 만든다. 평상시에는 **0 bytes, 추가 메시지 0개**다. pause/degraded/unknown/resume일 때만 최대 4 KiB의 유효 JSON을 제공한다. 이것은 출력 packing이지 실행 quota가 아니다. 상세 상태는 선택적인 `runtime_status`로 읽는다.

## 호스트 계층과 재현성

`config/AGENTS.md`, `config/rules/`, `config/mcp.json`, `config/runtime.json`에 비밀이 없는 실제 호스트 계약을 추적한다. auth 파일·credential·전체 사용자 설정·메모리 bank는 저장소에 넣지 않는다. 경로와 활성화 절차는 MIGRATION.md, 실행 결과는 VERIFICATION.md, upstream 근거는 SOURCE-AUDIT.md를 따른다.
