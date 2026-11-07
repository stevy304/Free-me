"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ErrorBox } from "@/components/shared";
import { api, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface TokenOut { access_token: string; user: User }

export default function LoginPage() {
  const { user, signIn } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (user) router.replace("/dashboard"); }, [user, router]);

  async function submit(path: string, body: Record<string, string>) {
    setBusy(true); setError(null);
    try {
      const r = await api<TokenOut>(path, { method: "POST", json: body });
      signIn(r.access_token, r.user);
      router.replace("/dashboard");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <ShieldCheck className="h-9 w-9 text-primary" />
          <CardTitle className="text-2xl">Rights Manager</CardTitle>
          <CardDescription>Register your original videos and find every re-upload.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="login" onValueChange={() => setError(null)}>
            <TabsList className="w-full">
              <TabsTrigger value="login">Sign in</TabsTrigger>
              <TabsTrigger value="register">Create account</TabsTrigger>
            </TabsList>
            <TabsContent value="login">
              <form
                className="space-y-4"
                onSubmit={(e) => { e.preventDefault(); void submit("/api/auth/login", { login: field(e.currentTarget, "login"), password: field(e.currentTarget, "password") }); }}
              >
                <div className="space-y-2"><Label htmlFor="login">Username or email</Label><Input id="login" name="login" autoComplete="username" required /></div>
                <div className="space-y-2"><Label htmlFor="password">Password</Label><Input id="password" name="password" type="password" autoComplete="current-password" required /></div>
                {error && <ErrorBox message={error} />}
                <Button className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Sign in</Button>
              </form>
            </TabsContent>
            <TabsContent value="register">
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  void submit("/api/auth/register", { username: field(f, "username"), email: field(f, "email"), password: field(f, "new-password") });
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input id="username" name="username" autoComplete="username" required minLength={3} maxLength={40} pattern="[A-Za-z0-9_.]+" title="Letters, numbers, dots and underscores" />
                </div>
                <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" required /></div>
                <div className="space-y-2"><Label htmlFor="new-password">Password</Label><Input id="new-password" name="new-password" type="password" autoComplete="new-password" required minLength={8} /></div>
                {error && <ErrorBox message={error} />}
                <Button className="w-full" disabled={busy}>{busy && <Loader2 className="animate-spin" />}Create account</Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  );
}
