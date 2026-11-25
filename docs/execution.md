# 검증 실행 기록

## 최종 통합 제출 사례

[공개 MCP PR #9](https://github.com/jtlim/whatap-open-mcp/pull/9)는 당시 Harness `submission`을 새 환경에 복제해 설치, 기준·후보 MCP 검수, 실제 Codex 답변의 독립 검증, 보고서 생성과 PR 제출까지 완료한 사례입니다. 승인된 비식별 비교표와 MCP·AI 답변의 개별 판정이 PR 본문에 있습니다.

| 근거 | 결과 |
| --- | --- |
| Harness | `9ef17963e5128710651a8cc2ea428004fb98b849`, 회귀 테스트 38/38 PASS |
| 기준 MCP | `c1001155538114e811e8ecf311904723aa131115`, 실행 `2026-11-25T12-20-52-177Z-PLoZS7`, 실데이터 6/9 PASS, 단위·회귀 테스트 147/147 PASS |
| 후보 MCP | `89427a9533cc87aa2a15f60880c5c2a0c4aef4ad`, 실행 `2026-11-25T12-23-13-742Z-BGkWbX`, 실데이터 9/9 PASS, 단위·회귀 테스트 154/154 PASS |
| 실제 AI 답변 | `ai-cpu-7tzZy0`, MCP PASS 및 AI 답변 PASS. 조회 조건, 표본 수, 평균·최대 CPU가 독립 HTTP 대조를 통과 |

표의 Harness SHA는 **실제 실행 커밋**입니다. 문서 보완을 포함한 제출 버전의 SHA는 [Harness `submission` 이력](https://github.com/jtlim/whatap-harness-v2/commits/submission/)에서 확인합니다.

기준은 서버·트랜잭션·예외 고정 구간 3건을 거부했습니다. 이 실행의 기준 상대 시계열은 통과했습니다. 후보는 같은 고정 구간을 통과했고, 별도 합성 stdio 실험에서 MXQL과 직접 PromQL의 밀리초 경계 보존을 확인했습니다. 실제 CPU 답변은 현재 Codex가 MCP 행만 보고 생성했으며, 답변 저장 이후 독립 HTTP를 조회했습니다. 자유 형식 답변과 PromQL 실서비스 값은 범위 밖입니다.

통합 상세 보고서는 실행 환경의 `runs/setup/review-final/report.md`에 있습니다. AI 답변과 비교 원본은 `runs/ai-cpu-7tzZy0/report.md`와 `report.json`을 확인합니다. 이 파일들은 Git에서 제외됩니다. 공개 근거는 PR 본문에서 확인할 수 있습니다. 새 환경에서는 [전체 검수와 후보 제출 순서](usage.md#후보-확정과-제출-순서)를 따릅니다.

## 실패 처리 근거

| 구분 | 사례와 결과 | 근거 |
| --- | --- | --- |
| 실제 실데이터 검증 실패 | 위 통합 실행의 기준 MCP가 고정 구간 세 건을 거부해 `VALIDATION_FAILED`로 기록했습니다. 독립 HTTP는 같은 구간에서 정상 응답했습니다. | [PR #9 전후 판정과 대조 근거](https://github.com/jtlim/whatap-open-mcp/pull/9) |
| 실제 AI 시작 실패 · 초기 진단 | 당시 `--agent-smoke`에서 읽기 전용 파일 시스템으로 Codex가 시작하지 못해 `AI_FAILED`로 종료됐습니다. | [비식별 실행 기록](examples/agent-start-failure.json) |
| 실제 검증 불가 · 초기 사전 점검 | 토큰이 주입되지 않아 데모 조회 전에 `UNVERIFIABLE`로 종료됐습니다. | [비식별 실행 기록](examples/full-preflight-blocked.json) |
| 통제된 AI 실행 실패 | 하위 프로세스에 종료 코드 17을 주입해 `AI_FAILED` 분류와 사유 기록을 확인한 당시의 진단입니다. | [비식별 실행 기록](examples/controlled-failure.json) |
| 통제된 비교·실행 검사 | 독립 기준 격자가 불완전하면 `UNVERIFIABLE`로 판정합니다. 응답 오류, 시간 초과, 하위 프로세스 종료와 보고서의 증거 조건을 회귀 테스트로 확인합니다. | [MCP 비교](../test/probe.test.js) · [AI 답변 비교](../test/ai-answer.test.js) · [프로세스 통제](../test/process.test.js) · [보고서 검사](../test/review.test.js) |

현재 실행의 실패 사유는 로컬 `report.md`와 `report.json`에서 확인합니다. 비교 배치에는 시간 제한을 적용하고, 실패한 후보는 원인을 확인한 뒤 같은 입력으로 재검증합니다. [실행 한도와 통제](architecture.md#실행-한도와-통제) · [실패 확인과 재시도](usage.md#실패-확인-및-재시도)
