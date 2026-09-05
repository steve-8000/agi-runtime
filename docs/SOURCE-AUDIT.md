# 소스 근거

검토일: 2026-09-05. 설치본은 Homebrew `omp/18.1.10`(컴파일 바이너리, `/opt/homebrew/Cellar/omp/18.1.10/bin/omp`, formula는 GitHub release 자산). 소스는 태그 `v18.1.10` = `f241301c83726afe75a847e919b89977a54dafbe`에서 파일 단위로 읽었다. 전체 clone·빌드는 하지 않았다.

## OMP 확장 계약 (v18.1.10)

| 파일 | 확인한 내용 | 반영 |
|---|---|---|
| `packages/coding-agent/src/extensibility/extensions/wrapper.ts` L184-250, 348-417 | `tool_call`은 agent loop가 arg-prep 시점에 emit하고 wrapper는 loop가 보지 못한 디스패치(중첩 `xd://`, 직접 실행)에서만 emit. 승인 게이트는 수정된 `effectiveParams`에 대해 resolve. `tool.execute` 예외는 `isError:true` 결과로 변환되어 `tool_result`로 전달. `tool_result` 핸들러는 확장 순서로 실행되며 이전 수정을 본다 | 커널 `intent/settle` 매핑. throw와 isError를 구분하지 않음 |
| `extensibility/extensions/types.ts` L795-820 | `ToolExecutionStartEvent{toolCallId,toolName,args}`, `ToolExecutionEndEvent{toolCallId,toolName,result,isError}` | `revise`, 최종 `settle` |
| `extensibility/shared-events.ts` L310-345 | `ToolCallEventResult{block,reason,input}`: 여러 핸들러가 `input`을 주면 마지막이 이기고 서로의 수정을 보지 못함; `computer`에는 미적용 | `tool_execution_start.args`로 실제 입력 재확인 |
| `types.ts` L455-523 | `ExtensionContext`: `ui, hasUI, cwd, sessionManager, abort, setInterval/setTimeout/clearTimer, invokeTool?` | probe 대상 멤버 |
| `types.ts` L1218-1230 | `ExtensionAPI.pi: typeof PiCodingAgent`, `zod`, `logger` | `pi.pi.VERSION`, `pi.pi.getAgentDir()` |
| `packages/coding-agent/src/index.ts` L10 | `export { getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils"` | 버전·agent dir 획득 |
| `omp://extension-loading.md` | user root `~/.omp/agent/extensions`, 한 단계 스캔, 디렉터리의 `package.json#omp.extensions`, symlink 허용, `?mtime` 캐시 버스터가 상대 import 그래프에 전파 | symlink 설치, `.mjs` 소스 relative import |
| `omp://extensions.md` | `ctx.setInterval` 격리 타이머; `tool_result` middleware; 서브에이전트는 자체 확장을 로드하지 않음(파일 fallback 절) | 하트비트, 정책 범위 |
| `types.ts` L692-698 | `ToolInfo{name,description,parameters,promptGuidelines,sourceInfo}` — 승인 tier 없음 | 이름 표 기반 분류 |

### 라이브에서만 확인된 사실

`omp -p … -e extension/index.ts`(OMP_RUNTIME_REQUIRED=1)에서 모델이 `write({path:"xd://runtime_status"})`를 호출했다. 관측: `intents 4 / starts 3 / results 4 / ends 3`. 중첩 디스패치는 외부와 **같은 toolCallId**, 다른 toolName, 자체 `tool_execution_start/end` 없음. 초기 구현(toolCallId 키)은 외부 `write` 행을 `executing`으로 남겼다. 키를 `(toolCallId, toolName)`으로 바꾸고 `tests/kernel.test.mjs`에 회귀를 남겼다. 수정 후 재실행: 네 행 모두 `succeeded`.

## gbrain (정본 메모리)

`~/.omp/agent/mcp.json`: 서버 `gbrain` = `https://gbrain.clab.one/mcp`(Streamable HTTP, bearer는 0600 파일에서 읽는 헤더 명령). OMP는 MCP 도구를 `mcp__<server>_<tool>`로 노출하므로 라우트는 `mcp__gbrain_*`다.

서버가 노출하는 표면은 메모리 verb 7개다: `recall`, `entity`, `context_pack`, `delta`, `synthesize`(읽기), `remember`, `forget`(쓰기). `remember`는 사실 하나에 `provenance`를 필수로 받고 `{id, status}`(`inserted|duplicate|superseded`)를 돌려준다. 중복 판정은 임베딩 유사도이고 **서버가 강제하는 멱등 키는 없다** — 같은 사실을 다른 문구로 다시 쓰면 두 번 들어갈 수 있다. 그래서 이 런타임은 결과 본문으로 저널 상태를 바꾸지 않고, 오류를 `unknown`으로 두고 read-back attestation만 해소로 인정한다.

`forget(id)`는 멱등이며 만료 이력을 남긴다. `recall`은 질의로 코퍼스를 조망하고 `entity`/`context_pack`은 아는 대상을 답한다 — 게이트가 이 구분을 쓴다(조망만 하고 아무 것도 읽지 않으면 `recall.shallow`).

읽기·쓰기 목록은 config에서 정확한 이름으로만 분류한다. 한 이름이 두 목록에 동시에 있으면 attach가 거절된다(`INVALID_TOOL_ALLOWLIST`): 두 부류의 게이트가 다르기 때문이다.

## zvec-grep

`~/.omp/agent/mcp.json`: 서버 `zvec-grep` = `zg server --stdio`. 도구 이름 `mcp__zvec_grep_search`. MCP 서버 지침(시스템 프롬프트): `query/queries/fts/vector`, `fuse`, 절대 `root`, index 생성은 사용자 승인 필요. 커널은 입력을 **수정하지 않는다** — `limit`, `autoUpdate`, `hidden/noIgnore/follow`, query group 수, `root`(`--add-dir` 같은 정당한 다중 root 포함)는 모두 모델이 보낸 그대로 실행되고 `READ_TOOLS`의 read로 저널에만 남는다. freshness·update·query semantics는 zvec 서버 지침이 담당한다. 이전 pin(`52653951`) 검토 내용은 유지된다.

## 첨부 설정 검토

`~/.omp/agent/config.yml`(2026-09-05): `tools.approvalMode: yolo`, `memory.backend: off`, `autolearn` off, `task.disabledAgents: [librarian, sonic, task, security-reviewer]`, 모델 역할 Opus default/plan, Luna scout/advisor/smol, Grok reviewer. 이 계층은 어느 것도 바꾸지 않는다. 원본 파일은 공개 저장소에 포함하지 않는다.

`~/.omp/agent/extensions/kubernetes-approval.ts`: 실행 도구만 검사, clab-cluster 명시 시 면제, headless 차단, 작업당 1회 승인. 이 계층의 `headlessEffects` 기본은 이 확장이 k8s를 이미 fail-closed 한다는 사실에 기댄다.

## 원본 링크

```text
https://github.com/can1357/oh-my-pi/tree/v18.1.10
https://raw.githubusercontent.com/can1357/oh-my-pi/v18.1.10/packages/coding-agent/src/extensibility/extensions/wrapper.ts
https://raw.githubusercontent.com/can1357/oh-my-pi/v18.1.10/packages/coding-agent/src/extensibility/extensions/types.ts
https://raw.githubusercontent.com/can1357/oh-my-pi/v18.1.10/packages/coding-agent/src/extensibility/shared-events.ts
https://raw.githubusercontent.com/can1357/oh-my-pi/v18.1.10/packages/coding-agent/src/index.ts
https://github.com/can1357/oh-my-pi/releases/download/v18.1.10/omp-darwin-arm64   (sha256 f93613f5…, formula)
```
