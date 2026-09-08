# 소스 근거와 설계 판단

기준일 2026-09-06. GitHub connector로 버전/파일/commit을 읽었다. 전체 repository clone이나 실제 Mac 설치 검증을 수행했다고 주장하지 않는다. 아래 링크는 source reference이며 런타임에서 네트워크로 호출하는 dependency가 아니다.

## 고정 근거

| 대상 | 기준 | 확인 내용 |
|---|---|---|
| steve-8000/agi-runtime | 580f0e52b67769acc3642053f167eaaf60d2c7ad | main ref, 최신 수정 diff, source-pins, evidence primitive, 기존 설계/검토 이력 |
| can1357/oh-my-pi | v18.1.11 | 최신 release 확인, extension event/public API, custom message/session 저장, CLI args |
| zvec-ai/zvec-grep | 52653951b24617762f4ab0c71c34d594e5001617 | 최신 commit, MCP search/freshness 계약(기존 source 검토 포함) |
| OMP Sharpshooter backend | v18.1.11 설치 바이너리 | `sharpshooter/{paths,queue,extract,consolidate,backend}.ts`, `memory-backend/runtime.ts`, settings schema. 설치본 자체에서 직접 확인 |

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

## Sharpshooter: 무엇을 읽어도 되고 무엇을 주장하면 안 되는가

설치된 v18.1.11 바이너리에서 직접 확인한 사실만 사용한다.

- extraction과 consolidation은 `sharpshooter.model` 하나를 공유하고, effort는 코드에 `Low`/`Medium`으로 고정되어 있다. selector에 `:high`를 붙여도 Sharpshooter는 그 값을 쓰지 않는다. 미설정 시 `smol` role로 떨어진다.
- bank는 `<agentDir>/memories/sharpshooter/<bank id>/`이고 bank id는 cwd에서 파생된다. 파생식(`basename` slug + `Bun.hash`)을 재구현하지 않는다. `ctx.memory.status()`가 돌려주는 `scope`가 backend 자신이 쓰는 id이므로 그것만 사용한다.
- 큐 파일은 `queue/<sessionId>/<ts base36>-<rand>.json`이고 delta는 `v:1`이다. 파일명이 시간 순 정렬이라는 성질에만 의존한다.
- `state.json`은 `v:1`, `lastConsolidatedAt`, 선택적 `lastResult`/`lastError`다. shape이 다르면 관측을 null로 만들고 아무것도 주장하지 않는다. `lastError.message`는 backend가 `String(error)`로 저장한 provider/filesystem 원문이므로 모델 컨텍스트로 옮기지 않는다 — 고정 목록 분류값만 내보낸다.
- extraction은 evidence 문자열이 실제 사용자 프롬프트의 부분문자열일 때만 delta를 받아들이고, friction gate와 consolidation이 delta를 버릴 수 있다. 따라서 “사용자가 말했으니 기억에 남는다”는 보장은 없다. 큐에 있다는 관측을 저장 보장으로 승격하지 않는다.
- `taskDepth > 0`이면 backend가 아예 시작하지 않는다. subagent는 추출도 주입도 받지 않는다.
- backend는 `save`를 구현하지 않는다. runtime은 기억을 쓰지 않는다.

모델이 주입된 기억 텍스트를 새 instruction으로 실행하지 않는다. 주입 memory는 evidence이며 permission이 아니다.

## zvec

- https://github.com/zvec-ai/zvec-grep/blob/52653951b24617762f4ab0c71c34d594e5001617/docs/03-mcp.md
- https://github.com/zvec-ai/zvec-grep/blob/52653951b24617762f4ab0c71c34d594e5001617/src/mcp/schemas.ts

검색 호출은 논리적 read지만 인덱스 갱신이나 embedding 비용까지 없는 것은 아니다. freshness/auth/model 선택은 zvec가 소유한다. runtime은 요청 인자를 수정하지 않는다. 제공되는 실제 schema가 권위이며 aliases/MCP server 이름이 바뀌면 identity 목록만 변경한다.

## 설계 판단인 것

local unknown을 workspace 전체 차단으로 바꾸지 않는 것, known memory unknown만 쓰기 보류하는 것, request-only 4 KiB projection, optional short checkpoints, 새 dependency 없이 SQLite adapter를 재사용하는 것은 이 패키지의 판단이다. upstream이 보장하거나 모든 workload에서 최적이라고 발표한 내용이 아니다.

Kubernetes 정책은 사용자가 제공한 AGENTS의 read-only, clab-cluster 예외, other-target approval, headless/subagent deny를 유지한다. 실제 Kubernetes hook 소스/배포는 미검증이다.
