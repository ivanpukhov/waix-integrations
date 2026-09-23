// Real n8n execution against a local mock. Never calls Meta or the live WAIX API.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const root = await mkdtemp(join(tmpdir(), "waix-n8n-runtime-"));
const container = "waix-n8n-check-" + randomUUID().slice(0, 8);
const image =
  "n8nio/n8n:2.40.5@sha256:9f693fd5565539efd5e75ad168526c8041a6af516d9e50bc4d9cb1c9c5031523";
const key = "f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb";
const slugs = [
  "website-form",
  "order-notification",
  "otp-send",
  "otp-verify",
  "otp-status",
];
let started = false;
try {
  await writeFile(
    join(root, "credentials.json"),
    JSON.stringify([
      {
        id: "waixFixtureIn",
        name: "Fixture incoming",
        type: "httpHeaderAuth",
        data: { name: "X-Workflow-Key", value: "fixture-incoming" },
      },
      {
        id: "waixFixtureOut",
        name: "Fixture WAIX",
        type: "httpHeaderAuth",
        data: { name: "Authorization", value: "Bearer fixture-waix" },
      },
    ]),
  );
  const flows = [];
  for (const slug of slugs) {
    const f = JSON.parse(
      await readFile(new URL(`../n8n/${slug}.json`, import.meta.url), "utf8"),
    );
    f.id = "waix-" + slug;
    for (const n of f.nodes) {
      if (n.name === "Server webhook")
        n.credentials = {
          httpHeaderAuth: { id: "waixFixtureIn", name: "Fixture incoming" },
        };
      if (n.name === "WAIX settings")
        for (const field of n.parameters.values.string) {
          if (field.name === "waix_connection_id") field.value = key;
          if (field.name === "waix_template") field.value = "order_ready";
        }
      if (n.name === "WAIX API") {
        n.credentials = {
          httpHeaderAuth: { id: "waixFixtureOut", name: "Fixture WAIX" },
        };
        n.parameters.url = n.parameters.url.replace(
          "https://waix.kz",
          "http://127.0.0.1:9099",
        );
        n.parameters.options.timeout = 1000;
      }
    }
    flows.push(f);
  }
  await writeFile(join(root, "flows.json"), JSON.stringify(flows));
  await writeFile(
    join(root, "mock.cjs"),
    String.raw`
 const {createServer}=require('http');
 const calls=[];
 createServer(async(req,res)=>{
  if(req.url==='/calls'){res.setHeader('content-type','application/json');res.end(JSON.stringify(calls));return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):{};calls.push({url:req.url,body,key:req.headers['idempotency-key'],auth:req.headers.authorization});
  res.setHeader('x-request-id','req-fixture');
  const variant=body.to||'';
  if(variant.endsWith('68')){res.writeHead(429,{'retry-after':'60'}).end('<html>rate limit</html>');return;}
  if(variant.endsWith('69')){req.socket.destroy();return;}
  if(variant.endsWith('70')){res.end('invalid success');return;}
  if(variant.endsWith('71'))return;
  res.writeHead(req.method==='GET'?200:202,{'content-type':'application/json'}).end(JSON.stringify({data:{id:'f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb',status:'queued',test_code:'012345'}}));
 }).listen(9099,'127.0.0.1');`,
  );
  const startup = `node /fixtures/mock.cjs &
 n8n import:credentials --input=/fixtures/credentials.json &&
 n8n import:workflow --input=/fixtures/flows.json &&
 ${slugs.map((s) => `n8n publish:workflow --id=waix-${s}`).join(" &&\n")} &&
 exec n8n start`;
  docker(
    "run",
    "-d",
    "--name",
    container,
    "--mount",
    `type=bind,src=${root},dst=/fixtures,readonly`,
    "-p",
    "127.0.0.1::5678",
    "-e",
    "N8N_DIAGNOSTICS_ENABLED=false",
    "-e",
    "N8N_VERSION_NOTIFICATIONS_ENABLED=false",
    "-e",
    "N8N_TEMPLATES_ENABLED=false",
    "-e",
    "N8N_ENCRYPTION_KEY=fixture-not-a-real-secret",
    "-e",
    "N8N_SECURE_COOKIE=false",
    "-e",
    "N8N_RUNNERS_MODE=internal",
    "-e",
    "N8N_LOG_LEVEL=warn",
    "--entrypoint",
    "sh",
    image,
    "-c",
    startup,
  );
  started = true;
  const address = "http://" + docker("port", container, "5678").trim();
  let ready = false;
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(address + "/healthz/readiness");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(ready, "n8n must become ready");
  const base = {
    event_id: key,
    phone: "+77071234567",
    name: 'Аида "A"',
    order_number: "42",
    whatsapp_consent: true,
    id: key,
    code: "012345",
  };
  const call = async (slug, body, auth = true) => {
    const r = await fetch(address + "/webhook/waix-" + slug, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { "X-Workflow-Key": "fixture-incoming" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: r.status, headers: r.headers, body: parsed };
  };
  for (let i = 0; i < 60; i++) {
    const probe = await call("website-form", {});
    if (probe.status === 400) break;
    if (i === 59) throw new Error("Published webhooks did not activate");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (const slug of slugs) {
    const good = await call(slug, base);
    assert.ok(
      [200, 202].includes(good.status),
      `${slug}: ${JSON.stringify(good)}`,
    );
    assert.equal(good.body.data.id, key);
    assert.equal(good.body.data.test_code, undefined);
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(good.headers.get("x-request-id"), "req-fixture");
    assert.equal((await call(slug, {})).status, 400);
    assert.equal((await call(slug, base, false)).status, 403);
  }
  for (const [suffix, status, code] of [
    ["68", 429, "INVALID_RESPONSE"],
    ["69", 502, "UPSTREAM_UNAVAILABLE"],
    ["70", 502, "INVALID_RESPONSE"],
    ["71", 502, "UPSTREAM_UNAVAILABLE"],
  ]) {
    const result = await call("otp-send", {
      ...base,
      phone: "+770712345" + suffix,
    });
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(result.body.code, code);
    if (status === 429) assert.equal(result.headers.get("retry-after"), "60");
  }
  const calls = JSON.parse(
    docker(
      "exec",
      container,
      "node",
      "-e",
      "fetch('http://127.0.0.1:9099/calls').then(r=>r.text()).then(console.log)",
    ),
  );
  assert.equal(
    calls.length,
    9,
    "invalid/unauthenticated inputs never reach API; no automatic retries",
  );
  assert.ok(calls.every((c) => c.auth === "Bearer fixture-waix"));
  assert.equal(calls[0].key, key);
  assert.equal(calls[3].body.code, "012345");
  assert.equal(calls[4].url, "/api/v1/otp/" + key);
  console.log(
    "n8n 2.40.5: 5 live webhooks, credentials, validation, JSON/HTML, status headers, socket reset and timeout passed. No external sends.",
  );
} catch (error) {
  if (started) console.error(docker("logs", "--tail", "55", container));
  throw error;
} finally {
  if (started) docker("rm", "-f", container);
  await rm(root, { recursive: true, force: true });
}
