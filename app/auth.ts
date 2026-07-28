import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import type { AppUser } from "../db/data";

export async function getAppUser(): Promise<AppUser | null> {
  const user = await getChatGPTUser();
  if (user) return { email: user.email, displayName: user.displayName };
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "";
  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) {
    return { email: "local.customer@example.com", displayName: "Local Customer" };
  }
  return null;
}

export async function requireAppUser(returnTo = "/app") {
  const user = await getAppUser();
  if (user) return user;
  redirect(chatGPTSignInPath(returnTo));
}

export async function requireApiUser() {
  return getAppUser();
}
