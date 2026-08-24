"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  return (
    <button
      type="button"
      // The icon swap is the only visual feedback, so the name has to carry it
      // for anyone who cannot see it.
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={async () => {
        // Absent outside secure contexts, and can reject when the page lacks
        // clipboard permission.
        if (!navigator.clipboard) return;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute right-3 top-3 z-10 inline-flex size-7 items-center justify-center rounded-md border bg-background/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground [&_svg]:size-3.5"
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}
