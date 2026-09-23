import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const key = "f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb";
for (const slug of [
  "website-form",
  "order-notification",
  "otp-send",
  "otp-verify",
  "otp-status",
]) {
  test(`n8n ${slug}: validation, every branch responds, secrets and error metadata`, async () => {
    const flow = JSON.parse(
      await readFile(new URL(`../n8n/${slug}.json`, import.meta.url), "utf8"),
    );
    assert.equal(flow.active, false);
    for (const flag of ["saveDataSuccessExecution", "saveDataErrorExecution"])
      assert.equal(flow.settings[flag], "none");
    assert.equal(flow.settings.saveManualExecutions, false);
    const nodes = Object.fromEntries(flow.nodes.map((n) => [n.name, n]));
    for (const [name, node] of Object.entries(flow.connections)) {
      assert.ok(nodes[name]);
      for (const branch of node.main)
        for (const edge of branch) assert.ok(nodes[edge.node]);
    }
    const prepare = new Function(
      "$json",
      nodes["Prepare request"].parameters.jsCode,
    );
    const config = {
      waix_connection_id: key,
      waix_template: "order_ready",
      waix_language: "ru",
      waix_otp_ttl: 300,
    };
    const run = (body) => prepare({ ...config, body })[0].json;
    for (const body of [null, [], {}, "text"])
      assert.equal(run(body).valid, false);
    const request = {
      event_id: key,
      phone: "+77071234567",
      whatsapp_consent: true,
      name: 'Иван "A"\nАлматы',
      order_number: "42",
      id: key,
      code: "012345",
    };
    const result = run(request);
    assert.equal(result.valid, true);
    if (slug === "otp-verify") {
      assert.deepEqual(result.body, { id: key, code: "012345" });
      for (const code of [123456, "12345", "1234567", "１２３４５６", null])
        assert.equal(run({ ...request, code }).valid, false);
    } else if (slug === "otp-status")
      assert.deepEqual(result.body, { id: key });
    else {
      assert.equal(result.idempotency_key, key);
      assert.equal(result.body.to, request.phone);
      for (const event_id of [123, null, "bad"])
        assert.equal(run({ ...request, event_id }).valid, false);
      for (const phone of [77071234567, "87071234567", "+7 abc", null])
        assert.equal(run({ ...request, phone }).valid, false);
    }
    if (["website-form", "order-notification"].includes(slug)) {
      assert.equal(run({ ...request, whatsapp_consent: false }).valid, false);
      const unconfigured = prepare({ body: request })[0].json;
      assert.equal(unconfigured.status, 500);
      assert.equal(unconfigured.code, "WORKFLOW_NOT_CONFIGURED");
    }
    assert.equal(
      nodes["Server webhook"].parameters.authentication,
      "headerAuth",
    );
    const http = nodes["WAIX API"];
    assert.equal(http.parameters.genericAuthType, "httpHeaderAuth");
    assert.equal(http.retryOnFail, undefined);
    assert.equal(http.onError, "continueErrorOutput");
    assert.equal(
      flow.connections["WAIX API"].main[1][0].node,
      "Transport error",
    );
    assert.equal(nodes["Transport error"].parameters.options.responseCode, 502);
    const normalize = new Function(
      "$json",
      nodes["Normalize response"].parameters.jsCode,
    );
    const sanitize = (input) => normalize(input)[0].json;
    const good = sanitize({
      statusCode: 202,
      body: JSON.stringify({ data: { id: key, test_code: "123456" } }),
      headers: { "x-request-id": "req-1" },
    });
    assert.equal(good.body.data.test_code, undefined);
    assert.equal(good.responseCode, 202);
    const error = sanitize({
      statusCode: 429,
      body: "<html>slow down</html>",
      headers: { "retry-after": "60", "x-request-id": "req-2" },
    });
    assert.equal(error.responseCode, 429);
    assert.ok(
      error.responseHeaders.some(
        (h) => h.name === "Retry-After" && h.value === "60",
      ),
    );
    assert.doesNotMatch(JSON.stringify(error), /<html>/);
    assert.equal(
      sanitize({ statusCode: 200, body: "not-json" }).responseCode,
      502,
    );
    assert.equal(
      sanitize({ statusCode: 302, body: "{}" }).body.code,
      "REDIRECT_DISALLOWED",
    );
    const injected = sanitize({
      statusCode: 500,
      body: "{}",
      headers: {
        "retry-after": "1\r\nInjected: yes",
        "x-request-id": "evil\r\n",
      },
    });
    assert.equal(injected.responseHeaders.length, 1);
    assert.match(nodes.Setup.parameters.content, /Настрой|срок|задайте/);
  });
}
