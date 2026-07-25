import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "0xNothing | Nothing to everything",
  description: "Create on-chain pixel art and launch NUSD bonding-curve tokens on LitVM.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "0xNothing | Nothing to everything",
    description: "0xPixel art and 0xPump NUSD token markets on LitVM.",
    url: "/",
    siteName: "0xNothing",
    images: [{ url: "/0xNothing.jpg", width: 1200, height: 630, alt: "0xNothing" }],
    type: "website",
  },
};

const links = [
  { href: "/0xpixel", label: "0xPixel", tone: "light" },
  { href: "/0xpump", label: "0xPump", tone: "dark" },
] as const;

export default function Home() {
  return (
    <div className="nothing-home min-h-[100dvh] overflow-hidden">
      <div className="nothing-home-grid" />
      <div className="nothing-home-vignette" />

      <header className="nothing-header relative z-10 border-b border-white/[0.04] px-5 py-5 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/" className="group flex items-center gap-3" aria-label="0xNothing home">
            <span className="nothing-mark grid h-8 w-8 place-items-center border border-white/[0.08] bg-black">
              <Image
                src="/0xNothing.jpg"
                alt="0xNothing"
                width={32}
                height={32}
                priority
                className="h-7 w-7 object-cover opacity-90 transition-opacity duration-200 group-hover:opacity-100"
              />
            </span>
            <span className="nothing-brand text-[11px] uppercase tracking-[0.32em] text-white/72">0xNothing</span>
          </Link>

          <a
            href="https://x.com/0xnothing_net"
            target="_blank"
            rel="noopener noreferrer"
            className="nothing-x"
            aria-label="X / Twitter"
          >
            <svg className="nothing-x-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.966 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
          </a>
        </div>
      </header>

      <main className="nothing-main relative z-10 flex min-h-[calc(100dvh-147px)] items-center px-5 py-20 sm:px-6">
        <section className="nothing-stage mx-auto w-full max-w-5xl text-center">
          <div className="nothing-crosshair" aria-hidden="true" />
          <h1 className="nothing-title">
            <span>Nothing</span>
            <span>to everything</span>
          </h1>

          <nav className="nothing-nav mt-16 flex flex-col items-center justify-center gap-3 sm:flex-row" aria-label="0xNothing apps">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`nothing-link nothing-link-${link.tone}`}
              >
                <span>{link.label}</span>
                <span aria-hidden="true">&gt;</span>
              </Link>
            ))}
          </nav>
        </section>
      </main>

      <footer className="nothing-footer relative z-10 border-t border-white/[0.04] px-5 py-6 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-start text-[9px] uppercase tracking-[0.38em] text-white/[0.08]">
          <span>LitVm Testnet</span>
        </div>
      </footer>
    </div>
  );
}
