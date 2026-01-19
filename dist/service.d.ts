import { Parameter } from '@aws-sdk/client-ssm';
export declare class Service {
    private client;
    constructor(data: {
        region: string;
    });
    findAll(path: string): Promise<Parameter[]>;
    transformKey(key: string): string;
}
