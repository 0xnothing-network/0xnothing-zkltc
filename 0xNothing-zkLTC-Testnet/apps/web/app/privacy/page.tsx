import type { Metadata } from "next";
import Link from "next/link";
import "./privacy.css";

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
          testnet. The extension does not require a 0xNothing account. Assets on
          this testnet are test assets and have no monetary value.
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
            custom networks, a custom RPC address for LitVM LiteForge, custom
            tokens, security and display settings, and approved dApp connections.
          </li>
          <li>
            <strong>Records the wallet keeps for the user:</strong> recent
            recipients and the names given to them, a record of the token
            approvals signed from the wallet, a send form draft kept for up to
            ten minutes, and, when notifications are on, the text of
            notifications already shown. A history export is a CSV file the user
            saves on their own device.
          </li>
          <li>
            <strong>dApp interaction information:</strong> the origin and page
            title of a site that sends a request, the JSON-RPC method, and the
            content of the request (a transaction, a message or typed data to
            sign, or a token or network suggestion), as needed to expose the
            EIP-1193/EIP-6963 provider, enforce site permissions, and show
            approval requests. When the user opens the Dapp screen from the
            toolbar, the origin of the current tab is read to show whether that
            site is connected; it is not stored.
          </li>
        </ul>
        <p>
          All of the above is kept on the user&apos;s device. The extension does
          not read the content of web pages, form contents, or personal
          communications, and does not record the user&apos;s general browsing
          history; it stores only the origins of sites the user connected or
          that sent a wallet request.
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
        <p>
          The wallet locks by itself after a period without use (15 minutes by
          default; the user can choose from 1 to 60 minutes), when the computer
          is locked, and whenever the user chooses Lock now.
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
            The LitVM LiteForge RPC endpoint, or an RPC endpoint the user chose,
            to read public blockchain state, estimate gas, broadcast a
            user-approved signed transaction, and retrieve its receipt. These
            requests contain the account&apos;s public address. An RPC endpoint
            the user chose can be a custom network added in Settings, a custom
            RPC address set for LitVM LiteForge, or a network a website
            suggested and the user approved.
          </li>
          <li>
            A website can ask the wallet provider for public blockchain data
            (for example a balance or a contract read). The wallet forwards such
            read-only calls to the active RPC endpoint, as injected wallets do.
          </li>
          <li>
            0xNothing and Goldsky endpoints to retrieve public 0xPump and 0xFi
            token, pool, metadata, and market information. These requests never
            contain the wallet address. To show the 24-hour change on Home, the
            wallet asks for the price history of the 0xPump tokens the account
            holds, by token contract address; together with the IP address of
            the request, that can tell the server which of those tokens a user
            holds.
          </li>
          <li>
            Token images, loaded through the 0xNothing image proxy or from
            public IPFS gateways (dweb.link, ipfs.io, and Pinata gateways).
          </li>
          <li>
            A dApp selected by the user when the user approves a connection,
            signature, or transaction request. A site receives the account
            address only after the user connects that account to it.
          </li>
        </ul>
        <p>
          These services receive the request data required to answer it and may
          receive standard connection information such as an IP address under
          their own policies. Public addresses, contract calls, and broadcast
          transactions may be visible on the public blockchain. Passwords,
          recovery phrases, private keys, and derived unlock keys are never sent.
          The extension contains no analytics, advertising, telemetry, or error
          reporting code.
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
          <strong>Alarms</strong> runs the auto-lock timer, maintains a pending
          dApp approval workflow while Chrome may suspend the Manifest V3
          service worker, and, only when notifications are on, checks whether a
          pending transaction has confirmed. An alarm is removed when it is no
          longer needed.
        </li>
        <li>
          <strong>Idle</strong> tells the wallet that the computer was locked, so
          that the wallet locks too. It is used for nothing else.
        </li>
        <li>
          <strong>Side panel</strong> lets the user keep the wallet open beside
          a page in Chrome&apos;s side panel.
        </li>
        <li>
          <strong>Active tab</strong> lets the wallet, after the user opens it
          from the toolbar or with its keyboard shortcut, read the origin of the
          current tab to show whether that site is connected. Nothing from the
          tab is stored.
        </li>
        <li>
          <strong>Notifications</strong> is optional and is requested only when
          the user turns notifications on in Settings. The wallet then reports
          when one of its own transactions confirms or fails, and when a site
          request is waiting. A notification about a transaction that a website
          requested shows that website&apos;s host name. Turning notifications
          off returns the permission.
        </li>
        <li>
          <strong>Host access</strong> permits the RPC and public market-data
          requests described above. Access to another RPC origin is requested
          only when the user adds or approves that network or RPC address, one
          origin at a time, and is given back when no saved network uses it.
        </li>
        <li>
          <strong>Content scripts</strong> run on every http and https page and
          frame to expose the wallet provider to dApps. They add the provider
          and relay wallet requests; they do not read or change page content,
          forms, or cookies.
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
        <p>
          The use of information received by 0xWallet complies with the Chrome
          Web Store User Data Policy, including the Limited Use requirements.
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
          networks or tokens, rename or remove saved recipients, turn
          notifications off, return to the default RPC address, or reset the
          wallet from its settings. Uninstalling
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
        The website hosting this policy is delivered through Cloudflare, which
        processes request data such as IP addresses to serve and protect the
        site. The website runs no analytics script. It is separate from 0xWallet
        and is not embedded in the extension.
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
    <div className="ox-privacy relative min-h-[100dvh] overflow-x-clip">
      <header className="relative z-10 border-b border-white/10 py-5">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 sm:px-6">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center text-xs text-white/80 transition-colors hover:text-white"
          >
            0xNothing
          </Link>
          <span className="text-xs text-white/35">
            0xWallet / Privacy
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-5 py-14 sm:px-6 sm:py-20">
        <div>
          <p className="mb-5 text-xs text-emerald-300/70">
            0xWallet
          </p>
          <h1 className="text-3xl uppercase tracking-[-0.04em] sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-6 max-w-2xl text-sm leading-7 text-white/55">
            Effective November 15, 2026. This policy explains what the extension
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
              <h2 className="text-xs leading-6 text-white/45">
                <span className="ox-privacy-num">{String(index + 1).padStart(2, "0")} /</span> {section.title}
              </h2>
              <div className="min-w-0 space-y-4 text-[13px] leading-7 text-white/65 [overflow-wrap:anywhere] [&_a]:text-emerald-200 [&_a]:underline [&_a]:decoration-white/20 [&_a]:underline-offset-4 [&_li]:pl-1 [&_strong]:font-normal [&_strong]:text-white/90 [&_ul]:list-square [&_ul]:space-y-2 [&_ul]:pl-5">
                {section.body}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 text-xs text-white/30 sm:px-6">
          <span>0xWallet · LitVM LiteForge Testnet</span>
          <Link href="/" className="inline-flex min-h-11 items-center transition-colors hover:text-(--text-1)">
            Back to 0xNothing
          </Link>
        </div>
      </footer>
    </div>
  );
}
