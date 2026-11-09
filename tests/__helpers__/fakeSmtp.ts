import { createServer, type Server, type Socket } from "node:net";

/** What one client connection said to the fake server. */
export interface SmtpSession {
	/** Every command line, in order (DATA payloads excluded). */
	commands: string[];
	/** Each DATA payload, byte for byte (latin1), without the final `.` line. */
	data: string[];
}

export interface FakeSmtpOptions {
	/** Whether EHLO advertises STARTTLS. The server never actually upgrades. */
	advertiseStartTls?: boolean;
	/** Reply to every RCPT TO, e.g. `"550 5.1.1 user unknown"`. */
	rcptReply?: string;
	/** Reply to AUTH, e.g. `"535 5.7.8 bad credentials"`. */
	authReply?: string;
}

export interface FakeSmtp {
	port: number;
	sessions: SmtpSession[];
	/** Every command of every session, flattened. */
	commands(): string[];
	close(): Promise<void>;
}

/**
 * A minimal SMTP server that records what a client sends. It answers just
 * enough of RFC 5321 for nodemailer to deliver a message, and refuses STARTTLS
 * (454), which is what a downgrading man in the middle looks like.
 */
export async function startFakeSmtp(
	options: FakeSmtpOptions = {},
): Promise<FakeSmtp> {
	const sessions: SmtpSession[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		const session: SmtpSession = { commands: [], data: [] };
		sessions.push(session);
		let buffer = "";
		let inData = false;
		socket.write("220 fake ESMTP\r\n");
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("latin1");
			for (;;) {
				if (inData) {
					const end = buffer.indexOf("\r\n.\r\n");
					if (end === -1) return;
					session.data.push(buffer.slice(0, end));
					buffer = buffer.slice(end + 5);
					inData = false;
					socket.write("250 2.0.0 queued as FAKE\r\n");
					continue;
				}
				const eol = buffer.indexOf("\r\n");
				if (eol === -1) return;
				const line = buffer.slice(0, eol);
				buffer = buffer.slice(eol + 2);
				session.commands.push(line);
				const verb = line.toUpperCase();
				if (verb.startsWith("EHLO")) {
					socket.write(
						`250-fake\r\n${options.advertiseStartTls ? "250-STARTTLS\r\n" : ""}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`,
					);
				} else if (verb.startsWith("HELO")) {
					socket.write("250 fake\r\n");
				} else if (verb.startsWith("STARTTLS")) {
					socket.write("454 4.7.0 TLS not available\r\n");
				} else if (verb.startsWith("AUTH")) {
					socket.write(`${options.authReply ?? "235 2.7.0 ok"}\r\n`);
				} else if (verb.startsWith("RCPT")) {
					socket.write(`${options.rcptReply ?? "250 ok"}\r\n`);
				} else if (verb.startsWith("MAIL") || verb.startsWith("RSET")) {
					socket.write("250 ok\r\n");
				} else if (verb === "DATA") {
					inData = true;
					socket.write("354 go ahead\r\n");
				} else if (verb === "QUIT") {
					socket.end("221 bye\r\n");
				} else {
					socket.write("502 5.5.2 unknown command\r\n");
				}
			}
		});
	});
	const port = await new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(
				typeof address === "object" && address !== null ? address.port : 0,
			);
		});
	});
	return {
		port,
		sessions,
		commands: () => sessions.flatMap((s) => s.commands),
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
