import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";

export default function NotFound() {
  return (
    <main className="pixel-not-found">
      <Link className="pixel-not-found-brand" href="/">0xNothing</Link>
      <div className="pixel-not-found-content">
        <p className="pixel-not-found-code" aria-hidden="true">404</p>
        <h1>Page not found</h1>
        <p>This page may have moved or the address may be incorrect.</p>
        <nav aria-label="Recovery links">
          <Link href="/">Back to home <ArrowRight size={14} aria-hidden="true" /></Link>
          <Link href="/docs">Read the docs <ArrowRight size={14} aria-hidden="true" /></Link>
        </nav>
      </div>
      <p className="pixel-not-found-network">LitVM Testnet</p>
    </main>
  );
}
