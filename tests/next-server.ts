export const NextResponse = {
  next: (init?: { request?: { headers?: Headers } }) => {
    const headers = new Headers();
    if (init?.request?.headers) {
      headers.set("x-middleware-override-headers", Array.from(init.request.headers.keys()).join(","));
      init.request.headers.forEach((value, key) => headers.set(`x-middleware-request-${key}`, value));
    }
    return new Response(null, { headers });
  },
  rewrite: (url: URL, init?: { request?: { headers?: Headers } }) => {
    const headers = new Headers({ "x-middleware-rewrite": url.href });
    if (init?.request?.headers) {
      headers.set("x-middleware-override-headers", Array.from(init.request.headers.keys()).join(","));
      init.request.headers.forEach((value, key) => headers.set(`x-middleware-request-${key}`, value));
    }
    return new Response(null, { headers });
  },
  redirect: (url: URL, init?: ResponseInit) => new Response(null, {
    status: init?.status ?? 307, headers: { location: url.href },
  }),
};
