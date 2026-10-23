import { registerHooks } from "node:module";

// Both runtimes use the same NextResponse stub; production Next.js has its own integration gate.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return { url: new URL("./next-server.js", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "next/headers") {
      return { url: new URL("./next-headers.js", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
