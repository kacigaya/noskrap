const call = async (method, args, signal) => {
  const response = await fetch(`${process.env.NOSKRAP_TEST_STORAGE_URL}/${method}`, {
    method: "POST", body: JSON.stringify(args), cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("test storage failed");
  return response.json();
};
export const config = {
  secret: process.env.NOSKRAP_TEST_SECRET,
  contextTtlMs: 60_000,
  protectedRoutes: ["/api/"],
  storage: {
    getVisitor: (id, signal) => call("getVisitor", [id], signal),
    setVisitor: (id, state, ttl, signal) => call("setVisitor", [id, state, ttl], signal),
    incrementCounter: (key, window, signal) => call("incrementCounter", [key, window], signal),
  },
};
export const verified = request => request.headers.get("x-test-proof") === "verified";
