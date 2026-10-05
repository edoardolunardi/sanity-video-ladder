"use client";

import { Card, Flex, Spinner, Stack, Text } from "@sanity/ui";
import type { Probe } from "./media.ts";

/** Inline compatibility status for the picked file: checking, ready, or unsupported (with guidance). */
export function ProbeNotice({ probe }: { probe: Probe }) {
  if (probe.state === "checking") {
    return (
      <Card border padding={2} radius={2} tone="transparent">
        <Flex align="center" gap={2}>
          <Spinner muted size={1} />
          <Text size={1} muted>
            Checking compatibility...
          </Text>
        </Flex>
      </Card>
    );
  }

  if (probe.state === "ok") {
    return (
      <Card border padding={2} radius={2} tone="positive">
        <Text size={1}>Ready: {probe.summary}</Text>
      </Card>
    );
  }

  return (
    <Card border padding={3} radius={2} tone="critical">
      <Stack gap={2}>
        <Text size={1} weight="semibold">
          This file can't be processed in the browser
        </Text>
        <Text size={1} muted>
          {probe.summary}
        </Text>
        <Text size={1}>{probe.reason}</Text>
      </Stack>
    </Card>
  );
}
