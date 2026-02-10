import { getInput, setFailed } from '@actions/core';
import { DeploymentService } from './deployment.service';

let newName: string;
let curName: string;
let deploy: DeploymentService | undefined;
let awsRegion: string;
let envFilePath: string;
let dockerComposeFilePath: string;
let awsEc2Id: string;
let nginxConfigFilePath: string;
let healthPath: string;
let healthStatus: string;
let healthTimeOut: string;
let internalPort: string;

async function bootstrap() {
    // 고유한 실행 ID 생성 (밀리초 단위 타임스탬프)
    const runId = crypto.randomUUID();
    const dockerConfigPath = `/tmp/docker-config-${runId}`;

    try {
        awsRegion = getInput('aws-region');
        envFilePath = getInput('env-file-path');
        dockerComposeFilePath = getInput('docker-compose-file-path');
        awsEc2Id = getInput('aws-ec2-id');
        nginxConfigFilePath = getInput('nginx-config-file-path');
        healthPath = getInput('health-path');
        healthStatus = getInput('health-status');
        healthTimeOut = getInput('health-time-out');
        internalPort = getInput('internal-port');

        // dockerConfigPath를 주입하여 DeploymentService 생성
        deploy = new DeploymentService(awsRegion, awsEc2Id, dockerConfigPath);

        // 도커 설정 디렉토리 생성
        await deploy.runShellScript(`mkdir -p ${dockerConfigPath}`);

        // compose에 명시된 서비스명 추출
        const findService = await deploy.runShellScript(`docker compose -f ${dockerComposeFilePath} config --services`);
        const services = findService?.split('\n')?.filter((f) => !!f) || [];

        // 서비스가 실행중인지 체크
        const findContainers = await deploy.runShellScript(`docker compose -f ${dockerComposeFilePath} ps ${services[0]} --format "{{.Service}}"`);
        if (findContainers) {
            newName = services[1];
            curName = services[0];
        } else {
            newName = services[0];
            curName = services[1];
        }

        // 1. config 명령어로 전체 설정을 JSON으로 가져옵니다.
        const configRaw = await deploy.runShellScript(
            `sudo docker compose -f ${dockerComposeFilePath} config --no-interpolate --format json`,
            false, // 로그 출력을 끕니다 (내용이 길 수 있음)
        );

        // 2. JSON 파싱
        const composeConfig = JSON.parse(configRaw as string);

        // 3. 특정 서비스의 container_name 추출
        // newName이 서비스 이름(예: 'old-api.carsayo.net-blue')일 때
        const newContainerName = composeConfig.services[newName].container_name;

        if (envFilePath) await deploy.generateEnvFile(envFilePath, newContainerName);

        await deploy.runShellScript(`echo "${process.env.GITHUB_TOKEN}" | sudo docker login ghcr.io -u ${process.env.GITHUB_ACTOR} --password-stdin`);
        await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} pull ${newName}`);
        await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} up -d ${newName}`);

        const newNetwork = await deploy.runShellScript(
            `sudo docker inspect $(sudo docker compose -f ${dockerComposeFilePath} ps -q ${newName}) --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'`,
        );

        if (!newNetwork) throw new Error('Failed to get network name from docker inspect');

        const healthCheck = await deploy.healthCheck({
            network: newNetwork,
            appName: newName,
            timeOut: healthTimeOut,
            internalPort: internalPort,
            healthStatus: healthStatus,
            healthPath: healthPath,
        });

        if (healthCheck) {
            // 정상인 경우

            // proxy_pass로 시작해서 ;로 끝나는 모든 부분을 찾아서 교체
            await deploy.runShellScript(`sudo sed -i 's|proxy_pass .*;|proxy_pass http://${newContainerName}:${internalPort};|g' ${nginxConfigFilePath}`);

            // nginx 리로드
            await deploy.runShellScript(`sudo docker exec nginx nginx -s reload`);

            // 기존 서비스 종료
            await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} down ${curName}`);

            // 미사용중인 이미지 삭제
            // await deploy.runShellScript(`sudo docker image prune -af || true`);
        } else {
            // 비정상인 경우, 컨테이너 내부 로그 출력 후 종료
            throw new Error('Health check failed');
        }

        const curImage = composeConfig.services[curName]['image'] as string | undefined;
        const newImage = composeConfig.services[newName]['image'] as string | undefined;
        if (curImage && newImage) {
            const curRepoName = curImage.substring(0, curImage.lastIndexOf(':'));
            const newRepoName = newImage.substring(0, newImage.lastIndexOf(':'));

            // 1. 배포가 성공했으므로, 기존 컨테이너는 이미 중지되었거나 삭제되었다고 가정합니다.
            // 하지만 안전을 위해 중지된 컨테이너 정리를 먼저 수행하는 것이 좋습니다 (선택 사항)
            await deploy.runShellScript(`sudo docker container prune -f`);

            if (curRepoName === newRepoName) {
                // [수정됨] 기존 이미지와 신규 이미지가 같은 레포지토리인 경우 (예: v1 -> v2)
                // 댕글링 체크가 아니라, '직전 이미지(curImage)'를 직접 지목하여 삭제합니다.
                // 현재 실행 중인 컨테이너가 newImage를 쓰고 있으므로, curImage는 안전하게 삭제 가능합니다.
                console.log(`Cleaning up old image: ${curImage}`);
                try {
                    await deploy.runShellScript(`sudo docker rmi ${curImage}`);
                } catch (e) {
                    console.log(`이미지 삭제 실패 (다른 컨테이너가 사용 중일 수 있음): ${curImage}`);
                }
            } else {
                // 기존 이미지와 신규 이미지가 완전히 달라지는 경우 (기존 로직 유지)
                // 이 부분은 기존 이미지를 모두 날려도 되는 상황이라고 판단하신 것 같아 유지합니다.
                await deploy.runShellScript(`sudo docker images -q --filter "reference=${curRepoName}" | xargs -r sudo docker rmi`);
            }

            // [추가 팁] 빌드 캐시 정리
            // 이미지만 지운다고 용량이 확보되지 않는 경우, '빌드 캐시'가 주범일 수 있습니다.
            // 병렬 빌드에 영향이 적은 범위 내에서 24시간 지난 빌드 캐시만 정리하는 것도 방법입니다.
            await deploy.runShellScript(`sudo docker builder prune -f --filter "until=24h"`);
        }
    } catch (err) {
        if (newName && deploy) {
            await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} logs ${newName}`);
            await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} down ${newName}`);
        }

        if (err instanceof Error) {
            setFailed(err.message);
        } else {
            setFailed(String(err));
        }
        process.exit(1);
    } finally {
        // 임시 도커 설정 디렉토리 삭제
        if (deploy && dockerConfigPath) {
            try {
                await deploy.runShellScript(`rm -rf ${dockerConfigPath}`);
            } catch (e) {
                console.error('Failed to cleanup docker config path', e);
            }
        }
    }
}

bootstrap();
