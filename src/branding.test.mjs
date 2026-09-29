import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BRANDING,
  brandingFrom,
  brandingFromEnv,
  childCheckRunName,
} from "./branding.mjs";

describe("DEFAULT_BRANDING", () => {
  // Existing Weave check runs and comment markers are matched by these exact
  // strings; a drift here orphans every open PR's history.
  it("keeps the Weave defaults byte-identical", () => {
    assert.deepEqual({ ...DEFAULT_BRANDING }, {
      productName: "Weave Check",
      checkRunPrefix: "Weave Check",
      aggregateName: "Weave Checks",
      markerPrefix: "weave-check",
    });
  });
});

describe("brandingFrom", () => {
  it("keeps defaults for blank overrides", () => {
    assert.deepEqual(brandingFrom({ productName: "", markerPrefix: undefined }), DEFAULT_BRANDING);
  });

  it("applies overrides", () => {
    const branding = brandingFrom({ checkRunPrefix: "Acme Review", markerPrefix: "acme-review" });
    assert.equal(branding.checkRunPrefix, "Acme Review");
    assert.equal(branding.markerPrefix, "acme-review");
    assert.equal(branding.productName, "Weave Check");
  });

  it("rejects a marker prefix outside the slug vocabulary", () => {
    for (const markerPrefix of ["Acme", "acme review", "acme|.*", "acme-->"]) {
      assert.throws(() => brandingFrom({ markerPrefix }), /lowercase letters, digits, and hyphens/);
    }
  });

  it("rejects multi-line names", () => {
    assert.throws(() => brandingFrom({ aggregateName: "A\nB" }), /single line/);
    assert.throws(() => brandingFrom({ productName: " padded " }), /single line/);
  });

  it("reads the worker's environment", () => {
    const branding = brandingFromEnv({ WEAVE_CHECKS_AGGREGATE_NAME: "Acme Checks" });
    assert.equal(branding.aggregateName, "Acme Checks");
  });
});

describe("childCheckRunName", () => {
  it("joins the prefix and the check's display name", () => {
    assert.equal(childCheckRunName(DEFAULT_BRANDING, { name: "Naming Clarity" }), "Weave Check / Naming Clarity");
    assert.equal(
      childCheckRunName(brandingFrom({ checkRunPrefix: "Acme" }), { name: "Naming Clarity" }),
      "Acme / Naming Clarity",
    );
  });
});
