# 사용 가이드

[설치 가이드](installation.md)로 계정, Fork, 데모 권한과 로컬 설정을 준비한 뒤 **Harness 루트**에서 `codex`를 엽니다. 명령을 내리기 전에 작업 트리의 기존 변경은 보존해 달라고 요청할 수 있습니다.

## 자연어 요청 예제

아래 문장은 사용 방법을 보여 주는 예제입니다. 과제에서 실제로 수행한 실행은 [실행 기록](execution.md)에 따로 정리되어 있습니다.

| 목적 | 요청 예제 |
| --- | --- |
| 전체 검수 | “깨끗한 기준 MCP에서 서버·APM·시계열을 모두 검수하고, 재현되는 문제만 내 Fork의 PR로 제출해 줘.” |
| 특정 기능 | “APM 트랜잭션 통계와 예외 통계만 검수해 줘.” |
| 데이터 정확성 | “TPS의 Period, 5초 간격, 누락과 값을 독립 HTTP로 대조하고 변경 없이 결과만 알려 줘.” |
| 기능 개선 | “고정 UTC 구간에서 MCP가 조회를 지원하는지 확인하고, 필요하면 상대시간 호환성을 유지해 개선해 줘.” |
| 추가 수정 | “이 PR의 검토 의견을 반영하고 같은 절대 구간에서 재검증해 줘.” |

## 작업 결과에 따른 흐름

| 확인한 상황 | Codex가 하는 작업 |
| --- | --- |
| 검사 범위 내 수정 필요 없음 | 판정, 증거와 한계를 보고 |
| MCP 동작 문제 | 기준과 후보를 분리해 빌드하고 같은 기준으로 재검증한 뒤, 변경이 있는 MCP Fork에 검토용 PR 제출 |
| Harness 문제 | 동일 입력으로 변경 전후 판정 및 정책 유지 여부를 비교하고 별도의 Harness PR 제출 |
| 두 저장소에 변경 필요 | PR을 분리하고 상호 참조. MCP PR에 사용한 Harness SHA 기록 |
| 외부 API 제약·환경 실패 | 실패 원인과 범위를 기록하고 교정 가능한 조건에 한해 재시도. 데이터 부족이나 인증 오류를 MCP 결함으로 단정하지 않음 |

사용자는 GitHub에서 파일 차이, 변경별 반영 근거, 시나리오별 전후 판정 및 승인된 실제 표를 검토합니다. 추가 보완을 요청할 때는 PR URL과 문제가 된 시나리오를 지정합니다. 만족하면 GitHub에서 직접 Merge합니다. [보고서와 PR 제출](reporting.md)

## 직접 검증

`--mcp`에는 Git 체크아웃을 전달합니다. 먼저 그 디렉터리에서 `npm ci`, `npm run build`, `npm test`를 수행해 `dist/index.js`를 준비합니다. 아래 예시는 설치에서 만든 기준 체크아웃을 사용하며, 후보는 별도로 만든 깨끗한 체크아웃을 지정합니다. 검증할 때는 **Harness 루트**와 두 읽기 전용 환경변수가 있는 셸에서 실행합니다.

```bash
node verify.js --list

# 등록된 전체 시나리오
node verify.js --mcp runs/baseline --phase before

# APM 통계·오류 입력과 시계열만 검수
node verify.js --mcp runs/baseline --select apm --select timeseries --phase before
```

`--select`에는 `all`, `server`, `apm`, `timeseries`, `range` 또는 목록에 나온 시나리오 ID를 사용할 수 있고 반복 지정이 가능합니다. `range`는 잘못된 기간 입력 시나리오를 제외한 조회를 선택합니다. `--request`로 로컬 보고서에 요청 요약을 남길 수 있습니다. `--config FILE`의 기본값은 Harness 루트의 `config.local.json`입니다.

절대시간 전후 비교의 경우 종료 시각을 한 번 계산하고 두 명령에 전달합니다. 아래에서 `runs/candidate`는 빌드를 완료한 후보 체크아웃 예시입니다. 기준에서 실패 재현을 예상하는 경우 두 명령을 `&&`로 연결하지 않습니다.

```bash
fixed_end=$(node -p 'Math.floor((Date.now() - 20 * 60_000) / 300_000) * 300_000')
node verify.js --mcp runs/baseline --phase before --fixed-end "$fixed_end"
node verify.js --mcp runs/candidate --phase after --fixed-end "$fixed_end"
```

종료 값은 과거의 5분 경계 UTC Unix 밀리초입니다. 해당 시각까지의 15분을 검증합니다. 명령 옵션을 생략하면 설정의 `fixedEnd`, 둘 다 없으면 실행 시각보다 최소 20분 앞선 최신 5분 경계를 사용합니다. 상대 조회는 각 MCP가 표시한 Period로 독립 HTTP를 별도 조회합니다.

## 실패 확인 및 재시도

| 종료 코드 | 의미 | 확인 시점 |
| --- | --- | --- |
| `0` | 등록 범위 검증 통과 | 실행의 시나리오 결과와 판정 근거 확인 |
| `1` | 검증 실패 | 저장된 MCP 응답과 독립 HTTP 응답의 조건·키 대조 |
| `2` | 검증 불가 또는 환경·인증 문제 | 토큰 전달 및 프로젝트 권한, 네트워크, 시간 범위와 기준 데이터 확인 |

출력에 표시된 `runs/<실행 ID>/report.md`와 `report.json`에서 사유 코드를 확인합니다. 환경 오류는 먼저 인증, 권한 또는 네트워크 상태를 복구합니다. 독립 API가 빈 결과를 제공하거나 완전성을 확인할 수 없는 구간에서는 해당 한계를 보고합니다. Codex가 재시도 여부를 판단할 때 [시간과 승인 정책](architecture.md#실행-한도와-통제)을 따릅니다. 자료를 외부에 공유할 때는 [공개 설정](reporting.md#데이터-공개-설정)을 적용합니다.

## 기존 진단 재현

`run.js`는 과거 고정 분석과 진단 기록을 재현하기 위한 진입점입니다. **Harness 루트**에서 실행합니다.

| 명령 | 범위 |
| --- | --- |
| `node run.js --build-only --local-source runs/baseline --config config.local.json` | 격리된 기준 빌드·테스트와 stdio 오류 응답 검사. 실제 서비스 요청 없이 원본 진단을 재현 |
| `node run.js --failure-example` | 통제된 AI 실패와 보고 처리 재현. 의도적으로 실패 코드 반환 |
| `node run.js --agent-smoke` | Codex 초기화 확인. Codex CLI 인증·네트워크 필요 |
| `node run.js --legacy-full` | 고정 UTC 문제 수정의 과거 흐름. 로컬 검증 후 검토 단계에서 종료 |

일반 검수의 진입점은 Codex와 `verify.js`입니다. 레거시 진단에서 `--offline-install`을 쓸 경우 완전한 npm 캐시가 사전에 준비되어 있어야 하며, 설치 스크립트가 생략됩니다. 자세한 과거 환경 제약은 [실행 기록](execution.md)을 참고하세요.
