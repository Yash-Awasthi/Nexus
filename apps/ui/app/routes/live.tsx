// SPDX-License-Identifier: Apache-2.0
/**
 * Watch a council answer as it streams, from a link its author copied. Joining
 * late or after a dropped connection replays everything said so far.
 *
 * Socket: /api/ws/channels/:id?key=&dir=read (see apps/api/src/lib/channels.ts)
 */
import { ChannelReader } from "@nexus/stream-recovery";
import { Loader2, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";

import { Page, PageHeader } from "~/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

interface Frame {
  type?: string;
  label?: string;
  text?: string;
  message?: string;
}

export default function LivePage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const key = params.get("key") ?? "";
  const [opinions, setOpinions] = useState<Record<string, string>>({});
  const [verdict, setVerdict] = useState("");
  const [state, setState] = useState<"waiting" | "live" | "done">("waiting");

  useEffect(() => {
    if (!id || !key) return;
    const base = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api`;
    const reader = new ChannelReader(base, { channel_id: id, access_key: key, direction: "read" });
    // Replayed frames arrive again after a reconnect, so each connection starts from empty.
    reader.onMessage((msg) => {
      let f: Frame;
      try {
        f = JSON.parse(msg) as Frame;
      } catch {
        return;
      }
      setState((s) => (s === "done" ? s : "live"));
      if (f.type === "opinion" && f.label)
        setOpinions((o) => ({ ...o, [f.label!]: (o[f.label!] ?? "") + (f.text ?? "") }));
      else if (f.type === "verdict") setVerdict((v) => v + (f.text ?? ""));
      else if (f.type === "done" || f.type === "error") setState("done");
    });
    return () => reader.close();
  }, [id, key]);

  return (
    <Page width="default">
      <PageHeader
        title="Live council"
        description={
          state === "done"
            ? "This answer has finished."
            : state === "live"
              ? "Streaming now."
              : "Waiting for the council…"
        }
        actions={
          state === "live" ? (
            <Radio className="size-5 animate-pulse text-destructive" aria-label="Live" />
          ) : state === "waiting" ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : null
        }
      />
      {!key && <p className="text-sm text-destructive">This link is missing its key.</p>}
      {Object.entries(opinions).map(([label, text]) => (
        <Card key={label}>
          <CardHeader>
            <CardTitle className="text-sm">{label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
          </CardContent>
        </Card>
      ))}
      {verdict && (
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="text-sm">Verdict</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap break-words">{verdict}</p>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
