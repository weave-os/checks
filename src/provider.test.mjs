import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROVIDER,
  childEnvironment,
  createProvider,
  parseProviderEnv,
} from "./provider.mjs";
import { anthropicProvider } from "./providers/anthropic.mjs";
import { clientReportedCost } from "./providers/client-cost.mjs";
import { inheritProvider } from "./providers/inherit.mjs";

describe("parseProviderEnv", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    assert.deepEqual(
      parseProviderEnv("# gateway\nANTHROPIC_BASE_URL=https://gw.example.com\n\nCLAUDE_CODE_USE_BEDROCK=1\n"),
      { ANTHROPIC_BASE_URL: "https://gw.example.com", CLAUDE_CODE_USE_BEDROCK: "1" },
    );
  });

  it("keeps everything after the first = verbatim", () => {
    assert.deepEqual(parseProviderEnv("TOKEN=a=b= c"), { TOKEN: "a=b= c" });
  });

  // ANTHROPIC_CUSTOM_HEADERS takes one header per line.
  it("joins a repeated key with newlines", () => {
    assert.deepEqual(
      parseProviderEnv("ANTHROPIC_CUSTOM_HEADERS=X-A: 1\nANTHROPIC_CUSTOM_HEADERS=X-B: 2"),
      { ANTHROPIC_CUSTOM_HEADERS: "X-A: 1\nX-B: 2" },
    );
  });

  it("treats absent input as empty", () => {
    assert.deepEqual(parseProviderEnv(undefined), {});
    assert.deepEqual(parseProviderEnv(""), {});
  });

  it("rejects a line that is not KEY=VALUE", () => {
    for (const line of ["just words", "=value", "1BAD=x", "BAD KEY=x"]) {
      assert.throws(() => parseProviderEnv(line), /not KEY=VALUE/);
    }
  });
});

describe("childEnvironment", () => {
  it("drops, then overlays, then pins the automation initiator", () => {
    const env = childEnvironment({
      baseEnv: { KEEP: "1", SECRET: "s", SHARED: "inherited", WEAVE_PROMPT_INITIATOR: "human" },
      dropEnv: ["SECRET", "SHARED"],
      providerEnv: { SHARED: "provider", WEAVE_PROMPT_INITIATOR: "provider" },
    });
    assert.deepEqual(env, {
      KEEP: "1",
      SHARED: "provider",
      WEAVE_PROMPT_INITIATOR: "automation",
    });
  });

  it("does not mutate the inherited environment", () => {
    const baseEnv = { SECRET: "s" };
    childEnvironment({ baseEnv, dropEnv: ["SECRET"] });
    assert.deepEqual(baseEnv, { SECRET: "s" });
  });
});

describe("createProvider", () => {
  it("builds anthropic without any Weave secret", () => {
    const provider = createProvider(PROVIDER.ANTHROPIC, {
      env: {},
      providerEnv: { ANTHROPIC_BASE_URL: "https://gw.example.com" },
    });
    assert.equal(provider.id, "anthropic");
    assert.deepEqual(provider.envFor({ cluster: "low" }), { ANTHROPIC_BASE_URL: "https://gw.example.com" });
    assert.deepEqual(provider.dropEnv, []);
  });

  it("builds inherit with no overlay", () => {
    const provider = createProvider(PROVIDER.INHERIT);
    assert.deepEqual(provider.envFor({}), {});
  });

  it("requires both Router secrets only for weave-router", () => {
    assert.throws(() => createProvider(PROVIDER.WEAVE_ROUTER, { env: {} }), /requires WEAVE_ROUTER_KEY/);
    assert.throws(
      () => createProvider(PROVIDER.WEAVE_ROUTER, { env: { WEAVE_ROUTER_KEY: "rk" } }),
      /requires WEAVE_API_KEY/,
    );
    const provider = createProvider(PROVIDER.WEAVE_ROUTER, {
      env: { WEAVE_ROUTER_KEY: "rk", WEAVE_API_KEY: "wk" },
    });
    assert.equal(provider.id, "weave-router");
  });

  it("honours Router endpoint overrides", () => {
    const provider = createProvider(PROVIDER.WEAVE_ROUTER, {
      env: { WEAVE_ROUTER_KEY: "rk", WEAVE_API_KEY: "wk", WEAVE_ROUTER_BASE_URL: "https://router.staging.example" },
    });
    assert.equal(provider.envFor({ cluster: "low" }).ANTHROPIC_BASE_URL, "https://router.staging.example");
  });

  it("rejects an unknown provider", () => {
    assert.throws(() => createProvider("openai"), /unknown provider "openai"/);
  });
});

describe("client-reported cost", () => {
  it("reads total_cost_usd off the terminal result event", () => {
    assert.deepEqual(clientReportedCost({ total_cost_usd: 0.42 }), { cost: 0.42, error: null });
    assert.deepEqual(clientReportedCost({ total_cost_usd: 0 }), { cost: 0, error: null });
  });

  // Unknown, never zero: a crashed or non-reporting CLI must not present a
  // billed run as free.
  it("reports unknown when the CLI reported no usable cost", () => {
    for (const event of [null, {}, { total_cost_usd: "0.4" }, { total_cost_usd: -1 }, { total_cost_usd: Number.NaN }]) {
      const { cost, error } = clientReportedCost(event);
      assert.equal(cost, null);
      assert.match(error, /did not report total_cost_usd/);
    }
  });

  it("is what anthropic and inherit report, labelled as client-reported", async () => {
    for (const provider of [anthropicProvider(), inheritProvider()]) {
      assert.equal(provider.costLabel, "client-reported cost");
      assert.deepEqual(
        await provider.resolveCost({ sessionId: "s", resultEvent: { total_cost_usd: 1.5 } }),
        { cost: 1.5, error: null },
      );
    }
  });
});
