"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { RpContext } from "@worldcoin/idkit";

// ssr: false ensures WASM (used by IDKit v4 bridge) only loads in the browser
const WorldIDModal = dynamic(() => import("./WorldIDModal"), { ssr: false });

const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "prana-verify";
const RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID ?? "";

interface WorldIDGateProps {
  onVerified: (nullifierHash: string) => void;
}

export default function WorldIDGate({ onVerified }: WorldIDGateProps) {
  const [rpContext, setRpContext] = useState<RpContext | null>(null);

  const handleOpen = async () => {
    const rpSig = await fetch("/api/rp-signature", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: ACTION }),
    }).then((r) => r.json());

    setRpContext({
      rp_id: RP_ID,
      nonce: rpSig.nonce,
      created_at: rpSig.created_at,
      expires_at: rpSig.expires_at,
      signature: rpSig.sig,
    });
  };

  return (
    <>
      {rpContext && (
        <WorldIDModal
          rpContext={rpContext}
          onVerified={onVerified}
          onClose={() => setRpContext(null)}
        />
      )}
      <button
        onClick={handleOpen}
        className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg hover:bg-[#2A4D3D] transition-colors min-h-[56px] flex items-center justify-center gap-2.5"
      >
        <svg width="20" height="20" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <circle cx="14" cy="14" r="13" stroke="white" strokeWidth="2"/>
          <circle cx="14" cy="14" r="6" fill="white"/>
        </svg>
        Verify you&apos;re human to begin
      </button>
    </>
  );
}
