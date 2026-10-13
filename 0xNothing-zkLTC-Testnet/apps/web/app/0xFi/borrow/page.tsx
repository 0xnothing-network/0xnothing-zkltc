import { redirect } from "next/navigation";

/** Lend and Borrow are one page now (ui-redesign-spec §5). */
export default function BorrowPage() {
  redirect("/0xFi/lend?tab=borrow");
}
