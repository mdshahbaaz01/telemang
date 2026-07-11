import { expect, test } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";

type CapturedRequest = {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startVerifyServer() {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.startsWith("/verify/Shadow_pointbot")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html>
            <head><title>Verify</title></head>
            <body>
              <main data-testid="verify-root">
                <h1>Verify</h1>
                <p data-testid="signin-status">Loading Telegram session…</p>
                <p data-testid="api-status">Waiting for API…</p>
              </main>
              <script>
                (async () => {
                  const webApp = window.Telegram && window.Telegram.WebApp;
                  const user = webApp && webApp.initDataUnsafe && webApp.initDataUnsafe.user;
                  const signedIn = user && String(user.id) === '8451018562';
                  document.querySelector('[data-testid="signin-status"]').textContent = signedIn
                    ? 'Signed in as ' + user.first_name + ' #' + user.id
                    : 'Not signed in';
                  const response = await fetch('/x1/verify', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
                    body: JSON.stringify({ initData: webApp && webApp.initData, userId: user && user.id })
                  });
                  const json = await response.json();
                  document.querySelector('[data-testid="api-status"]').textContent = json.status === 'ok'
                    ? 'Verification request delivered'
                    : 'Verification request failed';
                })().catch((error) => {
                  document.querySelector('[data-testid="api-status"]').textContent = error.message;
                });
              </script>
            </body>
          </html>`);
        return;
      }

      if (req.url?.startsWith("/x1/verify")) {
        captured.push({
          url: req.url,
          method: req.method ?? "GET",
          headers: req.headers,
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("mini-app verify flow renders in a tile and signs in with Telegram init data", async ({ page, baseURL }) => {
  const verifyServer = await startVerifyServer();
  try {
    const accountId = "3c0e7426-4009-4ada-a1e4-9091bacf7a16";
    const initData = new URLSearchParams({
      query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
      user: JSON.stringify({ id: 8451018562, first_name: "Shadow", username: "Shadow_point" }),
      auth_date: "1783753938",
      hash: "test_hash",
    }).toString();
    const target = `${verifyServer.origin}/verify/Shadow_pointbot`;
    const proxyPath = `/api/public/miniapp-proxy/${encodeURIComponent(target)}?a=${encodeURIComponent(accountId)}#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppPlatform=android&tgWebAppVersion=8.0`;

    await page.goto("/");
    await page.setContent(`<iframe title="Verify tile" src="${baseURL}${proxyPath}" style="width:420px;height:640px;border:0"></iframe>`);

    const frame = page.frameLocator('iframe[title="Verify tile"]');
    await expect(frame.getByTestId("verify-root")).toBeVisible();
    await expect(frame.getByTestId("signin-status")).toContainText("Signed in as Shadow #8451018562");
    await expect(frame.getByTestId("api-status")).toHaveText("Verification request delivered");

    expect(verifyServer.captured).toHaveLength(1);
    expect(verifyServer.captured[0].method).toBe("POST");
    expect(verifyServer.captured[0].url).toBe("/x1/verify");
    expect(verifyServer.captured[0].headers["content-type"]).toContain("application/json");
    expect(verifyServer.captured[0].headers["user-agent"]).toContain("Mobile");
    expect(JSON.parse(verifyServer.captured[0].body)).toMatchObject({ userId: 8451018562 });
  } finally {
    await verifyServer.close();
  }
});