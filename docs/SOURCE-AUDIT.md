# Source audit and evidence boundaries

정책 개정의 기준 commit은 `da7a671c63dbf62c672a4189a0001a4716866c47`이다. runtime 실행 코드는 이 개정에서 변경하지 않는다. 설치된 호스트의 최신 상태는 별도 확인 대상이며 과거 로컬 실행 기록을 현재 관측으로 바꾸어 서술하지 않는다.

## Runtime과 integration

| 근거 | 확인하는 계약 |
|---|---|
| [extension/index.mjs](../extension/index.mjs) | native events, 선택적 runtime tools, 강제 continuation 부재 |
| [src/context.mjs](../src/context.mjs) | 정상 projection 생략, 예외 상태의 bounded JSON |
| [src/contracts.mjs](../src/contracts.mjs) | 고정 intelligence identity와 read/derived-effect 분류 |
| [src/kernel.mjs](../src/kernel.mjs), [src/journal.mjs](../src/journal.mjs) | correlation, uncertainty, read-back, durable observation |
| [src/memory.mjs](../src/memory.mjs) | native Sharpshooter bank의 읽기 전용 관측 |
| [intelligence-tools.json](../evidence/intelligence-tools.json) | 기록된 `code_intel` schema; 현재 설치의 tools/list를 대신하지 않음 |
| [VERIFICATION.md](VERIFICATION.md) | 기존 macOS/OMP 실행 결과와 미검증 범위 |
| [source-pins.json](../source-pins.json) | 기존 integration 소스 pin |

기록된 intelligence schema에서 `root` 생략 시 process cwd가 기본이다. 정책은 실제 프로젝트의 canonical absolute root를 명시하게 한다. `diagnostics`의 query/symbol 추가 요구는 기존 server 검증 기록에 따른 것이며, 새 버전에서는 실제 등록 schema와 server validation을 우선한다.

## OMP의 정책 로딩

[OMP 18.1.11 rulebook pipeline](https://github.com/can1357/oh-my-pi/blob/v18.1.11/docs/rulebook-matching-pipeline.md)은 다음을 명시한다.

- description-only rule은 이름/설명이 prompt에 노출되고 본문은 `rule://`로 읽는다. 본문 상시 주입에는 `alwaysApply`가 필요하다.
- `agents`는 session별 노출 필터다. rule 내용으로 도구 write 권한이 강제되는 것은 아니다.
- 이름 기반 discovery 우선순위 때문에 같은 이름의 다른 파일이 host rule을 가릴 수 있다.

따라서 기존 rules 본문 전체가 항상 로드된다고 가정하지 않는다. 이번 정리는 AGENTS의 중복을 줄이고 기존 rulebook을 활용하며 새 router나 enforcement loop를 추가하지 않는다.

[Native agent loop](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/agent/src/agent-loop.ts)가 실행 지속을 소유한다. [Sharpshooter backend](https://github.com/can1357/oh-my-pi/blob/v18.1.11/packages/coding-agent/src/sharpshooter/backend.ts)가 사용자 결정 추출과 native injection을 소유한다. AGENTS가 새 소유자를 만들지 않는다.

## 정책 설계 근거와 검증 한계

[OpenAI의 skills/prompts 재검토 글](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)은 좁은 사용 조건, progressive disclosure와 명확한 완료 조건을 권한다. 이는 정책 정리의 근거이지 모델의 안전성이나 성공률 보장이 아니다. 모델명에 따라 runtime 분기를 추가하지 않는다.

정적 문서 검증은 실제 모델의 lazy-intel 사용을 증명하지 않는다. 이번 변경의 검증 범위와 자연어 평가 기준은 [POLICY-VALIDATION.md](POLICY-VALIDATION.md)에 별도로 둔다. 과거 실모델 evidence와 기존 test source는 그대로 보존한다.
