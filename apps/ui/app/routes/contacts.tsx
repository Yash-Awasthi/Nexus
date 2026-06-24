// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Badge } from "~/components/ui/badge";
import { Users, Mail, Building, Send, CheckCircle, AlertCircle } from "lucide-react";

interface Contact {
  id: string;
  name: string;
  email: string;
  company?: string;
  notes?: string;
  createdAt: string;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");

  async function loadContacts() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/contacts");
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts ?? []);
      }
    } catch {
      // offline / no backend yet
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;

    setStatus(null);
    try {
      const res = await fetch("/api/v1/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), company: company.trim() || undefined, notes: notes.trim() || undefined }),
      });
      if (res.ok) {
        setName(""); setEmail(""); setCompany(""); setNotes("");
        setStatus({ type: "success", message: "Contact saved." });
        await loadContacts();
      } else {
        setStatus({ type: "error", message: "Failed to save contact." });
      }
    } catch {
      setStatus({ type: "error", message: "Network error — backend may be offline." });
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">Contacts</h1>
        <p className="text-muted-foreground text-sm">
          Manage your contacts. Backend persists contacts when a connector (e.g. Google Contacts, HubSpot) is configured.
        </p>
      </div>

      {/* Add contact form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="w-5 h-5" /> New Contact
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="email">Email *</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="company">Company</Label>
                <Input id="company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corp" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." rows={2} />
            </div>
            {status && (
              <div className={`flex items-center gap-2 text-sm ${status.type === "success" ? "text-green-600" : "text-red-600"}`}>
                {status.type === "success" ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                {status.message}
              </div>
            )}
            <Button type="submit" disabled={!name.trim() || !email.trim()}>
              <Send className="w-4 h-4 mr-2" /> Save Contact
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Contact list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Mail className="w-5 h-5" /> Saved Contacts ({contacts.length})
          </CardTitle>
          <CardDescription>
            <Button variant="outline" size="sm" onClick={loadContacts} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </Button>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {contacts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {loading ? "Loading contacts..." : "No contacts yet. Add one above."}
            </p>
          ) : (
            <div className="space-y-3">
              {contacts.map((c) => (
                <div key={c.id} className="flex items-start justify-between border-b pb-3 last:border-0">
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-sm text-muted-foreground">{c.email}</p>
                    {c.company && (
                      <Badge variant="secondary" className="mt-1">
                        <Building className="w-3 h-3 mr-1" /> {c.company}
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
