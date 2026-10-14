import { redirect } from "next/navigation";

// Dynamic so the old URL answers with a real 307 instead of a static meta refresh.
export const dynamic = "force-dynamic";

/** Lend and Borrow are one page now (ui-redesign-spec §5). */
export default function BorrowPage() {
  redirect("/0xFi/lend?tab=borrow");
}
