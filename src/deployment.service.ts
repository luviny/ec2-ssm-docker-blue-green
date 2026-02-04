import { SSMClient, SendCommandCommand, GetCommandInvocationCommand, waitUntilCommandExecuted } from '@aws-sdk/client-ssm';
import { error, info } from '@actions/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

export class DeploymentService {
    private client: SSMClient;
    private instanceId: string;
    private dockerConfigPath?: string;

    constructor(region: string, instanceId: string, dockerConfigPath?: string) {
        this.client = new SSMClient({ region });
        this.instanceId = instanceId;
        this.dockerConfigPath = dockerConfigPath;
    }

    async generateEnvFile(envFilePath: string, containerName?: string) {
        // 로컬의 .env 파일 읽기 (경로는 본인의 환경에 맞게 수정하세요)
        const localEnvPath = path.join(process.cwd(), '.env');
        if (!fs.existsSync(localEnvPath)) {
            throw new Error('Local .env file not found.');
        }

        // env 파일 읽기
        const envContent = fs.readFileSync(localEnvPath, 'utf-8');

        // 특수 문자 문제 방지를 위해 Base64 인코딩
        const base64Env = Buffer.from(envContent).toString('base64');

        const envFile = containerName ? `${envFilePath}.${containerName}` : envFilePath;

        // EC2에 디렉토리 생성 및 파일 쓰기 스크립트 작성 (base64로 전달하고 서버에서 디코딩하여 저장합니다)
        const setupEnvScript = `
        mkdir -p $(dirname ${envFile})
        echo "${base64Env}" | base64 -d > ${envFile}
        chmod 600 ${envFile}`;

        info('Transferring .env file to EC2...');
        await this.runShellScript(setupEnvScript, false);
        info('.env file transfer completed');
    }

    async healthCheck(data: { network: string; appName: string; internalPort: string; timeOut: string; healthStatus: string; healthPath: string }) {
        const result = await this.runShellScript(
            `docker run --rm --network ${data.network.trim()} curlimages/curl  --retry 5  --retry-delay 3  --retry-all-errors --max-time 30 -s -o /dev/null -w "%{http_code}\n" http://${data.appName.trim()}:${data.internalPort.trim()}${data.healthPath.trim()}`,
        );
        return result?.trim() === data.healthStatus;
    }

    async runShellScript(command: string, isPrint: boolean = true) {
        let finalCommand = command;
        if (this.dockerConfigPath) {
            // sudo docker 실행 시 환경변수 유지를 위해 인라인으로 주입
            finalCommand = finalCommand.replace(/sudo docker/g, `sudo DOCKER_CONFIG=${this.dockerConfigPath} docker`);
            // 일반 실행을 위한 export
            finalCommand = `export DOCKER_CONFIG=${this.dockerConfigPath}; ${finalCommand}`;
        }

        // 로그 발생
        if (isPrint) info(`\x1b[1;36m${finalCommand}\x1b[0m`);

        const parameters: Record<string, string[]> = {
            commands: [finalCommand],
        };

        // 실행
        const sendResult = await this.client.send(
            new SendCommandCommand({
                DocumentName: 'AWS-RunShellScript',
                InstanceIds: [this.instanceId],
                Parameters: parameters,
            }),
        );

        // 실행 아이디 추출
        const commandId = sendResult.Command?.CommandId;
        if (!commandId) throw new Error('Command ID를 생성하지 못했습니다.');

        // 실행 건 대기
        await waitUntilCommandExecuted(
            {
                client: this.client,
                maxWaitTime: 300,
                minDelay: 2,
            },
            {
                CommandId: commandId,
                InstanceId: this.instanceId,
            },
        );

        // 결과 조회
        const invocation = await this.client.send(
            new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: this.instanceId,
            }),
        );

        // Standard Output 출력
        if (isPrint && invocation.StandardOutputContent) {
            info(invocation.StandardOutputContent);
        }

        // Standard Error 출력 (이 부분이 핵심입니다)
        if (invocation.StandardErrorContent) {
            // Status가 Success라면 에러가 아니라 '경고'나 '정보'로 취급합니다.
            if (invocation.Status === 'Success') {
                // info 또는 warn 레벨로 출력하여 혼동을 방지합니다.
                info(`[Stderr/Warning]: ${invocation.StandardErrorContent}`);
            } else {
                // 진짜 실패했을 때만 error 레벨로 출력합니다.
                error(`[Stderr/Error]: ${invocation.StandardErrorContent}`);
            }
        }

        // 실패 시 중단 (Status 필드 기반)
        if (invocation.Status !== 'Success') {
            error(`Step failed with status: ${invocation.Status} (Code: ${invocation.ResponseCode})`);
            process.exit(1);
        }

        return invocation.StandardOutputContent;
    }
}
