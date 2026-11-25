# Ubuntu 설치 및 환경 구성

명령은 Ubuntu의 Bash에서 실행합니다. 이미 설치되어 있고 확인 명령이 통과하는 프로그램은 설치를 건너뛰세요. 로컬 설치 확인에는 WhaTap 및 Codex 계정이 필요 없습니다. 실제 비교에는 승인된 WhaTap HTTPS 접속과 읽기 권한이, Codex 사용에는 Codex 계정과 서비스 접속이 필요합니다. 소스와 의존성을 내려받으려면 GitHub와 npm 레지스트리에 접속할 수 있어야 합니다.

## 1. 프로그램 준비

아래 버전은 문서 점검 환경인 Ubuntu 26.04.1 LTS에서 확인했습니다. 최소 버전이 따로 명시되지 않은 도구는 표에 필요한 기능을 기준으로 확인합니다.

| 프로그램 | 필요한 경우 | 버전 기준 | 확인한 버전과 명령 |
| --- | --- | --- | --- |
| Bash | 검증기의 MCP stdio 파이프 및 가이드 명령 | 별도 최소 명시 없음 | 5.3.9 · `bash --version` |
| Git | Clone, MCP 체크아웃과 실행 SHA 확인, 변경 검토 | 별도 최소 명시 없음 | 2.53.0 · `git --version` |
| Node.js | Harness와 MCP 실행 | Harness 선언은 22 이상. `npm test`에 필요한 옵션은 22.8.0부터 제공 | 22.23.5 · `node --version` |
| npm | Harness 테스트 스크립트, MCP 의존성·빌드, Codex npm 설치 | 별도 최소 명시 없음. Node.js와 함께 제공되는 npm 사용 권장 | 10.9.9 · `npm --version` |
| curl 및 CA 인증서 | 이 가이드의 Node.js HTTPS 다운로드 | 별도 최소 명시 없음. 검증기는 Node.js의 `fetch` 사용 | curl 8.18.0 · `curl --version` |
| coreutils, tar, xz-utils | 이 가이드의 파일 설치·압축 해제, 선택적 `timeout` | 별도 최소 명시 없음 | coreutils 0.10.0(uutils), tar 1.35, xz 5.8.3 · `command -v install sha256sum tar xz timeout` |
| GitHub CLI (`gh`) | GitHub 인증 보조, Fork 확인·생성 및 PR | 별도 최소 명시 없음. 해당 명령의 플래그는 `--help`로 확인 | 2.46.0 · `gh --version` |
| Codex CLI | AI 주도 검수·수정 및 구조화 답변 작성 | 별도 최소 명시 없음. Headless 로그인은 `--device-auth` 지원 필요 | 0.172.0 · `codex --version` |
| Bubblewrap (`bwrap`) | Ubuntu에서 Codex의 Linux 샌드박스를 위한 시스템 패키지 | 별도 최소 명시 없음. 직접 검증에는 필요 없음 | 0.11.1 · `bwrap --version` |

[Node.js 테스트 옵션 버전](https://nodejs.org/download/release/v22.21.0/docs/api/cli.html#--experimental-test-isolationmode) · [Codex Linux 샌드박스 요구사항](https://developers.openai.com/codex/concepts/sandboxing#prerequisites)

**Ubuntu 터미널의 임의 디렉터리**에서 누락된 패키지를 설치합니다. 시스템 패키지를 변경하는 이 단계에는 `sudo` 권한이 필요합니다.

```bash
sudo apt-get update
sudo apt-get install bash git ca-certificates curl coreutils tar xz-utils
# GitHub 인증, Fork 또는 PR을 사용할 경우
sudo apt-get install gh
# Codex를 사용할 경우
sudo apt-get install bubblewrap
```

배포판에서 `gh`를 제공하지 않거나 필요한 옵션이 없다면 GitHub CLI 공식 Linux 설치 절차를 사용합니다. 관리자 권한이 없으면 관리자에게 시스템 패키지 설치를 요청하세요. [GitHub CLI 공식 설치](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)

### Node.js와 npm

일반 사용자 Bash에서 두 프로그램을 각각 확인합니다. Node.js 22의 최신 패치를 권장합니다. 기존 설치가 있다면 테스트 옵션도 확인한 뒤 다음 단계로 넘어갑니다.

```bash
node --version
npm --version
node --experimental-test-isolation=none --version
```

`npm`이 없거나 현재 Node.js에서 테스트 옵션을 지원하지 않는다면 아래 예제처럼 npm이 포함된 공식 Node.js 배포본을 일반 사용자 홈에 설치할 수 있습니다. 예제는 Ubuntu x86-64와 ARM64용입니다. 버전을 변경하려면 공식 다운로드 페이지에서 Node.js 22 패치 버전을 확인하고 `NODE_VERSION`에 `v`를 포함해 입력합니다. 기존 버전 관리자를 쓰는 경우 그 도구로 npm을 포함한 Node.js 22를 활성화해도 됩니다. [Node.js 공식 다운로드](https://nodejs.org/en/download)

```bash
(
  set -e
  NODE_VERSION=v22.23.5
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) printf '이 예제에서 지원하지 않는 CPU 아키텍처입니다.\n' >&2; exit 1 ;;
  esac
  archive="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  download_dir=$(mktemp -d)
  cd "$download_dir"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$archive"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  sha256sum --ignore-missing --check SHASUMS256.txt
  mkdir -p "$HOME/.local/opt/node22"
  tar -xJf "$archive" --strip-components=1 -C "$HOME/.local/opt/node22"
)
```

설치에 성공했다면 아래 줄을 현재 셸에서 실행합니다. 계속 적용하려면 같은 줄을 Bash 로그인 시 읽히는 `~/.profile`에 한 번 추가합니다. `~/.bash_profile` 또는 `~/.bash_login`이 우선되는 환경은 해당 파일을, 비로그인 대화형 Bash는 `~/.bashrc`를 사용합니다.

```bash
export PATH="$HOME/.local/opt/node22/bin:$PATH"
node --version
npm --version
node --experimental-test-isolation=none --version
```

### Codex CLI와 npm 권한

Codex를 사용할 경우 **일반 사용자 Bash**에서 설치합니다. 시스템 npm의 전역 경로가 쓰기 불가능하면 `EACCES`가 발생할 수 있습니다. 아래 예제는 이 설치에만 적용되는 사용자 전용 `--prefix`를 사용합니다. `PATH`의 `export` 줄은 앞의 셸 시작 파일에 추가하면 새 터미널에서도 적용됩니다. 버전 관리자가 제공하는 쓰기 가능한 Node.js를 사용한다면 기본 `npm install -g @openai/codex`도 사용할 수 있습니다. [npm 전역 설치 권한 안내](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/) · [Codex CLI 설치](https://developers.openai.com/codex/cli)

```bash
mkdir -p "$HOME/.local"
npm install --global --prefix "$HOME/.local" @openai/codex
export PATH="$HOME/.local/bin:$PATH"
codex --version
bwrap --version
codex sandbox -- /bin/true
```

마지막 명령은 종료 코드 0이면 샌드박스에서 명령을 실행할 수 있음을 확인합니다. Ubuntu AppArmor 또는 사용자 네임스페이스 오류가 발생하면 관리자와 함께 해당 배포판의 `bwrap` 프로필을 확인합니다. [Codex Linux 샌드박스 요구사항](https://developers.openai.com/codex/concepts/sandboxing#prerequisites)

MCP 체크아웃에서의 `npm ci`, 잠금 파일을 관리할 때의 `npm install`, `npm run build` 및 `npm test`는 체크아웃을 소유한 일반 사용자로 실행합니다. `sudo npm`으로 실행하면 체크아웃·캐시·빌드 결과가 root 소유가 될 수 있습니다.

## 2. GitHub와 Codex 인증

### GitHub HTTPS 인증

**Ubuntu의 일반 사용자 터미널**에서 실행합니다. 공개 저장소 읽기와 로컬 테스트만 할 경우 GitHub 로그인을 건너뛸 수 있습니다.

```bash
gh auth login --hostname github.com --git-protocol https
```

브라우저가 없는 VM에서는 다음 명령으로 로컬 브라우저 실행을 건너뛸 수 있습니다. `GH_BROWSER`는 이 명령에만 적용되고 `/bin/true`는 브라우저 실행 단계에서 즉시 종료됩니다. 인증 완료 대기는 GitHub CLI가 계속 수행합니다. [GitHub CLI 로그인](https://cli.github.com/manual/gh_auth_login) · [Device Code 동작](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) · [브라우저 환경변수](https://cli.github.com/manual/gh_help_environment) · [gh 2.46.0 인증 구현](https://github.com/cli/cli/blob/v2.46.0/internal/authflow/flow.go)

```bash
GH_BROWSER=/bin/true gh auth login \
  --hostname github.com \
  --git-protocol https \
  --web
```

1. VM에 표시된 일회용 코드를 확인합니다. `Press Enter`가 나오면 VM에서 먼저 Enter를 눌러 인증 대기를 시작합니다. Git 자격 증명 사용 여부를 묻는 경우 Git HTTPS 인증을 사용할지 선택합니다.
2. 별도 PC의 브라우저로 `https://github.com/login/device`에 접속합니다. 작업할 계정으로 로그인하고 해당 코드와 OAuth 승인 요청을 확인합니다.
3. VM에 로그인 완료 메시지가 출력될 때까지 기다립니다. 브라우저에서 승인했는데 계속 대기하면 VM에 미응답 프롬프트가 있는지, VM에서 `github.com`과 `api.github.com`으로 HTTPS 요청이 가능한지 확인합니다. 코드가 만료되면 기존 명령을 종료하고 새 코드로 다시 시도합니다. 브라우저 우회는 로컬 실행 단계에만 적용됩니다. 네트워크 확인은 `curl -fsSI https://github.com/login/device`와 `curl -fsSI https://api.github.com/`로 할 수 있습니다.

```bash
gh auth status --hostname github.com
gh api user --jq .login
gh auth setup-git --hostname github.com
```

`gh api user`가 작업할 계정을 표시하는지 확인합니다. `gh auth setup-git`은 현재 사용자의 Git HTTPS 자격 증명 도우미를 설정합니다. VM에 시스템 자격 증명 저장소가 없으면 `gh`가 사용자 설정 파일을 사용하므로 해당 위치의 접근 권한을 보호하세요. [Git HTTPS 인증 설정](https://cli.github.com/manual/gh_auth_setup-git)

Device Code가 막히면 조직 정책이 허용하는 경우 classic PAT를 표준입력으로 전달할 수 있습니다. 공식 문서의 최소 스코프는 `repo`, `read:org`, `gist`입니다. 조직 저장소에는 SSO 등 추가 승인이 필요할 수 있습니다. 자동화에서 fine-grained 토큰을 쓰는 경우에는 비밀 저장소에서 `GH_TOKEN`을 주입하고 저장소별 접근 및 쓰기 권한을 확인합니다. `GH_TOKEN`이나 `GITHUB_TOKEN`이 설정되어 있으면 저장된 로그인보다 우선합니다. 저장된 계정으로 전환하려면 해당 변수를 비운 후 로그인합니다. [GitHub CLI 토큰 인증](https://cli.github.com/manual/gh_auth_login)

```bash
# 셸 추적이 꺼진 일반 사용자 Bash에서 실행
read -r -s -p 'GitHub classic PAT: ' github_pat
printf '\n'
printf '%s\n' "$github_pat" | gh auth login --hostname github.com --git-protocol https --with-token
unset github_pat
```

토큰으로 로그인한 뒤 위의 상태 확인과 `gh auth setup-git`을 실행합니다.

### Codex Headless 인증

Codex를 사용할 경우 **일반 사용자 터미널**에서 실행합니다. 브라우저가 있는 환경은 `codex login`, 브라우저 없는 VM은 아래 Device Code 로그인을 사용합니다. 개인 계정 보안 설정 또는 워크스페이스 관리자 설정에서 Device Code 로그인이 허용되어 있어야 합니다. 별도 PC에서 CLI가 보여 준 URL을 열고 코드로 승인한 뒤 VM에서 상태를 확인합니다. [Codex 공식 인증 안내](https://developers.openai.com/codex/auth)

```bash
codex login --device-auth
codex login status
```

Device Code를 사용할 수 없고 조직 정책상 API 키 사용이 허용되면 비밀 저장소에서 `OPENAI_API_KEY`를 주입한 셸에서 `printenv OPENAI_API_KEY | codex login --with-api-key`를 실행하고 `codex login status`로 확인합니다. 키·토큰·로그인 캐시는 명령 인자, 셸 기록, Git, 실행 보고서나 PR에 넣지 않습니다.

## 3. Harness Clone과 MCP Fork 선택

**작업을 둘 상위 디렉터리**에서 일반 사용자로 실행합니다. 기본 URL은 배포 저장소입니다. 사내 미러 또는 자신의 Harness Fork는 아래 `HARNESS_REPO`에 해당 `OWNER/REPO`를 입력하세요. `HARNESS_DIR`는 원하는 새 로컬 경로로 바꿀 수 있습니다. 별도 브랜치를 지정하지 않으면 Git은 저장소의 기본 브랜치를 체크아웃합니다.

```bash
read -r -p 'Harness OWNER/REPO (Enter: jtlim/whatap-harness-v2): ' HARNESS_REPO
HARNESS_REPO="${HARNESS_REPO:-jtlim/whatap-harness-v2}"
HARNESS_DIR=whatap-harness-v2
git clone "https://github.com/$HARNESS_REPO.git" "$HARNESS_DIR" &&
  cd "$HARNESS_DIR" &&
  git remote get-url origin
```

이후 단계는 **Harness 루트**에서 실행합니다. 이미 Clone했다면 해당 경로로 이동합니다. 작업 저장소에 지정된 기준 브랜치가 있으면 해당 브랜치로 전환합니다. 설치 확인만 할 경우 바로 [로컬 설치 확인](#6-설치-확인과-최초-실행)을 실행할 수 있습니다.

MCP 원본은 고정된 [`whatap/whatap-open-mcp`](https://github.com/whatap/whatap-open-mcp)입니다. 수정안을 PR로 만들 경우 원본의 Fork를 본인 계정이나 권한 있는 조직에 준비합니다. GitHub 웹의 **Fork** 화면에서 Owner 및 Repository name을 지정할 수 있습니다. 또는 `gh repo fork whatap/whatap-open-mcp --clone=false --fork-name YOUR_MCP_REPOSITORY`를 사용합니다. 이 CLI 명령은 현재 계정에 Fork를 만들며, 조직에 만들 경우 `--org YOUR_GITHUB_OWNER`를 추가합니다. 이미 Fork가 있으면 해당 저장소를 사용합니다. [GitHub CLI Fork 옵션](https://cli.github.com/manual/gh_repo_fork)

| 작업 | 필요한 권한 |
| --- | --- |
| Fork 생성 | 원본 읽기와 대상 계정·조직에서 Fork 생성 권한 |
| Clone·Fetch | 대상 저장소 읽기. 공개 저장소는 인증 없이 읽을 수 있음 |
| Push | 작업 브랜치가 위치할 Fork의 쓰기 권한 및 해당 브랜치 규칙 준수 |
| PR 생성 | Fork에 Push된 작업 브랜치와 대상 저장소에서 PR을 열 수 있는 권한. Merge는 별도 권한과 검토 절차 적용 |

`MCP_FORK`는 GitHub **소유자/저장소 이름**의 형식입니다. 예를 들어 `MCP_FORK="YOUR_GITHUB_OWNER/YOUR_MCP_REPOSITORY"` 또는 `MCP_FORK="jtlim/whatap-open-mcp"`입니다. 전체 URL, `.git` 접미사, 저장소 이름만 입력하는 형식은 사용하지 않습니다. 로그인 계정은 작업 권한을 가진 개인 계정이고, Fork의 소유자는 그 계정이나 조직일 수 있습니다.

```bash
read -r -p 'MCP Fork (OWNER/REPO, 읽기 전용 검수는 Enter): ' MCP_FORK
if [[ -n "$MCP_FORK" ]]; then
  gh api "repos/$MCP_FORK" --jq '{fork, parent: .parent.full_name, canPush: .permissions.push}'
fi
```

PR을 만들 경우 `fork: true`, 부모 `whatap/whatap-open-mcp`, `canPush: true`를 확인합니다. Harness도 변경할 경우 `gh repo view --repo "$HARNESS_REPO" --json nameWithOwner,defaultBranchRef,viewerPermission`으로 원격과 권한을 확인하고 쓰기 가능한 Harness 원격으로 작업합니다. 새 셸에서 이 명령을 실행한다면 `HARNESS_REPO`를 먼저 다시 지정합니다.

## 4. MCP 기준 체크아웃과 검토 브랜치

**Harness 루트의 같은 셸**에서 실행합니다. Agent의 기본 검수 기준 SHA는 `c1001155538114e811e8ecf311904723aa131115`입니다. 다른 버전을 직접 비교하려면 해당 Git 체크아웃을 빌드한 후 `verify.js --mcp`로 지정합니다. 설치 예제의 `runs/baseline`은 새 경로여야 합니다. 이미 기준 복제본이 있으면 기존 파일을 보존하고 HEAD를 확인하거나 새 경로를 사용하세요.

```bash
umask 077
mkdir -p runs
MCP_UPSTREAM=whatap/whatap-open-mcp
MCP_BASE=c1001155538114e811e8ecf311904723aa131115
MCP_SOURCE="${MCP_FORK:-$MCP_UPSTREAM}"
git clone "https://github.com/$MCP_SOURCE.git" runs/baseline &&
  git -C runs/baseline fetch "https://github.com/$MCP_UPSTREAM.git" "$MCP_BASE" &&
  git -C runs/baseline switch --detach "$MCP_BASE" &&
  git -C runs/baseline rev-parse HEAD
```

읽기 전용 직접 검수라면 다음 단계로 이동합니다. MCP PR을 만들 경우 Fork의 기존 검토 기준 브랜치를 선택하고 해당 SHA를 확인합니다. `MCP_FORK`가 설정된 상태에서만 아래 명령을 실행합니다.

```bash
read -r -p 'MCP Fork의 PR 기준 브랜치: ' BASE_BRANCH
git check-ref-format "refs/heads/$BASE_BRANCH" &&
  git ls-remote --exit-code "https://github.com/$MCP_FORK.git" "refs/heads/$BASE_BRANCH"
```

출력이 `MCP_BASE`와 일치해야 합니다. 종료 코드 2는 일치하는 ref가 없다는 뜻입니다. 네트워크·인증 오류라면 먼저 연결을 확인합니다. 브랜치가 없고 Fork의 운영 정책에서 허용하면 아래처럼 새 브랜치를 만듭니다. 기존 브랜치가 다른 SHA를 가리키면 다른 이름을 선택하고 조회를 반복합니다. Push 직전에 브랜치가 생성되지 않았는지 확인합니다.

```bash
git push "https://github.com/$MCP_FORK.git" "$MCP_BASE:refs/heads/$BASE_BRANCH" &&
  git ls-remote --exit-code "https://github.com/$MCP_FORK.git" "refs/heads/$BASE_BRANCH"
```

커밋을 만들 때에만 해당 **후보 또는 Harness 체크아웃**에서 `git config user.name "본인 이름"`, `git config user.email "본인 이메일 또는 GitHub noreply 주소"`로 저장소별 작성자를 설정합니다. 이는 GitHub 인증과 별개이며 기존 설정은 `git var GIT_AUTHOR_IDENT`로 확인할 수 있습니다.

## 5. WhaTap 설정과 읽기 전용 토큰

**Harness 루트**에서 로컬 설정을 최초 한 번 복사하고 편집합니다. 이미 구성했다면 파일을 보존하고 값만 확인합니다.

```bash
test -f config.local.json || install -m 600 config.example.json config.local.json
```

| 설정 | 값 |
| --- | --- |
| `serverProject`, `apmProject` | 실데이터 검증에 사용할 승인된 프로젝트의 양의 정수 코드. 예시의 1과 2를 교체 |
| `fork`, `baseBranch` | Agent가 수정안을 제출할 때 사용하는 `MCP_FORK`의 `OWNER/REPO`와 검증한 `BASE_BRANCH` 값. `verify.js` 직접 비교에는 필요 없음 |
| `apiOrigin` | 선택. 승인된 HTTPS API Origin. 생략 시 `https://api.whatap.io` |
| `fixedEnd` | 선택. 과거 5분 경계 UTC Unix 밀리초. 검증 구간 종료점 |

`MCP_FORK`, `BASE_BRANCH` 등은 가이드의 셸 변수입니다. `config.local.json`에는 변수명 대신 실제 값을 써야 합니다. JSON은 체크아웃에 남으며, 셸 변수는 새 셸에서 후속 명령에 필요할 때 다시 지정합니다. 레거시 `run.js --legacy-full`에는 `OWNER/whatap-open-mcp` 형식의 Fork 이름 제약이 있습니다.

WhaTap 환경 관리자가 승인한 MCP 및 독립 HTTP 읽기 전용 토큰을 검증을 실행할 **같은 Bash**에 주입합니다. 비밀 저장소에서 주입하거나, 셸 추적이 꺼진 터미널에서 아래처럼 화면에 표시하지 않고 입력합니다. 새 셸에서는 다시 주입합니다.

```bash
read -r -s -p 'MCP read-only API token: ' WHATAP_API_TOKEN
printf '\n'
read -r -s -p 'Independent HTTP read-only API token: ' WHATAP_HTTP_API_TOKEN
printf '\n'
export WHATAP_API_TOKEN WHATAP_HTTP_API_TOKEN
```

독립 조회는 `verify.js`가 수행하고 빌드한 MCP는 stdio에서 실행합니다. 외부 MCP 등록은 필요 없습니다. 토큰은 설정 JSON에 저장하지 않습니다. 실제 수치 공개는 제공자가 승인한 경우에만 [공개 정책 설정](reporting.md#데이터-공개-설정)을 적용합니다.

## 6. 설치 확인과 최초 실행

**Harness 루트**에서 일반 사용자로 실행합니다. Harness 자체는 Node.js 내장 모듈을 사용하므로 의존성 설치 단계가 없습니다. 아래 두 명령은 WhaTap 접속 없이 테스트 성공 여부와 등록 시나리오를 보여 줍니다.

```bash
npm test
node verify.js --list
```

실데이터 검증을 준비할 경우 **Harness 루트**에서 다음 명령을 실행합니다. 괄호 안의 명령은 준비한 **MCP 체크아웃**에서 실행되며 정상 빌드 시 `dist/index.js`가 있습니다.

```bash
(cd runs/baseline && npm ci && npm run build && npm test) &&
  test -f runs/baseline/dist/index.js
```

같은 Harness 루트와 토큰을 전달받는 셸에서 [직접 검증](usage.md#직접-검증)을 시작하거나 Codex를 실행합니다.

```bash
codex --sandbox workspace-write --ask-for-approval on-request
```

첫 요청은 “APM 트랜잭션과 TPS를 독립 HTTP와 대조하고 결과만 알려 줘”처럼 대상과 원하는 결과를 지정합니다. 수정안을 검토하려면 Fork 및 PR 권한을 준비하고 [후보 확정과 제출 순서](usage.md#후보-확정과-제출-순서)를 따릅니다.
