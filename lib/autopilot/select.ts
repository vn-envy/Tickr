import { opportunityScore, type AutopilotSelection, type ResearchReport } from "../research/contracts";

/**
 * Deterministic Autopilot opportunity choice. The report's own recommendation wins when it
 * names a returned opportunity; otherwise the highest complete heuristic score; otherwise
 * the first supported opportunity. The score is the documented 30I/25E/20D/15F/10C
 * prioritization heuristic, not a conversion prediction.
 */
export function chooseAutopilotOpportunity(report: ResearchReport, reportHash: string): AutopilotSelection | null {
  if (!report.opportunities.length) return null;
  const recommended = report.recommendedOpportunityId ? report.opportunities.find((item) => item.id === report.recommendedOpportunityId) : undefined;
  if (recommended) {
    return { opportunityId: recommended.id, reportHash, selectedBy: "autopilot", basis: "report_recommendation", score: opportunityScore(recommended),
      rationale: `Autopilot followed the research recommendation “${recommended.title.slice(0, 200)}”. The owner can still start a new run to choose another direction.` };
  }
  const scored = report.opportunities
    .map((opportunity, index) => ({ opportunity, index, score: opportunityScore(opportunity) }))
    .filter((item): item is typeof item & { score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length) {
    const best = scored[0];
    return { opportunityId: best.opportunity.id, reportHash, selectedBy: "autopilot", basis: "highest_complete_score", score: best.score,
      rationale: `Autopilot chose “${best.opportunity.title.slice(0, 200)}”, the highest complete prioritization score (${best.score}) in this run. Scores compare options within this run only.` };
  }
  const first = report.opportunities[0];
  return { opportunityId: first.id, reportHash, selectedBy: "autopilot", basis: "first_supported", score: null,
    rationale: `No opportunity had a complete score, so Autopilot used the first supported opportunity “${first.title.slice(0, 200)}”. Its ranking remains unscored.` };
}
