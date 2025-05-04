declare module "bun" {
  export const redis: RedisClient;
  export class RedisClient {
    constructor(url?: string, options?: any);
    connect(): Promise<void>;
    close(): void;
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    exists(key: string): Promise<boolean>;
    del(key: string): Promise<number>;
    send(command: string, args: string[]): Promise<any>;
  }
}
