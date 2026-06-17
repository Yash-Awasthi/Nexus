import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarTrigger,
} from "./ui/sidebar";
import { Badge } from "./ui/badge";
import {
  HomeIcon,
  BotIcon,
  MessagesSquareIcon,
  BookOpenIcon,
  SettingsIcon,
  UserIcon,
  BrainIcon,
  UsersIcon,
} from "lucide-react";

const meta: Meta = {
  title: "Components/Sidebar",
  parameters: {
    layout: "fullscreen",
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof meta>;

const navItems = [
  { icon: HomeIcon, label: "Dashboard", href: "/" },
  { icon: BotIcon, label: "Agents", href: "/agents" },
  { icon: MessagesSquareIcon, label: "Chat", href: "/chat" },
  { icon: BookOpenIcon, label: "Knowledge Bases", href: "/knowledge-bases" },
  { icon: BrainIcon, label: "Memory", href: "/memory" },
  { icon: UsersIcon, label: "Contacts", href: "/contacts" },
];

const adminItems = [
  { icon: UserIcon, label: "Users", href: "/admin/users" },
  { icon: SettingsIcon, label: "System", href: "/admin/system" },
];

export const Default: Story = {
  render: () => (
    <SidebarProvider>
      <div style={{ display: "flex", height: "100vh", width: "100%" }}>
        <Sidebar>
          <SidebarHeader style={{ padding: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <BotIcon size={20} />
              <span style={{ fontWeight: 600, fontSize: "14px" }}>AI Council</span>
              <Badge variant="secondary" style={{ marginLeft: "auto" }}>Beta</Badge>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild>
                        <a href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Admin</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild>
                        <a href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter style={{ padding: "0.75rem" }}>
            <div style={{ fontSize: "11px", opacity: 0.5, textAlign: "center" }}>
              AI Council v1.0.0
            </div>
          </SidebarFooter>
        </Sidebar>

        <main style={{ flex: 1, padding: "2rem" }}>
          <SidebarTrigger />
          <h1 style={{ marginTop: "1rem", fontSize: "24px", fontWeight: 600 }}>
            Main Content Area
          </h1>
          <p style={{ marginTop: "0.5rem", opacity: 0.7 }}>
            This is where the page content renders alongside the sidebar.
          </p>
        </main>
      </div>
    </SidebarProvider>
  ),
};

export const CollapsedByDefault: Story = {
  render: () => (
    <SidebarProvider defaultOpen={false}>
      <div style={{ display: "flex", height: "100vh", width: "100%" }}>
        <Sidebar>
          <SidebarHeader style={{ padding: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <BotIcon size={20} />
              <span style={{ fontWeight: 600, fontSize: "14px" }}>AI Council</span>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild>
                        <a href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <main style={{ flex: 1, padding: "2rem" }}>
          <SidebarTrigger />
          <h1 style={{ marginTop: "1rem", fontSize: "24px", fontWeight: 600 }}>
            Sidebar Collapsed
          </h1>
          <p style={{ opacity: 0.7 }}>Click the trigger button to expand the sidebar.</p>
        </main>
      </div>
    </SidebarProvider>
  ),
};
