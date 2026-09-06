import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

const app = await buildApp();

afterAll(async () => {
  await app.close();
});

describe("GET /health/live", () => {
  it("reports that the process is alive", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("appears in OpenAPI with its actual response code", () => {
    const operation = app.swagger().paths?.["/health/live"]?.get;

    expect(operation).toBeDefined();
    expect(Object.keys(operation?.responses ?? {})).toEqual(["200"]);
  });
});
