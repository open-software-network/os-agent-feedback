import { EpodeMark } from "@/components/epode-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Password gate for ACO reports. A plain form post keeps the gate working
 * with JavaScript disabled; the unlock route sets the HttpOnly access cookie
 * and redirects back to the report.
 */
export function AcoReportUnlock({ slug, showError }: { slug: string; showError: boolean }) {
  return (
    <main className="grid min-h-svh place-items-center bg-canvas px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
            <EpodeMark className="size-4" />
            <span className="text-xs font-medium uppercase tracking-[0.14em]">
              Epode · ACO Report
            </span>
          </div>
          <CardTitle>This report is protected</CardTitle>
          <CardDescription>Enter the password you were given to view it.</CardDescription>
        </CardHeader>
        <CardContent>
          <form method="post" action={`/aco-report/${slug}/unlock`} className="grid gap-3">
            {showError ? (
              <p className="text-sm text-destructive">That password was not correct.</p>
            ) : null}
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="Report password"
              aria-label="Report password"
              required
              autoFocus
            />
            <Button type="submit">View report</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
