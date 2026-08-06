import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { acoReportLoaders } from "@/aco-reports/registry";
import { AcoReportUnlock } from "@/components/views/aco-report/aco-unlock";
import { ACO_COOKIE_PREFIX, reportPassword, tokenMatches } from "@/lib/aco/reports";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Protected report",
  robots: { index: false, follow: false },
};

export default async function AcoReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const password = reportPassword(slug);
  const loader = password ? acoReportLoaders[slug] : undefined;
  if (!password || !loader) {
    notFound();
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(`${ACO_COOKIE_PREFIX}${slug}`)?.value;
  if (!token || !tokenMatches(token, slug, password)) {
    const { error } = await searchParams;
    return <AcoReportUnlock slug={slug} showError={error === "1"} />;
  }

  const { default: Report } = await loader();
  return <Report />;
}
