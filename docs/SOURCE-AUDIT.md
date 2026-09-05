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

## clab-mem (정본 메모리)

`~/.omp/agent/mcp.json`: 서버 `clab-mem` = `bun run <clab-mem checkout>/mcp/server.ts`. OMP는 MCP 도구를 `mcp__<server>_<tool>`로 노출하며 이 세션의 라우트 목록이 `mcp__clab_mem_mem_read` 등을 그대로 보인다.

`mcp/server.ts` 도구 정의: `mem_task_start`(key find-or-create; 기존 키에는 `재개` 절 append), `mem_task_note`(append, key 없으면 실패), `mem_task_complete`(read-back 검증), `mem_supersede`(배너 + `폐기` 절 append), `mem_task_read`, `mem_task_lookup`, `mem_search`, `mem_read`, `mem_status`, 그리고 이번에 추가한 `mem_publish`. 읽기 다섯 개가 `memoryReadTools`, 쓰기 네 개가 `memoryWriteTools`, `mem_publish`가 `memoryPublishTool`이다. **쓰기 네 개 전부 문서 RMW append**다 — `start`도 `supersede`도 멱등이 아니다.

이번 변경(clab-mem `mcp/commit.ts`, `mcp/receipt.ts`, `mcp/server.ts`): Utopia ingest에 조건부 갱신이 없고(`references/utopia-api.md`: `{filename, content, external_id, doc_time}`뿐) 청크는 비동기이며 로컬 캐시는 기계 단위 파일이다. 그래서 (1) 쓰기마다 `idempotency_key` 필수, 절에 `<!-- idem: … -->` 마커, 바탕에 마커가 있으면 `duplicate`; (2) `~/.clab-mem/locks/write-lock.sqlite`의 `BEGIN IMMEDIATE`로 같은 기계 직렬화(커널이 프로세스 사망 시 해제; 파일 lock 토큰 방식은 해제 TOCTOU 때문에 폐기); (3) 바탕은 캐시 sha == 문서 행 sha일 때만 캐시, 아니면 `ready` 대기 후 청크 복원을 `render(parse(·))`로 정규화해 그 sha가 행 sha와 같을 때만(실측 80건 중 79건; 어긋나면 쓰지 않고 오류); (4) 민 뒤 행 sha 재확인, 덮어쓰였으면 마커 확인 후 재적용(최대 4회, 실패는 오류); (5) 결과 첫 줄에 Ed25519 서명 receipt(`~/.clab-mem/receipt-signing.key`, `bun mcp/receipt.ts`로 생성). curl exit 6/7/35에만 `outcome=not_sent`, 그것도 push가 하나도 돌아오지 않은 커밋에만(typed `NotSentError`). `mem_publish`는 기존 문서가 이 후보의 마커·payload hash를 갖지 않으면 duplicate 판정 전에 거부.

`skill://clab-mem`: append-only, `mem_task_complete`는 2xx를 성공 근거로 삼지 않음, 임베딩 지연이 파이프라인을 멈출 수 있음(실측). `references/transport.md`: 이 맥에서 bun/node/python은 `mem.clab.one`에 TCP 연결 불가, 전송은 `/usr/bin/curl` — 런타임이 전송을 소유할 수 없는 결정적 이유. 스킬 문서(`~/.omp/agent/skills/clab-mem/SKILL.md`)는 아직 `idempotency_key`·`mem_publish`·receipt를 모른다 — 이 저장소는 `~/.omp/agent/*`를 수정하지 않으므로 운영자 갱신 항목이다.

이 세션에서 `mem_search`·`mem_task_lookup`은 정상 응답했다(`hits=10 embedding=Qwen3-Embedding-0.6B-8bit`, `docs=1085`). 이 저장소에 대한 기록은 0건이었고, 작업 기록 `agi-runtime-autonomy-cutover`를 시작했다.

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
