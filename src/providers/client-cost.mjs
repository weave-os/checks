// Cost as the Claude CLI itself reports it: `total_cost_usd` on the terminal
// stream-json `result` event.
//
// This is the CLI's own estimate, priced against its local table for the
// model it asked for. It is the best number available without a provider-side
// billing API, and it is labelled "client-reported" everywhere it is shown so
// nobody mistakes it for an invoice. A gateway behind ANTHROPIC_BASE_URL may
// bill differently; Bedrock and Vertex certainly do.
//
// Returns the same `{ cost, error }` contract as the Router's session-cost
// lookup: a null cost means unknown, never zero.
export function clientReportedCost(resultEvent) {
  const cost = resultEvent?.total_cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    return { cost, error: null };
  }
  return {
    cost: null,
    error: "Claude CLI did not report total_cost_usd, so cost is unknown",
  };
}

export const CLIENT_COST_LABEL = "client-reported cost";
