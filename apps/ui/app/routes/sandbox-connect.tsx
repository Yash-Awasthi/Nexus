// SPDX-License-Identifier: Apache-2.0
/**
 * Setup guide for the local sandbox helper.
 *
 * The browser app cannot ask the hosted API to run code on the viewer's machine,
 * so it talks to a helper on http://127.0.0.1:4789 instead. This page is the
 * whole installation: build the image, start the helper, pair, and what the
 * helper can and cannot reach.
 */
import { Link } from "react-router";

import { Page, PageHeader } from "~/components/page";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

const HELPER_URL = "http://127.0.0.1:4789";

function Command({ children }: { children: string }) {
  return (
    <pre className="rounded-lg bg-muted p-3 text-xs font-mono overflow-auto whitespace-pre-wrap">
      {children}
    </pre>
  );
}

export default function SandboxConnect() {
  return (
    <Page width="default">
      <PageHeader
        title="Connect the local sandbox"
        description="Run code in a container on your own machine, driven by this page."
      />

      <div className="space-y-4 max-w-3xl">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Why a helper</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              The server this page is served from cannot reach your computer's loopback interface,
              and it should not: that would be a remote shell. Code you run from the Sandbox page in
              a browser is therefore sent to a small process on your machine at{" "}
              <code className="text-foreground">{HELPER_URL}</code>, which runs it in the same image
              the server uses.
            </p>
            <p>
              The desktop app does not need this: it starts its own API and its own sandbox on the
              same machine.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">1. Build the image</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>From a checkout of this repository, with Docker running:</p>
            <Command>{"docker build -t nexus-sandbox:local infra/sandbox"}</Command>
            <p>
              The image carries Node, Python, TypeScript (tsx), Bash, Go, Rust and Ruby. It is the
              same image the compose stack uses.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">2. Start the helper</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Node 26 or newer. The helper has no third-party dependencies.</p>
            <Command>{"pnpm install\npnpm --filter @nexus/sandbox-helper start"}</Command>
            <p>
              It listens on <code className="text-foreground">127.0.0.1:4789</code> and prints a
              six-digit pairing code. Restarting it ends every pairing, so keep it running while you
              use the page.
            </p>
            <p>
              Pages served from a host other than the local development ports must be named when the
              helper starts, or the helper refuses their origin:
            </p>
            <Command>
              {
                "NEXUS_HELPER_ORIGINS=https://nexus-iosc.onrender.com pnpm --filter @nexus/sandbox-helper start"
              }
            </Command>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">3. Pair this browser</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              On the{" "}
              <Link to="/sandbox" className="text-foreground underline underline-offset-4">
                Sandbox
              </Link>{" "}
              page, choose <span className="text-foreground">Connect local sandbox</span> and type
              the code the helper printed. The token is kept in this browser only; it is bound to
              this origin and lasts until the helper stops.
            </p>
            <p>
              If the helper is not running, the page says{" "}
              <span className="text-foreground">local sandbox: not connected</span> and runs code on
              the server instead.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">What the helper can and cannot reach</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <ul className="list-disc pl-5 space-y-1">
              <li>It binds loopback only. Nothing on your network can call it.</li>
              <li>
                Containers start with <code className="text-foreground">--network=none</code>, a
                read-only root filesystem, a scratch tmpfs, no Linux capabilities and uid 1000, so
                code inside has no network, no host files and no privileges.
              </li>
              <li>
                A run is capped at 30 seconds and 64 KiB of output, and only one run happens at a
                time.
              </li>
              <li>
                Only the configured image runs. A request cannot choose another one;{" "}
                <code className="text-foreground">NEXUS_SANDBOX_IMAGE</code> and{" "}
                <code className="text-foreground">NEXUS_SANDBOX_IMAGES</code> decide it at startup.
              </li>
              <li>
                It never sees your account, your keys or your files. Results are reported back to
                this page, and the page stores them in your run history.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
