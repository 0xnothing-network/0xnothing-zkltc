import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ | 0xPump",
  description: "0xPump fees, READY status, NUSD, IPFS, and graduation.",
};

const FAQ_ITEMS = [
  {
    question: "What does it cost?",
    answer: "Creating a market costs 1 NUSD. Each buy and sell pays a 0.1% protocol fee.",
  },
  {
    question: "How does trading work?",
    answer: "Tokens trade against an on-chain NUSD bonding curve. Price changes with the curve reserves.",
  },
  {
    question: "What is READY?",
    answer: "A market reaches READY at a 6,000 NUSD market cap. On testnet, buys pause at READY and a sell can reopen the curve.",
  },
  {
    question: "How is NUSD minted?",
    answer: "NUSD is minted directly from zkLTC at the current DIA oracle price. The quoted NUSD is delivered in the same transaction and the zkLTC enters the protocol reserve.",
  },
  {
    question: "How is NUSD redeemed?",
    answer: "Redeeming burns NUSD directly from your wallet and returns the quoted zkLTC from the reserve. It does not require an approval transaction.",
  },
  {
    question: "Why can an approval appear?",
    answer: "The 0xPump Factory needs an allowance before it can spend NUSD for market actions. Direct NUSD redemption does not use an allowance.",
  },
  {
    question: "Where are token images stored?",
    answer: "Token logos and canonical metadata are pinned to public IPFS before the market is created.",
  },
  {
    question: "What happens after graduation?",
    answer: "Testnet remains on the curve. Mainnet will convert or bridge NUSD into zkLTC's official stablecoin before liquidity is listed through an audited DEX adapter.",
  },
] as const;

export default function PumpFaqPage() {
  return (
    <main className="pump-page pump-faq-page">
      <section className="pump-page-heading">
        <div><span className="pump-eyebrow">Reference</span><h1>FAQ</h1></div>
      </section>
      <dl className="pump-faq-list">
        {FAQ_ITEMS.map((item, index) => (
          <div key={item.question}>
            <dt><span>{String(index + 1).padStart(2, "0")}</span>{item.question}</dt>
            <dd>{item.answer}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
