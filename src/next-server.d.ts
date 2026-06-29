declare module "next/server" {
  export class NextResponse extends Response {
    cookies: {
      set(name: string, value: string, init?: ResponseCookieInit): void;
    };
    static next(): NextResponse;
    static redirect(url: URL | string, init?: ResponseInit): NextResponse;
  }

  export interface ResponseCookieInit {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    path?: string;
    maxAge?: number;
  }
}
