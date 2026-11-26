# 실행 예시와 실패 기록

## 실제 PR 결과물

[MCP PR #9](https://github.com/jtlim/whatap-open-mcp/pull/9)는 이전 Harness에서 별도 기준·후보 MCP의 검수 결과와 구조화 AI 답변 대조를 한 PR에 담은 예시입니다. 본문 상단에서 변경 전후 판정과 반영 근거를 확인하고, 시나리오별 상세 비교표와 테스트·재현 절차를 펼쳐 볼 수 있습니다. 기준과 후보는 같은 고정 구간을 사용했으며 상대 조회는 각 MCP 결과의 Period를 기준으로 비교했습니다.

이 사례의 로컬 원본은 실행 환경에 보관됩니다. 새 환경에서 같은 유형의 결과물을 만들려면 [직접 검증](usage.md#직접-검증)과 [보고서 생성](reporting.md#codex의-보고서-생성)을 따릅니다.

## 실패 처리 근거

[기준 빌드 예제](examples/baseline-build.json)에서 레거시 `--build-only` 결과의 빌드·테스트·stdio 검사 기록을 볼 수 있습니다. 이 모드는 일반 검수와 별도의 진단 경로입니다.

| 구분 | 사례와 결과 | 근거 |
| --- | --- | --- |
| 이전 버전의 고정 기간 사례 | 예시 PR의 기준 MCP가 고정 구간 세 건을 거부해 `VALIDATION_FAILED`로 기록했습니다. 독립 HTTP는 같은 구간에서 정상 응답했습니다. 현재 기본 배치는 기준 MCP의 상대시간 계약을 검증합니다. | [PR #9 전후 판정과 대조 근거](https://github.com/jtlim/whatap-open-mcp/pull/9) |
| 실제 AI 시작 실패 · 초기 진단 | 당시 `--agent-smoke`에서 읽기 전용 파일 시스템으로 Codex가 시작하지 못해 `AI_FAILED`로 종료됐습니다. | [비식별 실행 기록](examples/agent-start-failure.json) |
| 실제 검증 불가 · 초기 사전 점검 | 토큰이 주입되지 않아 데모 조회 전에 `UNVERIFIABLE`로 종료됐습니다. | [비식별 실행 기록](examples/full-preflight-blocked.json) |
| 통제된 AI 실행 실패 | 하위 프로세스에 종료 코드 17을 주입해 `AI_FAILED` 분류와 사유 기록을 확인한 당시의 진단입니다. | [비식별 실행 기록](examples/controlled-failure.json) |
| 통제된 비교·실행 검사 | 독립 기준 격자가 불완전하면 `UNVERIFIABLE`로 판정합니다. 응답 오류, 시간 초과, 하위 프로세스 종료와 보고서의 증거 조건을 회귀 테스트로 확인합니다. | [MCP 비교](../test/probe.test.js) · [AI 답변 비교](../test/ai-answer.test.js) · [프로세스 통제](../test/process.test.js) · [보고서 검사](../test/review.test.js) |

현재 실행의 실패 사유는 로컬 `report.md`와 `report.json`에서 확인합니다. 비교 배치에는 시간 제한을 적용하고, 실패한 후보는 원인을 확인한 뒤 같은 입력으로 재검증합니다. [실행 한도와 통제](architecture.md#실행-한도와-통제) · [실패 확인과 재시도](usage.md#실패-확인-및-재시도)
