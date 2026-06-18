"use client"

import * as React from "react"
import { PlusIcon, Trash2Icon, PencilIcon, FileTextIcon, XIcon, FolderOpenIcon } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Textarea } from "~/components/ui/textarea"
import { Badge } from "~/components/ui/badge"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "~/components/ui/dialog"

// ─── Types ──────────────────────────────────────────────────────────────────

interface DocumentSet {
  id: string
  name: string
  description: string | null
  isPublic: boolean
  memberCount?: number
  createdAt: string
  updatedAt: string
}

interface DocumentSetMember {
  id: string
  documentSetId: string
  documentId: string
  documentTitle: string
  documentSource: string | null
  addedAt: string
}

interface DocumentSetManagerProps {
  /** Base API URL, defaults to "/api/document-sets" */
  apiBase?: string
  /** Called when a set is selected for scoping a conversation */
  onSelectSet?: (set: DocumentSet) => void
  /** Optional class name */
  className?: string
}

// ─── API helpers ────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message ?? `Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ─── Component ──────────────────────────────────────────────────────────────

export function DocumentSetManager({
  apiBase = "/api/document-sets",
  onSelectSet,
  className,
}: DocumentSetManagerProps) {
  const [sets, setSets] = React.useState<DocumentSet[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Create dialog state
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createName, setCreateName] = React.useState("")
  const [createDescription, setCreateDescription] = React.useState("")
  const [creating, setCreating] = React.useState(false)

  // Edit dialog state
  const [editSet, setEditSet] = React.useState<DocumentSet | null>(null)
  const [editName, setEditName] = React.useState("")
  const [editDescription, setEditDescription] = React.useState("")
  const [editing, setEditing] = React.useState(false)

  // Members panel state
  const [activeSetId, setActiveSetId] = React.useState<string | null>(null)
  const [members, setMembers] = React.useState<DocumentSetMember[]>([])
  const [membersLoading, setMembersLoading] = React.useState(false)
  const [addDocId, setAddDocId] = React.useState("")
  const [adding, setAdding] = React.useState(false)

  // ─── Load sets ────────────────────────────────────────────────────────────

  const loadSets = React.useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await apiFetch<DocumentSet[]>(apiBase)
      setSets(data)
    } catch (err: any) {
      setError(err.message ?? "Failed to load document sets")
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  React.useEffect(() => {
    loadSets()
  }, [loadSets])

  // ─── Create ───────────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!createName.trim()) return
    try {
      setCreating(true)
      await apiFetch<{ success: boolean; id: string }>(apiBase, {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          description: createDescription.trim() || undefined,
        }),
      })
      setCreateName("")
      setCreateDescription("")
      setCreateOpen(false)
      await loadSets()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  function openEdit(set: DocumentSet) {
    setEditSet(set)
    setEditName(set.name)
    setEditDescription(set.description ?? "")
  }

  async function handleEdit() {
    if (!editSet || !editName.trim()) return
    try {
      setEditing(true)
      await apiFetch<{ success: boolean }>(`${apiBase}/${editSet.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || undefined,
        }),
      })
      setEditSet(null)
      await loadSets()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setEditing(false)
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await apiFetch<{ success: boolean }>(`${apiBase}/${id}`, {
        method: "DELETE",
      })
      if (activeSetId === id) {
        setActiveSetId(null)
        setMembers([])
      }
      await loadSets()
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── Members ──────────────────────────────────────────────────────────────

  async function loadMembers(setId: string) {
    try {
      setMembersLoading(true)
      const data = await apiFetch<DocumentSetMember[]>(`${apiBase}/${setId}/members`)
      setMembers(data)
      setActiveSetId(setId)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setMembersLoading(false)
    }
  }

  async function handleAddDocument() {
    if (!activeSetId || !addDocId.trim()) return
    try {
      setAdding(true)
      await apiFetch<{ success: boolean }>(`${apiBase}/${activeSetId}/members`, {
        method: "POST",
        body: JSON.stringify({ documentIds: [addDocId.trim()] }),
      })
      setAddDocId("")
      await loadMembers(activeSetId)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemoveDocument(documentId: string) {
    if (!activeSetId) return
    try {
      await apiFetch<{ success: boolean }>(
        `${apiBase}/${activeSetId}/members/${documentId}`,
        { method: "DELETE" },
      )
      await loadMembers(activeSetId)
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const activeSet = sets.find((s) => s.id === activeSetId)

  return (
    <div className={className}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Document Sets</h2>
          <p className="text-xs text-muted-foreground">
            Curated subsets of your knowledge base for scoped search
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              New Set
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Document Set</DialogTitle>
              <DialogDescription>
                Group documents together to scope search for agents or conversations.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Input
                placeholder="Set name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              <Textarea
                placeholder="Description (optional)"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="icon-xs" onClick={() => setError(null)}>
            <XIcon />
          </Button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <p className="py-8 text-center text-xs text-muted-foreground">Loading document sets...</p>
      )}

      {/* Empty */}
      {!loading && sets.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
          <FolderOpenIcon className="size-8 opacity-40" />
          <p className="text-xs">No document sets yet</p>
          <p className="text-xs">Create one to scope your knowledge base searches.</p>
        </div>
      )}

      {/* Grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sets.map((set) => (
          <Card
            key={set.id}
            size="sm"
            className={activeSetId === set.id ? "ring-2 ring-primary/50" : ""}
          >
            <CardHeader className="border-b">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate text-xs font-semibold">{set.name}</CardTitle>
                  {set.description && (
                    <CardDescription className="mt-0.5 line-clamp-2 text-[0.6875rem]">
                      {set.description}
                    </CardDescription>
                  )}
                </div>
                {set.isPublic && <Badge variant="secondary">Public</Badge>}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FileTextIcon className="size-3" />
                  {set.memberCount ?? 0} docs
                </span>
              </div>
            </CardContent>
            <CardFooter className="flex items-center gap-1 border-t pt-3">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => loadMembers(set.id)}
              >
                <FileTextIcon data-icon="inline-start" />
                Docs
              </Button>
              <Button variant="ghost" size="xs" onClick={() => openEdit(set)}>
                <PencilIcon data-icon="inline-start" />
                Edit
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => handleDelete(set.id)}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete
              </Button>
              {onSelectSet && (
                <Button
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() => onSelectSet(set)}
                >
                  Use
                </Button>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* Members panel */}
      {activeSet && (
        <div className="mt-4 rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold">
              Documents in "{activeSet.name}"
            </h3>
            <Button variant="ghost" size="icon-xs" onClick={() => setActiveSetId(null)}>
              <XIcon />
            </Button>
          </div>

          {/* Add document */}
          <div className="mb-3 flex items-center gap-2">
            <Input
              placeholder="Document ID to add"
              value={addDocId}
              onChange={(e) => setAddDocId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddDocument()}
              className="flex-1"
            />
            <Button
              size="sm"
              onClick={handleAddDocument}
              disabled={adding || !addDocId.trim()}
            >
              {adding ? "Adding..." : "Add"}
            </Button>
          </div>

          {/* Members list */}
          {membersLoading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading...</p>
          ) : members.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No documents in this set yet
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((member) => (
                <li key={member.id} className="flex items-center gap-2 py-2">
                  <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {member.documentTitle || member.documentId}
                    </p>
                    {member.documentSource && (
                      <p className="truncate text-[0.625rem] text-muted-foreground">
                        {member.documentSource}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleRemoveDocument(member.documentId)}
                  >
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editSet} onOpenChange={(open) => !open && setEditSet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Document Set</DialogTitle>
            <DialogDescription>Update the name or description of this set.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              placeholder="Set name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleEdit()}
            />
            <Textarea
              placeholder="Description (optional)"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSet(null)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={editing || !editName.trim()}>
              {editing ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
