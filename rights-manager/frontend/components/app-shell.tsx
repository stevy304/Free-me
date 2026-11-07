"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, LogOut, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { when } from "@/components/shared";
import { api, type Notification } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useData } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload", label: "Upload" },
  { href: "/matches", label: "Matches" },
  { href: "/disputes", label: "Disputes" },
];

function Notifications() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { data, refresh } = useData(() => api<Notification[]>("/api/notifications"), [], { every: 15_000, poll: () => true });
  const unread = data?.filter((n) => !n.read).length ?? 0;

  async function show(v: boolean) {
    setOpen(v);
    if (v && unread) { await api("/api/notifications/read", { method: "POST" }).catch(() => undefined); void refresh(); }
  }

  return (
    <>
      <Button variant="ghost" size="icon" className="relative" onClick={() => show(true)} aria-label={`Notifications${unread ? ` (${unread} new)` : ""}`}>
        <Bell />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">{unread}</span>}
      </Button>
      <Dialog open={open} onOpenChange={show}>
        <DialogContent>
          <DialogHeader><DialogTitle>Notifications</DialogTitle></DialogHeader>
          {!data?.length ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="divide-y">
              {data.map((n) => (
                <li key={n.id}>
                  <button
                    className={cn("w-full py-3 text-left text-sm hover:text-primary", !n.read && "font-medium")}
                    onClick={() => { setOpen(false); if (n.link) router.push(n.link); }}
                  >
                    {n.text}
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{when(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="container flex h-14 items-center gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" /> <span className="hidden sm:inline">Rights Manager</span>
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn("rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground", path.startsWith(n.href) && "bg-secondary text-foreground")}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Notifications />
          <div className="hidden text-right text-xs leading-tight md:block">
            <div className="font-medium">@{user.username}</div>
            <div className="capitalize text-muted-foreground">{user.role}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out"><LogOut /></Button>
        </div>
      </header>
      <main className="container py-8">{children}</main>
    </div>
  );
}
