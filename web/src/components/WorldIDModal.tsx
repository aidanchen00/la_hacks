"use client";

import { IDKitRequestWidget, orbLegacy, type RpContext } from "@worldcoin/idkit";

const APP_ID = (process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "") as `app_${string}`;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "prana-verify";
const RP_ID = process.env.NEXT_PUBLIC_WORLD_RP_ID ?? "";

export default function WorldIDModal({
  rpContext,
  onVerified,
  onClose,
}: {
  rpContext: RpContext;
  onVerified: (nullifier: string) => void;
  onClose: () => void;
}) {
  return (
    <IDKitRequestWidget
      open={true}
      onOpenChange={(o) => { if (!o) onClose(); }}
      app_id={APP_ID}
      action={ACTION}
      rp_context={rpContext}
      allow_legacy_proofs={true}
      preset={orbLegacy()}
      handleVerify={async (result) => {
        const response = await fetch("/api/verify-world-id", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rp_id: RP_ID, idkitResponse: result }),
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error ?? "Verification failed");
        }
      }}
      onSuccess={(result) => {
        const item = result?.responses?.[0];
        const nullifier = (item && "nullifier" in item ? item.nullifier : "") ?? "";
        onVerified(nullifier);
        onClose();
      }}
    />
  );
}
