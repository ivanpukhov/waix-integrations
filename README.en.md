[Русский](README.md)

# WAIX integrations

Importable n8n workflows and integration recipes for [WAIX API v1](https://waix.kz/docs). These are server-side examples. No credentials are included.

## n8n: import a workflow

Download a JSON file from `n8n/`, then choose **Import from file** in a new n8n workflow:

- `website-form.json`: your site's backend → approved WhatsApp template.
- `order-notification.json`: order event → approved order template.
- `otp-send.json`: request a WhatsApp authentication challenge.
- `otp-verify.json`: verify the code entered by a user.

The workflows use built-in Webhook, Code, If, HTTP Request and Respond to Webhook nodes. No community node installation is needed. They are inactive after import.

1. **Server webhook**: create Header Auth credentials: header `X-Workflow-Key`, value a long random secret. Only your backend calls this endpoint. Add rate limits and authentication to the public form/OTP endpoint on your backend; never put the workflow URL or secrets in frontend JavaScript.
2. **WAIX API**: create separate Header Auth credentials: header `Authorization`, value `Bearer YOUR_WAIX_API_KEY`. Message workflows need `messages:write`. OTP send/verify need a project key with `otp:send` / `otp:verify`. Begin with a sandbox project.
3. Message workflows: edit `connectionId`, `templateName`, `language` in **Prepare request**. The supplied mapping is for one body variable: `name` or `order_number`. Change the components to match your approved template exactly. These are examples, not templates automatically created in your Meta account.
4. Call the webhook from your server using the sample bodies below. Preserve `event_id` in your database: generate it once per logical notification and reuse it after a timeout. A new UUID means a new message. Automatic retries are off.
5. Inspect a test response, verify recipient consent and delivery status, then activate. A `202` response means queued, not delivered. Use WAIX webhooks or the message journal for final status.

Execution history and pinned data are disabled to avoid storing phone numbers and authentication codes. An OTP send response intentionally omits `test_code`; read the sandbox code through the authenticated WAIX API during backend tests. Do not return it to the user being authenticated.

### Website form

```json
{"event_id":"f5bf0474-d4b6-4ca5-bd1b-92e44f3ad0fb","phone":"+77071234567","name":"Aida","whatsapp_consent":true}
```

### Order notification

```json
{"event_id":"00dcd40d-ec60-4f65-8991-63ca7c775e47","phone":"+77071234567","order_number":"42","whatsapp_consent":true}
```

### OTP send

```json
{"event_id":"c6e29497-2fc5-4380-888e-699704be43c5","phone":"+77071234567"}
```

Keep the returned challenge ID in the authenticated server session that requested the code. The subsequent verify endpoint must accept only that session's challenge ID. The n8n workflow is an authenticated internal service; it does not implement your app's session binding or login policy.

### OTP verify

```json
{"id":"CHALLENGE_UUID_FROM_SEND","code":"123456"}
```

Handle invalid codes and expiry. Issue your application's session only after a successful WAIX verification. Apply your own account/IP rate limits; use WAIX limits as an additional boundary.

## Make and Zapier

See `make/README.md` and `zapier/README.md` for HTTP module settings and request bodies. These recipes do not claim a listed marketplace application. Each platform's account, billing and publishing requirements remain separate from WAIX.

## 1C and Bitrix24

See `1c/` for a server-side BSL function and `bitrix24/` for the event handling recipe. These are integration examples, not an extension installed automatically into an arbitrary 1C configuration or Bitrix24 portal.

## Checks

`node --test test/workflows.test.mjs` checks the workflow graph, validation, payloads, secret handling and response sanitization. Import acceptance and runtime evidence are recorded with each release.

License: MIT. WhatsApp, n8n, Make and Zapier are their respective owners' trademarks.
