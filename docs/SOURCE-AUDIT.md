# 소스 근거와 설계 판단

기준일 2026-09-06. GitHub connector로 버전/파일/commit을 읽었다. 전체 repository clone이나 실제 Mac 설치 검증을 수행했다고 주장하지 않는다. 아래 링크는 source reference이며 런타임에서 네트워크로 호출하는 dependency가 아니다.

## 고정 근거

| 대상 | 기준 | 확인 내용 |
|---|---|---|
| steve-8000/agi-runtime | 580f0e52b67769acc3642053f167eaaf60d2c7ad | main ref, 최신 수정 diff, source-pins, evidence primitive, 기존 설계/검토 이력 |
| can1357/oh-my-pi | v18.1.11 | 최신 release 확인, extension event/public API, custom message/session 저장, CLI args |
| zvec-ai/zvec-grep | 52653951b24617762f4ab0c71c34d594e5001617 | 최신 commit, MCP search/freshness 계약(기존 source 검토 포함) |
| garrytan/gbrain | 8c70f6255047a7647adb30b1d6333a48068d9fa5 | 최신 commit, MEMORY_VERBS v1 문서, src/core/verbs.ts 실제 입력 계약 |
| clab-one/gbrain-server | 조회 시 deploy/gbrain.yaml | gbrain.clab.one과 verbs surface, 기존 로컬 모델 경로. 실제 pod 상태는 미검증 |

## OMP: 구현에 직접 반영한 사실

- https://github.com/can1357/oh-my-pi/blob/v18.1.11/docs/extensions.md
- https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/session/messages.ts
- https://github.com/can1357/oh-my-pi/blob/v18.1.11/docs/session.md
- https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/cli/args.ts

Public context handler는 provider용 messages의 detached copy를 다룬다. 그래서 자체 projection만 요청 단위로 교체한다. Native transcript를 반복 수정하거나 provider payload 전체를 가로채지 않는다.

tool_result는 extension 순서대로 수정될 수 있다. 원시 결과 보장을 버리고 ‘이 extension이 관측한 결과’로 명명했다. start/end 없는 호출을 같은 수준의 입력검증으로 간주하지 않는다.

getAllTools/getActiveTools는 공식 API에 존재한다. 그러나 실제 노출/활성/동적 discovery는 호스트 상태와 다르므로 이 패키지는 ‘도구가 연결됐다’를 config 문자열만으로 보증하지 않는다. 실제 OMP 적용에서는 해당 API와 현재 tools/list를 조회한다.

invokeTool은 same-name native builtin delegation이다. arbitrary MCP를 부르는 별도 bridge로 사용하지 않는다. managed timer는 수명과 오류 처리를 OMP에 맡긴다. session_stop/triggerTurn/sendUserMessage continuation은 사용하지 않는다.

Custom session record에는 type:title 슬롯이 앞설 수 있고 parentSession은 타입이 고정된 foreign key가 아니다. 그래서 임의 JSONL 위치나 parent ID를 추측하는 process supervisor를 만들지 않았다.

## gbrain: 결과 계약과 안전성의 구분

- https://github.com/garrytan/gbrain/blob/8c70f6255047a7647adb30b1d6333a48068d9fa5/docs/protocol/MEMORY_VERBS_v1.md
- https://github.com/garrytan/gbrain/blob/8c70f6255047a7647adb30b1d6333a48068d9fa5/src/core/verbs.ts

MEMORY_VERBS v1은 additive 확장을 허용하는 명시적 계약이다. context_pack/delta는 이미 존재하므로 새 memory aggregator를 만들지 않는다. context_pack.entities는 comma-separated string이다. recall/entity와 달리 synthesize는 별도 LLM을 호출할 수 있으므로 hot path 기본 호출로 두지 않는다.

중요한 정정: `remember` 실제 코드에는 `annotations.idempotentHint: true`가 있다. 따라서 ‘서버에 어떠한 dedup도 없다’는 설명은 틀리다. 문서는 similarity 기반 dedup/supersession과 embedding 부재 시 degraded_dedup도 설명한다. 이것은 요청 ID의 영속 uniqueness/exactly-once 계약과 동일하지 않다. 이번 구현은 unknown remember를 재전송하지 않는 보수적인 정책을 사용한다.

`forget`은 opaque fact ID 기준 idempotent로 문서화되어 있다. 이번 reducer는 write 오류를 일관되게 unknown 처리하므로 forget도 read-back을 요구할 수 있다. 정확한 ID retry를 별도 최적화하지 않은 의도적인 단순화이며 서버의 idempotency가 없다는 주장은 하지 않는다.

protocol_version/status/error 등의 유효한 응답은 구조화된 관측으로 처리한다. 성공 응답이 암호학적 영수증이거나 middleware 영향이 없는 원본이라고 가정하지 않는다. 모델이 받은 memory text를 새 instruction으로 실행하지 않는다.

`budget_tokens`는 반환 콘텐츠 packing을 위한 인자다. 실행 시간/호출 수 quota 제거와 충돌하지 않는다. private/world는 gbrain의 인증/scope 조건을 따르며 entity 슬러그를 ACL로 착각하지 않는다.

## zvec

- https://github.com/zvec-ai/zvec-grep/blob/52653951b24617762f4ab0c71c34d594e5001617/docs/03-mcp.md
- https://github.com/zvec-ai/zvec-grep/blob/52653951b24617762f4ab0c71c34d594e5001617/src/mcp/schemas.ts

검색 호출은 논리적 read지만 인덱스 갱신이나 embedding 비용까지 없는 것은 아니다. freshness/auth/model 선택은 zvec가 소유한다. runtime은 요청 인자를 수정하지 않는다. 제공되는 실제 schema가 권위이며 aliases/MCP server 이름이 바뀌면 identity 목록만 변경한다.

## 설계 판단인 것

local unknown을 workspace 전체 차단으로 바꾸지 않는 것, known memory unknown만 쓰기 보류하는 것, request-only 4 KiB projection, optional short checkpoints, 새 dependency 없이 SQLite adapter를 재사용하는 것은 이 패키지의 판단이다. upstream이 보장하거나 모든 workload에서 최적이라고 발표한 내용이 아니다.

Kubernetes 정책은 사용자가 제공한 AGENTS의 read-only, clab-cluster 예외, other-target approval, headless/subagent deny를 유지한다. 실제 Kubernetes hook 소스/배포는 미검증이다.
