import { describe, it, expect } from "vitest";
import { formDataToBody, readRequestBody } from "@/lib/request-body";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("formDataToBody", () => {
  it("keeps flat fields flat", () => {
    expect(formDataToBody(form([["status", "hola"], ["visibility", "public"]]))).toEqual({
      status: "hola",
      visibility: "public",
    });
  });

  it("collects `key[]` into an array (Tusky's media_ids)", () => {
    expect(formDataToBody(form([["status", "hola"], ["media_ids[]", "1"], ["media_ids[]", "2"]]))).toEqual({
      status: "hola",
      media_ids: ["1", "2"],
    });
    expect(formDataToBody(form([["media_ids[]", "7"]]))).toEqual({ media_ids: ["7"] });
  });

  it("nests `key[sub]` and `key[sub][]` like Rails", () => {
    expect(
      formDataToBody(
        form([
          ["poll[options][]", "uno"],
          ["poll[options][]", "dos"],
          ["poll[expires_in]", "3600"],
          ["poll[multiple]", "true"],
        ])
      )
    ).toEqual({ poll: { options: ["uno", "dos"], expires_in: "3600", multiple: "true" } });

    expect(formDataToBody(form([["push[data][alerts][follow]", "true"]]))).toEqual({
      push: { data: { alerts: { follow: "true" } } },
    });
  });

  it("last value wins for a repeated scalar key (Rack semantics)", () => {
    expect(formDataToBody(form([["a", "1"], ["a", "2"]]))).toEqual({ a: "2" });
  });
});

describe("readRequestBody", () => {
  it("returns a JSON body untouched", async () => {
    const request = new Request("https://local.example/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hola", media_ids: ["1", "2"] }),
    });
    expect(await readRequestBody(request)).toEqual({ status: "hola", media_ids: ["1", "2"] });
  });

  it("parses a form-encoded body with array keys", async () => {
    const request = new Request("https://local.example/api", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "status=hola&media_ids%5B%5D=1&media_ids%5B%5D=2",
    });
    expect(await readRequestBody(request)).toEqual({ status: "hola", media_ids: ["1", "2"] });
  });

  it("returns an empty object for an unparseable body", async () => {
    const request = new Request("https://local.example/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(await readRequestBody(request)).toEqual({});
  });
});
