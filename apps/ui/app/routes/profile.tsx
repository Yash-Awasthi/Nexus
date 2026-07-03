// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from "react";
import { useAuth } from "~/context/AuthContext";
import { cn } from "~/lib/utils";
import { useTheme } from "~/context/ThemeContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Separator } from "~/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  User,
  Mail,
  Shield,
  Pencil,
  Monitor,
  Sun,
  Moon,
  Download,
  Trash2,
  AlertTriangle,
  Loader2,
  Check,
} from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const PRESETS = [
  { value: "default", label: "Default" },
  { value: "business", label: "Business" },
  { value: "technical", label: "Technical" },
  { value: "personal", label: "Personal" },
  { value: "creative", label: "Creative" },
  { value: "ethical", label: "Ethical" },
  { value: "strategy", label: "Strategy" },
  { value: "debate", label: "Debate" },
  { value: "research", label: "Research" },
];

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export default function ProfilePage() {
  const { user } = useAuth();
  const displayName = user?.username ?? "User";
  const email = user?.email ?? "";
  const role = user?.role ?? "user";

  const [name, setName] = useState(displayName);
  const [customInstructions, setCustomInstructions] = useState(user?.customInstructions ?? "");
  const { theme: currentTheme, setTheme: applyTheme } = useTheme();
  const [themeSelection, setThemeSelection] = useState<"auto" | "light" | "dark">(
    currentTheme === "dark" ? "dark" : currentTheme === "light" ? "light" : "auto",
  );
  const [defaultPreset, setDefaultPreset] = useState("default");
  const [defaultRounds, setDefaultRounds] = useState("3");
  const [githubConnected, setGithubConnected] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Sync user data once loaded
  useEffect(() => {
    if (user) {
      setName(user.username ?? "");
      setCustomInstructions(user.customInstructions ?? "");
    }
  }, [user?.id]);

  const initials =
    (name || displayName)
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?";

  async function handleSaveInstructions() {
    setIsSavingInstructions(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_instructions: customInstructions }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? `Save failed (${res.status})`);
      }
      setInstructionsSaved(true);
      setTimeout(() => setInstructionsSaved(false), 2500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSavingInstructions(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        {/* Profile Header */}
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center size-16 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white text-xl font-semibold">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-muted-foreground">{email}</p>
            <Badge variant="secondary" className="mt-1">
              {role}
            </Badge>
          </div>
          <Button variant="outline" size="sm" onClick={() => setIsEditing(!isEditing)}>
            <Pencil className="size-3 mr-1" />
            {isEditing ? "Done" : "Edit Profile"}
          </Button>
        </div>

        {/* Profile Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-4" />
              Profile Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="full-name">Full Name</Label>
              <Input
                id="full-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isEditing}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Input id="email" value={email} disabled className="opacity-60" />
                <Mail className="absolute right-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <div>
                <Badge variant="outline" className="flex items-center gap-1 w-fit">
                  <Shield className="size-3" />
                  {role.charAt(0).toUpperCase() + role.slice(1)}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Custom Instructions */}
        <Card>
          <CardHeader>
            <CardTitle>Custom Instructions</CardTitle>
            <CardDescription>Customize how the AI council responds to your queries</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={customInstructions}
              onChange={(e) => {
                if (e.target.value.length <= 2000) {
                  setCustomInstructions(e.target.value);
                }
              }}
              rows={5}
              className="resize-none"
              placeholder="Enter custom instructions for the AI council..."
            />
            {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {customInstructions.length}/2000
              </span>
              <Button size="sm" onClick={handleSaveInstructions} disabled={isSavingInstructions}>
                {isSavingInstructions ? (
                  <Loader2 className="size-3 mr-1 animate-spin" />
                ) : instructionsSaved ? (
                  <Check className="size-3 mr-1 text-green-500" />
                ) : null}
                {isSavingInstructions ? "Saving..." : instructionsSaved ? "Saved" : "Save"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Appearance */}
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose your preferred theme</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {(
                [
                  { value: "auto", label: "Auto", icon: Monitor },
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <Button
                  key={value}
                  variant={themeSelection === value ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => {
                    setThemeSelection(value);
                    if (value === "auto") {
                      const prefersDark =
                        typeof window !== "undefined" &&
                        window.matchMedia("(prefers-color-scheme: dark)").matches;
                      applyTheme(prefersDark ? "dark" : "light");
                    } else {
                      applyTheme(value);
                    }
                  }}
                  className={cn(
                    "flex-1",
                    themeSelection === value && "ring-2 ring-primary/30 border-primary/50",
                  )}
                >
                  <Icon className="size-3.5 mr-1.5" />
                  {label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Council Defaults */}
        <Card>
          <CardHeader>
            <CardTitle>Council Defaults</CardTitle>
            <CardDescription>Configure default settings for new council sessions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Default Summon Preset</Label>
              <Select value={defaultPreset} onValueChange={setDefaultPreset}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Default Rounds</Label>
              <Select value={defaultRounds} onValueChange={setDefaultRounds}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} round{n !== 1 ? "s" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Connected Accounts */}
        <Card>
          <CardHeader>
            <CardTitle>Connected Accounts</CardTitle>
            <CardDescription>Manage your connected third-party accounts</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <GithubIcon className="size-4" />
                <span className="text-sm font-medium">GitHub</span>
                <Badge variant={githubConnected ? "default" : "outline"}>
                  {githubConnected ? "Connected" : "Not Connected"}
                </Badge>
              </div>
              <Button
                variant={githubConnected ? "destructive" : "outline"}
                size="sm"
                onClick={() => setGithubConnected(!githubConnected)}
              >
                {githubConnected ? "Disconnect" : "Connect"}
              </Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <GoogleIcon />
                <span className="text-sm font-medium">Google</span>
                <Badge variant={googleConnected ? "default" : "outline"}>
                  {googleConnected ? "Connected" : "Not Connected"}
                </Badge>
              </div>
              <Button
                variant={googleConnected ? "destructive" : "outline"}
                size="sm"
                onClick={() => setGoogleConnected(!googleConnected)}
              >
                {googleConnected ? "Disconnect" : "Connect"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-4" />
              Danger Zone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Delete All Conversations</p>
                <p className="text-xs text-muted-foreground">
                  Permanently remove all your conversation history
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="size-3 mr-1" />
                Delete All
              </Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Export My Data</p>
                <p className="text-xs text-muted-foreground">
                  Download all your data in a portable format
                </p>
              </div>
              <Button variant="outline" size="sm">
                <Download className="size-3 mr-1" />
                Export Data
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-4" />
                Delete All Conversations
              </DialogTitle>
              <DialogDescription>
                This action cannot be undone. All your conversation history will be permanently
                deleted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => setDeleteDialogOpen(false)}>
                <Trash2 className="size-3 mr-1" />
                Delete All
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
