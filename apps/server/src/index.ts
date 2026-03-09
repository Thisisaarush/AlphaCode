import { createServer } from "node:http";
import { APP_NAME, healthResponseSchema } from "@alpha-code/shared";

const port = Number(process.env.PORT ?? 3030);

const server = createServer((request, response) => {
  if (request.url === "/health") {
    const payload = healthResponseSchema.parse({
      ok: true,
      appName: APP_NAME,
      timestamp: new Date().toISOString()
    });

    response.writeHead(200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(payload));
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(
    JSON.stringify({
      appName: APP_NAME,
      message: "Alpha Code server scaffold is running."
    })
  );
});

server.listen(port, () => {
  console.log(`${APP_NAME} server listening on http://localhost:${port}`);
});
