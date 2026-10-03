import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import "./home.css";

export const metadata: Metadata = {
  title: "0xNothing | Nothing to everything",
  description: "Create on-chain pixel art, launch tokens, and access 0xFi markets on LitVM.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "0xNothing | Nothing to everything",
    description: "0xPixel art, 0xPump launches, and 0xFi markets on LitVM.",
    url: "/",
    siteName: "0xNothing",
    images: [{ url: "/0xNothing.jpg", width: 1200, height: 630, alt: "0xNothing" }],
    type: "website",
  },
};

const links = [
  { href: "/0xPump", label: "0xPump", description: "Launch & discover tokens", tone: "dark" },
  { href: "/0xFi", label: "0xFi", description: "Swap, lend & earn", tone: "ghost" },
  { href: "/0xpixel", label: "0xPixel", description: "Create & collect pixel art", tone: "light" },
] as const;

export default function Home() {
  return (
    <div className="nothing-home">
      <header className="nothing-header">
        <div className="nothing-header-inner">
          <Link href="/" className="nothing-brand-link" aria-label="0xNothing home">
            <span className="nothing-mark">
              <Image
                src="/0xNothing.jpg"
                alt="0xNothing"
                width={32}
                height={32}
                priority
                className="nothing-mark-image"
              />
            </span>
            <span className="nothing-brand">0xNothing</span>
          </Link>

          <a
            href="https://x.com/0xnothing_net"
            target="_blank"
            rel="noopener noreferrer"
            className="nothing-x"
            aria-label="0xNothing on X (opens in a new tab)"
          >
            <svg className="nothing-x-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.966 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
          </a>
        </div>
      </header>

      <main className="nothing-main">
        <section className="nothing-stage" aria-labelledby="nothing-title">
          <p className="nothing-eyebrow">A creative ecosystem on LitVM</p>
          <h1 id="nothing-title" className="nothing-title">
            <span>Nothing</span>
            <span>to everything</span>
          </h1>
          <p className="nothing-intro">Create something. Make it yours.</p>

          <nav className="nothing-nav" aria-label="0xNothing apps">
            {links.map((link) => {
              const className = `nothing-link nothing-link-${link.tone}`;
              return (
                <Link key={link.href} href={link.href} className={className}>
                  <span className="nothing-link-heading">
                    <span>{link.label}</span>
                    <span className="nothing-link-arrow" aria-hidden="true">&gt;</span>
                  </span>
                  <span className="nothing-link-description">{link.description}</span>
                </Link>
              );
            })}
          </nav>
        </section>
      </main>

      <footer className="nothing-footer">
        <div className="nothing-footer-inner">
          <span className="nothing-network"><span className="nothing-network-mark" aria-hidden="true" />LitVM · Testnet</span>
          <nav className="nothing-footer-nav" aria-label="Resources">
            <Link href="/docs">Docs</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
