export interface GrogoniProvider {
  name: "cloud" | "local" | "peer";
  supports(op: string): boolean;
  isAvailable(): Promise<boolean>;
  call<T>(op: string, args: unknown): Promise<T>;
}
