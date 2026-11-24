# 설치 및 환경 구성

## 1. 프로그램과 권한 준비

| 항목 | 준비할 내용 |
| --- | --- |
| 실행 환경 | Linux/Ubuntu, Bash, Git, GNU coreutils, Node.js **22**와 npm. 로컬 개발은 Bash stdio 파이프를 사용합니다. |
| 네트워크 | GitHub와 npm Registry, Codex 인증·실행, 승인된 WhaTap 데모 HTTPS 주소에 대한 접근 |
| GitHub | 자신의 MCP Fork 및 Harness PR 대상 저장소에 대한 작업 브랜치 쓰기 권한 |
| 데모 환경 | 과제 제공자가 승인한 Server·APM 프로젝트의 숫자 코드와 MCP 및 독립 HTTP Client용 읽기 전용 토큰 |

**Ubuntu 터미널**에서 기본 도구를 설치합니다. Node.js 22는 공식 다운로드 페이지에서 운영체제에 맞는 설치 방법을 선택합니다. 머신의 패키지 저장소나 조직 설치 정책에서 `gh`를 제공하지 않으면 공식 설치 문서를 이용합니다. [Node.js 다운로드](https://nodejs.org/en/download) · [GitHub CLI 설치 안내](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)

```bash
sudo apt-get update
sudo apt-get install bash coreutils git gh
node --version
npm --version
git --version
gh --version
```

같은 터미널에서 Codex CLI를 설치하고 본인의 계정으로 로그인합니다. npm 전역 설치 경로는 쓰기 권한이 있는 Node.js 사용자 설치를 이용합니다. [Codex CLI](https://developers.openai.com/codex/cli) · [Codex 인증 안내](https://developers.openai.com/codex/auth)

```bash
npm install -g @openai/codex
codex --version
codex login
codex login status
```

GitHub CLI에는 PR과 브랜치 작업에 사용할 본인 계정으로 로그인합니다. 아래 절차는 HTTPS Clone을 사용합니다. [GitHub CLI 로그인](https://cli.github.com/manual/gh_auth_login)

```bash
gh auth login --hostname github.com --git-protocol https
gh auth status --hostname github.com
gh auth setup-git --hostname github.com
gh api user --jq .login
```

새 체크아웃에서 커밋이 필요할 때 Git 작성자도 설정합니다. 예를 들어 대상 체크아웃에서 `git config user.name "본인 이름"`, `git config user.email "본인 GitHub 이메일"`을 실행합니다. 작성자 설정과 GitHub 인증은 별개입니다.

## 2. MCP Fork와 Harness Clone

브라우저에서 [WhaTap MCP 원본](https://github.com/whatap/whatap-open-mcp)을 본인 계정이나 권한 있는 조직으로 Fork합니다. 원본은 기준 소스를 가져오는 데 사용하고 PR의 대상은 사용자 Fork로 지정합니다. Harness는 과제 제출 링크에 있는 저장소를 Clone합니다. Harness도 수정해 PR을 만들 예정이면 작업 브랜치 쓰기 권한이 있는 Harness 저장소나 본인 Harness Fork를 선택합니다.

**새 작업을 둘 상위 디렉터리**에서 실행합니다. URL과 Fork 이름은 본인 환경 값으로 바꿉니다. 아래의 `MCP_FORK`와 `BASE_BRANCH`는 같은 셸에서 이후 단계에도 사용합니다.

```bash
read -r -p 'Harness GitHub HTTPS clone URL: ' HARNESS_URL
read -r -p 'MCP Fork (OWNER/REPO): ' MCP_FORK
git clone "$HARNESS_URL" whatap-harness-v2
cd whatap-harness-v2
git remote get-url origin
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission
gh api "repos/$MCP_FORK" --jq '{fork, parent: .parent.full_name, canPush: .permissions.push}'
```

MCP의 `fork`가 `true`, 부모가 `whatap/whatap-open-mcp`, `canPush`가 `true`인지 확인합니다. Harness는 원격 기본 브랜치를 확인하고, 해당 저장소에 승인된 `submission`의 운영 방식이 있으면 그 브랜치를 기준으로 사용합니다. Clone 직후 `origin`이 읽기 전용이라면 설치 확인은 가능하며, Harness 코드 변경 제출 전에 쓰기 가능한 Fork가 필요합니다.

다른 지원 브랜치가 설치 기준인 경우, Harness 루트에서 `git switch "승인된-브랜치"`로 전환합니다.

## 3. MCP 기준 체크아웃과 PR 기준 브랜치

이 과제의 고정 MCP 기준은 `c1001155538114e811e8ecf311904723aa131115`입니다. **Harness 루트**에서 로컬 작업 복제본을 Git이 추적하지 않는 `runs/` 아래에 준비합니다. 아래 명령의 `baseline`은 검수용 원본이며 후보 수정은 별도 작업 브랜치와 체크아웃에서 진행합니다.

```bash
umask 077
mkdir -p runs
git clone "https://github.com/$MCP_FORK.git" runs/baseline
MCP_BASE=c1001155538114e811e8ecf311904723aa131115
git -C runs/baseline fetch https://github.com/whatap/whatap-open-mcp.git "$MCP_BASE"
git -C runs/baseline switch --detach "$MCP_BASE"
git -C runs/baseline rev-parse HEAD
```

MCP Fork에 같은 커밋을 가리키는 검토용 브랜치가 있으면 그 이름을 선택합니다. 예를 들어 기존 `submission`이 정확히 그 커밋일 때 사용할 수 있습니다. `agent`는 작업 브랜치 예시이며 필수 이름이 아닙니다. 기존 기준 브랜치가 다른 커밋을 가리키면 별도의 새 이름을 선택합니다.

```bash
read -r -p 'MCP Fork의 PR 기준 브랜치: ' BASE_BRANCH
git check-ref-format "refs/heads/$BASE_BRANCH"
git -C runs/baseline ls-remote origin "refs/heads/$BASE_BRANCH"
```

출력된 SHA를 `MCP_BASE`와 대조합니다. 브랜치가 **아직 존재하지 않고** 자신의 Fork에 과제 기준 브랜치를 마련하려면 다음 명령으로 새 브랜치를 생성하고 SHA를 다시 확인합니다. 기존 브랜치가 다른 SHA이면 그 브랜치를 덮어쓰지 말고 앞 단계에서 새 이름을 선택합니다.

```bash
git -C runs/baseline push origin "$MCP_BASE:refs/heads/$BASE_BRANCH"
git -C runs/baseline ls-remote origin "refs/heads/$BASE_BRANCH"
```

## 4. 로컬 설정과 읽기 전용 토큰

**Harness 루트**에서 설정을 최초 한 번 만듭니다. 이미 구성한 경우 기존 파일을 유지합니다.

```bash
test -f config.local.json || install -m 600 config.example.json config.local.json
```

| 계약 | 입력할 값 |
| --- | --- |
| `fork` | 실제 MCP Fork의 `OWNER/REPO`. 공식 Codex 제출 절차는 이 설정을 사용합니다. 레거시 진단은 저장소 이름이 `whatap-open-mcp`인 Fork를 기대합니다. |
| `baseBranch` | 위에서 확인한 MCP Fork의 PR 기준 브랜치 |
| `serverProject`, `apmProject` | 승인된 데모 프로젝트의 양의 정수 코드. 예시의 1과 2를 교체합니다. |
| `apiOrigin` (선택) | 승인된 데모 HTTPS Origin. 생략 시 `https://api.whatap.io` |
| `fixedEnd` (선택) | 과거 5분 경계의 Unix 밀리초. 절대시간 검증의 종료점 |

과제 제공자가 준 토큰을 비밀 저장소에서 같은 셸로 환경변수에 주입합니다. 직접 입력할 경우 아래 명령은 터미널 입력을 표시하지 않습니다. 토큰을 프롬프트, 설정 JSON, Git, 보고서 또는 PR에 복사하지 않습니다.

```bash
read -r -s -p 'MCP read-only API token: ' WHATAP_API_TOKEN
printf '\n'
read -r -s -p 'Independent HTTP read-only API token: ' WHATAP_HTTP_API_TOKEN
printf '\n'
export WHATAP_API_TOKEN WHATAP_HTTP_API_TOKEN
```

검증 프로세스가 두 환경변수를 받는 곳에서 실행해야 합니다. `verify.js`는 독립 HTTP를 직접 호출하고 빌드된 MCP를 stdio로 실행합니다. 외부 MCP 등록이나 이전 사용자의 Codex 설정 파일은 필요하지 않습니다. GitHub CLI와 Codex에는 각자의 로그인 세션이 필요합니다.

데모 수치의 공개가 승인된 경우에만 `publication.example.json`을 `publication.local.json`으로 복사하고 승인 참조, 프로젝트, 지표 범위를 입력합니다. 최초 생성은 `install -m 600 publication.example.json publication.local.json`으로 할 수 있습니다. 승인 또는 제공자 허용 범위가 확인되지 않으면 이 파일 없이 시작합니다. [세부 공개 정책](reporting.md#데이터-공개-설정)

## 5. 설치 확인과 최초 실행

**Harness 루트**에서 의존성 설치 없이 회귀 테스트와 시나리오 목록을 실행합니다. MCP 빌드 확인의 경우 미리 준비한 체크아웃에서만 npm 의존성을 설치합니다.

```bash
npm test
node verify.js --list
(cd runs/baseline && npm ci && npm run build && npm test)
test -f runs/baseline/dist/index.js
```

같은 Harness 루트에서 CLI를 엽니다. 승인 요청이 필요한 네트워크·작업 경로는 조직과 Codex의 기존 제한 안에서 허용합니다.

```bash
codex --sandbox workspace-write --ask-for-approval on-request
```

첫 요청에는 “원본 MCP 전체를 검수하고 재현되는 문제가 있으면 내 Fork에서 수정·재검증 후 PR을 제출해 줘”처럼 목표를 적습니다. PR 없이 확인만 원하면 그 범위를 요청에 명시합니다. 다음 단계는 [사용 가이드](usage.md)를 참고하세요.
