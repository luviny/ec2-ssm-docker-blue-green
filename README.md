# EC2 SSM Docker Blue Green Deployment Action

이 액션은 AWS Systems Manager (SSM)를 사용하여 EC2 인스턴스에서 Docker Compose 기반의 애플리케이션을 Blue/Green 방식으로 배포합니다. SSH 키 관리 없이 IAM 권한만으로 안전하고 중단 없는 배포를 지원하며, Nginx 또는 Traefik과의 연동을 통해 트래픽을 자동으로 전환합니다.

## 주요 특징 (Features)

*   **별도의 Compose 파일 관리**: Blue와 Green 환경을 각각의 Docker Compose 파일로 관리하여 설정을 명확하게 분리합니다.
*   **자동 서비스 감지**: 각 Compose 파일에서 배포할 서비스를 자동으로 추출하여 배포를 진행합니다.
*   **리버스 프록시 연동**: Nginx 또는 Traefik 설정을 자동으로 업데이트하여 무중단 배포를 실현합니다.
*   **격리된 Docker 설정**: 실행 시마다 고유한 `DOCKER_CONFIG` 경로를 사용하여 병렬 작업이나 다른 프로세스와의 충돌을 방지합니다.
*   **보안적인 환경 변수 전달**: 로컬 `.env` 파일을 Base64 인코딩하여 EC2로 안전하게 전송합니다.
*   **GHCR 자동 로그인**: GitHub Container Registry(GHCR) 로그인을 자동으로 수행하여 프라이빗 이미지를 원활하게 가져옵니다.

## 전제 조건 (Prerequisites)

1.  **EC2 인스턴스 설정**:
    *   **AWS SSM Agent**가 설치 및 실행 중이어야 합니다.
    *   **Docker** 및 **Docker Compose**가 설치되어 있어야 합니다.
    *   EC2 인스턴스의 IAM 역할에 SSM 관련 권한(`AmazonSSMManagedInstanceCore`)이 부여되어야 합니다.
    *   Nginx를 사용하는 경우, Nginx가 `nginx`라는 이름의 컨테이너로 실행 중이어야 합니다.

2.  **프로젝트 설정**:
    *   두 개의 Compose 파일 (예: `docker-compose.blue.yml`, `docker-compose.green.yml`).
    *   서비스 정의에 `container_name`이 명시되어 있어야 프록시 설정 업데이트가 가능합니다.
    *   Nginx 설정 시 `proxy_pass http://<container-name>:<port>;` 형식이 포함되어야 합니다.
    *   Traefik 설정 시 `url: "http://<container-name>:<port>"` 형식이 포함되어야 합니다.

## 사용 방법 (Usage)

```yaml
- name: Deploy Blue/Green
  uses: luviny/ec2-ssm-docker-blue-green@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    aws-ec2-id: 'i-0123456789abcdef0'
    docker-compose-blue-file-path: '/home/ubuntu/app/docker-compose.blue.yml'
    docker-compose-green-file-path: '/home/ubuntu/app/docker-compose.green.yml'
    # Nginx 또는 Traefik 중 하나를 선택하여 설정 (둘 다 생략 가능)
    nginx-config-file-path: '/etc/nginx/conf.d/app.conf'
    # traefik-config-file-path: '/etc/traefik/dynamic/conf.yml'
    env-file-path: '/home/ubuntu/app/.env'
    internal-port: '3000'
    health-path: '/health'
```

## 입력 변수 (Inputs)

| 입력 변수명 | 필수 여부 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `aws-ec2-id` | **Required** | - | 대상 EC2 인스턴스 ID |
| `docker-compose-blue-file-path` | **Required** | - | Blue 환경용 Compose 파일 절대 경로 (EC2 내부 경로) |
| `docker-compose-green-file-path` | **Required** | - | Green 환경용 Compose 파일 절대 경로 (EC2 내부 경로) |
| `aws-region` | Optional | `ap-northeast-2` | AWS 리전 |
| `env-file-path` | Optional | - | EC2에 생성할 `.env` 파일의 절대 경로. `${path}.${service-name}` 형식으로 저장됩니다. |
| `nginx-config-file-path` | Optional | - | Nginx 설정 파일 절대 경로. `proxy_pass` 주소가 새 컨테이너로 자동 교체됩니다. |
| `traefik-config-file-path` | Optional | - | Traefik 설정 파일 절대 경로. `url` 주소가 새 컨테이너로 자동 교체됩니다. |
| `internal-port` | Optional | `80` | 컨테이너 내부 애플리케이션 포트 |
| `health-path` | Optional | `/` | 배포 후 확인할 Health Check 경로 |
| `health-status` | Optional | `200` | 성공으로 간주할 HTTP 상태 코드 |
| `health-time-out` | Optional | `30` | Health Check 타임아웃 (초) |

## 상세 동작 방식

### 1. 환경 변수 전달 (`env-file-path`)
`env-file-path`를 지정하면 현재 작업 디렉토리의 `.env` 파일을 읽어 EC2 서버로 전송합니다. 파일은 중복 실행 방지를 위해 `${env-file-path}.${service_name}` 형태로 생성되므로, Docker Compose 파일에서 다음과 같이 참조해야 합니다.

```yaml
# docker-compose.blue.yml 예시
services:
  web:
    image: ghcr.io/user/repo:latest
    env_file:
      - .env.web # env-file-path가 /path/to/.env 인 경우
```

### 2. 트래픽 전환
*   **Nginx**: 지정된 경로의 파일에서 `proxy_pass .*;` 패턴을 찾아 `proxy_pass http://<new-container>:<port>;`로 변경하고 `docker exec nginx nginx -s reload`를 실행합니다.
*   **Traefik**: `url:.*` 패턴을 찾아 `url: "http://<new-container>:<port>"`로 변경합니다. (Traefik은 대개 파일 변경을 자동으로 감지하므로 별도의 재시작 명령을 내리지 않습니다.)

### 3. GHCR 로그인
이 액션은 `env` 섹션의 `GITHUB_TOKEN`을 사용하여 EC2에서 `docker login ghcr.io`를 수행합니다. 이를 위해 워크플로우 파일에서 `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 설정이 반드시 필요합니다.

## 주의 사항

*   **서비스 감지**: 각 Compose 파일의 **첫 번째 서비스**를 주 배포 대상으로 인식합니다.
*   **이미지 정리**: 배포 성공 시 기존 컨테이너를 중지/삭제하고, 사용되지 않는 기존 이미지를 `docker rmi`로 정리하여 디스크 공간을 확보합니다.
*   **헬스 체크**: 헬스 체크는 EC2 내부에서 별도의 임시 `curl` 컨테이너를 생성하여 수행하므로 애플리케이션 컨테이너가 특정 네트워크에 속해 있어도 내부 통신이 가능해야 합니다.
