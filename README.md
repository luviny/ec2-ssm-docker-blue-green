# EC2 SSM Docker Blue Green Deployment Action

이 액션은 AWS Systems Manager (SSM)를 사용하여 EC2 인스턴스에서 Docker Compose 기반의 애플리케이션을 Blue/Green 방식으로 배포합니다. SSH 키를 관리할 필요 없이 IAM 권한만으로 안전하게 배포를 수행할 수 있습니다.

## 주요 기능

*   **Blue/Green 배포**: 현재 실행 중인 서비스(Blue 또는 Green)를 자동으로 감지하고, 새 버전을 유휴 서비스로 배포합니다.
*   **Health Check**: 배포된 새 컨테이너가 정상적으로 응답하는지 확인한 후 트래픽을 전환합니다.
*   **Zero Downtime**: Nginx 설정을 동적으로 업데이트하고 리로드하여 중단 없는 배포를 지원합니다.
*   **자동 정리**: 배포 성공 시 이전 컨테이너를 중지하고 사용하지 않는 이미지를 정리합니다.
*   **보안**: AWS SSM을 사용하여 SSH 포트를 열거나 키를 공유할 필요가 없습니다. `.env` 파일도 안전하게 전송합니다.

## 전제 조건 (Prerequisites)

이 액션을 사용하기 위해서는 대상 EC2 인스턴스와 프로젝트에 다음과 같은 설정이 필요합니다.

1.  **EC2 인스턴스 설정**:
    *   **AWS Systems Manager Agent (SSM Agent)**가 설치되어 있고 실행 중이어야 합니다.
    *   **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
    *   **Nginx**가 설치되어 있고, 리버스 프록시로 설정되어 있어야 합니다.
    *   EC2 인스턴스에 연결된 IAM 역할은 SSM 관련 권한(`AmazonSSMManagedInstanceCore` 등)을 가지고 있어야 합니다.

2.  **프로젝트 설정**:
    *   EC2 내에 `docker-compose.yml` 파일이 위치해야 하며, Blue/Green 배포를 위한 두 개의 서비스(예: `app-blue`, `app-green`)가 정의되어 있는 것이 권장됩니다.
    *   Nginx 설정 파일(`nginx.conf` 또는 `sites-available/default`)은 `proxy_pass` 지시어를 포함해야 하며, 이 액션은 해당 라인을 찾아 포트를 변경합니다.

## 사용 방법 (Usage)

`.github/workflows/deploy.yml` 예시:

```yaml
name: Deploy to EC2

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Create .env file
        run: |
          echo "DATABASE_URL=${{ secrets.DATABASE_URL }}" >> .env
          echo "API_KEY=${{ secrets.API_KEY }}" >> .env

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ap-northeast-2

      - name: Deploy Blue/Green
        uses: luviny/ec2-ssm-docker-blue-green@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # GHCR 로그인을 위해 필요
        with:
          aws-ec2-id: 'i-0123456789abcdef0'
          docker-compose-file-path: '/home/ubuntu/app/docker-compose.yml'
          nginx-config-file-path: '/etc/nginx/conf.d/app.conf'
          env-file-path: '/home/ubuntu/app/.env' # 선택 사항
          internal-port: '3000'
          health-path: '/health'
```

## 입력 변수 (Inputs)

| 입력 변수명 | 필수 여부 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `aws-ec2-id` | **Required** | - | 배포할 대상 EC2 인스턴스 ID |
| `docker-compose-file-path` | **Required** | - | EC2 내의 `docker-compose.yml` 파일 절대 경로 |
| `nginx-config-file-path` | **Required** | - | EC2 내의 Nginx 설정 파일 절대 경로 (포트 교체 대상) |
| `aws-region` | Optional | `ap-northeast-2` | AWS 리전 |
| `env-file-path` | Optional | - | EC2에 생성할 `.env` 파일의 경로. 지정 시 로컬의 `.env` 내용을 전송합니다. |
| `internal-port` | Optional | `80` | 컨테이너 내부 애플리케이션 포트 |
| `health-path` | Optional | `/` | Health check를 수행할 경로 |
| `health-status` | Optional | `200` | Health check 성공으로 간주할 HTTP 상태 코드 |
| `health-time-out` | Optional | `30` | Health check 타임아웃 (초) |

## 작동 원리 (How it works)

1.  **서비스 감지**: `docker compose ps` 명령어를 통해 현재 실행 중인 서비스(Blue 또는 Green)를 확인합니다.
2.  **환경 변수 설정**: `env-file-path`가 제공되면, GitHub Runner의 `.env` 파일을 Base64로 인코딩하여 EC2로 전송 및 복원합니다.
3.  **이미지 풀 & 실행**: 새로운 버전의 이미지를 Pull하고, 현재 실행 중이지 않은 세트(예: 현재 Blue라면 Green)를 시작합니다.
4.  **Health Check**: 새로 띄운 컨테이너와 동일한 네트워크에서 `curl` 컨테이너를 실행하여 애플리케이션의 상태를 확인합니다.
5.  **트래픽 전환**: Health Check가 성공하면, Nginx 설정 파일의 `proxy_pass` 부분에서 포트 번호를 새 컨테이너의 포트로 변경하고 Nginx를 리로드(`nginx -s reload`)합니다.
6.  **정리**: 이전 버전의 서비스를 중지하고(`docker compose down`), 사용하지 않는 Docker 이미지를 정리합니다.

## 주의 사항

*   **Nginx 설정**: Nginx 설정 파일에서 `proxy_pass http://<container>:<port>;` 형태의 라인이 존재해야 `sed` 명령어가 올바르게 동작하여 포트를 교체할 수 있습니다.
*   **권한**: GitHub Actions Runner가 AWS 리소스에 접근할 수 있도록 올바른 IAM 권한이 설정되어 있어야 합니다.
