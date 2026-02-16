# EC2 SSM Docker Blue Green Deployment Action

이 액션은 AWS Systems Manager (SSM)를 사용하여 EC2 인스턴스에서 Docker Compose 기반의 애플리케이션을 Blue/Green 방식으로 배포합니다. SSH 키 관리 없이 IAM 권한만으로 안전하고 중단 없는 배포를 지원합니다.

## 주요 변경 사항 (v1.0.0)

*   **별도의 Compose 파일 관리**: Blue와 Green 환경을 각각의 Docker Compose 파일로 관리하여 설정을 더욱 명확하게 분리할 수 있습니다.
*   **자동 서비스 감지**: 각 Compose 파일에서 배포할 서비스를 자동으로 추출하여 배포를 진행합니다.
*   **Nginx 컨테이너 연동**: EC2 내에서 `nginx`라는 이름의 Docker 컨테이너로 실행 중인 Nginx와 연동하여 자동으로 트래픽을 전환합니다.
*   **GHCR 지원**: `GITHUB_TOKEN`을 통해 GitHub Container Registry(GHCR) 로그인을 자동으로 수행합니다.
*   **격리된 Docker 설정**: 실행 시마다 독립된 `DOCKER_CONFIG` 경로를 사용하여 다른 도커 작업과의 충돌을 방지합니다.

## 전제 조건 (Prerequisites)

이 액션을 사용하기 위해서는 대상 EC2 인스턴스에 다음과 같은 설정이 필요합니다.

1.  **EC2 인스턴스 설정**:
    *   **AWS Systems Manager Agent (SSM Agent)**가 설치 및 실행 중이어야 합니다.
    *   **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
    *   **Nginx**가 `nginx`라는 이름의 Docker 컨테이너로 실행 중이어야 합니다.
    *   EC2 인스턴스의 IAM 역할은 SSM 관련 권한(`AmazonSSMManagedInstanceCore` 등)을 가지고 있어야 합니다.

2.  **프로젝트 설정**:
    *   Blue/Green 배포를 위한 두 개의 별도 Compose 파일이 필요합니다. (예: `docker-compose.blue.yml`, `docker-compose.green.yml`)
    *   각 서비스는 `container_name`이 명시되어 있어야 Nginx `proxy_pass` 설정이 올바르게 업데이트됩니다.
    *   Nginx 설정 파일에는 `proxy_pass http://<container-name>:<port>;` 형태의 라인이 존재해야 합니다.

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

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ap-northeast-2

      - name: Deploy Blue/Green
        uses: luviny/ec2-ssm-docker-blue-green@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          aws-ec2-id: 'i-0123456789abcdef0'
          docker-compose-blue-file-path: '/home/ubuntu/app/docker-compose.blue.yml'
          docker-compose-green-file-path: '/home/ubuntu/app/docker-compose.green.yml'
          nginx-config-file-path: '/etc/nginx/conf.d/app.conf'
          env-file-path: '/home/ubuntu/app/.env' # 선택 사항
          internal-port: '3000'
          health-path: '/health'
```

## 입력 변수 (Inputs)

| 입력 변수명 | 필수 여부 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `aws-ec2-id` | **Required** | - | 배포할 대상 EC2 인스턴스 ID |
| `docker-compose-blue-file-path` | **Required** | - | Blue 환경용 Compose 파일 절대 경로 |
| `docker-compose-green-file-path` | **Required** | - | Green 환경용 Compose 파일 절대 경로 |
| `nginx-config-file-path` | **Required** | - | Nginx 설정 파일 절대 경로 (포트 및 호스트 교체 대상) |
| `aws-region` | Optional | `ap-northeast-2` | AWS 리전 |
| `env-file-path` | Optional | - | EC2에 생성할 `.env` 파일의 기본 경로. 실제로는 `.env.<service-name>`으로 생성됩니다. |
| `internal-port` | Optional | `80` | 컨테이너 내부 애플리케이션 포트 |
| `health-path` | Optional | `/` | Health check를 수행할 경로 |
| `health-status` | Optional | `200` | Health check 성공으로 간주할 HTTP 상태 코드 |
| `health-time-out` | Optional | `30` | Health check 타임아웃 (초) |

## 주의 사항

*   **Nginx 리로드**: 액션 실행 마지막 단계에서 `sudo docker exec nginx nginx -s reload`를 실행합니다. Nginx 컨테이너의 이름이 `nginx`가 아닌 경우 오류가 발생할 수 있습니다.
*   **.env 파일 명명 규칙**: `env-file-path`를 지정하면 EC2 서버에는 `${env-file-path}.${service-name}` 형식으로 파일이 저장됩니다. 따라서 각 Compose 파일에서 `env_file` 설정을 이에 맞춰 구성해야 합니다.
*   **서비스 정의**: 각 Compose 파일에는 배포하고자 하는 서비스가 하나만 정의되어 있는 것이 권장됩니다. 액션은 파일 내의 첫 번째 서비스를 배포 대상으로 인식합니다.
