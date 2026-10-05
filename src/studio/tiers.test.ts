import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFieldTiers } from "./tiers.ts";

test("a field without tiers uses the plugin's", () => {
  assert.deepEqual(resolveFieldTiers(undefined, [240, 720]), { tiers: [240, 720] });
  assert.deepEqual(resolveFieldTiers({ collapsible: true }, [240, 720]), { tiers: [240, 720] });
});

test("a field picks its own tiers from the plugin's", () => {
  assert.deepEqual(resolveFieldTiers({ tiers: [720] }, [240, 720, 1080]), { tiers: [720] });
  assert.deepEqual(resolveFieldTiers({ tiers: [1080, 720, 720] }, [240, 720, 1080]), { tiers: [720, 1080] });
  assert.deepEqual(resolveFieldTiers({ tiers: [] }, [240, 720]), { tiers: [] });
});

test("a tier the plugin does not list is left out and named", () => {
  const result = resolveFieldTiers({ tiers: [720, 1080, 2160] }, [240, 720]);
  assert.deepEqual(result.tiers, [720]);
  assert.match(result.warning ?? "", /asks for 1080p, 2160p, which videoLadder\(\{ tiers \}\) does not list\. Add them there/);
});

test("invalid field tiers fall back to the plugin's with a warning", () => {
  const result = resolveFieldTiers({ tiers: [721] }, [240, 720]);
  assert.deepEqual(result.tiers, [240, 720]);
  assert.match(result.warning ?? "", /Invalid tier 721.*Using 240, 720\./);
});
