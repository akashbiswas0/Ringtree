import { ArrowUpRight, GitBranch } from "lucide-react";
import "./landing.css";

export default function Landing() {
  return (
    <div className="landing">
      <header className="landing-header">
        <a className="landing-brand" href="/" aria-label="RingTree home">
          <GitBranch size={28} strokeWidth={1.8} aria-hidden="true" />
          <span>RingTree</span>
        </a>
        <a className="landing-enter" href="/workspace">
          enter <ArrowUpRight size={22} aria-hidden="true" />
        </a>
      </header>
      <main className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="landing-eyebrow">
            <span className="landing-typewriter">
              <span className="landing-typewriter-text">Agents act. You authorize.</span>
              <span className="landing-typewriter-cursor" aria-hidden="true" />
            </span>
          </p>
          <h1 id="landing-title">Autonomy.<br />In your hands.</h1>
          <p className="landing-description">
            Give your agents room to work.<br />
            Keep control with Ledger Flex.
          </p>
        </div>
        <div className="landing-art">
          <img
            src="/images/ledger-flex-hero.webp"
            alt="A hand holding a Ledger Flex, showing a transaction approval on its screen"
            width="1600"
            height="1283"
            fetchPriority="high"
          />
        </div>
      </main>
    </div>
  );
}
