import { redirect } from "next/navigation";

export default function DashboardRedirect() {
  redirect("https://agent-feedback-api-production.up.railway.app/auth/start");
}
