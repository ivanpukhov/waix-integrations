// Code by Zapier → Run JavaScript. Сопоставьте поля inputData по README.
// Здесь нет ключа WAIX: Authorization задаётся отдельно в HTTP-действии.
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const text = (name) =>
  typeof inputData[name] === "string" ? inputData[name].trim() : "";
const id = (name) => {
  const value = text(name);
  if (!uuid.test(value)) throw new Error(`${name}: нужен сохранённый UUID`);
  return value;
};
const phone = () => {
  const value = text("phone");
  if (!/^\+[1-9][0-9]{7,14}$/.test(value))
    throw new Error("phone: нужен формат E.164");
  return value;
};
const operation = text("operation");
let path,
  body,
  eventId = "",
  method = "POST";
if (operation === "message") {
  eventId = id("event_id");
  if (!["true", "1"].includes(text("whatsapp_consent")))
    throw new Error("Нет подтверждённого согласия на WhatsApp");
  const name = text("template"),
    language = text("language");
  if (
    !/^[a-z0-9_]{1,512}$/.test(name) ||
    !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)
  )
    throw new Error("Проверьте шаблон и язык");
  const variable = text("variable");
  if (!variable || variable.length > 500)
    throw new Error("variable: от 1 до 500 символов");
  path = "/messages";
  body = {
    connection_id: id("connection_id"),
    to: phone(),
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [
        { type: "body", parameters: [{ type: "text", text: variable }] },
      ],
    },
  };
} else if (operation === "otp_send") {
  eventId = id("event_id");
  const ttl = text("ttl") ? Number(text("ttl")) : 300;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 600)
    throw new Error("ttl: от 60 до 600 секунд");
  path = "/otp/send";
  body = { to: phone(), channel: "whatsapp", ttl };
} else if (operation === "otp_verify") {
  const code = text("code");
  if (!/^[0-9]{6}$/.test(code)) throw new Error("code: строка из 6 цифр");
  path = "/otp/verify";
  body = { id: id("id"), code };
} else if (operation === "otp_status" || operation === "message_status") {
  method = "GET";
  path = (operation === "otp_status" ? "/otp/" : "/messages/") + id("id");
} else
  throw new Error(
    "operation: message, message_status, otp_send, otp_verify или otp_status",
  );
return {
  method,
  url: "https://waix.kz/api/v1" + path,
  idempotency_key: eventId,
  body: body ? JSON.stringify(body) : "",
};
