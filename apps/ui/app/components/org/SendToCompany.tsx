// SPDX-License-Identifier: Apache-2.0
import { Building2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { canManage, orgApi, type Company } from "~/lib/org";

/** Hand a council verdict to one of your companies; its top agent turns it into work. */
export function SendToCompany({ question, verdict }: { question: string; verdict: string }) {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [filed, setFiled] = useState<{ companyId: string; identifier: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = () =>
    orgApi<{ companies: Company[] }>("/companies")
      .then((b) => setCompanies(b.companies.filter(canManage)))
      .catch((e: Error) => setError(e.message));

  const send = (companyId: string) =>
    orgApi<{ identifier: string }>(`/companies/${companyId}/verdicts`, {
      method: "POST",
      json: { question, verdict },
    })
      .then((t) => setFiled({ companyId, identifier: t.identifier }))
      .catch((e: Error) => setError(e.message));

  if (filed)
    return (
      <Link
        to={`/org?c=${filed.companyId}&tab=tasks`}
        className="px-1 text-xs text-primary underline-offset-4 hover:underline"
        data-testid="verdict-filed"
      >
        Filed as {filed.identifier}
      </Link>
    );
  if (error) return <span className="text-xs text-destructive">{error}</span>;
  if (companies)
    return companies.length ? (
      <select
        aria-label="Send the verdict to a company"
        className="h-7 max-w-44 rounded-md border bg-background px-2 text-xs"
        defaultValue=""
        onChange={(e) => e.target.value && void send(e.target.value)}
      >
        <option value="">Send to company…</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    ) : (
      <Link to="/org" className="px-1 text-xs text-primary underline-offset-4 hover:underline">
        Create a company to act on this
      </Link>
    );
  return (
    <Button variant="ghost" size="sm" onClick={() => void open()} aria-label="Send to a company">
      <Building2 /> Turn into work
    </Button>
  );
}
