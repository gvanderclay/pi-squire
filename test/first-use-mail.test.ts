import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { agentFile, cleanup, resetRoot, writeAgent } from "./harness.ts";
import { envelopes, mailSession, request } from "./mail-harness.ts";

beforeEach(resetRoot);
after(cleanup);

test("doctor invalid-input probes against real mail leave outgoing and waiting mail untouched", async () => {
	writeAgent("scout", agentFile({}));
	const sender = mailSession();
	const recipient = mailSession();
	await sender.start();
	await recipient.start();
	request(sender, recipient.parent, "leave this queued");
	const before = {
		sent: envelopes(recipient.parent, "sent"),
		new: envelopes(recipient.parent, "new"),
		cur: envelopes(recipient.parent, "cur"),
	};
	await recipient.command("delegate-doctor", "");
	assert.match(recipient.notes.join("\n"), /message:send: a handler answered an invalid-input probe/);
	assert.match(recipient.notes.join("\n"), /message:reply: a handler answered an invalid-input probe/);
	assert.deepEqual(envelopes(recipient.parent, "sent"), before.sent);
	assert.deepEqual(envelopes(recipient.parent, "new"), before.new);
	assert.deepEqual(envelopes(recipient.parent, "cur"), before.cur);
	assert.equal(recipient.sent.length, 0);
});
