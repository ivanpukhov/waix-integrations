[Русский](README.md)

# WAIX + Zapier

Use **Webhooks by Zapier → Custom Request**. This recipe uses Zapier's HTTP action; it is not a published native WAIX app. Webhooks by Zapier requires a compatible paid Zapier plan; check [Zapier's documentation](https://help.zapier.com/hc/en-us/articles/8496083355661-How-to-get-started-with-Webhooks-by-Zapier).

1. Trigger: an order/form event from your server. Provide an `event_id` UUID saved with that event, an E.164 phone number and the template variables.
2. Filter: recipient consent exists and required fields are filled. Avoid triggering from every intermediate update to the same order.
3. Action: **Webhooks by Zapier → Custom Request**. Method POST. URL `https://waix.kz/api/v1/messages`. Data Pass-Through: No. Unflatten: No. Basic Auth: empty.
4. Headers: `Content-Type: application/json`, `Authorization: Bearer YOUR_WAIX_KEY`, `Idempotency-Key: <mapped event_id>`. Keep the Zap private and use a dedicated restricted key. Do not export or share a configured Zap containing a real key.
5. Body: use `requests.json`. Replace the connection ID and template with your own; map recipient and variables. Produce JSON with a JSON serializer (for example a Code by Zapier step using `JSON.stringify`) before the Custom Request action so quotes and line breaks in names cannot break it.
6. Save `data.id`. A successful action queues the message; it does not prove delivery. Review the WAIX journal or process delivery webhooks through a signature-validating backend.

To add OTP, use the `/otp/send` and `/otp/verify` requests and a separate OTP project key. Your own authenticated server must bind each challenge ID to the user's session and rate-limit attempts. Do not send OTP codes, sandbox test codes or API secrets to analytics or shared Zap logs.

Keep Catch Hook URLs on your server. Do not expose them in a website form: anyone with that URL could trigger the Zap. For timeout/replay, reuse the original event UUID; never generate a new key inside a retried action.
