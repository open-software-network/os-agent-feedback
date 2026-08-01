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
      <a href={startPath}>Continue with OS Accounts</a>
    </main>
  );
}
