import { redirect } from "next/navigation";

export default function DashboardRedirect() {
  redirect("https://app.epode.ai/auth/start");
}
