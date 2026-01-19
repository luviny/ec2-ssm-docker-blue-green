export declare class DeploymentService {
    private client;
    private instanceId;
    constructor(region: string, instanceId: string);
    generateEnvFile(envFilePath: string, containerName?: string): Promise<void>;
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
