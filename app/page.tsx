import { redirect } from "next/navigation";

// ARK (incident command) is the main web surface; DOVE lives at /dove/[residentId].
export default function Home() {
  redirect("/ark");
}
