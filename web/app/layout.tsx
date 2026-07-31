import { Agentation } from "agentation";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { mdIo, mdUi, mdUiXl, mdUiXs } from "@/app/fonts";
import { Providers } from "@/components/providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import "./globals.css";

export const metadata: Metadata = {
  title: "Epode",
  description: "Structured feedback from customer agents",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={cn(mdUi.variable, mdUiXs.variable, mdUiXl.variable, mdIo.variable)}>
      <body>
        <Providers>
          <TooltipProvider>{children}</TooltipProvider>
        </Providers>
        {process.env.NODE_ENV === "development" && <Agentation endpoint="http://localhost:4747" />}
      </body>
    </html>
  );
}
