export type GroupingMode = "account" | "model";
export type DataState = "complete" | "partial" | "failed";
export type Outcome = "success" | "retryable" | "permanent" | "unknown";
export interface Clock {
  now(): number;
}
export interface Stats {
  calls: number;
  errors: number;
  retried: number;
  canceled: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  unpriced: number;
  tokens: number;
  errorRate: number;
  [key: string]: any;
}
export interface UsageRow extends Stats {
  provider: string;
  providerName: string;
  account: string;
  accountName: string;
  model: string;
  kind: string;
}
export interface UsageSnapshot {
  rows: UsageRow[];
  totals: Stats;
  state: DataState;
  warnings: any[];
  generatedAt: string;
  period: any;
  options: any;
  source: string;
}
export interface UsageSource {
  load(query: any): Promise<UsageSnapshot>;
}
export interface QuotaSource {
  load(): Promise<any>;
}
export interface GroupingStrategy {
  id: string;
  label: string;
  build(rows: UsageRow[], options: any): any[];
}
export interface ReportBuilder {
  build(spec: any, at: number): Promise<any>;
}
export interface ReportRenderer {
  id: string;
  render(report: any, layout: string): string;
}
export interface NotificationAdapter {
  id: string;
  label: string;
  fields: any[];
  capabilities: any;
  send(config: any, secret: any, message: any, context: any): Promise<any>;
}
export interface Repository {
  get(kind: string, id: string): any;
  list(kind: string): any[];
  put(kind: string, value: any, revision?: number): any;
  remove(kind: string, id: string): void;
}
export interface CredentialStore {
  get(id: string): Promise<any>;
  set(id: string, value: any): Promise<void>;
  delete(id: string): Promise<void>;
}
