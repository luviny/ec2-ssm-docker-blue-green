import { getInput, setFailed } from '@actions/core';
import { DeploymentService } from './deployment.service';

let newCompose: string;
let curCompose: string;
let newService: string;
let curService: string;
let deploy: DeploymentService | undefined;
let awsRegion: string;
let envFilePath: string;
let dockerComposeBlueFilePath: string;
let dockerComposeGreenFilePath: string;
let awsEc2Id: string;
let nginxConfigFilePath: string | null | undefined;
let traefikConfigFilePath: string | null | undefined;
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
        dockerComposeBlueFilePath = getInput('docker-compose-blue-file-path');
        dockerComposeGreenFilePath = getInput('docker-compose-green-file-path');
        awsEc2Id = getInput('aws-ec2-id');
        nginxConfigFilePath = getInput('nginx-config-file-path');
        healthPath = getInput('health-path');
        healthStatus = getInput('health-status');
        healthTimeOut = getInput('health-time-out');
        internalPort = getInput('internal-port');
        traefikConfigFilePath = getInput('traefik-config-file-path');

        // dockerConfigPath를 주입하여 DeploymentService 생성
        deploy = new DeploymentService(awsRegion, awsEc2Id, dockerConfigPath);

        // 도커 설정 디렉토리 생성
        await deploy.runShellScript(`mkdir -p ${dockerConfigPath}`, false);

        // 서비스 이름 추출
        const findBlueService = await deploy.runShellScript(`docker compose -f ${dockerComposeBlueFilePath} config --services`, false);
        const findGreenService = await deploy.runShellScript(`docker compose -f ${dockerComposeGreenFilePath} config --services`, false);

        // 옵셔널 체이닝과 기본값 설정 (|| '')
        // 만약 명령어가 실패해서 null이 오더라도 에러 없이 빈 문자열로 처리됨
        const blueOutput = (findBlueService || '').trim();
        const greenOutput = (findGreenService || '').trim();

        // 첫 번째 서비스명 추출
        const firstBlueService = blueOutput ? blueOutput.split('\n')[0] : null;
        const firstGreenService = greenOutput ? greenOutput.split('\n')[0] : null;

        if (!firstBlueService || !firstGreenService) throw new Error('No services found in the compose file.');

        const findBlueContainer = await deploy.runShellScript(`docker compose -f ${dockerComposeBlueFilePath} ps -q ${firstBlueService} 2> /dev/null`, false);

        if (findBlueContainer) {
            newCompose = dockerComposeGreenFilePath;
            curCompose = dockerComposeBlueFilePath;

            newService = firstGreenService;
            curService = firstBlueService;
        } else {
            newCompose = dockerComposeBlueFilePath;
            curCompose = dockerComposeGreenFilePath;

            newService = firstBlueService;
            curService = firstGreenService;
        }

        const curConfigRaw = await deploy.runShellScript(
            `sudo docker compose -f ${curCompose} config --no-interpolate --format json`,
            false, // 로그 출력을 끕니다 (내용이 길 수 있음)
        );

        const curComposeConfig = JSON.parse(curConfigRaw as string);

        const newConfigRaw = await deploy.runShellScript(
            `sudo docker compose -f ${newCompose} config --no-interpolate --format json`,
            false, // 로그 출력을 끕니다 (내용이 길 수 있음)
        );

        const newComposeConfig = JSON.parse(newConfigRaw as string);
        const newContainerName = newComposeConfig.services[newService].container_name;

        if (envFilePath) await deploy.generateEnvFile(envFilePath, newService);

        // 마무리 단계에서 이미지 삭제를 위해
        const curImageName = curComposeConfig.services[curService].image;
        const curImageId = (await deploy.runShellScript(`sudo docker images -q ${curImageName}`, false))?.trim();

        await deploy.runShellScript(`echo "${process.env.GITHUB_TOKEN}" | sudo docker login ghcr.io -u ${process.env.GITHUB_ACTOR} --password-stdin`);
        await deploy.runShellScript(`sudo docker compose -f ${newCompose} pull ${newService}`);
        await deploy.runShellScript(`sudo docker compose -f ${newCompose} up -d ${newService}`);

        const newNetwork = await deploy.runShellScript(
            `sudo docker inspect $(sudo docker compose -f ${newCompose} ps -q ${newService}) --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'`,
            false,
        );

        if (!newNetwork) throw new Error('Failed to get network name from docker inspect');

        const healthCheck = await deploy.healthCheck({
            network: newNetwork,
            appName: newContainerName,
            timeOut: healthTimeOut,
            internalPort: internalPort,
            healthStatus: healthStatus,
            healthPath: healthPath,
        });

        if (healthCheck) {
            // 정상인 경우

            if (nginxConfigFilePath) {
                // proxy_pass로 시작해서 ;로 끝나는 모든 부분을 찾아서 교체
                await deploy.runShellScript(`sudo sed -i 's|proxy_pass .*;|proxy_pass http://${newContainerName}:${internalPort};|g' ${nginxConfigFilePath}`);

                // nginx 리로드
                await deploy.runShellScript(`sudo docker exec nginx nginx -s reload`);
            }

            if (traefikConfigFilePath) {
                await deploy.runShellScript(`sudo sed -i 's|url:.*|url: "http://${newContainerName}:${internalPort}"|g' ${traefikConfigFilePath}`);
            }

            // 기존 서비스 종료
            await deploy.runShellScript(`sudo docker compose -f ${curCompose} stop ${curService} || true`);
            await deploy.runShellScript(`sudo docker compose -f ${curCompose} rm -f -v ${curService} || true`);

            if (curImageId)
                // 미사용중인 이미지 삭제
                await deploy.runShellScript(`sudo docker rmi ${curImageId} || true`);
        } else {
            // 비정상인 경우, 컨테이너 내부 로그 출력 후 종료
            throw new Error('Health check failed');
        }
    } catch (err) {
        if (newCompose && newService && deploy) {
            await deploy.runShellScript(`sudo docker compose -f ${newCompose} logs ${newService}`);
            await deploy.runShellScript(`sudo docker compose -f ${newCompose} down ${newService}`);
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
