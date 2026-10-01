// SPDX-License-Identifier: Apache-2.0
/** Accept a workspace invitation from its link. */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";

import { authFetch } from "~/lib/api";

export default function InvitationPage() {
  const { token } = useParams();
  const [message, setMessage] = useState("Joining…");
  const sent = useRef(false);

  useEffect(() => {
    // Accepting spends the invitation, so a second effect run must not ask again.
    if (sent.current) return;
    sent.current = true;
    void (async () => {
      try {
        const res = await authFetch(
          `/api/v1/workspaces/invitations/${encodeURIComponent(token ?? "")}`,
        );
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(
          res.ok
            ? "You joined the workspace."
            : body.error === "invitation_email_mismatch"
              ? "This invitation was sent to a different email. Sign in with that account."
              : "This invitation has expired or was already used.",
        );
      } catch {
        setMessage("Could not reach the server.");
      }
    })();
  }, [token]);

  return (
    <div className="mx-auto max-w-md space-y-3 p-4">
      <p role="status">{message}</p>
      <Link to="/workspaces" className="text-sm underline">
        Go to workspaces
      </Link>
    </div>
  );
}
