import * as React from "react";
import { useClient } from "sanity";
import { useVideoLadderConfig } from "./config.tsx";

// The Studio's calls to the host's video endpoint. Each carries the signed-in editor's Sanity token, which
// the host's `authorize` verifies. The token is only readable when the Studio config sets
// `auth.loginMethod: "token"`; under cookie auth it stays in an httpOnly cookie and `hasToken` is false.

export type VideoApiCall = <T extends object>(body: Record<string, unknown>, failure: string) => Promise<T>;

export function useVideoApi() {
  const { apiVersion, endpoint } = useVideoLadderConfig();
  const client = useClient({ apiVersion });
  const token = client.config().token;

  const call: VideoApiCall = React.useCallback(
    async (body, failure) => {
      const headers = new Headers({ "content-type": "application/json" });

      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }

      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || `${failure} (${response.status}).`);
      }

      return data as never;
    },
    [endpoint, token]
  );

  return { call, client, hasToken: Boolean(token) };
}
