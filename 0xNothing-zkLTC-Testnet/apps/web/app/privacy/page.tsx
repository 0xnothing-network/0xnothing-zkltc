import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "0xWallet Privacy Policy | 0xNothing",
  description: "Privacy policy for the 0xWallet Chrome extension.",
  alternates: {
    canonical: "/privacy",
  },
};

const sections = [
  {
    title: "Scope",
    body: (
      <>
        <p>
          This Privacy Policy describes how the 0xWallet Chrome extension handles
          information. 0xWallet is a self-custodial EVM wallet for LitVM LiteForge
          testnet. The extension does not require a 0xNothing account.
        </p>
      </>
    ),
  },
  {
    title: "Data handled",
    body: (
      <>
        <p>0xWallet handles only information needed to provide wallet features:</p>
        <ul>
          <li>
            <strong>Authentication information:</strong> the wallet password,
            recovery phrase, imported private keys, and the derived unlock key.
          </li>
          <li>
            <strong>Financial and payment information:</strong> public wallet
            addresses, balances, transaction history, signing requests, and
            transaction data.
          </li>
          <li>
            <strong>Wallet configuration:</strong> account labels, selected and
            custom networks, custom tokens, security settings, and approved dApp
            connections.
          </li>
          <li>
            <strong>dApp interaction information:</strong> the requesting page
            origin and JSON-RPC method needed to expose the EIP-1193/EIP-6963
            provider, enforce site permissions, and show approval requests.
          </li>
        </ul>
        <p>
          The extension does not read page content, form contents, personal
          communications, or a list of the user&apos;s general browsing history.
        </p>
      </>
    ),
  },
  {
    title: "Local storage and security",
    body: (
      <>
        <p>
          Recovery phrases and imported private keys are stored only on the
          user&apos;s device inside an AES-GCM-encrypted vault. They are never stored
          in plaintext and are never uploaded to 0xNothing, an RPC provider, an
          indexer, or a dApp.
        </p>
        <p>
          While the wallet is unlocked, only the derived encryption key and the
          auto-lock deadline are kept in Chrome session storage. Session data is
          removed when the wallet locks or the browser session ends. Persistent
          wallet data remains until the user removes it or resets the wallet.
        </p>
      </>
    ),
  },
  {
    title: "Network requests",
    body: (
      <>
        <p>The extension communicates with:</p>
        <ul>
          <li>
            LitVM LiteForge or a user-selected custom RPC endpoint to read public
            blockchain state, estimate gas, broadcast a user-approved signed
            transaction, and retrieve its receipt.
          </li>
          <li>
            0xNothing and Goldsky endpoints to retrieve public 0xPump and 0xFi
            token, pool, metadata, and market information.
          </li>
          <li>
            A dApp selected by the user when the user approves a connection,
            signature, or transaction request.
          </li>
        </ul>
        <p>
          These services receive the request data required to answer it and may
          receive standard connection information such as an IP address under
          their own policies. Public addresses, contract calls, and broadcast
          transactions may be visible on the public blockchain. Passwords,
          recovery phrases, private keys, and derived unlock keys are never sent.
        </p>
      </>
    ),
  },
  {
    title: "Chrome permissions",
    body: (
      <ul>
        <li>
          <strong>Storage</strong> saves the encrypted vault, wallet settings,
          public account metadata, transaction history, and dApp approvals on the
          device, and keeps the temporary unlock key in session storage.
        </li>
        <li>
          <strong>Alarms</strong> maintains a pending dApp approval workflow while
          Chrome may suspend the Manifest V3 service worker. The alarm is removed
          when no approval is pending.
        </li>
        <li>
          <strong>Host access</strong> exposes the wallet provider to dApps and
          permits the RPC and public market-data requests described above. Access
          to a custom RPC origin is requested only after the user adds that
          network.
        </li>
      </ul>
    ),
  },
  {
    title: "Remote code",
    body: (
      <p>
        0xWallet does not use remotely hosted code. All executable JavaScript is
        bundled with the extension. Network responses are treated only as data and
        are never evaluated or executed as JavaScript or WebAssembly.
      </p>
    ),
  },
  {
    title: "Use and disclosure",
    body: (
      <>
        <p>
          Information is used only to provide and secure the wallet features
          described above. 0xNothing does not sell wallet data, use it for
          personalized advertising, allow human review of wallet secrets, or use
          it to determine creditworthiness or lending eligibility.
        </p>
        <p>
          Information is disclosed only when necessary to complete a user-requested
          RPC, indexing, dApp, or blockchain operation, or when required by law.
        </p>
      </>
    ),
  },
  {
    title: "User control and deletion",
    body: (
      <>
        <p>
          Users can lock the wallet, revoke dApp connections, remove custom
          networks or tokens, or reset the wallet from its settings. Uninstalling
          the extension removes its local Chrome storage. Information already
          published to a blockchain cannot be altered or deleted by 0xNothing.
        </p>
      </>
    ),
  },
  {
    title: "Website hosting",
    body: (
      <p>
        The website hosting this policy may use Vercel Web Analytics when enabled
        to measure aggregate website performance. This website analytics service
        is separate from 0xWallet and is not embedded in the extension.
      </p>
    ),
  },
  {
    title: "Changes and contact",
    body: (
      <>
        <p>
          This policy may be updated when wallet functionality or data handling
          changes. The current version and effective date will remain available on
          this page.
        </p>
        <p>
          Privacy questions can be sent to{" "}
          <a href="mailto:0xnothing.network@gmail.com">
            0xnothing.network@gmail.com
          </a>
          .
        </p>
      </>
    ),
  },
] as const;

export default function PrivacyPage() {
  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-black text-white">
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        aria-hidden="true"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage: "linear-gradient(to bottom, black, transparent 82%)",
        }}
      />

      <header className="relative z-10 border-b border-white/10 px-5 py-5 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <Link
            href="/"
            className="text-[11px] uppercase tracking-[0.3em] text-white/80 transition-colors hover:text-white"
          >
            0xNothing
          </Link>
          <span className="text-[9px] uppercase tracking-[0.28em] text-white/35">
            0xWallet / Privacy
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-5 py-14 sm:px-6 sm:py-20">
        <div className="max-w-3xl">
          <p className="mb-5 text-[10px] uppercase tracking-[0.32em] text-emerald-300/70">
            0xWallet
          </p>
          <h1 className="text-3xl uppercase tracking-[-0.04em] sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-6 max-w-2xl text-sm leading-7 text-white/55">
            Effective August 30, 2026. This policy explains what the extension
            handles, what stays on the device, and what is sent to network
            services when the user requests a wallet operation.
          </p>
        </div>

        <div className="mt-14 border-t border-white/12">
          {sections.map((section, index) => (
            <section
              key={section.title}
              className="grid gap-5 border-b border-white/10 py-8 md:grid-cols-[180px_minmax(0,1fr)] md:gap-12 md:py-10"
            >
              <h2 className="text-[10px] uppercase tracking-[0.26em] text-white/45">
                {String(index + 1).padStart(2, "0")} / {section.title}
              </h2>
              <div className="space-y-4 text-[13px] leading-7 text-white/65 [&_a]:text-emerald-200 [&_a]:underline [&_a]:decoration-white/20 [&_a]:underline-offset-4 [&_li]:pl-1 [&_strong]:font-normal [&_strong]:text-white/90 [&_ul]:list-square [&_ul]:space-y-2 [&_ul]:pl-5">
                {section.body}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="relative z-10 border-t border-white/10 px-5 py-6 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 text-[9px] uppercase tracking-[0.28em] text-white/30">
          <span>0xWallet · LitVM LiteForge Testnet</span>
          <Link href="/" className="transition-colors hover:text-white/70">
            Back to 0xNothing
          </Link>
        </div>
      </footer>
    </div>
  );
}
