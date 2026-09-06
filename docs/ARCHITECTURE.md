# OMP Native Autonomous Runtime 0.3

기준: 2026-09-06. `steve-8000/agi-runtime`의 검토 기준은 `580f0e52b67769acc3642053f167eaaf60d2c7ad`. 이 디렉터리는 원격 저장소에 적용하지 않은 replacement candidate다. 기존 기능을 모두 포팅한 fork가 아니라, 책임을 줄여 다시 구현한 경량 extension이다. AGI 능력이나 완전 무인 운영을 증명한 명칭이 아니다.

## 1. 결정

**판단과 실행 순서는 OMP, 코드 발견은 zvec, 장기 지식은 gbrain, 실행 관측과 복구 안내는 extension이 소유한다.**

```
User goal + existing permissions
             |
       OMP native loop
       Main sole writer
         |         | read-only evidence
         |         +-- Scout / Advisor / Reviewer
         |             generic task agent disabled
         |
         +-- zvec-grep: unknown semantic/cross-file discovery
         +-- native read/rg/LSP: exact source verification
         +-- gbrain MCP: recall/entity/context_pack/delta/remember/forget
         +-- existing tools + existing Kubernetes approval hook
                    |
           OMP public events
                    |
        one local runtime extension
        journal -> outcome aggregation -> recovery hints
                    |
          fresh request-only context
```

OMP의 `task` dispatch 도구와 이름이 `task`인 범용 worker는 다르다. worker는 비활성으로 유지하고, Scout/Reviewer를 부르는 기존 dispatch 경로까지 제거하지 않는다. 모델 이름은 이 패키지에 고정하지 않는다. 기존 OMP modelRoles를 그대로 사용한다.

새 planner, supervisor agent, memory agent, vector database, retrieval proxy, MCP client, scheduler, message queue를 만들지 않는다. extension은 모델 API, gbrain, zvec에 직접 네트워크 요청을 하지 않는다. 모델이 이미 노출된 OMP 도구를 호출한다.

## 2. 자율성의 범위

정상적인 조사, 구현, 빌드, 테스트, 수정, 메모리 읽기와 기록은 사용자 확인 없이 진행한다. 이 extension은 승인 대화상자, 회상 의무 게이트, 실행 횟수/효과 횟수/벽시계 예산, 기억 갱신 승인, 완료 검증 에이전트를 추가하지 않는다. 사용자가 중지하거나 pause한 상태는 자동으로 해제하지 않는다.

초기 목표와 유효한 도구 연결/권한은 전제다. 권한 없는 API, 고장 난 외부 서비스, 삭제된 증거에서 사실을 만들어내지 않는다. 해결할 수 없는 개별 작업은 자동으로 보류하고 영향을 받지 않는 작업을 계속한다. 이 보류는 사용자가 `/runtime renew`를 눌러야 풀리는 절차가 아니다.

**Kubernetes 정책은 기존 것 그대로다.** read-only inspection은 허용. `clab-cluster`의 기존 일반 변경 예외 유지. 다른 대상의 Kubernetes/GitOps 변경은 기존 point-of-action 승인이 필요. headless/subagent K8s mutation은 대상과 무관하게 기존 fail-closed를 유지한다. 기존 고위험/credential/financial/production 범위 보호도 약화하지 않는다. 이 패키지는 명령 문자열을 파싱해 Kubernetes를 재구현하지 않으며 기존 hook을 덮어쓰거나 `allow`로 우회하지 않는다.

실제 `kubernetes-approval.ts`와 OMP 실행 환경은 이 컨테이너에서 읽거나 실행하지 못했다. 보존하는 설계와 mock 비간섭 검사는 실제 배포 보안 보증과 다르다.

## 3. 모듈과 정본

| 소유자 | 정본 또는 책임 | 소유하지 않는 것 |
|---|---|---|
| OMP | 사용자 목표, 모델 선택, 대화/compaction, 도구 실행, 역할 선택 | 별도 runtime 정책 엔진 |
| Working tree / 실제 외부 시스템 | 현재 파일과 외부 상태 | 모델의 기억 |
| zvec-grep | 재생성 가능한 검색 인덱스와 freshness | 승인/완료 여부 |
| gbrain | 출처가 있는 장기 사실과 결정 | 실행 중 action의 확정 여부 |
| SQLite journal | 관측한 호출, 결과, 원본 세션 참조, 불명 상태 | 외부 세계의 exactly-once 보증 |

`src/contracts.mjs`는 도구 identity와 작은 outcome reducer, `src/journal.mjs`는 로컬 원장, `src/kernel.mjs`는 이벤트 연결/복구, `src/context.mjs`는 요청용 projection, `extension/index.mjs`는 OMP adapter다. 기존 `evidence`와 dual SQLite adapter는 재사용한다. 새 production dependency는 없다.

## 4. 실행을 막는 것과 막지 않는 것

정상 개발 호출에는 재검증 모델이나 추가 I/O probe를 넣지 않는다. 기록에 필요한 SQLite 작업만 수행한다.

- zvec 미호출, gbrain 미회상, checkpoint 부재, 작업 시간/횟수는 차단 사유가 아니다.
- `hub`, `yield`, `advise`, `goal`, native dispatch, runtime 상태/복구 도구는 회상/불명 이력으로 잠그지 않는다. 기존 호스트 권한까지 우회하는 의미가 아니다.
- 같은 logical call을 재디스패치하는 경우는 원장에 기록하고 거절한다. 새로운 ID의 동일 내용까지 의미적으로 중복 판정하지 않는다.
- 코드/불투명 로컬 명령의 불명 이력은 최신 상태를 읽으라는 안내다. **workspace 전체를 잠그지 않는다.** 읽고 판단하는 책임은 Main에 있다.
- 결과가 불명인 gbrain 쓰기는 새 gbrain 쓰기를 보류한다. 기억을 다시 읽어 결과를 확인하거나, 확인 불가능하면 기록을 미룬다. 코드 수정과 검색은 계속된다.
- gbrain 쓰기에 명백한 credential 패턴이나 명시적으로 인용한 오래된 evidence가 있으면 해당 요청만 거절한다. 패턴 검사는 완전한 DLP가 아니다. 수정/다른 실제 근거를 사용해 에이전트가 해결한다.

이 설계는 임의 shell의 의미를 추론해서 모든 외부 POST를 dedupe하지 않는다. 네트워크를 건드리는 명령의 nonzero exit는 ‘도구가 오류를 보고했다’는 관측이지 ‘외부 효과가 없었다’는 증명이 아니다.

## 5. 이벤트 정산과 중첩 호출

`tool_call`은 intent snapshot이고 `tool_execution_start`는 제공되는 경로에서 실행 입력을 관측한다. `tool_result`는 middleware 결과이므로 원시 결과라고 부르지 않는다. `tool_execution_end`는 제공되는 경로의 후속 결과다.

한 호출은 여러 관측을 가질 수 있다. local failure는 나중 성공으로 지워지지 않는다. result/end 오류 또는 exit code가 충돌하면 conflict를 기록한다. 시작 이벤트를 보았으면 end 전에는 성공으로 확정하지 않는다. result-only 호출은 `includes-result-only`라는 관측 품질로 구분한다.

`write(xd://memory-tool)`와 같은 ID의 실제 memory-tool 호출은 **한 logical action / 두 wire observations**다. scope와 결과는 실제 도구 기준으로 통합한다. ID가 다르거나 서로 관계없는 같은 payload는 합치지 않는다. timeout은 불명 action 하나로 남는다. 원문 명령을 원장에 복사하지 않고 session ID, toolCallId, wire tool, 가능한 경우 OMP session file을 참조한다.

알려진 memory write는 host 오류, 인식 불가능한 ack 또는 입력 변경 시 unknown이다. 성공 ack도 ‘관측된 성공’이며 암호학적 영수증이나 독립적 외부 증명이 아니다. protocol v1의 상태 필드를 해석하되 답변 본문의 지시문을 실행하지 않는다.

## 6. 사람 없이 복구하는 경로

### 원장 정상, memory write 불명

에이전트가 `runtime_status`로 action과 원본 참조를 보고, gbrain의 확인된 entity/record를 읽는다. 조회 자체가 성공했다는 것과 대상 사실의 존재/부재는 다르다. 유사도 검색에서 안 보였다는 이유만으로 미기록을 확정하지 않는다.

결과를 확인했으면 `runtime_reconcile(actionIds, readbackIds, observed)`로 명시한 action만 닫는다. 원장은 해당 unknown 이후에 관측한 성공 읽기 ID를 확인한다. 메모리 action은 메모리 읽기를 참조해야 한다. 이 검사는 읽기가 실제로 있었는지에 대한 작은 구조 검사이며 의미적 증명 엔진이 아니다. 에이전트 attestation임을 결과와 event에 남긴다. 확인할 수 없으면 unknown을 유지하고 메모리 쓰기만 미룬다. `all` shortcut이나 관측 없는 성공 승격은 없다.

### SQLite 장애 / lease 상실

한 번의 load-bearing I/O 실패 후 닫힌 DB에 매 호출 재접속하지 않는다. 상태를 degraded로 바꾸고 원장 보장을 주장하지 않는다. 일반 소스 작업은 통과시키며 gbrain 쓰기는 기록이 복구될 때까지 미룬다. 기존 OMP managed timer에서 재열기/lease 획득을 재시도한다. 5초 heartbeat, 30초 lease, 실패 뒤 10초 재시도 간격은 소유권/접속 관리이지 세션 실행 예산이 아니다. 타이머는 새 모델 턴을 만들지 않는다.

회복하면 기존 원장을 다시 읽고 불명 상태를 제시한다. action을 자동 재전송하지 않는다. 영구 디스크 장애에서는 진짜 durable checkpoint를 만들어낼 수 없으며 그 사실을 표시한다.

### 프로세스 종료

OMP의 JSONL 세션과 원장은 남는다. **프로세스 재기동 자체는 이 extension의 기능이 아니다.** OMP process가 죽으면 in-process timer도 죽는다. 기존 OS/process supervisor가 있다면 OMP의 같은 세션 재개를 담당하게 한다. 이 패키지는 검증되지 않은 `--goal`/`--session` 옵션이나 무조건적인 재실행 스크립트를 추가하지 않는다. 프로세스 자동 재기동까지 포함한 무인 운영은 해당 host에서 별도 확인해야 하며 이번 패키지에서 완료했다고 주장하지 않는다.

## 7. 지식 활용은 강하게, 절차 강제는 약하게

zvec은 위치가 불명확한 코드 기능/관계/흐름 탐색의 첫 선택이다. 정확한 문자열과 모든 occurrence는 native 경로로, 중요한 hit는 원문으로 확인한다. runtime은 `limit`, `autoUpdate`, `hidden`, `follow`, `freshness`를 덮어쓰지 않는다. ‘read’ 분류는 사용자 코드 변경이 아니라는 의미이며 인덱스 갱신/embedding 호출이 전혀 없다는 뜻이 아니다.

gbrain은 기존 MCP의 MEMORY_VERBS v1을 사용한다. `recall`/`entity`는 필요한 이전 결정, `context_pack`은 알려진 관련 entity의 cold start/compaction 복구, `delta`는 확인된 cursor 이후 변경에 사용한다. `synthesize`는 매 턴 넣지 않는다. 사실은 `remember`에 provenance와 entity를 붙여 자연스러운 결정/해결 경계에 기록한다. 모든 tool call을 기억으로 만들지 않는다.

출력 packing인 gbrain `budget_tokens`와 context 크기 제한은 실행 예산과 다르다. 요청이 오래되었다고 일을 중지하지 않고, 응답의 dropped/has_more를 보고 필요한 내용을 점진적으로 더 읽는다. 모델이 쓸 MCP schema가 실제 API 계약이고 이 패키지는 스키마를 복제하지 않는다.

## 8. 컨텍스트 계약

`before_agent_start`와 모델 호출 1회는 동일한 개념이 아니다. 이전 설명의 ‘매 모델 호출마다 before_agent_start’ 가정은 폐기한다.

이 구현은 OMP `context`에서 detached messages를 받아 **요청용 최신 projection 하나**를 만든다. 자체 과거 runtime 메시지만 제거하고 다른 extension 정책, user, tool 결과, OMP 원본 기록은 변경하지 않는다. 이 메시지를 native history에 append하지 않는다.

평상시에는 짧은 search/memory routing만 남긴다. usage/discovery 수치, goal mirror, unchanged checkpoint는 넣지 않는다. resume/compaction 때만 짧은 checkpoint를 한 모델 round에 제공하고, unknown/degraded/pause는 존재하는 동안 필요한 최소 내용만 제공한다. 상세 이력은 `runtime_status`로 읽는다.

정상 payload 실측 317바이트, 큰 resume+unknown 예시 2,296바이트. 최대 4,096바이트 출력 packing. 1,000번 projection 생성 후 own message 수는 하나다. provider별 tokenizer/token 비용과 cache hit는 측정하지 않았다. 새 토큰 누적이 없다는 것은 매 요청에서 공짜라는 뜻이 아니다.

## 9. 장기 유지 기준

미래 모델의 성능을 예측해 이름이나 effort를 코드에 고정하지 않는다. 모델이 바뀌면 OMP modelRoles만 바꾼다. 요청 의미는 모델, 프로토콜 parsing과 durability는 코드라는 경계를 유지한다.

OMP public event contract, gbrain protocol v1, zvec live schema에 의존한다. 작은 adapter와 deterministic contract tests만 업데이트한다. 호환성을 검사하는 것은 모든 미래 버전에서 동작한다고 보장하는 것과 다르다. 모든 agent 종류가 같은 events를 낸다고 가정하지 않는다.

기존 기능이 upstream에 들어오면 겹치는 extension 코드를 제거한다. 실제 실패/운영 이득이 없는 새로운 hook, 설정, daemon, agent, 검증 규칙은 추가하지 않는다. 완료 판정은 기존 프로젝트의 검사와 Main/Reviewer 책임이며 새로운 acceptance service는 만들지 않는다.
