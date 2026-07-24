export interface MutantTally {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  excluded: number;
  valid: number;
}
export interface StrykerMutant { status?: string }
export interface StrykerFile { mutants?: StrykerMutant[] }
export interface StrykerReport { files?: Record<string, StrykerFile> }
export function tallyMutants(report: StrykerReport | null | undefined): MutantTally;

export interface AdapterResult {
  file: string;
  strykerExit: number;
  reportPresent: boolean;
  tally: MutantTally | null;
}
export interface GateResult {
  ok: boolean;
  failures: string[];
  aggregate: number | null;
  valid: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
}
export function gateAdapters(results: AdapterResult[], breakThreshold: number): GateResult;
