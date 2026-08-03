import { authStartPath } from "@/lib/auth/return-to";

type SignInPageProps = {
  searchParams: Promise<{ return_to?: string | string[] }>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const returnTo = (await searchParams).return_to;
  const startPath = authStartPath(Array.isArray(returnTo) ? null : returnTo);
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-semibold">Sign in to Epode</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Ask customer agents questions, record their answers, and connect every response to the
        customer and session where it happened.
      </p>
      <a className="mt-5 inline-block underline" href={startPath}>
        Continue
      </a>
    </main>
  );
}
