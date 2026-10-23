let requestHeaders = new Headers();

export function setRequestHeaders(value: Headers): void {
  requestHeaders = new Headers(value);
}

export async function headers(): Promise<Headers> {
  return new Headers(requestHeaders);
}
