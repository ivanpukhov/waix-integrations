[Русский](README.md)

# WAIX + Make

Use **HTTP → Make a request** after your form/order trigger. This is an HTTP integration recipe, not a listed WAIX Make app. [Make's HTTP documentation](https://apps.make.com/http) describes the module and credential settings. The attached `requests.json` contains the request bodies; it is not a scenario blueprint.

1. Receive a server-side event with `event_id` (a persistent UUID), `phone`, and `order_number` or `name`. Keep the public form behind your own validation, consent and rate limiting.
2. Add a filter: an existing customer consent flag is true, the recipient is in E.164 format, and required variables are present.
3. Add **HTTP → Make a request**, method POST, URL `https://waix.kz/api/v1/messages`.
4. Store the WAIX key in the HTTP module's credential/keychain configuration: header name `Authorization`, value `Bearer YOUR_KEY`. Do not place a real key in a shared blueprint. Enable only the permissions needed by this scenario.
5. Add header `Idempotency-Key`: map the persisted UUID from step 1. Content type: JSON. Use the module's JSON/data-structure builder so names and order text are escaped correctly. Do not paste raw user text into an unescaped JSON string.
6. Set the body fields from `requests.json`: your connection ID, recipient, approved template, language and variables. Enable response parsing. Do not follow redirects.
7. Save returned `data.id` against the source event. Treat 202 as queued. Delivery status arrives through a signed WAIX webhook or can be read through GET `/messages/{id}`.

For OTP, create separate scenarios using POST `/otp/send` and POST `/otp/verify`, with an OTP project key. Bind the returned challenge ID to the user's session on your backend. Use a sandbox key first. Do not expose `test_code` or the scenario webhook URL to the browser.

For retries, preserve the same event ID and payload, and honor Retry-After on HTTP 429. Inspect 400/401/403 rather than retrying them. Enable confidential-data handling in scenario settings and avoid retaining OTP request bodies in execution history.
