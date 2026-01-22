import { error, getInput, setFailed } from '@actions/core';
import { DeploymentService } from './deployment.service';

let newName: string;
let curName: string;
let deploy: DeploymentService;
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

        deploy = new DeploymentService(awsRegion, awsEc2Id);

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
            await deploy.runShellScript(`sudo docker image prune -af || true`);
        } else {
            // 비정상인 경우, 컨테이너 내부 로그 출력 후 종료
            throw new Error('Health check failed');
        }

        const curImage = composeConfig.services[curName]['image'] as string | undefined;
        const newImage = composeConfig.services[newName]['image'] as string | undefined;
        if (curImage && newImage) {
            const curRepoName = curImage.substring(0, curImage.lastIndexOf(':'));
            const newRepoName = curImage.substring(0, newImage.lastIndexOf(':'));

            if (curRepoName === newRepoName) {
                // 기존 이미지와 신규 이미지가 같은 경우 고어 이미지만 삭제
                await deploy.runShellScript(`sudo docker images -f "reference=${curRepoName}" -f "dangling=true" -q | xargs -r sudo docker rmi`);
            } else {
                // 기존 이미지와 신규 이미지가 완전 달라지는 경우 기존 이미지를 태그와 상관없이 모두 삭제
                await deploy.runShellScript(`sudo docker images -q --filter "reference=${curRepoName}" | xargs -r sudo docker rmi`);
            }
        }
    } catch (err) {
        await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} logs ${newName}`);
        await deploy.runShellScript(`sudo docker compose -f ${dockerComposeFilePath} down ${newName}`);

        if (err instanceof Error) {
            setFailed(err.message);
        } else {
            setFailed(String(err));
        }
        process.exit(1);
    }
}

bootstrap();
