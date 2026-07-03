// SPDX-License-Identifier: Apache-2.0
/**
 * Collaborative Rooms — shared AI sessions where multiple users
 * see responses in real-time.
 *
 * API:
 *   POST /api/rooms            — create room (host)
 *   POST /api/rooms/join/:code — join room with invite code
 *   GET  /api/rooms/:id        — get room info
 *   DELETE /api/rooms/:id      — delete room (host)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Users,
  Plus,
  Link2,
  Copy,
  Check,
  Loader2,
  LogIn,
  Trash2,
  MessageSquare,
  Radio,
  ArrowRight,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Room {
  id: string;
  name?: string;
  inviteCode: string;
  hostUserId: number;
  conversationId: string;
  participantCount?: number;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Rooms() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [creating, setCreating] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [err, setErr] = useState("");

  // Fetch rooms on mount — try to get user's rooms
  // (API may return only hosted rooms; we maintain local state for joined rooms too)
  useEffect(() => {
    // Rooms list isn't explicitly provided by the backend, so we load from localStorage cache
    const cached = localStorage.getItem("nexus_rooms");
    if (cached) {
      try {
        setRooms(JSON.parse(cached));
      } catch {}
    }
  }, []);

  const saveRooms = useCallback((updated: Room[]) => {
    setRooms(updated);
    localStorage.setItem("nexus_rooms", JSON.stringify(updated));
  }, []);

  const createRoom = useCallback(async () => {
    setCreating(true);
    setErr("");
    try {
      const r = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoomName.trim() || undefined }),
      });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Create failed");
        return;
      }
      const data = await r.json();
      const room: Room = data.room ?? data;
      saveRooms([room, ...rooms]);
      setCurrentRoom(room);
      setShowCreate(false);
      setNewRoomName("");
    } catch {
      setErr("Create failed");
    } finally {
      setCreating(false);
    }
  }, [newRoomName, rooms, saveRooms]);

  const joinRoom = useCallback(async () => {
    const code = inviteCode.trim();
    if (!code) return;
    setJoining(true);
    setErr("");
    try {
      const r = await fetch(`/api/rooms/join/${code}`, { method: "POST" });
      if (!r.ok) {
        const d = await r.json();
        setErr(d.error ?? "Join failed");
        return;
      }
      const data = await r.json();
      const room: Room = data.room ?? data;
      saveRooms([room, ...rooms.filter((rm) => rm.id !== room.id)]);
      setCurrentRoom(room);
      setShowJoin(false);
      setInviteCode("");
    } catch {
      setErr("Join failed");
    } finally {
      setJoining(false);
    }
  }, [inviteCode, rooms, saveRooms]);

  const deleteRoom = useCallback(
    async (room: Room) => {
      if (!confirm("Delete this room? All participants will lose access.")) return;
      try {
        await fetch(`/api/rooms/${room.id}`, { method: "DELETE" });
        const updated = rooms.filter((r) => r.id !== room.id);
        saveRooms(updated);
        if (currentRoom?.id === room.id) setCurrentRoom(null);
      } catch {}
    },
    [rooms, currentRoom, saveRooms],
  );

  const copyInviteLink = useCallback((room: Room) => {
    const link = `${window.location.origin}/rooms?join=${room.inviteCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopiedId(room.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  const copyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(code);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, []);

  // On load, check for ?join= query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get("join");
    if (joinCode) {
      setInviteCode(joinCode);
      setShowJoin(true);
    }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radio className="w-6 h-6 text-rose-500" />
            Collaborative Rooms
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Share a live AI session with teammates — everyone sees the same responses
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowJoin(true)}>
            <LogIn className="w-4 h-4 mr-1" />
            Join room
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-1" />
            New room
          </Button>
        </div>
      </div>

      {err && <p className="text-red-500 text-sm">{err}</p>}

      {/* Room detail / active view */}
      {currentRoom && (
        <Card className="border-rose-200 dark:border-rose-800 bg-rose-50/30 dark:bg-rose-950/10">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Radio className="w-4 h-4 text-rose-500" />
                  {currentRoom.name ?? `Room ${currentRoom.id.slice(-8)}`}
                  <Badge className="text-xs bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">
                    Live
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Created {timeAgo(currentRoom.createdAt)}
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setCurrentRoom(null)}
              >
                ×
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Invite code */}
            <div className="flex items-center gap-2 bg-background rounded-lg p-2.5 border">
              <code className="text-sm font-mono flex-1 select-all">{currentRoom.inviteCode}</code>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => copyCode(currentRoom.inviteCode)}
              >
                {copiedId === currentRoom.inviteCode ? (
                  <>
                    <Check className="w-3 h-3 mr-1 text-green-500" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 mr-1" />
                    Copy code
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => copyInviteLink(currentRoom)}
              >
                {copiedId === currentRoom.id ? (
                  <>
                    <Check className="w-3 h-3 mr-1 text-green-500" />
                    Link copied
                  </>
                ) : (
                  <>
                    <Link2 className="w-3 h-3 mr-1" />
                    Copy link
                  </>
                )}
              </Button>
            </div>

            {/* Join chat button */}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  window.location.href = `/chat/${currentRoom.conversationId}`;
                }}
              >
                <MessageSquare className="w-4 h-4 mr-2" />
                Open shared chat
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Share the invite code or link with teammates. Anyone who joins will see AI responses
              live.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Room list */}
      {rooms.length === 0 ? (
        <Card>
          <CardContent className="pt-12 pb-12 text-center space-y-4">
            <Users className="w-12 h-12 mx-auto text-muted-foreground opacity-40" />
            <div>
              <p className="font-medium">No rooms yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create a room to start a shared AI session, or join one with an invite code
              </p>
            </div>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={() => setShowJoin(true)}>
                <LogIn className="w-4 h-4 mr-2" />
                Join with code
              </Button>
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create room
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {rooms.length} room{rooms.length > 1 ? "s" : ""}
          </p>
          {rooms.map((room) => (
            <Card
              key={room.id}
              className={`hover:bg-accent/30 transition-colors cursor-pointer ${
                currentRoom?.id === room.id ? "border-rose-400" : ""
              }`}
              onClick={() => setCurrentRoom(room)}
            >
              <CardContent className="pt-3 pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-rose-100 dark:bg-rose-900/50 flex items-center justify-center">
                      <Radio className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {room.name ?? `Room ${room.id.slice(-8)}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {room.participantCount !== undefined
                          ? `${room.participantCount} participant${room.participantCount !== 1 ? "s" : ""} · `
                          : ""}
                        Created {timeAgo(room.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-muted-foreground hidden sm:block">
                      {room.inviteCode}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        copyInviteLink(room);
                      }}
                    >
                      {copiedId === room.id ? (
                        <Check className="w-3 h-3 text-green-500" />
                      ) : (
                        <Link2 className="w-3 h-3" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRoom(room);
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* How it works */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs font-medium mb-2">How rooms work</p>
          <ol className="space-y-1 text-xs text-muted-foreground list-decimal list-inside">
            <li>Create a room — you get a unique invite code</li>
            <li>Share the invite code or link with your team</li>
            <li>Everyone joins the same conversation thread</li>
            <li>AI responses are visible to all participants in real-time via WebSocket</li>
          </ol>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Room</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Room name (optional)"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createRoom()}
            />
            {err && <p className="text-red-500 text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={createRoom} disabled={creating}>
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Join dialog */}
      <Dialog open={showJoin} onOpenChange={setShowJoin}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Join Room</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Invite code"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              className="font-mono"
            />
            {err && <p className="text-red-500 text-xs">{err}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowJoin(false)}>
              Cancel
            </Button>
            <Button onClick={joinRoom} disabled={joining || !inviteCode.trim()}>
              {joining ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <LogIn className="w-4 h-4 mr-2" />
              )}
              Join
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
