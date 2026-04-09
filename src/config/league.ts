import {
  loadLeagueProfile,
  type LeagueCategories as RecommendationLeagueCategories,
  type LeaguePitchingSettings as RecommendationLeaguePitchingSettings,
  type LeagueTransactionSettings as RecommendationLeagueTransactionSettings,
  type LeaguePlayoffSettings as RecommendationLeaguePlayoffSettings,
  type LeagueProfile,
} from "../recommendation/league-profile";

export type LeagueCategories = RecommendationLeagueCategories;
export type LeaguePitchingSettings = RecommendationLeaguePitchingSettings;
export type LeagueTransactionSettings = RecommendationLeagueTransactionSettings;
export type LeaguePlayoffSettings = RecommendationLeaguePlayoffSettings;
export type LeagueSettings = LeagueProfile;

export function loadLeagueSettings(): LeagueSettings {
  return loadLeagueProfile();
}
