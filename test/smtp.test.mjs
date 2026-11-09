import { test, expect } from "bun:test";
import { SMTPServer } from "smtp-server";
import nodemailer from "nodemailer";
import { readFileSync } from "node:fs";
import { notificationAdapters } from "../lib/channels/index.mjs";
// This key and certificate are public test fixtures, used only by loopback test servers.
const key = readFileSync(new URL("./fixtures/smtp-key.pem", import.meta.url)),
  cert = readFileSync(new URL("./fixtures/smtp-cert.pem", import.meta.url));
for (const mode of ["tls", "starttls"])
  test(
    "real SMTP " + mode + " handshake and UTF-8 text delivery",
    async () => {
      const received = [];
      const server = new SMTPServer({
        secure: mode === "tls",
        key,
        cert,
        authOptional: true,
        disabledCommands: ["AUTH"],
        logger: false,
        onData(stream, session, callback) {
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            received.push({
              secure: session.secure,
              data: Buffer.concat(chunks).toString("utf8"),
            });
            callback(null, "accepted");
          });
        },
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = server.server.address().port;
        const adapter = notificationAdapters({
          createTransport: (opts) =>
            nodemailer.createTransport({
              ...opts,
              tls: { ca: cert, servername: "localhost" },
            }),
        }).find((a) => a.id === "smtp");
        const result = await adapter.send(
          {
            host: "127.0.0.1",
            port,
            security: mode,
            user: "",
            from: "sender@example.test",
            to: "recipient@example.test",
          },
          {},
          {
            title: "用量报告",
            text: "中文文字报告\nCalls 10",
            reportId: "smtp-fixture",
          },
          {},
        );
        expect(result.outcome).toBe("success");
        expect(received.length).toBe(1);
        expect(received[0].secure).toBe(true);
        expect(received[0].data).toContain("X-Magpie-Report-ID: smtp-fixture");
        expect(received[0].data).toContain("text/plain");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
    20000,
  );
