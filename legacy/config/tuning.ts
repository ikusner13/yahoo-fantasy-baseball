import tuningOverrides from "../../config/tuning.json";

// --- Interfaces ---

export interface StreamingScoreMinimum {
  any: number;
  "high-floor": number;
  "elite-only": number;
}

export interface StreamingConfig {
  scoreMinimum: StreamingScoreMinimum;
  eraRiskThreshold: number;
  whipRiskThreshold: number;
}

export interface BudgetConfig {
  maxAddsPerWeek: number;
  reserveMonTue: number;
  reserveWedThu: number;
  reserveFriSun: number;
}

export interface RateStatThreshold {
  endOfWeek: number;
  startOfWeek: number;
}

export interface MatchupConfig {
  clinchMultiplier: number;
  rateStatClinchERA: RateStatThreshold;
  rateStatClinchWHIP: RateStatThreshold;
}

export interface LLMConfig {
  overrideEnabled: boolean;
  notes: string;
}

export interface TuningConfig {
  streaming: StreamingConfig;
  budget: BudgetConfig;
  matchup: MatchupConfig;
  llm: LLMConfig;
}

// --- Defaults ---

const DEFAULTS: TuningConfig = {
  streaming: {
    scoreMinimum: { any: 2.0, "high-floor": 4.0, "elite-only": 6.0 },
    eraRiskThreshold: 4.5,
    whipRiskThreshold: 1.35,
  },
  budget: {
    maxAddsPerWeek: 6,
    reserveMonTue: 3,
    reserveWedThu: 2,
    reserveFriSun: 0,
  },
  matchup: {
    clinchMultiplier: 3,
    rateStatClinchERA: { endOfWeek: 0.5, startOfWeek: 1.0 },
    rateStatClinchWHIP: { endOfWeek: 0.15, startOfWeek: 0.3 },
  },
  llm: {
    overrideEnabled: true,
    notes: "LLM can disagree with engine when historical/contextual signals are strong",
  },
};

// --- Core export ---

const parsed = tuningOverrides as Partial<TuningConfig>;

export function loadTuning(): TuningConfig {
  return {
    streaming: { ...DEFAULTS.streaming, ...parsed.streaming },
    budget: { ...DEFAULTS.budget, ...parsed.budget },
    matchup: { ...DEFAULTS.matchup, ...parsed.matchup },
    llm: { ...DEFAULTS.llm, ...parsed.llm },
  };
}
