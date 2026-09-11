# Architecture: native execution, selective context

실행 구현은 runtime 0.5.0이다. 정책 개정은 아래 runtime 계약을 바꾸지 않는다. 모델과 OMP가 작업을 수행하고, runtime은 관측과 복구만 담당한다.

## 소유권과 데이터 흐름

| 계층 | 소유하는 것 | 소유하지 않는 것 |
|---|---|---|
| Main + OMP | 판단, 소스 수정, 네이티브 도구 루프, 검증, session, 승인 | 외부 작업의 무조건적 성공 |
| read-only agents | 조사·독립 검토의 근거 | 소스 쓰기, 최종 통합, 권한 부여 |
| Sharpshooter | 사용자 결정 추출, queue, 통합, native memory injection | workspace index |
| lazy-intel | 단일 `code_intel`, retrieval/graph/LSP, 파생 인덱스 수명주기 | durable memory, 최종 correctness 판단 |
| runtime | 이벤트 correlation, journal, 불명 결과, checkpoint, 복구 정보 | 모델 선택, 실행 budget, 완료 judge, 두 번째 루프 |

OMP가 MCP 연결과 도구 발견을 소유한다. runtime은 별도 MCP client를 만들지 않는다. 하나의 code-intelligence MCP는 lazy-ios나 figma-bridge 같은 다른 제품 도구까지 제거한다는 의미가 아니다.

현재 환경·소스·실제 실행 결과가 기억과 인덱스의 해석보다 우선한다. 어느 근거도 실행 권한을 부여하지 않는다.

## 검색과 정책 로딩

[AGENTS.md](../config/AGENTS.md)의 짧은 라우팅 계약을 상시 유지하고, [search-routing.md](../config/rules/search-routing.md)의 operation별 설명은 필요할 때 읽는다. 의미·구조·영향 분석에서 lazy-intel을 선택 사항으로 만들지 않되, 알려진 경로·문자열·전수 검색까지 semantic 호출로 우회시키지 않는다.

`root`는 실제 작업 프로젝트의 canonical absolute path다. MCP process cwd를 프로젝트 경계로 가정하지 않는다. freshness와 index maintenance는 lazy-intel이 소유한다. 명시적인 maintenance만 복구/사용자 요청에 따라 실행하며 독립 autoindex extension을 추가하지 않는다.

OMP 18.1.11의 rulebook은 description을 노출하고 본문을 `rule://`로 제공한다. `agents`는 rule 노출 범위를 제한하지만 write capability를 강제하는 보안 기능은 아니다. 역할 권한과 승인 hook은 별도다. [소스 근거](SOURCE-AUDIT.md)를 참고한다.

## 이벤트와 journal

`extension/index.mjs`는 native public events를 전달하고, `src/contracts.mjs`는 identity/outcome을 분류하며, `src/kernel.mjs`와 `src/journal.mjs`가 correlation과 저장을 담당한다.

같은 `toolCallId`의 xd envelope와 실제 child는 logical action 하나다. 다른 ID의 동일 입력을 같은 작업으로 합치지 않는다. `code_intel` 조회 및 `status`는 read, 명시적인 `sync`/`reindex`/`repair`는 derived-effect다. 조회 중 자동 freshness I/O가 없다는 뜻은 아니며 native 승인 정책을 override하지 않는다. 도구 입력도 재작성하지 않는다.

앞선 오류를 나중 성공으로 지우지 않는다. start를 관측했으면 end 전까지 완료로 확정하지 않는다. input drift, process/lease 상실, persistence 실패는 불명 상태로 남을 수 있다. 실패한 명령이 부작용을 남기지 않았다고 단정하지 않는다.

불명 효과는 나중에 성공한 실제 read-back과 agent attestation을 받은 뒤 `runtime_reconcile`에 명시한 ID만 정리한다. 이전 읽기, 실패한 읽기, 무관한 로컬 읽기로 외부 상태를 증명하지 않는다. retired external-memory 이력도 같은 이유로 로컬에서 완료 인증하지 않는다. attestation 자체는 독립적인 외부 사실 증명이 아니다.

SQLite 장애는 observer를 degraded로 만들며 일반 개발을 막지 않는다. heartbeat/lease/reconnect는 프로세스 소유권 관리이며 작업 budget이 아니다. 복구 시 효과를 자동 재전송하지 않는다.

## Memory와 compaction

Sharpshooter가 사용자 메시지의 결정을 추출·통합하고 `architecture.md`, `product.md`, `style.md`를 주입한다. 모든 메시지나 에이전트 발언이 영구 저장된다는 보장은 없다. runtime은 `ctx.memory.status().scope`를 따라 읽기만 하며 bank 경로 파생식을 복제하지 않는다.

통합된 memory를 다시 주입하거나 `/memory sync`를 강제하지 않는다. 미관측 bank와 queue/session queue/delta의 실제 읽기 실패는 빈 기억이 아니라 `null`이다. 생성 중 ENOENT와 malformed delta의 처리는 별도로 구분한다. compaction handler는 최신 bank sample을 기다려 이전 snapshot이 다음 요청에 쓰이는 경쟁을 피한다.

미통합 결정은 resume/compaction recovery card에만 비신뢰 evidence로 나타난다. 통합 오류는 원문 credentials가 아니라 고정 분류값으로 전달한다.

## 요청 컨텍스트와 안전 경계

`src/context.mjs`는 자신의 이전 projection만 제거한 detached request를 만든다. 정상 상태에는 runtime 메시지를 추가하지 않는다. 행동을 바꾸는 예외 상태만 4 KiB 이내의 유효 JSON으로 전달하고, 세부 상태는 선택적인 `runtime_status`로 제공한다. 이는 출력 packing 상한이며 총 prompt 크기나 실행 횟수 제한이 아니다.

`/runtime pause`는 advisory다. 읽을 수 있는 journal과 현재 runtime 밖에서 production interlock을 보장하지 않는다. native approvals, Kubernetes hook, 명시적 사용자 stop은 그대로 유지한다. instrumentation 장애를 이유로 이 경계를 완화하지 않는다.

OMP native loop가 도구 결과를 다음 모델 요청으로 전달한다. runtime은 follow-up 메시지나 강제 turn을 생성하지 않는다. 프로세스 종료 후 OS 재기동, 모든 잘못된 완료 선언 차단, 원격 exactly-once 보장은 없다.

호스트 정책 템플릿과 적용 절차는 [MIGRATION.md](MIGRATION.md), 과거 실행 기록은 [VERIFICATION.md](VERIFICATION.md), 이번 정책의 검증 범위는 [POLICY-VALIDATION.md](POLICY-VALIDATION.md)에 구분한다.
