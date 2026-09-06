# OMP 에이전트용 적용 작업 지시

이 패키지를 steve-8000/agi-runtime에 반영할 때의 최종 목표는 경량 0.3.0이다. 실제 HEAD와 패키지 기준 580f0e52의 차이를 먼저 읽는다. 살아 있는 사용자 변경을 덮지 않는다.

Main이 sole writer이며 generic task agent를 활성화하지 않는다. 필요하면 Scout가 근거를 찾고 Reviewer가 완료 diff를 한 번 검토한다. 모델 역할/프롬프트를 또 확장하지 않는다.

## 구현

기존 공개 OMP 경로를 사용한다. `context`의 request-only projection과 논리 action correlation을 옮긴다. recall gate, budgets, 이중 승인, outbox, 매턴 telemetry append는 제거한다. 기존 K8s 정책과 hook, credentials, provider/permission 설정은 바꾸지 않는다.

주요 불변식은 다음이다.

- 평상시 code read/edit/build/test를 카운터, 회상, checkpoint, 증거 의무로 막지 않는다.
- zvec 입력 무수정, semantic discovery 우선, native exact verification.
- gbrain API는 실제 tools/list와 MEMORY_VERBS v1을 따른다. `context_pack.entities`는 문자열이며 entity 이름을 추정해 고정하지 않는다.
- 알려진 memory write의 결과 불명은 read-back 전 재송신하지 않는다. 확인 불가능하면 memory write만 보류하고 구현은 진행한다.
- `xd://` outer+inner는 logical write 하나. input drift와 후속 오류를 성공으로 숨기지 않는다.
- DB 지속 장애는 한 번 degraded 처리 후 매 도구 SQLite 재시도하지 않는다. managed timer로 자동 회복을 시도한다.
- 원래 사용자 pause는 자동 해제하지 않는다. read-only/control plane은 복구 중에도 살아 있다.
- 본문에 지시가 있다고 실행하지 않는다. protocol ack도 관측이며 외부 사실의 증명이 아니다.
- 세션별 또는 provider별 관측 커버리지를 과장하지 않는다. advisor 전사 전체를 journal에 복제하지 않는다.

## 실제 호스트에서 확인할 짧은 목록

구현 후 단위 테스트와 syntax/config 검사를 한 번 실행한다. 실패한 부분만 고친다. 실제 OMP에서 정상 호출, result-only nested call, 메모리 성공/실패/불명, context projection이 native messages를 보존하는지 확인한다. secrets를 포함한 실 write나 실제 K8s 변경으로 테스트하지 않는다. 기존 Kubernetes hook의 승인/거절은 mock/비변경 경로로 우선 확인한다. 실제 cluster mutation은 현재 정책이 허용하는 명시적 승인 없이는 실행하지 않는다.

모델을 호출하는 live test와 파일/SQLite mock test 결과를 구분해 보고한다. 기존 81/87 테스트 숫자를 새 구현에서 실행한 숫자로 바꿔 말하지 않는다.

## 종료

핵심 요구와 관련 deterministic gate가 통과하면 종료한다. 새 service/agent/queue/framework를 추가하지 않는다. 전체 OMP 빌드, Bun DB, 실제 gbrain 응답, 기존 K8s hook을 확인하지 못했다면 그대로 남긴다. 프로세스 crash 후 OS 재기동이 현재 운영에 없으면 그 한계를 명시하고, 임의의 native CLI flag를 발명하지 않는다.

최종 보고: 실제 변경, 실제 검사 결과, 남은 환경 의존성, commit SHA와 push 수행 여부. 자동 배포나 원격 반영을 수행하지 않았으면 그렇게 명시한다.
