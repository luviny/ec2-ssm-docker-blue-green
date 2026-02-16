export declare class DeploymentService {
    private client;
    private instanceId;
    private dockerConfigPath?;
    constructor(region: string, instanceId: string, dockerConfigPath?: string);
    generateEnvFile(envFilePath: string, serviceName?: string): Promise<void>;
    healthCheck(data: {
        network: string;
        appName: string;
        internalPort: string;
        timeOut: string;
        healthStatus: string;
        healthPath: string;
    }): Promise<boolean>;
    runShellScript(command: string, isPrint?: boolean): Promise<string | undefined>;
}
