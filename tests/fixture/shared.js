const call = async (method, args) => {
  const response = await fetch(`${process.env.NOSKRAP_TEST_STORAGE_URL}/${method}`, {
    method: "POST", body: JSON.stringify(args), cache: "no-store",
  });
  if (!response.ok) throw new Error("test storage failed");
  return response.json();
};
export const config = {
  secret: process.env.NOSKRAP_TEST_SECRET,
  protectedRoutes: ["/api/"],
  storage: {
    getVisitor: (...args) => call("getVisitor", args),
    setVisitor: (...args) => call("setVisitor", args),
    incrementCounter: (...args) => call("incrementCounter", args),
  },
};
export const verified = request => request.headers.get("x-test-proof") === "verified";
