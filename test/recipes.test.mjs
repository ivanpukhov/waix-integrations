import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const key = "f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb";
const run = new Function(
  "inputData",
  await readFile(
    new URL("../zapier/build-request.js", import.meta.url),
    "utf8",
  ),
);
const sample = {
  operation: "message",
  event_id: key,
  connection_id: key,
  phone: "+77071234567",
  whatsapp_consent: "true",
  template: "order_ready",
  language: "ru",
  variable: 'Иван "A"\nАлматы',
  id: key,
  code: "012345",
};
test("Zapier creates escaped JSON and requires consent, stable id and strict phone", () => {
  const result = run(sample);
  assert.equal(result.idempotency_key, key);
  assert.equal(
    JSON.parse(result.body).template.components[0].parameters[0].text,
    sample.variable,
  );
  for (const bad of [
    { event_id: "" },
    { phone: "87071234567" },
    { whatsapp_consent: "false" },
    { connection_id: "bad" },
    { operation: "arbitrary" },
    { variable: "" },
  ])
    assert.throws(() => run({ ...sample, ...bad }));
});
test("Zapier OTP and status requests match API v1", () => {
  assert.equal(
    JSON.parse(run({ ...sample, operation: "otp_verify" }).body).code,
    "012345",
  );
  assert.equal(
    JSON.parse(run({ ...sample, operation: "otp_send" }).body).ttl,
    300,
  );
  assert.throws(() => run({ ...sample, operation: "otp_send", ttl: "30" }));
  for (const operation of ["otp_status", "message_status"]) {
    const result = run({ ...sample, operation });
    assert.equal(result.method, "GET");
    assert.equal(result.body, "");
    assert.ok(result.url.endsWith(key));
  }
});
test("Make and Zapier have identical endpoint recipes, no live secrets", async () => {
  const paths = ["make", "zapier"];
  const values = [];
  for (const path of paths) {
    const data = JSON.parse(
      await readFile(
        new URL(`../${path}/requests.json`, import.meta.url),
        "utf8",
      ),
    );
    values.push(data);
    for (const request of Object.values(data)) {
      assert.match(request.url, /^https:\/\/waix.kz\/api\/v1\//);
      assert.match(request.headers.Authorization, /^Bearer YOUR_/);
      if (request.method === "GET") assert.equal(request.body, undefined);
    }
  }
  assert.deepEqual(values[0], values[1]);
});
