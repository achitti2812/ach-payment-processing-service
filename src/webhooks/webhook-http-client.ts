export interface WebhookHttpResponse {
  status: number;
}

export interface WebhookHttpClient {
  post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<WebhookHttpResponse>;
}

export class FetchWebhookHttpClient implements WebhookHttpClient {
  async post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<WebhookHttpResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    return { status: response.status };
  }
}
